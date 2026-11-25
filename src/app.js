// ============================================================================
// 模块 7：玩家控制、任务剧情、战术 HUD 与 60fps 主循环 (GameApp)
// ============================================================================

const GameApp = (() => {
  'use strict';

  class PlayerController {
    constructor(camera, level, texFactory, audio, weapon) {
      this.camera = camera;
      this.level = level;
      this.tex = texFactory;
      this.audio = audio;
      this.weapon = weapon;

      this.pos = new THREE.Vector3(0, 0, 27.5);
      this.vel = new THREE.Vector3();
      this.yaw = 0;
      this.pitch = 0.03;

      this.hp = 100;
      this.maxHp = 100;
      this.timeSinceHit = 10;
      this.regenDelay = 5.0;
      this.regenCap = 65;
      this.regenRate = 5.5;
      this.damageTakenTotal = 0;
      this.invulnerablePractice = false;
      this.simulatedHits = 0;

      this.standEye = 1.68;
      this.crouchEye = 1.08;
      this.slideEye = 0.86;
      this.curEye = this.standEye;
      this.grounded = true;
      this.moveSpeed = 0;
      this.sprinting = false;
      this.crouching = false;
      this.sliding = false;
      this.slideTimer = 0;
      this.slideCooldown = 0;
      this.slideDir = new THREE.Vector3();
      this.leanAlpha = 0;
      this.leanDir = 0;
      this.adrenalinePerk = false;
      this.blackoutMutator = false;
      this.stepAccum = 0;
      this.indoors = false;
      this.puddleDepth = 0;

      this.keys = Object.create(null);
      this.sensitivity = 1.0;
      this.invertY = false;
      this.trauma = 0;
      this.shakeTime = 0;
      this.onLowHpWarning = null;
      this.camera.rotation.order = 'YXZ';

      this._fwd = new THREE.Vector3();
      this._right = new THREE.Vector3();
      this._wish = new THREE.Vector3();
      this._eyeProbe = new THREE.Vector3();
      this._frontProbe = new THREE.Vector3();
      this._rightSide = new THREE.Vector3();
      this._rightAim = new THREE.Vector3();
      this._leftSide = new THREE.Vector3();
      this._leftAim = new THREE.Vector3();
    }

    reset() {
      this.pos.set(0, 0, 27.5);
      this.vel.set(0, 0, 0);
      this.yaw = 0;
      this.pitch = 0.03;
      this.hp = this.maxHp;
      this.timeSinceHit = 10;
      this.damageTakenTotal = 0;
      this.invulnerablePractice = false;
      this.simulatedHits = 0;
      this.curEye = this.standEye;
      this.grounded = true;
      this.sliding = false;
      this.slideTimer = 0;
      this.slideCooldown = 0;
      this.leanAlpha = 0;
      this.leanDir = 0;
      this.adrenalinePerk = false;
      this.stepAccum = 0;
      this.trauma = 0;
    }

    triggerSlide() {
      if (!this.sprinting || !this.grounded || this.sliding || this.slideCooldown > 0) return false;
      this.sliding = true;
      this.slideTimer = 0.62;
      this.slideCooldown = 0.88;
      this.slideDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
      this.audio.playSlide();
      return true;
    }

    getStealthFactor() {
      let factor = 1.0;
      if (this.crouching || this.sliding) factor *= 0.62;
      else if (this.sprinting) factor *= 1.32;
      else if (this.moveSpeed < 0.45) factor *= 0.85;

      if (!this.weapon.flashlightOn) factor *= 0.74;
      else factor *= 1.08;

      if (this.blackoutMutator) factor *= 0.72;
      if (this.indoors && this.level.warehouseLights && this.level.warehouseLights.disabled) {
        factor *= 0.65;
      }
      if (this.level.isPointInRelayASearchlight && this.level.isPointInRelayASearchlight(this.pos)) {
        factor *= 1.65;
      }
      return Math.max(0.32, Math.min(1.65, factor));
    }

    setSpawn(x, y, z, yaw = 0, pitch = 0.03) {
      this.pos.set(x, y, z);
      this.vel.set(0, 0, 0);
      this.yaw = yaw;
      this.pitch = pitch;
    }

    addTrauma(amount) {
      this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
    }

    onMouseMove(dx, dy) {
      const fov = this.camera ? this.camera.fov : 75;
      const adsScale = (window.GameLogic && window.GameLogic.computeAdsSensitivityScale)
        ? window.GameLogic.computeAdsSensitivityScale(fov, 75)
        : (1 - this.weapon.adsAlpha * 0.44);
      const s = 0.0021 * this.sensitivity * adsScale;
      const dySign = this.invertY ? -1 : 1;
      this.yaw -= dx * s;
      this.pitch = Math.max(-1.38, Math.min(1.38, this.pitch - dy * dySign * s));
      this.weapon.addLookSway(dx, dy);
    }

    takeDamage(dmg, sourcePos) {
      if (this.hp <= 0) return;
      if (this.invulnerablePractice) {
        this.simulatedHits++;
        this.damageTakenTotal += dmg;
        this.audio.playPlayerHit();
        this.addTrauma(Math.min(0.45, 0.16 + dmg * 0.008));
        if (this.onDamageFeedback) this.onDamageFeedback(sourcePos);
        return;
      }
      const wasAboveLow = this.hp > 32;
      this.hp = Math.max(0, this.hp - dmg);
      this.timeSinceHit = 0;
      this.damageTakenTotal += dmg;
      this.audio.playPlayerHit();
      if (dmg >= 24 && this.audio.playTinnitusFlash) {
        this.audio.playTinnitusFlash(Math.min(0.85, dmg / 36));
      }
      this.weapon.camRecoilPitch += 0.025;
      this.weapon.camRecoilYaw += (Math.random() - 0.5) * 0.03;
      const traumaMul = this.adrenalinePerk ? 0.55 : 1.0;
      this.addTrauma(Math.min(0.65, 0.24 + dmg * 0.012) * traumaMul);
      if (wasAboveLow && this.hp > 0 && this.hp <= 32 && this.onLowHpWarning) {
        this.onLowHpWarning();
      }
      if (this.onDamageFeedback) this.onDamageFeedback(sourcePos);
    }

    heal(amount) {
      this.hp = Math.min(this.maxHp, this.hp + amount);
    }

    setDifficultyConfig(diffCfg) {
      const cfg = diffCfg || {};
      this.regenDelay = typeof cfg.playerRegenDelay === 'number' ? cfg.playerRegenDelay : 5.0;
      this.regenCap = typeof cfg.playerRegenCap === 'number' ? cfg.playerRegenCap : 65;
      this.regenRate = typeof cfg.playerRegenRate === 'number' ? cfg.playerRegenRate : 5.5;
    }

    update(dt) {
      this.timeSinceHit += dt;
      // 脱战后按当前难度阈值恢复生命值
      if (this.timeSinceHit > this.regenDelay && this.hp > 0 && this.hp < this.regenCap) {
        this.hp = Math.min(this.regenCap, this.hp + dt * this.regenRate);
      }

      if (this.slideCooldown > 0) this.slideCooldown = Math.max(0, this.slideCooldown - dt);

      const fwdInput = (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0) -
                       (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0);
      const sideInput = (this.keys['KeyD'] || this.keys['ArrowRight'] ? 1 : 0) -
                        (this.keys['KeyA'] || this.keys['ArrowLeft'] ? 1 : 0);

      this.crouching = !!(this.keys['KeyC'] || this.keys['ControlLeft'] || this.keys['ControlRight']);
      const shiftHeld = !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
      if (shiftHeld && fwdInput > 0 && !this.crouching && !this.sliding && this.weapon.isADS && this.weapon._toggleAdsMode) {
        this.weapon.isADS = false;
      }
      const wantSprint = shiftHeld && fwdInput > 0 && !this.crouching && !this.weapon.isADS && !this.sliding;
      this.sprinting = wantSprint;

      this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

      if (this.sliding) {
        this.slideTimer -= dt;
        const tNorm = Math.max(0, this.slideTimer / 0.62);
        const slideSpeed = 5.4 + 6.0 * tNorm;
        this.vel.x = this.slideDir.x * slideSpeed;
        this.vel.z = this.slideDir.z * slideSpeed;
        if (this.slideTimer <= 0 || this.keys['Space']) {
          this.sliding = false;
        }
      } else {
        let targetSpeed = 5.2;
        if (this.sprinting) targetSpeed = 7.7;
        else if (this.crouching) targetSpeed = 3.1;
        else if (this.weapon.isADS) targetSpeed = 3.35;

        this._wish.set(0, 0, 0)
          .addScaledVector(this._fwd, fwdInput)
          .addScaledVector(this._right, sideInput);
        if (this._wish.lengthSq() > 0.001) {
          this._wish.normalize().multiplyScalar(targetSpeed);
        }

        const accel = this.grounded ? 14 : 4;
        this.vel.x += (this._wish.x - this.vel.x) * Math.min(1, dt * accel);
        this.vel.z += (this._wish.z - this.vel.z) * Math.min(1, dt * accel);
      }

      if (this.keys['Space'] && this.grounded && (!this.crouching || this.sliding)) {
        this.sliding = false;
        this.vel.y = 5.8;
        this.grounded = false;
      }

      this.vel.y -= 17.5 * dt;

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.level.collision.resolveCircleXZ(this.pos, 0.42, this.pos.y);

      this.pos.y += this.vel.y * dt;
      const groundH = this.level.collision.getGroundHeight(this.pos.x, this.pos.z, this.pos.y);
      if (this.pos.y <= groundH) {
        this.pos.y = groundH;
        this.vel.y = 0;
        this.grounded = true;
      } else if (this.pos.y > groundH + 0.08) {
        this.grounded = false;
      }

      this.moveSpeed = Math.hypot(this.vel.x, this.vel.z);

      // 平滑下蹲 / 滑铲视角高度
      const targetEye = this.sliding ? this.slideEye : this.crouching ? this.crouchEye : this.standEye;
      this.curEye += (targetEye - this.curEye) * Math.min(1, dt * 13);

      // 掩体边缘 ADS 自动探头检测（零每帧分配）
      let targetLean = 0;
      if (this.weapon.isADS && !this.sliding && this.grounded) {
        this._eyeProbe.set(this.pos.x, this.pos.y + this.curEye, this.pos.z);
        this._frontProbe.copy(this._eyeProbe).addScaledVector(this._fwd, 1.15);
        if (!this.level.collision.hasLineOfSight(this._eyeProbe, this._frontProbe)) {
          this._rightSide.copy(this._eyeProbe).addScaledVector(this._right, 0.62);
          this._rightAim.copy(this._rightSide).addScaledVector(this._fwd, 1.45);
          this._leftSide.copy(this._eyeProbe).addScaledVector(this._right, -0.62);
          this._leftAim.copy(this._leftSide).addScaledVector(this._fwd, 1.45);
          const rightClear = this.level.collision.hasLineOfSight(this._eyeProbe, this._rightSide) &&
                             this.level.collision.hasLineOfSight(this._rightSide, this._rightAim);
          const leftClear = this.level.collision.hasLineOfSight(this._eyeProbe, this._leftSide) &&
                            this.level.collision.hasLineOfSight(this._leftSide, this._leftAim);
          if (rightClear && !leftClear) targetLean = 1;
          else if (leftClear && !rightClear) targetLean = -1;
          else if (rightClear && leftClear) targetLean = sideInput < 0 ? -1 : 1;
        }
      }
      this.leanDir += (targetLean - this.leanDir) * Math.min(1, dt * 11);

      // 判定是否处于铁皮仓库室内与地面积水深度
      const wb = this.level.warehouseBox;
      this.indoors = this.pos.x > wb.minX && this.pos.x < wb.maxX &&
                     this.pos.z > wb.minZ && this.pos.z < wb.maxZ &&
                     this.pos.y < wb.maxY;
      this.puddleDepth = this.pos.y > 0.15 ? 0 : this.tex.samplePuddleMask(this.pos.x, this.pos.z);

      if (this.grounded && !this.sliding && this.moveSpeed > 0.8) {
        this.stepAccum += this.moveSpeed * dt;
        const stepInterval = this.sprinting ? 2.3 : 1.95;
        if (this.stepAccum >= stepInterval) {
          this.stepAccum = 0;
          const isMetal = this.pos.y > 0.2;
          this.audio.playFootstep(this.puddleDepth, isMetal);
        }
      }

      this.trauma = Math.max(0, this.trauma - dt * 1.65);
      this.shakeTime += dt * 36;
      const shake = this.trauma * this.trauma;
      const shakePitch = shake * 0.032 * Math.sin(this.shakeTime * 1.15);
      const shakeYaw = shake * 0.026 * Math.cos(this.shakeTime * 0.92);
      const shakeRoll = shake * 0.038 * Math.sin(this.shakeTime * 1.43);

      const leanOffset = this.leanDir * 0.44;
      const slideRoll = this.sliding ? -0.07 : 0;
      this.camera.position.set(
        this.pos.x + this._right.x * leanOffset,
        this.pos.y + this.curEye,
        this.pos.z + this._right.z * leanOffset
      );
      this.camera.rotation.y = this.yaw + this.weapon.camRecoilYaw + shakeYaw;
      this.camera.rotation.x = this.pitch + this.weapon.camRecoilPitch + shakePitch;
      this.camera.rotation.z = shakeRoll - this.leanDir * 0.085 + slideRoll;
    }
  }

  class MissionHUD {
    constructor() {
      this.compassTrack = document.getElementById('compass-track');
      this.compassPips = document.getElementById('compass-pips');
      this.markersLayer = document.getElementById('markers-layer');
      this.scopeOverlay = document.getElementById('scope-overlay');
      this.crosshair = document.getElementById('crosshair');
      this.chDot = this.crosshair.querySelector('.ch-dot');
      this.chTicks = this.crosshair.querySelectorAll('.ch-tick');
      this.hitmarker = document.getElementById('hitmarker');
      this.interactWrap = document.getElementById('interact-wrap');
      this.interactLabel = document.getElementById('interact-label');
      this.interactRing = document.getElementById('interact-ring-prog');
      this.hpFill = document.getElementById('hp-fill');
      this.hpText = document.getElementById('hp-text');
      this.regenTag = document.getElementById('regen-tag');
      this.relayPips = document.querySelectorAll('.relay-pip');
      this.objectiveCard = document.getElementById('objective-card');
      this.objectiveTitle = document.getElementById('objective-title');
      this.relayLedsEl = document.getElementById('relay-leds');
      this.tutChipsEl = document.getElementById('tut-chips');
      this.tutSkipHintEl = document.getElementById('tut-skip-hint');
      this.ammoCur = document.getElementById('ammo-cur');
      this.ammoRes = document.getElementById('ammo-res');
      this.wpnNameEl = document.getElementById('wpn-name');
      this.wpnSlotBadge = document.getElementById('wpn-slot-badge');
      this.supStatus = document.getElementById('sup-status');
      this.grenadeStatus = document.getElementById('grenade-status');
      this.scanStatus = document.getElementById('scan-status');
      this.stealthChip = document.getElementById('stealth-chip');
      this.holdoutBar = document.getElementById('holdout-bar');
      this.holdoutTime = document.getElementById('holdout-time');
      this.holdoutFill = document.getElementById('holdout-fill');
      this.hudRoot = document.getElementById('hud');
      this.reloadBadge = document.getElementById('reload-badge');
      this.flashStatus = document.getElementById('flash-status');
      this.radioBox = document.getElementById('radio-box');
      this.radioSpeaker = document.getElementById('radio-speaker');
      this.radioText = document.getElementById('radio-text');
      this.damageVignette = document.getElementById('damage-vignette');
      this.damageArcsEl = document.getElementById('damage-arcs');
      this.fpsChip = document.getElementById('fps-chip');
      this.difficultyBadge = document.getElementById('difficulty-badge');
      this.perkStrip = document.getElementById('perk-strip');
      this.killFeedEl = document.getElementById('kill-feed');
      this._killFeedItems = [];

      this.voice = null;
      this.hitTimer = 0;
      this.dmgTimer = 0;
      this.radioTimer = 0;
      this.radioFullText = '';
      this.radioRevealIdx = 0;
      this._radioToken = 0;
      this._activeRadio = null;
      this._lastTutChipsKey = '';
      this.markerEls = new Map();
      this._proj = new THREE.Vector3();
      this._markerOffset = new THREE.Vector3(0, 0.8, 0);
      this._markerTargets = [];
      this._markerActiveKeys = new Set();
      this._markerPlaced = [];
      this._compassPipPool = [];
      this._pipPoolSize = 24;
      if (this.compassPips) {
        for (let i = 0; i < this._pipPoolSize; i++) {
          const pip = document.createElement('span');
          pip.className = 'cmp-pip';
          pip.hidden = true;
          this.compassPips.appendChild(pip);
          this._compassPipPool.push({ el: pip, cls: '', hidden: true, tx: -9999 });
        }
      }
      this._relaySeveredCache = [];
      this._lastDomCache = {
        lang: (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang() : 'zh',
        hp: -1,
        hpLow: '',
        regenOpacity: '',
        interactActive: null,
        interactLabel: '',
        interactDash: '',
        tutMode: null,
        trainMode: null,
        urgentMode: null,
        relayHidden: null,
        tutChipsActive: null,
        tutSkipHidden: null,
        objTitle: '',
        holdoutHidden: null,
        holdoutTime: '',
        holdoutScale: '',
        stealthState: '',
        stealthText: '',
        wpnName: '',
        ammoCur: '',
        ammoLow: null,
        ammoRes: '',
        wpnSlot: '',
        supOn: null,
        grenadeText: '',
        scanText: '',
        diffId: '',
        diffText: '',
        realismAttr: '',
        reloading: null,
        flashText: '',
        fpsText: '',
        compassOffset: null,
        perkKey: '',
      };

      this.arcPool = [];
      this._arcCursor = 0;
      if (this.damageArcsEl) {
        for (let i = 0; i < 4; i++) {
          const div = document.createElement('div');
          div.className = 'dmg-arc';
          div.innerHTML = '<svg viewBox="0 0 260 260" aria-hidden="true"><path d="M 88 40 Q 130 14 172 40 L 160 54 Q 130 34 100 54 Z" fill="rgba(255, 58, 48, 0.92)"/></svg>';
          this.damageArcsEl.appendChild(div);
          this.arcPool.push({ el: div, life: 0, maxLife: 0.72, worldPos: null });
        }
      }

      this._buildCompassLabels();
    }

    setVoiceEngine(voice) {
      this.voice = voice;
    }

    invalidateCache(lang) {
      const cache = this._lastDomCache;
      if (!cache) return;
      if (lang) cache.lang = lang;
      cache.interactLabel = '';
      cache.objTitle = '';
      cache.stealthText = '';
      cache.wpnName = '';
      cache.wpnSlot = '';
      cache.supOn = null;
      cache.grenadeText = '';
      cache.scanText = '';
      cache.diffText = '';
      cache.flashText = '';
      cache.perkKey = '';
      this._lastTutChipsKey = '';
    }

    clearKillFeed() {
      for (let i = 0; i < this._killFeedItems.length; i++) {
        const item = this._killFeedItems[i];
        if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
      }
      this._killFeedItems.length = 0;
    }

    pushKillFeed(enemy, isCrit = false, silentTakedown = false) {
      if (!this.killFeedEl || !enemy || enemy.isTutorialTarget || enemy.isTrainingTarget) return;
      const typeKeys = {
        drone: 'hud.enemy.drone',
        hound: 'hud.enemy.hound',
        shield: 'hud.enemy.shield',
        sniper: 'hud.enemy.sniper',
        recon: 'hud.enemy.recon',
      };
      const label = I18n.t(typeKeys[enemy.type] || 'hud.enemy.unknown');
      const suffix = silentTakedown
        ? I18n.t('hud.killSuffixSilent')
        : isCrit
          ? I18n.t('hud.killSuffixCrit')
          : '';
      const el = document.createElement('div');
      el.className = 'kf-item' + (silentTakedown ? ' silent' : isCrit ? ' crit' : '');
      el.textContent = I18n.t('hud.killFeed', { label, suffix });
      this.killFeedEl.appendChild(el);
      this._killFeedItems.push({ el, life: 3.2 });
      while (this._killFeedItems.length > 3) {
        const oldest = this._killFeedItems.shift();
        if (oldest && oldest.el && oldest.el.parentNode) {
          oldest.el.parentNode.removeChild(oldest.el);
        }
      }
    }

    clearRadio() {
      this.radioTimer = 0;
      this._activeRadio = null;
      this._radioToken++;
      this.radioBox.classList.remove('active', 'tutorial', 'speaking');
      for (let i = 0; i < this.arcPool.length; i++) {
        this.arcPool[i].life = 0;
        this.arcPool[i].el.style.opacity = '0';
      }
      this.clearKillFeed();
      if (this.perkStrip) {
        this.perkStrip.hidden = true;
        this.perkStrip.textContent = '';
      }
      if (this._lastDomCache) this._lastDomCache.perkKey = '';
    }

    _buildCompassLabels() {
      const dirs = [
        [0, I18n.t('hud.dir.N')],
        [45, I18n.t('hud.dir.NE')],
        [90, I18n.t('hud.dir.E')],
        [135, I18n.t('hud.dir.SE')],
        [180, I18n.t('hud.dir.S')],
        [225, I18n.t('hud.dir.SW')],
        [270, I18n.t('hud.dir.W')],
        [315, I18n.t('hud.dir.NW')],
      ];
      let html = '';
      // 铺设 -360 到 +720 度无缝循环标尺 (每度 3px)
      for (let rep = -1; rep <= 1; rep++) {
        for (let deg = 0; deg < 360; deg += 15) {
          const x = (deg + rep * 360) * 3;
          const match = dirs.find((d) => d[0] === deg);
          if (match) {
            html += `<span class="cmp-major" style="left:${x}px">${match[1]}</span>`;
          } else {
            html += `<span class="cmp-tick" style="left:${x}px"></span>`;
          }
        }
      }
      this.compassTrack.innerHTML = html;
    }

    _resolveRadioCopy(speaker, text, voiceOpts) {
      const vOpts = voiceOpts || {};
      const uiLang = (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang() : 'zh';
      const anyPack = (vOpts.voiceId && this.voice && this.voice._getAnyLoadedPack)
        ? this.voice._getAnyLoadedPack(vOpts.voiceId)
        : null;
      const packClip = anyPack && anyPack.clips ? anyPack.clips[vOpts.voiceId] : null;
      const role = vOpts.role || (packClip && packClip.role) || 'watcher';

      let resolvedSpeaker = speaker;
      if (vOpts.speakerKey && typeof I18n !== 'undefined') {
        const params = typeof vOpts.getSpeakerParams === 'function' ? vOpts.getSpeakerParams() : vOpts.speakerParams;
        resolvedSpeaker = I18n.t(vOpts.speakerKey, params);
      } else if (!resolvedSpeaker && this.voice && typeof this.voice.getRoleLabel === 'function') {
        resolvedSpeaker = this.voice.getRoleLabel(role, uiLang);
      } else if (!resolvedSpeaker && typeof I18n !== 'undefined') {
        const key = role === 'instructor' ? 'app.speaker.instructor' : role === 'evac' ? 'app.speaker.evac' : 'app.speaker.watcher';
        resolvedSpeaker = I18n.t(key);
      }

      let resolvedText = text;
      if (vOpts.textKey && typeof I18n !== 'undefined') {
        const params = typeof vOpts.getTextParams === 'function' ? vOpts.getTextParams() : vOpts.textParams;
        resolvedText = I18n.t(vOpts.textKey, params);
      } else if (!resolvedText && vOpts.voiceId && this.voice && typeof this.voice.getClipSubtitle === 'function') {
        resolvedText = this.voice.getClipSubtitle(vOpts.voiceId, uiLang) || '';
      }

      return { resolvedSpeaker, resolvedText, role, uiLang };
    }

    refreshRadioLanguage() {
      if (!this._activeRadio || !this.radioBox.classList.contains('active') || this.radioTimer <= 0) return;
      const { speaker, text, vOpts } = this._activeRadio;
      const hadKeyOrClip = !!(vOpts && (vOpts.speakerKey || vOpts.textKey || vOpts.voiceId));
      if (!hadKeyOrClip) return;
      const prevLen = this.radioFullText.length;
      const wasDone = this.radioRevealIdx >= prevLen;
      const { resolvedSpeaker, resolvedText } = this._resolveRadioCopy(
        vOpts.speakerKey ? null : (vOpts.voiceId && !vOpts.hasCustomSpeaker ? null : speaker),
        vOpts.textKey ? null : (vOpts.voiceId ? null : text),
        vOpts
      );
      if (resolvedSpeaker) this.radioSpeaker.textContent = resolvedSpeaker;
      if (resolvedText) {
        this.radioFullText = resolvedText;
        if (wasDone) {
          this.radioRevealIdx = resolvedText.length;
          this.radioText.textContent = resolvedText;
        } else {
          this.radioRevealIdx = Math.min(this.radioRevealIdx, resolvedText.length);
          this.radioText.textContent = resolvedText.slice(0, Math.floor(this.radioRevealIdx));
        }
      }
    }

    showRadio(speaker, text, duration = 5.8, isTutorial = false, voiceOpts = null) {
      const vOpts = voiceOpts || {};
      const { resolvedSpeaker, resolvedText, role, uiLang } = this._resolveRadioCopy(speaker, text, vOpts);
      const reqToken = ++this._radioToken;

      if (vOpts.voiceId && this.voice) {
        const activeVoiceLang = this.voice.voiceLang || ((typeof I18n !== 'undefined' && I18n.resolveVoiceLang) ? I18n.resolveVoiceLang('auto') : uiLang);
        const ttsText = typeof this.voice.getClipSubtitle === 'function'
          ? (this.voice.getClipSubtitle(vOpts.voiceId, activeVoiceLang) || '')
          : '';
        const res = this.voice.speak(vOpts.voiceId, {
          text: resolvedText,
          ttsText: ttsText || undefined,
          role: vOpts.role || role,
          priority: vOpts.priority,
          cooldownSec: vOpts.cooldownSec,
          voiceLang: vOpts.voiceLang,
          onStart: () => {
            this.radioBox.classList.add('speaking');
          },
          onEnd: (completed) => {
            this.radioBox.classList.remove('speaking');
            if (completed && !isTutorial && Number.isFinite(this.radioTimer)) {
              this.radioTimer = Math.min(this.radioTimer, 1.15);
            }
          },
        });
        if (!res.played && (res.reason === 'skip_busy' || res.reason === 'skip_cooldown')) {
          if (vOpts.tacOnly || (vOpts.priority !== undefined && vOpts.priority <= 2)) {
            return false;
          }
        }
        if ((!resolvedText || !resolvedSpeaker) && typeof this.voice.ensurePackLoaded === 'function') {
          this.voice.ensurePackLoaded(activeVoiceLang).then(() => {
            if (this._radioToken !== reqToken || !this.radioBox.classList.contains('active')) return;
            const curUiLang = (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang() : uiLang;
            if (!this.radioFullText && typeof this.voice.getClipSubtitle === 'function') {
              const lateText = this.voice.getClipSubtitle(vOpts.voiceId, curUiLang);
              if (lateText) {
                this.radioFullText = lateText;
                this.radioRevealIdx = 0;
              }
            }
            if (!speaker && typeof this.voice.getRoleLabel === 'function') {
              const lateSpeaker = this.voice.getRoleLabel(role, curUiLang);
              if (lateSpeaker) this.radioSpeaker.textContent = lateSpeaker;
            }
          });
        }
      } else {
        this.radioBox.classList.remove('speaking');
      }

      this._activeRadio = { speaker: resolvedSpeaker, text: resolvedText, vOpts };
      this.radioSpeaker.textContent = resolvedSpeaker || I18n.t('app.speaker.watcher');
      this.radioFullText = resolvedText || '';
      this.radioRevealIdx = 0;
      this.radioText.textContent = '';
      this.radioTimer = (vOpts.voiceId && this.voice && this.voice.isSpeaking() && Number.isFinite(duration))
        ? Math.max(duration, 20)
        : duration;
      this.radioBox.classList.toggle('tutorial', !!isTutorial);
      this.radioBox.classList.add('active');
      return true;
    }

    triggerHitmarker(isCrit, isKill, blockedByShield = false) {
      this.hitTimer = isKill ? 0.24 : 0.14;
      this.hitmarker.className = 'hitmarker active' + (isKill ? ' kill' : isCrit ? ' crit' : blockedByShield ? ' blocked' : '');
      this.hitmarker.style.borderColor = '';
    }

    triggerDamageFlash(sourcePos = null, player = null) {
      this.dmgTimer = 0.42;
      this.damageVignette.classList.add('active');
      if (sourcePos && this.arcPool.length > 0) {
        const slot = this.arcPool[this._arcCursor];
        this._arcCursor = (this._arcCursor + 1) % this.arcPool.length;
        slot.worldPos = new THREE.Vector3(sourcePos.x, sourcePos.y || 0, sourcePos.z);
        slot.life = slot.maxLife;
        if (player) {
          const deg = GameLogic.computeRelativeHitAngleDeg(player.pos, player.yaw, slot.worldPos);
          slot.el.style.setProperty('--arc-deg', `${deg.toFixed(1)}deg`);
        }
        slot.el.style.opacity = '1';
      }
    }

    update(dt, camera, player, weapon, level, enemies, missionState, fps, tutorial = null, training = null) {
      const tutActive = !!(tutorial && tutorial.active);
      const trainActive = !tutActive && !!(training && training.active);
      const cache = this._lastDomCache;
      const curLang = (typeof I18n !== 'undefined' && I18n.getLang) ? I18n.getLang() : 'zh';
      if (cache.lang !== curLang) {
        this.invalidateCache(curLang);
      }
      // 1. 顶部罗盘滚动（Three.js yaw=0 朝 -Z 即正北 0°，右转 yaw<0 朝东 90°）
      let heading = ((-player.yaw * 180) / Math.PI) % 360;
      if (heading < 0) heading += 360;
      const trackOffset = -Math.round(heading * 30) / 10;
      if (cache.compassOffset !== trackOffset) {
        cache.compassOffset = trackOffset;
        this.compassTrack.style.transform = `translate3d(${trackOffset}px, 0, 0)`;
      }

      // 更新罗盘动态方位点（复用 DOM 池 + GPU transform，零 innerHTML GC）
      let pipIdx = 0;
      const pool = this._compassPipPool;
      const poolLen = pool.length;
      const addPip = (worldPos, cls) => {
        if (pipIdx >= poolLen) return;
        const dx = worldPos.x - player.pos.x;
        const dz = worldPos.z - player.pos.z;
        let ang = (Math.atan2(dx, -dz) * 180) / Math.PI;
        if (ang < 0) ang += 360;
        let diff = ang - heading;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        if (Math.abs(diff) <= 58) {
          const slot = pool[pipIdx++];
          const tx = Math.round(diff * 30) / 10;
          if (slot.hidden) {
            slot.el.hidden = false;
            slot.hidden = false;
          }
          if (slot.cls !== cls) {
            slot.el.className = `cmp-pip ${cls}`;
            slot.cls = cls;
          }
          if (Math.abs(slot.tx - tx) > 0.05) {
            slot.el.style.transform = `translate3d(${tx}px, 0, 0) rotate(45deg)`;
            slot.tx = tx;
          }
        }
      };
      const guideTargets = tutActive ? tutorial.getGuideTargets(player, level) : [];
      if (tutActive) {
        for (const gt of guideTargets) {
          addPip(gt.pos, 'pip-tut');
        }
      } else {
        for (const r of level.relays) {
          if (!r.severed && !r.disabledByMode) addPip(r.pos, 'pip-relay');
        }
        if (level.extraction && level.extraction.unlocked) {
          addPip(level.extraction.pos, 'pip-evac');
        }
        for (const e of enemies.enemies) {
          if (e.dead || e.isTutorialTarget) continue;
          if (e.isTrainingTarget) {
            addPip(e.group.position, 'pip-tut');
          } else if (e.alerted && e.group.position.distanceTo(player.pos) < 42) {
            addPip(e.group.position, 'pip-enemy');
          }
        }
      }
      for (let i = pipIdx; i < poolLen; i++) {
        const slot = pool[i];
        if (!slot.hidden) {
          slot.el.hidden = true;
          slot.hidden = true;
        }
      }

      // 2. 3D 投影任务距离标记（进入近距交互圈后自动隐藏悬浮标以免遮挡交互提示）
      const targets = this._markerTargets;
      targets.length = 0;
      const activeKeys = this._markerActiveKeys;
      activeKeys.clear();
      if (tutActive) {
        for (const gt of guideTargets) {
          if (gt.pos.distanceTo(player.pos) >= (gt.hideDist ?? 3.2)) {
            targets.push({ key: gt.key, label: gt.label, pos: gt.pos, cls: 'mk-tut' });
            activeKeys.add(gt.key);
          }
        }
      } else {
        for (const r of level.relays) {
          if (!r.severed && !r.disabledByMode && r.pos.distanceTo(player.pos) >= 3.6) {
            const key = 'relay-' + r.id;
            targets.push({ key, label: I18n.t('hud.markerRelay', { id: r.id }), pos: r.pos, cls: 'mk-relay' });
            activeKeys.add(key);
          }
        }
        if (level.extraction && level.extraction.unlocked && level.extraction.pos.distanceTo(player.pos) >= 4.0) {
          targets.push({ key: 'evac', label: I18n.t('hud.markerEvac'), pos: level.extraction.pos, cls: 'mk-evac' });
          activeKeys.add('evac');
        }
      }
      for (const [k, el] of this.markerEls.entries()) {
        if (!activeKeys.has(k)) {
          el.remove();
          this.markerEls.delete(k);
        }
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const placed = this._markerPlaced;
      placed.length = 0;
      for (const t of targets) {
        let el = this.markerEls.get(t.key);
        if (!el) {
          el = document.createElement('div');
          el.className = `world-marker ${t.cls}`;
          el.innerHTML = '<span class="mk-diamond"></span><span class="mk-text"></span>';
          this.markersLayer.appendChild(el);
          el._textEl = el.querySelector('.mk-text');
          el._lastTransform = '';
          el._lastLabel = '';
          this.markerEls.set(t.key, el);
        }
        const dist = Math.round(t.pos.distanceTo(player.pos));
        this._proj.copy(t.pos).add(this._markerOffset).project(camera);
        let sx = (this._proj.x * 0.5 + 0.5) * w;
        let sy = (-this._proj.y * 0.5 + 0.5) * h;
        const behind = this._proj.z > 1;
        if (behind) {
          sx = w - sx;
          sy = h - 150;
        }
        sx = Math.round(Math.max(54, Math.min(w - 64, sx)) * 10) / 10;
        sy = Math.round(Math.max(66, Math.min(h - 150, sy)) * 10) / 10;
        for (const p of placed) {
          if (Math.abs(sx - p.x) < 110 && Math.abs(sy - p.y) < 28) {
            sy = p.y + 30;
          }
        }
        placed.push({ x: sx, y: sy });
        const tr = `translate3d(${sx}px, ${sy}px, 0)`;
        if (el._lastTransform !== tr) {
          el._lastTransform = tr;
          el.style.transform = tr;
        }
        const txt = `${t.label} · ${dist}m`;
        if (el._lastLabel !== txt && el._textEl) {
          el._lastLabel = txt;
          el._textEl.textContent = txt;
        }
      }

      // 3. 分枪型开镜光学视野（2.5D DMR 狙击镜 / 3D 全息反射 ADS 中心对齐点 / 拟真隐退）
      const wCfgForOptics = weapon.currentConfig || { id: 'car47' };
      const opticsDiff = tutActive || (trainActive && training.submode === 'timed')
        ? 'standard'
        : (missionState.difficulty || 'standard');
      const opticsState = (window.GameLogic && window.GameLogic.computeAdsOpticsState)
        ? window.GameLogic.computeAdsOpticsState({
          weaponId: weapon.activeSlot === 'secondary' ? 'pistol' : wCfgForOptics.id,
          adsAlpha: weapon.adsAlpha,
          isReloading: weapon.isReloading,
          difficulty: opticsDiff,
        })
        : {
          hideViewmodel3D: false,
          scopeOverlayOpacity: 0,
          crosshairLineOpacity: Math.max(0, 1 - weapon.adsAlpha * 1.4),
          crosshairDotOpacity: 0.9,
        };

      if (weapon.setAds3DHidden) {
        weapon.setAds3DHidden(opticsState.hideViewmodel3D);
      }
      if (this.scopeOverlay) {
        this.scopeOverlay.style.opacity = `${opticsState.scopeOverlayOpacity}`;
        const scopeScale = (1.06 - opticsState.scopeOverlayOpacity * 0.06).toFixed(3);
        this.scopeOverlay.style.transform = `scale(${scopeScale})`;
      }

      const spreadPx = 6 + weapon.getCurrentSpread(player.moveSpeed, player.crouching) * 680;
      const lineOpStr = `${opticsState.crosshairLineOpacity}`;
      const dotOpStr = `${opticsState.crosshairDotOpacity}`;
      this.crosshair.style.opacity = (opticsState.crosshairDotOpacity > 0 || opticsState.crosshairLineOpacity > 0) ? '1' : '0';
      if (this.chDot) this.chDot.style.opacity = dotOpStr;
      for (let tIdx = 0; tIdx < this.chTicks.length; tIdx++) {
        this.chTicks[tIdx].style.opacity = lineOpStr;
      }
      this.chTicks[0].style.transform = `translate(-50%, ${-spreadPx - 8}px)`;
      this.chTicks[1].style.transform = `translate(-50%, ${spreadPx}px)`;
      this.chTicks[2].style.transform = `translate(${-spreadPx - 8}px, -50%)`;
      this.chTicks[3].style.transform = `translate(${spreadPx}px, -50%)`;

      if (this.hitTimer > 0) {
        this.hitTimer -= dt;
        if (this.hitTimer <= 0) this.hitmarker.className = 'hitmarker';
      }
      if (this.dmgTimer > 0) {
        this.dmgTimer -= dt;
        if (this.dmgTimer <= 0) this.damageVignette.classList.remove('active');
      }
      for (let i = 0; i < this.arcPool.length; i++) {
        const slot = this.arcPool[i];
        if (slot.life <= 0) continue;
        slot.life -= dt;
        if (slot.life <= 0) {
          slot.life = 0;
          slot.el.style.opacity = '0';
          continue;
        }
        if (slot.worldPos) {
          const deg = GameLogic.computeRelativeHitAngleDeg(player.pos, player.yaw, slot.worldPos);
          slot.el.style.setProperty('--arc-deg', `${deg.toFixed(1)}deg`);
        }
        slot.el.style.opacity = Math.max(0, Math.min(1, slot.life / slot.maxLife)).toFixed(3);
      }

      // 4. 交互环、HP、弹药与电台打字机字幕（全量脏检查，避免每帧无意义 DOM 写入）
      const interactActive = !!missionState.interactPrompt;
      if (cache.interactActive !== interactActive) {
        cache.interactActive = interactActive;
        this.interactWrap.classList.toggle('active', interactActive);
      }
      if (interactActive) {
        if (cache.interactLabel !== missionState.interactPrompt) {
          cache.interactLabel = missionState.interactPrompt;
          this.interactLabel.textContent = missionState.interactPrompt;
        }
        const dashStr = (163.36 * (1 - missionState.interactProgress)).toFixed(1);
        if (cache.interactDash !== dashStr) {
          cache.interactDash = dashStr;
          this.interactRing.style.strokeDashoffset = dashStr;
        }
      }

      const hpVal = Math.ceil(player.hp);
      if (cache.hp !== hpVal) {
        cache.hp = hpVal;
        this.hpFill.style.width = `${hpVal}%`;
        this.hpText.textContent = `${hpVal}`;
        const hpLow = hpVal <= 35 ? 'true' : 'false';
        if (cache.hpLow !== hpLow) {
          cache.hpLow = hpLow;
          this.hpFill.dataset.low = hpLow;
        }
      }
      const regenOp = (player.timeSinceHit > player.regenDelay && hpVal < player.regenCap) ? '1' : '0';
      if (cache.regenOpacity !== regenOp) {
        cache.regenOpacity = regenOp;
        this.regenTag.style.opacity = regenOp;
      }

      if (tutActive || trainActive) {
        const hudInfo = tutActive ? tutorial.getHudInfo() : training.getHudInfo();
        const urgentMode = !!hudInfo.urgent;
        if (cache.tutMode !== tutActive) {
          cache.tutMode = tutActive;
          this.objectiveCard.classList.toggle('tutorial-mode', tutActive);
        }
        if (cache.trainMode !== trainActive) {
          cache.trainMode = trainActive;
          this.objectiveCard.classList.toggle('training-mode', trainActive);
        }
        if (cache.urgentMode !== urgentMode) {
          cache.urgentMode = urgentMode;
          this.objectiveCard.classList.toggle('urgent', urgentMode);
        }
        if (cache.relayHidden !== true) {
          cache.relayHidden = true;
          this.relayLedsEl.hidden = true;
        }
        if (this.holdoutBar && cache.holdoutHidden !== true) {
          cache.holdoutHidden = true;
          this.holdoutBar.hidden = true;
        }
        if (cache.tutChipsActive !== true) {
          cache.tutChipsActive = true;
          this.tutChipsEl.classList.add('active');
        }
        const skipHidden = !tutActive;
        if (cache.tutSkipHidden !== skipHidden) {
          cache.tutSkipHidden = skipHidden;
          this.tutSkipHintEl.hidden = skipHidden;
        }
        if (cache.objTitle !== hudInfo.title) {
          cache.objTitle = hudInfo.title;
          this.objectiveTitle.textContent = hudInfo.title;
        }
        if (this._lastTutChipsKey !== hudInfo.chipsKey) {
          this._lastTutChipsKey = hudInfo.chipsKey;
          this.tutChipsEl.innerHTML = hudInfo.chips
            .map((c) => {
              const cls = c.done ? ' done' : c.tone ? ` ${c.tone}` : '';
              return `<span class="tut-chip${cls}">${c.done ? '✔ ' : ''}${c.label}</span>`;
            })
            .join('');
        }
      } else {
        if (cache.tutMode) {
          cache.tutMode = false;
          this.objectiveCard.classList.remove('tutorial-mode');
        }
        if (cache.trainMode) {
          cache.trainMode = false;
          this.objectiveCard.classList.remove('training-mode');
        }
        if (cache.urgentMode) {
          cache.urgentMode = false;
          this.objectiveCard.classList.remove('urgent');
        }
        if (cache.relayHidden !== false) {
          cache.relayHidden = false;
          this.relayLedsEl.hidden = false;
        }
        if (cache.tutChipsActive) {
          cache.tutChipsActive = false;
          this.tutChipsEl.classList.remove('active');
        }
        if (cache.tutSkipHidden !== true) {
          cache.tutSkipHidden = true;
          this.tutSkipHintEl.hidden = true;
        }
        for (let i = 0; i < level.relays.length; i++) {
          const sev = !!level.relays[i].severed;
          if (this._relaySeveredCache[i] !== sev) {
            this._relaySeveredCache[i] = sev;
            this.relayPips[i].classList.toggle('done', sev);
          }
        }

        const isHoldout = missionState.phase === 'EVAC_HOLDOUT';
        if (this.holdoutBar) {
          const hh = !isHoldout;
          if (cache.holdoutHidden !== hh) {
            cache.holdoutHidden = hh;
            this.holdoutBar.hidden = hh;
          }
          if (isHoldout && this.holdoutTime && this.holdoutFill) {
            const rem = Math.max(0, missionState.holdoutTimer || 0);
            const hTime = `${rem.toFixed(1)}s`;
            if (cache.holdoutTime !== hTime) {
              cache.holdoutTime = hTime;
              this.holdoutTime.textContent = hTime;
            }
            const hScale = `scaleX(${Math.max(0, Math.min(1, rem / 30)).toFixed(3)})`;
            if (cache.holdoutScale !== hScale) {
              cache.holdoutScale = hScale;
              this.holdoutFill.style.transform = hScale;
            }
          }
        }
        const objTitle = missionState.phase === 'CUT_RELAYS'
          ? I18n.t('hud.objCutRelays', { count: missionState.severedCount })
          : isHoldout
            ? I18n.t('hud.objHoldout')
            : I18n.t('hud.objExtract');
        if (cache.objTitle !== objTitle) {
          cache.objTitle = objTitle;
          this.objectiveTitle.textContent = objTitle;
        }
      }

      if (this.stealthChip && enemies.getStealthStatus) {
        const st = enemies.getStealthStatus();
        let nextStState = st.maxState;
        let nextStText = I18n.t('hud.stealthPatrol');
        if (st.sniperLocking) {
          nextStState = 'COMBAT';
          nextStText = I18n.t('hud.stealthSniperLock');
        } else if (st.callInUrgent) {
          nextStState = 'COMBAT';
          nextStText = I18n.t('hud.stealthCallIn');
        } else if (st.maxState === 'COMBAT') {
          nextStText = I18n.t('hud.stealthCombat');
        } else if (st.maxState === 'SUSPICIOUS') {
          nextStText = I18n.t('hud.stealthSuspicious', { pct: Math.round(st.maxSuspicion * 100) });
        }
        if (cache.stealthState !== nextStState) {
          cache.stealthState = nextStState;
          this.stealthChip.dataset.state = nextStState;
        }
        if (cache.stealthText !== nextStText) {
          cache.stealthText = nextStText;
          this.stealthChip.textContent = nextStText;
        }
      }

      const wCfg = weapon.currentConfig || { name: 'CAR-47', nameEn: 'CAR-47', shortName: 'CAR-47', shortNameEn: 'CAR-47', magSize: 30 };
      const wName = I18n.field(wCfg, 'name') || wCfg.name || 'CAR-47';
      if (this.wpnNameEl && cache.wpnName !== wName) {
        cache.wpnName = wName;
        this.wpnNameEl.textContent = wName;
      }
      const ammoStr = `${weapon.ammo}`;
      if (cache.ammoCur !== ammoStr) {
        cache.ammoCur = ammoStr;
        this.ammoCur.textContent = ammoStr;
      }
      const ammoLow = weapon.ammo <= Math.max(2, Math.floor(weapon.magSize * 0.25));
      if (cache.ammoLow !== ammoLow) {
        cache.ammoLow = ammoLow;
        this.ammoCur.classList.toggle('low', ammoLow);
      }
      const resStr = `/ ${weapon.reserveAmmo}`;
      if (this.ammoRes && cache.ammoRes !== resStr) {
        cache.ammoRes = resStr;
        this.ammoRes.textContent = resStr;
      }
      if (this.wpnSlotBadge) {
        const wShort = I18n.field(wCfg, 'shortName') || wCfg.shortName || 'CAR-47';
        const slotTxt = weapon.activeSlot === 'secondary'
          ? `[2] ${wShort}`
          : `[1] ${wShort}`;
        if (cache.wpnSlot !== slotTxt) {
          cache.wpnSlot = slotTxt;
          this.wpnSlotBadge.textContent = slotTxt;
        }
      }
      if (this.supStatus) {
        const supOn = !!weapon.suppressorAttached;
        if (cache.supOn !== supOn) {
          cache.supOn = supOn;
          this.supStatus.textContent = supOn ? I18n.t('hud.supOn') : I18n.t('hud.supOff');
          this.supStatus.classList.toggle('sup-on', supOn);
          this.supStatus.classList.toggle('sup-off', !supOn);
        }
      }
      if (this.grenadeStatus) {
        const gId = weapon.activeThrowableId || 'emp';
        const gCat = window.GameLogic && window.GameLogic.THROWABLE_CATALOG;
        const gName = (gCat && gCat[gId] && I18n.field(gCat[gId], 'shortName')) || gId.toUpperCase();
        const cnt = (weapon.throwables && weapon.throwables[gId]) || 0;
        const grStr = `[G/4] ${gName} x${cnt}`;
        if (cache.grenadeText !== grStr) {
          cache.grenadeText = grStr;
          this.grenadeStatus.textContent = grStr;
        }
      }
      if (this.scanStatus) {
        const sc = missionState.scanCooldown || 0;
        const scanStr = sc > 0 ? I18n.t('hud.scanCooldown', { sec: sc.toFixed(1) }) : I18n.t('hud.scanReady');
        if (cache.scanText !== scanStr) {
          cache.scanText = scanStr;
          this.scanStatus.textContent = scanStr;
        }
      }
      const effectiveDiffId = tutActive || (trainActive && training.submode === 'timed')
        ? 'standard'
        : (missionState.difficulty || 'standard');
      const effDiffCfg = (window.GameLogic && window.GameLogic.getDifficultyConfig)
        ? window.GameLogic.getDifficultyConfig(effectiveDiffId)
        : null;
      if (this.difficultyBadge) {
        const dId = (effDiffCfg && effDiffCfg.id) || 'standard';
        const isLockedStd = tutActive || (trainActive && training.submode === 'timed');
        const dTxt = isLockedStd
          ? I18n.t('hud.diffBenchmark')
          : I18n.t('hud.diffLabel', { name: (effDiffCfg && I18n.field(effDiffCfg, 'name')) || I18n.t('diff.standard.title') });
        if (cache.diffId !== dId) {
          cache.diffId = dId;
          this.difficultyBadge.dataset.diff = dId;
        }
        if (cache.diffText !== dTxt) {
          cache.diffText = dTxt;
          this.difficultyBadge.textContent = dTxt;
        }
      }
      if (this.hudRoot) {
        const rAttr = missionState.realism ? 'true' : 'false';
        if (cache.realismAttr !== rAttr) {
          cache.realismAttr = rAttr;
          this.hudRoot.dataset.realism = rAttr;
        }
      }

      if (cache.reloading !== !!weapon.isReloading) {
        cache.reloading = !!weapon.isReloading;
        this.reloadBadge.classList.toggle('active', cache.reloading);
      }
      const fTxt = weapon.flashlightOn ? I18n.t('hud.flashOn') : I18n.t('hud.flashOff');
      if (cache.flashText !== fTxt) {
        cache.flashText = fTxt;
        this.flashStatus.textContent = fTxt;
      }

      if (this.radioTimer > 0) {
        if (dt > 0 && Number.isFinite(this.radioTimer)) {
          this.radioTimer -= dt;
        }
        if (this.radioRevealIdx < this.radioFullText.length) {
          this.radioRevealIdx = Math.min(this.radioFullText.length, this.radioRevealIdx + dt * 95);
          this.radioText.textContent = this.radioFullText.slice(0, Math.floor(this.radioRevealIdx));
        }
        if (this.radioTimer <= 0) {
          this.radioBox.classList.remove('active');
          this.radioBox.classList.remove('tutorial');
          this.radioBox.classList.remove('speaking');
        }
      }

      const fpsStr = `${Math.round(fps)} FPS`;
      if (cache.fpsText !== fpsStr) {
        cache.fpsText = fpsStr;
        this.fpsChip.textContent = fpsStr;
      }

      if (this.perkStrip) {
        const showPerks = !!(trainActive && training && training.submode === 'endless' &&
          Array.isArray(training.ownedPerks) && training.ownedPerks.length > 0);
        const perkKey = showPerks ? `${curLang}:${training.ownedPerks.join(',')}` : '';
        if (cache.perkKey !== perkKey) {
          cache.perkKey = perkKey;
          if (showPerks) {
            this.perkStrip.textContent = '';
            const catalog = (window.GameLogic && window.GameLogic.AIRDROP_PERKS) || [];
            for (let i = 0; i < training.ownedPerks.length; i++) {
              const pid = training.ownedPerks[i];
              const p = catalog.find((x) => x.id === pid);
              const pill = document.createElement('span');
              pill.className = 'perk-pill';
              pill.textContent = (p && (I18n.field(p, 'shortTag') || I18n.field(p, 'name'))) || pid;
              this.perkStrip.appendChild(pill);
            }
            this.perkStrip.hidden = false;
          } else {
            this.perkStrip.hidden = true;
            this.perkStrip.textContent = '';
          }
        }
      }

      for (let i = this._killFeedItems.length - 1; i >= 0; i--) {
        const item = this._killFeedItems[i];
        item.life -= dt;
        if (item.life <= 0) {
          if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
          this._killFeedItems.splice(i, 1);
        } else if (item.life < 0.4) {
          item.el.classList.add('fading');
        }
      }
    }
  }

  const TUT_STORAGE_KEY = 'storm_pier_tut_done';

  function isTutorialDone() {
    try {
      return window.localStorage.getItem(TUT_STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function markTutorialDone() {
    try {
      window.localStorage.setItem(TUT_STORAGE_KEY, '1');
    } catch (e) {}
  }

  class TutorialController {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.step = 0;
      this.finishing = false;
      this.finishTimer = 0;
      this.subtasks = {};
      this.tutorialDrone = null;
      this.tutorialStealthTarget = null;
      this.tutorialShieldTarget = null;
      this.prevPos = new THREE.Vector3();
      this.moveAccum = 0;
      this.stepStartShots = 0;
      this.sawReloading = false;
      this.initFlashlight = true;
      this._emptyGrenadeTimer = 0;
      this._lastBlockedHintTime = -99;
    }

    start() {
      this.active = true;
      this.finishing = false;
      this.finishTimer = 0;
      this.tutorialDrone = null;
      this.tutorialStealthTarget = null;
      this.tutorialShieldTarget = null;
      this._emptyGrenadeTimer = 0;
      this._lastBlockedHintTime = -99;
      const app = this.app;

      app.enemies.clearAll();
      app.level.resetWorldState();
      app._resetPlayerAndWeapon(true);
      app.elapsedTime = 0;
      app.missionState = {
        phase: 'TUTORIAL',
        severedCount: 0,
        interactPrompt: '',
        interactProgress: 0,
        lockdown: false,
        difficulty: 'standard',
        realism: false,
        scanCooldown: 0,
      };
      app.hud._lastTutChipsKey = '';
      this._enterStep(1);
    }

    stop() {
      this.active = false;
      this.step = 0;
      this.finishing = false;
      this.finishTimer = 0;
      this.tutorialDrone = null;
      this.tutorialStealthTarget = null;
      this.tutorialShieldTarget = null;
      this.subtasks = {};
      this.app.level.setTutorialGuide(false, 0, false);
    }

    _getPrimarySightLabel() {
      const priId = this.app.weapon.slots.primary.id;
      const cfg = this.app.weapon._getWeaponConfigById(priId);
      const shortName = cfg ? (I18n.field(cfg, 'shortName') || cfg.shortName) : I18n.t('tut.primaryFallback');
      if (priId === 'dmr') return I18n.t('tut.sight.dmr', { weapon: shortName });
      if (priId === 'shotgun') return I18n.t('tut.sight.shotgun', { weapon: shortName });
      return I18n.t('tut.sight.carbine', { weapon: shortName });
    }

    onFlashlightToggle() {
      if (this.active && this.step === 1) {
        this.subtasks.flashlight = true;
      }
    }

    onWeaponSwitched() {
      if (this.active && this.step === 2) {
        this.subtasks.switchedWeapon = true;
      }
    }

    onSuppressorToggled() {
      if (this.active && this.step === 2) {
        this.subtasks.toggledSuppressor = true;
      }
    }

    onScanTriggered() {
      if (this.active && this.step === 4) {
        this.subtasks.scanned = true;
      }
    }

    onMeleePerformed(res) {
      if (this.active && this.step === 4 && res && res.hit && res.killed) {
        this.subtasks.takedown = true;
      }
    }

    onThrowableCycled() {
      if (this.active && this.step === 5) {
        this.subtasks.cycled = true;
      }
    }

    onGadgetThrown(gadgetId) {
      if (this.active && this.step === 5 && gadgetId) {
        this.subtasks.thrown = true;
        if (gadgetId === 'emp') this.subtasks.cycled = true;
      }
    }

    onMedkitUsed() {
      if (this.active && this.step === 7) {
        this.subtasks.medkit = true;
      }
    }

    onBulletBlocked(kind) {
      if (!this.active) return;
      const now = this.app.elapsedTime;
      if (now - this._lastBlockedHintTime < 3.2) return;
      this._lastBlockedHintTime = now;
      if (kind === 'melee' && this.step === 4) {
        this.app.hud.showRadio(
          I18n.t('tut.speaker.stealth'),
          I18n.t('tut.blocked.melee'),
          3.6,
          true,
          { role: 'instructor', priority: 2, speakerKey: 'tut.speaker.stealth', textKey: 'tut.blocked.melee' }
        );
      } else if (kind === 'emp' && this.step === 5) {
        this.app.hud.showRadio(
          I18n.t('tut.speaker.shield'),
          I18n.t('tut.blocked.emp'),
          3.8,
          true,
          { role: 'instructor', priority: 2, speakerKey: 'tut.speaker.shield', textKey: 'tut.blocked.emp' }
        );
      }
    }

    onSimRelaySevered() {
      if (this.active && this.step === 8 && !this.finishing) {
        this.subtasks.severed = true;
        this.finishing = true;
        this.finishTimer = 2.0;
        markTutorialDone();
        this.app.audio.playRadioBeep();
        this.app.hud.showRadio(
          I18n.t('tut.speaker.complete'),
          I18n.t('tut.radio.complete'),
          Infinity,
          true,
          {
            voiceId: 'tut_complete',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.complete',
            textKey: 'tut.radio.complete',
          }
        );
      }
    }

    _enterStep(step) {
      const app = this.app;
      this.step = step;
      app.hud._lastTutChipsKey = '';
      app.audio.playRadioBeep();
      const speaker = I18n.t('tut.speaker.step', { step });
      const speakerParams = { step };

      if (step === 1) {
        this.prevPos.copy(app.player.pos);
        this.moveAccum = 0;
        this.initFlashlight = app.weapon.flashlightOn;
        this.subtasks = { moved: false, sprinted: false, slid: false, crouched: false, flashlight: false };
        app.level.setTutorialGuide(false, 1, false);
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step1'),
          Infinity,
          true,
          {
            voiceId: 'tut_1',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step1',
          }
        );
      } else if (step === 2) {
        this.stepStartShots = app.weapon.stats.shotsFired;
        this.subtasks = { ads: false, fired: false, shots: 0, switchedWeapon: false, toggledSuppressor: false };
        app.level.setTutorialGuide(false, 2, false);
        const sightName = this._getPrimarySightLabel();
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step2', { sight: sightName }),
          Infinity,
          true,
          {
            voiceId: 'tut_2',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step2',
            getTextParams: () => ({ sight: this._getPrimarySightLabel() }),
          }
        );
      } else if (step === 3) {
        this.tutorialDrone = app.enemies.spawnTutorialDrone(new THREE.Vector3(0, 4.2, 13.5));
        this.sawReloading = app.weapon.isReloading;
        this.subtasks = { droneKilled: false, reloaded: false };
        app.level.setTutorialGuide(false, 3, false);
        const curMag = app.weapon.magSize;
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step3', { mag: curMag }),
          Infinity,
          true,
          {
            voiceId: 'tut_3',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step3',
            textParams: { mag: curMag },
          }
        );
      } else if (step === 4) {
        this.tutorialStealthTarget = app.enemies.spawnTutorialStealthTarget(new THREE.Vector3(-3.5, 0.95, 11.0));
        app.scanCooldown = 0;
        this.subtasks = { scanned: false, takedown: false };
        app.level.setTutorialGuide(true, 4, false);
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step4'),
          Infinity,
          true,
          {
            voiceId: 'tut_4',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step4',
          }
        );
      } else if (step === 5) {
        this.tutorialShieldTarget = app.enemies.spawnTutorialShieldTarget(new THREE.Vector3(-1.5, 0.0, 12.5));
        app.weapon.throwables.emp = Math.max(2, app.weapon.throwables.emp || 0);
        app.weapon.throwables.frag = Math.max(2, app.weapon.throwables.frag || 0);
        this._emptyGrenadeTimer = 0;
        this.subtasks = { cycled: false, thrown: false, shieldKilled: false };
        app.level.setTutorialGuide(true, 5, false);
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step5'),
          Infinity,
          true,
          {
            voiceId: 'tut_5',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step5',
          }
        );
      } else if (step === 6) {
        this.subtasks = { climbed: false };
        app.level.setTutorialGuide(true, 6, false);
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step6'),
          Infinity,
          true,
          {
            voiceId: 'tut_6',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step6',
          }
        );
      } else if (step === 7) {
        const alreadyIn = !!app.player.indoors;
        this.subtasks = { indoors: alreadyIn, medkit: false };
        if (alreadyIn) {
          app.player.hp = Math.min(app.player.hp, 70);
          app.player.timeSinceHit = 10;
        }
        app.level.setTutorialGuide(true, 7, alreadyIn);
        const tKey = alreadyIn ? 'tut.radio.step7In' : 'tut.radio.step7Out';
        app.hud.showRadio(
          speaker,
          I18n.t(tKey),
          Infinity,
          true,
          {
            voiceId: alreadyIn ? 'tut_7_in' : 'tut_7_out',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: tKey,
          }
        );
      } else if (step === 8) {
        const sim = app.level.tutorialRelay;
        if (sim) {
          sim.severed = false;
          sim.c4Planted = false;
          sim.c4Timer = 0;
          if (sim.c4Group) sim.c4Group.visible = false;
          sim.panel.material.color.setHex(0x48d5ff);
          sim.light.color.setHex(0x48d5ff);
          sim.light.intensity = 12;
        }
        this.subtasks = { severed: false };
        app.level.setTutorialGuide(true, 8, true);
        app.hud.showRadio(
          speaker,
          I18n.t('tut.radio.step8'),
          Infinity,
          true,
          {
            voiceId: 'tut_8',
            role: 'instructor',
            priority: 3,
            speakerKey: 'tut.speaker.step',
            speakerParams,
            textKey: 'tut.radio.step8',
          }
        );
      }
    }

    update(dt) {
      if (!this.active) return;
      const app = this.app;
      const player = app.player;
      const weapon = app.weapon;

      if (this.finishing) {
        this.finishTimer -= dt;
        if (this.finishTimer <= 0) {
          app._startCombatMission(I18n.t('tut.missionStartMsg'), 'mission_start', 'tut.missionStartMsg');
        }
        return;
      }

      if (this.step <= 6 && player.hp < 100) player.hp = 100;
      if (this.step === 7 && this.subtasks.medkit && player.hp < 100) player.hp = 100;

      if (this.step === 1) {
        const movedDist = Math.hypot(player.pos.x - this.prevPos.x, player.pos.z - this.prevPos.z);
        this.prevPos.copy(player.pos);
        this.moveAccum += movedDist;
        if (this.moveAccum >= 2.5) this.subtasks.moved = true;
        if (player.sprinting && player.moveSpeed > 5.0) this.subtasks.sprinted = true;
        if (player.sliding) this.subtasks.slid = true;
        if (player.crouching) this.subtasks.crouched = true;
        if (weapon.flashlightOn !== this.initFlashlight) this.subtasks.flashlight = true;
        if (this.subtasks.moved && this.subtasks.sprinted && this.subtasks.slid && this.subtasks.crouched && this.subtasks.flashlight) {
          this._enterStep(2);
        }
      } else if (this.step === 2) {
        if (weapon.adsAlpha >= 0.78) this.subtasks.ads = true;
        this.subtasks.shots = Math.min(3, Math.max(0, weapon.stats.shotsFired - this.stepStartShots));
        this.subtasks.fired = this.subtasks.shots >= 3;
        if (this.subtasks.ads && this.subtasks.fired && this.subtasks.switchedWeapon && this.subtasks.toggledSuppressor) {
          this._enterStep(3);
        }
      } else if (this.step === 3) {
        if (weapon.isReloading) this.sawReloading = true;
        if (this.tutorialDrone && this.tutorialDrone.dead && !this.subtasks.droneKilled) {
          this.subtasks.droneKilled = true;
          if (!this.sawReloading && !weapon.isReloading && weapon.ammo >= weapon.magSize) {
            weapon.ammo = Math.max(0, weapon.magSize - 3);
          }
        }
        if (this.sawReloading && !weapon.isReloading && weapon.ammo >= weapon.magSize) {
          this.subtasks.reloaded = true;
        }
        if (this.subtasks.droneKilled && this.subtasks.reloaded) {
          this._enterStep(4);
        }
      } else if (this.step === 4) {
        app.scanCooldown = Math.min(app.scanCooldown, 1.5);
        if (this.tutorialStealthTarget && this.tutorialStealthTarget.dead) {
          this.subtasks.takedown = true;
        }
        if (this.subtasks.scanned && this.subtasks.takedown) {
          this._enterStep(5);
        }
      } else if (this.step === 5) {
        const totalExplosive = (weapon.throwables.emp || 0) + (weapon.throwables.frag || 0);
        if (totalExplosive === 0 && weapon.activeGrenades.length === 0) {
          this._emptyGrenadeTimer += dt;
          if (this._emptyGrenadeTimer >= 0.85) {
            this._emptyGrenadeTimer = 0;
            weapon.throwables.emp = 2;
            weapon.throwables.frag = 2;
          }
        } else {
          this._emptyGrenadeTimer = 0;
        }
        if (this.tutorialShieldTarget && this.tutorialShieldTarget.dead) {
          this.subtasks.shieldKilled = true;
        }
        if (this.subtasks.shieldKilled) {
          this._enterStep(6);
        }
      } else if (this.step === 6) {
        if (player.pos.y >= 2.1 && Math.hypot(player.pos.x - (-16.0), player.pos.z - 10.0) <= 4.5) {
          this.subtasks.climbed = true;
          this._enterStep(7);
        }
      } else if (this.step === 7) {
        if (!this.subtasks.indoors && player.indoors) {
          this.subtasks.indoors = true;
          player.hp = Math.min(player.hp, 70);
          player.timeSinceHit = 10;
          app.level.setTutorialGuide(true, 7, true);
          app.audio.playRadioBeep();
          app.hud.showRadio(
            I18n.t('tut.speaker.step', { step: 7 }),
            I18n.t('tut.radio.step7Entered'),
            Infinity,
            true,
            {
              voiceId: 'tut_7_in',
              role: 'instructor',
              priority: 3,
              speakerKey: 'tut.speaker.step',
              speakerParams: { step: 7 },
              textKey: 'tut.radio.step7Entered',
            }
          );
        }
        if (this.subtasks.indoors && this.subtasks.medkit) {
          this._enterStep(8);
        }
      } else if (this.step === 8) {
        const sim = app.level.tutorialRelay;
        if (sim && sim.c4Planted && !sim.severed) {
          sim.c4Timer -= dt;
          if (sim.c4Timer <= 0) {
            sim.c4Planted = false;
            sim.severed = true;
            if (sim.c4Group) sim.c4Group.visible = false;
            app.level.flashExplosionLight(sim.pos);
            app.render.spawnSparks(sim.pos, new THREE.Vector3(0, 1, 0), 30, 1.5);
            app.render.spawnSmoke(sim.pos, 6, 0.55, 2.5, 0xff8c3a);
            app.audio.playExplosion(app.player.pos.distanceTo(sim.pos));
            app.player.addTrauma(0.35);
            sim.panel.material.color.setHex(0x281414);
            sim.light.color.setHex(0xff5b2e);
            sim.light.intensity = 2.0;
            this.onSimRelaySevered();
          }
        }
      }
    }

    getGuideTargets(player, level) {
      if (!this.active) return [];
      if (this.step === 3 && this.tutorialDrone && !this.tutorialDrone.dead) {
        return [{ key: 'tut-drone', label: I18n.t('tut.marker.drone'), pos: this.tutorialDrone.group.position.clone(), hideDist: 2.0 }];
      }
      if (this.step === 4 && this.tutorialStealthTarget && !this.tutorialStealthTarget.dead) {
        return [{ key: 'tut-stealth', label: I18n.t('tut.marker.stealth'), pos: this.tutorialStealthTarget.group.position.clone(), hideDist: 1.5 }];
      }
      if (this.step === 5) {
        const list = [];
        if (this.tutorialShieldTarget && !this.tutorialShieldTarget.dead) {
          list.push({ key: 'tut-shield', label: I18n.t('tut.marker.shield'), pos: this.tutorialShieldTarget.group.position.clone(), hideDist: 2.0 });
        }
        if (level.tutorialAmmoCrate) {
          list.push({ key: 'tut-crate', label: I18n.t('tut.marker.crate'), pos: level.tutorialAmmoCrate.pos, hideDist: 2.0 });
        }
        return list;
      }
      if (this.step === 6) {
        return [{ key: 'tut-ramp', label: I18n.t('tut.marker.ramp'), pos: new THREE.Vector3(-16.0, 3.2, 10.0), hideDist: 2.8 }];
      }
      if (this.step === 7) {
        if (!this.subtasks.indoors) {
          return [{ key: 'tut-wh', label: I18n.t('tut.marker.wh'), pos: new THREE.Vector3(-12.0, 2.0, -14.0), hideDist: 3.0 }];
        }
        if (!this.subtasks.medkit && level.tutorialMedkit) {
          return [{ key: 'tut-med', label: I18n.t('tut.marker.med'), pos: level.tutorialMedkit.pos, hideDist: 2.4 }];
        }
      }
      if (this.step === 8 && !this.subtasks.severed && level.tutorialRelay) {
        return [{ key: 'tut-relay', label: I18n.t('tut.marker.relay'), pos: level.tutorialRelay.pos, hideDist: 3.2 }];
      }
      return [];
    }

    getHudInfo() {
      const lang = I18n.getLang();
      if (this.finishing) {
        const chips = [{ label: I18n.t('tut.finishingChip'), done: true }];
        return { title: I18n.t('tut.finishingTitle'), chips, chipsKey: `fin:${lang}` };
      }
      let title = I18n.t('tut.titleGeneric', { step: this.step });
      let chips = [];
      if (this.step === 1) {
        title = I18n.t('tut.step1.title');
        chips = [
          { label: I18n.t('tut.step1.move'), done: !!this.subtasks.moved },
          { label: I18n.t('tut.step1.sprint'), done: !!this.subtasks.sprinted },
          { label: I18n.t('tut.step1.slide'), done: !!this.subtasks.slid },
          { label: I18n.t('tut.step1.crouch'), done: !!this.subtasks.crouched },
          { label: I18n.t('tut.step1.light'), done: !!this.subtasks.flashlight },
        ];
      } else if (this.step === 2) {
        const wCfg = this.app.weapon.currentConfig || { shortName: I18n.t('tut.primaryFallback'), shortNameEn: I18n.t('tut.primaryFallback') };
        const wShort = I18n.field(wCfg, 'shortName') || I18n.t('tut.primaryFallback');
        title = I18n.t('tut.step2.title', { weapon: wShort });
        chips = [
          { label: I18n.t('tut.step2.ads'), done: !!this.subtasks.ads },
          { label: I18n.t('tut.step2.fire', { shots: this.subtasks.shots || 0 }), done: !!this.subtasks.fired },
          { label: I18n.t('tut.step2.swap'), done: !!this.subtasks.switchedWeapon },
          { label: I18n.t('tut.step2.sup'), done: !!this.subtasks.toggledSuppressor },
        ];
      } else if (this.step === 3) {
        const mag = this.app.weapon.magSize;
        title = I18n.t('tut.step3.title');
        chips = [
          { label: I18n.t('tut.step3.drone'), done: !!this.subtasks.droneKilled },
          { label: I18n.t('tut.step3.reload', { mag }), done: !!this.subtasks.reloaded },
        ];
      } else if (this.step === 4) {
        title = I18n.t('tut.step4.title');
        chips = [
          { label: I18n.t('tut.step4.scan'), done: !!this.subtasks.scanned },
          { label: I18n.t('tut.step4.takedown'), done: !!this.subtasks.takedown },
        ];
      } else if (this.step === 5) {
        title = I18n.t('tut.step5.title');
        chips = [
          { label: I18n.t('tut.step5.cycle'), done: !!this.subtasks.cycled },
          { label: I18n.t('tut.step5.empKill'), done: !!this.subtasks.shieldKilled },
        ];
      } else if (this.step === 6) {
        title = I18n.t('tut.step6.title');
        chips = [{ label: I18n.t('tut.step6.climb'), done: !!this.subtasks.climbed }];
      } else if (this.step === 7) {
        title = I18n.t('tut.step7.title');
        chips = [
          { label: I18n.t('tut.step7.enter'), done: !!this.subtasks.indoors },
          { label: I18n.t('tut.step7.medkit'), done: !!this.subtasks.medkit },
        ];
      } else if (this.step === 8) {
        title = I18n.t('tut.step8.title');
        chips = [{ label: I18n.t('tut.step8.sever'), done: !!this.subtasks.severed }];
      }
      const chipsKey = `${lang}:${this.step}:${this.app.weapon.activeSlot}:${this.app.weapon.magSize}:${chips.map((c) => `${c.label}=${c.done ? 1 : 0}`).join(',')}`;
      return { title, chips, chipsKey };
    }
  }

  const TRAINING_STORAGE_KEY = 'storm_pier_training_records_v1';

  function loadTrainingRecords() {
    try {
      const raw = window.localStorage.getItem(TRAINING_STORAGE_KEY);
      if (!raw) return GameLogic.createDefaultTrainingRecords();
      const parsed = JSON.parse(raw);
      return GameLogic.updateTrainingRecords(parsed, 'noop', {}).nextRecords;
    } catch (e) {
      return GameLogic.createDefaultTrainingRecords();
    }
  }

  function saveTrainingRecords(records) {
    try {
      window.localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(records));
    } catch (e) {}
  }

  const CAREER_STORAGE_KEY = 'storm_pier_career_v1';

  function loadCareerProfile() {
    try {
      const raw = window.localStorage.getItem(CAREER_STORAGE_KEY);
      if (!raw) return GameLogic.createDefaultCareerProfile();
      const parsed = JSON.parse(raw);
      return GameLogic.updateCareerRecords(parsed, { victory: false }).nextProfile;
    } catch (e) {
      return GameLogic.createDefaultCareerProfile();
    }
  }

  function saveCareerProfile(profile) {
    try {
      window.localStorage.setItem(CAREER_STORAGE_KEY, JSON.stringify(profile));
    } catch (e) {}
  }

  const LOADOUT_STORAGE_KEY = 'storm_pier_loadout_v1';

  function sanitizeLoadoutConfig(raw) {
    const fallback = { primaryWeapon: 'car47', skin: 'standard', difficulty: 'standard', mutators: [] };
    if (!raw || typeof raw !== 'object') return fallback;
    const validWeapons = ['car47', 'dmr', 'shotgun'];
    const validSkins = ['standard', 'night_ops', 'hazmat_blue'];
    const validMutators = ['blackout', 'explosive_tide', 'elite_patrol'];
    const primaryWeapon = validWeapons.includes(raw.primaryWeapon) ? raw.primaryWeapon : fallback.primaryWeapon;
    const skin = validSkins.includes(raw.skin) ? raw.skin : fallback.skin;
    let diff = typeof raw.difficulty === 'string' ? raw.difficulty : fallback.difficulty;
    if (diff === 'realistic') diff = 'realism';
    const validDiffs = ['recruit', 'standard', 'veteran', 'realism'];
    const difficulty = validDiffs.includes(diff) ? diff : fallback.difficulty;
    const mutators = Array.isArray(raw.mutators)
      ? Array.from(new Set(raw.mutators.filter((m) => validMutators.includes(m))))
      : [];
    return { primaryWeapon, skin, difficulty, mutators };
  }

  function loadLoadoutConfig() {
    try {
      const raw = window.localStorage.getItem(LOADOUT_STORAGE_KEY);
      if (!raw) return sanitizeLoadoutConfig(null);
      return sanitizeLoadoutConfig(JSON.parse(raw));
    } catch (e) {
      return sanitizeLoadoutConfig(null);
    }
  }

  function saveLoadoutConfig(cfg) {
    try {
      window.localStorage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(sanitizeLoadoutConfig(cfg)));
    } catch (e) {}
  }

  const USER_SETTINGS_STORAGE_KEY = 'storm_pier_settings_v1';

  function loadUserSettings() {
    try {
      const raw = window.localStorage.getItem(USER_SETTINGS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return GameLogic.sanitizeUserSettings(parsed);
    } catch (e) {
      return GameLogic.sanitizeUserSettings(null);
    }
  }

  function saveUserSettings(settings) {
    try {
      window.localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify(GameLogic.sanitizeUserSettings(settings)));
    } catch (e) {}
  }

  const TIMED_TARGET_SLOTS = [
    { pos: [0, 3.4, 15.5], motionType: 'hover', motionAmp: 0.7, motionFreq: 1.4 },
    { pos: [-2.4, 2.7, 13.0], motionType: 'strafe', motionAmp: 1.5, motionFreq: 1.5 },
    { pos: [2.6, 4.1, 13.5], motionType: 'strafe', motionAmp: 1.6, motionFreq: 1.65 },
    { pos: [-6.8, 4.0, 14.5], motionType: 'strafe', motionAmp: 1.8, motionFreq: 1.35 },
    { pos: [7.0, 4.2, 15.0], motionType: 'strafe', motionAmp: 1.8, motionFreq: 1.45 },
    { pos: [0, 5.8, 11.5], motionType: 'arc', motionAmp: 2.3, motionFreq: 1.25 },
    { pos: [-3.2, 4.8, 11.5], motionType: 'hover', motionAmp: 0.85, motionFreq: 1.85 },
    { pos: [3.2, 2.9, 16.5], motionType: 'strafe', motionAmp: 1.4, motionFreq: 1.75 },
    { pos: [-8.5, 5.1, 12.5], motionType: 'arc', motionAmp: 1.6, motionFreq: 1.5 },
  ];

  const ENDLESS_HOUND_SPAWNS = [
    [-14.0, 0, 26.0],
    [14.0, 0, 24.0],
    [-18.0, 0, 2.0],
    [9.5, 0, -2.0],
    [-12.0, 0, -21.0],
    [18.0, 0, -22.0],
    [-2.0, 0, -24.0],
    [-34.0, 0, 22.0],
  ];

  const ENDLESS_DRONE_SPAWNS = [
    [-20.0, 6.2, 6.0],
    [11.5, 6.8, -7.5],
    [-6.0, 7.5, -10.0],
    [4.0, 6.4, 15.0],
    [-26.0, 7.2, -16.0],
    [17.0, 8.2, -19.0],
  ];

  class TrainingController {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.submode = 'timed'; // 'timed' | 'endless' | 'stage'
      this.finished = false;

      // Timed state
      this.timedDuration = 60;
      this.timeRemaining = 60;
      this.lastCountdownSec = 60;
      this.combo = 0;
      this.maxCombo = 0;
      this.comboTimer = 0;
      this.lastSlotIdx = -1;

      // Endless state
      this.wave = 1;
      this.waveState = 'FIGHTING'; // 'FIGHTING' | 'BREATHER'
      this.breatherTimer = 0;
      this.waveSpec = null;
      this.waveQueue = [];
      this.ownedPerks = [];
      this.airdropPending = false;

      // Stage practice state
      this.stageId = 1;
      this.stage = GameLogic.TRAINING_STAGES[0];
      this.invulnerable = false;
      this.stageRelaySevered = false;
      this.stageInterceptorsSpawned = false;

      // Shared run metrics
      this.score = 0;
      this.kills = 0;
      this.critKills = 0;
    }

    isTimedSafe() {
      return this.active && this.submode === 'timed';
    }

    start(submode, config = {}) {
      const app = this.app;
      this.active = true;
      this.submode = submode;
      this.finished = false;
      this.score = 0;
      this.kills = 0;
      this.critKills = 0;

      app.tutorial.stop();
      app.audio.stopRelayCutLoop();
      app.hud.clearRadio();
      const forceStd = submode === 'timed';
      const trainDiff = app._getEffectiveDiffConfig(forceStd);
      app.enemies.clearAll();
      app.level.resetWorldState();
      app._resetPlayerAndWeapon(forceStd);
      app.elapsedTime = 0;
      app.hud._lastTutChipsKey = '';
      app.missionState = {
        phase: 'TRAINING',
        severedCount: 0,
        interactPrompt: '',
        interactProgress: 0,
        lockdown: false,
        difficulty: trainDiff.id,
        realism: !!trainDiff.hideHudHints,
        evacApproached: false,
        evacBoardingSpoken: false,
      };

      if (submode === 'timed') {
        this.timedDuration = Number(config.timedDuration) || 60;
        this.timeRemaining = this.timedDuration;
        this.lastCountdownSec = Math.ceil(this.timeRemaining);
        this.combo = 0;
        this.maxCombo = 0;
        this.comboTimer = 0;
        this.lastSlotIdx = -1;
        this.invulnerable = true;
        app.player.invulnerablePractice = true;
        app.player.setSpawn(0, 0, 24.5, 0, 0.04);
        app.level.setRelayModeState([]);
        for (let i = 0; i < 3; i++) this._spawnTimedTarget();
        app.audio.playRadioBeep();
        app.hud.showRadio(
          I18n.t('train.speaker.timed'),
          I18n.t('train.radio.timedStart', { sec: this.timedDuration }),
          5.0,
          false,
          {
            voiceId: 'train_timed_start',
            role: 'instructor',
            priority: 3,
            speakerKey: 'train.speaker.timed',
            textKey: 'train.radio.timedStart',
            textParams: { sec: this.timedDuration },
          }
        );
      } else if (submode === 'endless') {
        this.invulnerable = false;
        this.ownedPerks = [];
        this.airdropPending = false;
        app.player.invulnerablePractice = false;
        app.player.setSpawn(0, 0, 27.5, 0, 0.03);
        app.level.setRelayModeState([]);
        this._startEndlessWave(1);
        app.audio.playRadioBeep();
        app.hud.showRadio(
          I18n.t('train.speaker.endless'),
          I18n.t('train.radio.endlessStart'),
          5.6,
          false,
          {
            voiceId: 'train_endless_start',
            role: 'watcher',
            priority: 3,
            speakerKey: 'train.speaker.endless',
            textKey: 'train.radio.endlessStart',
          }
        );
      } else {
        this.stageId = Number(config.stageId) || 1;
        this.stage = GameLogic.TRAINING_STAGES.find((s) => s.id === this.stageId) || GameLogic.TRAINING_STAGES[0];
        this.invulnerable = !!config.invulnerable;
        this.stageRelaySevered = false;
        this.stageInterceptorsSpawned = false;
        app.player.invulnerablePractice = this.invulnerable;
        app.player.setSpawn(this.stage.spawn.x, this.stage.spawn.y, this.stage.spawn.z, this.stage.spawn.yaw, 0.03);

        if (this.stage.isExtractStage) {
          app.level.setRelayModeState([]);
          for (const r of app.level.relays) app.level.setRelaySeveredVisual(r);
          app.level.unlockExtraction();
          app.missionState.phase = 'EXTRACT';
          app.missionState.lockdown = true;
          app.enemies.spawnFinalReinforcements(app._buildEnemyDiffOpts(trainDiff));
          app.audio.playAlarmKlaxon(3);
          app.audio.playRadioBeep();
          app.hud.showRadio(
            I18n.t('train.speaker.stageEvac'),
            I18n.t('train.radio.stageExtract'),
            6.5,
            false,
            {
              voiceId: 'train_stage_4',
              role: 'evac',
              priority: 3,
              speakerKey: 'train.speaker.stageEvac',
              textKey: 'train.radio.stageExtract',
            }
          );
        } else {
          app.level.setRelayModeState([this.stage.relayId]);
          app.missionState.phase = 'CUT_RELAYS';
          for (const spec of this.stage.enemies) {
            app.enemies.spawnCombatEnemy(
              spec.type,
              new THREE.Vector3(spec.pos[0], spec.pos[1], spec.pos[2]),
              app._buildEnemyDiffOpts(trainDiff, { alertImmediately: false })
            );
          }
          app.audio.playRadioBeep();
          const stRef = this.stage;
          app.hud.showRadio(
            I18n.t('train.speaker.stage', { id: stRef.id }),
            I18n.t('train.radio.stageStart', { name: I18n.field(stRef, 'name'), relay: stRef.relayId }),
            6.2,
            false,
            {
              voiceId: stRef.voiceId,
              role: 'instructor',
              priority: 3,
              speakerKey: 'train.speaker.stage',
              speakerParams: { id: stRef.id },
              textKey: 'train.radio.stageStart',
              getTextParams: () => ({ name: I18n.field(stRef, 'name'), relay: stRef.relayId }),
            }
          );
        }
      }
    }

    stop() {
      this.active = false;
      this.finished = false;
      this.airdropPending = false;
      this.waveQueue = [];
      if (this.app && this.app.player) {
        this.app.player.invulnerablePractice = false;
      }
    }

    _spawnTimedTarget(avoidSlot = -1) {
      const usedSlots = new Set(
        this.app.enemies.enemies
          .filter((e) => !e.dead && e.isTrainingTarget && e.slotIndex >= 0)
          .map((e) => e.slotIndex)
      );
      const candidates = [];
      for (let i = 0; i < TIMED_TARGET_SLOTS.length; i++) {
        if (!usedSlots.has(i) && i !== avoidSlot && i !== this.lastSlotIdx) {
          candidates.push(i);
        }
      }
      if (candidates.length === 0) {
        for (let i = 0; i < TIMED_TARGET_SLOTS.length; i++) {
          if (!usedSlots.has(i)) candidates.push(i);
        }
      }
      const slotIndex = candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : Math.floor(Math.random() * TIMED_TARGET_SLOTS.length);
      this.lastSlotIdx = slotIndex;
      const spec = TIMED_TARGET_SLOTS[slotIndex];
      this.app.enemies.spawnTrainingTarget(new THREE.Vector3(spec.pos[0], spec.pos[1], spec.pos[2]), {
        slotIndex,
        motionType: spec.motionType,
        motionAmp: spec.motionAmp,
        motionFreq: spec.motionFreq,
      });
    }

    _pickSafeSpawn(pool) {
      const pPos = this.app.player.pos;
      const safe = pool.filter((coords) => Math.hypot(coords[0] - pPos.x, coords[2] - pPos.z) >= 14);
      const list = safe.length > 0 ? safe : pool;
      const c = list[Math.floor(Math.random() * list.length)];
      return new THREE.Vector3(c[0], c[1], c[2]);
    }

    _startEndlessWave(waveNum) {
      this.wave = waveNum;
      this.waveState = 'FIGHTING';
      this.breatherTimer = 0;
      this.airdropPending = false;
      this.waveSpec = GameLogic.computeEndlessWaveSpec(waveNum);
      const q = [];
      for (let i = 0; i < this.waveSpec.droneCount; i++) q.push('drone');
      for (let i = 0; i < this.waveSpec.houndCount; i++) q.push('hound');
      for (let i = 0; i < (this.waveSpec.reconCount || 0); i++) q.push('recon');
      for (let i = 0; i < (this.waveSpec.shieldCount || 0); i++) q.push('shield');
      for (let i = 0; i < (this.waveSpec.sniperCount || 0); i++) q.push('sniper');
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j], q[i]];
      }
      this.waveQueue = q;
      this._fillEndlessConcurrent();
    }

    _fillEndlessConcurrent() {
      if (!this.waveSpec || this.waveQueue.length === 0) return;
      let activeCount = 0;
      for (const e of this.app.enemies.enemies) {
        if (!e.dead && !e.isTutorialTarget && !e.isTrainingTarget) activeCount++;
      }
      const trainDiff = this.app._getEffectiveDiffConfig(false);
      while (this.waveQueue.length > 0 && activeCount < this.waveSpec.maxConcurrent) {
        const type = this.waveQueue.shift();
        const isAir = type === 'drone' || type === 'recon' || type === 'sniper';
        const pos = this._pickSafeSpawn(isAir ? ENDLESS_DRONE_SPAWNS : ENDLESS_HOUND_SPAWNS);
        if (type === 'sniper') pos.y = Math.max(pos.y, 8.8);
        this.app.enemies.spawnCombatEnemy(type, pos, this.app._buildEnemyDiffOpts(trainDiff, {
          alertImmediately: true,
          hpScale: this.waveSpec.hpScale,
          speedScale: this.waveSpec.speedScale,
          cooldownScale: this.waveSpec.cooldownScale,
        }));
        activeCount++;
      }
    }

    applyEndlessAirdrop(perkId) {
      this.airdropPending = false;
      if (perkId) {
        this.ownedPerks.push(perkId);
        this.app.weapon.addPerk(perkId);
        if (perkId === 'adrenaline_stim') {
          this.app.player.adrenalinePerk = true;
        }
        const cfg = (GameLogic.AIRDROP_PERKS || []).find((p) => p.id === perkId);
        this.app.hud.showRadio(
          I18n.t('train.speaker.airdrop'),
          I18n.t('train.radio.airdropLoaded', { name: cfg ? I18n.field(cfg, 'name') : perkId }),
          4.2,
          false,
          {
            voiceId: 'endless_airdrop_ready',
            role: 'watcher',
            priority: 2,
            speakerKey: 'train.speaker.airdrop',
            textKey: 'train.radio.airdropLoaded',
            getTextParams: () => ({ name: cfg ? I18n.field(cfg, 'name') : perkId }),
          }
        );
      }
      this.breatherTimer = 2.5;
    }

    onEnemyKilled(enemy, isCrit) {
      if (!this.active || this.finished) return;
      if (this.submode === 'timed' && enemy.isTrainingTarget) {
        this.kills++;
        if (isCrit) this.critKills++;
        this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        this.comboTimer = 4.5;
        const { points } = GameLogic.computeTimedTargetScore({
          basePoints: 100,
          isCrit,
          comboCount: this.combo,
        });
        this.score += points;
        this.app.audio.playComboChime(this.combo);
        this._spawnTimedTarget(enemy.slotIndex);
      } else if (this.submode === 'endless' && !enemy.isTutorialTarget && !enemy.isTrainingTarget) {
        this.kills++;
        if (isCrit) this.critKills++;
        const pts = enemy.type === 'shield' ? 220 : enemy.type === 'sniper' ? 190 : enemy.type === 'hound' ? 140 : 120;
        this.score += pts + (isCrit ? 60 : 0);
        this._fillEndlessConcurrent();
      } else if (this.submode === 'stage' && !enemy.isTutorialTarget && !enemy.isTrainingTarget) {
        this.kills++;
        if (isCrit) this.critKills++;
      }
    }

    onRelaySevered(relay) {
      if (!this.active || this.finished || this.submode !== 'stage' || this.stage.isExtractStage) return;
      this.app.level.setRelaySeveredVisual(relay);
      this.app.audio.playRelaySevered();
      this.app.render.spawnSparks(relay.pos, new THREE.Vector3(0, 1, 0), 22, 1.3);
      this.stageRelaySevered = true;

      if (!this.stageInterceptorsSpawned && this.stage.interceptors.length > 0) {
        this.stageInterceptorsSpawned = true;
        const trainDiff = this.app._getEffectiveDiffConfig(false);
        this.app.audio.playAlarmKlaxon(2);
        for (const spec of this.stage.interceptors) {
          this.app.enemies.spawnCombatEnemy(
            spec.type,
            new THREE.Vector3(spec.pos[0], spec.pos[1], spec.pos[2]),
            this.app._buildEnemyDiffOpts(trainDiff, { alertImmediately: true })
          );
        }
        const rem = this.app.enemies.enemies.filter((e) => !e.dead).length;
        if (rem > 0) {
          this.app.audio.playRadioBeep();
          this.app.hud.showRadio(
            I18n.t('train.speaker.stage', { id: this.stage.id }),
            I18n.t('train.radio.stageRelayCut', { id: relay.id, rem }),
            4.8,
            false,
            {
              speakerKey: 'train.speaker.stage',
              speakerParams: { id: this.stage.id },
              textKey: 'train.radio.stageRelayCut',
              textParams: { id: relay.id, rem },
            }
          );
        }
      }
    }

    onExtractionComplete() {
      if (!this.active || this.finished) return;
      if (this.submode === 'stage' && this.stage.isExtractStage) {
        this.finished = true;
        this.app._endTraining(true);
      }
    }

    update(dt) {
      if (!this.active || this.finished) return;
      const app = this.app;

      if (this.submode === 'timed') {
        if (app.player.hp < app.player.maxHp) app.player.hp = app.player.maxHp;
        if (this.comboTimer > 0) {
          this.comboTimer -= dt;
          if (this.comboTimer <= 0) {
            this.comboTimer = 0;
            this.combo = 0;
          }
        }
        this.timeRemaining = Math.max(0, this.timeRemaining - dt);
        const sec = Math.ceil(this.timeRemaining);
        if (sec > 0 && sec <= 5 && sec < this.lastCountdownSec) {
          this.lastCountdownSec = sec;
          app.audio.playCountdownTick(sec <= 3);
        }
        if (this.timeRemaining <= 0) {
          this.finished = true;
          app._endTraining(true);
        }
      } else if (this.submode === 'endless') {
        const activeCount = app.enemies.enemies.filter((e) => !e.dead && !e.isTutorialTarget && !e.isTrainingTarget).length;
        if (this.waveState === 'FIGHTING') {
          if (this.waveQueue.length > 0 && activeCount < this.waveSpec.maxConcurrent) {
            this._fillEndlessConcurrent();
          } else if (this.waveQueue.length === 0 && activeCount === 0) {
            this.waveState = 'BREATHER';
            this.breatherTimer = 3.5;
            app.audio.playWaveClear();
            app.player.heal(25);
            app.weapon.refillAmmo();
            const refreshed = this.wave % 2 === 0;
            if (refreshed) app.level.refreshSuppliesAndBarrels();
            if (app._openEndlessAirdropModal) {
              const opts = GameLogic.rollEndlessAirdropOptions(this.ownedPerks);
              this.airdropPending = true;
              app._openEndlessAirdropModal(opts, this.wave);
            }
          }
        } else if (!this.airdropPending) {
          this.breatherTimer -= dt;
          if (this.breatherTimer <= 0) {
            this._startEndlessWave(this.wave + 1);
            app.audio.playRadioBeep();
            app.hud.showRadio(
              I18n.t('train.speaker.endless'),
              I18n.t('train.radio.endlessWave', { wave: this.wave, total: this.waveSpec.totalCount }),
              4.6,
              false,
              {
                voiceId: 'train_endless_wave',
                role: 'watcher',
                priority: 3,
                speakerKey: 'train.speaker.endless',
                textKey: 'train.radio.endlessWave',
                textParams: { wave: this.wave, total: this.waveSpec.totalCount },
              }
            );
          }
        }
      } else if (this.submode === 'stage' && !this.stage.isExtractStage) {
        const activeCount = app.enemies.enemies.filter((e) => !e.dead && !e.isTutorialTarget && !e.isTrainingTarget).length;
        if (this.stageRelaySevered && activeCount === 0) {
          this.finished = true;
          app._endTraining(true);
        }
      }
    }

    getHudInfo() {
      const lang = I18n.getLang();
      if (this.submode === 'timed') {
        const secLeft = Math.ceil(this.timeRemaining);
        const mins = Math.floor(secLeft / 60);
        const secs = String(secLeft % 60).padStart(2, '0');
        const mult = this.combo > 1
          ? Math.min(3.0, 1 + (this.combo - 1) * 0.15).toFixed(2)
          : '1.00';
        const urgent = secLeft <= 5;
        const timerTone = urgent ? 'danger' : secLeft <= 10 ? 'warn' : '';
        const chips = [
          { label: I18n.t('train.hud.score', { score: this.score }), done: false, tone: '' },
          { label: I18n.t('train.hud.combo', { combo: this.combo, mult }), done: this.combo >= 3, tone: '' },
          { label: I18n.t('train.hud.kills', { kills: this.kills }), done: false, tone: timerTone },
        ];
        return {
          title: I18n.t('train.hud.timedTitle', { mins, secs }),
          urgent,
          chips,
          chipsKey: `${lang}:t:${secLeft}:${this.score}:${this.combo}:${this.kills}`,
        };
      }

      if (this.submode === 'endless') {
        const activeCount = this.app.enemies.enemies.filter((e) => !e.dead && !e.isTutorialTarget && !e.isTrainingTarget).length;
        const remaining = activeCount + this.waveQueue.length;
        const mins = Math.floor(this.app.elapsedTime / 60);
        const secs = String(Math.floor(this.app.elapsedTime % 60)).padStart(2, '0');
        const title = this.waveState === 'BREATHER'
          ? I18n.t('train.hud.endlessBreatherTitle', { sec: Math.max(0.1, this.breatherTimer).toFixed(1) })
          : I18n.t('train.hud.endlessWaveTitle', { wave: this.wave });
        const chips = [
          {
            label: this.waveState === 'BREATHER'
              ? I18n.t('train.hud.endlessReady')
              : I18n.t('train.hud.endlessRemaining', { count: remaining }),
            done: this.waveState === 'BREATHER',
            tone: '',
          },
          { label: I18n.t('train.hud.perks', { count: this.ownedPerks.length }), done: this.ownedPerks.length > 0, tone: '' },
          { label: I18n.t('train.hud.totalKills', { kills: this.kills }), done: false, tone: '' },
          { label: I18n.t('train.hud.survived', { mins, secs }), done: false, tone: '' },
        ];
        return {
          title,
          urgent: false,
          chips,
          chipsKey: `${lang}:e:${this.wave}:${this.waveState}:${Math.ceil(this.breatherTimer * 5)}:${remaining}:${this.ownedPerks.length}:${this.kills}:${secs}`,
        };
      }

      const activeCount = this.app.enemies.enemies.filter((e) => !e.dead && !e.isTutorialTarget && !e.isTrainingTarget).length;
      const mins = Math.floor(this.app.elapsedTime / 60);
      const secs = String(Math.floor(this.app.elapsedTime % 60)).padStart(2, '0');
      const chips = this.stage.isExtractStage
        ? [
            { label: I18n.t('train.hud.extractBerth'), done: false, tone: 'warn' },
            { label: I18n.t('train.hud.activeEnemies', { count: activeCount }), done: activeCount === 0, tone: '' },
            { label: I18n.t('train.hud.elapsed', { mins, secs }), done: false, tone: '' },
          ]
        : [
            { label: I18n.t('train.hud.relayTarget', { id: this.stage.relayId }), done: this.stageRelaySevered, tone: '' },
            { label: I18n.t('train.hud.remainingEnemies', { count: activeCount }), done: activeCount === 0, tone: '' },
            { label: I18n.t('train.hud.elapsed', { mins, secs }), done: false, tone: '' },
          ];
      if (this.invulnerable) {
        chips.push({ label: I18n.t('train.hud.practiceHits', { hits: this.app.player.simulatedHits }), done: false, tone: 'warn' });
      }
      return {
        title: I18n.t('train.hud.stageTitle', { id: this.stage.id, name: I18n.field(this.stage, 'shortName') }),
        urgent: false,
        chips,
        chipsKey: `${lang}:s:${this.stage.id}:${this.stageRelaySevered ? 1 : 0}:${activeCount}:${secs}:${this.invulnerable ? this.app.player.simulatedHits : -1}`,
      };
    }
  }

  class App {
    constructor() {
      if (typeof I18n !== 'undefined' && typeof I18n.applyDOM === 'function') {
        I18n.applyDOM();
      }
      this.canvas = document.getElementById('game-canvas');
      this.dialog = document.getElementById('menu-dialog');
      this.dlgTitle = document.getElementById('dlg-title');
      this.dlgDesc = document.getElementById('dlg-desc');
      this.dlgStats = document.getElementById('dlg-stats');
      this.langButtons = Array.from(document.querySelectorAll('#lang-switch .lang-btn[data-lang]'));
      this.menuViewMain = document.getElementById('menu-view-main');
      this.menuViewTraining = document.getElementById('menu-view-training');
      this.ctrlBrief = this.menuViewMain ? this.menuViewMain.querySelector('.ctrl-brief') : null;
      this.optGroup = this.menuViewMain ? this.menuViewMain.querySelector('.opt-group') : null;
      this.btnStart = document.getElementById('btn-start');
      this.btnSecondary = document.getElementById('btn-secondary');
      this.btnOpenTraining = document.getElementById('btn-open-training');
      this.btnReturnMain = document.getElementById('btn-return-main');
      this.trainTabs = Array.from(document.querySelectorAll('#train-tablist [role="tab"]'));
      this.trainTabPanel = document.getElementById('train-tabpanel');
      this.trainBestStrip = document.getElementById('train-best-strip');
      this.trainPanes = {
        timed: document.getElementById('train-pane-timed'),
        endless: document.getElementById('train-pane-endless'),
        stage: document.getElementById('train-pane-stage'),
      };
      this.trainPills = Array.from(document.querySelectorAll('.train-pill[data-duration]'));
      this.trainStageGrid = document.getElementById('train-stage-grid');
      this.optTrainInvuln = document.getElementById('opt-train-invuln');
      this.btnTrainBack = document.getElementById('btn-train-back');
      this.btnTrainStart = document.getElementById('btn-train-start');
      this.qualitySelect = document.getElementById('opt-quality');
      this.optDrs = document.getElementById('opt-drs');
      this.warmupBanner = document.getElementById('gfx-warmup-banner');
      this.warmupTitle = document.getElementById('warmup-title');
      this.warmupPct = document.getElementById('warmup-pct');
      this.warmupFill = document.getElementById('warmup-fill');
      this._gfxWarmupToken = 0;
      this._warmupHideTimer = 0;
      this.sensSlider = document.getElementById('opt-sens');
      this.sensOut = document.getElementById('val-sens');
      this.volSlider = document.getElementById('opt-vol');
      this.volOut = document.getElementById('val-vol');
      this.voiceVolSlider = document.getElementById('opt-voice-vol');
      this.voiceVolOut = document.getElementById('val-voice-vol');
      this.voiceLangSelect = document.getElementById('opt-voice-lang');
      this.voiceModeSelect = document.getElementById('opt-voice-mode');
      this.optToggleAds = document.getElementById('opt-toggle-ads');
      this.optInvertY = document.getElementById('opt-invert-y');
      this.loadoutPanel = document.getElementById('loadout-panel');
      this.difficultyPanel = document.getElementById('difficulty-panel');
      this.diffSummaryEl = document.getElementById('diff-summary');
      this.disclosureLoadout = document.getElementById('disclosure-loadout');
      this.disclosureLoadoutSummary = document.getElementById('disclosure-loadout-summary');
      this.disclosureSettings = document.getElementById('disclosure-settings');
      this.careerBestStrip = document.getElementById('career-best-strip');
      this.loadoutWeaponRadios = Array.from(document.querySelectorAll('input[name="loadout-weapon"]'));
      this.loadoutSkinRadios = Array.from(document.querySelectorAll('input[name="loadout-skin"]'));
      this.loadoutDiffRadios = Array.from(document.querySelectorAll('input[name="loadout-diff"]'));
      this.loadoutMutatorChecks = Array.from(document.querySelectorAll('input[name="loadout-mutator"]'));
      this.airdropDialog = document.getElementById('airdrop-dialog');
      this.airdropOptions = document.getElementById('airdrop-options');

      this.state = 'MENU'; // MENU | PLAYING | PAUSED | VICTORY | DEFEAT
      this.activeMode = 'combat'; // tutorial | combat | training
      this.dialogView = 'main'; // main | training
      this.elapsedTime = 0;
      this.fpsSmooth = 60;
      this.lastFrameTime = performance.now();

      this.userSettings = loadUserSettings();
      const initialVoiceLang = I18n.resolveVoiceLang(this.userSettings.voiceLang);

      this.audio = new AudioEngine();
      this.voice = new VoiceEngine(this.audio, { voiceLang: initialVoiceLang });
      this.voice.setVoiceLang(initialVoiceLang);
      this.texFactory = new TextureFactory(4).buildAll();
      this.render = new RenderEngine(this.canvas, this.texFactory);
      this.level = new LevelBuilder.Builder(this.render, this.texFactory).build();
      if (this.render.setRainOcclusionMap && this.level.rainOcclusionMap) this.render.setRainOcclusionMap(this.level.rainOcclusionMap);
      this.weapon = new WeaponSystem(this.render.camera, this.render.scene, this.texFactory, this.audio, this.render, this.level);
      this.enemies = new EnemyManager(this.render.scene, this.texFactory, this.audio, this.render, this.level);
      this.player = new PlayerController(this.render.camera, this.level, this.texFactory, this.audio, this.weapon);
      this.hud = new MissionHUD();
      this.hud.setVoiceEngine(this.voice);
      this.tutorial = new TutorialController(this);
      this.training = new TrainingController(this);
      this.trainingRecords = loadTrainingRecords();
      this.trainingConfig = { submode: 'timed', timedDuration: 60, stageId: 1, invulnerable: false };
      this.careerProfile = loadCareerProfile();
      this.loadoutConfig = loadLoadoutConfig();
      const unlockedSkinsInit = (this.careerProfile && this.careerProfile.unlockedSkins) || ['standard'];
      if (!unlockedSkinsInit.includes(this.loadoutConfig.skin)) {
        this.loadoutConfig.skin = 'standard';
      }
      this.toggleAds = !!this.userSettings.toggleAds;
      this.player.sensitivity = this.userSettings.sensitivity;
      this.player.invertY = !!this.userSettings.invertY;
      this.weapon._toggleAdsMode = this.toggleAds;
      this.audio.setVolume(this.userSettings.volume);
      this.audio.setVoiceVolume(this.userSettings.voiceVolume);
      this.audio.setVoiceMode(this.userSettings.voiceMode);
      if (this.sensSlider) this.sensSlider.value = String(this.userSettings.sensitivity);
      if (this.volSlider) this.volSlider.value = String(this.userSettings.volume);
      if (this.voiceVolSlider) this.voiceVolSlider.value = String(this.userSettings.voiceVolume);
      if (this.voiceLangSelect) this.voiceLangSelect.value = this.userSettings.voiceLang || 'auto';
      if (this.voiceModeSelect) this.voiceModeSelect.value = this.userSettings.voiceMode;
      if (this.optToggleAds) this.optToggleAds.checked = !!this.userSettings.toggleAds;
      if (this.optInvertY) this.optInvertY.checked = !!this.userSettings.invertY;

      this.activeC4Relays = [];
      this.scanCooldown = 0;
      this.meleeCooldown = 0;
      this.sniperWarnSpoken = false;
      this.holdout15Spoken = false;
      this._pendingAirdropDefaultId = '';
      this._pendingAirdropOptions = null;
      this._pendingAirdropWave = 0;
      this.lastTrainingResult = null;
      this._lastDebrief = null;
      this._interactPromptSpec = null;
      this._aimDirTmp = new THREE.Vector3();
      this._playerExpTmp = new THREE.Vector3();
      this._gPlantedC4ThisPress = false;

      this.missionState = {
        phase: 'CUT_RELAYS',
        severedCount: 0,
        interactPrompt: '',
        interactProgress: 0,
        lockdown: false,
        evacApproached: false,
        evacBoardingSpoken: false,
        alarmsTriggered: 0,
        stealthRelays: 0,
        barrelKills: 0,
        c4Kills: 0,
        meleeKills: 0,
        holdoutTimer: 30,
        scanCooldown: 0,
        difficulty: this.loadoutConfig.difficulty,
        realism: false,
      };

      this.render.onLightningFlash = (intensity) => {
        if (this.state === 'PLAYING' && this.audio.scheduleThunder) {
          this.audio.scheduleThunder(0.75 + Math.random() * 1.45, Math.min(1, intensity));
        }
      };

      this.player.onDamageFeedback = (sourcePos) => this.hud.triggerDamageFlash(sourcePos, this.player);
      this.player.onLowHpWarning = () => {
        if (!this.tutorial.active && !this.training.isTimedSafe() && this.state === 'PLAYING') {
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('app.radio.lowHp'),
            4.6,
            false,
            {
              voiceId: 'tac_low_hp',
              role: 'watcher',
              priority: 2,
              cooldownSec: 16,
              tacOnly: true,
              speakerKey: 'app.speaker.watcher',
              textKey: 'app.radio.lowHp',
            }
          );
        }
      };
      this.weapon.onEmptyReload = () => {
        if (!this.tutorial.active && !this.training.isTimedSafe() && this.state === 'PLAYING') {
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('app.radio.ammoEmpty'),
            3.4,
            false,
            {
              voiceId: 'tac_ammo_empty',
              role: 'watcher',
              priority: 1,
              cooldownSec: 8,
              tacOnly: true,
              speakerKey: 'app.speaker.watcher',
              textKey: 'app.radio.ammoEmpty',
            }
          );
        }
      };
      this.weapon.onLowReserve = () => {
        if (!this.tutorial.active && !this.training.isTimedSafe() && this.state === 'PLAYING') {
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('app.radio.lowReserve'),
            4.6,
            false,
            {
              voiceId: 'ammo_low_reserve',
              role: 'watcher',
              priority: 2,
              cooldownSec: 22,
              tacOnly: true,
              speakerKey: 'app.speaker.watcher',
              textKey: 'app.radio.lowReserve',
            }
          );
        }
      };
      this.weapon.onBreakerHit = (breaker) => {
        this.audio.playSwitchClick();
        const getLabel = () => I18n.field(breaker, 'label') || I18n.field(breaker, 'name') || breaker.id;
        this.hud.showRadio(
          I18n.t('app.speaker.watcher'),
          I18n.t('app.radio.breakerShot', { label: getLabel() }),
          4.0,
          false,
          {
            role: 'watcher',
            priority: 1,
            cooldownSec: 6,
            speakerKey: 'app.speaker.watcher',
            textKey: 'app.radio.breakerShot',
            getTextParams: () => ({ label: getLabel() }),
          }
        );
      };
      this.weapon.onBarrelHit = (barrel, dmg) => this._damageBarrel(barrel, dmg);
      this.level.onBarrelExplode = (barrel) => this._triggerBarrelExplosion(barrel);
      this.enemies.onKillCallback = (enemy, isCrit, silentTakedown) => {
        this.training.onEnemyKilled(enemy, isCrit);
        if (silentTakedown && !enemy.isTutorialTarget && !enemy.isTrainingTarget) {
          this.missionState.meleeKills++;
        }
        if (!enemy.isTutorialTarget && !enemy.isTrainingTarget) {
          this.hud.pushKillFeed(enemy, isCrit, silentTakedown);
        }
        if (this.training.active && this.training.submode === 'endless' && this.training.ownedPerks.includes('adrenaline_stim')) {
          this.player.heal(8);
        }
      };
      this.enemies.onAlarmTriggered = (enemy) => this._onEnemyAlarmTriggered(enemy);
      this.enemies.onReconReinforce = (pos) => this._onReconReinforce(pos);
      this.enemies.onTutorialBulletBlocked = (enemy, kind) => this.tutorial.onBulletBlocked(kind);
      this._applyGameplayDifficulty(true);
      this.weapon.resetArsenal(this.loadoutConfig.primaryWeapon, this.loadoutConfig.skin, []);
      this.enemies.spawnInitialPatrols({});

      this._renderTrainingStageGrid();
      this._syncTrainingUI();
      this._syncLoadoutUI();
      this._setDialogView('main');
      this._syncMenuButtons();
      this._bindEvents();
      const savedGfx = this._loadQualitySettings();
      this._exposeDebugHooks();
      this.dialog.showModal();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
      if (savedGfx.quality === 'extreme') {
        this._applyGraphicsPreset('high', savedGfx.drsEnabled, false);
        if (this.qualitySelect) this.qualitySelect.value = 'extreme';
        setTimeout(() => {
          this._applyGraphicsPreset('extreme', savedGfx.drsEnabled, false);
        }, 60);
      } else {
        this._applyGraphicsPreset(savedGfx.quality, savedGfx.drsEnabled, false);
      }
    }

    _showWarmupBanner(pct = 0, msg = I18n.t('warmup.bannerTitle')) {
      if (!this.warmupBanner) return;
      if (this._warmupHideTimer) {
        clearTimeout(this._warmupHideTimer);
        this._warmupHideTimer = 0;
      }
      if (this.warmupTitle && msg) this.warmupTitle.textContent = msg;
      const clamped = Math.max(0, Math.min(100, Math.round((Number(pct) || 0) * 100)));
      if (this.warmupPct) this.warmupPct.textContent = `${clamped}%`;
      if (this.warmupFill) this.warmupFill.style.width = `${clamped}%`;

      let isOpen = this.warmupBanner.classList.contains(':popover-open');
      if (!isOpen && typeof this.warmupBanner.matches === 'function') {
        try { isOpen = this.warmupBanner.matches(':popover-open'); } catch {}
      }
      if (!isOpen) {
        if (typeof this.warmupBanner.showPopover === 'function') {
          try { this.warmupBanner.showPopover(); } catch {}
        }
        this.warmupBanner.classList.add(':popover-open');
      }
    }

    _hideWarmupBanner(delayMs = 0) {
      if (this._warmupHideTimer) {
        clearTimeout(this._warmupHideTimer);
        this._warmupHideTimer = 0;
      }
      const closeNow = () => {
        this._warmupHideTimer = 0;
        if (!this.warmupBanner) return;
        if (typeof this.warmupBanner.hidePopover === 'function') {
          try { this.warmupBanner.hidePopover(); } catch {}
        }
        this.warmupBanner.classList.remove(':popover-open');
      };
      if (delayMs > 0) {
        this._warmupHideTimer = setTimeout(closeNow, delayMs);
      } else {
        closeNow();
      }
    }

    _loadQualitySettings() {
      const sanitize = (v) => (window.GameLogic && GameLogic.sanitizeQualityPreset)
        ? GameLogic.sanitizeQualityPreset(v)
        : (v || 'high');
      try {
        const raw = localStorage.getItem('storm_pier_quality_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            quality: sanitize(parsed && parsed.quality),
            drsEnabled: parsed && typeof parsed.drsEnabled === 'boolean' ? parsed.drsEnabled : true,
          };
        }
      } catch {}
      return { quality: 'high', drsEnabled: true };
    }

    async _applyGraphicsPreset(preset, drsEnabled = true, persist = true) {
      const sanitize = (v) => (window.GameLogic && GameLogic.sanitizeQualityPreset)
        ? GameLogic.sanitizeQualityPreset(v)
        : (v || 'high');
      const target = sanitize(preset);
      const token = ++this._gfxWarmupToken;

      this.render.setDrsEnabled(!!drsEnabled);
      if (this.optDrs) this.optDrs.checked = !!this.render.drsEnabled;

      const applyDetail = (enabled) => {
        if (this.level && this.level.setExtremeDetail) this.level.setExtremeDetail(enabled);
        if (this.weapon && this.weapon.setExtremeDetail) this.weapon.setExtremeDetail(enabled);
        if (this.enemies && this.enemies.setExtremeDetail) this.enemies.setExtremeDetail(enabled);
      };
      const saveGfx = (q) => {
        if (!persist) return;
        try {
          localStorage.setItem('storm_pier_quality_v1', JSON.stringify({
            quality: q,
            drsEnabled: !!this.render.drsEnabled,
          }));
        } catch {}
      };

      if (target !== 'extreme') {
        this._hideWarmupBanner(0);
        this.render.setQuality(target);
        applyDetail(false);
        if (this.qualitySelect) this.qualitySelect.value = this.render.quality;
        saveGfx(this.render.quality);
        return;
      }

      // 若极限画质管线已完成预热，直接毫秒级激活
      if (this.render._extremePrepared) {
        this._hideWarmupBanner(0);
        applyDetail(true);
        this.render.setQuality('extreme');
        if (this.qualitySelect) this.qualitySelect.value = this.render.quality;
        saveGfx(this.render.quality);
        return;
      }

      // 异步分帧烘焙 PBR 纹理与 compileAsync Shader 预编译，不阻塞主线程与 UI
      if (this.qualitySelect) this.qualitySelect.value = 'extreme';
      this._showWarmupBanner(0.02, I18n.t('warmup.bannerTitle'));
      const extraShadowLights = this.weapon && this.weapon.flashlight ? [this.weapon.flashlight] : [];
      let prepared = false;
      try {
        prepared = await this.render.prepareExtremeAsync({
          onProgress: (pct, msg) => {
            if (token !== this._gfxWarmupToken) return;
            this._showWarmupBanner(pct, msg || I18n.t('warmup.bannerTitle'));
          },
          isCancelled: () => token !== this._gfxWarmupToken,
          onPrepareDetail: (enabled) => applyDetail(enabled),
          extraShadowLights,
        });
      } catch (err) {
        prepared = false;
      }

      if (token !== this._gfxWarmupToken) {
        return;
      }

      if (!prepared) {
        this._showWarmupBanner(1.0, I18n.t('app.warmupFallbackHigh'));
        this._hideWarmupBanner(2400);
        this.render.setQuality('high');
        applyDetail(false);
        if (this.qualitySelect) this.qualitySelect.value = this.render.quality;
        saveGfx(this.render.quality);
        return;
      }

      this.render.setQuality('extreme');
      applyDetail(true);
      if (this.qualitySelect) this.qualitySelect.value = this.render.quality;
      saveGfx(this.render.quality);
      this._showWarmupBanner(1.0, I18n.t('app.warmupDone'));
      this._hideWarmupBanner(1300);
    }

    _formatDuration(sec, withTenths = false) {
      const safe = Math.max(0, Number(sec) || 0);
      const mins = Math.floor(safe / 60);
      if (withTenths) {
        const rem = (safe % 60).toFixed(1).padStart(4, '0');
        return `${mins}:${rem}`;
      }
      const secs = Math.floor(safe % 60).toString().padStart(2, '0');
      return `${mins}:${secs}`;
    }

    _getEffectiveDiffConfig(forceStandard = false) {
      const id = forceStandard ? 'standard' : this.loadoutConfig.difficulty;
      return GameLogic.getDifficultyConfig(id);
    }

    _applyGameplayDifficulty(forceStandard = false) {
      const diffCfg = this._getEffectiveDiffConfig(forceStandard);
      this.player.setDifficultyConfig(diffCfg);
      this.weapon.setDifficultyModifiers(diffCfg);
      this.enemies.setDifficultyStealthMult(diffCfg.stealthDetectMult);
      return diffCfg;
    }

    _buildEnemyDiffOpts(diffCfg, extra = {}) {
      const cfg = diffCfg || this._getEffectiveDiffConfig(false);
      return {
        ...extra,
        hpScale: (extra.hpScale != null ? extra.hpScale : 1.0) * cfg.enemyHpMult,
        dmgScale: (extra.dmgScale != null ? extra.dmgScale : 1.0) * cfg.enemyDmgMult,
        speedScale: (extra.speedScale != null ? extra.speedScale : 1.0) * cfg.enemySpeedScale,
        cooldownScale: (extra.cooldownScale != null ? extra.cooldownScale : 1.0) * cfg.enemyCooldownScale,
        boltSpeedScale: cfg.enemyBoltSpeedScale,
        jitterScale: cfg.enemyJitterScale,
        callInScale: cfg.callInTimerScale,
      };
    }

    _syncLoadoutUI() {
      const unlocked = (this.careerProfile && this.careerProfile.unlockedSkins) || ['standard'];
      if (!unlocked.includes(this.loadoutConfig.skin)) {
        this.loadoutConfig.skin = 'standard';
      }
      if (this.careerBestStrip) {
        const p = this.careerProfile || GameLogic.createDefaultCareerProfile();
        this.careerBestStrip.hidden = this.state === 'PAUSED';
        if (p.clears > 0) {
          const timeTxt = p.bestTimeSec !== null
            ? I18n.t('app.careerBestTime', { time: this._formatDuration(p.bestTimeSec, true) })
            : '';
          this.careerBestStrip.innerHTML = I18n.t('app.careerClearedHtml', {
            grade: p.bestGrade || '-',
            score: p.bestScore,
            clears: p.clears,
            timeTxt,
            skins: unlocked.length,
          });
        } else {
          this.careerBestStrip.innerHTML = I18n.t('app.careerEmptyHtml');
        }
      }
      for (const r of this.loadoutWeaponRadios) {
        r.checked = r.value === this.loadoutConfig.primaryWeapon;
      }
      for (const r of this.loadoutSkinRadios) {
        const canUse = unlocked.includes(r.value);
        r.disabled = !canUse;
        r.checked = r.value === this.loadoutConfig.skin;
        const metaEl = document.getElementById(`skin-meta-${r.value}`);
        if (metaEl) {
          if (canUse && r.value !== 'standard') {
            metaEl.textContent = I18n.t('app.skinUnlocked');
          } else if (r.value === 'night_ops') {
            metaEl.textContent = I18n.t('skin.night_ops.meta');
          } else if (r.value === 'hazmat_blue') {
            metaEl.textContent = I18n.t('skin.hazmat_blue.meta');
          }
        }
      }
      for (const r of this.loadoutDiffRadios) {
        r.checked = r.value === this.loadoutConfig.difficulty;
      }
      for (const c of this.loadoutMutatorChecks) {
        c.checked = this.loadoutConfig.mutators.includes(c.value);
      }
      const diffCfg = this._getEffectiveDiffConfig(false);
      if (this.diffSummaryEl && diffCfg) {
        this.diffSummaryEl.innerHTML = I18n.t('app.diffSummaryHtml', {
          name: I18n.field(diffCfg, 'name'),
          summary: I18n.field(diffCfg, 'summary'),
          mult: diffCfg.scoreMult.toFixed(2),
        });
      }
      if (this.disclosureLoadoutSummary) {
        const wCfg = GameLogic.WEAPON_CATALOG && GameLogic.WEAPON_CATALOG[this.loadoutConfig.primaryWeapon];
        const sCfg = GameLogic.GUN_SKINS && GameLogic.GUN_SKINS[this.loadoutConfig.skin];
        const mutCnt = (this.loadoutConfig.mutators || []).length;
        const mutTxt = mutCnt === 1
          ? I18n.t('app.loadoutMutatorOne')
          : mutCnt > 1
            ? I18n.t('app.loadoutMutatorMany', { count: mutCnt })
            : '';
        this.disclosureLoadoutSummary.textContent = I18n.t('app.loadoutSummary', {
          weapon: (wCfg && I18n.field(wCfg, 'shortName')) || this.loadoutConfig.primaryWeapon,
          skin: (sCfg && I18n.field(sCfg, 'name')) || I18n.t('skin.standard.title'),
          mutTxt,
        });
      }
    }

    _renderAirdropOptions(options, waveNum) {
      if (!this.airdropOptions) return;
      this.airdropOptions.innerHTML = '';
      for (const opt of (options || [])) {
        const btn = document.createElement('button');
        btn.type = 'submit';
        btn.className = 'airdrop-card-btn';
        btn.value = opt.id;
        const titleEl = document.createElement('strong');
        titleEl.textContent = I18n.t('train.airdropOptionTitle', {
          name: I18n.field(opt, 'name'),
          wave: waveNum,
        });
        const descEl = document.createElement('span');
        descEl.textContent = I18n.field(opt, 'desc');
        btn.appendChild(titleEl);
        btn.appendChild(descEl);
        this.airdropOptions.appendChild(btn);
      }
    }

    _openEndlessAirdropModal(options, waveNum) {
      if (!this.airdropDialog || !this.airdropOptions) {
        if (options && options[0]) this.training.applyEndlessAirdrop(options[0].id);
        return;
      }
      this.state = 'PAUSED';
      this.weapon.setFiring(false);
      this.weapon.cancelThrowPreview();
      this.weapon.isADS = false;
      this.player.keys = Object.create(null);
      this.audio.setPaused(true);
      this.voice.setPaused(true);
      if (document.pointerLockElement === this.canvas) {
        document.exitPointerLock();
      }
      this._pendingAirdropDefaultId = (options && options[0] && options[0].id) || '';
      this._pendingAirdropOptions = options || [];
      this._pendingAirdropWave = waveNum;
      this._renderAirdropOptions(this._pendingAirdropOptions, waveNum);
      this.airdropDialog.returnValue = '';
      if (!this.airdropDialog.open) this.airdropDialog.showModal();
    }

    _renderTrainingStageGrid() {
      if (!this.trainStageGrid) return;
      this.trainStageGrid.innerHTML = '';
      for (const stage of GameLogic.TRAINING_STAGES) {
        const rec = (this.trainingRecords.stages && this.trainingRecords.stages[String(stage.id)]) || {};
        let metaText = I18n.t('train.stageNotCleared');
        if (rec.bestTime !== null && rec.bestTime !== undefined) {
          metaText = I18n.t('train.stageBestOfficial', { time: this._formatDuration(rec.bestTime, true) });
        } else if (rec.practiceCleared) {
          metaText = I18n.t('train.stagePracticeCleared');
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stage-card';
        btn.dataset.stageId = String(stage.id);
        btn.setAttribute('aria-pressed', String(this.trainingConfig.stageId === stage.id));
        const titleEl = document.createElement('span');
        titleEl.className = 'stage-card-title';
        titleEl.textContent = I18n.t('train.stageCardTitle', {
          id: stage.id,
          name: I18n.field(stage, 'shortName'),
        });
        const metaEl = document.createElement('span');
        metaEl.className = 'stage-card-meta';
        metaEl.textContent = metaText;
        btn.appendChild(titleEl);
        btn.appendChild(metaEl);
        this.trainStageGrid.appendChild(btn);
      }
    }

    _syncTrainingUI() {
      const sub = this.trainingConfig.submode || 'timed';
      for (const tab of this.trainTabs) {
        const active = tab.dataset.submode === sub;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        if (active && this.trainTabPanel) {
          this.trainTabPanel.setAttribute('aria-labelledby', tab.id);
        }
      }
      if (this.trainPanes.timed) this.trainPanes.timed.hidden = sub !== 'timed';
      if (this.trainPanes.endless) this.trainPanes.endless.hidden = sub !== 'endless';
      if (this.trainPanes.stage) this.trainPanes.stage.hidden = sub !== 'stage';

      for (const pill of this.trainPills) {
        const active = Number(pill.dataset.duration) === Number(this.trainingConfig.timedDuration);
        pill.setAttribute('aria-pressed', active ? 'true' : 'false');
      }

      this._renderTrainingStageGrid();
      if (this.optTrainInvuln) {
        this.optTrainInvuln.checked = !!this.trainingConfig.invulnerable;
      }

      if (this.trainBestStrip) {
        const rec = this.trainingRecords;
        if (sub === 'timed') {
          const dur = String(this.trainingConfig.timedDuration || 60);
          const slot = (rec.timed && rec.timed[dur]) || { bestScore: 0, bestKills: 0 };
          this.trainBestStrip.innerHTML = I18n.t('train.best.timedHtml', {
            dur,
            score: slot.bestScore,
            kills: slot.bestKills,
          });
        } else if (sub === 'endless') {
          const e = rec.endless || { bestWave: 0, bestKills: 0, bestTime: 0 };
          const waveTxt = e.bestWave > 0
            ? I18n.t('train.best.waveNum', { wave: e.bestWave })
            : I18n.t('train.best.noWave');
          this.trainBestStrip.innerHTML = I18n.t('train.best.endlessHtml', {
            waveTxt,
            kills: e.bestKills,
            time: this._formatDuration(e.bestTime),
          });
        } else {
          const sid = String(this.trainingConfig.stageId || 1);
          const s = (rec.stages && rec.stages[sid]) || { cleared: false, practiceCleared: false, bestTime: null };
          let txt = I18n.t('train.stageNotCleared');
          if (s.bestTime !== null && s.bestTime !== undefined) {
            txt = I18n.t('train.best.stageFastest', { time: this._formatDuration(s.bestTime, true) });
          } else if (s.practiceCleared) {
            txt = I18n.t('train.best.stagePracticeOnly');
          }
          this.trainBestStrip.innerHTML = I18n.t('train.best.stageHtml', { id: sid, txt });
        }
      }

      if (this.btnTrainStart) {
        this.btnTrainStart.textContent = sub === 'timed'
          ? I18n.t('train.startTimed')
          : sub === 'endless'
            ? I18n.t('train.startEndless')
            : I18n.t('train.startStage', { id: this.trainingConfig.stageId });
      }
    }

    _applyPauseDialogCopy() {
      if (this.tutorial.active) {
        this.dlgTitle.textContent = I18n.t('app.pause.tutTitle');
        this.dlgDesc.textContent = I18n.t('app.pause.tutDesc');
      } else if (this.activeMode === 'training' && this.training.active) {
        const sub = this.training.submode;
        this.dlgTitle.textContent = sub === 'timed'
          ? I18n.t('app.pause.trainTimedTitle')
          : sub === 'endless'
            ? I18n.t('app.pause.trainEndlessTitle')
            : I18n.t('app.pause.trainStageTitle', { id: this.training.stageId });
        this.dlgDesc.textContent = I18n.t('app.pause.trainDesc');
      } else {
        this.dlgTitle.textContent = I18n.t('app.pause.combatTitle');
        this.dlgDesc.textContent = I18n.t('app.pause.combatDesc');
      }
    }

    _setDialogView(view) {
      this.dialogView = view === 'training' ? 'training' : 'main';
      const isTrain = this.dialogView === 'training';
      if (this.menuViewMain) this.menuViewMain.hidden = isTrain;
      if (this.menuViewTraining) this.menuViewTraining.hidden = !isTrain;

      if (isTrain) {
        this.dlgTitle.textContent = I18n.t('app.trainCenter.title');
        this.dlgDesc.textContent = I18n.t('app.trainCenter.desc');
        this.dlgStats.hidden = true;
        this._syncTrainingUI();
      } else if (this.state === 'MENU') {
        this.dlgTitle.textContent = I18n.t('app.title');
        this.dlgDesc.textContent = I18n.t('menu.desc');
        this.dlgStats.hidden = true;
      } else if (this.state === 'PAUSED') {
        this._applyPauseDialogCopy();
        this.dlgStats.hidden = true;
      } else if ((this.state === 'VICTORY' || this.state === 'DEFEAT') && this._lastDebrief) {
        const copy = this._renderDebriefCopy(this._lastDebrief);
        this.dlgTitle.textContent = copy.title;
        this.dlgDesc.textContent = copy.desc;
        this.dlgStats.innerHTML = copy.statsHtml;
        this.dlgStats.hidden = false;
      }
    }

    _syncMenuButtons() {
      const done = isTutorialDone();
      const inTraining = this.activeMode === 'training' && this.training.active;
      const isPaused = this.state === 'PAUSED';
      if (this.ctrlBrief) this.ctrlBrief.hidden = false;
      if (this.optGroup) this.optGroup.hidden = false;
      if (this.difficultyPanel) this.difficultyPanel.hidden = isPaused;
      if (this.disclosureLoadout) {
        this.disclosureLoadout.hidden = isPaused;
        if (isPaused) this.disclosureLoadout.open = false;
      }
      if (this.loadoutPanel) this.loadoutPanel.hidden = isPaused;
      if (this.disclosureSettings) {
        this.disclosureSettings.hidden = false;
        if (isPaused) this.disclosureSettings.open = true;
      }
      this._syncLoadoutUI();

      if (this.state === 'MENU') {
        if (done) {
          this.btnStart.textContent = I18n.t('app.btn.deployLock');
          this.btnStart.dataset.mode = 'combat';
          this.btnStart.dataset.action = 'combat';
          this.btnSecondary.textContent = I18n.t('app.btn.replayTutorial');
          this.btnSecondary.dataset.action = 'tutorial';
          this.btnSecondary.hidden = false;
        } else {
          this.btnStart.textContent = I18n.t('btn.startTutorial');
          this.btnStart.dataset.mode = 'tutorial';
          this.btnStart.dataset.action = 'tutorial';
          this.btnSecondary.textContent = I18n.t('btn.deployDirect');
          this.btnSecondary.dataset.action = 'combat';
          this.btnSecondary.hidden = false;
        }
        if (this.btnOpenTraining) {
          this.btnOpenTraining.textContent = I18n.t('btn.openTraining');
          this.btnOpenTraining.hidden = false;
        }
        if (this.btnReturnMain) this.btnReturnMain.hidden = true;
      } else if (this.state === 'PAUSED') {
        if (this.tutorial.active) {
          this.btnStart.textContent = I18n.t('app.btn.resumeTutorial');
          this.btnStart.dataset.mode = 'tutorial';
          this.btnStart.dataset.action = 'resume';
          this.btnSecondary.textContent = I18n.t('app.btn.skipTutorial');
          this.btnSecondary.dataset.action = 'skip-tutorial';
          this.btnSecondary.hidden = false;
          if (this.btnOpenTraining) {
            this.btnOpenTraining.textContent = I18n.t('app.btn.openTrainingCenter');
            this.btnOpenTraining.hidden = false;
          }
          if (this.btnReturnMain) this.btnReturnMain.hidden = false;
        } else if (inTraining) {
          this.btnStart.textContent = I18n.t('app.btn.resumeTraining');
          this.btnStart.dataset.mode = 'training';
          this.btnStart.dataset.action = 'resume';
          this.btnSecondary.textContent = I18n.t('app.btn.restartTraining');
          this.btnSecondary.dataset.action = 'restart-training';
          this.btnSecondary.hidden = false;
          if (this.btnOpenTraining) {
            this.btnOpenTraining.textContent = I18n.t('app.btn.switchTrainMode');
            this.btnOpenTraining.hidden = false;
          }
          if (this.btnReturnMain) this.btnReturnMain.hidden = false;
        } else {
          this.btnStart.textContent = I18n.t('app.btn.resumeCombat');
          this.btnStart.dataset.mode = 'combat';
          this.btnStart.dataset.action = 'resume';
          this.btnSecondary.textContent = I18n.t('app.btn.restartCombat');
          this.btnSecondary.dataset.action = 'restart-combat';
          this.btnSecondary.hidden = false;
          if (this.btnOpenTraining) {
            this.btnOpenTraining.textContent = I18n.t('app.btn.openTrainingCenter');
            this.btnOpenTraining.hidden = false;
          }
          if (this.btnReturnMain) this.btnReturnMain.hidden = false;
        }
      } else if (this.activeMode === 'training' && this.lastTrainingResult) {
        const res = this.lastTrainingResult;
        const canNext = res.submode === 'stage' && res.cleared && Number(res.stageId) < 6;
        if (canNext) {
          this.btnStart.textContent = I18n.t('app.btn.nextStage', { id: Number(res.stageId) + 1 });
          this.btnStart.dataset.mode = 'training';
          this.btnStart.dataset.action = 'next-stage';
          this.btnSecondary.textContent = I18n.t('app.btn.retryStage');
          this.btnSecondary.dataset.action = 'restart-training';
          this.btnSecondary.hidden = false;
        } else {
          this.btnStart.textContent = I18n.t('app.btn.playAgainTraining');
          this.btnStart.dataset.mode = 'training';
          this.btnStart.dataset.action = 'restart-training';
          this.btnSecondary.textContent = I18n.t('btn.returnMain');
          this.btnSecondary.dataset.action = 'return-main';
          this.btnSecondary.hidden = false;
        }
        if (this.btnOpenTraining) {
          this.btnOpenTraining.textContent = I18n.t('app.btn.switchTrainMode');
          this.btnOpenTraining.hidden = false;
        }
        if (this.btnReturnMain) this.btnReturnMain.hidden = !canNext;
      } else {
        this.btnStart.textContent = I18n.t('app.btn.redeployCombat');
        this.btnStart.dataset.mode = 'combat';
        this.btnStart.dataset.action = 'combat';
        this.btnSecondary.textContent = I18n.t('app.btn.replayTutorial');
        this.btnSecondary.dataset.action = 'tutorial';
        this.btnSecondary.hidden = false;
        if (this.btnOpenTraining) {
          this.btnOpenTraining.textContent = I18n.t('app.btn.openTrainingCenter');
          this.btnOpenTraining.hidden = false;
        }
        if (this.btnReturnMain) this.btnReturnMain.hidden = false;
      }
    }

    _applyLanguage(lang, persist = true) {
      const nextLang = I18n.setLang(lang, persist);
      if (!this.userSettings.voiceLang || this.userSettings.voiceLang === 'auto') {
        this.voice.setVoiceLang(I18n.resolveVoiceLang('auto'));
      }
      this.hud._buildCompassLabels();
      this.hud.invalidateCache(nextLang);
      this.hud.refreshRadioLanguage();
      if (this._interactPromptSpec && this.missionState && this.missionState.interactPrompt) {
        const spec = this._interactPromptSpec;
        const params = typeof spec.paramsOrFn === 'function' ? spec.paramsOrFn() : spec.paramsOrFn;
        this.missionState.interactPrompt = I18n.t(spec.key, params);
      }
      this._syncLoadoutUI();
      this._syncTrainingUI();
      this._setDialogView(this.dialogView);
      this._syncMenuButtons();
      if (this.airdropDialog && this.airdropDialog.open && this._pendingAirdropOptions) {
        this._renderAirdropOptions(this._pendingAirdropOptions, this._pendingAirdropWave);
      }
      if (this.state === 'PAUSED' || this.state === 'PLAYING') {
        this.hud.update(
          0,
          this.render.camera,
          this.player,
          this.weapon,
          this.level,
          this.enemies,
          this.missionState,
          this.fpsSmooth,
          this.tutorial,
          this.training
        );
      }
      return nextLang;
    }

    _handleMenuAction(action) {
      this.audio.init();
      this.voice.prewarm([
        'tut_1', 'tut_2', 'mission_start', 'mission_skip',
        'train_timed_start', 'train_endless_start', 'train_stage_1',
        'relay_stealth_clean', 'relay_c4_loud', 'evac_holdout_start',
      ]);
      if (action === 'open-training') {
        this._setDialogView('training');
        return;
      }
      if (action === 'return-main') {
        this._returnToMainMenu();
        return;
      }
      if (action === 'tutorial') {
        this._setDialogView('main');
        this._startTutorial();
        this._enterPlay();
      } else if (action === 'combat') {
        this._setDialogView('main');
        this._startCombatMission();
        this._enterPlay();
      } else if (action === 'restart-combat') {
        this._setDialogView('main');
        this._restartMission();
        this._enterPlay();
      } else if (action === 'skip-tutorial') {
        markTutorialDone();
        this._setDialogView('main');
        this._startCombatMission(I18n.t('app.radio.missionSkipMenu'), 'mission_skip', 'app.radio.missionSkipMenu');
        this._enterPlay();
      } else if (action === 'start-training' || action === 'restart-training') {
        this._setDialogView('main');
        this._startTraining(this.trainingConfig.submode, this.trainingConfig);
        this._enterPlay();
      } else if (action === 'next-stage') {
        const nextId = Math.min(6, (Number(this.trainingConfig.stageId) || 1) + 1);
        this.trainingConfig.submode = 'stage';
        this.trainingConfig.stageId = nextId;
        this._syncTrainingUI();
        this._setDialogView('main');
        this._startTraining('stage', this.trainingConfig);
        this._enterPlay();
      } else {
        this._enterPlay();
      }
    }

    _bindEvents() {
      window.addEventListener('resize', () => this.render.resize());

      const syncSlider = (el, out, fmt) => {
        el.style.setProperty('--attr-min', el.min || 0);
        el.style.setProperty('--attr-max', el.max || 100);
        el.style.setProperty('--control-value', el.value);
        out.textContent = fmt(el.value);
        el.setAttribute('aria-valuetext', out.textContent);
      };

      syncSlider(this.sensSlider, this.sensOut, (v) => `${Number(v).toFixed(1)}x`);
      syncSlider(this.volSlider, this.volOut, (v) => `${Math.round(Number(v) * 100)}%`);
      if (this.voiceVolSlider && this.voiceVolOut) {
        syncSlider(this.voiceVolSlider, this.voiceVolOut, (v) => `${Math.round(Number(v) * 100)}%`);
        this.audio.setVoiceVolume(parseFloat(this.voiceVolSlider.value));
        this.voiceVolSlider.addEventListener('input', () => {
          syncSlider(this.voiceVolSlider, this.voiceVolOut, (v) => `${Math.round(Number(v) * 100)}%`);
          const val = parseFloat(this.voiceVolSlider.value);
          this.audio.setVoiceVolume(val);
          this.userSettings.voiceVolume = val;
          saveUserSettings(this.userSettings);
        });
      }
      if (this.voiceLangSelect) {
        this.voiceLangSelect.value = this.userSettings.voiceLang || 'auto';
        this.voiceLangSelect.addEventListener('change', () => {
          const val = ['auto', 'zh', 'en'].includes(this.voiceLangSelect.value) ? this.voiceLangSelect.value : 'auto';
          this.userSettings.voiceLang = val;
          saveUserSettings(this.userSettings);
          this.voice.setVoiceLang(I18n.resolveVoiceLang(val));
        });
      }
      if (this.voiceModeSelect) {
        this.audio.setVoiceMode(this.voiceModeSelect.value);
        this.voiceModeSelect.addEventListener('change', () => {
          this.audio.setVoiceMode(this.voiceModeSelect.value);
          this.userSettings.voiceMode = this.voiceModeSelect.value;
          saveUserSettings(this.userSettings);
        });
      }
      for (const btn of this.langButtons) {
        btn.addEventListener('click', () => {
          const lang = btn.dataset.lang;
          if (lang) this._applyLanguage(lang, true);
        });
      }

      this.sensSlider.addEventListener('input', () => {
        syncSlider(this.sensSlider, this.sensOut, (v) => `${Number(v).toFixed(1)}x`);
        const val = parseFloat(this.sensSlider.value);
        this.player.sensitivity = val;
        this.userSettings.sensitivity = val;
        saveUserSettings(this.userSettings);
      });

      this.volSlider.addEventListener('input', () => {
        syncSlider(this.volSlider, this.volOut, (v) => `${Math.round(Number(v) * 100)}%`);
        const val = parseFloat(this.volSlider.value);
        this.audio.setVolume(val);
        this.userSettings.volume = val;
        saveUserSettings(this.userSettings);
      });

      if (this.optToggleAds) {
        this.optToggleAds.addEventListener('change', () => {
          this.toggleAds = !!this.optToggleAds.checked;
          this.weapon._toggleAdsMode = this.toggleAds;
          this.userSettings.toggleAds = this.toggleAds;
          saveUserSettings(this.userSettings);
        });
      }
      if (this.optInvertY) {
        this.optInvertY.addEventListener('change', () => {
          this.player.invertY = !!this.optInvertY.checked;
          this.userSettings.invertY = this.player.invertY;
          saveUserSettings(this.userSettings);
        });
      }

      this.qualitySelect.addEventListener('change', () => {
        this._applyGraphicsPreset(this.qualitySelect.value, this.optDrs ? this.optDrs.checked : true, true);
      });
      if (this.optDrs) {
        this.optDrs.addEventListener('change', () => {
          this._applyGraphicsPreset(this.qualitySelect.value, this.optDrs.checked, true);
        });
      }

      this.btnStart.addEventListener('click', () => {
        this._handleMenuAction(this.btnStart.dataset.action || 'combat');
      });

      this.btnSecondary.addEventListener('click', () => {
        this._handleMenuAction(this.btnSecondary.dataset.action || 'combat');
      });

      if (this.btnOpenTraining) {
        this.btnOpenTraining.addEventListener('click', () => {
          this._handleMenuAction('open-training');
          const activeTab = this.trainTabs.find((t) => t.getAttribute('aria-selected') === 'true');
          if (activeTab) activeTab.focus();
        });
      }

      if (this.btnReturnMain) {
        this.btnReturnMain.addEventListener('click', () => {
          this._handleMenuAction('return-main');
        });
      }

      if (this.btnTrainBack) {
        this.btnTrainBack.addEventListener('click', () => {
          this._setDialogView('main');
        });
      }

      if (this.btnTrainStart) {
        this.btnTrainStart.addEventListener('click', () => {
          this._handleMenuAction('start-training');
        });
      }

      for (let i = 0; i < this.trainTabs.length; i++) {
        const tab = this.trainTabs[i];
        tab.addEventListener('click', () => {
          this.trainingConfig.submode = tab.dataset.submode || 'timed';
          this._syncTrainingUI();
        });
        tab.addEventListener('keydown', (e) => {
          let nextIdx = -1;
          if (e.code === 'ArrowRight') nextIdx = (i + 1) % this.trainTabs.length;
          else if (e.code === 'ArrowLeft') nextIdx = (i - 1 + this.trainTabs.length) % this.trainTabs.length;
          else if (e.code === 'Home') nextIdx = 0;
          else if (e.code === 'End') nextIdx = this.trainTabs.length - 1;
          if (nextIdx >= 0) {
            e.preventDefault();
            const targetTab = this.trainTabs[nextIdx];
            this.trainingConfig.submode = targetTab.dataset.submode || 'timed';
            this._syncTrainingUI();
            targetTab.focus();
          }
        });
      }

      for (const pill of this.trainPills) {
        pill.addEventListener('click', () => {
          this.trainingConfig.timedDuration = Number(pill.dataset.duration) || 60;
          this._syncTrainingUI();
        });
      }

      if (this.trainStageGrid) {
        this.trainStageGrid.addEventListener('click', (e) => {
          const card = e.target.closest('.stage-card');
          if (!card) return;
          this.trainingConfig.stageId = Number(card.dataset.stageId) || 1;
          this._syncTrainingUI();
        });
      }

      if (this.optTrainInvuln) {
        this.optTrainInvuln.addEventListener('change', () => {
          this.trainingConfig.invulnerable = !!this.optTrainInvuln.checked;
        });
      }

      for (const r of this.loadoutWeaponRadios) {
        r.addEventListener('change', () => {
          if (!r.checked) return;
          this.loadoutConfig.primaryWeapon = r.value;
          saveLoadoutConfig(this.loadoutConfig);
          this._syncLoadoutUI();
          if (this.state === 'MENU' || this.state === 'VICTORY' || this.state === 'DEFEAT') {
            this._applyGameplayDifficulty(true);
            this.weapon.resetArsenal(this.loadoutConfig.primaryWeapon, this.loadoutConfig.skin, []);
          }
        });
      }
      for (const r of this.loadoutSkinRadios) {
        r.addEventListener('change', () => {
          if (!r.checked || r.disabled) return;
          this.loadoutConfig.skin = r.value;
          saveLoadoutConfig(this.loadoutConfig);
          this._syncLoadoutUI();
          this.weapon.setSkin(this.loadoutConfig.skin);
        });
      }
      for (const r of this.loadoutDiffRadios) {
        r.addEventListener('change', () => {
          if (!r.checked) return;
          this.loadoutConfig.difficulty = r.value;
          saveLoadoutConfig(this.loadoutConfig);
          this._syncLoadoutUI();
        });
      }
      for (const c of this.loadoutMutatorChecks) {
        c.addEventListener('change', () => {
          this.loadoutConfig.mutators = this.loadoutMutatorChecks.filter((x) => x.checked).map((x) => x.value);
          saveLoadoutConfig(this.loadoutConfig);
          this._syncLoadoutUI();
        });
      }

      if (this.airdropDialog) {
        this.airdropDialog.addEventListener('close', () => {
          const picked = this.airdropDialog.returnValue || this._pendingAirdropDefaultId;
          this.airdropDialog.returnValue = '';
          this._pendingAirdropDefaultId = '';
          this._pendingAirdropOptions = null;
          this._pendingAirdropWave = 0;
          if (this.training.active && this.training.submode === 'endless') {
            this.training.applyEndlessAirdrop(picked);
            this._enterPlay();
          }
        });
      }

      this.dialog.addEventListener('cancel', (e) => {
        if (this.dialogView === 'training') {
          e.preventDefault();
          this._setDialogView('main');
          return;
        }
        if (this.state === 'MENU' || this.state === 'VICTORY' || this.state === 'DEFEAT') {
          e.preventDefault();
        }
      });

      this.dialog.addEventListener('close', () => {
        if (this.state === 'PAUSED') {
          this._enterPlay();
        }
      });

      document.addEventListener('pointerlockchange', () => {
        const locked = document.pointerLockElement === this.canvas;
        if (!locked && this.state === 'PLAYING') {
          this._pauseGame();
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.state === 'PLAYING') {
          this._pauseGame();
        }
      });

      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyC' && !e.repeat && this.state === 'PLAYING' && (this.player.keys['ShiftLeft'] || this.player.keys['ShiftRight'])) {
          this.player.triggerSlide();
        }
        this.player.keys[e.code] = true;
        if (this.state !== 'PLAYING' || e.repeat) return;
        if (e.code === 'Tab' && this.tutorial.active) {
          e.preventDefault();
          this.skipTutorial();
          return;
        }
        if (e.code === 'KeyR') this.weapon.startReload();
        if (e.code === 'KeyF') {
          this.weapon.toggleFlashlight();
          this.tutorial.onFlashlightToggle();
        }
        if (e.code === 'Digit1') {
          if (this.weapon.switchWeapon('primary')) this.tutorial.onWeaponSwitched();
        }
        if (e.code === 'Digit2') {
          if (this.weapon.switchWeapon('secondary')) this.tutorial.onWeaponSwitched();
        }
        if (e.code === 'Digit4') {
          this.weapon.cycleThrowable();
          this.tutorial.onThrowableCycled();
        }
        if (e.code === 'KeyT') {
          this.weapon.toggleSuppressor();
          this.tutorial.onSuppressorToggled();
        }
        if (e.code === 'KeyQ') this._triggerTacticalScan();
        if (e.code === 'KeyV') this._performTacticalMelee();
        if (e.code === 'KeyG') this._handleTacticalGKeyDown();
      });

      window.addEventListener('keyup', (e) => {
        this.player.keys[e.code] = false;
        if (e.code === 'KeyE') {
          this.audio.stopRelayCutLoop();
        }
        if (e.code === 'KeyG') {
          if (this._gPlantedC4ThisPress) {
            this._gPlantedC4ThisPress = false;
          } else if (this.state === 'PLAYING' && this.weapon.isPreviewingThrow) {
            this.render.camera.getWorldDirection(this._aimDirTmp);
            const thrownId = this.weapon.commitThrowPreview(
              this.render.camera.position,
              this._aimDirTmp,
              this.loadoutConfig.mutators
            );
            if (thrownId) this.tutorial.onGadgetThrown(thrownId);
          } else {
            this.weapon.cancelThrowPreview();
          }
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (this.state !== 'PLAYING') return;
        if (document.pointerLockElement === this.canvas) {
          this.player.onMouseMove(e.movementX, e.movementY);
        }
      });

      window.addEventListener('wheel', (e) => {
        if (this.state !== 'PLAYING') return;
        if (document.pointerLockElement !== this.canvas) return;
        if (Math.abs(e.deltaY) < 4) return;
        const targetSlot = this.weapon.activeSlot === 'primary' ? 'secondary' : 'primary';
        if (this.weapon.switchWeapon(targetSlot)) {
          this.tutorial.onWeaponSwitched();
        }
      }, { passive: true });

      this.canvas.addEventListener('mousedown', (e) => {
        if (this.state !== 'PLAYING') return;
        if (document.pointerLockElement !== this.canvas) {
          this._requestLock();
        }
        if (e.button === 0) this.weapon.setFiring(true);
        if (e.button === 2) {
          if (this.weapon.isPreviewingThrow) {
            this.weapon.cancelThrowPreview();
            this.audio.playSwitchClick();
          } else if (this.toggleAds) {
            this.weapon.isADS = !this.weapon.isADS;
          } else {
            this.weapon.isADS = true;
          }
        }
      });

      window.addEventListener('mouseup', (e) => {
        if (e.button === 0) this.weapon.setFiring(false);
        if (e.button === 2 && !this.toggleAds) this.weapon.isADS = false;
      });

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _requestLock() {
      try {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (err) {}
    }

    _enterPlay() {
      this.state = 'PLAYING';
      this._setDialogView('main');
      if (this.dialog.open) this.dialog.close();
      this.audio.setPaused(false);
      this.voice.setPaused(false);
      this._requestLock();
      this.lastFrameTime = performance.now();
    }

    _pauseGame() {
      if (this.state !== 'PLAYING') return;
      this.state = 'PAUSED';
      this._gPlantedC4ThisPress = false;
      this.weapon.setFiring(false);
      this.weapon.cancelThrowPreview();
      this.weapon.isADS = false;
      this.player.keys = Object.create(null);
      if (this.audio.clearScheduledThunder) this.audio.clearScheduledThunder();
      this.audio.setPaused(true);
      this.voice.setPaused(true);

      this.dlgStats.hidden = true;
      this._setDialogView('main');
      this._syncMenuButtons();
      if (!this.dialog.open) this.dialog.showModal();
    }

    _renderDebriefCopy(debrief) {
      if (!debrief) return { title: '', desc: '', statsHtml: '' };
      if (debrief.kind === 'mission') {
        const {
          victory,
          rating,
          diffId,
          elapsedTime,
          alarmsTriggered,
          killedCount,
          meleeKills,
          barrelKills,
          acc,
          crits,
        } = debrief;
        const mins = Math.floor(elapsedTime / 60);
        const secs = Math.floor(elapsedTime % 60).toString().padStart(2, '0');
        const medalCatalog = GameLogic.MEDAL_CATALOG || {};
        const medalNames = Array.isArray(rating.medalIds) && rating.medalIds.length > 0
          ? rating.medalIds.map((id) => (medalCatalog[id] ? I18n.field(medalCatalog[id], 'name') : id))
          : (rating.medals || []);
        const medalHtml = victory && medalNames.length > 0
          ? `<div class="medal-row">${medalNames.map((m) => `<span class="medal-pill">★ ${m}</span>`).join('')}</div>`
          : '';
        const scoreHtml = victory
          ? `<span class="rank-badge">${rating.grade}</span> ${rating.score}`
          : I18n.t('debrief.unranked', { score: rating.score });
        const diffCfg = GameLogic.getDifficultyConfig(diffId);
        const title = victory
          ? I18n.t('debrief.victoryTitle', { grade: rating.grade })
          : I18n.t('debrief.defeatTitle');
        const desc = victory ? I18n.t('debrief.victoryDesc') : I18n.t('debrief.defeatDesc');
        const statsHtml = `
        <div><span>${I18n.t('debrief.statRankScore')}</span><strong>${scoreHtml}</strong></div>
        <div><span>${I18n.t('debrief.statDiffMult')}</span><strong>${I18n.field(diffCfg, 'name')} (${diffCfg.scoreMult.toFixed(2)}x)</strong></div>
        <div><span>${I18n.t('debrief.statTimeAlarms')}</span><strong>${mins}:${secs} / ${I18n.t('debrief.alarmCount', { count: alarmsTriggered })}</strong></div>
        <div><span>${I18n.t('debrief.statKillsBreak')}</span><strong>${killedCount} / ${meleeKills} / ${barrelKills}</strong></div>
        <div><span>${I18n.t('debrief.statAccCrits')}</span><strong>${acc}% / ${crits}</strong></div>
        ${medalHtml}
      `;
        return { title, desc, statsHtml };
      }

      const {
        sub,
        cleared,
        timedDuration,
        kills,
        maxCombo,
        score,
        critKills,
        acc,
        wave,
        elapsedTime,
        stageId,
        invulnerable,
        simulatedHits,
        noteIds = [],
        notes = [],
      } = debrief;
      const mins = Math.floor(elapsedTime / 60);
      const secs = Math.floor(elapsedTime % 60).toString().padStart(2, '0');
      const legacyNoteMap = {
        best_score: '\u6700\u9ad8\u5206',
        best_wave: '\u6700\u9ad8\u6ce2\u6b21',
        best_kills: '\u6700\u9ad8\u51fb\u6740',
        best_time: '\u6700\u5feb\u901a\u5173',
      };
      const badge = (noteId) => (
        (Array.isArray(noteIds) && noteIds.includes(noteId)) ||
        (Array.isArray(notes) && legacyNoteMap[noteId] && notes.includes(legacyNoteMap[noteId]))
          ? `<span class="new-record-badge">${I18n.t('debrief.newRecord')}</span>`
          : ''
      );

      if (sub === 'timed') {
        return {
          title: I18n.t('train.debrief.timedTitle'),
          desc: I18n.t('train.debrief.timedDesc', { dur: timedDuration, kills, maxCombo }),
          statsHtml: `
          <div><span>${I18n.t('train.debrief.finalScore')}${badge('best_score')}</span><strong>${score}</strong></div>
          <div><span>${I18n.t('train.debrief.killsCrits')}</span><strong>${kills} / ${critKills}</strong></div>
          <div><span>${I18n.t('train.debrief.maxCombo')}</span><strong>x${maxCombo}</strong></div>
          <div><span>${I18n.t('train.debrief.accuracy')}</span><strong>${acc}%</strong></div>
        `,
        };
      }
      if (sub === 'endless') {
        return {
          title: I18n.t('train.debrief.endlessTitle'),
          desc: I18n.t('train.debrief.endlessDesc', { wave, time: `${mins}:${secs}`, kills }),
          statsHtml: `
          <div><span>${I18n.t('train.debrief.waveReached')}${badge('best_wave')}</span><strong>${I18n.t('train.debrief.waveValue', { wave })}</strong></div>
          <div><span>${I18n.t('train.debrief.totalKills')}${badge('best_kills')}</span><strong>${kills}</strong></div>
          <div><span>${I18n.t('train.debrief.survivalTime')}</span><strong>${mins}:${secs}</strong></div>
          <div><span>${I18n.t('train.debrief.critsAcc')}</span><strong>${critKills} / ${acc}%</strong></div>
        `,
        };
      }
      const st = (GameLogic.TRAINING_STAGES || []).find((s) => s.id === stageId) || GameLogic.TRAINING_STAGES[0];
      const stName = I18n.field(st, 'name');
      const title = cleared
        ? I18n.t('train.debrief.stageClearTitle', { id: st.id })
        : I18n.t('train.debrief.stageFailTitle', { id: st.id });
      const desc = (cleared && invulnerable)
        ? I18n.t('train.debrief.stagePracticeDesc', { name: stName, hits: simulatedHits })
        : cleared
          ? I18n.t('train.debrief.stageClearDesc', { name: stName })
          : I18n.t('train.debrief.stageFailDesc', { name: stName });
      const modeTxt = invulnerable
        ? I18n.t('train.debrief.modePractice', { hits: simulatedHits })
        : I18n.t('train.debrief.modeOfficial');
      return {
        title,
        desc,
        statsHtml: `
          <div><span>${I18n.t('train.debrief.stageTime')}${badge('best_time')}</span><strong>${this._formatDuration(elapsedTime, true)}</strong></div>
          <div><span>${I18n.t('train.debrief.killsCrits')}</span><strong>${kills} / ${critKills}</strong></div>
          <div><span>${I18n.t('train.debrief.accuracy')}</span><strong>${acc}%</strong></div>
          <div><span>${I18n.t('train.debrief.challengeMode')}</span><strong>${modeTxt}</strong></div>
        `,
      };
    }

    _endMission(victory) {
      this.state = victory ? 'VICTORY' : 'DEFEAT';
      this._gPlantedC4ThisPress = false;
      this.weapon.setFiring(false);
      this.weapon.cancelThrowPreview();
      this.weapon.isADS = false;
      this.weapon.clearThrowables();
      this.audio.stopRelayCutLoop();
      if (this.audio.clearScheduledThunder) this.audio.clearScheduledThunder();
      this.audio.setLowHpFactor(0);
      this.audio.setMusicMode('off');
      this.voice.setPaused(false);
      if (document.pointerLockElement === this.canvas) {
        document.exitPointerLock();
      }

      const acc = this.weapon.stats.shotsFired > 0
        ? Math.round((this.weapon.stats.shotsHit / this.weapon.stats.shotsFired) * 100)
        : 0;

      const rating = GameLogic.computeMissionRating({
        elapsedSec: this.elapsedTime,
        kills: this.enemies.killedCount,
        shotsFired: this.weapon.stats.shotsFired,
        shotsHit: this.weapon.stats.shotsHit,
        crits: this.weapon.stats.crits,
        alarmsTriggered: this.missionState.alarmsTriggered || 0,
        stealthRelays: this.missionState.stealthRelays || 0,
        damageTaken: this.player.damageTakenTotal,
        barrelKills: this.missionState.barrelKills || 0,
        meleeKills: this.missionState.meleeKills || 0,
        difficulty: this.loadoutConfig.difficulty,
        mutators: this.loadoutConfig.mutators,
      });

      const careerRes = GameLogic.updateCareerRecords(this.careerProfile, {
        victory: !!victory,
        grade: rating.grade,
        score: rating.score,
        elapsedSec: this.elapsedTime,
        medals: rating.medals,
        medalIds: rating.medalIds,
      });
      this.careerProfile = careerRes.nextProfile;
      saveCareerProfile(this.careerProfile);

      this._lastDebrief = {
        kind: 'mission',
        victory: !!victory,
        rating,
        diffId: this.missionState.difficulty || this.loadoutConfig.difficulty,
        elapsedTime: this.elapsedTime,
        alarmsTriggered: this.missionState.alarmsTriggered || 0,
        killedCount: this.enemies.killedCount,
        meleeKills: this.missionState.meleeKills || 0,
        barrelKills: this.missionState.barrelKills || 0,
        acc,
        crits: this.weapon.stats.crits,
      };
      const copy = this._renderDebriefCopy(this._lastDebrief);
      this.dlgTitle.textContent = copy.title;
      this.dlgDesc.textContent = copy.desc;
      this.dlgStats.innerHTML = copy.statsHtml;
      this.dlgStats.hidden = false;
      this._setDialogView('main');
      this._syncMenuButtons();
      if (!this.dialog.open) this.dialog.showModal();

      if (victory && rating.grade === 'S') {
        this.hud.showRadio(
          I18n.t('debrief.speaker.rankS'),
          I18n.t('debrief.radio.rankS'),
          6.8,
          false,
          {
            voiceId: 'mission_rank_s',
            role: 'evac',
            priority: 3,
            speakerKey: 'debrief.speaker.rankS',
            textKey: 'debrief.radio.rankS',
          }
        );
      } else if (victory) {
        this.hud.showRadio(
          I18n.t('app.speaker.evac'),
          I18n.t('debrief.radio.victory'),
          6.5,
          false,
          {
            voiceId: 'mission_victory',
            role: 'evac',
            priority: 3,
            speakerKey: 'app.speaker.evac',
            textKey: 'debrief.radio.victory',
          }
        );
      } else {
        this.hud.showRadio(
          I18n.t('app.speaker.watcher'),
          I18n.t('debrief.radio.defeat'),
          6.0,
          false,
          {
            voiceId: 'mission_defeat',
            role: 'watcher',
            priority: 3,
            speakerKey: 'app.speaker.watcher',
            textKey: 'debrief.radio.defeat',
          }
        );
      }
    }

    _endTraining(cleared) {
      const sub = this.training.submode || 'timed';
      this.training.finished = true;
      this.training.active = false;
      this.player.invulnerablePractice = false;
      this.state = cleared ? 'VICTORY' : 'DEFEAT';
      this._gPlantedC4ThisPress = false;
      this.weapon.setFiring(false);
      this.weapon.cancelThrowPreview();
      this.weapon.isADS = false;
      this.weapon.clearThrowables();
      this.player.keys = Object.create(null);
      this.audio.stopRelayCutLoop();
      if (this.audio.clearScheduledThunder) this.audio.clearScheduledThunder();
      this.audio.setLowHpFactor(0);
      this.audio.setMusicMode('off');
      this.voice.setPaused(false);
      if (document.pointerLockElement === this.canvas) {
        document.exitPointerLock();
      }

      const acc = this.weapon.stats.shotsFired > 0
        ? Math.round((this.weapon.stats.shotsHit / this.weapon.stats.shotsFired) * 100)
        : 0;

      let payload;
      if (sub === 'timed') {
        payload = {
          duration: this.training.timedDuration,
          score: this.training.score,
          kills: this.training.kills,
        };
      } else if (sub === 'endless') {
        payload = {
          wave: this.training.wave,
          kills: this.training.kills,
          time: this.elapsedTime,
        };
      } else {
        payload = {
          stageId: this.training.stageId,
          cleared: !!cleared,
          time: this.elapsedTime,
          invulnerable: !!this.training.invulnerable,
        };
      }

      const recResult = GameLogic.updateTrainingRecords(this.trainingRecords, sub, payload);
      this.trainingRecords = recResult.nextRecords;
      saveTrainingRecords(this.trainingRecords);
      this._syncTrainingUI();

      this.lastTrainingResult = {
        submode: sub,
        cleared: !!cleared,
        ...payload,
        isNewRecord: recResult.isNewRecord,
        notes: recResult.notes,
        noteIds: recResult.noteIds || [],
      };

      this._lastDebrief = {
        kind: 'training',
        sub,
        cleared: !!cleared,
        timedDuration: this.training.timedDuration,
        kills: this.training.kills,
        maxCombo: this.training.maxCombo,
        score: this.training.score,
        critKills: this.training.critKills,
        acc,
        wave: this.training.wave,
        elapsedTime: this.elapsedTime,
        stageId: this.training.stageId,
        invulnerable: !!this.training.invulnerable,
        simulatedHits: this.player.simulatedHits,
        noteIds: recResult.noteIds || [],
        notes: recResult.notes || [],
      };

      const copy = this._renderDebriefCopy(this._lastDebrief);
      this.dlgTitle.textContent = copy.title;
      this.dlgDesc.textContent = copy.desc;
      this.dlgStats.innerHTML = copy.statsHtml;

      if (sub === 'timed') {
        const tScore = this.training.score;
        const tKills = this.training.kills;
        this.hud.showRadio(
          I18n.t('train.speaker.timed'),
          I18n.t('train.debrief.timedRadio', { score: tScore, kills: tKills }),
          5.5,
          false,
          {
            voiceId: 'train_timed_end',
            role: 'instructor',
            priority: 3,
            speakerKey: 'train.speaker.timed',
            textKey: 'train.debrief.timedRadio',
            textParams: { score: tScore, kills: tKills },
          }
        );
      } else if (sub === 'endless') {
        const eWave = this.training.wave;
        const eKills = this.training.kills;
        this.hud.showRadio(
          I18n.t('app.speaker.watcher'),
          I18n.t('train.debrief.endlessRadio', { wave: eWave, kills: eKills }),
          5.8,
          false,
          {
            voiceId: 'mission_defeat',
            role: 'watcher',
            priority: 3,
            speakerKey: 'app.speaker.watcher',
            textKey: 'train.debrief.endlessRadio',
            textParams: { wave: eWave, kills: eKills },
          }
        );
      } else {
        const st = this.training.stage || GameLogic.TRAINING_STAGES[0];
        if (cleared) {
          this.hud.showRadio(
            I18n.t('train.speaker.stage', { id: st.id }),
            I18n.t('train.debrief.stageClearRadio', { name: I18n.field(st, 'shortName') }),
            5.5,
            false,
            {
              voiceId: 'train_stage_clear',
              role: 'instructor',
              priority: 3,
              speakerKey: 'train.speaker.stage',
              speakerParams: { id: st.id },
              textKey: 'train.debrief.stageClearRadio',
              getTextParams: () => ({ name: I18n.field(st, 'shortName') }),
            }
          );
        } else {
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('train.debrief.stageFailRadio', { name: I18n.field(st, 'shortName') }),
            5.2,
            false,
            {
              voiceId: 'mission_defeat',
              role: 'watcher',
              priority: 3,
              speakerKey: 'app.speaker.watcher',
              textKey: 'train.debrief.stageFailRadio',
              getTextParams: () => ({ name: I18n.field(st, 'shortName') }),
            }
          );
        }
      }

      this.dlgStats.hidden = false;
      this._setDialogView('main');
      this._syncMenuButtons();
      if (!this.dialog.open) this.dialog.showModal();
    }

    _returnToMainMenu() {
      this.tutorial.stop();
      this.training.stop();
      this.audio.stopRelayCutLoop();
      if (this.audio.clearScheduledThunder) this.audio.clearScheduledThunder();
      this.hud.clearRadio();
      this._gPlantedC4ThisPress = false;
      this.weapon.setFiring(false);
      this.weapon.cancelThrowPreview();
      this.weapon.isADS = false;
      this.player.keys = Object.create(null);
      if (document.pointerLockElement === this.canvas) {
        document.exitPointerLock();
      }
      this.audio.setPaused(false);
      this.voice.setPaused(false);
      this.enemies.clearAll();
      this.level.resetWorldState([]);
      this._resetPlayerAndWeapon(true);
      this.enemies.spawnInitialPatrols({});

      this.elapsedTime = 0;
      this.activeMode = 'combat';
      this.lastTrainingResult = null;
      this._lastDebrief = null;
      this._interactPromptSpec = null;
      this.state = 'MENU';
      this.dlgStats.hidden = true;
      if (this.disclosureLoadout) this.disclosureLoadout.open = false;
      if (this.disclosureSettings) this.disclosureSettings.open = false;
      this._setDialogView('main');
      this._syncMenuButtons();
      if (!this.dialog.open) this.dialog.showModal();
    }

    _resetPlayerAndWeapon(forceStandard = false) {
      const diffCfg = this._applyGameplayDifficulty(forceStandard);
      this.player.reset();
      this.player.blackoutMutator = false;
      this._gPlantedC4ThisPress = false;
      this.weapon.cancelThrowPreview();
      this.weapon.resetArsenal(this.loadoutConfig.primaryWeapon, this.loadoutConfig.skin, []);
      this.weapon.clearThrowables();
      this.activeC4Relays = [];
      for (const r of this.level.relays) {
        r.c4Planted = false;
        r.c4Timer = 0;
      }
      this.scanCooldown = 0;
      this.meleeCooldown = 0;
      this.sniperWarnSpoken = false;
      this.holdout15Spoken = false;
      if (this.audio.clearScheduledThunder) this.audio.clearScheduledThunder();
      this.audio.setLowHpFactor(0);
      this.audio.setMusicMode('off');
      this.render.setEnvironmentEffects({ indoors: false, lowHpFactor: 0, blackout: false });
      if (this.missionState) {
        this.missionState.difficulty = diffCfg.id;
        this.missionState.realism = !!diffCfg.hideHudHints;
      }
    }

    _startTutorial() {
      this.activeMode = 'tutorial';
      this.lastTrainingResult = null;
      this._lastDebrief = null;
      this._interactPromptSpec = null;
      this.training.stop();
      this.tutorial.start();
    }

    skipTutorial() {
      if (!this.tutorial.active || this.state !== 'PLAYING') return;
      markTutorialDone();
      this._startCombatMission(I18n.t('app.radio.missionSkip'), 'mission_skip', 'app.radio.missionSkip');
    }

    _startTraining(submode = this.trainingConfig.submode, config = this.trainingConfig) {
      this.activeMode = 'training';
      this.lastTrainingResult = null;
      this._lastDebrief = null;
      this._interactPromptSpec = null;
      this.trainingConfig.submode = submode;
      this.training.start(submode, config);
    }

    _startCombatMission(
      radioMessage = null,
      voiceId = 'mission_start',
      radioTextKey = 'app.radio.missionStart'
    ) {
      this.activeMode = 'combat';
      this.lastTrainingResult = null;
      this._lastDebrief = null;
      this._interactPromptSpec = null;
      this.tutorial.stop();
      this.training.stop();
      this.audio.stopRelayCutLoop();
      this.hud.clearRadio();
      this.enemies.clearAll();

      const diffCfg = this._getEffectiveDiffConfig(false);
      const mutators = this.loadoutConfig.mutators || [];
      this.level.resetWorldState(mutators);
      this._resetPlayerAndWeapon(false);
      this.player.blackoutMutator = mutators.includes('blackout');
      this.enemies.spawnInitialPatrols(this._buildEnemyDiffOpts(diffCfg, {
        elitePatrol: mutators.includes('elite_patrol'),
      }));

      this.elapsedTime = 0;
      this.hud._lastTutChipsKey = '';
      this.missionState = {
        phase: 'CUT_RELAYS',
        severedCount: 0,
        interactPrompt: '',
        interactProgress: 0,
        lockdown: false,
        evacApproached: false,
        evacBoardingSpoken: false,
        alarmsTriggered: 0,
        stealthRelays: 0,
        barrelKills: 0,
        c4Kills: 0,
        meleeKills: 0,
        holdoutTimer: 30,
        scanCooldown: 0,
        difficulty: diffCfg.id,
        realism: !!diffCfg.hideHudHints,
      };
      this.audio.setMusicMode('stealth');
      this.audio.playRadioBeep();
      const textKey = radioTextKey || 'app.radio.missionStart';
      const resolvedMsg = radioMessage !== null && radioMessage !== undefined ? radioMessage : I18n.t(textKey);
      this.hud.showRadio(
        I18n.t('app.speaker.watcher'),
        resolvedMsg,
        6.8,
        false,
        {
          voiceId,
          role: 'watcher',
          priority: 3,
          speakerKey: 'app.speaker.watcher',
          textKey,
        }
      );
    }

    _restartMission() {
      this._startCombatMission(I18n.t('app.radio.missionRestart'), 'mission_restart', 'app.radio.missionRestart');
    }

    _triggerTacticalScan() {
      if (this.scanCooldown > 0) return;
      const shortCd = this.training.active && this.training.submode === 'endless' && this.training.ownedPerks.includes('tactical_optics');
      this.scanCooldown = shortCd ? 7.0 : 14.0;
      this.missionState.scanCooldown = this.scanCooldown;
      this.audio.playPulseScan();
      this.render.triggerScanPulse();
      this.enemies.triggerTacticalScan(this.player.pos, 62, 7.0);
      this.tutorial.onScanTriggered();
    }

    _performTacticalMelee() {
      if (this.meleeCooldown > 0) return;
      this.meleeCooldown = 0.6;
      this.weapon.triggerMeleeSwing();
      const fwd = new THREE.Vector3(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
      const res = this.enemies.performMelee(this.player.pos, fwd);
      this.tutorial.onMeleePerformed(res);
      if (res && res.hit) {
        if (res.silentTakedown) {
          this.audio.playMeleeTakedown();
        } else {
          this.audio.playHitmarker(false, res.killed, false);
        }
        this.hud.triggerHitmarker(res.silentTakedown, res.killed, false);
      }
    }

    _handleTacticalGKeyDown() {
      this._gPlantedC4ThisPress = false;
      if (this.tutorial.active && this.tutorial.step === 8 && this.level.tutorialRelay) {
        const sim = this.level.tutorialRelay;
        if (!sim.severed && !sim.c4Planted && this.player.pos.distanceTo(sim.pos) < 3.4) {
          sim.c4Planted = true;
          sim.c4Timer = 1.35;
          if (sim.c4Group) sim.c4Group.visible = true;
          this.audio.playC4Plant();
          this._gPlantedC4ThisPress = true;
          return;
        }
      }
      if (!this.tutorial.active && !this.training.isTimedSafe() && !(this.training.active && this.training.submode === 'endless')) {
        for (const r of this.level.relays) {
          if (!r.severed && !r.disabledByMode && !r.c4Planted && this.player.pos.distanceTo(r.pos) < 3.4) {
            r.c4Planted = true;
            r.c4Timer = 1.35;
            if (r.c4Group) r.c4Group.visible = true;
            this.activeC4Relays.push(r);
            this.audio.playC4Plant();
            this._gPlantedC4ThisPress = true;
            return;
          }
        }
      }
      if (this.weapon.beginThrowPreview()) {
        this.render.camera.getWorldDirection(this._aimDirTmp);
        this.weapon.updateThrowPreview(this.render.camera.position, this._aimDirTmp);
      }
    }

    _detonateRelayC4(relay) {
      if (!relay || relay.severed) return;
      relay.c4Planted = false;
      this.level.flashExplosionLight(relay.pos);
      this.render.spawnSparks(relay.pos, new THREE.Vector3(0, 1, 0), 34, 1.5);
      this.render.spawnSmoke(relay.pos, 8, 0.65, 3.0, 0xff8c3a);
      const dist = this.player.pos.distanceTo(relay.pos);
      this.audio.playExplosion(dist, relay.pos);
      if (dist < 12) {
        this.player.addTrauma(Math.max(0.18, (1 - dist / 12) * 0.58));
      }
      if (dist < 7.5 && this.audio.playTinnitusFlash) {
        this.audio.playTinnitusFlash(Math.min(1, 1 - dist / 9));
      }
      const kills = this.enemies.applyExplosionDamage(relay.pos, 7.5, 140);
      this.missionState.c4Kills = (this.missionState.c4Kills || 0) + kills;
      this.enemies.alertSound(relay.pos, 65, true);
      this._completeRelaySever(relay, 'c4');
    }

    _onEnemyAlarmTriggered(enemy) {
      if (this.tutorial.active || this.training.isTimedSafe() || this.state !== 'PLAYING') return;
      this.missionState.alarmsTriggered = (this.missionState.alarmsTriggered || 0) + 1;
      this.audio.playAlarmKlaxon(2);
      this.hud.showRadio(
        I18n.t('app.speaker.watcher'),
        I18n.t('app.radio.alarmTriggered'),
        4.6,
        false,
        {
          voiceId: 'alarm_compromised',
          role: 'watcher',
          priority: 2,
          cooldownSec: 20,
          speakerKey: 'app.speaker.watcher',
          textKey: 'app.radio.alarmTriggered',
        }
      );
    }

    _onReconReinforce(pos) {
      if (this.tutorial.active || this.training.isTimedSafe() || this.state !== 'PLAYING') return;
      const diffCfg = this._getEffectiveDiffConfig(false);
      const offsetX = pos.x > 0 ? -4 : 4;
      const offsetZ = pos.z > 0 ? -4 : 4;
      const isDrone = Math.random() >= 0.5;
      let spawnPos = new THREE.Vector3(pos.x + offsetX, isDrone ? 6.4 : 0, pos.z + offsetZ);
      if (isDrone && this.level.collision.findSafeAerialSpawn) {
        const safe = this.level.collision.findSafeAerialSpawn(spawnPos, { radiusXZ: 1.0, halfY: 0.48, minY: 2.4 });
        spawnPos = new THREE.Vector3(safe.x, safe.y, safe.z);
      }
      this.enemies.spawnCombatEnemy(isDrone ? 'drone' : 'hound', spawnPos, this._buildEnemyDiffOpts(diffCfg, {
        alertImmediately: true,
      }));
    }

    _setInteractPrompt(key, paramsOrFn = null) {
      if (!key) {
        this._interactPromptSpec = null;
        this.missionState.interactPrompt = '';
        return;
      }
      this._interactPromptSpec = { key, paramsOrFn };
      const params = typeof paramsOrFn === 'function' ? paramsOrFn() : paramsOrFn;
      this.missionState.interactPrompt = I18n.t(key, params);
    }

    _updateInteraction(dt) {
      this._setInteractPrompt('');
      const pPos = this.player.pos;
      const holdingE = !!this.player.keys['KeyE'];

      // 新手教程期专属隔离交互（屏蔽实战中继器与实战医疗箱）
      if (this.tutorial.active) {
        if (this.tutorial.step === 5 && this.level.tutorialAmmoCrate) {
          if (pPos.distanceTo(this.level.tutorialAmmoCrate.pos) < 2.8) {
            this._setInteractPrompt('tut.interact.crate');
            this.missionState.interactProgress = 0;
            if (holdingE && ((this.weapon.throwables.emp || 0) < 3 || (this.weapon.throwables.frag || 0) < 3)) {
              this.weapon.throwables.emp = 3;
              this.weapon.throwables.frag = 3;
              this.audio.playSwitchClick();
            }
            return;
          }
        }
        if (this.tutorial.step === 7 && this.level.tutorialMedkit && !this.level.tutorialMedkit.used) {
          if (pPos.distanceTo(this.level.tutorialMedkit.pos) < 3.0) {
            this._setInteractPrompt('tut.interact.medkit');
            this.missionState.interactProgress = 0;
            if (holdingE) {
              this.level.tutorialMedkit.used = true;
              this.level.tutorialMedkit.group.visible = false;
              this.player.heal(100);
              this.audio.playSwitchClick();
              this.tutorial.onMedkitUsed();
            }
            return;
          }
        }
        if (this.tutorial.step === 8 && this.level.tutorialRelay && !this.level.tutorialRelay.severed && !this.level.tutorialRelay.c4Planted) {
          const sim = this.level.tutorialRelay;
          if (pPos.distanceTo(sim.pos) < 3.4) {
            this._setInteractPrompt('tut.interact.simRelay');
            if (holdingE) {
              this.missionState.interactProgress = Math.min(1, this.missionState.interactProgress + dt / 1.45);
              this.audio.updateRelayCutLoop(this.missionState.interactProgress);
              if (Math.random() < dt * 12) {
                this.render.spawnSparks(sim.pos, new THREE.Vector3(0, 1, 0), 3, 0.7);
              }
              if (this.missionState.interactProgress >= 1) {
                sim.severed = true;
                sim.panel.material.color.setHex(0x1f362a);
                sim.light.color.setHex(0x22cc66);
                sim.light.intensity = 3.5;
                this.render.spawnSparks(sim.pos, new THREE.Vector3(0, 1, 0), 22, 1.3);
                this.missionState.interactProgress = 0;
                this.audio.stopRelayCutLoop();
                this.audio.playRelaySevered();
                this.tutorial.onSimRelaySevered();
              }
            } else {
              this.missionState.interactProgress = Math.max(0, this.missionState.interactProgress - dt * 2.5);
              this.audio.stopRelayCutLoop();
            }
            return;
          }
        }
        this.missionState.interactProgress = 0;
        this.audio.stopRelayCutLoop();
        return;
      }

      // 1. 医疗补给箱（按 E 瞬间恢复）
      for (const crate of this.level.supplyCrates) {
        if (!crate.used && pPos.distanceTo(crate.pos) < 2.6 && this.player.hp < this.player.maxHp) {
          this._setInteractPrompt('app.interact.medkit');
          this.missionState.interactProgress = 0;
          if (holdingE) {
            crate.used = true;
            crate.group.visible = false;
            this.player.heal(45);
            this.audio.playSwitchClick();
            this.hud.showRadio(
              I18n.t('app.speaker.watcher'),
              I18n.t('app.radio.medkitUsed'),
              3.8,
              false,
              {
                voiceId: 'tac_medkit',
                role: 'watcher',
                priority: 1,
                cooldownSec: 10,
                tacOnly: true,
                speakerKey: 'app.speaker.watcher',
                textKey: 'app.radio.medkitUsed',
              }
            );
          }
          return;
        }
      }

      // 2. 战术弹药补给箱（补充备弹与手雷，30秒冷却再生）
      for (const ac of this.level.ammoCrates) {
        if (ac.cooldown <= 0 && pPos.distanceTo(ac.pos) < 2.6) {
          this._setInteractPrompt('app.interact.ammoCrate');
          this.missionState.interactProgress = 0;
          if (holdingE) {
            ac.cooldown = 30.0;
            ac.stripMat.color.setHex(0x3a404a);
            ac.light.intensity = 0.5;
            this.weapon.refillAmmo();
            this.hud.showRadio(
              I18n.t('app.speaker.watcher'),
              I18n.t('app.radio.ammoResupplied'),
              3.6,
              false,
              {
                voiceId: 'ammo_crate_resupply',
                role: 'watcher',
                priority: 1,
                cooldownSec: 12,
                tacOnly: true,
                speakerKey: 'app.speaker.watcher',
                textKey: 'app.radio.ammoResupplied',
              }
            );
          }
          return;
        }
      }

      // 3. 场景配电闸刀（A探照灯 / B仓库总闸，支持潜行无声关闭）
      const interactEye = new THREE.Vector3(pPos.x, pPos.y + (this.player.curEye || 1.65), pPos.z);
      for (const br of this.level.breakers) {
        if (
          !br.tripped &&
          pPos.distanceTo(br.pos) < 2.6 &&
          this.level.collision.hasLineOfSight(interactEye, br.pos)
        ) {
          const getBreakerLabel = () => I18n.field(br, 'label') || I18n.field(br, 'name') || br.id;
          this._setInteractPrompt('app.interact.breaker', () => ({ label: getBreakerLabel() }));
          this.missionState.interactProgress = 0;
          if (holdingE) {
            this.level.triggerBreaker(br);
            this.audio.playSwitchClick();
            this.hud.showRadio(
              I18n.t('app.speaker.watcher'),
              I18n.t('app.radio.breakerTripped', { label: getBreakerLabel() }),
              3.8,
              false,
              {
                role: 'watcher',
                priority: 1,
                cooldownSec: 6,
                speakerKey: 'app.speaker.watcher',
                textKey: 'app.radio.breakerTripped',
                getTextParams: () => ({ label: getBreakerLabel() }),
              }
            );
          }
          return;
        }
      }

      // 4. 未切断的 3 处通信中继器（长按 E 无声黑入 2.25s 或 按 G 贴 C4 强破）
      if (!this.training.isTimedSafe() && !(this.training.active && this.training.submode === 'endless')) {
        for (const relay of this.level.relays) {
          if (!relay.severed && !relay.disabledByMode && !relay.c4Planted && pPos.distanceTo(relay.pos) < 3.4) {
            this._setInteractPrompt('app.interact.relay', { id: relay.id });
            if (holdingE) {
              this.missionState.interactProgress = Math.min(1, this.missionState.interactProgress + dt / 2.25);
              this.audio.updateRelayCutLoop(this.missionState.interactProgress);
              if (Math.random() < dt * 12) {
                this.render.spawnSparks(relay.pos, new THREE.Vector3(0, 1, 0), 3, 0.7);
              }
              if (this.missionState.interactProgress >= 1) {
                this._completeRelaySever(relay, 'hack');
                this.missionState.interactProgress = 0;
                this.audio.stopRelayCutLoop();
              }
            } else {
              this.missionState.interactProgress = Math.max(0, this.missionState.interactProgress - dt * 2.5);
              this.audio.stopRelayCutLoop();
            }
            return;
          }
        }
      }

      // 5. 撤离船只登船点（守住 30s 倒计时解锁后长按 E 1.35s 撤离）
      if (this.level.extraction && this.level.extraction.unlocked) {
        if (!this.missionState.evacApproached && pPos.x > 13 && pPos.z < -14) {
          this.missionState.evacApproached = true;
          this.hud.showRadio(
            I18n.t('app.speaker.evac'),
            I18n.t('app.radio.evacApproach'),
            4.6,
            false,
            {
              voiceId: 'tac_evac_approach',
              role: 'evac',
              priority: 2,
              cooldownSec: 60,
              tacOnly: true,
              speakerKey: 'app.speaker.evac',
              textKey: 'app.radio.evacApproach',
            }
          );
        }
        if (pPos.distanceTo(this.level.extraction.pos) < 3.8) {
          if (this.missionState.phase === 'EVAC_HOLDOUT') {
            this._setInteractPrompt('app.interact.holdoutWait', () => ({ sec: (this.missionState.holdoutTimer || 0).toFixed(1) }));
            this.missionState.interactProgress = 0;
            this.audio.stopRelayCutLoop();
            return;
          }
          this._setInteractPrompt('app.interact.boardBoat');
          if (holdingE) {
            if (!this.missionState.evacBoardingSpoken) {
              this.missionState.evacBoardingSpoken = true;
              this.hud.showRadio(
                I18n.t('app.speaker.evac'),
                I18n.t('app.radio.evacBoarding'),
                4.2,
                false,
                {
                  voiceId: 'tac_evac_boarding',
                  role: 'evac',
                  priority: 2,
                  cooldownSec: 30,
                  tacOnly: true,
                  speakerKey: 'app.speaker.evac',
                  textKey: 'app.radio.evacBoarding',
                }
              );
            }
            this.missionState.interactProgress = Math.min(1, this.missionState.interactProgress + dt / 1.35);
            this.audio.updateRelayCutLoop(this.missionState.interactProgress);
            if (this.missionState.interactProgress >= 1) {
              this.audio.stopRelayCutLoop();
              this.audio.playRelaySevered();
              if (this.training.active) {
                this.training.onExtractionComplete();
              } else {
                this._endMission(true);
              }
            }
          } else {
            this.missionState.interactProgress = Math.max(0, this.missionState.interactProgress - dt * 2.5);
            this.audio.stopRelayCutLoop();
          }
          return;
        }
      }

      this.missionState.interactProgress = 0;
      this.audio.stopRelayCutLoop();
    }

    _completeRelaySever(relay, method = 'hack') {
      if (this.training.active) {
        relay.severed = true;
        this.training.onRelaySevered(relay);
        return;
      }
      this.level.setRelaySeveredVisual(relay, method);

      this.missionState.severedCount++;
      this.audio.playRelaySevered();
      this.render.spawnSparks(relay.pos, new THREE.Vector3(0, 1, 0), 22, 1.3);

      const diffCfg = this._getEffectiveDiffConfig(false);
      if (method === 'hack') {
        this.missionState.stealthRelays = (this.missionState.stealthRelays || 0) + 1;
      } else {
        this.missionState.alarmsTriggered = (this.missionState.alarmsTriggered || 0) + 1;
      }

      const getRelayName = () => I18n.field(relay, 'name') || relay.id;
      const sevCount = this.missionState.severedCount;

      if (sevCount < 3) {
        if (method === 'c4') {
          this.audio.playAlarmKlaxon(2);
          this.enemies.spawnRelayInterceptor(relay.pos, this._buildEnemyDiffOpts(diffCfg, {
            withShield: sevCount >= 2,
          }));
          this.audio.playRadioBeep();
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('app.radio.relayC4', { name: getRelayName(), count: sevCount }),
            5.8,
            false,
            {
              voiceId: 'relay_c4_loud',
              role: 'watcher',
              priority: 3,
              speakerKey: 'app.speaker.watcher',
              textKey: 'app.radio.relayC4',
              getTextParams: () => ({ name: getRelayName(), count: sevCount }),
            }
          );
        } else if ((this.missionState.alarmsTriggered || 0) === 0) {
          this.audio.playRadioBeep();
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('app.radio.relayStealth', { name: getRelayName(), count: sevCount }),
            5.4,
            false,
            {
              voiceId: 'relay_stealth_clean',
              role: 'watcher',
              priority: 3,
              speakerKey: 'app.speaker.watcher',
              textKey: 'app.radio.relayStealth',
              getTextParams: () => ({ name: getRelayName(), count: sevCount }),
            }
          );
        } else {
          this.enemies.spawnRelayInterceptor(relay.pos, this._buildEnemyDiffOpts(diffCfg, {
            withShield: sevCount >= 2,
          }));
          this.audio.playRadioBeep();
          const voiceId = `relay_${relay.id}_${sevCount}`;
          const textKey = sevCount === 2 ? 'app.radio.relayTwo' : 'app.radio.relayOne';
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t(textKey, { name: getRelayName() }),
            5.6,
            false,
            {
              voiceId,
              role: 'watcher',
              priority: 3,
              speakerKey: 'app.speaker.watcher',
              textKey,
              getTextParams: () => ({ name: getRelayName() }),
            }
          );
        }
      } else {
        this.missionState.phase = 'EVAC_HOLDOUT';
        this.missionState.holdoutTimer = 30.0;
        this.missionState.lockdown = true;
        this.holdout15Spoken = false;
        this.level.unlockExtraction();
        this.audio.playAlarmKlaxon(4);
        this.audio.setMusicMode('holdout');
        this.enemies.spawnFinalReinforcements(this._buildEnemyDiffOpts(diffCfg));
        this.audio.playRadioBeep();
        this.hud.showRadio(
          I18n.t('app.speaker.evac'),
          I18n.t('app.radio.evacHoldoutStart'),
          7.0,
          false,
          {
            voiceId: 'evac_holdout_start',
            role: 'evac',
            priority: 3,
            speakerKey: 'app.speaker.evac',
            textKey: 'app.radio.evacHoldoutStart',
          }
        );
      }
    }

    _damageBarrel(barrel, dmg) {
      if (!barrel || barrel.state === 'exploded' || barrel.state === 'chaining') return;
      barrel.hp -= dmg;
      if (barrel.hp <= 0) {
        this._triggerBarrelExplosion(barrel);
      } else if (barrel.hp <= 15 && barrel.state === 'intact') {
        barrel.state = 'burning';
        barrel.burnTimer = 0.85;
      }
    }

    _triggerBarrelExplosion(barrel) {
      if (!barrel || barrel.state === 'exploded') return;
      barrel.state = 'exploded';
      barrel.mesh.visible = false;
      if (barrel.aabbBox) barrel.aabbBox.disabled = true;

      const pos = barrel.pos;
      this.level.flashExplosionLight(pos);
      this.render.spawnSparks(pos, new THREE.Vector3(0, 1, 0), 36, 1.45);
      this.render.spawnSmoke(pos, 10, 0.72, 3.6, 0x383c42);
      this.render.spawnSmoke(pos, 5, 0.48, 2.8, 0xff8c3a);

      const distToPlayer = this.player.pos.distanceTo(pos);
      this.audio.playExplosion(distToPlayer, pos);
      if (distToPlayer < 14) {
        this.player.addTrauma(Math.max(0.18, (1 - distToPlayer / 14) * 0.72));
      }

      const mutators = this.loadoutConfig ? this.loadoutConfig.mutators : [];
      const isExpTide = mutators.includes('explosive_tide');
      const expRadius = isExpTide ? 10.5 : 8.5;
      const expDmg = isExpTide ? 165 : 135;
      const kills = this.enemies.applyExplosionDamage(pos, expRadius, expDmg);
      this.missionState.barrelKills = (this.missionState.barrelKills || 0) + kills;
      this.enemies.alertSound(pos, 52, true);
      if (!this.tutorial.active && !this.training.isTimedSafe() && distToPlayer < 6.8) {
        this._playerExpTmp.set(this.player.pos.x, this.player.pos.y + 1.0, this.player.pos.z);
        const occluded = this.level.collision ? !this.level.collision.hasLineOfSight(pos, this._playerExpTmp) : false;
        const pDmg = GameLogic.computeExplosionFalloff(distToPlayer, 6.8, 52, occluded);
        if (pDmg > 0) this.player.takeDamage(pDmg, pos);
        if ((distToPlayer < 7.5 || pDmg >= 22) && this.audio.playTinnitusFlash) {
          this.audio.playTinnitusFlash(Math.min(1, Math.max(1 - distToPlayer / 9, pDmg / 45)));
        }
      } else if (distToPlayer < 7.5 && this.audio.playTinnitusFlash) {
        this.audio.playTinnitusFlash(Math.min(1, 1 - distToPlayer / 9));
      }

      // 连锁引爆邻近危化油桶
      for (let i = 0; i < this.level.barrels.length; i++) {
        const other = this.level.barrels[i];
        if (other !== barrel && (other.state === 'intact' || other.state === 'burning')) {
          if (other.pos.distanceTo(pos) <= 6.2) {
            other.state = 'chaining';
            other.chainTimer = 0.16;
          }
        }
      }

      if (!this.tutorial.active && !this.training.isTimedSafe() && this.state === 'PLAYING' && kills > 0) {
        this.hud.showRadio(
          I18n.t('app.speaker.watcher'),
          I18n.t('app.radio.barrelKill'),
          4.2,
          false,
          {
            voiceId: 'tac_barrel_kill',
            role: 'watcher',
            priority: 1,
            cooldownSec: 10,
            tacOnly: true,
            speakerKey: 'app.speaker.watcher',
            textKey: 'app.radio.barrelKill',
          }
        );
      }
    }

    _exposeDebugHooks() {
      const app = this;
      window.__GAME_DEBUG__ = {
        getState() {
          const stealthInfo = app.enemies.getStealthStatus ? app.enemies.getStealthStatus() : { maxState: 'PATROL' };
          const activeVoicePack = app.voice && app.voice._getPack
            ? app.voice._getPack(app.voice.voiceLang)
            : ((window.__VOICE_PACKS__ && window.__VOICE_PACKS__[app.voice.voiceLang]) || window.__VOICE_PACK__);
          return {
            state: app.state,
            activeMode: app.activeMode,
            dialogView: app.dialogView,
            uiLang: I18n.getLang(),
            voiceLang: app.voice.voiceLang,
            voiceLangSetting: app.userSettings.voiceLang,
            fps: Math.round(app.fpsSmooth),
            quality: app.render.quality,
            extremeActive: !!app.render.isExtremeActive,
            drsScale: +(app.render.drsScale || 1).toFixed(2),
            drsEnabled: !!app.render.drsEnabled,
            playerPos: { x: +app.player.pos.x.toFixed(2), y: +app.player.pos.y.toFixed(2), z: +app.player.pos.z.toFixed(2) },
            hp: Math.round(app.player.hp),
            ammo: app.weapon.ammo,
            reserveAmmo: app.weapon.reserveAmmo,
            primaryWeapon: app.loadoutConfig.primaryWeapon,
            activeSlot: app.weapon.activeSlot,
            suppressorAttached: app.weapon.suppressorAttached,
            activeThrowableId: app.weapon.activeThrowableId,
            throwables: { ...app.weapon.throwables },
            skin: app.loadoutConfig.skin,
            mutators: [...app.loadoutConfig.mutators],
            adsAlpha: +app.weapon.adsAlpha.toFixed(2),
            sliding: app.player.sliding,
            flashlightOn: app.weapon.flashlightOn,
            indoors: app.player.indoors,
            puddleDepth: +app.player.puddleDepth.toFixed(2),
            severedCount: app.missionState.severedCount,
            phase: app.missionState.phase,
            holdoutTimer: +(app.missionState.holdoutTimer || 0).toFixed(1),
            stealthState: stealthInfo.maxState,
            alarmsTriggered: app.missionState.alarmsTriggered || 0,
            scanCooldown: +(app.scanCooldown || 0).toFixed(1),
            activeEnemies: app.enemies.enemies.filter((e) => !e.dead).length,
            killedEnemies: app.enemies.killedCount,
            extractionUnlocked: app.level.extraction ? app.level.extraction.unlocked : false,
            tutorialActive: app.tutorial.active,
            tutorialStep: app.tutorial.step,
            tutorialFinishing: app.tutorial.finishing,
            tutorialSubtasks: { ...app.tutorial.subtasks },
            tutorialDoneStorage: isTutorialDone(),
            trainingActive: app.training.active,
            trainingSubmode: app.training.submode,
            trainingScore: app.training.score,
            trainingKills: app.training.kills,
            trainingWave: app.training.wave,
            trainingStageId: app.training.stageId,
            trainingInvulnerable: app.training.invulnerable,
            ownedPerks: [...app.training.ownedPerks],
            trainingRecords: app.trainingRecords,
            careerProfile: app.careerProfile,
            difficulty: app.missionState ? app.missionState.difficulty : 'standard',
            realism: !!(app.missionState && app.missionState.realism),
            toggleAds: !!app.toggleAds,
            invertY: !!app.player.invertY,
            isPreviewingThrow: !!app.weapon.isPreviewingThrow,
            c4Kills: (app.missionState && app.missionState.c4Kills) || 0,
            loadoutConfig: { ...app.loadoutConfig, mutators: [...(app.loadoutConfig.mutators || [])] },
            playerRegenDelay: app.player.regenDelay,
            playerRegenCap: app.player.regenCap,
            voiceSpeaking: app.voice.isSpeaking(),
            voiceMode: app.audio.voiceMode,
            voicePackLoaded: !!(activeVoicePack && activeVoicePack.clips),
            voiceCount: activeVoicePack && activeVoicePack.clips ? Object.keys(activeVoicePack.clips).length : 0,
            trauma: +app.player.trauma.toFixed(2),
            activeBarrels: app.level.barrels.filter((b) => b.state !== 'exploded').length,
          };
        },
        setLang(lang, persist = true) {
          return app._applyLanguage(lang, persist);
        },
        startDirect() {
          app.audio.init();
          app._startCombatMission();
          if (app.dialog.open) app.dialog.close();
          app.state = 'PLAYING';
          app.audio.setPaused(false);
          app.voice.setPaused(false);
          app.lastFrameTime = performance.now();
        },
        startTutorial() {
          app.audio.init();
          app._startTutorial();
          if (app.dialog.open) app.dialog.close();
          app.state = 'PLAYING';
          app.audio.setPaused(false);
          app.voice.setPaused(false);
          app.lastFrameTime = performance.now();
        },
        startTraining(submode = 'timed', config = {}) {
          app.audio.init();
          app._startTraining(submode, { ...app.trainingConfig, ...config, submode });
          if (app.dialog.open) app.dialog.close();
          app.state = 'PLAYING';
          app.audio.setPaused(false);
          app.voice.setPaused(false);
          app.lastFrameTime = performance.now();
        },
        skipTutorial() {
          app.skipTutorial();
        },
        resetTutorialStorage() {
          try { window.localStorage.removeItem(TUT_STORAGE_KEY); } catch (e) {}
          app._syncMenuButtons();
        },
        setLook(yaw, pitch) {
          app.player.yaw = yaw;
          app.player.pitch = pitch;
        },
        teleport(x, y, z) {
          app.player.pos.set(x, y, z);
          app.player.vel.set(0, 0, 0);
        },
        severRelay(idx, method = 'hack') {
          const r = app.level.relays[idx];
          if (r && !r.severed) app._completeRelaySever(r, method);
        },
        triggerShot() {
          app.weapon._fireOneShot(app.player, app.enemies, (c, k, b) => app.hud.triggerHitmarker(c, k, b));
        },
        triggerScan() {
          app._triggerTacticalScan();
        },
        playVoice(clipId) {
          return app.hud.showRadio(null, null, 5.5, false, { voiceId: clipId, priority: 3 });
        },
        triggerTestDamage(x, z, dmg = 18) {
          const src = new THREE.Vector3(x, 1.2, z);
          app.player.takeDamage(dmg, src);
        },
        explodeBarrel(idx = 0) {
          const b = app.level.barrels[idx];
          if (b && b.state !== 'exploded') app._triggerBarrelExplosion(b);
        },
      };
    }

    _loop(now) {
      requestAnimationFrame(this._loop);
      const rawDt = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;
      const dt = Math.min(0.05, Math.max(0.001, rawDt));

      if (rawDt > 0.001 && rawDt < 0.5) {
        const instFps = 1 / rawDt;
        this.fpsSmooth = this.fpsSmooth * 0.9 + instFps * 0.1;
      }

      if (this.state === 'PLAYING') {
        this.elapsedTime += dt;
        if (this.scanCooldown > 0) this.scanCooldown = Math.max(0, this.scanCooldown - dt);
        if (this.meleeCooldown > 0) this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
        this.missionState.scanCooldown = this.scanCooldown;

        for (let i = this.activeC4Relays.length - 1; i >= 0; i--) {
          const r = this.activeC4Relays[i];
          if (r.severed || !r.c4Planted) {
            this.activeC4Relays.splice(i, 1);
            continue;
          }
          r.c4Timer -= dt;
          if (r.c4Timer <= 0) {
            this.activeC4Relays.splice(i, 1);
            this._detonateRelayC4(r);
          }
        }

        if (this.missionState.phase === 'EVAC_HOLDOUT') {
          this.missionState.holdoutTimer = Math.max(0, (this.missionState.holdoutTimer || 0) - dt);
          if (this.missionState.holdoutTimer <= 15 && !this.holdout15Spoken) {
            this.holdout15Spoken = true;
            const diffCfg = this._getEffectiveDiffConfig(false);
            this.enemies.spawnCombatEnemy('hound', new THREE.Vector3(14.5, 0, -24.5), this._buildEnemyDiffOpts(diffCfg, {
              alertImmediately: true,
            }));
            this.enemies.spawnCombatEnemy('drone', new THREE.Vector3(21.0, 6.8, -14.0), this._buildEnemyDiffOpts(diffCfg, {
              alertImmediately: true,
            }));
            this.hud.showRadio(
              I18n.t('app.speaker.evac'),
              I18n.t('app.radio.holdout15s'),
              4.8,
              false,
              {
                voiceId: 'evac_holdout_15s',
                role: 'evac',
                priority: 3,
                speakerKey: 'app.speaker.evac',
                textKey: 'app.radio.holdout15s',
              }
            );
          }
          if (this.missionState.holdoutTimer <= 0) {
            this.missionState.phase = 'EXTRACT';
            this.audio.playAlarmKlaxon(2);
            this.audio.playRadioBeep();
            this.hud.showRadio(
              I18n.t('app.speaker.evac'),
              I18n.t('app.radio.evacUnlocked'),
              6.5,
              false,
              {
                voiceId: 'evac_unlocked',
                role: 'evac',
                priority: 3,
                speakerKey: 'app.speaker.evac',
                textKey: 'app.radio.evacUnlocked',
              }
            );
          }
        }

        this.player.update(dt);
        if (this.audio.updateListener) {
          this.audio.updateListener(this.player.pos, this.player.yaw);
        }
        this.audio.updateEnvironment(this.player.indoors, dt);
        this.weapon.updateThrowables(dt, this.enemies, {
          playerPos: this.player.pos,
          onExplosion: (expPos) => {
            const d = this.player.pos.distanceTo(expPos);
            if (d < 12) this.player.addTrauma(Math.max(0.15, (1 - d / 12) * 0.5));
            if (d < 7.5 && this.audio.playTinnitusFlash) {
              this.audio.playTinnitusFlash(Math.min(1, 1 - d / 9));
            }
          },
        });
        if (this.weapon.isPreviewingThrow) {
          this.render.camera.getWorldDirection(this._aimDirTmp);
          this.weapon.updateThrowPreview(this.render.camera.position, this._aimDirTmp);
        }
        this.weapon.update(dt, this.player, this.enemies, (isCrit, isKill, blockedByShield) => {
          this.hud.triggerHitmarker(isCrit, isKill, blockedByShield);
          if (blockedByShield && !this.tutorial.active && !this.training.isTimedSafe()) {
            this.hud.showRadio(
              I18n.t('app.speaker.watcher'),
              I18n.t('app.radio.shieldWarn'),
              4.8,
              false,
              {
                voiceId: 'enemy_shield_warn',
                role: 'watcher',
                priority: 2,
                cooldownSec: 22,
                tacOnly: true,
                speakerKey: 'app.speaker.watcher',
                textKey: 'app.radio.shieldWarn',
              }
            );
          }
          if (isKill && !this.tutorial.active && !this.training.isTimedSafe()) {
            this.weapon.grantKillAmmoDrop();
          }
        });
        this.enemies.update(dt, this.player.pos, this.player);
        this._updateInteraction(dt);
        this.tutorial.update(dt);
        this.training.update(dt);
        this.level.update(dt, this.missionState.lockdown);

        const st = this.enemies.getStealthStatus ? this.enemies.getStealthStatus() : { maxState: 'PATROL', sniperLocking: false };
        if (st.sniperLocking && !this.sniperWarnSpoken && !this.tutorial.active && !this.training.isTimedSafe()) {
          this.sniperWarnSpoken = true;
          this.hud.showRadio(
            I18n.t('app.speaker.watcher'),
            I18n.t('app.radio.sniperWarn'),
            4.5,
            false,
            {
              voiceId: 'enemy_laser_warn',
              role: 'watcher',
              priority: 2,
              cooldownSec: 18,
              tacOnly: true,
              speakerKey: 'app.speaker.watcher',
              textKey: 'app.radio.sniperWarn',
            }
          );
        } else if (!st.sniperLocking) {
          this.sniperWarnSpoken = false;
        }

        let musicMode = 'off';
        if (!this.tutorial.active && !this.training.isTimedSafe()) {
          if (this.missionState.phase === 'EVAC_HOLDOUT' || this.missionState.phase === 'EXTRACT') {
            musicMode = 'holdout';
          } else if (st.maxState === 'COMBAT') {
            musicMode = 'combat';
          } else {
            musicMode = 'stealth';
          }
        }
        this.audio.setMusicMode(musicMode);

        const lowHpFactor = !this.training.isTimedSafe() && this.player.hp < 40
          ? Math.min(1, (40 - this.player.hp) / 30)
          : 0;
        this.audio.setLowHpFactor(lowHpFactor);
        this.render.setEnvironmentEffects({
          indoors: this.player.indoors,
          lowHpFactor,
          blackout: this.player.blackoutMutator,
        });

        if (!this.tutorial.active && !this.training.isTimedSafe() && this.player.hp <= 0) {
          if (this.training.active) {
            this._endTraining(false);
          } else {
            this._endMission(false);
          }
        }
      } else {
        // 菜单背景维持微弱雨景与海面动态渲染（页面隐藏时不浪费算力）
        if (!document.hidden) {
          this.level.update(dt * 0.5, false);
        }
      }

      if (!document.hidden) {
        const optics = this.weapon.getOpticsTelemetry ? this.weapon.getOpticsTelemetry() : null;
        this.render.update(dt, this.weapon.muzzleWorldPos, this.weapon.muzzleLight.intensity, optics);
        this.render.render();
      }

      if (this.state === 'PLAYING') {
        this.hud.update(dt, this.render.camera, this.player, this.weapon, this.level, this.enemies, this.missionState, this.fpsSmooth, this.tutorial, this.training);
      }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    window.__GAME_APP__ = new App();
  });

  return App;
})();
