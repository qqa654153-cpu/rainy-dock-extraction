// ============================================================================
// 模块 2.5：纯逻辑工具与中文同步语音系统 (GameLogic + VoiceEngine)
// 混合架构：优先解码播放 voices/voice_pack.js 神经语音并走无线电 DSP 滤波，
// 缺失时无缝降级至浏览器 window.speechSynthesis，同时提供优先级抢占与冷却。
// ============================================================================

const GameLogic = (() => {
  'use strict';

  function selectVoiceAction(current, incomingPriority, cooldownUntil, nowMs) {
    if (nowMs < cooldownUntil) return 'skip_cooldown';
    if (current) {
      if (incomingPriority < current.priority) return 'skip_busy';
      if (incomingPriority === 1 && current.priority === 1) return 'skip_busy';
    }
    return 'play';
  }

  function computeWatchdogTimeoutMs(text, lang) {
    const len = typeof text === 'string' ? text.length : 0;
    const isEn = lang === 'en' || (typeof text === 'string' && !/[\u4e00-\u9fff]/.test(text) && text.length > 0);
    const perCharMs = isEn ? 85 : 290;
    return Math.max(4000, Math.min(22000, Math.round(len * perCharMs + 2500)));
  }

  function computeRelativeHitAngleDeg(playerPos, playerYaw, sourcePos) {
    const dx = sourcePos.x - playerPos.x;
    const dz = sourcePos.z - playerPos.z;
    if (dx * dx + dz * dz < 1e-6) return 0;
    // 世界北向为 -Z (0 rad)，顺时针为正；玩家 yaw=0 朝 -Z，右转 yaw 减小
    const targetBearing = Math.atan2(dx, -dz);
    const playerHeading = -playerYaw;
    let rel = targetBearing - playerHeading;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    return (rel * 180) / Math.PI;
  }

  function computeExplosionFalloff(dist, radius, maxDamage, occluded = false) {
    if (dist >= radius || radius <= 0) return 0;
    const ratio = 1 - Math.max(0, dist) / radius;
    const raw = Math.round(maxDamage * (0.25 + 0.75 * ratio));
    return occluded ? Math.max(1, Math.round(raw * 0.3)) : raw;
  }

  function computePlayerHitbox({
    pos,
    curEye = 1.68,
    leanDir = 0,
    rightX = 1,
    rightZ = 0,
    crouching = false,
    sliding = false,
  } = {}) {
    const px = pos ? (Number(pos.x) || 0) : 0;
    const py = pos ? (Number(pos.y) || 0) : 0;
    const pz = pos ? (Number(pos.z) || 0) : 0;
    const leanOffset = (Number(leanDir) || 0) * 0.44;
    const cx = px + (Number(rightX) || 0) * leanOffset;
    const cz = pz + (Number(rightZ) || 0) * leanOffset;
    const eye = Number.isFinite(curEye) ? curEye : 1.68;
    const bottomY = py + (sliding ? 0.18 : 0.25);
    const minTop = sliding ? 0.78 : crouching ? 1.05 : 1.56;
    const topY = py + Math.max(minTop, eye + 0.08);
    const radius = sliding ? 0.44 : crouching ? 0.48 : 0.52;
    return {
      bottom: { x: cx, y: bottomY, z: cz },
      top: { x: cx, y: topY, z: cz },
      center: { x: cx, y: (bottomY + topY) * 0.5, z: cz },
      radius,
    };
  }

  function segmentHitsCapsule(p0, p1, capBottom, capTop, radius = 0.5) {
    if (!p0 || !p1 || !capBottom || !capTop || radius <= 0) return false;
    const d1x = p1.x - p0.x, d1y = p1.y - p0.y, d1z = p1.z - p0.z;
    const d2x = capTop.x - capBottom.x, d2y = capTop.y - capBottom.y, d2z = capTop.z - capBottom.z;
    const rx = p0.x - capBottom.x, ry = p0.y - capBottom.y, rz = p0.z - capBottom.z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    const EPS = 1e-8;
    let s = 0;
    let t = 0;

    if (a <= EPS && e <= EPS) {
      return (rx * rx + ry * ry + rz * rz) <= radius * radius;
    }
    if (a <= EPS) {
      t = Math.max(0, Math.min(1, f / e));
    } else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= EPS) {
        s = Math.max(0, Math.min(1, -c / a));
      } else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z;
        const denom = a * e - b * b;
        if (denom > EPS) {
          s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
        }
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = Math.max(0, Math.min(1, -c / a));
        } else if (t > 1) {
          t = 1;
          s = Math.max(0, Math.min(1, (b - c) / a));
        }
      }
    }
    const cx = rx + d1x * s - d2x * t;
    const cy = ry + d1y * s - d2y * t;
    const cz = rz + d1z * s - d2z * t;
    return (cx * cx + cy * cy + cz * cz) <= radius * radius;
  }

  function computeSpatialAudioParams(listenerPos, listenerYaw, sourcePos, maxDist = 60) {
    const lx = listenerPos ? (Number(listenerPos.x) || 0) : 0;
    const ly = listenerPos ? (Number(listenerPos.y) || 0) : 0;
    const lz = listenerPos ? (Number(listenerPos.z) || 0) : 0;
    const sx = sourcePos ? (Number(sourcePos.x) || 0) : lx;
    const sy = sourcePos ? (Number(sourcePos.y) || 0) : ly;
    const sz = sourcePos ? (Number(sourcePos.z) || 0) : lz;
    const dx = sx - lx;
    const dy = sy - ly;
    const dz = sz - lz;
    const dist = Math.hypot(dx, dy, dz);
    const flatDist = Math.hypot(dx, dz);
    const distAtten = maxDist > 0 ? Math.max(0.05, Math.min(1, 1 - dist / maxDist)) : 1;

    if (flatDist < 0.05) {
      return {
        pan: 0,
        rearFactor: 0,
        lpFreq: 20000,
        distAtten: +distAtten.toFixed(3),
        dist: +dist.toFixed(2),
      };
    }

    const yaw = Number(listenerYaw) || 0;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const nx = dx / flatDist;
    const nz = dz / flatDist;
    const rightDot = nx * rightX + nz * rightZ;
    const fwdDot = nx * fwdX + nz * fwdZ;
    const nearTaper = Math.min(1, flatDist / 1.5);
    const pan = Math.max(-0.92, Math.min(0.92, rightDot * 0.92 * nearTaper));
    const rearFactor = Math.max(0, Math.min(1, -fwdDot));
    const lpFreq = Math.round(20000 - rearFactor * 17400);

    return {
      pan: +pan.toFixed(3),
      rearFactor: +rearFactor.toFixed(3),
      lpFreq,
      distAtten: +distAtten.toFixed(3),
      dist: +dist.toFixed(2),
    };
  }

  function classifySoundAlert(dist, radius, isHostile = true, isSuppressed = false) {
    if (!Number.isFinite(dist) || !Number.isFinite(radius) || radius <= 0 || dist > radius) {
      return 'NONE';
    }
    if (!isHostile) return 'SUSPICIOUS';
    if (isSuppressed) {
      return dist <= 3.5 ? 'COMBAT' : 'SUSPICIOUS';
    }
    return dist <= Math.max(9, radius * 0.48) ? 'COMBAT' : 'SUSPICIOUS';
  }

  function sanitizeUserSettings(raw) {
    const defaults = {
      sensitivity: 1.0,
      volume: 0.72,
      voiceVolume: 0.85,
      voiceMode: 'radio',
      voiceLang: 'auto',
      toggleAds: false,
      invertY: false,
    };
    if (!raw || typeof raw !== 'object') return defaults;
    const sensNum = Number(raw.sensitivity);
    const volNum = Number(raw.volume);
    const vVolNum = Number(raw.voiceVolume);
    const sensitivity = Number.isFinite(sensNum)
      ? Math.round(Math.max(0.3, Math.min(2.5, sensNum)) * 100) / 100
      : defaults.sensitivity;
    const volume = Number.isFinite(volNum)
      ? Math.round(Math.max(0, Math.min(1, volNum)) * 100) / 100
      : defaults.volume;
    const voiceVolume = Number.isFinite(vVolNum)
      ? Math.round(Math.max(0, Math.min(1, vVolNum)) * 100) / 100
      : defaults.voiceVolume;
    const voiceMode = ['radio', 'clean', 'off'].includes(raw.voiceMode) ? raw.voiceMode : defaults.voiceMode;
    const voiceLang = ['auto', 'zh', 'en'].includes(raw.voiceLang) ? raw.voiceLang : defaults.voiceLang;
    return {
      sensitivity,
      volume,
      voiceVolume,
      voiceMode,
      voiceLang,
      toggleAds: !!raw.toggleAds,
      invertY: !!raw.invertY,
    };
  }

  const TUTORIAL_TOTAL_STEPS = 8;
  const TUTORIAL_STEP_VOICES = [
    'tut_1',
    'tut_2',
    'tut_3',
    'tut_4',
    'tut_5',
    'tut_6',
    'tut_7_out',
    'tut_7_in',
    'tut_8',
    'tut_complete',
  ];

  function computeAdsSensitivityScale(fovDeg, baseFovDeg = 75) {
    const safeBase = Math.max(20, Math.min(120, Number(baseFovDeg) || 75));
    const safeFov = Math.max(15, Math.min(safeBase, Number(fovDeg) || safeBase));
    const ratio = Math.tan((safeFov * Math.PI) / 360) / Math.tan((safeBase * Math.PI) / 360);
    return +Math.max(0.25, Math.min(1.0, ratio)).toFixed(4);
  }

  function computeAdsOpticsState({
    weaponId = 'car47',
    adsAlpha = 0,
    isReloading = false,
    difficulty = 'standard',
  } = {}) {
    const isRealism = difficulty === 'realism' || difficulty === 'realistic';
    const alpha = Math.max(0, Math.min(1, Number(adsAlpha) || 0));
    const use2DScope = weaponId === 'dmr' && !isReloading;
    const scopeRaw = use2DScope ? (alpha - 0.62) / 0.34 : 0;
    const scopeOverlayOpacity = +Math.max(0, Math.min(1, scopeRaw)).toFixed(3);
    const hideViewmodel3D = use2DScope && scopeOverlayOpacity >= 0.55;
    const crosshairLineOpacity = isRealism
      ? 0
      : +Math.max(0, 1 - alpha * 1.4).toFixed(3);

    let crosshairDotOpacity = 0;
    if (!isRealism) {
      if (use2DScope && scopeOverlayOpacity >= 0.35) {
        crosshairDotOpacity = +Math.max(0, 1 - (scopeOverlayOpacity - 0.35) / 0.35).toFixed(3);
      } else {
        crosshairDotOpacity = +(alpha > 0.1 ? Math.max(0.78, 0.9 - alpha * 0.12) : 0.9).toFixed(3);
      }
    }

    return {
      mode: hideViewmodel3D ? '2d_scope' : alpha > 0.15 ? '3d_optic' : 'hip',
      hideViewmodel3D,
      scopeOverlayOpacity,
      crosshairLineOpacity,
      crosshairDotOpacity,
    };
  }

  const TRAINING_STAGES = [
    {
      id: 1,
      name: '西区集装箱 · 中继器 A 攻防',
      nameEn: 'West Container Yard · Relay A Assault',
      shortName: '西区集装箱 A',
      shortNameEn: 'West Yard A',
      relayId: 'A',
      isExtractStage: false,
      voiceId: 'train_stage_1',
      spawn: { x: -14.5, y: 0, z: 22.5, yaw: 0.42 },
      enemies: [
        { type: 'drone', pos: [-23.0, 5.8, 5.5] },
        { type: 'drone', pos: [-17.0, 6.2, -1.5] },
        { type: 'hound', pos: [-23.5, 0, 9.0] },
        { type: 'hound', pos: [-13.5, 0, 3.5] },
      ],
      interceptors: [
        { type: 'drone', pos: [-28.0, 7.8, -3.0] },
        { type: 'hound', pos: [-12.0, 0, 12.0] },
      ],
    },
    {
      id: 2,
      name: '铁皮仓库 · 室内 CQB 近战',
      nameEn: 'Corrugated Warehouse · Interior CQB',
      shortName: '铁皮仓库 B',
      shortNameEn: 'Warehouse B',
      relayId: 'B',
      isExtractStage: false,
      voiceId: 'train_stage_2',
      spawn: { x: -12.0, y: 0, z: -9.5, yaw: 0.0 },
      enemies: [
        { type: 'hound', pos: [-15.0, 0, -21.0] },
        { type: 'hound', pos: [-7.5, 0, -24.0] },
        { type: 'hound', pos: [-13.5, 0, -28.5] },
        { type: 'drone', pos: [2.0, 5.5, -22.0] },
      ],
      interceptors: [
        { type: 'hound', pos: [-12.0, 0, -13.0] },
        { type: 'drone', pos: [-6.0, 6.2, -10.5] },
      ],
    },
    {
      id: 3,
      name: '东侧龙门吊 · 制高点与爆破',
      nameEn: 'East Gantry Crane · Overlook & Demo',
      shortName: '龙门吊高台 C',
      shortNameEn: 'Gantry Crane C',
      relayId: 'C',
      isExtractStage: false,
      voiceId: 'train_stage_3',
      spawn: { x: 11.5, y: 0, z: 20.5, yaw: -0.3 },
      enemies: [
        { type: 'drone', pos: [15.2, 7.2, 15.0] },
        { type: 'drone', pos: [9.0, 6.2, -5.0] },
        { type: 'hound', pos: [14.0, 0, 7.5] },
        { type: 'hound', pos: [18.0, 0, -4.5] },
      ],
      interceptors: [
        { type: 'drone', pos: [18.5, 8.2, -9.0] },
        { type: 'hound', pos: [8.5, 0, 12.0] },
      ],
    },
    {
      id: 4,
      name: '终局全面封锁 · 突围撤离',
      nameEn: 'Final Lockdown · Combat Extraction',
      shortName: '终局封锁撤离',
      shortNameEn: 'Final Extraction',
      relayId: null,
      isExtractStage: true,
      voiceId: 'train_stage_4',
      spawn: { x: -4.0, y: 0, z: 10.0, yaw: -0.68 },
      enemies: [],
      interceptors: [],
    },
    {
      id: 5,
      name: '潜行暗杀 · 消音与发报打断',
      nameEn: 'Stealth Infiltration · Suppress & Deny Comms',
      shortName: '潜行暗杀演练',
      shortNameEn: 'Stealth Drill',
      relayId: 'A',
      isExtractStage: false,
      stealthDrill: true,
      voiceId: 'train_stage_5',
      spawn: { x: -16.0, y: 0, z: 24.0, yaw: 0.35 },
      enemies: [
        { type: 'recon', pos: [-22.0, 5.2, 10.0] },
        { type: 'hound', pos: [-16.5, 0, 5.0] },
        { type: 'drone', pos: [-27.0, 5.6, 2.0] },
      ],
      interceptors: [
        { type: 'recon', pos: [-25.0, 6.4, -3.5] },
        { type: 'hound', pos: [-13.0, 0, 12.0] },
      ],
    },
    {
      id: 6,
      name: '重装破盾 · EMP 与高台反狙',
      nameEn: 'Heavy Breaching · EMP & Counter-Sniper',
      shortName: '破盾反狙演练',
      shortNameEn: 'Breach & Counter-Sniper',
      relayId: 'C',
      isExtractStage: false,
      voiceId: 'train_stage_6',
      spawn: { x: 8.5, y: 0, z: 21.5, yaw: -0.25 },
      enemies: [
        { type: 'shield', pos: [12.0, 0, 8.0] },
        { type: 'sniper', pos: [17.0, 9.6, -4.5] },
        { type: 'hound', pos: [16.5, 0, 2.5] },
      ],
      interceptors: [
        { type: 'shield', pos: [10.0, 0, 13.0] },
        { type: 'sniper', pos: [18.5, 9.6, -8.5] },
      ],
    },
  ];

  const STEALTH_STATES = {
    PATROL: 'PATROL',
    SUSPICIOUS: 'SUSPICIOUS',
    COMBAT: 'COMBAT',
  };

  function evaluateStealthStep({
    state = STEALTH_STATES.PATROL,
    suspicion = 0,
    dt = 0.016,
    hasLOS = false,
    dist = 999,
    angleDeg = 0,
    fovHalfDeg = 58,
    detectRange = 26,
    playerStealthFactor = 1.0,
    detectMult = 1.0,
    timeSinceLastSeen = 0,
  } = {}) {
    const safeDt = Math.max(0, dt || 0);
    let nextState = state || STEALTH_STATES.PATROL;
    let nextSuspicion = Math.max(0, Math.min(1, suspicion || 0));
    const safeDetectMult = Math.max(0.4, Number(detectMult) || 1.0);
    const effectiveRange = Math.max(3.5, detectRange * Math.max(0.32, playerStealthFactor) * safeDetectMult);
    const absAngle = Math.abs(angleDeg || 0);

    let visFactor = 0;
    if (hasLOS && dist <= effectiveRange) {
      if (absAngle <= fovHalfDeg) visFactor = 1.0;
      else if (absAngle <= fovHalfDeg + 28) visFactor = 0.45;
      else if (dist < 2.2) visFactor = 0.55;
    }

    if (visFactor > 0) {
      const prox = Math.max(0.28, 1.45 - dist / effectiveRange);
      const closeBoost = dist < 4.5 && absAngle <= 75 ? 2.4 : 1.0;
      const gainRate = visFactor * prox * closeBoost * 1.15 * safeDetectMult;
      nextSuspicion = Math.min(1, nextSuspicion + gainRate * safeDt);
      if (nextSuspicion >= 1) {
        nextState = STEALTH_STATES.COMBAT;
      } else if (nextSuspicion >= 0.22 && nextState === STEALTH_STATES.PATROL) {
        nextState = STEALTH_STATES.SUSPICIOUS;
      }
    } else {
      const decayRate = nextState === STEALTH_STATES.COMBAT ? 0.06 : 0.22;
      nextSuspicion = Math.max(0, nextSuspicion - decayRate * safeDt);
      if (nextState === STEALTH_STATES.SUSPICIOUS && nextSuspicion <= 0) {
        nextState = STEALTH_STATES.PATROL;
      } else if (nextState === STEALTH_STATES.COMBAT && timeSinceLastSeen > 12.0) {
        nextState = STEALTH_STATES.SUSPICIOUS;
        nextSuspicion = 0.45;
      }
    }

    return {
      state: nextState,
      suspicion: +nextSuspicion.toFixed(4),
      perceived: visFactor > 0,
      effectiveRange: +effectiveRange.toFixed(2),
    };
  }

  function buildNavGrid(boxes, {
    minX = -41,
    maxX = 25,
    minZ = -33,
    maxZ = 31,
    cellSize = 1.25,
    padding = 0.62,
    maxStepHeight = 0.55,
    ceilingMinY = 1.85,
  } = {}) {
    const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    const grid = new Uint8Array(cols * rows);
    const activeBoxes = (boxes || []).filter(
      (b) => !b.disabled && !b.isRamp && b.maxY > maxStepHeight && b.minY < ceilingMinY
    );

    for (let rz = 0; rz < rows; rz++) {
      const wz = minZ + (rz + 0.5) * cellSize;
      for (let cx = 0; cx < cols; cx++) {
        const wx = minX + (cx + 0.5) * cellSize;
        let blocked = 0;
        for (let i = 0; i < activeBoxes.length; i++) {
          const b = activeBoxes[i];
          if (
            wx + padding > b.minX &&
            wx - padding < b.maxX &&
            wz + padding > b.minZ &&
            wz - padding < b.maxZ
          ) {
            blocked = 1;
            break;
          }
        }
        grid[rz * cols + cx] = blocked;
      }
    }
    return { minX, maxX, minZ, maxZ, cellSize, cols, rows, grid };
  }

  function worldToCell(navGrid, x, z) {
    const cx = Math.max(0, Math.min(navGrid.cols - 1, Math.floor((x - navGrid.minX) / navGrid.cellSize)));
    const rz = Math.max(0, Math.min(navGrid.rows - 1, Math.floor((z - navGrid.minZ) / navGrid.cellSize)));
    return { cx, rz };
  }

  function cellToWorld(navGrid, cx, rz) {
    return {
      x: +(navGrid.minX + (cx + 0.5) * navGrid.cellSize).toFixed(3),
      z: +(navGrid.minZ + (rz + 0.5) * navGrid.cellSize).toFixed(3),
    };
  }

  function _nearestWalkable(navGrid, startCell, maxRadius = 4) {
    const { cols, rows, grid } = navGrid;
    if (grid[startCell.rz * cols + startCell.cx] === 0) return startCell;
    for (let r = 1; r <= maxRadius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const nx = startCell.cx + dx;
          const nz = startCell.rz + dz;
          if (nx >= 0 && nx < cols && nz >= 0 && nz < rows && grid[nz * cols + nx] === 0) {
            return { cx: nx, rz: nz };
          }
        }
      }
    }
    return null;
  }

  function findGridPath(navGrid, start, goal, { maxNodes = 900, goalRadius = 5 } = {}) {
    if (!navGrid || !navGrid.grid) return [];
    const { cols, rows, grid } = navGrid;
    const sRaw = worldToCell(navGrid, start.x, start.z);
    const gRaw = worldToCell(navGrid, goal.x, goal.z);
    const s = _nearestWalkable(navGrid, sRaw, 5);
    const g = _nearestWalkable(navGrid, gRaw, goalRadius);
    if (!s || !g) return [];
    if (s.cx === g.cx && s.rz === g.rz) return [{ x: goal.x, z: goal.z }];

    const startIdx = s.rz * cols + s.cx;
    const goalIdx = g.rz * cols + g.cx;
    const gScore = new Float32Array(cols * rows).fill(Infinity);
    const fScore = new Float32Array(cols * rows).fill(Infinity);
    const cameFrom = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    const openSet = new Set([startIdx]);

    const heuristic = (idxA, idxB) => {
      const ax = idxA % cols;
      const az = (idxA / cols) | 0;
      const bx = idxB % cols;
      const bz = (idxB / cols) | 0;
      const dx = Math.abs(ax - bx);
      const dz = Math.abs(az - bz);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };

    gScore[startIdx] = 0;
    fScore[startIdx] = heuristic(startIdx, goalIdx);

    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
    ];

    let explored = 0;
    let bestIdx = startIdx;
    let bestH = heuristic(startIdx, goalIdx);

    while (openSet.size > 0 && explored < maxNodes) {
      let curIdx = -1;
      let curF = Infinity;
      for (const idx of openSet) {
        if (fScore[idx] < curF) {
          curF = fScore[idx];
          curIdx = idx;
        }
      }
      if (curIdx < 0) break;
      if (curIdx === goalIdx) {
        bestIdx = curIdx;
        break;
      }
      openSet.delete(curIdx);
      closed[curIdx] = 1;
      explored++;

      const curH = heuristic(curIdx, goalIdx);
      if (curH < bestH) {
        bestH = curH;
        bestIdx = curIdx;
      }

      const cx = curIdx % cols;
      const rz = (curIdx / cols) | 0;

      for (let d = 0; d < dirs.length; d++) {
        const [dx, dz, stepCost] = dirs[d];
        const nx = cx + dx;
        const nz = rz + dz;
        if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
        const nIdx = nz * cols + nx;
        if (grid[nIdx] === 1 || closed[nIdx] === 1) continue;
        if (dx !== 0 && dz !== 0) {
          if (grid[rz * cols + nx] === 1 || grid[nz * cols + cx] === 1) continue;
        }
        const tentative = gScore[curIdx] + stepCost;
        if (tentative < gScore[nIdx]) {
          cameFrom[nIdx] = curIdx;
          gScore[nIdx] = tentative;
          fScore[nIdx] = tentative + heuristic(nIdx, goalIdx);
          openSet.add(nIdx);
        }
      }
    }

    const rev = [];
    let walk = cameFrom[goalIdx] !== -1 ? goalIdx : bestIdx;
    while (walk !== -1 && walk !== startIdx) {
      rev.push(cellToWorld(navGrid, walk % cols, (walk / cols) | 0));
      walk = cameFrom[walk];
    }
    rev.reverse();
    if (rev.length === 0) return [{ x: goal.x, z: goal.z }];
    if (walk === startIdx && cameFrom[goalIdx] !== -1) {
      rev[rev.length - 1] = { x: goal.x, z: goal.z };
    }
    return rev;
  }

  const WEAPON_CATALOG = {
    car47: {
      id: 'car47',
      slot: 1,
      name: 'CAR-47 破晓 // 突击步枪',
      nameEn: 'CAR-47 Dawnbreaker // Assault Rifle',
      shortName: 'CAR-47',
      shortNameEn: 'CAR-47',
      desc: '全自动均衡主战步枪，稳健射速与中距离压制，支持现场装卸消音器。',
      descEn: 'Balanced full-auto service rifle with steady fire rate and mid-range suppression; field-detachable suppressor.',
      magSize: 30,
      maxReserve: 180,
      fireRate: 0.092,
      baseDamage: 27,
      critMult: 2.0,
      armorPierce: 0.15,
      hipSpread: 0.015,
      adsSpread: 0.0018,
      adsFov: 52,
      tacReloadTime: 1.24,
      emptyReloadTime: 1.72,
      noiseLoud: 38,
      noiseSuppressed: 9.5,
      pellets: 1,
      silencerDamageMult: 0.9,
      auto: true,
      recoilKick: 1.0,
      defaultSuppressed: false,
    },
    dmr: {
      id: 'dmr',
      slot: 1,
      name: 'MK-14 夜枭 // 精确射手步枪',
      nameEn: 'MK-14 Nightowl // Designated Marksman Rifle',
      shortName: 'MK-14 DMR',
      shortNameEn: 'MK-14 DMR',
      desc: '高倍率半自动反狙重步枪，附带高护盾穿透力，点名弱点与高台狙击极佳。',
      descEn: 'High-magnification semi-auto counter-sniper rifle with high shield penetration; excels at weakpoints and elevated targets.',
      magSize: 12,
      maxReserve: 72,
      fireRate: 0.25,
      baseDamage: 56,
      critMult: 2.3,
      armorPierce: 0.42,
      hipSpread: 0.024,
      adsSpread: 0.0005,
      adsFov: 38,
      tacReloadTime: 1.38,
      emptyReloadTime: 1.92,
      noiseLoud: 46,
      noiseSuppressed: 11.5,
      pellets: 1,
      silencerDamageMult: 0.92,
      auto: false,
      recoilKick: 1.65,
      defaultSuppressed: false,
    },
    shotgun: {
      id: 'shotgun',
      slot: 1,
      name: 'M890 破门者 // 战术霰弹枪',
      nameEn: 'M890 Breacher // Tactical Shotgun',
      shortName: 'M890',
      shortNameEn: 'M890',
      desc: '7 枚钢珠弹丸近战清场霸主，仓库近距离接敌瞬间融化机械犬与护甲。',
      descEn: '7-pellet buckshot CQB room-clearer; shreds cyber-hounds and heavy armor inside warehouse range.',
      magSize: 8,
      maxReserve: 48,
      fireRate: 0.56,
      baseDamage: 16,
      critMult: 1.5,
      armorPierce: 0.25,
      hipSpread: 0.058,
      adsSpread: 0.036,
      adsFov: 60,
      tacReloadTime: 1.48,
      emptyReloadTime: 2.05,
      noiseLoud: 48,
      noiseSuppressed: 13.5,
      pellets: 7,
      silencerDamageMult: 0.88,
      auto: false,
      recoilKick: 2.05,
      defaultSuppressed: false,
    },
    pistol: {
      id: 'pistol',
      slot: 2,
      name: 'USP-9 幽灵 // 战术副手枪',
      nameEn: 'USP-9 Phantom // Tactical Sidearm',
      shortName: 'USP-9',
      shortNameEn: 'USP-9',
      desc: '出厂预装低噪消音器与高爆头倍率，切枪迅捷，专为潜行摸哨与备用保底设计。',
      descEn: 'Factory-suppressed sidearm with high headshot multiplier and fast draw; built for silent sentry takedowns and backup.',
      magSize: 15,
      maxReserve: 90,
      fireRate: 0.16,
      baseDamage: 24,
      critMult: 2.2,
      armorPierce: 0.12,
      hipSpread: 0.011,
      adsSpread: 0.0012,
      adsFov: 58,
      tacReloadTime: 0.92,
      emptyReloadTime: 1.32,
      noiseLoud: 28,
      noiseSuppressed: 6.5,
      pellets: 1,
      silencerDamageMult: 0.94,
      auto: false,
      recoilKick: 0.72,
      defaultSuppressed: true,
    },
  };

  const THROWABLE_CATALOG = {
    emp: {
      id: 'emp',
      name: 'EMP 电磁手雷',
      nameEn: 'EMP Grenade',
      shortName: 'EMP雷',
      shortNameEn: 'EMP',
      fuseTime: 1.05,
      radius: 8.5,
      stunSec: 5.5,
      shieldBreak: true,
      damage: 22,
      colorHex: 0x38d9ff,
    },
    frag: {
      id: 'frag',
      name: 'M67 破片手雷',
      nameEn: 'M67 Frag Grenade',
      shortName: '破片雷',
      shortNameEn: 'FRAG',
      fuseTime: 1.5,
      radius: 7.5,
      stunSec: 0.4,
      shieldBreak: false,
      damage: 135,
      colorHex: 0xff7b2e,
    },
    decoy: {
      id: 'decoy',
      name: '声波诱饵器',
      nameEn: 'Acoustic Decoy',
      shortName: '诱饵器',
      shortNameEn: 'DECOY',
      fuseTime: 0.45,
      radius: 22.0,
      durationSec: 6.5,
      damage: 0,
      colorHex: 0x30f28c,
    },
  };

  const DIFFICULTIES = {
    recruit: {
      id: 'recruit',
      name: '新兵护航',
      nameEn: 'Recruit',
      badge: '零基础推荐',
      badgeEn: 'Starter Friendly',
      summary: '温和准星磁吸 · 后坐力/散布减半 · 敌伤 0.55x · 脱战 3 秒回满 100 血 · 宽裕潜行与打断窗',
      summaryEn: 'Gentle aim assist · 0.55x recoil/spread · 0.55x enemy dmg · 3s out-of-combat full 100 HP regen · generous stealth & interrupt windows',
      enemyHpMult: 0.78,
      enemyDmgMult: 0.55,
      enemySpeedScale: 0.85,
      enemyCooldownScale: 1.35,
      enemyBoltSpeedScale: 0.86,
      enemyJitterScale: 1.65,
      stealthDetectMult: 0.76,
      callInTimerScale: 1.6,
      aimAssistDeg: 2.8,
      recoilScale: 0.55,
      spreadScale: 0.55,
      playerCritBonus: 0,
      playerRegenDelay: 3.0,
      playerRegenCap: 100,
      playerRegenRate: 9.0,
      ammoReserveMult: 1.25,
      scoreMult: 0.75,
      hideHudHints: false,
    },
    standard: {
      id: 'standard',
      name: '标准行动',
      nameEn: 'Standard',
      badge: '经典默认',
      badgeEn: 'Classic Default',
      summary: '无辅助瞄准 · 1.0x 原版战术撤离平衡 · 脱战 5 秒回血至 65 HP · 1.0x 基础评分',
      summaryEn: 'No aim assist · 1.0x tactical extraction balance · 5s regen up to 65 HP · 1.0x base score',
      enemyHpMult: 1.0,
      enemyDmgMult: 1.0,
      enemySpeedScale: 1.0,
      enemyCooldownScale: 1.0,
      enemyBoltSpeedScale: 1.0,
      enemyJitterScale: 1.0,
      stealthDetectMult: 1.0,
      callInTimerScale: 1.0,
      aimAssistDeg: 0,
      recoilScale: 1.0,
      spreadScale: 1.0,
      playerCritBonus: 0,
      playerRegenDelay: 5.0,
      playerRegenCap: 65,
      playerRegenRate: 5.5,
      ammoReserveMult: 1.0,
      scoreMult: 1.0,
      hideHudHints: false,
    },
    veteran: {
      id: 'veteran',
      name: '老兵特遣',
      nameEn: 'Veteran',
      badge: '老枪手推荐',
      badgeEn: 'Sharpshooter Pick',
      summary: '不堆血牛 · 敌军更快更准(1.14x移速/1.45x伤害) · 缩短发报打断窗 · 弱点暴击 +15% · 1.25x 评分',
      summaryEn: 'No bullet sponges · faster, deadlier hostiles (1.14x speed / 1.45x dmg) · tighter radio interrupt · +15% weakpoint crit · 1.25x score',
      enemyHpMult: 1.1,
      enemyDmgMult: 1.45,
      enemySpeedScale: 1.14,
      enemyCooldownScale: 0.78,
      enemyBoltSpeedScale: 1.15,
      enemyJitterScale: 0.65,
      stealthDetectMult: 1.18,
      callInTimerScale: 0.82,
      aimAssistDeg: 0,
      recoilScale: 1.05,
      spreadScale: 1.0,
      playerCritBonus: 0.15,
      playerRegenDelay: 5.5,
      playerRegenCap: 60,
      playerRegenRate: 5.0,
      ammoReserveMult: 1.0,
      scoreMult: 1.25,
      hideHudHints: false,
    },
    realism: {
      id: 'realism',
      name: '拟真夜战',
      nameEn: 'Realism',
      badge: '硬核无准星',
      badgeEn: 'Hardcore · No Crosshair',
      summary: '去 2D 准星强依赖 3D/2.5D 瞄具 · 少 HUD 提示 · 高致死(1.75x) · 弱点暴击 +25% · 1.5x 评分',
      summaryEn: 'No 2D crosshair (rely on 3D/2.5D optics) · minimal HUD · high lethality (1.75x) · +25% weakpoint crit · 1.5x score',
      enemyHpMult: 1.05,
      enemyDmgMult: 1.75,
      enemySpeedScale: 1.18,
      enemyCooldownScale: 0.72,
      enemyBoltSpeedScale: 1.25,
      enemyJitterScale: 0.5,
      stealthDetectMult: 1.28,
      callInTimerScale: 0.72,
      aimAssistDeg: 0,
      recoilScale: 1.12,
      spreadScale: 1.05,
      playerCritBonus: 0.25,
      playerRegenDelay: 6.5,
      playerRegenCap: 50,
      playerRegenRate: 4.5,
      ammoReserveMult: 1.0,
      scoreMult: 1.5,
      hideHudHints: true,
    },
  };

  function getDifficultyConfig(diffId = 'standard') {
    const normalized = diffId === 'realistic' ? 'realism' : diffId;
    return DIFFICULTIES[normalized] || DIFFICULTIES.standard;
  }

  /**
   * 温和准星磁吸（供新兵护航使用）：在极小视角锥体内将射线轻微引向最近可见目标，
   * 内圈优先吸附弱点、外圈吸附躯干，避免整屏自瞄锁死感。
   */
  function selectAimAssistDirection({
    origin,
    dir,
    candidates = [],
    maxAngleDeg = 2.8,
    maxRange = 65,
    blend = 0.92,
  } = {}) {
    const dx = Number(dir && dir.x) || 0;
    const dy = Number(dir && dir.y) || 0;
    const dz = Number(dir && dir.z) || -1;
    const dLen = Math.hypot(dx, dy, dz) || 1;
    const ndx = dx / dLen;
    const ndy = dy / dLen;
    const ndz = dz / dLen;

    const baseResult = { dir: { x: ndx, y: ndy, z: ndz }, assisted: false, targetIndex: -1, angleDeg: Infinity };
    if (!origin || !Array.isArray(candidates) || candidates.length === 0 || maxAngleDeg <= 0) {
      return baseResult;
    }

    let bestScore = Infinity;
    let bestIdx = -1;
    let bestAngle = Infinity;
    let bestVec = null;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c) continue;
      const tx = c.x - origin.x;
      const ty = c.y - origin.y;
      const tz = c.z - origin.z;
      const dist = Math.hypot(tx, ty, tz);
      if (dist <= 0.1 || dist > maxRange) continue;

      const ux = tx / dist;
      const uy = ty / dist;
      const uz = tz / dist;
      const dot = Math.max(-1, Math.min(1, ux * ndx + uy * ndy + uz * ndz));
      const angleDeg = (Math.acos(dot) * 180) / Math.PI;
      if (angleDeg > maxAngleDeg) continue;

      // 弱点在锥体内圈（<= 60% 磁吸角）时给予轻微优先级加成
      const isInnerWeakpoint = !!c.isWeakpoint && angleDeg <= maxAngleDeg * 0.6;
      const score = isInnerWeakpoint ? angleDeg * 0.72 : angleDeg;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
        bestAngle = angleDeg;
        bestVec = { x: ux, y: uy, z: uz };
      }
    }

    if (bestIdx < 0 || !bestVec) return baseResult;
    const alpha = Math.max(0, Math.min(1, Number(blend) || 0.92));
    const rx = ndx + (bestVec.x - ndx) * alpha;
    const ry = ndy + (bestVec.y - ndy) * alpha;
    const rz = ndz + (bestVec.z - ndz) * alpha;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    return {
      dir: { x: rx / rLen, y: ry / rLen, z: rz / rLen },
      assisted: true,
      targetIndex: bestIdx,
      angleDeg: +bestAngle.toFixed(3),
    };
  }

  const MUTATORS = {
    blackout: {
      id: 'blackout',
      name: '全图停电',
      nameEn: 'Total Blackout',
      desc: '关闭港口大部分探照/仓库照明，极度依赖 F 枪灯与 Q 扫描',
      descEn: 'Kills most pier floodlights and warehouse lighting; relies heavily on [F] weapon light and [Q] tactical scan.',
      scoreBonus: 0.2,
    },
    explosive_tide: {
      id: 'explosive_tide',
      name: '高爆狂潮',
      nameEn: 'Volatile Cargo',
      desc: '码头增设额外高爆危化油桶并加快破片手雷清场节奏',
      descEn: 'Deploys extra volatile hazmat fuel drums across the dock and accelerates frag-clearing pace.',
      scoreBonus: 0.15,
    },
    elite_patrol: {
      id: 'elite_patrol',
      name: '精锐巡防',
      nameEn: 'Elite Patrol',
      desc: '开局巡防即投入防爆盾机兵与高台激光狙击手',
      descEn: 'Deploys Riot Shield Units and elevated Laser Snipers directly into opening patrol waves.',
      scoreBonus: 0.25,
    },
  };

  const GUN_SKINS = {
    standard: {
      id: 'standard',
      name: '标准暗钢',
      nameEn: 'Standard Dark Steel',
      unlockDesc: '默认解锁',
      unlockDescEn: 'Unlocked by default',
      metalHex: 0x22262e,
      accentHex: 0x3b424d,
    },
    night_ops: {
      id: 'night_ops',
      name: '夜幕幽灵涂层',
      nameEn: 'Night-Ops Phantom Coat',
      unlockDesc: '任意 A/S 级通关或获得“暴雨幽灵”勋章解锁',
      unlockDescEn: 'Clear with A/S rank or earn the "Ghost of the Storm" medal',
      metalHex: 0x162432,
      accentHex: 0x24d8ff,
    },
    hazmat_blue: {
      id: 'hazmat_blue',
      name: '海军蓝 HAZMAT',
      nameEn: 'Navy HAZMAT',
      unlockDesc: '累计 3 次通关或 S 级评价解锁',
      unlockDescEn: 'Complete 3 extractions or earn an S rank',
      metalHex: 0x1a3854,
      accentHex: 0xff9f2e,
    },
  };

  const AIRDROP_PERKS = [
    {
      id: 'ap_rounds',
      name: '穿甲钨芯弹',
      nameEn: 'Tungsten AP Rounds',
      shortTag: '穿甲弹',
      shortTagEn: 'AP Rounds',
      desc: '+25% 武器伤害，并提升 0.35 正面护盾穿透力',
      descEn: '+25% weapon damage and +0.35 frontal shield penetration.',
    },
    {
      id: 'sleight_of_hand',
      name: '快手装填模块',
      nameEn: 'Sleight of Hand Rig',
      shortTag: '快手装填',
      shortTagEn: 'Fast Reload',
      desc: '+35% 换弹速度与 1/2 切枪手感加速',
      descEn: '+35% reload speed and faster [1]/[2] weapon swap.',
    },
    {
      id: 'extended_pouches',
      name: '战术扩容弹袋',
      nameEn: 'Extended Tactical Pouches',
      shortTag: '扩容弹袋',
      shortTagEn: 'Ext. Mag',
      desc: '主副武器弹匣与备弹上限 +30%，并立即全额补满',
      descEn: '+30% magazine & reserve capacity for primary/sidearm, plus instant full resupply.',
    },
    {
      id: 'emp_overload',
      name: 'EMP 超导电容',
      nameEn: 'EMP Overcharge Capacitor',
      shortTag: '超导EMP',
      shortTagEn: 'EMP+',
      desc: '手雷范围 x1.35、威力 +50%，并补充 +2 战术手雷',
      descEn: '1.35x grenade radius, +50% damage, and +2 tactical grenades.',
    },
    {
      id: 'adrenaline_stim',
      name: '战地肾上腺素',
      nameEn: 'Combat Adrenaline Stim',
      shortTag: '肾上腺素',
      shortTagEn: 'Adrenaline',
      desc: '每次击杀回复 8 HP，受击镜头震动衰减 45%',
      descEn: 'Restore +8 HP per kill and reduce hit camera flinch by 45%.',
    },
    {
      id: 'tactical_optics',
      name: '脉冲超频模组',
      nameEn: 'Overclocked Pulse Optics',
      shortTag: '超频扫描',
      shortTagEn: 'Pulse+',
      desc: 'Q 战术扫描冷却减半，暴击弱点伤害额外 +25%',
      descEn: 'Halves [Q] tactical scan cooldown and adds +25% weakpoint crit damage.',
    },
  ];

  const MEDAL_CATALOG = {
    ghost_of_storm: { id: 'ghost_of_storm', name: '暴雨幽灵', nameEn: 'Ghost of the Storm' },
    untouchable: { id: 'untouchable', name: '零伤突围', nameEn: 'Untouchable' },
    demo_expert: { id: 'demo_expert', name: '爆破大师', nameEn: 'Demolition Expert' },
    speedrun: { id: 'speedrun', name: '极速行动', nameEn: 'Speedrun Extraction' },
    sharpshooter: { id: 'sharpshooter', name: '神射手', nameEn: 'Sharpshooter' },
    shadow_blade: { id: 'shadow_blade', name: '暗影处决', nameEn: 'Shadow Executioner' },
  };

  function computeShotDamage({
    weaponCfg,
    suppressorAttached = false,
    isCrit = false,
    hitShield = false,
    enemyEmpStunned = false,
    perkDamageMult = 1.0,
    perkArmorPierceBonus = 0,
    perkCritBonus = 0,
  } = {}) {
    const cfg = weaponCfg || WEAPON_CATALOG.car47;
    let dmg = cfg.baseDamage * perkDamageMult;
    if (suppressorAttached) dmg *= cfg.silencerDamageMult || 0.9;
    if (hitShield && !enemyEmpStunned) {
      const totalPierce = (cfg.armorPierce || 0) + perkArmorPierceBonus;
      if (totalPierce < 0.36) {
        return { finalDamage: 0, blockedByShield: true, piercedShield: false };
      }
      return {
        finalDamage: Math.max(4, Math.round(dmg * 0.42)),
        blockedByShield: false,
        piercedShield: true,
      };
    }
    if (isCrit) {
      dmg *= (cfg.critMult || 2.0) + perkCritBonus;
    }
    return {
      finalDamage: Math.max(1, Math.round(dmg)),
      blockedByShield: false,
      piercedShield: false,
    };
  }

  function rollEndlessAirdropOptions(ownedPerkIds = [], rngFn = Math.random) {
    const owned = new Set(ownedPerkIds || []);
    const unowned = AIRDROP_PERKS.filter((p) => !owned.has(p.id));
    const pool = unowned.length >= 3 ? [...unowned] : [...AIRDROP_PERKS];
    const picked = [];
    while (picked.length < 3 && pool.length > 0) {
      const idx = Math.floor(Math.max(0, Math.min(0.9999, rngFn())) * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
  }

  function computeMissionRating({
    elapsedSec = 180,
    kills = 0,
    shotsFired = 0,
    shotsHit = 0,
    crits = 0,
    alarmsTriggered = 0,
    stealthRelays = 0,
    damageTaken = 0,
    barrelKills = 0,
    meleeKills = 0,
    difficulty = 'standard',
    mutators = [],
  } = {}) {
    const diffCfg = getDifficultyConfig(difficulty);
    const mutBonus = (mutators || []).reduce((acc, mId) => {
      const m = MUTATORS[mId];
      return acc + (m ? m.scoreBonus : 0);
    }, 0);
    const acc = shotsFired > 0 ? Math.min(1, shotsHit / shotsFired) : 0;
    const critRate = shotsHit > 0 ? Math.min(1, crits / shotsHit) : 0;
    const timeBonus = Math.max(0, Math.round((360 - Math.min(360, elapsedSec)) * 6));
    const stealthBonus = alarmsTriggered === 0 ? 1800 : Math.max(0, 800 - alarmsTriggered * 260) + stealthRelays * 220;
    const survivalBonus = damageTaken <= 0 ? 1000 : Math.max(0, 600 - Math.round(damageTaken * 2.5));
    const baseScore =
      kills * 120 +
      crits * 85 +
      barrelKills * 160 +
      meleeKills * 220 +
      Math.round(acc * 900) +
      Math.round(critRate * 600) +
      timeBonus +
      stealthBonus +
      survivalBonus;
    const finalScore = Math.round(baseScore * (diffCfg.scoreMult + mutBonus));

    let grade = 'C';
    if (finalScore >= 5200) grade = 'S';
    else if (finalScore >= 3900) grade = 'A';
    else if (finalScore >= 2600) grade = 'B';

    const medals = [];
    const medalIds = [];
    if (alarmsTriggered === 0) {
      medalIds.push('ghost_of_storm');
      medals.push(MEDAL_CATALOG.ghost_of_storm.name);
    }
    if (damageTaken <= 0) {
      medalIds.push('untouchable');
      medals.push(MEDAL_CATALOG.untouchable.name);
    }
    if (barrelKills >= 2) {
      medalIds.push('demo_expert');
      medals.push(MEDAL_CATALOG.demo_expert.name);
    }
    if (elapsedSec <= 210) {
      medalIds.push('speedrun');
      medals.push(MEDAL_CATALOG.speedrun.name);
    }
    if (crits >= 6) {
      medalIds.push('sharpshooter');
      medals.push(MEDAL_CATALOG.sharpshooter.name);
    }
    if (meleeKills >= 2) {
      medalIds.push('shadow_blade');
      medals.push(MEDAL_CATALOG.shadow_blade.name);
    }

    return {
      grade,
      score: finalScore,
      accuracyPct: Math.round(acc * 100),
      medals,
      medalIds,
    };
  }

  function createDefaultCareerProfile() {
    return {
      bestGrade: null,
      bestScore: 0,
      bestTimeSec: null,
      clears: 0,
      ghostClears: 0,
      unlockedSkins: ['standard'],
      medalsEarned: [],
    };
  }

  function updateCareerRecords(prevProfile, missionReport) {
    const base = createDefaultCareerProfile();
    const next = {
      bestGrade: (prevProfile && prevProfile.bestGrade) || base.bestGrade,
      bestScore: (prevProfile && prevProfile.bestScore) || 0,
      bestTimeSec: (prevProfile && prevProfile.bestTimeSec) ?? null,
      clears: (prevProfile && prevProfile.clears) || 0,
      ghostClears: (prevProfile && prevProfile.ghostClears) || 0,
      unlockedSkins: Array.from(new Set(['standard', ...((prevProfile && prevProfile.unlockedSkins) || [])])),
      medalsEarned: Array.from(new Set((prevProfile && prevProfile.medalsEarned) || [])),
    };
    const gradeOrder = { C: 1, B: 2, A: 3, S: 4 };
    const newlyUnlocked = [];

    if (missionReport && missionReport.victory) {
      next.clears++;
      const g = missionReport.grade || 'C';
      if (!next.bestGrade || (gradeOrder[g] || 0) > (gradeOrder[next.bestGrade] || 0)) {
        next.bestGrade = g;
      }
      if ((missionReport.score || 0) > next.bestScore) {
        next.bestScore = missionReport.score || 0;
      }
      const sec = +(missionReport.elapsedSec || 0).toFixed(1);
      if (next.bestTimeSec === null || sec < next.bestTimeSec) {
        next.bestTimeSec = sec;
      }
      const hasGhostId = Array.isArray(missionReport.medalIds) && missionReport.medalIds.includes('ghost_of_storm');
      const hasGhostName = Array.isArray(missionReport.medals) && (
        missionReport.medals.includes('暴雨幽灵') || missionReport.medals.includes('ghost_of_storm')
      );
      const isGhost = hasGhostId || hasGhostName;
      if (isGhost) next.ghostClears++;
      const earnedList = Array.isArray(missionReport.medals) && missionReport.medals.length > 0
        ? missionReport.medals
        : (Array.isArray(missionReport.medalIds) ? missionReport.medalIds : []);
      for (const m of earnedList) {
        if (!next.medalsEarned.includes(m)) next.medalsEarned.push(m);
      }
      if ((g === 'A' || g === 'S' || isGhost) && !next.unlockedSkins.includes('night_ops')) {
        next.unlockedSkins.push('night_ops');
        newlyUnlocked.push('night_ops');
      }
      if ((next.clears >= 3 || g === 'S') && !next.unlockedSkins.includes('hazmat_blue')) {
        next.unlockedSkins.push('hazmat_blue');
        newlyUnlocked.push('hazmat_blue');
      }
    }
    return { nextProfile: next, newlyUnlocked };
  }

  function computeTimedTargetScore({ basePoints = 100, isCrit = false, comboCount = 1 } = {}) {
    const raw = basePoints + (isCrit ? basePoints : 0);
    const streak = Math.max(1, Math.floor(comboCount));
    const multiplier = Math.min(3.0, +(1 + (streak - 1) * 0.15).toFixed(2));
    return {
      points: Math.round(raw * multiplier),
      multiplier,
    };
  }

  function computeEndlessWaveSpec(wave) {
    const w = Math.max(1, Math.floor(wave || 1));
    const droneCount = 1 + Math.ceil(w * 0.75);
    const houndCount = 1 + Math.floor((w + 1) * 0.85);
    const reconCount = w >= 2 ? Math.min(2, Math.floor((w + 1) / 3)) : 0;
    const shieldCount = w >= 3 ? Math.min(2, Math.floor(w / 3)) : 0;
    const sniperCount = w >= 3 ? Math.min(2, Math.floor((w - 1) / 3)) : 0;
    const totalCount = droneCount + houndCount + reconCount + shieldCount + sniperCount;
    const maxConcurrent = Math.min(10, 4 + Math.floor(w * 0.8));
    const hpScale = Math.min(1.65, +(1 + (w - 1) * 0.07).toFixed(2));
    const speedScale = Math.min(1.25, +(1 + (w - 1) * 0.03).toFixed(2));
    const cooldownScale = Math.max(0.72, +(1 - (w - 1) * 0.03).toFixed(2));
    return {
      wave: w,
      droneCount,
      houndCount,
      reconCount,
      shieldCount,
      sniperCount,
      totalCount,
      maxConcurrent,
      hpScale,
      speedScale,
      cooldownScale,
    };
  }

  function createDefaultTrainingRecords() {
    return {
      timed: {
        '30': { bestScore: 0, bestKills: 0 },
        '60': { bestScore: 0, bestKills: 0 },
        '90': { bestScore: 0, bestKills: 0 },
      },
      endless: { bestWave: 0, bestKills: 0, bestTime: 0 },
      stages: {
        '1': { cleared: false, practiceCleared: false, bestTime: null },
        '2': { cleared: false, practiceCleared: false, bestTime: null },
        '3': { cleared: false, practiceCleared: false, bestTime: null },
        '4': { cleared: false, practiceCleared: false, bestTime: null },
        '5': { cleared: false, practiceCleared: false, bestTime: null },
        '6': { cleared: false, practiceCleared: false, bestTime: null },
      },
    };
  }

  function updateTrainingRecords(prevRecords, submode, result) {
    const base = createDefaultTrainingRecords();
    const next = {
      timed: {
        '30': { ...base.timed['30'], ...(prevRecords && prevRecords.timed && prevRecords.timed['30']) },
        '60': { ...base.timed['60'], ...(prevRecords && prevRecords.timed && prevRecords.timed['60']) },
        '90': { ...base.timed['90'], ...(prevRecords && prevRecords.timed && prevRecords.timed['90']) },
      },
      endless: { ...base.endless, ...(prevRecords && prevRecords.endless) },
      stages: {
        '1': { ...base.stages['1'], ...(prevRecords && prevRecords.stages && prevRecords.stages['1']) },
        '2': { ...base.stages['2'], ...(prevRecords && prevRecords.stages && prevRecords.stages['2']) },
        '3': { ...base.stages['3'], ...(prevRecords && prevRecords.stages && prevRecords.stages['3']) },
        '4': { ...base.stages['4'], ...(prevRecords && prevRecords.stages && prevRecords.stages['4']) },
        '5': { ...base.stages['5'], ...(prevRecords && prevRecords.stages && prevRecords.stages['5']) },
        '6': { ...base.stages['6'], ...(prevRecords && prevRecords.stages && prevRecords.stages['6']) },
      },
    };

    let isNewRecord = false;
    const notes = [];
    const noteIds = [];

    if (submode === 'timed') {
      const key = String(result.duration || 60);
      const slot = next.timed[key] || { bestScore: 0, bestKills: 0 };
      if ((result.score || 0) > slot.bestScore) {
        slot.bestScore = result.score || 0;
        isNewRecord = true;
        notes.push('最高分');
        noteIds.push('best_score');
      }
      if ((result.kills || 0) > slot.bestKills) {
        slot.bestKills = result.kills || 0;
      }
      next.timed[key] = slot;
    } else if (submode === 'endless') {
      const wave = result.wave || 0;
      const kills = result.kills || 0;
      const time = result.time || 0;
      if (wave > next.endless.bestWave) {
        next.endless.bestWave = wave;
        isNewRecord = true;
        notes.push('最高波次');
        noteIds.push('best_wave');
      } else if (wave === next.endless.bestWave && kills > next.endless.bestKills) {
        isNewRecord = true;
        notes.push('最高击杀');
        noteIds.push('best_kills');
      }
      if (kills > next.endless.bestKills) next.endless.bestKills = kills;
      if (time > next.endless.bestTime) next.endless.bestTime = +time.toFixed(1);
    } else if (submode === 'stage' && result.cleared) {
      const key = String(result.stageId || 1);
      const slot = next.stages[key] || { cleared: false, practiceCleared: false, bestTime: null };
      if (result.invulnerable) {
        slot.practiceCleared = true;
      } else {
        const wasCleared = !!slot.cleared;
        slot.cleared = true;
        const elapsed = +(result.time || 0).toFixed(1);
        if (slot.bestTime === null || elapsed < slot.bestTime) {
          slot.bestTime = elapsed;
          isNewRecord = true;
          notes.push('最快通关');
          noteIds.push('best_time');
        }
        if (!wasCleared && !noteIds.includes('first_clear')) {
          noteIds.push('first_clear');
        }
      }
      next.stages[key] = slot;
    }

    return { nextRecords: next, isNewRecord, notes, noteIds };
  }

  const QUALITY_PRESETS = ['extreme', 'high', 'medium', 'low'];
  const EXTREME_MAX_PIXELS = 1920 * 1200;

  function sanitizeQualityPreset(preset) {
    return QUALITY_PRESETS.includes(preset) ? preset : 'high';
  }

  function computeDrsScale(currentScale, fpsSmooth, enabled = true, dt = 0.016) {
    if (!enabled) return 1.0;
    const cur = Number.isFinite(currentScale) ? Math.max(0.75, Math.min(1.0, currentScale)) : 1.0;
    const fps = Number.isFinite(fpsSmooth) ? fpsSmooth : 60;
    const stepDt = Math.max(0.001, Math.min(0.1, Number.isFinite(dt) ? dt : 0.016));
    let next = cur;
    if (fps < 55) {
      const deficit = Math.min(1.0, (55 - fps) / 20);
      next = cur - (0.04 + 0.08 * deficit) * stepDt * 3.2;
    } else if (fps > 61.5 && cur < 1.0) {
      next = cur + 0.03 * stepDt * 2.4;
    }
    return Math.round(Math.max(0.75, Math.min(1.0, next)) * 1000) / 1000;
  }

  /**
   * Computes capped internal render resolution for Extreme quality (~1920x1200 budget)
   * while aligning dimensions to multiples of 2 for half-res G-Buffer parity.
   */
  function computeExtremePixelCap(cssWidth, cssHeight, dpr = 1, maxDpr = 1.5, maxPixels = EXTREME_MAX_PIXELS) {
    const w = Math.max(320, Number.isFinite(cssWidth) ? cssWidth : 1280);
    const h = Math.max(240, Number.isFinite(cssHeight) ? cssHeight : 720);
    const effDpr = Math.max(1.0, Math.min(Number.isFinite(maxDpr) ? maxDpr : 1.5, Number.isFinite(dpr) ? dpr : 1.0));
    const budget = Math.max(320 * 240, Number.isFinite(maxPixels) ? maxPixels : EXTREME_MAX_PIXELS);
    const rawW = Math.max(64, Math.floor((w * effDpr) / 2) * 2);
    const rawH = Math.max(64, Math.floor((h * effDpr) / 2) * 2);
    const total = rawW * rawH;
    if (total <= budget) {
      return { width: rawW, height: rawH, capScale: 1.0, effectiveDpr: effDpr };
    }
    const capScale = Math.sqrt(budget / total);
    const width = Math.max(64, Math.floor((rawW * capScale) / 2) * 2);
    const height = Math.max(64, Math.floor((rawH * capScale) / 2) * 2);
    return {
      width,
      height,
      capScale: Math.round(capScale * 1000) / 1000,
      effectiveDpr: effDpr,
    };
  }

  /**
   * Computes zero-allocation DRS viewport dimensions and UV clamp limits inside pre-allocated RenderTargets.
   */
  function computeActiveViewportSize(baseW, baseH, drsScale = 1.0) {
    const bw = Math.max(64, Math.floor(Number.isFinite(baseW) ? baseW : 1280));
    const bh = Math.max(64, Math.floor(Number.isFinite(baseH) ? baseH : 720));
    const s = Math.max(0.5, Math.min(1.0, Number.isFinite(drsScale) ? drsScale : 1.0));
    const activeW = s >= 0.999 ? bw : Math.min(bw, Math.max(64, Math.floor((bw * s) / 2) * 2));
    const activeH = s >= 0.999 ? bh : Math.min(bh, Math.max(64, Math.floor((bh * s) / 2) * 2));
    return {
      activeW,
      activeH,
      uvScaleX: activeW / bw,
      uvScaleY: activeH / bh,
      uvMaxX: (activeW - 0.5) / bw,
      uvMaxY: (activeH - 0.5) / bh,
    };
  }

  /**
   * Scores a virtual point light for fixed-slot LightPool eviction/promotion.
   */
  function scoreVirtualLight(lightX, lightY, lightZ, intensity, distance, priority, camX, camY, camZ) {
    if (!Number.isFinite(intensity) || intensity <= 0.001) return -1;
    const effDist = Number.isFinite(distance) && distance > 0 ? distance : 24;
    const dx = lightX - camX;
    const dy = lightY - camY;
    const dz = lightZ - camZ;
    const d2 = dx * dx + dy * dy + dz * dz;
    const prio = Number.isFinite(priority) ? Math.max(0.1, priority) : 1.0;
    const reachScale = 1.0 + effDist * 0.04;
    const falloffDenom = Math.max(25.0, effDist * effDist * 1.25);
    return (prio * Math.min(60, intensity) * reachScale) / (1.0 + d2 / falloffDenom);
  }

  /**
   * Slab AABB ray intersection test; returns nearest hit distance within [minDist, maxDist] or -1.
   */
  function raycastAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, minDist = 0.001, maxDist = 1000) {
    let tmin = minDist;
    let tmax = maxDist;

    if (Math.abs(dx) < 1e-8) {
      if (ox < minX || ox > maxX) return -1;
    } else {
      const inv = 1.0 / dx;
      let t1 = (minX - ox) * inv;
      let t2 = (maxX - ox) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dy) < 1e-8) {
      if (oy < minY || oy > maxY) return -1;
    } else {
      const inv = 1.0 / dy;
      let t1 = (minY - oy) * inv;
      let t2 = (maxY - oy) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dz) < 1e-8) {
      if (oz < minZ || oz > maxZ) return -1;
    } else {
      const inv = 1.0 / dz;
      let t1 = (minZ - oz) * inv;
      let t2 = (maxZ - oz) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }

    return tmin >= minDist && tmin <= maxDist ? tmin : -1;
  }

  const DEFAULT_AERIAL_BOUNDS = {
    minX: -39.0,
    maxX: 28.5,
    minZ: -33.0,
    maxZ: 31.0,
    minY: 0.85,
    maxY: 18.5,
  };

  function _clampAerialBounds(pos, halfY, bounds) {
    const b = bounds || DEFAULT_AERIAL_BOUNDS;
    const minY = Math.max(b.minY !== undefined ? b.minY : 0.85, halfY + 0.35);
    const maxY = b.maxY !== undefined ? b.maxY : 18.5;
    pos.x = Math.max(b.minX, Math.min(b.maxX, pos.x));
    pos.z = Math.max(b.minZ, Math.min(b.maxZ, pos.z));
    pos.y = Math.max(minY, Math.min(maxY, pos.y));
  }

  /**
   * 3D cylinder/capsule vs AABB push-out resolution for aerial units.
   * Mutates pos in place and returns whether a collision push-out occurred.
   */
  function resolveAerialObstacle(pos, boxes, radiusXZ = 1.0, halfY = 0.45, bounds = null) {
    let collided = false;
    _clampAerialBounds(pos, halfY, bounds);
    if (!Array.isArray(boxes) || boxes.length === 0) return false;

    const rSq = radiusXZ * radiusXZ;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b || b.disabled) continue;
        if (pos.y + halfY <= b.minY || pos.y - halfY >= b.maxY) continue;

        const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const distSq = dx * dx + dz * dz;
        if (distSq >= rSq) continue;

        collided = true;
        let horizPen;
        let horizNx = 0;
        let horizNz = 0;
        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          horizPen = radiusXZ - dist;
          horizNx = dx / dist;
          horizNz = dz / dist;
        } else {
          const dLeft = Math.abs(pos.x - b.minX);
          const dRight = Math.abs(b.maxX - pos.x);
          const dBack = Math.abs(pos.z - b.minZ);
          const dFront = Math.abs(b.maxZ - pos.z);
          const m = Math.min(dLeft, dRight, dBack, dFront);
          horizPen = m + radiusXZ;
          if (m === dLeft) horizNx = -1;
          else if (m === dRight) horizNx = 1;
          else if (m === dBack) horizNz = -1;
          else horizNz = 1;
        }

        const upPen = (b.maxY + halfY) - pos.y;
        const downPen = pos.y - (b.minY - halfY);

        if (b.minY > 2.5 && pos.y <= b.minY + 0.2 && downPen < horizPen && downPen < upPen) {
          pos.y = b.minY - halfY;
        } else if (pos.y >= b.maxY - 0.35 || (upPen < horizPen && b.maxY <= 8.5)) {
          pos.y = b.maxY + halfY;
        } else {
          pos.x += horizNx * horizPen;
          pos.z += horizNz * horizPen;
        }
      }
      _clampAerialBounds(pos, halfY, bounds);
    }
    return collided;
  }

  /**
   * Highest supporting obstacle top (or 0 for ground) beneath (x, z) at/below curY.
   */
  function getAerialFloorHeight(x, z, curY, boxes, radiusXZ = 0.95) {
    let floorY = 0;
    if (!Array.isArray(boxes)) return floorY;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b || b.disabled) continue;
      if (x + radiusXZ > b.minX && x - radiusXZ < b.maxX && z + radiusXZ > b.minZ && z - radiusXZ < b.maxZ) {
        if (b.maxY <= curY + 0.65 && b.maxY > floorY) {
          floorY = b.maxY;
        }
      }
    }
    return floorY;
  }

  function _isAerialPointClear(x, y, z, boxes, radiusXZ, halfY, bounds) {
    const bnd = bounds || DEFAULT_AERIAL_BOUNDS;
    if (x < bnd.minX || x > bnd.maxX || z < bnd.minZ || z > bnd.maxZ || y < bnd.minY || y > bnd.maxY) {
      return false;
    }
    if (!Array.isArray(boxes)) return true;
    const pad = 0.15;
    const rLimitSq = (radiusXZ + pad) * (radiusXZ + pad);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b || b.disabled) continue;
      if (y + halfY <= b.minY - pad || y - halfY >= b.maxY + pad) continue;
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < rLimitSq) return false;
    }
    return true;
  }

  /**
   * Finds an obstacle-free aerial spawn position nearest to preferredPos.
   */
  function findSafeAerialSpawn(preferredPos, boxes, {
    radiusXZ = 1.05,
    halfY = 0.5,
    minY = 2.0,
    bounds = null,
  } = {}) {
    const bnd = bounds || DEFAULT_AERIAL_BOUNDS;
    const px = Math.max(bnd.minX, Math.min(bnd.maxX, preferredPos.x));
    const py = Math.max(minY, Math.min(bnd.maxY, preferredPos.y));
    const pz = Math.max(bnd.minZ, Math.min(bnd.maxZ, preferredPos.z));

    if (_isAerialPointClear(px, py, pz, boxes, radiusXZ, halfY, bnd)) {
      return { x: px, y: py, z: pz };
    }

    const radii = [1.8, 3.2, 4.8, 6.8, 9.2, 12.0];
    const heights = [py, Math.max(py, 8.6)];
    for (let hi = 0; hi < heights.length; hi++) {
      const cy = Math.min(bnd.maxY, heights[hi]);
      for (let ri = 0; ri < radii.length; ri++) {
        const r = radii[ri];
        for (let ai = 0; ai < 12; ai++) {
          const ang = (ai / 12) * Math.PI * 2;
          const cx = px + Math.cos(ang) * r;
          const cz = pz + Math.sin(ang) * r;
          if (_isAerialPointClear(cx, cy, cz, boxes, radiusXZ, halfY, bnd)) {
            return { x: cx, y: cy, z: cz };
          }
        }
      }
    }

    const fallback = { x: px, y: py, z: pz };
    resolveAerialObstacle(fallback, boxes, radiusXZ, halfY, bnd);
    return fallback;
  }

  function _findFirstAerialRayHit(ox, oy, oz, dx, dy, dz, boxes, radiusXZ, halfY, maxDist) {
    let bestDist = maxDist + 1;
    let bestBox = null;
    if (!Array.isArray(boxes)) return null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b || b.disabled) continue;
      const d = raycastAABB(
        ox, oy, oz, dx, dy, dz,
        b.minX - radiusXZ, b.minY - halfY, b.minZ - radiusXZ,
        b.maxX + radiusXZ, b.maxY + halfY, b.maxZ + radiusXZ,
        0.001, maxDist
      );
      if (d >= 0 && d < bestDist) {
        bestDist = d;
        bestBox = b;
      }
    }
    return bestBox ? { dist: bestDist, box: bestBox } : null;
  }

  /**
   * Computes obstacle-aware horizontal steering + optional climbTargetY for aerial enemies.
   */
  function computeAerialSteerVector(pos, targetPos, boxes, navGrid, {
    radiusXZ = 1.0,
    halfY = 0.45,
    lookahead = 4.2,
    maxClimbY = 6.8,
    flankSign = 1,
    navWaypoint = null,
  } = {}) {
    const dx = targetPos.x - pos.x;
    const dz = targetPos.z - pos.z;
    const flatDist = Math.hypot(dx, dz);
    if (flatDist < 0.05) {
      return { dirX: 0, dirY: 0, dirZ: 0, climbTargetY: null, blockedAhead: false };
    }
    const nx = dx / flatDist;
    const nz = dz / flatDist;
    const probeLen = Math.min(flatDist, lookahead);

    const directHit = _findFirstAerialRayHit(pos.x, pos.y, pos.z, nx, 0, nz, boxes, radiusXZ, halfY, probeLen);
    if (!directHit) {
      return { dirX: nx, dirY: 0, dirZ: nz, climbTargetY: null, blockedAhead: false };
    }

    // Attempt smooth climb-over for lower obstacles (such as 2.6m/5.2m containers)
    const hitBox = directHit.box;
    const desiredClimbY = hitBox.maxY + halfY + 0.9;
    if (desiredClimbY <= maxClimbY && hitBox.minY < 2.0) {
      const upClear = !_findFirstAerialRayHit(
        pos.x, pos.y, pos.z, 0, 1, 0, boxes, radiusXZ * 0.9, halfY, Math.max(0.2, desiredClimbY - pos.y)
      );
      const overClear = upClear && !_findFirstAerialRayHit(
        pos.x, desiredClimbY, pos.z, nx, 0, nz, boxes, radiusXZ, halfY, probeLen
      );
      if (overClear) {
        return { dirX: nx, dirY: 0, dirZ: nz, climbTargetY: desiredClimbY, blockedAhead: true };
      }
    }

    // Check A* waypoint direction first if provided
    let baseYaw = Math.atan2(nx, nz);
    if (navWaypoint) {
      const wdx = navWaypoint.x - pos.x;
      const wdz = navWaypoint.z - pos.z;
      const wLen = Math.hypot(wdx, wdz);
      if (wLen > 0.25) {
        const wnx = wdx / wLen;
        const wnz = wdz / wLen;
        const navProbe = Math.min(wLen, lookahead);
        if (!_findFirstAerialRayHit(pos.x, pos.y, pos.z, wnx, 0, wnz, boxes, radiusXZ, halfY, navProbe)) {
          return { dirX: wnx, dirY: 0, dirZ: wnz, climbTargetY: null, blockedAhead: true };
        }
        baseYaw = Math.atan2(wnx, wnz);
      }
    }

    const s = flankSign >= 0 ? 1 : -1;
    const angleOffsetsDeg = [0, 35 * s, -35 * s, 68 * s, -68 * s, 100 * s, -100 * s, 135 * s, -135 * s];
    const feelerDist = Math.min(lookahead, 3.6);
    const clX = Math.max(hitBox.minX, Math.min(pos.x, hitBox.maxX));
    const clZ = Math.max(hitBox.minZ, Math.min(pos.z, hitBox.maxZ));
    const outX = pos.x - clX;
    const outZ = pos.z - clZ;
    const grazing = directHit.dist < 0.12 && (outX * outX + outZ * outZ) > 1e-6;
    const feelerOriginOffset = grazing ? 0.22 : 0;
    const feelerRadius = grazing ? radiusXZ * 0.92 : radiusXZ;
    let bestDirX = nx;
    let bestDirZ = nz;
    let bestClearDist = -1;

    for (let i = 0; i < angleOffsetsDeg.length; i++) {
      const rad = baseYaw + (angleOffsetsDeg[i] * Math.PI) / 180;
      const cx = Math.sin(rad);
      const cz = Math.cos(rad);
      if (grazing && (cx * outX + cz * outZ) < -0.05) continue;
      const hit = _findFirstAerialRayHit(
        pos.x + cx * feelerOriginOffset,
        pos.y,
        pos.z + cz * feelerOriginOffset,
        cx, 0, cz,
        boxes,
        feelerRadius,
        halfY,
        feelerDist
      );
      if (!hit) {
        return { dirX: cx, dirY: 0, dirZ: cz, climbTargetY: null, blockedAhead: true };
      }
      if (hit.dist > bestClearDist) {
        bestClearDist = hit.dist;
        bestDirX = cx;
        bestDirZ = cz;
      }
    }

    return { dirX: bestDirX, dirY: 0, dirZ: bestDirZ, climbTargetY: null, blockedAhead: true };
  }

  const RAIN_OCCLUSION_BOUNDS = {
    minX: -55,
    maxX: 55,
    minZ: -45,
    maxZ: 45,
    maxHeight: 24,
  };

  const RAIN_QUALITY_PROFILES = {
    low: { rainCount: 1000, splashCount: 48, rippleLayers: 1, lensRainTarget: 0.0, fullLighting: false },
    medium: { rainCount: 2200, splashCount: 96, rippleLayers: 2, lensRainTarget: 0.55, fullLighting: false },
    high: { rainCount: 3800, splashCount: 150, rippleLayers: 2, lensRainTarget: 0.90, fullLighting: true },
    extreme: { rainCount: 5600, splashCount: 220, rippleLayers: 3, lensRainTarget: 0.95, fullLighting: true },
  };

  function _clampInt(val, minVal, maxVal) {
    return Math.max(minVal, Math.min(maxVal, val));
  }

  /**
   * Bakes static world AABBs into a uint8 2D heightmap for rain/splash/puddle occlusion.
   */
  function bakeRainOcclusionHeightmap(boxes, opts = {}) {
    const cfg = opts || {};
    const width = Math.max(1, Math.floor(Number.isFinite(cfg.width) ? cfg.width : 256));
    const height = Math.max(1, Math.floor(Number.isFinite(cfg.height) ? cfg.height : 256));
    const minX = Number.isFinite(cfg.minX) ? cfg.minX : RAIN_OCCLUSION_BOUNDS.minX;
    const maxX = Number.isFinite(cfg.maxX) ? cfg.maxX : RAIN_OCCLUSION_BOUNDS.maxX;
    const minZ = Number.isFinite(cfg.minZ) ? cfg.minZ : RAIN_OCCLUSION_BOUNDS.minZ;
    const maxZ = Number.isFinite(cfg.maxZ) ? cfg.maxZ : RAIN_OCCLUSION_BOUNDS.maxZ;
    const maxHeight = (Number.isFinite(cfg.maxHeight) && cfg.maxHeight > 0)
      ? cfg.maxHeight
      : RAIN_OCCLUSION_BOUNDS.maxHeight;

    const heights = new Uint8Array(width * height);
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    if (!(spanX > 0 && spanZ > 0) || !Array.isArray(boxes)) {
      return { width, height, minX, maxX, minZ, maxZ, maxHeight, heights };
    }

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b || b.disabled || b.isDynamic) continue;
      if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX) ||
          !Number.isFinite(b.minZ) || !Number.isFinite(b.maxZ) ||
          !Number.isFinite(b.maxY)) {
        continue;
      }
      if (b.maxY < 1.5) continue;
      if (b.maxX < b.minX || b.maxZ < b.minZ) continue;
      if ((b.maxX - b.minX) < 0.75 && (b.maxZ - b.minZ) < 0.75) continue;
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;

      const col0 = _clampInt(Math.floor(((b.minX - minX) / spanX) * width), 0, width - 1);
      const col1 = _clampInt(Math.floor(((b.maxX - minX) / spanX) * width), 0, width - 1);
      const row0 = _clampInt(Math.floor(((b.minZ - minZ) / spanZ) * height), 0, height - 1);
      const row1 = _clampInt(Math.floor(((b.maxZ - minZ) / spanZ) * height), 0, height - 1);

      const val = Math.round(Math.max(0, Math.min(1, b.maxY / maxHeight)) * 255);
      if (val <= 0) continue;

      for (let r = row0; r <= row1; r++) {
        const rowOffset = r * width;
        for (let c = col0; c <= col1; c++) {
          const idx = rowOffset + c;
          if (val > heights[idx]) heights[idx] = val;
        }
      }
    }

    return { width, height, minX, maxX, minZ, maxZ, maxHeight, heights };
  }

  /**
   * Samples baked rain occlusion height in meters at world (x, z); returns 0 when unoccluded or outside bounds.
   */
  function sampleRainOcclusionHeight(map, x, z) {
    if (!map || !map.heights || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
    if (x < map.minX || x > map.maxX || z < map.minZ || z > map.maxZ) return 0;
    const width = map.width;
    const height = map.height;
    const spanX = map.maxX - map.minX;
    const spanZ = map.maxZ - map.minZ;
    if (!(width > 0 && height > 0 && spanX > 0 && spanZ > 0 && map.maxHeight > 0)) return 0;
    const col = _clampInt(Math.floor(((x - map.minX) / spanX) * width), 0, width - 1);
    const row = _clampInt(Math.floor(((z - map.minZ) / spanZ) * height), 0, height - 1);
    return ((map.heights[row * width + col] || 0) / 255) * map.maxHeight;
  }

  /**
   * Returns rain particle/splash/ripple/lens quality parameters for a quality preset (falls back to high).
   */
  function getRainQualityProfile(quality) {
    const key = sanitizeQualityPreset(quality);
    return { ...RAIN_QUALITY_PROFILES[key] };
  }

  const api = {
    selectVoiceAction,
    computeWatchdogTimeoutMs,
    computeRelativeHitAngleDeg,
    computeExplosionFalloff,
    computePlayerHitbox,
    segmentHitsCapsule,
    computeSpatialAudioParams,
    classifySoundAlert,
    sanitizeUserSettings,
    TUTORIAL_TOTAL_STEPS,
    TUTORIAL_STEP_VOICES,
    computeAdsSensitivityScale,
    computeAdsOpticsState,
    TRAINING_STAGES,
    STEALTH_STATES,
    evaluateStealthStep,
    buildNavGrid,
    worldToCell,
    cellToWorld,
    findGridPath,
    resolveAerialObstacle,
    getAerialFloorHeight,
    findSafeAerialSpawn,
    computeAerialSteerVector,
    WEAPON_CATALOG,
    THROWABLE_CATALOG,
    DIFFICULTIES,
    getDifficultyConfig,
    selectAimAssistDirection,
    MUTATORS,
    GUN_SKINS,
    AIRDROP_PERKS,
    MEDAL_CATALOG,
    computeShotDamage,
    rollEndlessAirdropOptions,
    computeMissionRating,
    createDefaultCareerProfile,
    updateCareerRecords,
    computeTimedTargetScore,
    computeEndlessWaveSpec,
    createDefaultTrainingRecords,
    updateTrainingRecords,
    QUALITY_PRESETS,
    EXTREME_MAX_PIXELS,
    sanitizeQualityPreset,
    computeDrsScale,
    computeExtremePixelCap,
    computeActiveViewportSize,
    scoreVirtualLight,
    raycastAABB,
    RAIN_OCCLUSION_BOUNDS,
    bakeRainOcclusionHeightmap,
    sampleRainOcclusionHeight,
    getRainQualityProfile,
  };
  if (typeof window !== 'undefined') {
    window.__GAME_LOGIC__ = api;
    window.GameLogic = api;
  }
  return api;
})();

