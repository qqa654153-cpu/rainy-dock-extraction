// ============================================================================
// 模块 6：AI 敌人、三段式潜行警戒、A* 寻路与等离子弹道系统 (EnemyManager)
// 包含：巡逻无人机、机械犬、防爆盾重装机兵、高台激光狙击无人机、警戒发报无人机。
// ============================================================================

const EnemyManager = (() => {
  'use strict';

  const _upVec = new THREE.Vector3(0, 1, 0);
  const _ePos = new THREE.Vector3();
  const _playerCenter = new THREE.Vector3();
  const _nextPos = new THREE.Vector3();
  const _hbCenterVec = new THREE.Vector3();
  const _toPlayer = new THREE.Vector3();
  const _eyeOrigin = new THREE.Vector3();
  const _playerEye = new THREE.Vector3();
  const _flatDir = new THREE.Vector3();
  const _rightVec = new THREE.Vector3();
  const _desired = new THREE.Vector3();
  const _patrolGoal = new THREE.Vector3();
  const _aheadTarget = { x: 0, y: 0, z: 0 };
  const _patrolTarget = { x: 0, y: 0, z: 0 };
  const _muzzleTmp = new THREE.Vector3();
  const _dirTmp = new THREE.Vector3();
  const _navDirTmp = new THREE.Vector3();
  const _sideTmp = new THREE.Vector3();
  const _toETmp = new THREE.Vector3();
  const _flatDirTmp = new THREE.Vector3();
  const _fwdTmp = new THREE.Vector3();
  const _eFwdTmp = new THREE.Vector3();
  const _enemyToPlayerTmp = new THREE.Vector3();
  const _pushTmp = new THREE.Vector3();
  const _smokeTmp = new THREE.Vector3();
  const _boltDirTmp = new THREE.Vector3();
  const _hbArg = { pos: null, curEye: 1.68, leanDir: 0, rightX: 1, rightZ: 0, crouching: false, sliding: false };

  let _sharedAssets = null;
  function _getSharedEnemyAssets() {
    if (_sharedAssets) return _sharedAssets;
    const haloBox = new THREE.BoxGeometry(1.15, 1.15, 1.15);
    const scanHaloGeo = new THREE.EdgesGeometry(haloBox);
    haloBox.dispose();

    const assets = {
      scanHaloGeo,
      alertRingGeo: new THREE.RingGeometry(0.18, 0.28, 16),

      droneBodyGeo: new THREE.BoxGeometry(0.92, 0.36, 0.92),
      droneCoreGeo: new THREE.SphereGeometry(0.24, 12, 10),
      droneArmGeo: new THREE.BoxGeometry(0.1, 0.08, 0.85),
      droneBladeGeo: new THREE.BoxGeometry(0.7, 0.02, 0.07),
      droneBladeMat: new THREE.MeshBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.72 }),
      droneExtFrameGeo: null,
      droneExtArmorGeo: null,

      houndTorsoGeo: new THREE.BoxGeometry(0.62, 0.42, 1.18),
      houndHeadGeo: new THREE.BoxGeometry(0.36, 0.28, 0.36),
      houndVisorGeo: new THREE.BoxGeometry(0.32, 0.1, 0.08),
      houndLegUpperGeo: new THREE.BoxGeometry(0.11, 0.38, 0.13),
      houndLegLowerGeo: new THREE.BoxGeometry(0.08, 0.32, 0.09),
      houndLegExtGeo: null,
      houndSpineExtGeo: null,

      shieldBodyGeo: new THREE.BoxGeometry(0.95, 1.2, 0.68),
      shieldHeadGeo: new THREE.BoxGeometry(0.42, 0.34, 0.42),
      shieldVisorGeo: new THREE.BoxGeometry(0.36, 0.1, 0.08),
      shieldBackCoreGeo: new THREE.BoxGeometry(0.44, 0.56, 0.22),
      shieldSlabGeo: new THREE.BoxGeometry(1.18, 1.72, 0.12),
      shieldViewportGeo: new THREE.BoxGeometry(0.76, 0.16, 0.14),
      shieldLegGeo: new THREE.BoxGeometry(0.28, 0.72, 0.34),
      shieldAlloyMat: new THREE.MeshStandardMaterial({ color: 0x1b232e, metalness: 0.9, roughness: 0.28 }),
      shieldExtArmorGeo: null,
      shieldExtFrameGeo: null,
      shieldExtSlabGeo: null,

      sniperBodyGeo: new THREE.BoxGeometry(0.66, 0.28, 1.32),
      sniperWingGeo: new THREE.BoxGeometry(1.75, 0.06, 0.36),
      sniperBarrelGeo: new THREE.CylinderGeometry(0.05, 0.06, 0.95, 8),
      sniperOpticGeo: new THREE.SphereGeometry(0.21, 10, 8),
      sniperFinExtGeo: null,

      reconDomeGeo: new THREE.SphereGeometry(0.18, 10, 8),
      reconDomeMat: new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    };

    if (typeof ExtremeGfx !== 'undefined' && ExtremeGfx.mergeGeometriesSafe && ExtremeGfx.createTransformedGeo) {
      const tx = ExtremeGfx.createTransformedGeo;
      const merge = ExtremeGfx.mergeGeometriesSafe;

      const dfGeos = [];
      const daGeos = [];
      const armAngles = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
      for (const ang of armAngles) {
        const ax = Math.cos(ang) * 0.72;
        const az = Math.sin(ang) * 0.72;
        dfGeos.push(tx(new THREE.TorusGeometry(0.39, 0.025, 6, 18), { x: ax, y: 0.14, z: az, rx: Math.PI / 2 }));
        dfGeos.push(tx(new THREE.CylinderGeometry(0.06, 0.07, 0.11, 10), { x: ax, y: 0.09, z: az }));
      }
      daGeos.push(tx(new THREE.BoxGeometry(0.46, 0.08, 0.22), { x: 0, y: 0.19, z: 0.44, rx: 0.18 }));
      daGeos.push(tx(new THREE.BoxGeometry(0.76, 0.14, 0.2), { x: 0, y: 0.22, z: -0.22 }));
      dfGeos.push(tx(new THREE.CylinderGeometry(0.015, 0.02, 0.34, 6), { x: -0.25, y: 0.32, z: -0.32, rx: -0.25 }));
      assets.droneExtFrameGeo = merge(dfGeos);
      assets.droneExtArmorGeo = merge(daGeos);

      assets.houndLegExtGeo = merge([
        tx(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 10), { y: -0.02, rz: Math.PI / 2 }),
        tx(new THREE.BoxGeometry(0.13, 0.11, 0.15), { y: -0.31, z: 0.03 }),
        tx(new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6), { x: 0, y: -0.18, z: -0.08, rx: 0.15 }),
      ]);
      const spineGeos = [];
      for (let i = 0; i < 4; i++) {
        spineGeos.push(tx(new THREE.BoxGeometry(0.32, 0.12, 0.09), { y: 0.89, z: -0.36 + i * 0.22, rx: -0.32 }));
      }
      spineGeos.push(tx(new THREE.BoxGeometry(0.46, 0.16, 0.26), { y: 0.72, z: 0.52 }));
      spineGeos.push(tx(new THREE.BoxGeometry(0.42, 0.14, 0.18), { y: 0.66, z: 0.78 }));
      assets.houndSpineExtGeo = merge(spineGeos);

      assets.shieldExtArmorGeo = merge([
        tx(new THREE.BoxGeometry(0.34, 0.42, 0.74), { x: -0.58, y: 1.68, z: 0.02, rz: 0.22 }),
        tx(new THREE.BoxGeometry(0.34, 0.42, 0.74), { x: 0.58, y: 1.68, z: 0.02, rz: -0.22 }),
        tx(new THREE.BoxGeometry(0.82, 0.44, 0.16), { x: 0, y: 1.48, z: 0.38 }),
      ]);
      assets.shieldExtFrameGeo = merge([
        tx(new THREE.CylinderGeometry(0.04, 0.04, 0.66, 8), { x: -0.26, y: 1.38, z: -0.44 }),
        tx(new THREE.CylinderGeometry(0.04, 0.04, 0.66, 8), { x: 0.26, y: 1.38, z: -0.44 }),
        tx(new THREE.BoxGeometry(0.62, 0.08, 0.24), { x: 0, y: 1.72, z: -0.44 }),
        tx(new THREE.BoxGeometry(0.32, 0.18, 0.38), { x: -0.28, y: 0.46, z: 0.06 }),
        tx(new THREE.BoxGeometry(0.32, 0.18, 0.38), { x: 0.28, y: 0.46, z: 0.06 }),
      ]);
      const shGeos = [];
      for (const ry of [-0.62, 0.18, 0.72]) {
        shGeos.push(tx(new THREE.BoxGeometry(1.22, 0.08, 0.16), { y: ry }));
      }
      shGeos.push(tx(new THREE.BoxGeometry(0.08, 1.74, 0.16), { x: -0.56 }));
      shGeos.push(tx(new THREE.BoxGeometry(0.08, 1.74, 0.16), { x: 0.56 }));
      assets.shieldExtSlabGeo = merge(shGeos);

      assets.sniperFinExtGeo = merge([
        tx(new THREE.BoxGeometry(0.42, 0.05, 0.44), { x: -0.28, y: 0.22, z: -0.46, rz: 0.52 }),
        tx(new THREE.BoxGeometry(0.42, 0.05, 0.44), { x: 0.28, y: 0.22, z: -0.46, rz: -0.52 }),
        tx(new THREE.CylinderGeometry(0.08, 0.08, 0.45, 10), { y: -0.14, z: 0.46, rx: Math.PI / 2 }),
        tx(new THREE.BoxGeometry(0.32, 0.08, 0.22), { y: 0.16, z: 0.56, rx: 0.16 }),
      ]);
    }

    _sharedAssets = assets;
    return _sharedAssets;
  }

  class BaseEnemy {
    constructor(type, manager, pos, opts = {}) {
      this.type = type;
      this.manager = manager;
      this.assets = _getSharedEnemyAssets();
      this.group = new THREE.Group();
      this.group.position.copy(pos);
      this.hitboxes = [];
      this.dead = false;
      this.dying = false;
      this.disposed = false;
      this.dyingTimer = 0;
      this.dyingDuration = 0.55;
      this.dyingSilent = false;
      this._dyingFallVel = 0;
      this._dyingSpinX = 0;
      this._dyingSpinZ = 0;
      this._dyingRollDir = 1;
      this._dyingBaseY = pos.y;
      this._ownedGeos = [];
      this._ownedMats = [];

      this.stealthState = opts.alertImmediately ? 'COMBAT' : 'PATROL';
      this.alerted = !!opts.alertImmediately;
      this.suspicion = opts.alertImmediately ? 1.0 : 0;
      this.timeSinceLastSeen = 99;
      this.investigatePos = null;
      this.isTutorialTarget = !!opts.isTutorialTarget;
      this.requireMeleeKill = !!opts.requireMeleeKill;
      this.requireEmpBeforeKill = !!opts.requireEmpBeforeKill;
      this.allowTutorialMelee = !!opts.allowTutorialMelee;
      this.tutorialNoAttack = !!opts.tutorialNoAttack;
      this.tutorialFacingYaw = Number.isFinite(opts.tutorialFacingYaw) ? opts.tutorialFacingYaw : null;
      this.path = [];
      this.pathIndex = 0;
      this.pathTimer = Math.random() * 0.35;

      this.empTimer = 0;
      this.staggerTimer = 0;
      this.highlightedTimer = 0;
      this.callInTimer = -1;
      this.alarmCommitted = !!opts.alertImmediately;

      this.lastHitWasCrit = false;
      this.attackCooldown = 1.1 + Math.random() * 0.7;
      this.chargeTimer = 0;
      this.hitFlash = 0;
      this.dmgScale = opts.dmgScale || 1.0;
      this.speedScale = opts.speedScale || 1.0;
      this.cooldownScale = opts.cooldownScale || 1.0;
      this.boltSpeedScale = opts.boltSpeedScale || 1.0;
      this.jitterScale = opts.jitterScale || 1.0;
      this.callInScale = opts.callInScale || 1.0;
      this.vel = new THREE.Vector3();
      this.patrolOrigin = pos.clone();
      this.patrolPhase = Math.random() * Math.PI * 2;
      this.scanHalo = null;
      this.alertRingMat = null;
      this.alertRing = null;
      this.extremeDetailGroup = new THREE.Group();
      this.extremeDetailGroup.visible = !!(manager && manager.extremeDetailEnabled);
      this.extremeGroups = [this.extremeDetailGroup];
      this.group.add(this.extremeDetailGroup);

      this._buildScanHalo();
      manager.scene.add(this.group);
    }

    setExtremeDetail(enabled) {
      const next = !!enabled;
      for (const g of this.extremeGroups) {
        if (g) g.visible = next;
      }
      if (next && this.manager && this.manager.render && this.manager.render.syncNewObjectForExtreme) {
        this.manager.render.syncNewObjectForExtreme(this.group);
        if (this.laserLine) this.manager.render.syncNewObjectForExtreme(this.laserLine);
      }
    }

    _addExtremeSharedMesh(geo, mat, parent = this.extremeDetailGroup, castShadow = true) {
      if (!geo) return null;
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = castShadow;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    }

    _buildScanHalo() {
      const haloMat = new THREE.LineBasicMaterial({
        color: 0x3bf2ff,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      this._ownedMats.push(haloMat);
      this.scanHalo = new THREE.LineSegments(this.assets.scanHaloGeo, haloMat);
      this.scanHalo.position.y = this.type === 'drone' || this.type === 'sniper' || this.type === 'recon' ? 0 : 0.9;
      this.scanHalo.renderOrder = 25;
      this.scanHalo.visible = false;
      this.group.add(this.scanHalo);

      // 头顶警戒/发报进度光环
      this.alertRingMat = new THREE.MeshBasicMaterial({
        color: 0xffc638,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
      });
      this._ownedMats.push(this.alertRingMat);
      this.alertRing = new THREE.Mesh(this.assets.alertRingGeo, this.alertRingMat);
      this.alertRing.rotation.x = -Math.PI * 0.5;
      this.alertRing.position.y = (this.type === 'drone' || this.type === 'sniper' || this.type === 'recon') ? 0.65 : 1.75;
      this.alertRing.visible = false;
      this.group.add(this.alertRing);
    }

    setScanHighlight(sec = 5.5) {
      this.highlightedTimer = Math.max(this.highlightedTimer, sec);
    }

    applyEmpStun(sec = 5.0) {
      if (this.dead) return;
      this.empTimer = Math.max(this.empTimer, sec);
      this.chargeTimer = 0;
      if (this.callInTimer > 0) {
        this.callInTimer = -1;
      }
      if (this.laserChargeTimer !== undefined) {
        this.laserChargeTimer = 0;
      }
      if (this.onEmpStunned) this.onEmpStunned(sec);
    }

    alert(instantGlobal = false) {
      if (this.dead || this.isTutorialTarget || this.isTrainingTarget) return;
      const wasAlerted = this.alerted;
      this.stealthState = 'COMBAT';
      this.suspicion = 1.0;
      this.alerted = true;
      if (!wasAlerted) {
        this.manager.audio.playEnemyAlert(this.type === 'hound' || this.type === 'shield', this.group.position);
        if (instantGlobal) {
          this.alarmCommitted = true;
        } else if (this.callInTimer < 0 && !this.alarmCommitted) {
          // 留给玩家短促“点杀打断发报”的潜行容错窗口
          this.callInTimer = (this.type === 'recon' ? 2.5 : 1.35) * this.callInScale;
        }
      }
    }

    _fireBolt(origin, target, type = this.type) {
      this.manager.firePlasmaBolt(origin, target, type, this.dmgScale, {
        boltSpeedScale: this.boltSpeedScale,
        jitterScale: this.jitterScale,
      });
    }

    investigate(targetPos) {
      if (this.dead || this.alerted || this.isTutorialTarget || this.isTrainingTarget) return;
      this.stealthState = 'SUSPICIOUS';
      this.suspicion = Math.max(this.suspicion, 0.45);
      if (!this.investigatePos) this.investigatePos = targetPos.clone();
      else this.investigatePos.copy(targetPos);
      this.pathTimer = 0;
    }

    _updateCommonTimers(dt) {
      if (this.highlightedTimer > 0) {
        this.highlightedTimer = Math.max(0, this.highlightedTimer - dt);
      }
      if (this.scanHalo) {
        this.scanHalo.visible = this.highlightedTimer > 0 && !this.dead;
      }
      if (this.empTimer > 0) {
        this.empTimer = Math.max(0, this.empTimer - dt);
        if (Math.random() < dt * 10) {
          this.manager.render.spawnSparks(this.group.position, _upVec, 3, 0.55);
        }
      }
      if (this.staggerTimer > 0) {
        this.staggerTimer = Math.max(0, this.staggerTimer - dt);
      }
      if (this.callInTimer > 0 && this.empTimer <= 0 && this.staggerTimer <= 0) {
        this.callInTimer -= dt;
        if (this.callInTimer <= 0) {
          this.callInTimer = -1;
          if (!this.alarmCommitted) {
            this.alarmCommitted = true;
            this.manager.onEnemyAlarmCommitted(this);
          }
        }
      }
      if (this.alertRing) {
        if (this.callInTimer > 0) {
          this.alertRing.visible = true;
          this.alertRingMat.color.setHex(0xff2b20);
          const s = 1.0 + Math.sin(this.manager.render.time * 22) * 0.25;
          this.alertRing.scale.set(s, s, 1);
        } else if (this.stealthState === 'SUSPICIOUS') {
          this.alertRing.visible = true;
          this.alertRingMat.color.setHex(0xffc638);
          this.alertRing.scale.setScalar(0.8 + this.suspicion * 0.45);
        } else {
          this.alertRing.visible = false;
        }
      }
    }

    _evaluatePerception(dt, playerPos, hasLOS, dist, fovHalfDeg = 60, detectRange = 32) {
      _toPlayer.set(playerPos.x - this.group.position.x, 0, playerPos.z - this.group.position.z);
      const len = _toPlayer.length();
      let angleDeg = 0;
      if (len > 0.01) {
        const yaw = this.group.rotation.y;
        const fwdX = Math.sin(yaw);
        const fwdZ = Math.cos(yaw);
        const dot = Math.max(-1, Math.min(1, (_toPlayer.x * fwdX + _toPlayer.z * fwdZ) / len));
        angleDeg = (Math.acos(dot) * 180) / Math.PI;
      }

      const stealthFactor = this.manager.currentPlayerStealthFactor || 1.0;
      const detectMult = this.manager.stealthDetectMult || 1.0;
      const stepRes = (window.GameLogic && window.GameLogic.evaluateStealthStep)
        ? window.GameLogic.evaluateStealthStep({
          state: this.stealthState,
          suspicion: this.suspicion,
          dt,
          hasLOS,
          dist,
          angleDeg,
          fovHalfDeg,
          detectRange,
          playerStealthFactor: stealthFactor,
          detectMult,
          timeSinceLastSeen: this.timeSinceLastSeen,
        })
        : { state: hasLOS && dist < detectRange ? 'COMBAT' : this.stealthState, suspicion: this.suspicion, perceived: hasLOS && dist < detectRange };

      this.suspicion = stepRes.suspicion;
      if (stepRes.perceived) {
        this.timeSinceLastSeen = 0;
        if (!this.investigatePos) this.investigatePos = playerPos.clone();
        else this.investigatePos.copy(playerPos);
      } else {
        this.timeSinceLastSeen += dt;
      }

      if (stepRes.state === 'COMBAT' && this.stealthState !== 'COMBAT') {
        this.alert(false);
      } else if (stepRes.state === 'SUSPICIOUS' && this.stealthState === 'PATROL') {
        this.stealthState = 'SUSPICIOUS';
      } else if (stepRes.state === 'PATROL' && this.stealthState === 'SUSPICIOUS') {
        this.stealthState = 'PATROL';
        this.investigatePos = null;
      }
    }

    _computeNavDirection(dt, targetPos) {
      const pos = this.group.position;
      const navGrid = this.manager.level.navGrid;
      this.pathTimer -= dt;
      if (navGrid && window.GameLogic && window.GameLogic.findGridPath && this.pathTimer <= 0) {
        this.pathTimer = 0.45 + Math.random() * 0.2;
        this.path = window.GameLogic.findGridPath(navGrid, pos, targetPos);
        this.pathIndex = 0;
      }
      if (this.path && this.path.length > 0 && this.pathIndex < this.path.length) {
        const wp = this.path[this.pathIndex];
        const dx = wp.x - pos.x;
        const dz = wp.z - pos.z;
        if (dx * dx + dz * dz < 1.1 && this.pathIndex < this.path.length - 1) {
          this.pathIndex++;
        }
        const cur = this.path[this.pathIndex];
        _navDirTmp.set(cur.x - pos.x, 0, cur.z - pos.z);
        if (_navDirTmp.lengthSq() > 0.04) return _navDirTmp.normalize();
      }
      _navDirTmp.set(targetPos.x - pos.x, 0, targetPos.z - pos.z);
      if (_navDirTmp.lengthSq() > 0.04) return _navDirTmp.normalize();
      return _navDirTmp.set(0, 0, 1);
    }

    _computeAerialNavSteer(dt, targetPos, opts = {}) {
      const pos = this.group.position;
      const level = this.manager && this.manager.level;
      const collision = level && level.collision;
      const wb = level && level.warehouseBox;
      let navGoal = {
        x: targetPos.x,
        y: targetPos.y !== undefined ? targetPos.y : pos.y,
        z: targetPos.z,
      };
      if (
        wb &&
        navGoal.x >= wb.minX - 0.5 && navGoal.x <= wb.maxX + 0.5 &&
        navGoal.z >= wb.minZ - 0.5 && navGoal.z <= wb.maxZ + 0.5
      ) {
        const southDoor = { x: -12.0, y: 3.8, z: -10.8 };
        const eastDoor = { x: 1.2, y: 3.8, z: -23.0 };
        const dSouth = Math.hypot(pos.x - southDoor.x, pos.z - southDoor.z) +
          0.5 * Math.hypot(navGoal.x - southDoor.x, navGoal.z - southDoor.z);
        const dEast = Math.hypot(pos.x - eastDoor.x, pos.z - eastDoor.z) +
          0.5 * Math.hypot(navGoal.x - eastDoor.x, navGoal.z - eastDoor.z);
        navGoal = dSouth <= dEast ? southDoor : eastDoor;
      }

      const aerialGrid = level && level.aerialNavGrid;
      this.pathTimer -= dt;
      if (aerialGrid && window.GameLogic && window.GameLogic.findGridPath && this.pathTimer <= 0) {
        this.pathTimer = 0.4 + Math.random() * 0.2;
        this.path = window.GameLogic.findGridPath(aerialGrid, pos, navGoal, { goalRadius: 10 });
        this.pathIndex = 0;
      }

      let navWaypoint = null;
      if (this.path && this.path.length > 0 && this.pathIndex < this.path.length) {
        const wp = this.path[this.pathIndex];
        const dx = wp.x - pos.x;
        const dz = wp.z - pos.z;
        if (dx * dx + dz * dz < 4.0 && this.pathIndex < this.path.length - 1) {
          this.pathIndex++;
        }
        navWaypoint = this.path[this.pathIndex];
      }

      const boxes = (collision && collision.aerialBoxes) || (collision && collision.boxes) || [];
      const flankSign = opts.flankSign !== undefined ? opts.flankSign : (this.strafeDir || 1);
      if (window.GameLogic && window.GameLogic.computeAerialSteerVector) {
        return window.GameLogic.computeAerialSteerVector(pos, navGoal, boxes, aerialGrid, {
          radiusXZ: opts.radiusXZ !== undefined ? opts.radiusXZ : 1.0,
          halfY: opts.halfY !== undefined ? opts.halfY : 0.45,
          lookahead: opts.lookahead !== undefined ? opts.lookahead : 4.2,
          maxClimbY: opts.maxClimbY !== undefined ? opts.maxClimbY : 6.8,
          flankSign,
          navWaypoint,
        });
      }

      const dx = navGoal.x - pos.x;
      const dz = navGoal.z - pos.z;
      const len = Math.hypot(dx, dz);
      return {
        dirX: len > 0.01 ? dx / len : 0,
        dirY: 0,
        dirZ: len > 0.01 ? dz / len : 1,
        climbTargetY: null,
        blockedAhead: false,
      };
    }

    takeDamage(dmg, hitPoint, isCrit, opts = {}) {
      if (this.dead) return false;
      if (this.requireMeleeKill && !opts.silentTakedown && !opts.isMelee) {
        this.hitFlash = 0.12;
        if (this.manager.onTutorialBulletBlocked) this.manager.onTutorialBulletBlocked(this, 'melee');
        return false;
      }
      if (this.requireEmpBeforeKill && this.empTimer <= 0 && !opts.fromExplosion && !opts.silentTakedown && !opts.isMelee) {
        this.hitFlash = 0.12;
        if (this.manager.onTutorialBulletBlocked) this.manager.onTutorialBulletBlocked(this, 'emp');
        return false;
      }
      this.hp -= dmg;
      this.lastHitWasCrit = !!isCrit;
      this.hitFlash = 0.1;
      const killed = this.hp <= 0;
      if (!killed && !opts.silent) {
        this.alert(false);
      }
      if (killed) {
        this.die(!!opts.silentTakedown);
        return true;
      }
      return false;
    }

    die(silentTakedown = false) {
      if (this.dead) return;
      this.dead = true;
      this.dying = true;
      this.disposed = false;
      this.dyingSilent = !!silentTakedown;
      this.hitboxes.length = 0;

      if (this.laserLine) this.laserLine.visible = false;
      if (this.scanHalo) this.scanHalo.visible = false;
      if (this.alertRing) this.alertRing.visible = false;
      if (this.beamMesh) this.beamMesh.visible = false;

      const isQuickTarget = !!(this.isTrainingTarget || this.isTutorialTarget);
      const isAir = this.type === 'drone' || this.type === 'recon' || this.type === 'sniper';
      this.dyingDuration = isQuickTarget ? 0.16 : isAir ? 0.55 : (silentTakedown ? 0.42 : 0.65);
      this.dyingTimer = this.dyingDuration;
      this._dyingFallVel = -1.8;
      this._dyingSpinX = (Math.random() > 0.5 ? 1 : -1) * 6.5;
      this._dyingSpinZ = (Math.random() > 0.5 ? 1 : -1) * 7.5;
      this._dyingRollDir = Math.random() > 0.5 ? 1 : -1;
      this._dyingBaseY = this.group.position.y;

      this.manager.onEnemyKilled(this, this.lastHitWasCrit, silentTakedown);
      if (!silentTakedown) {
        const dist = this.group.position.distanceTo(this.manager.render.camera.position);
        this.manager.audio.playExplosion(dist, this.group.position);
        this.manager.render.spawnSparks(this.group.position, _upVec, isQuickTarget ? 24 : 18, 1.35);
        this.manager.spawnDeathFlash(this.group.position);
      } else {
        this.manager.render.spawnSparks(this.group.position, _upVec, 10, 0.8);
      }
    }

    updateDying(dt) {
      if (!this.dying || this.disposed) return false;
      this.dyingTimer -= dt;
      const progress = Math.max(0, Math.min(1, 1 - this.dyingTimer / Math.max(0.01, this.dyingDuration)));
      const isQuickTarget = !!(this.isTrainingTarget || this.isTutorialTarget);
      const isAir = this.type === 'drone' || this.type === 'recon' || this.type === 'sniper';

      if (isQuickTarget) {
        const sc = Math.max(0.05, 1 - progress * 0.9);
        this.group.scale.setScalar(sc);
        this.group.rotation.y += dt * 16;
      } else if (isAir) {
        this._dyingFallVel -= 15.0 * dt;
        this.group.position.y += this._dyingFallVel * dt;
        this.group.rotation.x += this._dyingSpinX * dt;
        this.group.rotation.z += this._dyingSpinZ * dt;
        if (Math.random() < dt * 22 && this.manager.render.spawnSmoke) {
          this.manager.render.spawnSmoke(this.group.position, 1, 0.28, 1.1, 0x383c42);
        }
        const collision = this.manager.level && this.manager.level.collision;
        const floorY = (collision && collision.getAerialFloor
          ? collision.getAerialFloor(this.group.position.x, this.group.position.z, this.group.position.y, 0.8)
          : 0) + 0.35;
        if (this.group.position.y <= floorY) {
          this.group.position.y = floorY;
          this.dyingTimer = 0;
        }
      } else {
        const k = Math.min(1, progress * 1.45);
        this.group.rotation.x = -1.32 * k;
        this.group.rotation.z = 0.42 * this._dyingRollDir * k;
        this.group.position.y = this._dyingBaseY - 0.14 * k;
        if (!this.dyingSilent && Math.random() < dt * 14 && this.manager.render.spawnSmoke) {
          _smokeTmp.set(this.group.position.x, this.group.position.y + 0.65, this.group.position.z);
          this.manager.render.spawnSmoke(_smokeTmp, 1, 0.32, 1.0, 0x42464c);
        }
        if (this.dyingTimer < 0.15) {
          this.group.scale.setScalar(Math.max(0.1, this.dyingTimer / 0.15));
        }
      }

      if (this.dyingTimer <= 0) {
        if (!this.dyingSilent && !isQuickTarget && isAir) {
          this.manager.render.spawnSparks(this.group.position, _upVec, 20, 1.4);
          if (this.manager.render.spawnSmoke) {
            this.manager.render.spawnSmoke(this.group.position, 4, 0.45, 2.0, 0x383c42);
          }
        }
        this.disposeVisuals();
        this.dying = false;
        this.disposed = true;
        return true;
      }
      return false;
    }

    disposeVisuals() {
      if (this.disposed) return;
      this.disposed = true;
      if (this.beamMesh && this.manager && this.manager.render && this.manager.render.disposeBeam) {
        this.manager.render.disposeBeam(this.beamMesh);
        this.beamMesh = null;
      }
      if (this.laserLine && this.laserLine.parent) {
        this.laserLine.parent.remove(this.laserLine);
      }
      if (this.group && this.group.parent) {
        this.group.parent.remove(this.group);
      }
      for (let i = 0; i < this._ownedGeos.length; i++) {
        if (this._ownedGeos[i] && this._ownedGeos[i].dispose) this._ownedGeos[i].dispose();
      }
      this._ownedGeos.length = 0;
      for (let i = 0; i < this._ownedMats.length; i++) {
        if (this._ownedMats[i] && this._ownedMats[i].dispose) this._ownedMats[i].dispose();
      }
      this._ownedMats.length = 0;
    }
  }

  class PatrolDrone extends BaseEnemy {
    constructor(manager, pos, options = false) {
      const opts = typeof options === 'object' && options !== null
        ? options
        : { alertImmediately: !!options };
      super('drone', manager, pos, opts);
      this.isTutorialTarget = !!opts.isTutorialTarget;
      this.isTrainingTarget = !!opts.isTrainingTarget;
      this.motionType = opts.motionType || 'hover';
      this.motionAmp = opts.motionAmp ?? 1.2;
      this.motionFreq = opts.motionFreq ?? 1.3;
      this.slotIndex = opts.slotIndex ?? -1;
      this.alertImmediately = !!opts.alertImmediately;
      this.hp = this.isTutorialTarget
        ? 75
        : this.isTrainingTarget
          ? 54
          : Math.round(105 * (opts.hpScale || 1));
      this.maxHp = this.hp;
      this.baseY = pos.y;
      this.rotors = [];
      this.strafeDir = Math.random() > 0.5 ? 1 : -1;

      const armor = manager.tex.droneArmor;
      const frame = manager.tex.metalFrame;
      const a = this.assets;

      const body = new THREE.Mesh(a.droneBodyGeo, armor);
      body.castShadow = true;
      body.userData = { enemy: this, isWeakpoint: false };
      this.group.add(body);
      this.hitboxes.push(body);

      this.coreMat = new THREE.MeshBasicMaterial({
        color: (this.isTutorialTarget || this.isTrainingTarget) ? 0xff3838 : (this.alertImmediately ? 0xff3030 : 0x24d8ff),
      });
      this._ownedMats.push(this.coreMat);
      this.coreMesh = new THREE.Mesh(a.droneCoreGeo, this.coreMat);
      this.coreMesh.position.set(0, -0.02, 0.44);
      this.coreMesh.userData = { enemy: this, isWeakpoint: true };
      this.group.add(this.coreMesh);
      this.hitboxes.push(this.coreMesh);

      const armAngles = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
      for (const ang of armAngles) {
        const ax = Math.cos(ang) * 0.72;
        const az = Math.sin(ang) * 0.72;
        const arm = new THREE.Mesh(a.droneArmGeo, frame);
        arm.position.set(ax * 0.5, 0.05, az * 0.5);
        arm.rotation.y = -ang + Math.PI / 2;
        arm.userData = { enemy: this, isWeakpoint: false };
        this.group.add(arm);
        this.hitboxes.push(arm);

        const blade = new THREE.Mesh(a.droneBladeGeo, a.droneBladeMat);
        blade.position.set(ax, 0.14, az);
        this.group.add(blade);
        this.rotors.push(blade);
      }

      this.beamMesh = manager.render.createBeam(this.alertImmediately ? 0xff3333 : 0x33ddff, 0.16, 1.85, 6.2, 0.16);
      this.beamMesh.position.set(0, -0.15, 0.2);
      this.beamMesh.rotation.x = -0.35;
      this.group.add(this.beamMesh);

      this._buildDroneExtremeDetails(armor, frame);
    }

    _buildDroneExtremeDetails(armor, frame) {
      const a = this.assets;
      this._addExtremeSharedMesh(a.droneExtFrameGeo, frame, this.extremeDetailGroup, false);
      this._addExtremeSharedMesh(a.droneExtArmorGeo, armor, this.extremeDetailGroup, false);
    }

    update(dt, playerPos, time) {
      if (this.dead) return;
      this._updateCommonTimers(dt);

      const rotorRate = this.empTimer > 0 ? 5 : 26;
      for (let i = 0; i < this.rotors.length; i++) {
        this.rotors[i].rotation.y += dt * (rotorRate + i * 2);
      }

      if (this.isTutorialTarget || this.isTrainingTarget) {
        if (this.hitFlash > 0) {
          this.hitFlash -= dt;
          this.coreMat.color.setHex(0xffffff);
        } else {
          this.coreMat.color.setHex(0xff3838);
        }
        this.beamMesh.material.uniforms.uColor.value.setHex(this.isTrainingTarget ? 0x48d5ff : 0x33ddff);
        const pos = this.group.position;
        if (this.isTrainingTarget) {
          const amp = this.motionAmp;
          const freq = this.motionFreq;
          let dx = Math.sin(time * freq + this.patrolPhase) * (amp * 0.65);
          let dy = Math.sin(time * freq * 1.5 + this.patrolPhase) * 0.35;
          if (this.motionType === 'strafe') {
            dx = Math.sin(time * freq + this.patrolPhase) * amp;
            dy = Math.sin(time * freq * 1.7 + this.patrolPhase) * 0.22;
          } else if (this.motionType === 'arc') {
            dx = Math.cos(time * freq + this.patrolPhase) * amp;
            dy = Math.sin(time * freq * 2.0 + this.patrolPhase) * 0.58;
          }
          const tx = this.patrolOrigin.x + dx;
          const ty = this.baseY + dy;
          pos.x += (tx - pos.x) * Math.min(1, dt * 4.2);
          pos.y += (ty - pos.y) * Math.min(1, dt * 4.2);
          pos.z = this.patrolOrigin.z;
        } else {
          const tx = this.patrolOrigin.x + Math.sin(time * 0.95) * 1.15;
          const ty = this.baseY + Math.sin(time * 2.1) * 0.24;
          pos.x += (tx - pos.x) * Math.min(1, dt * 3.0);
          pos.y += (ty - pos.y) * Math.min(1, dt * 3.0);
          pos.z = this.patrolOrigin.z;
        }
        if (this.manager.level.collision.resolveAerial) {
          this.manager.level.collision.resolveAerial(pos, 0.98, 0.45);
        }
        if (this.tutorialFacingYaw !== null) {
          this.group.rotation.y = this.tutorialFacingYaw;
        } else {
          this.group.lookAt(playerPos.x, playerPos.y + 1.25, playerPos.z);
        }
        return;
      }

      const stateColor = this.empTimer > 0
        ? 0x38d9ff
        : this.chargeTimer > 0
          ? 0xffbb33
          : this.stealthState === 'COMBAT'
            ? 0xff2b2b
            : this.stealthState === 'SUSPICIOUS'
              ? 0xffb82e
              : 0x24d8ff;

      if (this.hitFlash > 0) {
        this.hitFlash -= dt;
        this.coreMat.color.setHex(0xffffff);
      } else {
        this.coreMat.color.setHex(stateColor);
      }
      this.beamMesh.material.uniforms.uColor.value.setHex(
        this.stealthState === 'COMBAT' ? 0xff2b2b : this.stealthState === 'SUSPICIOUS' ? 0xffb82e : 0x33ddff
      );

      const collision = this.manager.level.collision;
      if (this.empTimer > 0) {
        const floorY = collision.getAerialFloor
          ? collision.getAerialFloor(this.group.position.x, this.group.position.z, this.group.position.y, 0.98)
          : 0;
        const minEmpY = Math.max(1.2, floorY + 0.95);
        this.group.position.y = Math.max(minEmpY, this.group.position.y - dt * 1.2);
        if (collision.resolveAerial) collision.resolveAerial(this.group.position, 0.98, 0.45);
        this.group.rotation.z = Math.sin(time * 24) * 0.18;
        return;
      }
      this.group.rotation.z *= 0.85;
      this._wallFlipCd = Math.max(0, (this._wallFlipCd || 0) - dt);

      const pos = this.group.position;
      _toPlayer.subVectors(playerPos, pos);
      const dist = _toPlayer.length();
      _eyeOrigin.copy(pos);
      const aimY = this.manager.currentPlayerAimY || 1.35;
      _playerEye.set(playerPos.x, playerPos.y + aimY, playerPos.z);
      const hasLOS = dist < 44 && collision.hasLineOfSight(_eyeOrigin, _playerEye);

      this._evaluatePerception(dt, playerPos, hasLOS, dist, 62, 34);

      const floorY = collision.getAerialFloor ? collision.getAerialFloor(pos.x, pos.z, pos.y, 0.98) : 0;
      const minClearY = floorY + 1.15;

      if (this.stealthState === 'PATROL') {
        this.patrolPhase += dt * 0.55;
        const tx = this.patrolOrigin.x + Math.cos(this.patrolPhase) * 8.0;
        const tz = this.patrolOrigin.z + Math.sin(this.patrolPhase * 0.8) * 8.0;
        const ty = Math.max(minClearY, this.baseY + Math.sin(time * 2.2 + this.patrolPhase) * 0.45);
        _patrolTarget.x = tx;
        _patrolTarget.y = ty;
        _patrolTarget.z = tz;
        const steer = this._computeAerialNavSteer(dt, _patrolTarget, {
          radiusXZ: 0.98,
          halfY: 0.45,
          lookahead: 3.8,
          flankSign: this.strafeDir || 1,
        });
        const distToPatrol = Math.hypot(tx - pos.x, tz - pos.z);
        const speed = Math.min(4.8, Math.max(1.8, distToPatrol * 1.8));
        if (distToPatrol > 0.25) {
          pos.x += steer.dirX * speed * dt;
          pos.z += steer.dirZ * speed * dt;
        }
        const desiredY = steer.climbTargetY !== null ? Math.max(ty, steer.climbTargetY) : ty;
        pos.y += (Math.max(minClearY, desiredY) - pos.y) * Math.min(1, dt * 2.5);
        const hitWall = collision.resolveAerial ? collision.resolveAerial(pos, 0.98, 0.45) : false;
        if ((steer.blockedAhead || hitWall) && this._wallFlipCd <= 0) {
          this.strafeDir *= -1;
          this._wallFlipCd = 0.75;
        }
        this.group.lookAt(pos.x + steer.dirX * 3.0, pos.y - 0.3, pos.z + steer.dirZ * 3.0);
      } else if (this.stealthState === 'SUSPICIOUS' && this.investigatePos) {
        const steer = this._computeAerialNavSteer(dt, this.investigatePos, {
          radiusXZ: 0.98,
          halfY: 0.45,
          lookahead: 4.2,
          flankSign: this.strafeDir || 1,
        });
        const d = Math.hypot(this.investigatePos.x - pos.x, this.investigatePos.z - pos.z);
        if (d > 2.2) {
          pos.x += steer.dirX * 3.2 * dt;
          pos.z += steer.dirZ * 3.2 * dt;
        }
        let targetY = Math.max(3.8, this.baseY, minClearY);
        if (steer.climbTargetY !== null) targetY = Math.max(targetY, steer.climbTargetY);
        pos.y += (targetY - pos.y) * Math.min(1, dt * 2.0);
        const hitWall = collision.resolveAerial ? collision.resolveAerial(pos, 0.98, 0.45) : false;
        if ((steer.blockedAhead || hitWall) && this._wallFlipCd <= 0) {
          this.strafeDir *= -1;
          this._wallFlipCd = 0.75;
        }
        this.group.lookAt(this.investigatePos.x, 1.0, this.investigatePos.z);
      } else {
        this.group.lookAt(playerPos.x, playerPos.y + aimY * 0.75, playerPos.z);
        _flatDir.set(_toPlayer.x, 0, _toPlayer.z).normalize();
        _rightVec.set(-_flatDir.z, 0, _flatDir.x);

        _desired.set(0, 0, 0);
        if (hasLOS) {
          if (dist > 20) _desired.addScaledVector(_flatDir, 4.4 * this.speedScale);
          else if (dist < 10) _desired.addScaledVector(_flatDir, -3.5 * this.speedScale);
          _desired.addScaledVector(_rightVec, this.strafeDir * 3.8 * this.speedScale);
        } else {
          const navSteer = this._computeAerialNavSteer(dt, playerPos, {
            radiusXZ: 0.98,
            halfY: 0.45,
            lookahead: 4.2,
            flankSign: this.strafeDir || 1,
          });
          _desired.set(navSteer.dirX * 4.4 * this.speedScale, 0, navSteer.dirZ * 4.4 * this.speedScale);
        }

        _aheadTarget.x = pos.x + _desired.x * 0.9;
        _aheadTarget.y = pos.y;
        _aheadTarget.z = pos.z + _desired.z * 0.9;
        const localAvoid = this._computeAerialNavSteer(dt, _aheadTarget, {
          radiusXZ: 0.98,
          halfY: 0.45,
          lookahead: 3.6,
          flankSign: this.strafeDir || 1,
        });
        const moveMag = Math.hypot(_desired.x, _desired.z);
        if (moveMag > 0.05) {
          pos.x += localAvoid.dirX * moveMag * dt;
          pos.z += localAvoid.dirZ * moveMag * dt;
        }
        pos.x = Math.max(-38, Math.min(24, pos.x));
        pos.z = Math.max(-32, Math.min(30, pos.z));
        let targetY = Math.max(3.8, minClearY, playerPos.y + 3.2 + Math.sin(time * 2.4 + this.patrolPhase) * 0.55);
        if (localAvoid.climbTargetY !== null) {
          targetY = Math.max(targetY, localAvoid.climbTargetY);
        }
        pos.y += (targetY - pos.y) * Math.min(1, dt * 2.5);

        const hitWall = collision.resolveAerial ? collision.resolveAerial(pos, 0.98, 0.45) : false;
        if (((localAvoid.blockedAhead || hitWall) && this._wallFlipCd <= 0) || Math.random() < dt * 0.35) {
          this.strafeDir *= -1;
          this._wallFlipCd = 0.75;
        }

        if (hasLOS && this.staggerTimer <= 0) {
          if (this.chargeTimer > 0) {
            this.chargeTimer -= dt;
            if (this.chargeTimer <= 0) {
              _muzzleTmp.set(pos.x, pos.y - 0.1, pos.z);
              this._fireBolt(_muzzleTmp, _playerEye, 'drone');
              this.attackCooldown = (1.65 + Math.random() * 0.7) * this.cooldownScale;
            }
          } else {
            this.attackCooldown -= dt;
            if (this.attackCooldown <= 0) {
              this.chargeTimer = 0.35;
            }
          }
        }
      }
    }
  }

  class MechHound extends BaseEnemy {
    constructor(manager, pos, options = false) {
      const opts = typeof options === 'object' && options !== null
        ? options
        : { alertImmediately: !!options };
      super('hound', manager, pos, opts);
      this.hp = Math.round(120 * (opts.hpScale || 1));
      this.maxHp = this.hp;
      this.legs = [];
      this.stridePhase = Math.random() * Math.PI * 2;
      this.stepAccum = 0;
      this.stuckTimer = 0;
      this.flankSign = Math.random() > 0.5 ? 1 : -1;

      const armor = manager.tex.houndArmor;
      const frame = manager.tex.metalFrame;
      const a = this.assets;

      const torso = new THREE.Mesh(a.houndTorsoGeo, armor);
      torso.position.y = 0.64;
      torso.castShadow = true;
      torso.userData = { enemy: this, isWeakpoint: false };
      this.group.add(torso);
      this.hitboxes.push(torso);

      const head = new THREE.Mesh(a.houndHeadGeo, armor);
      head.position.set(0, 0.78, 0.72);
      head.userData = { enemy: this, isWeakpoint: true };
      this.group.add(head);
      this.hitboxes.push(head);

      this.visorMat = new THREE.MeshBasicMaterial({ color: this.alerted ? 0xff2b2b : 0xffaa22 });
      this._ownedMats.push(this.visorMat);
      const visor = new THREE.Mesh(a.houndVisorGeo, this.visorMat);
      visor.position.set(0, 0.8, 0.89);
      visor.userData = { enemy: this, isWeakpoint: true };
      this.group.add(visor);
      this.hitboxes.push(visor);

      const legOffsets = [
        [-0.32, 0.58, 0.44],
        [0.32, 0.58, 0.44],
        [-0.32, 0.58, -0.44],
        [0.32, 0.58, -0.44],
      ];
      for (const [lx, ly, lz] of legOffsets) {
        const pivot = new THREE.Group();
        pivot.position.set(lx, ly, lz);
        const upper = new THREE.Mesh(a.houndLegUpperGeo, frame);
        upper.position.y = -0.18;
        upper.castShadow = true;
        upper.userData = { enemy: this, isWeakpoint: false };
        pivot.add(upper);
        this.hitboxes.push(upper);

        const lower = new THREE.Mesh(a.houndLegLowerGeo, armor);
        lower.position.set(0, -0.44, -0.05);
        lower.userData = { enemy: this, isWeakpoint: false };
        pivot.add(lower);
        this.hitboxes.push(lower);

        this.group.add(pivot);
        this.legs.push(pivot);

        if (a.houndLegExtGeo) {
          const legExt = new THREE.Group();
          legExt.visible = this.extremeDetailGroup.visible;
          this._addExtremeSharedMesh(a.houndLegExtGeo, frame, legExt, false);
          pivot.add(legExt);
          this.extremeGroups.push(legExt);
        }
      }

      if (a.houndSpineExtGeo) {
        this._addExtremeSharedMesh(a.houndSpineExtGeo, frame);
      }
    }

    update(dt, playerPos, time) {
      if (this.dead) return;
      this._updateCommonTimers(dt);

      const stateCol = this.empTimer > 0
        ? 0x38d9ff
        : this.stealthState === 'COMBAT'
          ? 0xff2626
          : this.stealthState === 'SUSPICIOUS'
            ? 0xffc638
            : 0x38d4ff;
      if (this.hitFlash > 0) {
        this.hitFlash -= dt;
        this.visorMat.color.setHex(0xffffff);
      } else {
        this.visorMat.color.setHex(stateCol);
      }
      if (this.empTimer > 0 || this.staggerTimer > 0) {
        if (this.empTimer > 0) {
          this.group.rotation.z = Math.sin(time * 38) * 0.085;
          this.group.rotation.x = 0.14 + Math.cos(time * 26) * 0.04;
        } else {
          this.group.rotation.x = -0.18 * (this.staggerTimer / 0.95);
          this.group.rotation.z = 0;
        }
        return;
      }
      this.group.rotation.z *= 0.8;
      this.group.rotation.x *= 0.8;

      const pos = this.group.position;
      _toPlayer.set(playerPos.x - pos.x, 0, playerPos.z - pos.z);
      const dist = _toPlayer.length();
      _eyeOrigin.set(pos.x, pos.y + 0.85, pos.z);
      const aimY = this.manager.currentPlayerAimY || 1.35;
      _playerEye.set(playerPos.x, playerPos.y + aimY, playerPos.z);
      const hasLOS = dist < 40 && this.manager.level.collision.hasLineOfSight(_eyeOrigin, _playerEye);

      this._evaluatePerception(dt, playerPos, hasLOS, dist, 58, 30);

      let moveSpeed = 0;
      _desired.set(0, 0, 0);

      if (this.stealthState === 'PATROL') {
        this.patrolPhase += dt * 0.42;
        _patrolGoal.set(
          this.patrolOrigin.x + Math.cos(this.patrolPhase) * 6.5,
          pos.y,
          this.patrolOrigin.z + Math.sin(this.patrolPhase) * 6.5
        );
        _desired.copy(this._computeNavDirection(dt, _patrolGoal));
        moveSpeed = 2.6;
      } else if (this.stealthState === 'SUSPICIOUS' && this.investigatePos) {
        const dInv = Math.hypot(this.investigatePos.x - pos.x, this.investigatePos.z - pos.z);
        if (dInv > 1.8) {
          _desired.copy(this._computeNavDirection(dt, this.investigatePos));
          moveSpeed = 3.6;
        }
      } else {
        if (dist > 6.5) {
          _desired.copy(this._computeNavDirection(dt, playerPos));
          _sideTmp.set(-_desired.z, 0, _desired.x);
          if (this.stuckTimer > 0) {
            _desired.addScaledVector(_sideTmp, this.flankSign * 1.1).normalize();
            this.stuckTimer -= dt;
          } else if (dist < 14) {
            _desired.addScaledVector(_sideTmp, this.flankSign * 0.25).normalize();
          }
          moveSpeed = 6.1 * this.speedScale;
        } else {
          _sideTmp.set(-_toPlayer.z, 0, _toPlayer.x).normalize();
          _desired.copy(_sideTmp).multiplyScalar(this.flankSign);
          moveSpeed = 3.2 * this.speedScale;
        }

        if (hasLOS) {
          this.attackCooldown -= dt;
          if (this.attackCooldown <= 0) {
            this._fireBolt(_eyeOrigin, _playerEye, 'hound');
            this.attackCooldown = (dist < 12 ? 0.95 : 1.45) * this.cooldownScale;
          }
        }
      }

      if (moveSpeed > 0.1) {
        const oldX = pos.x;
        const oldZ = pos.z;
        pos.x += _desired.x * moveSpeed * dt;
        pos.z += _desired.z * moveSpeed * dt;
        this.manager.level.collision.resolveCircleXZ(pos, 0.55, pos.y);
        pos.y = this.manager.level.collision.getGroundHeight(pos.x, pos.z, pos.y);

        const moved = Math.hypot(pos.x - oldX, pos.z - oldZ);
        if (moved < moveSpeed * dt * 0.25) {
          if (this.alerted) {
            this.stuckTimer = 0.7;
            this.flankSign *= -1;
          } else if (this.stealthState === 'PATROL') {
            this.patrolPhase += 0.9;
          }
        }

        const faceDir = this.alerted && hasLOS ? _toPlayer : _desired;
        if (faceDir.lengthSq() > 0.01) {
          this.group.rotation.y = Math.atan2(faceDir.x, faceDir.z);
        }

        this.stridePhase += dt * moveSpeed * 2.9;
        this.stepAccum += dt * moveSpeed;
        if (this.stepAccum > 2.2) {
          this.stepAccum = 0;
          this.manager.audio.playEnemyStep(dist, pos);
        }
        const s = Math.sin(this.stridePhase) * 0.55;
        this.legs[0].rotation.x = s;
        this.legs[3].rotation.x = s;
        this.legs[1].rotation.x = -s;
        this.legs[2].rotation.x = -s;
      }
    }
  }

  // 新增特化兵种 1：防爆盾重装机兵（正面盾弹反 + 背部散热核心弱点 + EMP 破盾）
  class ShieldHeavyMech extends BaseEnemy {
    constructor(manager, pos, options = {}) {
      const opts = typeof options === 'object' && options !== null ? options : { alertImmediately: !!options };
      super('shield', manager, pos, opts);
      this.hp = Math.round(215 * (opts.hpScale || 1));
      this.maxHp = this.hp;
      this.stridePhase = Math.random() * Math.PI * 2;
      this.stepAccum = 0;
      this.burstRemaining = 0;
      this.burstInterval = 0;

      const armor = manager.tex.houndArmor;
      const frame = manager.tex.metalFrame;
      const a = this.assets;

      // 厚重人形装甲躯干
      const body = new THREE.Mesh(a.shieldBodyGeo, armor);
      body.position.y = 1.28;
      body.castShadow = true;
      body.userData = { enemy: this, isWeakpoint: false };
      this.group.add(body);
      this.hitboxes.push(body);

      const head = new THREE.Mesh(a.shieldHeadGeo, frame);
      head.position.set(0, 2.04, 0.08);
      head.userData = { enemy: this, isWeakpoint: true };
      this.group.add(head);
      this.hitboxes.push(head);

      this.visorMat = new THREE.MeshBasicMaterial({ color: this.alerted ? 0xff3b30 : 0x38d9ff });
      this._ownedMats.push(this.visorMat);
      const visor = new THREE.Mesh(a.shieldVisorGeo, this.visorMat);
      visor.position.set(0, 2.04, 0.28);
      visor.userData = { enemy: this, isWeakpoint: true };
      this.group.add(visor);
      this.hitboxes.push(visor);

      // 背部高亮散热核心（绕后暴击弱点）
      this.backCoreMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a });
      this._ownedMats.push(this.backCoreMat);
      const backCore = new THREE.Mesh(a.shieldBackCoreGeo, this.backCoreMat);
      backCore.position.set(0, 1.38, -0.44);
      backCore.userData = { enemy: this, isWeakpoint: true };
      this.group.add(backCore);
      this.hitboxes.push(backCore);

      // 正面重型防爆能量盾（常规步枪正面击中弹反，需 EMP / AP / 油桶 / 绕后突破）
      this.shieldGroup = new THREE.Group();
      this.shieldGroup.position.set(-0.1, 1.15, 0.62);
      const shieldSlab = new THREE.Mesh(a.shieldSlabGeo, a.shieldAlloyMat);
      shieldSlab.castShadow = true;
      shieldSlab.userData = { enemy: this, isWeakpoint: false, isShield: true };
      this.shieldGroup.add(shieldSlab);
      this.hitboxes.push(shieldSlab);

      this.shieldTrimMat = new THREE.MeshBasicMaterial({ color: 0x4caeff, transparent: true, opacity: 0.72 });
      this._ownedMats.push(this.shieldTrimMat);
      const viewport = new THREE.Mesh(a.shieldViewportGeo, this.shieldTrimMat);
      viewport.position.y = 0.5;
      this.shieldGroup.add(viewport);
      this.group.add(this.shieldGroup);

      // 双腿（可受击非弱点肢体）
      this.legs = [];
      for (const lx of [-0.28, 0.28]) {
        const leg = new THREE.Mesh(a.shieldLegGeo, frame);
        leg.position.set(lx, 0.36, 0);
        leg.userData = { enemy: this, isWeakpoint: false, isLimb: true };
        this.group.add(leg);
        this.hitboxes.push(leg);
        this.legs.push(leg);
      }

      if (a.shieldExtArmorGeo || a.shieldExtFrameGeo || a.shieldExtSlabGeo) {
        this._addExtremeSharedMesh(a.shieldExtArmorGeo, armor);
        this._addExtremeSharedMesh(a.shieldExtFrameGeo, frame);

        const shExt = new THREE.Group();
        shExt.visible = this.extremeDetailGroup.visible;
        this._addExtremeSharedMesh(a.shieldExtSlabGeo, frame, shExt, false);
        this.shieldGroup.add(shExt);
        this.extremeGroups.push(shExt);
      }
    }

    onEmpStunned() {
      if (this.shieldGroup) {
        this.shieldGroup.rotation.y = 0.75;
        this.shieldGroup.position.x = -0.45;
      }
    }

    update(dt, playerPos, time) {
      if (this.dead) return;
      this._updateCommonTimers(dt);

      const stunned = this.empTimer > 0;
      this.shieldTrimMat.color.setHex(stunned ? 0x1a3344 : (this.stealthState === 'COMBAT' ? 0xff4c30 : 0x4caeff));
      if (!stunned && this.shieldGroup) {
        this.shieldGroup.rotation.y += (0 - this.shieldGroup.rotation.y) * Math.min(1, dt * 5);
        this.shieldGroup.position.x += (-0.1 - this.shieldGroup.position.x) * Math.min(1, dt * 5);
      }

      if (this.hitFlash > 0) {
        this.hitFlash -= dt;
        this.visorMat.color.setHex(0xffffff);
      } else {
        this.visorMat.color.setHex(stunned ? 0x38d9ff : this.stealthState === 'COMBAT' ? 0xff3b30 : 0xffb82e);
      }
      if (stunned || this.staggerTimer > 0) {
        if (stunned) {
          this.group.rotation.z = Math.sin(time * 34) * 0.065;
          this.group.rotation.x = 0.11 + Math.cos(time * 24) * 0.03;
        } else {
          this.group.rotation.x = -0.15 * (this.staggerTimer / 0.95);
          this.group.rotation.z = 0;
        }
        return;
      }
      this.group.rotation.z *= 0.8;
      this.group.rotation.x *= 0.8;

      if (this.isTutorialTarget) {
        if (this.tutorialFacingYaw !== null) {
          this.group.rotation.y = this.tutorialFacingYaw;
        }
        return;
      }

      const pos = this.group.position;
      _toPlayer.set(playerPos.x - pos.x, 0, playerPos.z - pos.z);
      const dist = _toPlayer.length();
      _eyeOrigin.set(pos.x, pos.y + 1.85, pos.z);
      const aimY = this.manager.currentPlayerAimY || 1.35;
      _playerEye.set(playerPos.x, playerPos.y + aimY, playerPos.z);
      const hasLOS = dist < 42 && this.manager.level.collision.hasLineOfSight(_eyeOrigin, _playerEye);

      this._evaluatePerception(dt, playerPos, hasLOS, dist, 52, 28);

      let moveSpeed = 0;
      _desired.set(0, 0, 0);
      if (this.stealthState === 'PATROL') {
        this.patrolPhase += dt * 0.42;
        _patrolGoal.set(
          this.patrolOrigin.x + Math.cos(this.patrolPhase) * 4.5,
          pos.y,
          this.patrolOrigin.z + Math.sin(this.patrolPhase) * 4.5
        );
        _desired.copy(this._computeNavDirection(dt, _patrolGoal));
        moveSpeed = 1.8;
      } else if (this.stealthState === 'SUSPICIOUS' && this.investigatePos) {
        if (Math.hypot(this.investigatePos.x - pos.x, this.investigatePos.z - pos.z) > 2.2) {
          _desired.copy(this._computeNavDirection(dt, this.investigatePos));
          moveSpeed = 2.4;
        }
      } else {
        if (dist > 5.0) {
          _desired.copy(this._computeNavDirection(dt, playerPos));
          moveSpeed = 3.15 * this.speedScale;
        } else if (dist > 0.05) {
          _desired.copy(_toPlayer).divideScalar(dist);
        }
        // 双发重型脉冲连射
        if (hasLOS) {
          if (this.burstRemaining > 0) {
            this.burstInterval -= dt;
            if (this.burstInterval <= 0) {
              this.burstRemaining--;
              this.burstInterval = 0.22;
              this._fireBolt(_eyeOrigin, _playerEye, 'shield');
            }
          } else {
            this.attackCooldown -= dt;
            if (this.attackCooldown <= 0) {
              this.burstRemaining = 2;
              this.burstInterval = 0.01;
              this.attackCooldown = 1.95 * this.cooldownScale;
            }
          }
        }
      }

      if (moveSpeed > 0.1) {
        const oldX = pos.x;
        const oldZ = pos.z;
        pos.x += _desired.x * moveSpeed * dt;
        pos.z += _desired.z * moveSpeed * dt;
        this.manager.level.collision.resolveCircleXZ(pos, 0.72, pos.y);
        pos.y = this.manager.level.collision.getGroundHeight(pos.x, pos.z, pos.y);

        if (this.stealthState === 'PATROL' && Math.hypot(pos.x - oldX, pos.z - oldZ) < moveSpeed * dt * 0.25) {
          this.patrolPhase += 0.9;
        }

        this.stridePhase += dt * moveSpeed * 2.3;
        const s = Math.sin(this.stridePhase) * 0.35;
        this.legs[0].rotation.x = s;
        this.legs[1].rotation.x = -s;
        this.stepAccum += dt * moveSpeed;
        if (this.stepAccum > 1.8) {
          this.stepAccum = 0;
          this.manager.audio.playEnemyStep(dist, pos);
        }
      }
      // 缓慢旋转朝向玩家（保留玩家绕背偷袭核心的窗口！）
      const faceDir = this.stealthState === 'COMBAT' && dist > 0.2 ? _toPlayer : _desired;
      if (faceDir.lengthSq() > 0.01) {
        const targetYaw = Math.atan2(faceDir.x, faceDir.z);
        let diff = targetYaw - this.group.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.group.rotation.y += Math.sign(diff) * Math.min(Math.abs(diff), dt * 2.45);
      }
    }
  }

  // 新增特化兵种 2：高台激光狙击无人机（1.4 秒可见红线追踪预警 -> 高速穿甲强光束）
  class LaserSniperDrone extends BaseEnemy {
    constructor(manager, pos, options = {}) {
      const opts = typeof options === 'object' && options !== null ? options : { alertImmediately: !!options };
      super('sniper', manager, pos, opts);
      this.hp = Math.round(92 * (opts.hpScale || 1));
      this.maxHp = this.hp;
      this.baseY = pos.y;
      this.laserChargeTimer = 0;
      this.laserLockedPos = new THREE.Vector3();

      const armor = manager.tex.droneArmor;
      const frame = manager.tex.metalFrame;
      const a = this.assets;

      const body = new THREE.Mesh(a.sniperBodyGeo, armor);
      body.castShadow = true;
      body.userData = { enemy: this, isWeakpoint: false };
      this.group.add(body);
      this.hitboxes.push(body);

      const wing = new THREE.Mesh(a.sniperWingGeo, frame);
      wing.userData = { enemy: this, isWeakpoint: false, isLimb: true };
      this.group.add(wing);
      this.hitboxes.push(wing);

      const barrel = new THREE.Mesh(a.sniperBarrelGeo, frame);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, -0.05, 0.92);
      this.group.add(barrel);

      this.coreMat = new THREE.MeshBasicMaterial({ color: 0xff2244 });
      this._ownedMats.push(this.coreMat);
      const optic = new THREE.Mesh(a.sniperOpticGeo, this.coreMat);
      optic.position.set(0, 0.04, 0.64);
      optic.userData = { enemy: this, isWeakpoint: true };
      this.group.add(optic);
      this.hitboxes.push(optic);

      // 场景全局可见瞄准红线
      const lGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
      this._ownedGeos.push(lGeo);
      this.laserMat = new THREE.LineBasicMaterial({ color: 0xff2438, transparent: true, opacity: 0.85 });
      this._ownedMats.push(this.laserMat);
      this.laserLine = new THREE.Line(lGeo, this.laserMat);
      this.laserLine.frustumCulled = false;
      this.laserLine.visible = false;
      manager.scene.add(this.laserLine);

      if (a.sniperFinExtGeo) {
        this._addExtremeSharedMesh(a.sniperFinExtGeo, frame);
      }
    }

    update(dt, playerPos, time) {
      if (this.dead) return;
      this._updateCommonTimers(dt);

      if (this.hitFlash > 0) {
        this.hitFlash -= dt;
        this.coreMat.color.setHex(0xffffff);
      } else {
        this.coreMat.color.setHex(this.empTimer > 0 ? 0x38d9ff : this.laserChargeTimer > 0 ? 0xff4455 : 0xffaa22);
      }

      const collision = this.manager.level.collision;
      if (this.empTimer > 0 || this.staggerTimer > 0) {
        this.laserChargeTimer = 0;
        if (this.laserLine) this.laserLine.visible = false;
        if (this.empTimer > 0) {
          const floorY = collision.getAerialFloor
            ? collision.getAerialFloor(this.group.position.x, this.group.position.z, this.group.position.y, 1.05)
            : 0;
          this.group.position.y = Math.max(Math.max(1.4, floorY + 0.9), this.group.position.y - dt * 1.1);
          this.group.rotation.z = Math.sin(time * 32) * 0.14;
        } else {
          this.group.rotation.x = -0.18 * (this.staggerTimer / 0.95);
        }
        if (collision.resolveAerial) collision.resolveAerial(this.group.position, 1.05, 0.4);
        return;
      }
      this.group.rotation.z *= 0.85;

      const pos = this.group.position;
      const floorY = collision.getAerialFloor ? collision.getAerialFloor(pos.x, pos.z, pos.y, 1.05) : 0;
      const safeBaseY = Math.max(this.baseY, floorY + 0.9);
      this.baseY = safeBaseY;
      pos.y = safeBaseY + Math.sin(time * 1.9 + this.patrolPhase) * 0.25;
      if (collision.resolveAerial) collision.resolveAerial(pos, 1.05, 0.4);

      _eyeOrigin.copy(pos);
      const aimY = this.manager.currentPlayerAimY || 1.35;
      _playerEye.set(playerPos.x, playerPos.y + aimY, playerPos.z);
      const dist = pos.distanceTo(playerPos);
      const hasLOS = dist < 58 && collision.hasLineOfSight(_eyeOrigin, _playerEye);

      this._evaluatePerception(dt, playerPos, hasLOS, dist, 68, 46);

      if (this.stealthState === 'PATROL') {
        this.group.rotation.y += dt * 0.45;
        this.laserLine.visible = false;
        return;
      }

      this.group.lookAt(_playerEye);
      if (this.laserChargeTimer > 0) {
        if (!hasLOS && this.laserChargeTimer > 0.45) {
          this.laserChargeTimer = 0;
          this.laserLine.visible = false;
          this.attackCooldown = 1.4 * this.cooldownScale;
          return;
        }
        // 最后 0.45 秒锁定终点不再跟枪，给与玩家侧滑躲避反应窗！
        if (this.laserChargeTimer > 0.45) {
          this.laserLockedPos.copy(_playerEye);
        }
        this.laserChargeTimer -= dt;
        _dirTmp.subVectors(this.laserLockedPos, pos);
        if (_dirTmp.lengthSq() > 0.0001) _dirTmp.normalize();
        else _dirTmp.set(0, 0, 1);
        _muzzleTmp.copy(pos).addScaledVector(_dirTmp, 1.3);
        const posAttr = this.laserLine.geometry.getAttribute('position');
        posAttr.setXYZ(0, _muzzleTmp.x, _muzzleTmp.y, _muzzleTmp.z);
        posAttr.setXYZ(1, this.laserLockedPos.x, this.laserLockedPos.y, this.laserLockedPos.z);
        posAttr.needsUpdate = true;
        this.laserLine.visible = true;
        this.laserMat.opacity = this.laserChargeTimer < 0.45 ? 1.0 : 0.6;

        if (this.laserChargeTimer <= 0) {
          this.laserLine.visible = false;
          this._fireBolt(_muzzleTmp, this.laserLockedPos, 'sniper');
          if (this.manager.audio.playLaserSniperShot) this.manager.audio.playLaserSniperShot(pos);
          this.attackCooldown = 2.8 * this.cooldownScale;
        }
      } else {
        this.laserLine.visible = false;
        if (hasLOS) {
          this.attackCooldown -= dt;
          if (this.attackCooldown <= 0) {
            this.laserChargeTimer = 1.4;
            this.laserLockedPos.copy(_playerEye);
            if (this.manager.audio.playLaserSniperCharge) this.manager.audio.playLaserSniperCharge(pos);
          }
        }
      }
    }
  }

  // 新增特化兵种 3：警戒发报无人机（高速侦察 + 接敌 2.5 秒发报呼叫增援，需点杀/EMP 打断）
  class ReconAlarmDrone extends PatrolDrone {
    constructor(manager, pos, options = {}) {
      super(manager, pos, options);
      this.type = 'recon';
      this.hp = Math.round(78 * (options.hpScale || 1));
      this.maxHp = this.hp;
      this.reinforcementsCalled = false;
      const dome = new THREE.Mesh(this.assets.reconDomeGeo, this.assets.reconDomeMat);
      dome.position.y = 0.28;
      this.group.add(dome);
    }

    alert(instantGlobal = false) {
      const first = !this.alerted;
      super.alert(instantGlobal);
      if (first && !instantGlobal) {
        this.callInTimer = 2.5 * this.callInScale;
      }
    }
  }

  class Manager {
    constructor(scene, texFactory, audio, renderEngine, level) {
      this.scene = scene;
      this.tex = texFactory;
      this.audio = audio;
      this.render = renderEngine;
      this.level = level;
      this.enemies = [];
      this.killedCount = 0;
      this.currentPlayerStealthFactor = 1.0;
      this.currentPlayerAimY = 1.35;
      this.stealthDetectMult = 1.0;
      this.onKillCallback = null;
      this.onAlarmTriggered = null;
      this.onReconReinforce = null;
      this.onTutorialBulletBlocked = null;
      this.extremeDetailEnabled = false;

      this._initProjectilesAndFlashes();
    }

    setExtremeDetail(enabled) {
      this.extremeDetailEnabled = !!enabled;
      for (let i = 0; i < this.enemies.length; i++) {
        if (this.enemies[i] && this.enemies[i].setExtremeDetail) {
          this.enemies[i].setExtremeDetail(this.extremeDetailEnabled);
        }
      }
    }

    _registerEnemy(enemy) {
      this.enemies.push(enemy);
      if (this.extremeDetailEnabled && enemy.setExtremeDetail) {
        enemy.setExtremeDetail(true);
      }
      return enemy;
    }

    _initProjectilesAndFlashes() {
      this.maxBolts = 36;
      const bGeo = new THREE.SphereGeometry(0.11, 8, 6);
      bGeo.scale(0.8, 0.8, 3.2);
      const bMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
      this.boltMesh = new THREE.InstancedMesh(bGeo, bMat, this.maxBolts);
      this.boltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.boltMesh.frustumCulled = false;
      this.scene.add(this.boltMesh);

      this._zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      this._dummy = new THREE.Object3D();
      this.bolts = Array.from({ length: this.maxBolts }, () => ({
        active: false,
        pos: new THREE.Vector3(),
        origin: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        damage: 11,
      }));
      for (let i = 0; i < this.maxBolts; i++) this.boltMesh.setMatrixAt(i, this._zeroMat);

      this.deathLight = this.render.createVirtualLight({
        color: 0xff7722,
        intensity: 0,
        distance: 24,
        decay: 1.5,
        priority: 9.0,
      });
      this.deathFlashTimer = 0;
    }

    clearAll() {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e && e.disposeVisuals) e.disposeVisuals();
      }
      this.enemies.length = 0;
      this.killedCount = 0;
      for (let i = 0; i < this.maxBolts; i++) {
        this.bolts[i].active = false;
        this.boltMesh.setMatrixAt(i, this._zeroMat);
      }
      this.boltMesh.instanceMatrix.needsUpdate = true;
      this.deathFlashTimer = 0;
      this.deathLight.intensity = 0;
    }

    spawnTutorialDrone(pos) {
      const drone = new PatrolDrone(this, pos, { alertImmediately: false, isTutorialTarget: true });
      return this._registerEnemy(drone);
    }

    spawnTutorialStealthTarget(pos) {
      const target = new PatrolDrone(this, pos, {
        alertImmediately: false,
        isTutorialTarget: true,
        requireMeleeKill: true,
        allowTutorialMelee: true,
        tutorialNoAttack: true,
        tutorialFacingYaw: Math.PI,
      });
      return this._registerEnemy(target);
    }

    spawnTutorialShieldTarget(pos) {
      const shield = new ShieldHeavyMech(this, pos, {
        alertImmediately: false,
        isTutorialTarget: true,
        requireEmpBeforeKill: true,
        allowTutorialMelee: true,
        tutorialNoAttack: true,
        tutorialFacingYaw: 0,
      });
      shield.hp = 90;
      shield.maxHp = 90;
      return this._registerEnemy(shield);
    }

    spawnTrainingTarget(pos, opts = {}) {
      const drone = new PatrolDrone(this, pos, { ...opts, alertImmediately: false, isTrainingTarget: true });
      return this._registerEnemy(drone);
    }

    spawnCombatEnemy(type, pos, opts = {}) {
      let spawnPos = pos;
      const isAerial = type === 'drone' || type === 'sniper' || type === 'recon';
      if (isAerial && !opts.skipAerialSafe && this.level && this.level.collision && this.level.collision.findSafeAerialSpawn) {
        const radiusXZ = type === 'sniper' ? 1.05 : 1.0;
        const safe = this.level.collision.findSafeAerialSpawn(pos, { radiusXZ, halfY: 0.48, minY: 2.4 });
        spawnPos = new THREE.Vector3(safe.x, safe.y, safe.z);
      }
      let enemy;
      if (type === 'shield') enemy = new ShieldHeavyMech(this, spawnPos, opts);
      else if (type === 'sniper') enemy = new LaserSniperDrone(this, spawnPos, opts);
      else if (type === 'recon') enemy = new ReconAlarmDrone(this, spawnPos, opts);
      else if (type === 'hound') enemy = new MechHound(this, spawnPos, opts);
      else enemy = new PatrolDrone(this, spawnPos, opts);
      return this._registerEnemy(enemy);
    }

    setDifficultyStealthMult(mult = 1.0) {
      this.stealthDetectMult = Math.max(0.4, Number(mult) || 1.0);
    }

    _buildCombatOpts(opts = {}, alertImmediately = false) {
      return {
        alertImmediately,
        hpScale: opts.hpScale || 1,
        dmgScale: opts.dmgScale || 1,
        speedScale: opts.speedScale || 1,
        cooldownScale: opts.cooldownScale || 1,
        boltSpeedScale: opts.boltSpeedScale || 1,
        jitterScale: opts.jitterScale || 1,
        callInScale: opts.callInScale || 1,
      };
    }

    spawnInitialPatrols(opts = {}) {
      const elite = !!opts.elitePatrol;
      const baseOpts = this._buildCombatOpts(opts, false);

      // A区、B区、中区、高台巡逻体系（保持南侧防波堤出生点安全潜行窗口）
      this.spawnCombatEnemy('drone', new THREE.Vector3(-17.5, 6.0, 3.5), baseOpts);
      this.spawnCombatEnemy('recon', new THREE.Vector3(5.5, 6.4, -6.5), baseOpts);
      this.spawnCombatEnemy('hound', new THREE.Vector3(-11, 0, -20), baseOpts);
      this.spawnCombatEnemy('hound', new THREE.Vector3(6, 0, -3), baseOpts);
      if (elite) {
        this.spawnCombatEnemy('shield', new THREE.Vector3(-14, 0, -8), baseOpts);
        this.spawnCombatEnemy('sniper', new THREE.Vector3(17, 10.5, -13.5), baseOpts);
      } else {
        this.spawnCombatEnemy('sniper', new THREE.Vector3(17.5, 11.2, -15.5), baseOpts);
      }
    }

    spawnRelayInterceptor(relayPos, opts = {}) {
      const alertOpts = this._buildCombatOpts(opts, true);
      const wb = this.level && this.level.warehouseBox;
      let dPos;
      if (
        wb &&
        relayPos.x >= wb.minX - 1.0 && relayPos.x <= wb.maxX + 1.0 &&
        relayPos.z >= wb.minZ - 1.0 && relayPos.z <= wb.maxZ + 1.0
      ) {
        dPos = Math.random() < 0.5
          ? new THREE.Vector3(-12.0 + (Math.random() - 0.5) * 8, 7.5, -8.5 + (Math.random() - 0.5) * 4)
          : new THREE.Vector3(3.0 + (Math.random() - 0.5) * 4, 7.5, -23.0 + (Math.random() - 0.5) * 8);
      } else {
        dPos = new THREE.Vector3(
          Math.max(-34, Math.min(20, relayPos.x + (Math.random() - 0.5) * 14)),
          7.5,
          Math.max(-28, Math.min(24, relayPos.z + (Math.random() - 0.5) * 14))
        );
      }
      this.spawnCombatEnemy('drone', dPos, alertOpts);
      const hPos = new THREE.Vector3(
        relayPos.x > 0 ? -4 : 10,
        0,
        relayPos.z > 0 ? -12 : 12
      );
      this.spawnCombatEnemy(opts.withShield ? 'shield' : 'hound', hPos, alertOpts);
    }

    spawnFinalReinforcements(opts = {}) {
      const alertOpts = this._buildCombatOpts(opts, true);
      const droneSpawns = [
        new THREE.Vector3(-22, 9.0, -8),
        new THREE.Vector3(16, 8.5, -18),
        new THREE.Vector3(4, 9.2, 14),
      ];
      for (const p of droneSpawns) {
        this.spawnCombatEnemy('drone', p, alertOpts);
      }
      this.spawnCombatEnemy('sniper', new THREE.Vector3(22.5, 10.4, 4.5), alertOpts);
      this.spawnCombatEnemy('shield', new THREE.Vector3(6, 0, -14), alertOpts);

      const houndSpawns = [
        new THREE.Vector3(-26, 0, 18),
        new THREE.Vector3(-12, 0, -28),
        new THREE.Vector3(15, 0, -16),
      ];
      for (const p of houndSpawns) {
        this.spawnCombatEnemy('hound', p, alertOpts);
      }
    }

    // 声波/枪声/爆炸感知：使用统一阶梯判定；消音武器仅贴脸（<=3.5m）触发红警 COMBAT，外圈仅 SUSPICIOUS
    alertSound(origin, radius, isHostile = true, isSuppressed = false) {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.dead || e.isTutorialTarget || e.isTrainingTarget) continue;
        const d = e.group.position.distanceTo(origin);
        const level = GameLogic.classifySoundAlert(d, radius, isHostile, isSuppressed);
        if (level === 'COMBAT') {
          e.alert(false);
        } else if (level === 'SUSPICIOUS') {
          e.investigate(origin);
        }
      }
    }

    lureSound(origin, radius = 22) {
      this.alertSound(origin, radius, false);
    }

    alertNearby(origin, radius) {
      this.alertSound(origin, radius, true);
    }

    onEnemyAlarmCommitted(enemy) {
      if (this.onAlarmTriggered) this.onAlarmTriggered(enemy);
      this.alertSound(enemy.group.position, 28, true);
      if (enemy.type === 'recon' && !enemy.reinforcementsCalled) {
        enemy.reinforcementsCalled = true;
        if (this.onReconReinforce) this.onReconReinforce(enemy.group.position);
      }
    }

    triggerTacticalScan(origin, radius = 65, duration = 6.0) {
      let highlighted = 0;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.dead && e.group.position.distanceTo(origin) <= radius) {
          e.setScanHighlight(duration);
          highlighted++;
        }
      }
      return highlighted;
    }

    performMelee(playerPos, playerForward) {
      let bestEnemy = null;
      let bestDist = 2.75;
      _fwdTmp.set(playerForward.x, 0, playerForward.z);
      if (_fwdTmp.lengthSq() > 0.0001) _fwdTmp.normalize();
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.dead || (e.isTutorialTarget && !e.allowTutorialMelee)) continue;
        _toETmp.subVectors(e.group.position, playerPos);
        const flatDist = Math.hypot(_toETmp.x, _toETmp.z);
        if (flatDist > bestDist || Math.abs(_toETmp.y) > 2.2) continue;
        _flatDirTmp.set(_toETmp.x, 0, _toETmp.z);
        if (_flatDirTmp.lengthSq() > 0.0001) _flatDirTmp.normalize();
        if (_flatDirTmp.dot(_fwdTmp) > 0.25) {
          bestDist = flatDist;
          bestEnemy = e;
        }
      }
      if (!bestEnemy) return { hit: false, silentTakedown: false, killed: false };

      _eFwdTmp.set(Math.sin(bestEnemy.group.rotation.y), 0, Math.cos(bestEnemy.group.rotation.y));
      _enemyToPlayerTmp.set(playerPos.x - bestEnemy.group.position.x, 0, playerPos.z - bestEnemy.group.position.z);
      if (_enemyToPlayerTmp.lengthSq() > 0.0001) _enemyToPlayerTmp.normalize();
      const fromBehind = _eFwdTmp.dot(_enemyToPlayerTmp) < -0.1;
      const unaware = bestEnemy.stealthState !== 'COMBAT' || bestEnemy.callInTimer > 0 || bestEnemy.empTimer > 0;
      const silentTakedown = fromBehind || unaware;

      if (silentTakedown) {
        const killed = bestEnemy.takeDamage(9999, bestEnemy.group.position, true, {
          silent: true,
          silentTakedown: true,
        });
        return { hit: true, silentTakedown: true, killed };
      }

      // 正面近战：击退硬直 + 打断发报与蓄力（击退后立即执行碰撞约束防止穿墙）
      bestEnemy.staggerTimer = 0.95;
      if (bestEnemy.callInTimer > 0) bestEnemy.callInTimer = -1;
      _pushTmp.set(bestEnemy.group.position.x - playerPos.x, 0, bestEnemy.group.position.z - playerPos.z);
      if (_pushTmp.lengthSq() > 0.0001) _pushTmp.normalize();
      bestEnemy.group.position.addScaledVector(_pushTmp, 1.35);
      const collision = this.level && this.level.collision;
      if (collision) {
        const isAir = bestEnemy.type === 'drone' || bestEnemy.type === 'recon' || bestEnemy.type === 'sniper';
        if (isAir && collision.resolveAerial) {
          collision.resolveAerial(bestEnemy.group.position, 0.98, 0.45);
        } else {
          collision.resolveCircleXZ(bestEnemy.group.position, 0.68, bestEnemy.group.position.y);
          bestEnemy.group.position.y = collision.getGroundHeight(
            bestEnemy.group.position.x,
            bestEnemy.group.position.z,
            bestEnemy.group.position.y
          );
        }
      }
      const killed = bestEnemy.takeDamage(85, bestEnemy.group.position, false, { silent: false, isMelee: true });
      return { hit: true, silentTakedown: false, killed };
    }

    getStealthStatus() {
      let maxState = 'PATROL';
      let maxSuspicion = 0;
      let activeCount = 0;
      let callInUrgent = false;
      let sniperLocking = false;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.dead || e.isTutorialTarget || e.isTrainingTarget) continue;
        activeCount++;
        if (e.suspicion > maxSuspicion) maxSuspicion = e.suspicion;
        if (e.callInTimer > 0) callInUrgent = true;
        if (e.laserChargeTimer > 0) sniperLocking = true;
        if (e.stealthState === 'COMBAT') maxState = 'COMBAT';
        else if (e.stealthState === 'SUSPICIOUS' && maxState !== 'COMBAT') maxState = 'SUSPICIOUS';
      }
      return { maxState, maxSuspicion, activeCount, callInUrgent, sniperLocking };
    }

    getActiveHitboxes() {
      const list = [];
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.dead) {
          for (let j = 0; j < e.hitboxes.length; j++) list.push(e.hitboxes[j]);
        }
      }
      return list;
    }

    firePlasmaBolt(origin, target, type, dmgScale = 1.0, opts = {}) {
      const dist = origin.distanceTo(target);
      this.audio.playEnemyShot(type, dist, origin);
      const boltSpeedScale = Math.max(0.5, Number(opts && opts.boltSpeedScale) || 1.0);
      const jitterScale = Math.max(0.25, Number(opts && opts.jitterScale) || 1.0);
      for (let i = 0; i < this.maxBolts; i++) {
        const b = this.bolts[i];
        if (!b.active) {
          b.active = true;
          b.life = 0;
          b.pos.copy(origin);
          b.origin.copy(origin);
          _boltDirTmp.subVectors(target, origin);
          if (_boltDirTmp.lengthSq() > 0.0001) _boltDirTmp.normalize();
          else _boltDirTmp.set(0, 0, 1);
          const jitter = (type === 'sniper' ? 0.008 : 0.05) * jitterScale;
          _boltDirTmp.x += (Math.random() - 0.5) * jitter;
          _boltDirTmp.y += (Math.random() - 0.5) * jitter * 0.8;
          _boltDirTmp.z += (Math.random() - 0.5) * jitter;
          _boltDirTmp.normalize();
          const baseSpeed = type === 'sniper' ? 88 : type === 'shield' ? 32 : type === 'drone' ? 31 : 35;
          const speed = baseSpeed * boltSpeedScale;
          const baseDmg = type === 'sniper' ? 28 : type === 'shield' ? 14 : type === 'drone' ? 10 : 8;
          b.vel.copy(_boltDirTmp).multiplyScalar(speed);
          b.damage = Math.max(4, Math.round(baseDmg * dmgScale));
          break;
        }
      }
    }

    applyExplosionDamage(center, radius = 8.2, maxDamage = 130) {
      let kills = 0;
      const collision = this.level && this.level.collision;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.dead) continue;
        _ePos.copy(e.group.position);
        if (_ePos.y < 0.3) _ePos.y += 0.6;
        const dist = _ePos.distanceTo(center);
        const occluded = collision ? !collision.hasLineOfSight(center, _ePos) : false;
        const dmg = GameLogic.computeExplosionFalloff(dist, radius, maxDamage, occluded);
        if (dmg > 0) {
          const killed = e.takeDamage(dmg, _ePos, false, { fromExplosion: true });
          if (killed) kills++;
        }
      }
      return kills;
    }

    spawnDeathFlash(pos) {
      this.deathLight.position.copy(pos);
      this.deathLight.intensity = 34;
      this.deathFlashTimer = 0.25;
    }

    onEnemyKilled(enemy, isCrit = false, silentTakedown = false) {
      if (!enemy.isTutorialTarget) {
        this.killedCount++;
      }
      if (this.onKillCallback) this.onKillCallback(enemy, !!isCrit, !!silentTakedown);
    }

    update(dt, playerPos, playerController) {
      const t = this.render.time;
      this.currentPlayerStealthFactor = playerController && playerController.getStealthFactor
        ? playerController.getStealthFactor()
        : 1.0;

      const isCrouched = !!(playerController && (playerController.crouching || playerController.crouched));
      const isSliding = !!(playerController && playerController.sliding);
      const leanAmt = playerController && Number.isFinite(playerController.leanDir)
        ? playerController.leanDir
        : (playerController && Number.isFinite(playerController.leanAmount) ? playerController.leanAmount : 0);
      const yaw = (playerController && Number.isFinite(playerController.yaw)) ? playerController.yaw : 0;
      _hbArg.pos = playerPos;
      _hbArg.curEye = (playerController && Number.isFinite(playerController.curEye))
        ? playerController.curEye
        : (isSliding ? 0.86 : isCrouched ? 1.08 : 1.68);
      _hbArg.leanDir = leanAmt;
      _hbArg.rightX = Math.cos(yaw);
      _hbArg.rightZ = -Math.sin(yaw);
      _hbArg.crouching = isCrouched;
      _hbArg.sliding = isSliding;
      const hb = GameLogic.computePlayerHitbox(_hbArg);
      this.currentPlayerAimY = Math.max(0.45, hb.center.y - playerPos.y);

      let needsCompaction = false;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.dead) {
          e.update(dt, playerPos, t);
        } else if (e.dying) {
          e.updateDying(dt);
          if (e.disposed) needsCompaction = true;
        } else if (e.disposed) {
          needsCompaction = true;
        }
      }
      if (needsCompaction) {
        let writeIdx = 0;
        for (let i = 0; i < this.enemies.length; i++) {
          if (!this.enemies[i].disposed) {
            this.enemies[writeIdx++] = this.enemies[i];
          }
        }
        this.enemies.length = writeIdx;
      }

      if (this.deathFlashTimer > 0) {
        this.deathFlashTimer -= dt;
        this.deathLight.intensity = Math.max(0, (this.deathFlashTimer / 0.25) * 34);
      }

      _hbCenterVec.set(hb.center.x, hb.center.y, hb.center.z);
      let boltDirty = false;
      for (let i = 0; i < this.maxBolts; i++) {
        const b = this.bolts[i];
        if (!b.active) continue;
        boltDirty = true;
        b.life += dt;
        if (b.life > 2.6) {
          b.active = false;
          this.boltMesh.setMatrixAt(i, this._zeroMat);
          continue;
        }

        _nextPos.copy(b.pos).addScaledVector(b.vel, dt);
        const hitsPlayer = GameLogic.segmentHitsCapsule(b.pos, _nextPos, hb.bottom, hb.top, hb.radius) &&
          this.level.collision.hasLineOfSight(b.pos, _hbCenterVec);
        if (hitsPlayer) {
          b.active = false;
          this.boltMesh.setMatrixAt(i, this._zeroMat);
          playerController.takeDamage(b.damage, b.origin);
          continue;
        }
        if (_nextPos.y <= 0.05 || !this.level.collision.hasLineOfSight(b.pos, _nextPos)) {
          b.active = false;
          this.boltMesh.setMatrixAt(i, this._zeroMat);
          this.render.spawnSparks(b.pos, _upVec, 4, 0.5);
          continue;
        }

        b.pos.copy(_nextPos);
        this._dummy.position.copy(b.pos);
        this._dummy.lookAt(b.pos.x + b.vel.x, b.pos.y + b.vel.y, b.pos.z + b.vel.z);
        this._dummy.scale.set(1, 1, 1);
        this._dummy.updateMatrix();
        this.boltMesh.setMatrixAt(i, this._dummy.matrix);
      }
      if (boltDirty) {
        this.boltMesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  return Manager;
})();
