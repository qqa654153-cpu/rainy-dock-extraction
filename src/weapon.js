// ============================================================================
// 模块 5：第一人称步枪、全息开镜 (ADS)、枪械晃动、换弹与命中系统 (WeaponSystem)
// ============================================================================

const WeaponSystem = (() => {
  'use strict';

  class Weapon {
    constructor(camera, scene, texFactory, audio, renderEngine, level) {
      this.camera = camera;
      this.scene = scene;
      this.tex = texFactory;
      this.audio = audio;
      this.render = renderEngine;
      this.level = level;

      this.primaryId = 'car47';
      this.skinId = 'standard';
      this.activeSlot = 'primary';
      this.perks = {};
      this.diffModifiers = {
        aimAssistDeg: 0,
        recoilScale: 1.0,
        spreadScale: 1.0,
        playerCritBonus: 0,
        ammoReserveMult: 1.0,
      };

      this.slots = {
        primary: { id: 'car47', ammo: 30, reserve: 150, suppressorAttached: false },
        secondary: { id: 'pistol', ammo: 15, reserve: 90, suppressorAttached: true },
      };

      this.throwableOrder = ['emp', 'frag', 'decoy'];
      this.activeThrowableIdx = 0;
      this.throwables = { emp: 2, frag: 2, decoy: 2 };
      this.activeGrenades = [];

      this.fireTimer = 0;
      this.isFiring = false;
      this._triggerConsumed = false;
      this.isADS = false;
      this.adsAlpha = 0;
      this.ads3DHidden = false;
      this.flashlightOn = true;

      this.isReloading = false;
      this.reloadDuration = 1.65;
      this.reloadTimer = 0;
      this.reloadStagesPlayed = { out: false, in: false, bolt: false };
      this.swapTimer = 0;
      this.meleeSwingTimer = 0;

      // 枪械动作与后坐力状态
      this.recoilZ = 0;
      this.recoilPitch = 0;
      this.camRecoilPitch = 0;
      this.camRecoilYaw = 0;
      this.burstCount = 0;
      this.timeSinceShot = 1;
      this.boltOffset = 0;
      this.swayX = 0;
      this.swayY = 0;
      this.bobPhase = 0;
      this.onBarrelHit = null;
      this.onBreakerHit = null;
      this.onEmptyReload = null;
      this.onLowReserve = null;
      this._lowReserveWarned = false;

      this.muzzleFlashTimer = 0;
      this.muzzleHeat = 0;
      this.muzzleWorldPos = new THREE.Vector3();
      this.extremeDetailEnabled = false;
      this.extremeGroups = [];
      this._vmFabrics = [];
      this._vmMetalExtras = [];
      this._vmOpticGlasses = [];
      this._bouncePos = new THREE.Vector3();
      this._flashOrigin = new THREE.Vector3();
      this._flashDir = new THREE.Vector3();
      this._upVec = new THREE.Vector3(0, 1, 0);
      this._grenadeBodyGeo = null;
      this._grenadeGlowGeo = null;
      this._grenadeBodyMat = null;
      this._grenadeGlowMats = new Map();

      this.stats = {
        shotsFired: 0,
        shotsHit: 0,
        crits: 0,
      };

      // 预分配射线与池化对象
      this._raycaster = new THREE.Raycaster();
      this._rayOrigin = new THREE.Vector3();
      this._rayDir = new THREE.Vector3();
      this._centerNDC = new THREE.Vector2(0, 0);
      this._baseDirTmp = new THREE.Vector3();
      this._hitEnd = new THREE.Vector3();
      this._normTmp = new THREE.Vector3();
      this._casingRight = new THREE.Vector3();
      this._casingUp = new THREE.Vector3();
      this._tracerCur = new THREE.Vector3();
      this._tmpCheckPos = new THREE.Vector3();
      this._assistTmpPos = new THREE.Vector3();
      this._assistOutDir = new THREE.Vector3();
      this._previewPos = new THREE.Vector3();
      this._previewPrevPos = new THREE.Vector3();
      this._previewVel = new THREE.Vector3();
      this.isPreviewingThrow = false;

      this._buildWeaponModels();
      this._initCasingsAndTracers();
      this._initThrowPreview();
      this.resetArsenal('car47', 'standard', []);
    }

    get currentSlot() {
      return this.slots[this.activeSlot] || this.slots.primary;
    }

    get currentConfig() {
      const cat = window.GameLogic && window.GameLogic.WEAPON_CATALOG;
      if (!cat) {
        return {
          id: 'car47', slot: 1, name: 'CAR-47 战术卡宾枪', shortName: 'CAR-47',
          magSize: 30, maxReserve: 150, fireRate: 0.092, baseDamage: 27, critMult: 2.0,
          armorPierce: 0.15, hipSpread: 0.015, adsSpread: 0.0018, adsFov: 49,
          tacReloadTime: 1.48, emptyReloadTime: 1.92, noiseLoud: 40, noiseSuppressed: 11,
          pellets: 1, silencerDamageMult: 0.9, auto: true, recoilKick: 1.0, defaultSuppressed: false,
        };
      }
      return cat[this.currentSlot.id] || cat.car47;
    }

    get ammo() {
      return this.currentSlot.ammo;
    }
    set ammo(v) {
      this.currentSlot.ammo = Math.max(0, v);
    }

    get reserveAmmo() {
      return this.currentSlot.reserve;
    }
    set reserveAmmo(v) {
      this.currentSlot.reserve = Math.max(0, v);
    }

    get magSize() {
      const base = this.currentConfig.magSize;
      return this.perks.extended_pouches ? Math.round(base * 1.3) : base;
    }

    get maxReserve() {
      const base = this.currentConfig.maxReserve;
      const perkMul = this.perks.extended_pouches ? 1.3 : 1.0;
      const diffMul = (this.diffModifiers && this.diffModifiers.ammoReserveMult) || 1.0;
      return Math.round(base * perkMul * diffMul);
    }

    setDifficultyModifiers(diffCfg = {}) {
      const prevMult = (this.diffModifiers && this.diffModifiers.ammoReserveMult) || 1.0;
      const nextMult = Math.max(0.5, Number(diffCfg && diffCfg.ammoReserveMult) || 1.0);
      this.diffModifiers = {
        aimAssistDeg: Math.max(0, Number(diffCfg && diffCfg.aimAssistDeg) || 0),
        recoilScale: Math.max(0.2, Number(diffCfg && diffCfg.recoilScale) || 1.0),
        spreadScale: Math.max(0.2, Number(diffCfg && diffCfg.spreadScale) || 1.0),
        playerCritBonus: Math.max(0, Number(diffCfg && diffCfg.playerCritBonus) || 0),
        ammoReserveMult: nextMult,
      };
      if (Math.abs(nextMult - prevMult) > 0.01 && this.slots) {
        const perkMul = this.perks.extended_pouches ? 1.3 : 1.0;
        for (const key of ['primary', 'secondary']) {
          const sl = this.slots[key];
          if (!sl) continue;
          const cfg = this._getWeaponConfigById(sl.id);
          const cap = Math.round(cfg.maxReserve * perkMul * nextMult);
          sl.reserve = Math.min(cap, Math.round(sl.reserve * (nextMult / prevMult)));
        }
      }
    }

    get suppressorAttached() {
      return !!this.currentSlot.suppressorAttached;
    }

    get activeThrowableId() {
      return this.throwableOrder[this.activeThrowableIdx] || 'emp';
    }

    _getWeaponConfigById(id) {
      const cat = window.GameLogic && window.GameLogic.WEAPON_CATALOG;
      return (cat && cat[id]) || this.currentConfig;
    }

    _buildTacticalArms(parent, isPistol = false) {
      const sleeveMat = new THREE.MeshPhysicalMaterial({ color: 0x1a212b, roughness: 0.85, metalness: 0.1 });
      const gloveMat = new THREE.MeshPhysicalMaterial({ color: 0x11151b, roughness: 0.72, metalness: 0.18 });
      const cuffMat = new THREE.MeshPhysicalMaterial({ color: 0x2a3340, roughness: 0.6, metalness: 0.3 });
      this._vmFabrics.push(sleeveMat, gloveMat);

      const armExt = new THREE.Group();
      armExt.visible = this.extremeDetailEnabled;
      const armorMat = new THREE.MeshPhysicalMaterial({ color: 0x181d25, roughness: 0.38, metalness: 0.45 });
      this._vmMetalExtras.push(armorMat);

      if (!isPistol) {
        // 右手握持扳机手腕与小臂
        const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.068, 0.28), sleeveMat);
        rArm.position.set(0.032, -0.105, 0.185);
        rArm.rotation.set(0.28, -0.22, 0.12);
        parent.add(rArm);

        const rGlove = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.064, 0.078), gloveMat);
        rGlove.position.set(0.004, -0.075, 0.052);
        rGlove.rotation.x = 0.28;
        parent.add(rGlove);

        // 左手护木托枪手臂与战术护腕
        const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.064, 0.34), sleeveMat);
        lArm.position.set(-0.088, -0.108, -0.04);
        lArm.rotation.set(0.24, -0.42, -0.28);
        parent.add(lArm);

        const lCuff = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.068, 0.04), cuffMat);
        lCuff.position.set(-0.04, -0.084, -0.14);
        lCuff.rotation.set(0.24, -0.42, -0.28);
        parent.add(lCuff);

        const lGlove = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.052, 0.072), gloveMat);
        lGlove.position.set(-0.006, -0.046, -0.235);
        lGlove.rotation.set(-0.1, -0.18, 0.15);
        parent.add(lGlove);

        // 极限画质：手套指节护甲、袖扣卡扣与左手腕战术荧光表盘
        const knuckleR = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.016, 0.045), armorMat);
        knuckleR.position.set(0.004, -0.048, 0.046);
        knuckleR.rotation.x = 0.28;
        armExt.add(knuckleR);

        const knuckleL = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.016, 0.042), armorMat);
        knuckleL.position.set(-0.006, -0.025, -0.235);
        knuckleL.rotation.set(-0.1, -0.18, 0.15);
        armExt.add(knuckleL);

        const watchCase = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 16), armorMat);
        watchCase.position.set(-0.036, -0.05, -0.135);
        watchCase.rotation.set(0.25, -0.35, -0.38);
        armExt.add(watchCase);

        const watchDial = new THREE.Mesh(
          new THREE.CircleGeometry(0.013, 16),
          new THREE.MeshBasicMaterial({ color: 0x38e2b5 })
        );
        watchDial.position.set(-0.038, -0.0435, -0.134);
        watchDial.rotation.set(-Math.PI / 2 + 0.25, 0, -0.35);
        armExt.add(watchDial);
      } else {
        const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.064, 0.3), sleeveMat);
        rArm.position.set(0.025, -0.115, 0.16);
        rArm.rotation.set(0.32, -0.14, 0.08);
        parent.add(rArm);

        const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.062, 0.3), sleeveMat);
        lArm.position.set(-0.042, -0.125, 0.145);
        lArm.rotation.set(0.34, 0.24, -0.1);
        parent.add(lArm);

        const gripHands = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.076, 0.08), gloveMat);
        gripHands.position.set(0, -0.072, 0.012);
        gripHands.rotation.x = 0.22;
        parent.add(gripHands);

        const knuckleGrip = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.018, 0.048), armorMat);
        knuckleGrip.position.set(0, -0.044, -0.008);
        knuckleGrip.rotation.x = 0.22;
        armExt.add(knuckleGrip);
      }
      parent.add(armExt);
      this.extremeGroups.push(armExt);
    }

    _buildWeaponModels() {
      this.viewmodelRoot = new THREE.Group();
      this.viewmodelRoot.userData.isViewmodel = true;
      this.camera.add(this.viewmodelRoot);
      this.render.puddleReflector.hiddenObjects.push(this.viewmodelRoot);

      const vmRimLight = new THREE.PointLight(0x88b8e6, 2.3, 1.45, 1.5);
      vmRimLight.position.set(0.14, 0.16, -0.15);
      this.viewmodelRoot.add(vmRimLight);

      // 共用枪灯挂载在 viewmodelRoot，主/副武器切换都保持照明
      this.flashlight = new THREE.SpotLight(0xdff0ff, 55, 42, 0.42, 0.55, 1.4);
      this.flashlight.position.set(0.12, -0.16, -0.45);
      const flashTarget = new THREE.Object3D();
      flashTarget.position.set(0.0, -0.12, -14);
      this.viewmodelRoot.add(flashTarget);
      this.flashlight.target = flashTarget;
      this.viewmodelRoot.add(this.flashlight);

      // 主副武器定位基准
      this.hipPos = new THREE.Vector3(0.22, -0.21, -0.44);
      this.adsPos = new THREE.Vector3(0.0, -0.095, -0.34);
      this.pistolHipPos = new THREE.Vector3(0.18, -0.20, -0.37);
      this.pistolAdsPos = new THREE.Vector3(0.0, -0.0545, -0.29);

      this.rifleGroup = new THREE.Group();
      this.rifleGroup.position.copy(this.hipPos);
      this.viewmodelRoot.add(this.rifleGroup);

      this._skinMetalMat = this.tex.gunMetal.clone();
      this._skinAccentMat = new THREE.MeshPhysicalMaterial({ color: 0x3b424d, metalness: 0.78, roughness: 0.35 });
      const metal = this._skinMetalMat;
      const polymer = this.tex.gunPolymer;
      const accent = this._skinAccentMat;
      const suppressorMat = new THREE.MeshPhysicalMaterial({ color: 0x191d24, metalness: 0.85, roughness: 0.32 });
      this._vmMetalExtras.push(suppressorMat);

      const addPart = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = this.rifleGroup) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        parent.add(m);
        return m;
      };

      // 上下机匣 + 导轨 + 护木
      addPart(new THREE.BoxGeometry(0.052, 0.068, 0.26), metal, 0, 0.0, -0.02);
      addPart(new THREE.BoxGeometry(0.056, 0.014, 0.34), accent, 0, 0.04, -0.06);
      addPart(new THREE.BoxGeometry(0.048, 0.052, 0.24), accent, 0, 0.008, -0.27);
      addPart(new THREE.CylinderGeometry(0.011, 0.012, 0.36, 12), metal, 0, 0.01, -0.42, Math.PI / 2);
      addPart(new THREE.CylinderGeometry(0.017, 0.015, 0.075, 10), metal, 0, 0.01, -0.61, Math.PI / 2);

      // DMR 加长枪管；Shotgun 下挂供弹管 + 泵动护木（不使用阻塞狙击筒名）
      this.dmrBarrelExt = addPart(new THREE.CylinderGeometry(0.01, 0.011, 0.16, 10), metal, 0, 0.01, -0.68, Math.PI / 2);
      this.shotgunUnderTube = addPart(new THREE.CylinderGeometry(0.013, 0.013, 0.34, 10), metal, 0, -0.018, -0.42, Math.PI / 2);
      this.shotgunPump = addPart(new THREE.BoxGeometry(0.044, 0.036, 0.15), polymer, 0, -0.02, -0.34);

      // 主武器消音器 [T] 热拔插
      this.rifleSuppressorMesh = addPart(new THREE.CylinderGeometry(0.021, 0.021, 0.19, 14), suppressorMat, 0, 0.01, -0.74, Math.PI / 2);
      this.rifleSuppressorMesh.visible = false;

      // 枪托、握把、弹匣、活动枪机
      addPart(new THREE.BoxGeometry(0.04, 0.048, 0.2), polymer, 0, -0.005, 0.2);
      addPart(new THREE.BoxGeometry(0.044, 0.11, 0.045), polymer, 0, -0.035, 0.29);
      addPart(new THREE.BoxGeometry(0.036, 0.105, 0.046), polymer, 0, -0.072, 0.055, 0.28);
      addPart(new THREE.BoxGeometry(0.032, 0.075, 0.042), polymer, 0, -0.046, -0.24, -0.22);

      this.magGroup = new THREE.Group();
      this.magGroup.position.set(0, -0.04, -0.065);
      addPart(new THREE.BoxGeometry(0.032, 0.145, 0.058), accent, 0, -0.06, 0, 0.14, 0, 0, this.magGroup);
      this.rifleGroup.add(this.magGroup);

      const boltMat = new THREE.MeshPhysicalMaterial({
        color: 0x8f98a3, metalness: 0.92, roughness: 0.2,
      });
      this._vmMetalExtras.push(boltMat);
      this.boltMesh = addPart(new THREE.BoxGeometry(0.014, 0.022, 0.065), boltMat, 0.024, 0.014, -0.03);

      // 瞄具 A (CAR-47)：宽视窗高通透 3D 全息瞄准镜
      const holo = new THREE.Group();
      holo.position.set(0, 0.048, -0.04);
      addPart(new THREE.BoxGeometry(0.056, 0.012, 0.088), metal, 0, 0.006, 0, 0, 0, 0, holo);
      addPart(new THREE.BoxGeometry(0.0055, 0.058, 0.074), accent, -0.030, 0.041, 0, 0, 0, 0, holo);
      addPart(new THREE.BoxGeometry(0.0055, 0.058, 0.074), accent, 0.030, 0.041, 0, 0, 0, 0, holo);
      addPart(new THREE.BoxGeometry(0.066, 0.0055, 0.074), accent, 0, 0.072, 0, 0, 0, 0, holo);
      const lensMat = new THREE.MeshBasicMaterial({
        color: 0x4ca8ff, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
      });
      const lensMesh = addPart(new THREE.PlaneGeometry(0.054, 0.054), lensMat, 0, 0.043, 0.018, 0, 0, 0, holo);
      lensMesh.renderOrder = 5;
      const reticleMat = new THREE.MeshBasicMaterial({
        map: this.tex.holoReticleTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95,
      });
      this.reticleMesh = addPart(new THREE.PlaneGeometry(0.036, 0.036), reticleMat, 0, 0.047, 0, 0, 0, 0, holo);
      this.reticleMesh.renderOrder = 6;
      this.holoGroup = holo;
      this.rifleGroup.add(this.holoGroup);

      // 瞄具 B (M890 霰弹枪)：无顶框开放式宽环反射红点
      const sgReflex = new THREE.Group();
      sgReflex.position.set(0, 0.048, -0.035);
      addPart(new THREE.BoxGeometry(0.058, 0.011, 0.072), metal, 0, 0.0055, 0, 0, 0, 0, sgReflex);
      addPart(new THREE.BoxGeometry(0.005, 0.046, 0.054), accent, -0.029, 0.032, 0, 0, 0, -0.1, sgReflex);
      addPart(new THREE.BoxGeometry(0.005, 0.046, 0.054), accent, 0.029, 0.032, 0, 0, 0, 0.1, sgReflex);
      const sgGlassMat = new THREE.MeshBasicMaterial({
        color: 0x38e6ff, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide,
      });
      const sgGlass = addPart(new THREE.PlaneGeometry(0.052, 0.048), sgGlassMat, 0, 0.042, 0.012, 0, 0, 0, sgReflex);
      sgGlass.renderOrder = 5;
      const sgReticleMat = new THREE.MeshBasicMaterial({
        map: this.tex.reflexCircleTex || this.tex.holoReticleTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.94,
      });
      this.sgReticleMesh = addPart(new THREE.PlaneGeometry(0.042, 0.042), sgReticleMat, 0, 0.047, 0, 0, 0, 0, sgReflex);
      this.sgReticleMesh.renderOrder = 6;
      sgReflex.visible = false;
      this.sgReflexGroup = sgReflex;
      this.rifleGroup.add(this.sgReflexGroup);

      // 瞄具 C (MK-14 DMR)：中空无遮挡长镜筒外观（openEnded=true + 环框，开镜到位切入 2.5D V字狙击镜）
      const dmrScope = new THREE.Group();
      dmrScope.position.set(0, 0.095, -0.055);
      const hollowTubeMat = new THREE.MeshPhysicalMaterial({
        color: 0x262d38, metalness: 0.84, roughness: 0.3, side: THREE.DoubleSide,
      });
      this._vmMetalExtras.push(hollowTubeMat);
      addPart(new THREE.CylinderGeometry(0.021, 0.019, 0.21, 18, 1, true), hollowTubeMat, 0, 0, 0, Math.PI / 2, 0, 0, dmrScope);
      addPart(new THREE.TorusGeometry(0.0215, 0.0028, 8, 22), metal, 0, 0, 0.104, 0, 0, 0, dmrScope);
      addPart(new THREE.TorusGeometry(0.0195, 0.0026, 8, 22), metal, 0, 0, -0.104, 0, 0, 0, dmrScope);
      addPart(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 10), accent, 0, 0.024, 0, 0, 0, 0, dmrScope);
      addPart(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 10), accent, 0.024, 0, 0, 0, 0, Math.PI / 2, dmrScope);
      addPart(new THREE.BoxGeometry(0.018, 0.032, 0.022), metal, 0, -0.028, -0.04, 0, 0, 0, dmrScope);
      addPart(new THREE.BoxGeometry(0.018, 0.032, 0.022), metal, 0, -0.028, 0.04, 0, 0, 0, dmrScope);
      const dmrGlassMat = new THREE.MeshBasicMaterial({
        color: 0x3ba8e6, transparent: true, opacity: 0.11, depthWrite: false, side: THREE.DoubleSide,
      });
      const dmrGlass = addPart(new THREE.CircleGeometry(0.0185, 18), dmrGlassMat, 0, 0, 0.06, 0, 0, 0, dmrScope);
      dmrGlass.renderOrder = 5;
      dmrScope.visible = false;
      this.dmrScopeGroup = dmrScope;
      this.rifleGroup.add(this.dmrScopeGroup);

      // 侧挂电筒外观与战术小臂手套
      addPart(new THREE.CylinderGeometry(0.014, 0.014, 0.095, 10), metal, -0.034, 0.008, -0.32, Math.PI / 2);
      this._buildTacticalArms(this.rifleGroup, false);

      // 副手枪 (USP-9 幽灵) 模型
      this.pistolGroup = new THREE.Group();
      this.pistolGroup.position.copy(this.pistolHipPos);
      this.pistolGroup.visible = false;
      this.viewmodelRoot.add(this.pistolGroup);

      addPart(new THREE.BoxGeometry(0.034, 0.026, 0.21), polymer, 0, 0.005, -0.08, 0, 0, 0, this.pistolGroup);
      this.pistolSlideMesh = addPart(new THREE.BoxGeometry(0.035, 0.028, 0.22), metal, 0, 0.032, -0.085, 0, 0, 0, this.pistolGroup);
      addPart(new THREE.BoxGeometry(0.031, 0.095, 0.042), polymer, 0, -0.052, -0.01, 0.26, 0, 0, this.pistolGroup);
      // 抬高开放式氚光三点机械准星（开镜清晰对齐正中）
      const triMat = new THREE.MeshBasicMaterial({ color: 0x38f294 });
      addPart(new THREE.BoxGeometry(0.0038, 0.009, 0.006), triMat, 0, 0.0535, -0.19, 0, 0, 0, this.pistolGroup);
      addPart(new THREE.BoxGeometry(0.0042, 0.009, 0.006), triMat, -0.012, 0.0545, 0.012, 0, 0, 0, this.pistolGroup);
      addPart(new THREE.BoxGeometry(0.0042, 0.009, 0.006), triMat, 0.012, 0.0545, 0.012, 0, 0, 0, this.pistolGroup);
      this.pistolMagGroup = new THREE.Group();
      this.pistolMagGroup.position.set(0, -0.04, -0.01);
      addPart(new THREE.BoxGeometry(0.024, 0.09, 0.032), accent, 0, -0.045, 0, 0.26, 0, 0, this.pistolMagGroup);
      this.pistolGroup.add(this.pistolMagGroup);
      this.pistolSuppressorMesh = addPart(new THREE.CylinderGeometry(0.016, 0.016, 0.155, 12), suppressorMat, 0, 0.03, -0.27, Math.PI / 2, 0, 0, this.pistolGroup);
      this._buildTacticalArms(this.pistolGroup, true);

      // 枪口锚点与火焰（挂在 viewmodelRoot 下，随开火切同步位移）
      this.muzzleAnchor = new THREE.Object3D();
      this.muzzleAnchor.position.set(0, 0.01, -0.66);
      this.rifleGroup.add(this.muzzleAnchor);
      this.pistolMuzzleAnchor = new THREE.Object3D();
      this.pistolMuzzleAnchor.position.set(0, 0.03, -0.35);
      this.pistolGroup.add(this.pistolMuzzleAnchor);

      const flashMat = new THREE.MeshBasicMaterial({
        map: this.tex.muzzleFlashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      this.muzzleGroup = new THREE.Group();
      const p1 = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), flashMat);
      const p2 = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), flashMat);
      p2.rotation.z = Math.PI / 4;
      const p3 = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.15), flashMat);
      p3.rotation.y = Math.PI / 2;
      this.muzzleGroup.add(p1, p2, p3);
      this.muzzleGroup.visible = false;
      this.viewmodelRoot.add(this.muzzleGroup);

      this.muzzleLight = this.render.createVirtualLight({
        color: 0xff9b3d,
        intensity: 0,
        distance: 18,
        decay: 1.5,
        x: 0,
        y: -0.05,
        z: -0.95,
        hostObject: this.viewmodelRoot,
        priority: 10.0,
      });

      this._buildExtremeWeaponDetails(metal, accent, suppressorMat);
    }

    _buildExtremeWeaponDetails(metal, accent, suppressorMat) {
      if (typeof ExtremeGfx === 'undefined' || !ExtremeGfx.mergeGeometriesSafe) return;
      const tx = ExtremeGfx.createTransformedGeo;
      const merge = ExtremeGfx.mergeGeometriesSafe;

      // 1. 步枪 CNC 皮卡汀尼导轨齿 / 倒角扳机护圈 / 护木散热孔 / 侧挂电筒灯杯
      const rifleMetalGeos = [];
      const rifleAccentGeos = [];

      // 顶部导轨 22 道精密齿槽 + 护木侧导轨齿
      for (let i = 0; i < 20; i++) {
        const z = 0.095 - i * 0.0165;
        if (Math.abs(z + 0.04) > 0.048) {
          rifleAccentGeos.push(tx(new THREE.BoxGeometry(0.046, 0.0055, 0.0075), { y: 0.0485, z }));
        }
      }
      for (let i = 0; i < 8; i++) {
        const z = -0.17 - i * 0.025;
        rifleAccentGeos.push(tx(new THREE.BoxGeometry(0.005, 0.016, 0.012), { x: -0.026, y: 0.008, z }));
        rifleAccentGeos.push(tx(new THREE.BoxGeometry(0.005, 0.016, 0.012), { x: 0.026, y: 0.008, z }));
      }
      // 倒角 ExtrudeGeometry 扳机护圈与拉机柄
      const guardShape = new THREE.Shape();
      guardShape.moveTo(-0.024, 0.0);
      guardShape.lineTo(0.024, 0.0);
      guardShape.lineTo(0.016, -0.028);
      guardShape.lineTo(-0.02, -0.028);
      guardShape.closePath();
      const guardGeo = new THREE.ExtrudeGeometry(guardShape, {
        depth: 0.012,
        bevelEnabled: true,
        bevelThickness: 0.002,
        bevelSize: 0.002,
        bevelSegments: 1,
      });
      guardGeo.rotateY(Math.PI / 2);
      rifleMetalGeos.push(tx(guardGeo, { x: -0.006, y: -0.036, z: 0.018 }));
      rifleMetalGeos.push(tx(new THREE.BoxGeometry(0.009, 0.022, 0.005), { y: -0.045, z: 0.022, rx: 0.25 }));

      // 气体调节阀、准星底座、枪背带环与电筒防眩灯环
      rifleMetalGeos.push(tx(new THREE.CylinderGeometry(0.014, 0.014, 0.028, 12), { y: 0.018, z: -0.42, rx: Math.PI / 2 }));
      rifleMetalGeos.push(tx(new THREE.TorusGeometry(0.016, 0.003, 8, 16), { x: -0.034, y: 0.008, z: -0.37 }));
      rifleMetalGeos.push(tx(new THREE.BoxGeometry(0.034, 0.01, 0.026), { y: 0.028, z: 0.11 }));
      rifleAccentGeos.push(tx(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 8), { x: -0.029, y: -0.014, z: 0.01, rz: Math.PI / 2 }));

      const rifleExtGroup = new THREE.Group();
      rifleExtGroup.visible = this.extremeDetailEnabled;
      const rmGeo = merge(rifleMetalGeos);
      const raGeo = merge(rifleAccentGeos);
      if (rmGeo) rifleExtGroup.add(new THREE.Mesh(rmGeo, metal));
      if (raGeo) rifleExtGroup.add(new THREE.Mesh(raGeo, accent));
      this.rifleGroup.add(rifleExtGroup);
      this.extremeGroups.push(rifleExtGroup);

      // 2. DMR 光学瞄具外围滚花调节塔环与消光蜂窝前环（绝不阻挡中间视窗）
      const dmrGeos = [];
      dmrGeos.push(tx(new THREE.CylinderGeometry(0.0075, 0.0075, 0.007, 14), { y: 0.030 }));
      dmrGeos.push(tx(new THREE.CylinderGeometry(0.0075, 0.0075, 0.007, 14), { x: 0.030, rz: Math.PI / 2 }));
      dmrGeos.push(tx(new THREE.TorusGeometry(0.022, 0.0022, 6, 20), { z: 0.068 }));
      dmrGeos.push(tx(new THREE.BoxGeometry(0.004, 0.012, 0.005), { x: -0.018, y: 0.018, z: 0.068, rz: 0.6 }));
      const dmrOpticExtGroup = new THREE.Group();
      dmrOpticExtGroup.visible = this.extremeDetailEnabled;
      const dmrM = merge(dmrGeos);
      if (dmrM) dmrOpticExtGroup.add(new THREE.Mesh(dmrM, accent));
      this.dmrScopeGroup.add(dmrOpticExtGroup);
      this.extremeGroups.push(dmrOpticExtGroup);

      // 3. 主副消音器外圈 CNC 减重沟槽与散热环
      const buildSupRings = (parent, r, len, count) => {
        const gs = [];
        for (let i = 0; i < count; i++) {
          const yOff = -len * 0.36 + (i / Math.max(1, count - 1)) * (len * 0.72);
          gs.push(tx(new THREE.CylinderGeometry(r * 1.07, r * 1.07, 0.008, 16), { y: yOff }));
        }
        const g = merge(gs);
        if (!g) return;
        const grp = new THREE.Group();
        grp.visible = this.extremeDetailEnabled;
        grp.add(new THREE.Mesh(g, suppressorMat));
        parent.add(grp);
        this.extremeGroups.push(grp);
      };
      buildSupRings(this.rifleSuppressorMesh, 0.021, 0.19, 6);
      buildSupRings(this.pistolSuppressorMesh, 0.016, 0.155, 5);

      // 4. 副手枪套筒防滑斜纹（挂在 pistolSlideMesh 随击发同步后坐）与下导轨齿
      const slideGeos = [];
      for (let i = 0; i < 6; i++) {
        const z = 0.048 + i * 0.0105;
        slideGeos.push(tx(new THREE.BoxGeometry(0.038, 0.021, 0.0045), { y: 0.0, z, rx: 0.16 }));
      }
      for (let i = 0; i < 4; i++) {
        const z = -0.065 - i * 0.0095;
        slideGeos.push(tx(new THREE.BoxGeometry(0.038, 0.017, 0.0042), { y: -0.002, z, rx: 0.16 }));
      }
      const slideM = merge(slideGeos);
      if (slideM) {
        const sExt = new THREE.Mesh(slideM, accent);
        sExt.visible = this.extremeDetailEnabled;
        this.pistolSlideMesh.add(sExt);
        this.extremeGroups.push(sExt);
      }

      const pistolFrameGeos = [];
      for (let i = 0; i < 3; i++) {
        pistolFrameGeos.push(tx(new THREE.BoxGeometry(0.030, 0.005, 0.007), { y: -0.01, z: -0.135 - i * 0.014 }));
      }
      const pfM = merge(pistolFrameGeos);
      if (pfM) {
        const pfExt = new THREE.Mesh(pfM, metal);
        pfExt.visible = this.extremeDetailEnabled;
        this.pistolGroup.add(pfExt);
        this.extremeGroups.push(pfExt);
      }
    }

    setExtremeDetail(enabled) {
      this.extremeDetailEnabled = !!enabled;
      for (const g of this.extremeGroups) {
        if (g) g.visible = this.extremeDetailEnabled;
      }
      if (this.flashlight) {
        this.flashlight.castShadow = this.extremeDetailEnabled;
        if (this.extremeDetailEnabled) {
          this.flashlight.shadow.mapSize.set(512, 512);
          this.flashlight.shadow.camera.near = 0.35;
          this.flashlight.shadow.camera.far = 36;
          this.flashlight.shadow.bias = -0.0007;
          this.flashlight.shadow.normalBias = 0.025;
        }
        if (this.flashlight.shadow) {
          this.flashlight.shadow.autoUpdate = this.extremeDetailEnabled && this.flashlightOn;
        }
      }
      for (const fMat of this._vmFabrics) {
        if (!fMat) continue;
        fMat.sheen = this.extremeDetailEnabled ? 0.55 : 0.0;
        fMat.sheenRoughness = 0.65;
        if (fMat.sheenColor) fMat.sheenColor.setHex(0x6d849e);
        fMat.needsUpdate = true;
      }
      for (const mMat of this._vmMetalExtras) {
        if (!mMat) continue;
        mMat.clearcoat = this.extremeDetailEnabled ? 0.36 : 0.0;
        mMat.clearcoatRoughness = 0.24;
        mMat.anisotropy = this.extremeDetailEnabled ? 0.65 : 0.0;
        mMat.needsUpdate = true;
      }
      if (this._skinAccentMat) {
        this._skinAccentMat.clearcoat = this.extremeDetailEnabled ? 0.34 : 0.0;
        this._skinAccentMat.anisotropy = this.extremeDetailEnabled ? 0.58 : 0.0;
        this._skinAccentMat.needsUpdate = true;
      }
      if (this.render && this.render.syncNewObjectForExtreme) {
        this.render.syncNewObjectForExtreme(this.viewmodelRoot);
      }
    }

    getOpticsTelemetry() {
      let flashBounce = null;
      if (this.extremeDetailEnabled && this.flashlightOn && this.level && this.level.collision) {
        this.camera.getWorldPosition(this._flashOrigin);
        this.camera.getWorldDirection(this._flashDir);
        const dist = this.level.collision.raycastBoxes
          ? this.level.collision.raycastBoxes(this._flashOrigin, this._flashDir, 0.4, 11.5, this._bouncePos)
          : -1;
        if (dist > 0 && dist < 11.5) {
          this._bouncePos.addScaledVector(this._flashDir, -0.45);
          flashBounce = {
            position: this._bouncePos,
            intensity: 2.3 * (1 - dist / 11.5),
          };
        }
      }
      return {
        flashlight: this.flashlight,
        flashBounce,
        adsAlpha: this.adsAlpha,
        isDmrScoped: this.activeSlot === 'primary' && this.slots.primary.id === 'dmr' && this.ads3DHidden,
        muzzleHeat: this.muzzleHeat,
        whLightOn: !!(this.level && this.level.warehouseLights && !this.level.warehouseLights.disabled),
      };
    }

    _initCasingsAndTracers() {
      // 黄铜弹壳抛射池
      this.maxCasings = 28;
      const cGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.032, 6);
      cGeo.rotateZ(Math.PI / 2);
      const cMat = new THREE.MeshStandardMaterial({ color: 0xd4a442, metalness: 0.9, roughness: 0.25 });
      this.casingMesh = new THREE.InstancedMesh(cGeo, cMat, this.maxCasings);
      this.casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.casingMesh.frustumCulled = false;
      this.scene.add(this.casingMesh);

      this._zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      this._dummy = new THREE.Object3D();
      this.casings = Array.from({ length: this.maxCasings }, () => ({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        life: 0,
      }));
      for (let i = 0; i < this.maxCasings; i++) this.casingMesh.setMatrixAt(i, this._zeroMat);

      // 子弹示踪弹道线池
      this.maxTracers = 16;
      const tGeo = new THREE.BoxGeometry(0.018, 0.018, 1.0);
      const tMat = new THREE.MeshBasicMaterial({
        color: 0xffd180,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
      });
      this.tracerMesh = new THREE.InstancedMesh(tGeo, tMat, this.maxTracers);
      this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.tracerMesh.frustumCulled = false;
      this.scene.add(this.tracerMesh);
      this.tracers = Array.from({ length: this.maxTracers }, () => ({
        active: false,
        start: new THREE.Vector3(),
        end: new THREE.Vector3(),
        progress: 0,
        speed: 180,
        dist: 10,
      }));
      for (let i = 0; i < this.maxTracers; i++) this.tracerMesh.setMatrixAt(i, this._zeroMat);
    }

    resetArsenal(primaryId = 'car47', skinId = 'standard', perkIds = []) {
      this.primaryId = ['car47', 'dmr', 'shotgun'].includes(primaryId) ? primaryId : 'car47';
      this.activeSlot = 'primary';
      this.perks = {};
      if (Array.isArray(perkIds)) {
        for (const p of perkIds) this.perks[p] = true;
      }

      const priCfg = this._getWeaponConfigById(this.primaryId);
      const secCfg = this._getWeaponConfigById('pistol');
      const mult = this.perks.extended_pouches ? 1.3 : 1.0;
      const resMult = mult * ((this.diffModifiers && this.diffModifiers.ammoReserveMult) || 1.0);

      this.slots = {
        primary: {
          id: this.primaryId,
          ammo: Math.round(priCfg.magSize * mult),
          reserve: Math.round(priCfg.maxReserve * resMult),
          suppressorAttached: !!priCfg.defaultSuppressed,
        },
        secondary: {
          id: 'pistol',
          ammo: Math.round(secCfg.magSize * mult),
          reserve: Math.round(secCfg.maxReserve * resMult),
          suppressorAttached: !!secCfg.defaultSuppressed,
        },
      };

      this.throwables = {
        emp: this.perks.emp_overload ? 4 : 2,
        frag: this.perks.emp_overload ? 4 : 2,
        decoy: 2,
      };
      this.activeThrowableIdx = 0;
      this.clearThrowables();
      this.cancelThrowPreview();

      this.isReloading = false;
      this.isFiring = false;
      this._triggerConsumed = false;
      this.isADS = false;
      this.ads3DHidden = false;
      this.fireTimer = 0;
      this.swapTimer = 0;
      this.meleeSwingTimer = 0;
      this._lowReserveWarned = false;
      this.stats = { shotsFired: 0, shotsHit: 0, crits: 0 };

      this.setSkin(skinId);
      this._syncModelVisuals();
    }

    setPrimaryType(primaryId) {
      this.resetArsenal(primaryId, this.skinId, Object.keys(this.perks).filter((k) => this.perks[k]));
    }

    setSkin(skinId = 'standard') {
      this.skinId = skinId;
      const skins = window.GameLogic && window.GameLogic.GUN_SKINS;
      const sk = (skins && skins[skinId]) || { metalHex: 0x22262e, accentHex: 0x3b424d };
      if (this._skinMetalMat) this._skinMetalMat.color.setHex(sk.metalHex);
      if (this._skinAccentMat) this._skinAccentMat.color.setHex(sk.accentHex);
    }

    addPerk(perkId) {
      if (!perkId) return;
      this.perks[perkId] = true;
      if (perkId === 'extended_pouches') {
        const diffMult = (this.diffModifiers && this.diffModifiers.ammoReserveMult) || 1.0;
        for (const key of ['primary', 'secondary']) {
          const sl = this.slots[key];
          const cfg = this._getWeaponConfigById(sl.id);
          sl.ammo = Math.round(cfg.magSize * 1.3);
          sl.reserve = Math.round(cfg.maxReserve * 1.3 * diffMult);
        }
      } else if (perkId === 'emp_overload') {
        this.throwables.emp += 2;
        this.throwables.frag += 2;
      }
    }

    setAds3DHidden(hidden) {
      const next = !!hidden;
      if (this.ads3DHidden === next) return;
      this.ads3DHidden = next;
      this._syncModelVisuals();
    }

    _syncModelVisuals() {
      const isPistol = this.activeSlot === 'secondary';
      this.rifleGroup.visible = !isPistol && !this.ads3DHidden;
      this.pistolGroup.visible = isPistol && !this.ads3DHidden;

      const priId = this.slots.primary.id;
      const isDmr = priId === 'dmr';
      const isShotgun = priId === 'shotgun';
      if (this.dmrBarrelExt) this.dmrBarrelExt.visible = isDmr;
      if (this.holoGroup) this.holoGroup.visible = !isDmr && !isShotgun;
      if (this.sgReflexGroup) this.sgReflexGroup.visible = isShotgun;
      if (this.dmrScopeGroup) this.dmrScopeGroup.visible = isDmr;
      if (this.shotgunUnderTube) this.shotgunUnderTube.visible = isShotgun;
      if (this.shotgunPump) this.shotgunPump.visible = isShotgun;
      if (this.magGroup) this.magGroup.visible = !isShotgun;

      if (this.rifleSuppressorMesh) {
        this.rifleSuppressorMesh.visible = !!this.slots.primary.suppressorAttached;
        this.rifleSuppressorMesh.position.z = isDmr ? -0.82 : -0.74;
      }
      if (this.pistolSuppressorMesh) {
        this.pistolSuppressorMesh.visible = !!this.slots.secondary.suppressorAttached;
      }
    }

    switchWeapon(slotName) {
      if (slotName !== 'primary' && slotName !== 'secondary') return false;
      if (this.activeSlot === slotName) return false;
      this.cancelThrowPreview();
      this.activeSlot = slotName;
      this.isReloading = false;
      this.isADS = false;
      this.ads3DHidden = false;
      this.isFiring = false;
      this._triggerConsumed = false;
      this.swapTimer = this.perks.sleight_of_hand ? 0.14 : 0.24;
      this.audio.playSwitchClick();
      this._syncModelVisuals();
      return true;
    }

    toggleSuppressor() {
      this.currentSlot.suppressorAttached = !this.currentSlot.suppressorAttached;
      this._syncModelVisuals();
      this.swapTimer = 0.18;
      if (this.audio.playSuppressorToggle) {
        this.audio.playSuppressorToggle(this.currentSlot.suppressorAttached);
      } else {
        this.audio.playSwitchClick();
      }
      return this.currentSlot.suppressorAttached;
    }

    setFiring(down) {
      this.isFiring = !!down;
      if (!down) this._triggerConsumed = false;
    }

    toggleFlashlight() {
      this.flashlightOn = !this.flashlightOn;
      this.flashlight.intensity = this.flashlightOn ? 55 : 0;
      if (this.flashlight && this.flashlight.shadow) {
        this.flashlight.shadow.autoUpdate = this.extremeDetailEnabled && this.flashlightOn;
      }
      this.audio.playSwitchClick();
    }

    triggerMeleeSwing() {
      if (this.meleeSwingTimer > 0) return;
      this.cancelThrowPreview();
      this.meleeSwingTimer = 0.36;
      this.isADS = false;
      this.setAds3DHidden(false);
    }

    _initThrowPreview() {
      this._throwArcMaxPts = 24;
      this._throwArcArray = new Float32Array(this._throwArcMaxPts * 3);
      const arcGeo = new THREE.BufferGeometry();
      arcGeo.setAttribute('position', new THREE.BufferAttribute(this._throwArcArray, 3));
      this._throwArcMat = new THREE.LineBasicMaterial({
        color: 0x38d9ff,
        transparent: true,
        opacity: 0.86,
        depthWrite: false,
      });
      this._throwArcLine = new THREE.Line(arcGeo, this._throwArcMat);
      this._throwArcLine.frustumCulled = false;
      this._throwArcLine.visible = false;
      this._throwArcLine.renderOrder = 8;
      this._throwArcLine.userData.forceLayer1 = true;
      this.scene.add(this._throwArcLine);

      const ringGeo = new THREE.RingGeometry(0.28, 0.44, 24);
      ringGeo.rotateX(-Math.PI / 2);
      this._throwRingMat = new THREE.MeshBasicMaterial({
        color: 0x38d9ff,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this._throwRingMesh = new THREE.Mesh(ringGeo, this._throwRingMat);
      this._throwRingMesh.frustumCulled = false;
      this._throwRingMesh.visible = false;
      this._throwRingMesh.renderOrder = 8;
      this._throwRingMesh.userData.forceLayer1 = true;
      this.scene.add(this._throwRingMesh);
    }

    beginThrowPreview() {
      const gId = this.activeThrowableId;
      if ((this.throwables[gId] || 0) <= 0) return false;
      this.isPreviewingThrow = true;
      const cat = window.GameLogic && window.GameLogic.THROWABLE_CATALOG;
      const cfg = (cat && cat[gId]) || { colorHex: 0x38d9ff };
      const col = cfg.colorHex || 0x38d9ff;
      if (this._throwArcMat) this._throwArcMat.color.setHex(col);
      if (this._throwRingMat) this._throwRingMat.color.setHex(col);
      return true;
    }

    updateThrowPreview(originPos, aimDir) {
      if (!this.isPreviewingThrow || !this._throwArcLine || !this._throwRingMesh) return;
      const gId = this.activeThrowableId;
      if ((this.throwables[gId] || 0) <= 0) {
        this.cancelThrowPreview();
        return;
      }
      const cat = window.GameLogic && window.GameLogic.THROWABLE_CATALOG;
      const cfg = (cat && cat[gId]) || { fuseTime: 1.2 };
      const pos = this._previewPos.copy(originPos).addScaledVector(aimDir, 0.65);
      pos.y -= 0.12;
      const vel = this._previewVel.copy(aimDir).multiplyScalar(17.5);
      vel.y += 4.2;

      const arr = this._throwArcArray;
      const maxPts = this._throwArcMaxPts;
      const stepDt = Math.max(0.038, Math.min(0.08, (cfg.fuseTime || 1.2) / 18));
      const boxes = (this.level && this.level.collision && this.level.collision.boxes) || [];
      let ptsWritten = 1;
      arr[0] = pos.x;
      arr[1] = pos.y;
      arr[2] = pos.z;

      for (let step = 1; step < maxPts; step++) {
        this._previewPrevPos.copy(pos);
        vel.y -= 15.0 * stepDt;
        pos.addScaledVector(vel, stepDt);

        let hitSurface = false;
        const floorY = (this.level && this.level.collision)
          ? this.level.collision.getGroundHeight(pos.x, pos.z, pos.y) + 0.08
          : 0.08;
        if (pos.y <= floorY) {
          pos.y = floorY;
          hitSurface = true;
        } else {
          for (let bIdx = 0; bIdx < boxes.length; bIdx++) {
            const box = boxes[bIdx];
            if (box.disabled) continue;
            if (pos.x > box.minX - 0.1 && pos.x < box.maxX + 0.1 &&
                pos.z > box.minZ - 0.1 && pos.z < box.maxZ + 0.1 &&
                pos.y >= box.minY && pos.y <= box.maxY) {
              pos.copy(this._previewPrevPos);
              hitSurface = true;
              break;
            }
          }
        }

        const baseIdx = step * 3;
        arr[baseIdx] = pos.x;
        arr[baseIdx + 1] = pos.y;
        arr[baseIdx + 2] = pos.z;
        ptsWritten = step + 1;
        if (hitSurface) break;
      }

      const lastX = arr[(ptsWritten - 1) * 3];
      const lastY = arr[(ptsWritten - 1) * 3 + 1];
      const lastZ = arr[(ptsWritten - 1) * 3 + 2];
      for (let step = ptsWritten; step < maxPts; step++) {
        const baseIdx = step * 3;
        arr[baseIdx] = lastX;
        arr[baseIdx + 1] = lastY;
        arr[baseIdx + 2] = lastZ;
      }

      const posAttr = this._throwArcLine.geometry.getAttribute('position');
      posAttr.needsUpdate = true;
      this._throwArcLine.visible = true;
      const ringY = (this.level && this.level.collision)
        ? Math.max(lastY, this.level.collision.getGroundHeight(lastX, lastZ, lastY) + 0.04)
        : lastY;
      this._throwRingMesh.position.set(lastX, ringY, lastZ);
      this._throwRingMesh.visible = true;
    }

    cancelThrowPreview() {
      this.isPreviewingThrow = false;
      if (this._throwArcLine) this._throwArcLine.visible = false;
      if (this._throwRingMesh) this._throwRingMesh.visible = false;
    }

    commitThrowPreview(originPos, aimDir, mutators = []) {
      const wasPreviewing = this.isPreviewingThrow;
      this.cancelThrowPreview();
      if (!wasPreviewing) return false;
      return this.throwActiveGadget(originPos, aimDir, mutators);
    }

    cycleThrowable() {
      this.activeThrowableIdx = (this.activeThrowableIdx + 1) % this.throwableOrder.length;
      this.audio.playSwitchClick();
      return this.activeThrowableId;
    }

    refillAmmo() {
      const mult = this.perks.extended_pouches ? 1.3 : 1.0;
      const resMult = mult * ((this.diffModifiers && this.diffModifiers.ammoReserveMult) || 1.0);
      for (const key of ['primary', 'secondary']) {
        const sl = this.slots[key];
        const cfg = this._getWeaponConfigById(sl.id);
        sl.reserve = Math.round(cfg.maxReserve * resMult);
        if (sl.ammo === 0) {
          const take = Math.min(Math.round(cfg.magSize * mult), sl.reserve);
          sl.ammo = take;
          sl.reserve -= take;
        }
      }
      this.throwables.emp = Math.max(this.throwables.emp, 2);
      this.throwables.frag = Math.max(this.throwables.frag, 2);
      this.throwables.decoy = Math.max(this.throwables.decoy, 2);
      this._lowReserveWarned = false;
      if (this.audio.playAmmoPickup) this.audio.playAmmoPickup();
    }

    grantKillAmmoDrop() {
      const cfg = this.currentConfig;
      const baseGain = cfg.id === 'shotgun' ? 4 : cfg.id === 'dmr' ? 6 : 12;
      const diffMult = (this.diffModifiers && this.diffModifiers.ammoReserveMult) || 1.0;
      const gain = Math.round(baseGain * diffMult);
      this.reserveAmmo = Math.min(this.maxReserve, this.reserveAmmo + gain);
      this._lowReserveWarned = false;
    }

    throwActiveGadget(originPos, aimDir, mutators = []) {
      const gId = this.activeThrowableId;
      if ((this.throwables[gId] || 0) <= 0) return false;
      const cat = window.GameLogic && window.GameLogic.THROWABLE_CATALOG;
      const cfg = (cat && cat[gId]) || { id: gId, fuseTime: 1.2, radius: 8, damage: 100, colorHex: 0x38d9ff };

      this.throwables[gId]--;
      this.swapTimer = 0.2;
      this.audio.playSwitchClick();

      if (!this._grenadeBodyGeo) {
        this._grenadeBodyGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.15, 10);
        this._grenadeGlowGeo = new THREE.CylinderGeometry(0.064, 0.064, 0.036, 10);
        this._grenadeBodyMat = new THREE.MeshStandardMaterial({ color: 0x2a313a, metalness: 0.75, roughness: 0.35 });
      }
      let glowMat = this._grenadeGlowMats.get(cfg.colorHex);
      if (!glowMat) {
        glowMat = new THREE.MeshBasicMaterial({ color: cfg.colorHex });
        this._grenadeGlowMats.set(cfg.colorHex, glowMat);
      }

      const meshGroup = new THREE.Group();
      const body = new THREE.Mesh(this._grenadeBodyGeo, this._grenadeBodyMat);
      const glow = new THREE.Mesh(this._grenadeGlowGeo, glowMat);
      meshGroup.add(body, glow);
      meshGroup.position.copy(originPos).addScaledVector(aimDir, 0.65);
      meshGroup.position.y -= 0.12;
      this.scene.add(meshGroup);

      const light = this.render.createVirtualLight({
        color: cfg.colorHex,
        intensity: 4.5,
        distance: 5.5,
        decay: 1.8,
        hostObject: meshGroup,
        priority: 8.5,
      });

      const vel = aimDir.clone().multiplyScalar(17.5);
      vel.y += 4.2;

      this.activeGrenades.push({
        id: gId,
        cfg,
        mesh: meshGroup,
        light,
        pos: meshGroup.position,
        vel,
        fuse: cfg.fuseTime,
        activeDecoyTimer: 0,
        decoyPulseTimer: 0,
        detonated: false,
        explosiveTide: Array.isArray(mutators) && mutators.includes('explosive_tide'),
      });
      return gId;
    }

    updateThrowables(dt, enemyManager, callbacks = {}) {
      for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
        const g = this.activeGrenades[i];
        if (!g.detonated) {
          g.vel.y -= 15.0 * dt;
          g.pos.addScaledVector(g.vel, dt);
          g.mesh.rotation.x += dt * 7;
          g.mesh.rotation.z += dt * 5;

          const floorY = this.level.collision.getGroundHeight(g.pos.x, g.pos.z, g.pos.y) + 0.08;
          if (g.pos.y < floorY) {
            g.pos.y = floorY;
            g.vel.y = Math.abs(g.vel.y) * 0.38;
            g.vel.x *= 0.58;
            g.vel.z *= 0.58;
          }
          // 撞击箱体水平简单反弹
          for (let bIdx = 0; bIdx < this.level.collision.boxes.length; bIdx++) {
            const box = this.level.collision.boxes[bIdx];
            if (box.disabled) continue;
            if (g.pos.x > box.minX - 0.1 && g.pos.x < box.maxX + 0.1 &&
                g.pos.z > box.minZ - 0.1 && g.pos.z < box.maxZ + 0.1 &&
                g.pos.y >= box.minY && g.pos.y <= box.maxY) {
              g.pos.addScaledVector(g.vel, -dt * 1.4);
              g.vel.x *= -0.45;
              g.vel.z *= -0.45;
              break;
            }
          }

          g.fuse -= dt;
          if (g.fuse <= 0) {
            this._detonateGrenade(g, enemyManager, callbacks);
          }
        } else if (g.id === 'decoy' && g.activeDecoyTimer > 0) {
          g.activeDecoyTimer -= dt;
          g.decoyPulseTimer -= dt;
          g.light.intensity = 3 + Math.sin(this.render.time * 18) * 2.5;
          if (g.decoyPulseTimer <= 0) {
            g.decoyPulseTimer = 1.4;
            if (this.audio.playDecoyPulse) this.audio.playDecoyPulse(g.pos);
            this.render.spawnSparks(g.pos, this._upVec, 8, 0.8);
            if (enemyManager && enemyManager.lureSound) {
              enemyManager.lureSound(g.pos, g.cfg.radius || 22);
            }
          }
          if (g.activeDecoyTimer <= 0) {
            if (g.light && g.light.dispose) g.light.dispose();
            this.scene.remove(g.mesh);
            this.activeGrenades.splice(i, 1);
          }
        }
      }
    }

    _detonateGrenade(g, enemyManager, callbacks) {
      g.detonated = true;
      const overloadScale = this.perks.emp_overload ? 1.35 : 1.0;
      const dmgMult = (this.perks.emp_overload ? 1.5 : 1.0) * (g.explosiveTide && g.id === 'frag' ? 1.25 : 1.0);
      const radius = (g.cfg.radius || 8) * overloadScale;

      if (g.id === 'decoy') {
        g.activeDecoyTimer = g.cfg.durationSec || 6.5;
        g.decoyPulseTimer = 0.01;
        return;
      }

      if (g.id === 'emp') {
        if (this.audio.playEmpBlast) this.audio.playEmpBlast(g.pos);
        this.render.spawnSparks(g.pos, this._upVec, 28, 1.9);
        this.render.spawnSmoke(g.pos, 4, 0.4, 2.2, 0x38d9ff);

        // 破坏范围内的配电箱
        if (this.level.breakers) {
          for (const br of this.level.breakers) {
            if (!br.tripped && br.pos.distanceTo(g.pos) <= radius) {
              if (this.level.triggerBreaker(br) && this.onBreakerHit) {
                this.onBreakerHit(br);
              }
            }
          }
        }
        // 瘫痪敌人与盾牌并打断报警呼叫
        if (enemyManager && enemyManager.enemies) {
          for (const e of enemyManager.enemies) {
            if (e.dead) continue;
            if (e.group.position.distanceTo(g.pos) <= radius) {
              if (e.applyEmpStun) e.applyEmpStun(g.cfg.stunSec || 5.5);
              e.takeDamage(Math.round((g.cfg.damage || 22) * dmgMult), e.group.position, false, { fromExplosion: true });
            }
          }
        }
      } else if (g.id === 'frag') {
        const pPos = callbacks.playerPos || g.pos;
        this.audio.playExplosion(g.pos.distanceTo(pPos), g.pos);
        this.render.spawnSparks(g.pos, this._upVec, 34, 2.2);
        this.render.spawnSmoke(g.pos, 7, 0.55, 2.6, 0xff9452);
        if (this.level.flashExplosionLight) this.level.flashExplosionLight(g.pos);
        if (callbacks.onExplosion) callbacks.onExplosion(g.pos, radius);

        if (enemyManager && enemyManager.enemies) {
          const baseFragDmg = Math.round((g.cfg.damage || 135) * dmgMult);
          for (const e of enemyManager.enemies) {
            if (e.dead) continue;
            this._tmpCheckPos.copy(e.group.position);
            if (e.type !== 'drone' && e.type !== 'sniper' && e.type !== 'recon') {
              this._tmpCheckPos.y += 0.9;
            }
            const d = this._tmpCheckPos.distanceTo(g.pos);
            if (d <= radius) {
              const occluded = this.level && this.level.collision && this.level.collision.hasLineOfSight
                ? !this.level.collision.hasLineOfSight(g.pos, this._tmpCheckPos)
                : false;
              const dmg = (window.GameLogic && window.GameLogic.computeExplosionFalloff)
                ? window.GameLogic.computeExplosionFalloff(d, radius, baseFragDmg, occluded)
                : Math.round(baseFragDmg * Math.max(0.35, 1 - d / (radius + 0.5)) * (occluded ? 0.3 : 1));
              if (dmg > 0) {
                e.takeDamage(dmg, this._tmpCheckPos, false, { fromExplosion: true });
              }
            }
          }
        }
        // 引爆附近红桶
        if (this.level.barrels && this.onBarrelHit) {
          for (const b of this.level.barrels) {
            if (b.state !== 'exploded' && b.pos.distanceTo(g.pos) <= radius) {
              this.onBarrelHit(b, 80);
            }
          }
        }
        if (enemyManager && enemyManager.alertSound) {
          enemyManager.alertSound(g.pos, 42, true, false);
        }
      }

      if (g.light && g.light.dispose) g.light.dispose();
      this.scene.remove(g.mesh);
      const idx = this.activeGrenades.indexOf(g);
      if (idx >= 0) this.activeGrenades.splice(idx, 1);
    }

    clearThrowables() {
      this.cancelThrowPreview();
      for (const g of this.activeGrenades) {
        if (g.light && g.light.dispose) g.light.dispose();
        this.scene.remove(g.mesh);
      }
      this.activeGrenades.length = 0;
    }

    startReload() {
      this.cancelThrowPreview();
      if (this.isReloading || this.ammo >= this.magSize) return;
      if (this.reserveAmmo <= 0) {
        if (!this._lowReserveWarned && this.onLowReserve) {
          this._lowReserveWarned = true;
          this.onLowReserve();
        }
        return;
      }
      const cfg = this.currentConfig;
      const baseTime = this.ammo === 0 ? cfg.emptyReloadTime : cfg.tacReloadTime;
      const speedMult = this.perks.sleight_of_hand ? 1.35 : 1.0;
      this.reloadDuration = baseTime / speedMult;
      this.isReloading = true;
      this.reloadTimer = 0;
      this.reloadStagesPlayed = { out: false, in: false, bolt: false };
      this.isADS = false;
      this.setAds3DHidden(false);
    }

    addLookSway(dx, dy) {
      this.swayX = Math.max(-0.035, Math.min(0.035, this.swayX - dx * 0.00028));
      this.swayY = Math.max(-0.035, Math.min(0.035, this.swayY + dy * 0.00028));
    }

    getCurrentSpread(moveSpeed, isCrouching) {
      const cfg = this.currentConfig;
      let spread = this.isADS ? cfg.adsSpread : cfg.hipSpread;
      if (moveSpeed > 0.5) spread += this.isADS ? cfg.adsSpread * 1.4 : 0.014;
      if (isCrouching) spread *= 0.65;
      spread += this.recoilZ * 0.14;
      const diffSpread = (this.diffModifiers && this.diffModifiers.spreadScale) || 1.0;
      return spread * diffSpread;
    }

    _getAimAssistedDirection(baseDir, enemyManager) {
      const maxAngleDeg = (this.diffModifiers && this.diffModifiers.aimAssistDeg) || 0;
      if (maxAngleDeg <= 0 || !enemyManager || !Array.isArray(enemyManager.enemies) || !window.GameLogic || !window.GameLogic.selectAimAssistDirection) {
        return baseDir;
      }
      const cosCutoff = Math.cos(((maxAngleDeg + 0.5) * Math.PI) / 180);
      const maxRange = 65;
      const candidates = [];
      const tmpPos = this._assistTmpPos;

      for (let i = 0; i < enemyManager.enemies.length; i++) {
        const e = enemyManager.enemies[i];
        if (!e || e.dead || !Array.isArray(e.hitboxes)) continue;
        e.group.updateMatrixWorld(true);
        const stunned = (e.empTimer || 0) > 0;
        for (let j = 0; j < e.hitboxes.length; j++) {
          const hb = e.hitboxes[j];
          if (!hb || (hb.userData && hb.userData.isShield && !stunned)) continue;
          hb.getWorldPosition(tmpPos);
          const tx = tmpPos.x - this._rayOrigin.x;
          const ty = tmpPos.y - this._rayOrigin.y;
          const tz = tmpPos.z - this._rayOrigin.z;
          const dist = Math.hypot(tx, ty, tz);
          if (dist <= 0.1 || dist > maxRange) continue;
          const dot = (tx * baseDir.x + ty * baseDir.y + tz * baseDir.z) / dist;
          if (dot < cosCutoff) continue;
          // 必须先通过地形掩体直视校验，防止隔墙吸附
          if (this.level && this.level.collision && !this.level.collision.hasLineOfSight(this._rayOrigin, tmpPos)) {
            continue;
          }
          candidates.push({
            x: tmpPos.x,
            y: tmpPos.y,
            z: tmpPos.z,
            isWeakpoint: !!(hb.userData && hb.userData.isWeakpoint),
          });
        }
      }

      if (candidates.length === 0) return baseDir;
      const res = window.GameLogic.selectAimAssistDirection({
        origin: this._rayOrigin,
        dir: baseDir,
        candidates,
        maxAngleDeg,
        maxRange,
      });
      if (res && res.assisted && res.dir) {
        return this._assistOutDir.set(res.dir.x, res.dir.y, res.dir.z).normalize();
      }
      return baseDir;
    }

    update(dt, playerState, enemyManager, onHitCallback) {
      const cfg = this.currentConfig;
      const activeGroup = this.activeSlot === 'secondary' ? this.pistolGroup : this.rifleGroup;
      const baseHip = this.activeSlot === 'secondary' ? this.pistolHipPos : this.hipPos;
      const baseAds = this.activeSlot === 'secondary' ? this.pistolAdsPos : this.adsPos;

      if (this.swapTimer > 0) this.swapTimer = Math.max(0, this.swapTimer - dt);
      if (this.meleeSwingTimer > 0) this.meleeSwingTimer = Math.max(0, this.meleeSwingTimer - dt);

      // 1. ADS 平滑插值与 FOV 缩放（DMR 拥有更高开镜倍率）
      const targetAds = this.isADS && !this.isReloading && !playerState.sprinting && this.meleeSwingTimer <= 0 ? 1 : 0;
      this.adsAlpha += (targetAds - this.adsAlpha) * Math.min(1, dt * 15);
      const adsDeltaFov = 75 - (cfg.adsFov || 49);
      const targetFov = 75 - this.adsAlpha * adsDeltaFov;
      if (Math.abs(this.camera.fov - targetFov) > 0.05) {
        this.camera.fov = targetFov;
        this.camera.updateProjectionMatrix();
      }

      // 2. 换弹多段动画与战术/空仓差异补弹
      let reloadDropY = 0;
      let reloadTiltZ = 0;
      let reloadPitchX = 0;
      let magOffsetY = 0;
      if (this.isReloading) {
        this.reloadTimer += dt;
        const p = this.reloadTimer / this.reloadDuration;
        if (p > 0.12 && !this.reloadStagesPlayed.out) {
          this.reloadStagesPlayed.out = true;
          this.audio.playReloadStage('out');
        }
        if (p > 0.58 && !this.reloadStagesPlayed.in) {
          this.reloadStagesPlayed.in = true;
          this.audio.playReloadStage('in');
        }
        if (p > 0.82 && !this.reloadStagesPlayed.bolt) {
          this.reloadStagesPlayed.bolt = true;
          this.audio.playReloadStage('bolt');
        }

        if (p < 0.25) {
          const k = p / 0.25;
          reloadDropY = -0.08 * k;
          reloadTiltZ = 0.48 * k;
          reloadPitchX = 0.25 * k;
        } else if (p < 0.72) {
          const k = (p - 0.25) / 0.47;
          reloadDropY = -0.08;
          reloadTiltZ = 0.48;
          reloadPitchX = 0.25;
          magOffsetY = k < 0.45 ? -0.22 * (k / 0.45) : -0.22 * (1 - (k - 0.45) / 0.55);
        } else {
          const k = Math.min(1, (p - 0.72) / 0.28);
          reloadDropY = -0.08 * (1 - k);
          reloadTiltZ = 0.48 * (1 - k);
          reloadPitchX = 0.25 * (1 - k);
          if (k > 0.25 && k < 0.65) {
            this.boltOffset = 0.042 * Math.sin(((k - 0.25) / 0.4) * Math.PI);
          }
        }

        if (this.reloadTimer >= this.reloadDuration) {
          this.isReloading = false;
          const needed = Math.min(this.magSize - this.ammo, this.reserveAmmo);
          this.ammo += needed;
          this.reserveAmmo -= needed;
          if (this.reserveAmmo <= 8 && !this._lowReserveWarned && this.onLowReserve) {
            this._lowReserveWarned = true;
            this.onLowReserve();
          }
        }
      }
      if (this.activeSlot === 'secondary') {
        this.pistolMagGroup.position.y = -0.04 + magOffsetY * 0.7;
      } else {
        this.magGroup.position.y = -0.04 + magOffsetY;
      }

      // 3. 开火调度（区分全自动步枪与半自动 DMR / Shotgun / Pistol）
      this.timeSinceShot += dt;
      if (this.timeSinceShot > 0.14) {
        this.burstCount = Math.max(0, this.burstCount - dt * 18);
      }
      this.fireTimer = Math.max(0, this.fireTimer - dt);
      const canShoot = cfg.auto || !this._triggerConsumed;
      if (this.isFiring && canShoot && !this.isReloading && this.fireTimer <= 0 && this.swapTimer <= 0) {
        if (!cfg.auto) this._triggerConsumed = true;
        if (this.ammo > 0) {
          this.fireTimer = cfg.fireRate;
          this._fireOneShot(playerState, enemyManager, onHitCallback);
        } else if (this.reserveAmmo > 0) {
          if (this.onEmptyReload) this.onEmptyReload();
          this.startReload();
        } else {
          this.fireTimer = 0.25;
          this.audio.playSwitchClick();
          if (this.onLowReserve) this.onLowReserve();
        }
      }

      // 4. 枪口火光、后坐力、热量与晃动衰减
      this.muzzleHeat = Math.max(0, this.muzzleHeat - dt * 0.36);
      if (this.muzzleFlashTimer > 0) {
        this.muzzleFlashTimer -= dt;
        if (this.muzzleFlashTimer <= 0) {
          this.muzzleGroup.visible = false;
          this.muzzleLight.intensity = 0;
        }
      }

      const recDecay = Math.min(1, dt * 16);
      this.recoilZ += (0 - this.recoilZ) * recDecay;
      this.recoilPitch += (0 - this.recoilPitch) * recDecay;
      this.boltOffset += (0 - this.boltOffset) * Math.min(1, dt * 24);
      const camDecay = Math.min(1, dt * 12);
      this.camRecoilPitch += (0 - this.camRecoilPitch) * camDecay;
      this.camRecoilYaw += (0 - this.camRecoilYaw) * camDecay;
      this.swayX += (0 - this.swayX) * Math.min(1, dt * 10);
      this.swayY += (0 - this.swayY) * Math.min(1, dt * 10);

      // 移动呼吸、冲刺、滑铲倾斜与近战挥砍姿态
      const speedRatio = Math.min(1.5, playerState.moveSpeed / 5.6);
      this.bobPhase += dt * (2.2 + speedRatio * 7.8);
      const bobAmp = (0.002 + speedRatio * 0.011) * (1 - this.adsAlpha * 0.82);
      const bobX = Math.cos(this.bobPhase) * bobAmp;
      const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmp * 1.15;
      const sprintTilt = playerState.sprinting && !this.isReloading ? -0.45 : 0;
      const sprintDrop = playerState.sprinting && !this.isReloading ? -0.05 : 0;
      const slideRoll = playerState.sliding ? -0.35 : 0;
      const swapDrop = -(this.swapTimer / 0.24) * 0.14;
      let meleeX = 0;
      let meleeY = 0;
      let meleeYaw = 0;
      let meleeRoll = 0;
      if (this.meleeSwingTimer > 0) {
        const s = Math.sin((this.meleeSwingTimer / 0.36) * Math.PI);
        meleeX = -0.22 * s;
        meleeY = -0.04 * s;
        meleeYaw = 0.85 * s;
        meleeRoll = 0.9 * s;
      }

      activeGroup.position.lerpVectors(baseHip, baseAds, this.adsAlpha);
      activeGroup.position.x += bobX + this.swayX * (1 - this.adsAlpha * 0.72) + meleeX;
      activeGroup.position.y += bobY + this.swayY * (1 - this.adsAlpha * 0.72) + reloadDropY + sprintDrop + swapDrop + meleeY;
      activeGroup.position.z += this.recoilZ;

      activeGroup.rotation.set(
        this.recoilPitch + reloadPitchX,
        sprintTilt * 0.7 + this.swayX * 1.4 + meleeYaw,
        reloadTiltZ - sprintTilt * 0.35 + slideRoll + meleeRoll
      );
      if (this.activeSlot === 'secondary') {
        this.pistolSlideMesh.position.z = -0.085 + this.boltOffset * 0.85;
      } else {
        this.boltMesh.position.z = -0.03 + this.boltOffset;
      }

      this._updateCasingsAndTracers(dt);
    }

    _fireOneShot(playerState, enemyManager, onHitCallback) {
      const cfg = this.currentConfig;
      const sup = this.suppressorAttached;
      this.ammo--;
      this.stats.shotsFired++;
      this.timeSinceShot = 0;
      this.burstCount = Math.min(20, this.burstCount + 1);
      this.muzzleHeat = Math.min(1.0, this.muzzleHeat + (sup ? 0.14 : 0.24));
      this.audio.playGunshot({ suppressed: sup, weaponType: cfg.id });

      // 枪口火光（消音时大幅削减火花与照度）
      const activeGroup = this.activeSlot === 'secondary' ? this.pistolGroup : this.rifleGroup;
      const activeAnchor = this.activeSlot === 'secondary' ? this.pistolMuzzleAnchor : this.muzzleAnchor;
      const barrelZ = sup ? -0.18 : 0;
      this.muzzleGroup.position.set(
        activeGroup.position.x + activeAnchor.position.x,
        activeGroup.position.y + activeAnchor.position.y,
        activeGroup.position.z + activeAnchor.position.z + barrelZ
      );
      this.muzzleFlashTimer = sup ? 0.03 : 0.058;
      this.muzzleGroup.visible = !this.ads3DHidden;
      this.muzzleGroup.rotation.z = Math.random() * Math.PI * 2;
      const ms = (sup ? 0.34 : 0.85) + Math.random() * 0.35;
      this.muzzleGroup.scale.set(ms, ms, ms);
      this.muzzleLight.intensity = sup ? 3.5 : 16;
      this.camera.updateMatrixWorld(true);
      this.muzzleGroup.getWorldPosition(this.muzzleWorldPos);
      if (this.render.spawnSmoke) {
        this.render.spawnSmoke(this.muzzleWorldPos, sup ? 1 : 2, 0.22, 1.0, 0xd8e0ea);
      }

      // 受控后坐力与镜头微震（ADS 下抑制 3D 枪身视效上仰幅度，防止挡住中心准点）
      const adsMul = 1 - this.adsAlpha * 0.44;
      const adsVisScale = 1 - this.adsAlpha * 0.58;
      const maxVisPitch = this.adsAlpha > 0.5 ? 0.052 : 0.18;
      const diffRecoil = (this.diffModifiers && this.diffModifiers.recoilScale) || 1.0;
      const kick = (cfg.recoilKick || 1.0) * diffRecoil;
      const earlyStabilize = this.burstCount <= 3 ? 0.78 : 1.0;
      const sCurveYaw = (Math.sin(this.burstCount * 0.72) * 0.0085 + (Math.random() - 0.5) * 0.005) * kick;
      this.recoilZ = Math.min(0.095, this.recoilZ + 0.042 * adsVisScale * kick);
      this.recoilPitch = Math.min(maxVisPitch, this.recoilPitch + 0.052 * adsVisScale * kick);
      this.boltOffset = 0.048;
      this.camRecoilPitch = Math.min(0.22, this.camRecoilPitch + 0.0155 * adsMul * earlyStabilize * kick);
      this.camRecoilYaw = Math.max(-0.09, Math.min(0.09, this.camRecoilYaw + sCurveYaw * adsMul));
      if (playerState && typeof playerState.addTrauma === 'function') {
        playerState.addTrauma(0.14 * adsMul * Math.min(1.5, kick));
      }

      this._spawnCasing();

      this.camera.getWorldPosition(this._rayOrigin);
      this.camera.getWorldDirection(this._baseDirTmp);
      const baseDir = this._getAimAssistedDirection(this._baseDirTmp, enemyManager);
      const spread = this.getCurrentSpread(playerState.moveSpeed, playerState.crouching);
      const pellets = cfg.pellets || 1;
      const enemyHitboxes = enemyManager.getActiveHitboxes();
      const barrelHitboxes = this.level.getActiveBarrelHitboxes ? this.level.getActiveBarrelHitboxes() : [];
      const breakerHitboxes = this.level.getBreakerHitboxes ? this.level.getBreakerHitboxes() : [];

      let pelletHitRegistered = false;
      let shotHit = false;
      let shotCrit = false;
      let shotKill = false;
      let shotBlocked = false;
      const hitEnd = this._hitEnd;
      const norm = this._normTmp;

      for (let p = 0; p < pellets; p++) {
        this._rayDir.copy(baseDir);
        this._rayDir.x += (Math.random() - 0.5) * spread * 2;
        this._rayDir.y += (Math.random() - 0.5) * spread * 2;
        this._rayDir.z += (Math.random() - 0.5) * spread * 2;
        this._rayDir.normalize();

        this._raycaster.set(this._rayOrigin, this._rayDir);
        this._raycaster.near = 0.2;
        this._raycaster.far = 140;

        const worldHits = this._raycaster.intersectObjects(this.level.collision.rayMeshes, false);
        const enemyHits = enemyHitboxes.length > 0 ? this._raycaster.intersectObjects(enemyHitboxes, false) : [];
        const barrelHits = barrelHitboxes.length > 0 ? this._raycaster.intersectObjects(barrelHitboxes, false) : [];
        const breakerHits = breakerHitboxes.length > 0 ? this._raycaster.intersectObjects(breakerHitboxes, false) : [];

        let bestDist = 130;
        let bestType = 'none';
        if (worldHits.length > 0 && worldHits[0].distance < bestDist) {
          bestDist = worldHits[0].distance;
          bestType = 'world';
        }
        if (enemyHits.length > 0 && enemyHits[0].distance <= bestDist) {
          bestDist = enemyHits[0].distance;
          bestType = 'enemy';
        }
        if (barrelHits.length > 0 && barrelHits[0].distance <= bestDist) {
          bestDist = barrelHits[0].distance;
          bestType = 'barrel';
        }
        if (breakerHits.length > 0 && breakerHits[0].distance <= bestDist) {
          bestDist = breakerHits[0].distance;
          bestType = 'breaker';
        }

        hitEnd.copy(this._rayOrigin).addScaledVector(this._rayDir, bestDist);

        if (bestType === 'enemy') {
          const eh = enemyHits[0];
          hitEnd.copy(eh.point);
          const enemy = eh.object.userData.enemy;
          const isCrit = !!eh.object.userData.isWeakpoint;
          const hitShield = !!eh.object.userData.isShield;

          const dmgRes = (window.GameLogic && window.GameLogic.computeShotDamage)
            ? window.GameLogic.computeShotDamage({
              weaponCfg: cfg,
              suppressorAttached: sup,
              isCrit,
              hitShield,
              enemyEmpStunned: (enemy.empTimer || 0) > 0,
              perkDamageMult: this.perks.ap_rounds ? 1.25 : 1.0,
              perkArmorPierceBonus: this.perks.ap_rounds ? 0.35 : 0,
              perkCritBonus: (this.perks.tactical_optics ? 0.25 : 0) + ((this.diffModifiers && this.diffModifiers.playerCritBonus) || 0),
            })
            : { finalDamage: isCrit ? 54 : 27, blockedByShield: false, piercedShield: false };

          if (eh.face) {
            norm.copy(eh.face.normal).transformDirection(eh.object.matrixWorld);
          } else {
            norm.copy(this._rayDir).negate();
          }

          if (enemy.requireMeleeKill) {
            enemy.takeDamage(0, eh.point, false);
            shotBlocked = true;
            this.render.spawnSparks(eh.point, norm, 10, 1.0);
          } else if (dmgRes.blockedByShield) {
            shotBlocked = true;
            this.render.spawnSparks(eh.point, norm, 14, 1.35);
          } else {
            const killed = enemy.takeDamage(dmgRes.finalDamage, eh.point, isCrit);
            if (!pelletHitRegistered) {
              this.stats.shotsHit++;
              pelletHitRegistered = true;
            }
            if (isCrit) this.stats.crits++;
            shotHit = true;
            if (isCrit) shotCrit = true;
            if (killed) {
              shotKill = true;
              if (onHitCallback) onHitCallback(isCrit, true, false);
            }
            this.render.spawnSparks(eh.point, norm, isCrit ? 18 : 10, isCrit ? 1.3 : 0.9);
          }
        } else if (bestType === 'barrel') {
          const bh = barrelHits[0];
          hitEnd.copy(bh.point);
          const barrel = bh.object.userData.barrel;
          if (bh.face) {
            norm.copy(bh.face.normal).transformDirection(bh.object.matrixWorld);
          } else {
            norm.copy(this._rayDir).negate();
          }
          this.render.spawnSparks(bh.point, norm, 10, 0.95);
          this.audio.playMetalImpact(bh.distance, bh.point);
          if (!pelletHitRegistered) {
            this.stats.shotsHit++;
            pelletHitRegistered = true;
          }
          shotHit = true;
          if (this.onBarrelHit && barrel) this.onBarrelHit(barrel, Math.round(cfg.baseDamage));
        } else if (bestType === 'breaker') {
          const brh = breakerHits[0];
          hitEnd.copy(brh.point);
          const breaker = brh.object.userData.breaker;
          this.audio.playMetalImpact(brh.distance, brh.point);
          if (this.level.triggerBreaker && this.level.triggerBreaker(breaker)) {
            if (this.audio.playEmpBlast) this.audio.playEmpBlast(breaker.pos);
            if (this.onBreakerHit) this.onBreakerHit(breaker);
          }
        } else if (bestType === 'world') {
          const wh = worldHits[0];
          hitEnd.copy(wh.point);
          if (wh.face) {
            norm.copy(wh.face.normal).transformDirection(wh.object.matrixWorld);
          } else {
            norm.set(0, 1, 0);
          }
          this.render.spawnSparks(wh.point, norm, 8, 0.85);
          this.audio.playMetalImpact(wh.distance, wh.point);

          const inPuddle = wh.point.y < 0.15 && this.tex.samplePuddleMask(wh.point.x, wh.point.z) > 0.25;
          if (!inPuddle && !(wh.object.userData && wh.object.userData.noDecal)) {
            if (this.render.spawnBulletDecal) this.render.spawnBulletDecal(wh.point, norm);
            if (this.render.spawnSmoke) this.render.spawnSmoke(wh.point, 2, 0.2, 1.3, 0xb8c2ce);
          }
        }

        if (p < 3 || pellets === 1) {
          this._spawnTracer(this.muzzleWorldPos, hitEnd);
        }
      }

      // 单枪命中/弹反音频去重：霰弹枪同帧多弹丸只播一次最高优先级反馈音
      if (shotHit) {
        this.audio.playHitmarker(shotCrit, shotKill);
        if (!shotKill && onHitCallback) onHitCallback(shotCrit, false, false);
      } else if (shotBlocked) {
        if (this.audio.playShieldDeflect) this.audio.playShieldDeflect();
        if (onHitCallback) onHitCallback(false, false, true);
      }

      // 枪声噪音半径：消音仅传 6.5m~13.5m（外圈进黄警排查），未消音高达 28m~48m
      const noiseRange = sup ? (cfg.noiseSuppressed || 11) : (cfg.noiseLoud || 40);
      if (enemyManager.alertSound) {
        enemyManager.alertSound(this._rayOrigin, noiseRange, true, sup);
      } else if (enemyManager.alertNearby) {
        enemyManager.alertNearby(this._rayOrigin, noiseRange);
      }

      if (this.ammo === 0) {
        if (this.reserveAmmo > 0) {
          if (this.onEmptyReload) this.onEmptyReload();
          this.startReload();
        } else if (this.onLowReserve) {
          this.onLowReserve();
        }
      }
    }

    _spawnCasing() {
      const activeGroup = this.activeSlot === 'secondary' ? this.pistolGroup : this.rifleGroup;
      for (let i = 0; i < this.maxCasings; i++) {
        const c = this.casings[i];
        if (!c.active) {
          c.active = true;
          c.life = 0;
          activeGroup.localToWorld(c.pos.set(0.03, 0.02, -0.03));

          this._casingRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
          this._casingUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
          c.vel.copy(this._casingRight).multiplyScalar(2.4 + Math.random() * 1.1)
            .addScaledVector(this._casingUp, 1.8 + Math.random() * 0.9);
          c.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);

          const puddle = this.tex.samplePuddleMask(c.pos.x, c.pos.z);
          this.audio.playShellClink(puddle > 0.25, c.pos);
          break;
        }
      }
    }

    _spawnTracer(start, end) {
      for (let i = 0; i < this.maxTracers; i++) {
        const t = this.tracers[i];
        if (!t.active) {
          t.active = true;
          t.start.copy(start);
          t.end.copy(end);
          t.dist = Math.max(0.5, start.distanceTo(end));
          t.progress = 0;
          break;
        }
      }
    }

    _updateCasingsAndTracers(dt) {
      let casingDirty = false;
      for (let i = 0; i < this.maxCasings; i++) {
        const c = this.casings[i];
        if (!c.active) continue;
        casingDirty = true;
        c.life += dt;
        if (c.life > 1.8) {
          c.active = false;
          this.casingMesh.setMatrixAt(i, this._zeroMat);
          continue;
        }
        c.vel.y -= 13.5 * dt;
        c.pos.addScaledVector(c.vel, dt);
        if (c.pos.y < 0.02) {
          c.pos.y = 0.02;
          c.vel.y = Math.abs(c.vel.y) * 0.35;
          c.vel.x *= 0.6;
          c.vel.z *= 0.6;
        }
        c.rot.x += dt * 14;
        c.rot.y += dt * 10;
        this._dummy.position.copy(c.pos);
        this._dummy.rotation.copy(c.rot);
        this._dummy.scale.setScalar(1);
        this._dummy.updateMatrix();
        this.casingMesh.setMatrixAt(i, this._dummy.matrix);
      }
      if (casingDirty) this.casingMesh.instanceMatrix.needsUpdate = true;

      let tracerDirty = false;
      for (let i = 0; i < this.maxTracers; i++) {
        const t = this.tracers[i];
        if (!t.active) continue;
        tracerDirty = true;
        t.progress += (t.speed * dt) / t.dist;
        if (t.progress >= 1) {
          t.active = false;
          this.tracerMesh.setMatrixAt(i, this._zeroMat);
          continue;
        }
        this._tracerCur.lerpVectors(t.start, t.end, t.progress);
        this._dummy.position.copy(this._tracerCur);
        this._dummy.lookAt(t.end);
        const segLen = Math.min(2.6, t.dist * 0.45);
        this._dummy.scale.set(1, 1, segLen);
        this._dummy.updateMatrix();
        this.tracerMesh.setMatrixAt(i, this._dummy.matrix);
      }
      if (tracerDirty) this.tracerMesh.instanceMatrix.needsUpdate = true;
    }
  }

  return Weapon;
})();