const VoiceEngine = (() => {
  'use strict';

  const FALLBACK_ROLES = {
    instructor: { speakerLabel: '教官', speakerLabelEn: 'INSTRUCTOR', speechPitch: 0.9, speechRate: 1.05 },
    watcher: { speakerLabel: '守望者 // 频道04', speakerLabelEn: 'OVERWATCH // CH-04', speechPitch: 1.04, speechRate: 1.05 },
    evac: { speakerLabel: '撤离艇 // 01', speakerLabelEn: 'EVAC-01', speechPitch: 0.95, speechRate: 1.1 },
  };

  function getGlobalRoot() {
    if (typeof window !== 'undefined') return window;
    if (typeof globalThis !== 'undefined') return globalThis;
    return null;
  }

  function normalizeLang(lang, fallback = 'zh') {
    if (lang === 'auto') {
      if (typeof I18n !== 'undefined') {
        if (typeof I18n.resolveVoiceLang === 'function') return I18n.resolveVoiceLang('auto') === 'en' ? 'en' : 'zh';
        if (typeof I18n.getLang === 'function') return I18n.getLang() === 'en' ? 'en' : 'zh';
      }
      return fallback === 'en' ? 'en' : 'zh';
    }
    if (typeof lang === 'string') {
      const trimmed = lang.trim();
      if (/^en/i.test(trimmed)) return 'en';
      if (/^zh/i.test(trimmed)) return 'zh';
    }
    return fallback === 'en' ? 'en' : 'zh';
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  class Manager {
    constructor(audio, opts = {}) {
      this.audio = audio;
      const initLang = typeof opts === 'string' ? opts : (opts && opts.voiceLang);
      this.voiceLang = normalizeLang(initLang, 'zh');
      this.bufferCache = new Map();
      this.decodePromises = new Map();
      this.packLoadPromises = new Map();
      this.cooldowns = new Map();
      this.current = null;
      this.token = 0;
      this.paused = false;
      this.watchdogId = null;
      this.watchdogRemainingMs = 0;
      this.watchdogStartedAt = 0;
      this.cachedVoices = [];

      if (typeof window !== 'undefined' && window.speechSynthesis) {
        const refreshVoices = () => {
          try {
            this.cachedVoices = window.speechSynthesis.getVoices() || [];
          } catch (e) {}
        };
        refreshVoices();
        if (typeof window.speechSynthesis.addEventListener === 'function') {
          window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
        }
      }
    }

    setVoiceLang(lang) {
      this.voiceLang = normalizeLang(lang, 'zh');
      return this.ensurePackLoaded(this.voiceLang);
    }

    ensurePackLoaded(lang = this.voiceLang) {
      const target = normalizeLang(lang, this.voiceLang || 'zh');
      const existing = this._getPack(target);
      if (existing) return Promise.resolve(existing);
      if (this.packLoadPromises.has(target)) {
        return this.packLoadPromises.get(target);
      }
      if (typeof document === 'undefined' || !document.createElement) {
        return Promise.resolve(null);
      }
      const parent = document.head || document.body || document.documentElement;
      if (!parent) {
        return Promise.resolve(null);
      }

      const src = target === 'en' ? 'voices/voice_pack_en.js' : 'voices/voice_pack.js';
      let settledFailed = false;
      const p = new Promise((resolve) => {
        try {
          const script = document.createElement('script');
          script.src = src;
          script.async = true;
          script.onload = () => {
            const loaded = this._getPack(target);
            if (!loaded) {
              settledFailed = true;
              this.packLoadPromises.delete(target);
            }
            resolve(loaded);
          };
          script.onerror = () => {
            settledFailed = true;
            this.packLoadPromises.delete(target);
            resolve(null);
          };
          parent.appendChild(script);
        } catch (err) {
          settledFailed = true;
          this.packLoadPromises.delete(target);
          resolve(null);
        }
      });
      if (!settledFailed) {
        this.packLoadPromises.set(target, p);
      }
      return p;
    }

    _getPack(lang = this.voiceLang) {
      const target = normalizeLang(lang, this.voiceLang || 'zh');
      const root = getGlobalRoot();
      if (!root) return null;
      if (root.__VOICE_PACKS__ && root.__VOICE_PACKS__[target]) {
        return root.__VOICE_PACKS__[target];
      }
      if (target === 'zh' && root.__VOICE_PACK__) {
        return root.__VOICE_PACK__;
      }
      return null;
    }

    _getAnyLoadedPack(clipId) {
      const active = this._getPack(this.voiceLang);
      if (active && (!clipId || (active.clips && active.clips[clipId]))) {
        return active;
      }
      const root = getGlobalRoot();
      if (!root) return null;
      const packs = root.__VOICE_PACKS__;
      if (packs && typeof packs === 'object') {
        const keys = Object.keys(packs);
        for (let i = 0; i < keys.length; i++) {
          const p = packs[keys[i]];
          if (p && (!clipId || (p.clips && p.clips[clipId]))) {
            return p;
          }
        }
      }
      if (root.__VOICE_PACK__ && (!clipId || (root.__VOICE_PACK__.clips && root.__VOICE_PACK__.clips[clipId]))) {
        return root.__VOICE_PACK__;
      }
      return null;
    }

    _getPackClip(clipId, lang = this.voiceLang) {
      const pack = this._getPack(lang);
      return pack && pack.clips ? pack.clips[clipId] || null : null;
    }

    _getRoleConfig(role, lang = this.voiceLang) {
      const pack = this._getPack(lang) || this._getAnyLoadedPack();
      return (pack && pack.roles && pack.roles[role]) || FALLBACK_ROLES[role] || FALLBACK_ROLES.watcher;
    }

    getClipSubtitle(clipId, uiLang) {
      const fallbackLang = typeof I18n !== 'undefined' && typeof I18n.getLang === 'function'
        ? I18n.getLang()
        : this.voiceLang;
      const lang = normalizeLang(uiLang || fallbackLang, this.voiceLang || 'zh');
      const langPack = this._getPack(lang);
      let clip = langPack && langPack.clips ? langPack.clips[clipId] : null;
      if (!clip) {
        const anyPack = this._getAnyLoadedPack(clipId);
        clip = anyPack && anyPack.clips ? anyPack.clips[clipId] : null;
      }
      if (!clip) return '';
      return lang === 'en'
        ? (clip.displayTextEn || clip.displayText || '')
        : (clip.displayText || clip.displayTextEn || '');
    }

    getRoleLabel(role, uiLang) {
      const fallbackLang = typeof I18n !== 'undefined' && typeof I18n.getLang === 'function'
        ? I18n.getLang()
        : this.voiceLang;
      const lang = normalizeLang(uiLang || fallbackLang, this.voiceLang || 'zh');
      const pack = this._getPack(lang) || this._getAnyLoadedPack();
      const packRole = pack && pack.roles && pack.roles[role];
      const fb = FALLBACK_ROLES[role] || FALLBACK_ROLES.watcher;
      if (lang === 'en') {
        return (packRole && packRole.speakerLabelEn) || fb.speakerLabelEn || (packRole && packRole.speakerLabel) || fb.speakerLabel || '';
      }
      return (packRole && packRole.speakerLabel) || fb.speakerLabel || (packRole && packRole.speakerLabelEn) || fb.speakerLabelEn || '';
    }

    prewarm(clipIds, lang = this.voiceLang) {
      if (!this.audio || !this.audio.ctx || !Array.isArray(clipIds)) return;
      const targetLang = normalizeLang(lang, this.voiceLang || 'zh');
      const run = () => {
        for (let i = 0; i < clipIds.length; i++) {
          this._decodeClip(clipIds[i], targetLang).catch(() => {});
        }
      };
      if (this._getPack(targetLang)) {
        run();
      } else {
        this.ensurePackLoaded(targetLang).then((pack) => {
          if (pack) run();
        });
      }
    }

    _decodeClip(clipId, lang = this.voiceLang) {
      const targetLang = normalizeLang(lang, this.voiceLang || 'zh');
      const cacheKey = `${targetLang}:${clipId}`;
      if (this.bufferCache.has(cacheKey)) {
        return Promise.resolve(this.bufferCache.get(cacheKey));
      }
      if (this.decodePromises.has(cacheKey)) {
        return this.decodePromises.get(cacheKey);
      }
      const clip = this._getPackClip(clipId, targetLang);
      if (!clip || !clip.data || !this.audio || !this.audio.ctx) {
        return Promise.resolve(null);
      }
      const p = (async () => {
        try {
          const ab = base64ToArrayBuffer(clip.data);
          const audioBuf = await this.audio.ctx.decodeAudioData(ab);
          this.bufferCache.set(cacheKey, audioBuf);
          return audioBuf;
        } catch (err) {
          return null;
        } finally {
          this.decodePromises.delete(cacheKey);
        }
      })();
      this.decodePromises.set(cacheKey, p);
      return p;
    }

    _pickSpeechVoice(role, lang = this.voiceLang) {
      const voices = this.cachedVoices;
      if (!voices || voices.length === 0) return null;
      const targetLang = normalizeLang(lang, this.voiceLang || 'zh');
      const preferFemale = role === 'watcher';

      if (targetLang === 'en') {
        const enUsVoices = voices.filter((v) => /^en[-_]us/i.test(v.lang || ''));
        const enVoices = enUsVoices.length > 0 ? enUsVoices : voices.filter((v) => /^en\b/i.test(v.lang || ''));
        const pool = enVoices.length > 0 ? enVoices : voices;
        const byGender = pool.find((v) => {
          const n = (v.name || '').toLowerCase();
          return preferFemale
            ? (n.includes('aria') || n.includes('jenny') || n.includes('zira') || n.includes('samantha') || n.includes('victoria') || n.includes('karen') || n.includes('female'))
            : (n.includes('guy') || n.includes('christopher') || n.includes('david') || n.includes('mark') || n.includes('alex') || n.includes('daniel') || n.includes('ryan') || /\bmale\b/.test(n));
        });
        if (byGender) return byGender;
        const natural = pool.find((v) => /natural|online/i.test(v.name || ''));
        return natural || pool[0];
      }

      const zhVoices = voices.filter((v) => /zh|cmn/i.test(v.lang || ''));
      const pool = zhVoices.length > 0 ? zhVoices : voices;
      const byGender = pool.find((v) => {
        const n = (v.name || '').toLowerCase();
        return preferFemale
          ? (n.includes('xiaoxiao') || n.includes('huihui') || n.includes('xiaoyi') || n.includes('female'))
          : (n.includes('yunjian') || n.includes('yunxi') || n.includes('yunyang') || n.includes('kangkang') || /\bmale\b/.test(n));
      });
      if (byGender) return byGender;
      const natural = pool.find((v) => /natural|online/i.test(v.name || ''));
      return natural || pool[0];
    }

    _clearWatchdog() {
      if (this.watchdogId !== null) {
        clearTimeout(this.watchdogId);
        this.watchdogId = null;
      }
    }

    _armWatchdog(timeoutMs, myToken) {
      this._clearWatchdog();
      this.watchdogRemainingMs = timeoutMs;
      this.watchdogStartedAt = performance.now();
      this.watchdogId = setTimeout(() => {
        if (this.current && this.current.token === myToken) {
          this._finishCurrent(true);
        }
      }, timeoutMs);
    }

    _finishCurrent(playSquelch = true) {
      const cur = this.current;
      if (!cur) return;
      this.current = null;
      this._clearWatchdog();
      this.audio.stopRadioCarrier();
      this.audio.setVoiceDucking(false);
      if (playSquelch) {
        this.audio.playRadioPTT(true);
      }
      if (cur.source) {
        try {
          cur.source.onended = null;
          cur.source.stop();
          cur.source.disconnect();
        } catch (e) {}
      }
      if (cur.usedSpeech && typeof window !== 'undefined' && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch (e) {}
      }
      if (typeof cur.onEnd === 'function') {
        cur.onEnd(true);
      }
    }

    stop(playSquelch = false) {
      this.token++;
      if (this.current) {
        this._finishCurrent(playSquelch);
      } else {
        this._clearWatchdog();
        this.audio.stopRadioCarrier();
        this.audio.setVoiceDucking(false);
      }
    }

    setPaused(paused) {
      this.paused = paused;
      if (this.audio && this.audio.ctx) {
        if (paused && this.audio.ctx.state === 'running') {
          this.audio.ctx.suspend().catch(() => {});
        } else if (!paused && this.audio.ctx.state === 'suspended') {
          this.audio.ctx.resume().catch(() => {});
        }
      }
      if (!this.current) return;
      if (paused) {
        // 冻结缓冲语音看门狗；兜底 speechSynthesis 直接干净终止以免后台续播
        if (this.current.usedSpeech) {
          this._finishCurrent(false);
        } else if (this.watchdogId !== null) {
          const elapsed = performance.now() - this.watchdogStartedAt;
          this.watchdogRemainingMs = Math.max(500, this.watchdogRemainingMs - elapsed);
          this._clearWatchdog();
        }
      } else if (!this.current.usedSpeech && this.watchdogRemainingMs > 0) {
        this._armWatchdog(this.watchdogRemainingMs, this.current.token);
      }
    }

    isSpeaking() {
      return !!this.current;
    }

    speak(clipId, opts = {}) {
      if (!this.audio || this.audio.voiceMode === 'off' || this.audio.voiceVolume <= 0.01) {
        if (opts.onEnd) opts.onEnd(false);
        return { played: false, reason: 'disabled' };
      }

      const activeLang = normalizeLang(opts.voiceLang || this.voiceLang || 'zh');
      const packClip = this._getPackClip(clipId, activeLang);
      const anyPack = !packClip ? this._getAnyLoadedPack(clipId) : null;
      const metaClip = packClip || (anyPack && anyPack.clips && anyPack.clips[clipId]) || null;

      const text = opts.text || this.getClipSubtitle(clipId, activeLang) || (metaClip && (metaClip.displayText || metaClip.displayTextEn)) || '';
      const role = opts.role || (metaClip && metaClip.role) || 'watcher';
      const priority = opts.priority ?? (metaClip && metaClip.priority) ?? 2;
      const cooldownSec = opts.cooldownSec ?? (metaClip && metaClip.cooldownSec) ?? 0;

      const nowMs = performance.now();
      const cooldownUntil = this.cooldowns.get(clipId) || 0;
      const decision = GameLogic.selectVoiceAction(this.current, priority, cooldownUntil, nowMs);
      if (decision !== 'play') {
        if (opts.onEnd) opts.onEnd(false);
        return { played: false, reason: decision };
      }

      if (cooldownSec > 0) {
        this.cooldowns.set(clipId, nowMs + cooldownSec * 1000);
      }

      this.stop(false);
      const myToken = ++this.token;
      const entry = {
        token: myToken,
        clipId,
        voiceLang: activeLang,
        priority,
        role,
        text,
        source: null,
        usedSpeech: false,
        onEnd: opts.onEnd || null,
        onStart: opts.onStart || null,
      };
      this.current = entry;

      this.audio.setVoiceDucking(true);
      this.audio.playRadioPTT(false);
      this.audio.startRadioCarrier();
      if (entry.onStart) entry.onStart();

      const decodePromise = this._getPack(activeLang)
        ? this._decodeClip(clipId, activeLang)
        : this.ensurePackLoaded(activeLang).then(() => {
            if (!this.current || this.current.token !== myToken) return null;
            return this._decodeClip(clipId, activeLang);
          });

      decodePromise.then((audioBuf) => {
        if (!this.current || this.current.token !== myToken) return;
        const loadedClip = this._getPackClip(clipId, activeLang)
          || ((this._getAnyLoadedPack(clipId) || {}).clips || {})[clipId]
          || null;
        if (opts.cooldownSec === undefined && cooldownSec === 0 && loadedClip && loadedClip.cooldownSec > 0) {
          this.cooldowns.set(clipId, performance.now() + loadedClip.cooldownSec * 1000);
        }
        if (audioBuf && this.audio.ctx) {
          const src = this.audio.ctx.createBufferSource();
          src.buffer = audioBuf;
          const dest = this.audio.voiceMode === 'radio'
            ? (this.audio.radioInput || this.audio.voiceGain)
            : (this.audio.cleanVoiceInput || this.audio.voiceGain);
          src.connect(dest);
          src.onended = () => {
            if (this.current && this.current.token === myToken) {
              this._finishCurrent(true);
            }
          };
          entry.source = src;
          const durMs = Math.ceil(audioBuf.duration * 1000) + 1200;
          this._armWatchdog(durMs, myToken);
          src.start();
          return;
        }

        // 无预生成缓冲时降级使用浏览器 speechSynthesis，优先采用当前语音语言对应的台词文本
        const ttsText = activeLang === 'en'
          ? ((loadedClip && loadedClip.displayTextEn) || opts.ttsText || opts.textEn || opts.text || (loadedClip && loadedClip.displayText) || '')
          : ((loadedClip && loadedClip.displayText) || opts.ttsText || opts.text || (loadedClip && loadedClip.displayTextEn) || '');
        if (!entry.text) entry.text = ttsText;
        this._speakWithSynthesis(entry, ttsText, activeLang);
      });

      return { played: true, reason: 'ok' };
    }

    _speakWithSynthesis(entry, ttsText, lang = this.voiceLang) {
      if (typeof window === 'undefined' || !window.speechSynthesis || !ttsText) {
        this._finishCurrent(false);
        return;
      }
      try {
        const targetLang = normalizeLang(lang, this.voiceLang || 'zh');
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(ttsText);
        utt.lang = targetLang === 'en' ? 'en-US' : 'zh-CN';
        const roleCfg = this._getRoleConfig(entry.role, targetLang);
        const voice = this._pickSpeechVoice(entry.role, targetLang);
        if (voice) utt.voice = voice;
        utt.pitch = roleCfg.speechPitch || 1.0;
        utt.rate = roleCfg.speechRate || 1.05;
        utt.volume = Math.max(0, Math.min(1, this.audio.volume * this.audio.voiceVolume));

        const myToken = entry.token;
        entry.usedSpeech = true;
        utt.onend = () => {
          if (this.current && this.current.token === myToken) {
            this._finishCurrent(true);
          }
        };
        utt.onerror = () => {
          if (this.current && this.current.token === myToken) {
            this._finishCurrent(false);
          }
        };
        this._armWatchdog(GameLogic.computeWatchdogTimeoutMs(ttsText, targetLang), myToken);
        window.speechSynthesis.speak(utt);
      } catch (e) {
        this._finishCurrent(false);
      }
    }
  }

  return Manager;
})();
