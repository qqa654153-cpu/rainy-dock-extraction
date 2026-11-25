// ============================================================================
// 模块 0：全量双语本地化核心 (I18n: zh / en)
// Classic global IIFE (file:// and Node vm safe, no ES modules)
// ============================================================================

const I18n = (() => {
  'use strict';

  const SUPPORTED_LANGS = Object.freeze(['zh', 'en']);
  const STORAGE_KEY = 'storm_pier_lang_v1';

  const DICT = {
    zh: {
      'app.title': '暴雨夜码头 · 战术撤离行动',
      'canvas.aria': '暴雨夜集装箱码头三维射击画布',
      'aria.langSwitch': '界面语言',

      // HUD
      'hud.diffDefault': '难度：标准行动',
      'hud.stealthDefault': '状态：隐匿潜行',
      'hud.objDefault': '切断通信中继器 (0/3)',
      'hud.relayA': '中继器 A',
      'hud.relayB': '中继器 B',
      'hud.relayC': '中继器 C',
      'hud.holdoutLabel': '撤离锚链解锁倒计时',
      'hud.tutSkipHint': '[Tab] 跳过引导直入实战',
      'hud.interactDefault': '长按 [E] 切断中继器',
      'hud.armorLabel': '护甲生命值',
      'hud.regenTag': '恢复中',
      'hud.wpnDefault': 'CAR-47 破晓 // 战术卡宾枪',
      'hud.slotPrimary': '[1] 主武器',
      'hud.supOff': '[T] 消音：卸',
      'hud.grenadeDefault': '[G/4] EMP雷 x2',
      'hud.scanReady': '[Q] 扫描就绪',
      'hud.reloading': '正在换弹...',
      'hud.flashOn': '枪灯：开',
      'hud.hintSlide': '[Shift+C] 滑铲',
      'hud.hintMelee': '[V] 处决',
      'hud.hintReload': '[R] 换弹',
      'hud.hintLight': '[F] 枪灯',

      // Radio Roles
      'radio.instructor': '教官',
      'radio.watcher': '守望者 // 频道 04',
      'radio.evac': '撤离艇',

      // Main Menu
      'menu.desc': '渗透至被机器军团控制的 04 号集装箱码头。任意顺序切断 3 处通信中继器，守住撤离倒计时后前往东北泊位登船撤离。',
      'menu.diffAria': '行动难度选择',
      'menu.diffLegend': '行动难度选择 · 新手护航至硬核拟真（教学与定时靶场固定标准基准）',

      'diff.recruit.title': '新兵护航',
      'diff.recruit.badge': '零基础推荐',
      'diff.recruit.meta': '柔和辅助瞄准 · 低后坐全回血',
      'diff.standard.title': '标准行动',
      'diff.standard.badge': '经典默认',
      'diff.standard.meta': '1.0x 原版平衡 · 全系统标准基准',
      'diff.standard.summary': '原版标准均衡数值，适合多数玩家完整体验潜行与突击节奏 · 评分 1.00x',
      'diff.veteran.title': '老兵特遣',
      'diff.veteran.badge': '老枪手推荐',
      'diff.veteran.meta': '+25% 评分 · 高压快反应 · 弱点收益↑',
      'diff.realism.title': '拟真夜战',
      'diff.realism.badge': '硬核无准星',
      'diff.realism.meta': '+50% 评分 · 去准星依赖 3D 全息/倍镜',

      'menu.loadoutSummaryDefault': '武器配装与挑战词缀（CAR-47 · 标准暗钢）',
      'menu.weaponLegend': '主战武器配置 [1] · 标配 [2] 消音 USP-9',
      'weapon.car47.cardTitle': 'CAR-47 卡宾枪',
      'weapon.car47.cardMeta': '全自动均衡突击 · 30发弹匣',
      'weapon.car47.fallbackName': 'CAR-47 战术卡宾枪',
      'weapon.dmr.cardTitle': 'MK-14 DMR',
      'weapon.dmr.cardMeta': '高穿甲精确射手 · 2.3x 暴击',
      'weapon.shotgun.cardTitle': 'M890 破门霰弹',
      'weapon.shotgun.cardMeta': '7发钢珠近战清场爆破',

      'menu.skinLegend': '枪械战术涂装（通关/S级解锁）',
      'skin.standard.title': '标准暗钢',
      'skin.standard.meta': '制式哑光碳钢',
      'skin.night_ops.title': '夜幕幽灵',
      'skin.night_ops.meta': 'A/S级或零警通关解锁',
      'skin.hazmat_blue.title': '海军蓝 HAZMAT',
      'skin.hazmat_blue.meta': '3次通关或S级解锁',

      'menu.mutatorLegend': '可叠加挑战词缀（额外提升 S 级评分倍率）',
      'mutator.blackout.title': '全图停电 +20%',
      'mutator.blackout.meta': '照明熄灭，强依赖 F/Q',
      'mutator.explosive_tide.title': '高爆狂潮 +15%',
      'mutator.explosive_tide.meta': '额外红桶 + 破片增威',
      'mutator.elite_patrol.title': '精锐巡防 +25%',
      'mutator.elite_patrol.meta': '防爆盾与高台激光狙开局布防',

      // Settings Disclosure
      'menu.settingsSummary': '操作指南与画面 / 灵敏度 / 音频设置',
      'menu.ctrlBrief': '<strong>操作指南：</strong>WASD 移动 · Shift 冲刺 · C 下蹲 · <strong>Shift+C 滑铲</strong> · 右键开镜(靠墙自动探头) · <strong>T 消音热装卸</strong> · <strong>1/2 切枪</strong> · <strong>按住 G 预瞄抛物线/松手投掷(右键取消) · 4 切投掷物</strong> · <strong>Q 扫描</strong> · <strong>V 近战/背刺</strong> · E 交互(近中继器按 G 贴 C4 强破)',
      'opt.quality': '画质预设',
      'opt.quality.extreme': '极限画质（SSR/GTAO + 动态投影 + 体积雾 + 高模 + AgX）',
      'opt.quality.high': '高画质（HDR泛光 + 镜头雨滴 + 水洼倒影）',
      'opt.quality.medium': '中画质（优化倒影 + HDR泛光）',
      'opt.quality.low': '低画质（原生直出 · 极致流畅）',
      'opt.drs.label': '动态分辨率保护 (DRS)',
      'opt.drs.hint': '极限画质帧率低于 55 FPS 时自动阶梯降分辨率稳住 60 FPS',
      'opt.sens': '鼠标灵敏度',
      'opt.vol': '主音量',
      'opt.voiceVol': '语音音量',
      'opt.voiceLang': '语音语言',
      'opt.voiceLang.auto': '跟随界面语言（自动）',
      'opt.voiceLang.zh': '中文语音 (ZH)',
      'opt.voiceLang.en': '英文语音 (EN)',
      'opt.voiceMode': '电台音色',
      'opt.voiceMode.radio': '战术对讲机滤波（推荐）',
      'opt.voiceMode.clean': '清晰原声直出',
      'opt.voiceMode.off': '关闭电台语音',
      'opt.toggleAds.label': '切换开镜 (Toggle ADS)',
      'opt.toggleAds.hint': '右键单击切换瞄准状态，再按右键或冲刺时自动退出',
      'opt.invertY.label': '反转垂直视角 (Invert Y)',
      'opt.invertY.hint': '鼠标上移低头、下移抬头',

      // Main Actions
      'btn.startTutorial': '开始新手教程（推荐）',
      'btn.deployDirect': '直接实战部署',
      'btn.openTraining': '训练模式 · 限时 / 无尽 / 关卡练习',
      'btn.returnMain': '返回主菜单',

      // Training Center
      'aria.trainTablist': '训练子模式',
      'train.tab.timed': '限时模式',
      'train.tab.endless': '无尽模式',
      'train.tab.stage': '关卡练习',
      'train.timed.desc': '安全靶场冲刺（无敌不受伤）。倒计时内快速击毁南侧中庭多距离移动靶机，精准命中红色核心触发 1 枪秒杀暴击并叠加连击倍率。',
      'aria.timedDuration': '限时模式倒计时长',
      'train.timed.d30': '30 秒冲刺',
      'train.timed.d60': '60 秒标准',
      'train.timed.d90': '90 秒耐力',
      'train.endless.desc': '真实战斗波次生存（第 2 波起出现警戒机兵、防爆重装与高台激光狙击手）。每波肃清触发三选一战术空投增益，并按波次补充弹药与回复护甲！',
      'train.stage.desc': '自由任选 04 号码头 6 大战术战区（含潜行消音摸哨与重装破盾反狙专项演练）展开实战练习。',
      'aria.stageGrid': '选择练习关卡',
      'train.stage.invulnLabel': '无伤练路线（防阵亡）',
      'train.stage.invulnHint': '开启后保留受击方向提醒但不会阵亡；仅记“演练通关”，不刷正式最快用时',
      'train.btnBack': '← 返回',
      'train.btnStart': '开始训练（锁定视角）',

      // Airdrop
      'airdrop.title': '战术空投补给 // 选择一项波间强化',
      'airdrop.desc': '护甲与弹药已同步补给。请立刻选取空投模块继续迎战下一波机械集群：',

      // Level Entities (10)
      'level.relay.A': '中继器 A（西侧探照灯堆场）',
      'level.relay.B': '中继器 B（铁皮仓库内部）',
      'level.relay.C': '中继器 C（龙门吊高台控制）',
      'level.relay.SIM': '模拟通信中继器',
      'level.breaker.A': 'A区探照灯配电箱',
      'level.breaker.B': 'B区仓库照明总闸',
      'level.ammo.south': '南侧码头弹药箱',
      'level.ammo.west': '西区高台前弹药箱',
      'level.ammo.warehouse': '仓库内西南角弹药箱',
      'level.ammo.east': '东侧龙门区弹药箱',

      // Warmup Progress (15 + banner title)
      'warmup.bannerTitle': '正在后台异步预编译极限画质管线...',
      'warmup.alreadyPrepared': '极限画质已预热',
      'warmup.assemblingAssets': '装配极高细节资产与材质',
      'warmup.bakeMicroNoise': '烘焙微表面细节噪点',
      'warmup.bakeAsphaltHeight': '烘焙湿滑沥青高度场',
      'warmup.synthAsphaltMaps': '合成沥青漫反射与粗糙度',
      'warmup.genAsphaltNormal': '生成沥青高精度法线贴图',
      'warmup.bakeConcreteBase': '烘焙工业水泥地坪材质',
      'warmup.synthConcreteMaps': '合成水泥粗糙度与法线',
      'warmup.bakeHdrProbe': '烘焙暮色 HDR 环境光探针',
      'warmup.reusePbr': '复用已烘焙 PBR 纹理',
      'warmup.bakeComplete': 'PBR 纹理烘焙完成',
      'warmup.collectVariants': '收集场景材质变体',
      'warmup.compileSceneShaders': '异步预编译场景着色器 ({done}/{total})',
      'warmup.compilePostPipeline': '异步预编译后期与光学管线',
      'warmup.pipelineReady': '极限画质管线就绪',
    },

    en: {
      'app.title': 'Rainy Dock: Tactical Extraction',
      'canvas.aria': 'Rainy Container Dock 3D Tactical Shooter Canvas',
      'aria.langSwitch': 'Interface Language',

      // HUD
      'hud.diffDefault': 'Difficulty: Standard',
      'hud.stealthDefault': 'Status: Stealth',
      'hud.objDefault': 'Sever Comms Relays (0/3)',
      'hud.relayA': 'Relay A',
      'hud.relayB': 'Relay B',
      'hud.relayC': 'Relay C',
      'hud.holdoutLabel': 'Extraction Anchor Unlock',
      'hud.tutSkipHint': '[Tab] Skip Tutorial -> Deploy',
      'hud.interactDefault': 'Hold [E] Sever Relay',
      'hud.armorLabel': 'ARMOR / HP',
      'hud.regenTag': 'REGEN',
      'hud.wpnDefault': 'CAR-47 Dawnbreaker // Tactical Carbine',
      'hud.slotPrimary': '[1] Primary',
      'hud.supOff': '[T] Sup: OFF',
      'hud.grenadeDefault': '[G/4] EMP x2',
      'hud.scanReady': '[Q] Scan Ready',
      'hud.reloading': 'RELOADING...',
      'hud.flashOn': 'Light: ON',
      'hud.hintSlide': '[Shift+C] Slide',
      'hud.hintMelee': '[V] Execute',
      'hud.hintReload': '[R] Reload',
      'hud.hintLight': '[F] Light',

      // Radio Roles
      'radio.instructor': 'INSTRUCTOR',
      'radio.watcher': 'OVERWATCH // CH-04',
      'radio.evac': 'EVAC-01',

      // Main Menu
      'menu.desc': 'Infiltrate Container Pier 04 under autonomous mech occupation. Sever all 3 comms relays in any order, hold through the extraction countdown, and board the boat at the NE berth.',
      'menu.diffAria': 'Mission Difficulty Selection',
      'menu.diffLegend': 'Mission Difficulty · Recruit Assist to Hardcore Realism (Tutorial & Timed Range locked to Standard)',

      'diff.recruit.title': 'Recruit',
      'diff.recruit.badge': 'Beginner',
      'diff.recruit.meta': 'Gentle Aim Assist · Low Recoil · Full Regen',
      'diff.standard.title': 'Standard',
      'diff.standard.badge': 'Default',
      'diff.standard.meta': '1.0x Original Balance · Standard Baseline',
      'diff.standard.summary': 'Balanced baseline tuning for full stealth and assault pacing · Score 1.00x',
      'diff.veteran.title': 'Veteran',
      'diff.veteran.badge': 'Marksman',
      'diff.veteran.meta': '+25% Score · Aggressive AI · Higher Crit Bonus',
      'diff.realism.title': 'Realism',
      'diff.realism.badge': 'No Crosshair',
      'diff.realism.meta': '+50% Score · No Crosshair · 3D Optics Only',

      'menu.loadoutSummaryDefault': 'Loadout & Challenge Mutators (CAR-47 · Dark Steel)',
      'menu.weaponLegend': 'Primary Weapon [1] · Sidearm [2] Suppressed USP-9',
      'weapon.car47.cardTitle': 'CAR-47 Carbine',
      'weapon.car47.cardMeta': 'Full-Auto Balanced Assault · 30-Rd Mag',
      'weapon.car47.fallbackName': 'CAR-47 Tactical Carbine',
      'weapon.dmr.cardTitle': 'MK-14 DMR',
      'weapon.dmr.cardMeta': 'High-AP Marksman Rifle · 2.3x Crit',
      'weapon.shotgun.cardTitle': 'M890 Breacher',
      'weapon.shotgun.cardMeta': '7-Pellet CQB Room-Clearer',

      'menu.skinLegend': 'Tactical Weapon Finishes (Clear / S-Rank Unlocks)',
      'skin.standard.title': 'Dark Steel',
      'skin.standard.meta': 'Standard Matte Carbon Steel',
      'skin.night_ops.title': 'Night Ghost',
      'skin.night_ops.meta': 'Unlock: A/S Rank or Zero-Alert Clear',
      'skin.hazmat_blue.title': 'Navy HAZMAT',
      'skin.hazmat_blue.meta': 'Unlock: 3 Clears or S Rank',

      'menu.mutatorLegend': 'Stackable Challenge Mutators (Bonus S-Rank Multiplier)',
      'mutator.blackout.title': 'Total Blackout +20%',
      'mutator.blackout.meta': 'Area lights offline · Rely on [F] & [Q]',
      'mutator.explosive_tide.title': 'Volatile Surge +15%',
      'mutator.explosive_tide.meta': 'Extra fuel drums + boosted frag blast',
      'mutator.elite_patrol.title': 'Elite Garrison +25%',
      'mutator.elite_patrol.meta': 'Riot shields & sniper overwatch deployed early',

      // Settings Disclosure
      'menu.settingsSummary': 'Controls Guide & Video / Sensitivity / Audio Settings',
      'menu.ctrlBrief': '<strong>Controls:</strong> WASD Move · Shift Sprint · C Crouch · <strong>Shift+C Slide</strong> · RMB ADS (auto-peek at cover) · <strong>T Suppressor</strong> · <strong>1/2 Switch Weapon</strong> · <strong>Hold G Aim / Release Throw (RMB Cancel) · 4 Cycle Ordinance</strong> · <strong>Q Pulse Scan</strong> · <strong>V Melee / Backstab</strong> · E Interact (Press G near Relay to plant C4)',
      'opt.quality': 'Graphics Preset',
      'opt.quality.extreme': 'Extreme (SSR/GTAO + Dynamic Shadows + Volumetric Fog + High-Poly + AgX)',
      'opt.quality.high': 'High (HDR Bloom + Lens Raindrops + Puddle Reflections)',
      'opt.quality.medium': 'Medium (Optimized Reflections + HDR Bloom)',
      'opt.quality.low': 'Low (Native Pass · Max Framerate)',
      'opt.drs.label': 'Dynamic Resolution (DRS)',
      'opt.drs.hint': 'Scales down internal resolution below 55 FPS on Extreme to maintain 60 FPS',
      'opt.sens': 'Mouse Sensitivity',
      'opt.vol': 'Master Volume',
      'opt.voiceVol': 'Voice Volume',
      'opt.voiceLang': 'Voice Language',
      'opt.voiceLang.auto': 'Follow UI Language (Auto)',
      'opt.voiceLang.zh': 'Chinese Radio (ZH)',
      'opt.voiceLang.en': 'English Radio (EN)',
      'opt.voiceMode': 'Radio Filter',
      'opt.voiceMode.radio': 'Tactical Radio Filter (Recommended)',
      'opt.voiceMode.clean': 'Clean Studio Voice',
      'opt.voiceMode.off': 'Radio Voice Off',
      'opt.toggleAds.label': 'Toggle ADS',
      'opt.toggleAds.hint': 'Click RMB to toggle aim down sights; press RMB again or sprint to exit',
      'opt.invertY.label': 'Invert Y-Axis',
      'opt.invertY.hint': 'Push mouse up to look down, pull down to look up',

      // Main Actions
      'btn.startTutorial': 'Start Tutorial (Recommended)',
      'btn.deployDirect': 'Deploy to Operation',
      'btn.openTraining': 'Training Center · Timed / Endless / Drills',
      'btn.returnMain': 'Return to Main Menu',

      // Training Center
      'aria.trainTablist': 'Training Sub-modes',
      'train.tab.timed': 'Timed Range',
      'train.tab.endless': 'Endless Waves',
      'train.tab.stage': 'Stage Drills',
      'train.timed.desc': 'Safe live-fire sprint (invulnerable). Destroy moving drone targets across the south courtyard before time expires; strike red cores for 1-shot crits and combo multipliers.',
      'aria.timedDuration': 'Timed Range Duration',
      'train.timed.d30': '30s Sprint',
      'train.timed.d60': '60s Standard',
      'train.timed.d90': '90s Endurance',
      'train.endless.desc': 'Live combat wave survival (Sentries, Riot Heavies, and Overwatch Snipers enter from Wave 2). Clearing each wave drops a 3-choice Tactical Perk plus ammo and armor resupply.',
      'train.stage.desc': 'Deploy freely into any of Pier 04’s 6 tactical combat zones, including silenced infiltration and anti-shield/counter-sniper drills.',
      'aria.stageGrid': 'Select Practice Stage',
      'train.stage.invulnLabel': 'Invulnerable Route Drill',
      'train.stage.invulnHint': 'Keeps hit-direction cues while preventing death; records Practice Clear only (no speedrun PB)',
      'train.btnBack': '← Back',
      'train.btnStart': 'Start Training (Lock Pointer)',

      // Airdrop
      'airdrop.title': 'Tactical Airdrop // Select Wave Perk',
      'airdrop.desc': 'Armor and ammo resupplied. Select a tactical module to engage the next mech wave:',

      // Level Entities (10)
      'level.relay.A': 'Relay A (West Searchlight Yard)',
      'level.relay.B': 'Relay B (Sheet-Metal Warehouse)',
      'level.relay.C': 'Relay C (Gantry Crane Deck)',
      'level.relay.SIM': 'Simulated Comms Relay',
      'level.breaker.A': 'Zone A Searchlight Breaker Box',
      'level.breaker.B': 'Zone B Warehouse Main Breaker',
      'level.ammo.south': 'South Pier Ammo Crate',
      'level.ammo.west': 'West Platform Ammo Crate',
      'level.ammo.warehouse': 'Warehouse SW Corner Ammo Crate',
      'level.ammo.east': 'East Gantry Zone Ammo Crate',

      // Warmup Progress (15 + banner title)
      'warmup.bannerTitle': 'Precompiling Extreme graphics pipeline in background...',
      'warmup.alreadyPrepared': 'Extreme graphics ready',
      'warmup.assemblingAssets': 'Assembling high-detail assets and materials',
      'warmup.bakeMicroNoise': 'Baking micro-surface detail noise',
      'warmup.bakeAsphaltHeight': 'Baking wet asphalt heightfield',
      'warmup.synthAsphaltMaps': 'Synthesizing asphalt albedo and roughness',
      'warmup.genAsphaltNormal': 'Generating high-precision asphalt normal map',
      'warmup.bakeConcreteBase': 'Baking industrial concrete slab maps',
      'warmup.synthConcreteMaps': 'Synthesizing concrete roughness and normals',
      'warmup.bakeHdrProbe': 'Baking twilight HDR environment probe',
      'warmup.reusePbr': 'Reusing baked PBR textures',
      'warmup.bakeComplete': 'PBR texture baking complete',
      'warmup.collectVariants': 'Collecting scene material variants',
      'warmup.compileSceneShaders': 'Precompiling scene shaders ({done}/{total})',
      'warmup.compilePostPipeline': 'Precompiling post-processing & optics pipeline',
      'warmup.pipelineReady': 'Extreme graphics pipeline ready',
    },
  };

  const listeners = new Set();

  function normalizeLang(val) {
    if (typeof val !== 'string') return null;
    const v = val.trim().toLowerCase();
    return v === 'zh' || v === 'en' ? v : null;
  }

  function getSearchParamLang() {
    try {
      const loc = (typeof window !== 'undefined' && window && window.location)
        || (typeof location !== 'undefined' ? location : null);
      const search = loc && typeof loc.search === 'string' ? loc.search : '';
      if (!search) return null;
      if (typeof URLSearchParams !== 'undefined') {
        return normalizeLang(new URLSearchParams(search).get('lang'));
      }
      const m = /(?:^|[?&])lang=([^&]+)/i.exec(search);
      return m ? normalizeLang(decodeURIComponent(m[1])) : null;
    } catch (_) {
      return null;
    }
  }

  function getStoredLang() {
    try {
      const ls = (typeof window !== 'undefined' && window && window.localStorage)
        || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!ls || typeof ls.getItem !== 'function') return null;
      return normalizeLang(ls.getItem(STORAGE_KEY));
    } catch (_) {
      return null;
    }
  }

  function getNavigatorLang() {
    try {
      const nav = (typeof navigator !== 'undefined' && navigator)
        || (typeof window !== 'undefined' && window && window.navigator)
        || null;
      const raw = nav
        ? String(nav.language || (Array.isArray(nav.languages) && nav.languages[0]) || nav.userLanguage || '')
        : '';
      return /^zh/i.test(raw) ? 'zh' : 'en';
    } catch (_) {
      return 'en';
    }
  }

  function detectInitialLang() {
    return getSearchParamLang() || getStoredLang() || getNavigatorLang();
  }

  let currentLang = detectInitialLang();

  function getLang() {
    return currentLang;
  }

  function _lookup(key) {
    if (typeof key !== 'string' || !key) return null;
    const primary = DICT[currentLang];
    if (primary && Object.prototype.hasOwnProperty.call(primary, key)) {
      return primary[key];
    }
    const fbZh = DICT.zh;
    if (fbZh && Object.prototype.hasOwnProperty.call(fbZh, key)) {
      return fbZh[key];
    }
    const fbEn = DICT.en;
    if (fbEn && Object.prototype.hasOwnProperty.call(fbEn, key)) {
      return fbEn[key];
    }
    return null;
  }

  function t(key, params) {
    const raw = _lookup(key);
    let str = raw !== null && raw !== undefined ? String(raw) : String(key ?? '');
    if (params && typeof params === 'object') {
      str = str.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, token) => (
        Object.prototype.hasOwnProperty.call(params, token) && params[token] !== undefined && params[token] !== null
          ? String(params[token])
          : match
      ));
    }
    return str;
  }

  function pick(zh, en) {
    if (currentLang === 'en') {
      return en !== undefined && en !== null ? en : zh;
    }
    return zh !== undefined && zh !== null ? zh : en;
  }

  function field(obj, prop) {
    if (!obj || typeof obj !== 'object' || !prop) return '';
    if (currentLang === 'en') {
      const enKey = `${prop}En`;
      if (obj[enKey] !== undefined && obj[enKey] !== null && obj[enKey] !== '') {
        return obj[enKey];
      }
      return obj[prop] !== undefined && obj[prop] !== null ? obj[prop] : '';
    }
    if (obj[prop] !== undefined && obj[prop] !== null && obj[prop] !== '') {
      return obj[prop];
    }
    const enKey = `${prop}En`;
    return obj[enKey] !== undefined && obj[enKey] !== null ? obj[enKey] : '';
  }

  function resolveVoiceLang(setting) {
    const norm = normalizeLang(setting);
    if (norm) return norm;
    return currentLang;
  }

  function register(zhMap, enMap) {
    if (zhMap && typeof zhMap === 'object') {
      Object.assign(DICT.zh, zhMap);
    }
    if (enMap && typeof enMap === 'object') {
      Object.assign(DICT.en, enMap);
    }
    return api;
  }

  function applyDOM(root) {
    const doc = typeof document !== 'undefined' ? document : null;
    const target = root !== undefined ? root : doc;
    if (!target || typeof target !== 'object') return;

    if (doc && target === doc) {
      if (doc.documentElement) {
        doc.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
      }
      if (_lookup('app.title') !== null) {
        doc.title = t('app.title');
      }
    }

    if (typeof target.querySelectorAll !== 'function') return;

    const textNodes = target.querySelectorAll('[data-i18n]');
    for (let i = 0; i < textNodes.length; i++) {
      const el = textNodes[i];
      const key = el.getAttribute('data-i18n');
      if (key && _lookup(key) !== null) {
        el.textContent = t(key);
      }
    }

    const htmlNodes = target.querySelectorAll('[data-i18n-html]');
    for (let i = 0; i < htmlNodes.length; i++) {
      const el = htmlNodes[i];
      const key = el.getAttribute('data-i18n-html');
      if (key && _lookup(key) !== null) {
        el.innerHTML = t(key);
      }
    }

    const ariaNodes = target.querySelectorAll('[data-i18n-aria]');
    for (let i = 0; i < ariaNodes.length; i++) {
      const el = ariaNodes[i];
      const key = el.getAttribute('data-i18n-aria');
      if (key && _lookup(key) !== null) {
        el.setAttribute('aria-label', t(key));
      }
    }

    const titleNodes = target.querySelectorAll('[data-i18n-title]');
    for (let i = 0; i < titleNodes.length; i++) {
      const el = titleNodes[i];
      const key = el.getAttribute('data-i18n-title');
      if (key && _lookup(key) !== null) {
        el.setAttribute('title', t(key));
      }
    }

    const langBtns = target.querySelectorAll('.lang-btn[data-lang]');
    for (let i = 0; i < langBtns.length; i++) {
      const btn = langBtns[i];
      const btnLang = btn.getAttribute('data-lang');
      btn.setAttribute('aria-pressed', btnLang === currentLang ? 'true' : 'false');
    }
  }

  function setLang(lang, persist = true) {
    const next = normalizeLang(lang);
    if (!next) return currentLang;
    const prev = currentLang;
    const changed = next !== prev;
    currentLang = next;

    if (persist) {
      try {
        const ls = (typeof window !== 'undefined' && window && window.localStorage)
          || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (ls && typeof ls.setItem === 'function') {
          ls.setItem(STORAGE_KEY, next);
        }
      } catch (_) {}
    }

    applyDOM();

    if (changed) {
      for (const cb of Array.from(listeners)) {
        try {
          cb(next, prev);
        } catch (err) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[I18n] onChange listener error:', err);
          }
        }
      }
    }
    return currentLang;
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  const api = {
    SUPPORTED_LANGS,
    STORAGE_KEY,
    DICT,
    register,
    detectInitialLang,
    getLang,
    setLang,
    t,
    pick,
    field,
    resolveVoiceLang,
    applyDOM,
    onChange,
  };

  return api;
})();

if (typeof window !== 'undefined') window.I18n = I18n;
if (typeof globalThis !== 'undefined' && typeof globalThis.I18n === 'undefined') {
  globalThis.I18n = I18n;
}

I18n.register(
  {
    // HUD runtime
    'hud.enemy.drone': '巡逻无人机',
    'hud.enemy.hound': '突袭机械犬',
    'hud.enemy.shield': '防爆重装机兵',
    'hud.enemy.sniper': '高台激光狙',
    'hud.enemy.recon': '警戒发报机',
    'hud.enemy.unknown': '敌方单位',
    'hud.killSuffixSilent': ' // 无声处决',
    'hud.killSuffixCrit': ' // 弱点暴击',
    'hud.killFeed': '已消灭 {label}{suffix}',
    'hud.dir.N': '北',
    'hud.dir.NE': '东北',
    'hud.dir.E': '东',
    'hud.dir.SE': '东南',
    'hud.dir.S': '南',
    'hud.dir.SW': '西南',
    'hud.dir.W': '西',
    'hud.dir.NW': '西北',
    'hud.markerRelay': '中继器 {id}',
    'hud.markerEvac': '撤离船只',
    'hud.objCutRelays': '切断通信中继器 ({count}/3)',
    'hud.objHoldout': '3/3 中继器断开 · 死守撤离区等待快艇解锁',
    'hud.objExtract': '快艇已就绪 · 前往东北泊位登船撤离',
    'hud.stealthPatrol': '状态：隐匿潜行',
    'hud.stealthSniperLock': '⚠ 高台激光狙锁定预警！',
    'hud.stealthCallIn': '⚠ 敌机发报呼叫增援！',
    'hud.stealthCombat': '状态：全面交火',
    'hud.stealthSuspicious': '状态：警戒核查 ({pct}%)',
    'hud.supOn': '[T] 消音：装',
    'hud.scanCooldown': '[Q] 扫描 {sec}s',
    'hud.diffBenchmark': '难度：标准基准',
    'hud.diffLabel': '难度：{name}',
    'hud.flashOff': '枪灯：关',

    // Tutorial
    'tut.primaryFallback': '主武器',
    'tut.sight.dmr': '{weapon} 高倍密位狙击镜',
    'tut.sight.shotgun': '{weapon} 开放式环形反射镜',
    'tut.sight.carbine': '{weapon} 宽视窗全息瞄准镜',
    'tut.speaker.stealth': '教官 // 潜行考核',
    'tut.speaker.shield': '教官 // 破盾考核',
    'tut.speaker.complete': '教官 // 结业考核',
    'tut.speaker.step': '教官 // 战术引导 {step}/8',
    'tut.blocked.melee': '该靶体免疫常规枪弹测试！请先按 [Q] 脉冲扫描，再绕至背面靠近按 [V] 无声处决！',
    'tut.blocked.emp': '防爆盾未破除前无法正面贯穿！先用 [4]/[G] 切出并投掷 EMP 瘫痪护盾，再开火或爆破击杀！',
    'tut.radio.complete': '全部 8 项战术演练达标！2 秒后将在南侧泊位满状态重置，正式开启「0/3 中继器切断」实战撤离任务！',
    'tut.radio.step1': '欢迎来到 04 号码头。先热身基础机动：WASD 移动、按住 Shift 冲刺、冲刺中按 C 滑铲、按 C 下蹲利用掩体，并按 F 切换战术枪灯。',
    'tut.radio.step2': '机动良好！按住右键使用「{sight}」开镜（ADS）并点射 3 发，然后按 [1]/[2] 切换副手枪，再按 [T] 体验现场装卸消音器。',
    'tut.radio.step3': '前方 13 米已投放训练靶机！瞄准正中红色核心打出 2 倍金色暴击将其击毁，随后按 [R] 将当前弹匣补满（{mag} 发）。',
    'tut.radio.step4': '潜行暗杀演练：按 [Q] 触发战术脉冲扫描标记前方背对你的警戒单位，绕到它身后靠近按 [V] 执行无声处决（免疫普通子弹）！',
    'tut.radio.step5': '防爆盾靶出现！按 [4] 切换投掷道具确认选定 EMP 雷，按 [G] 投出瘫痪护盾后开火击杀！（身旁蓝光补给箱可随时按 [E] 无限补雷）',
    'tut.radio.step6': '善用集装箱制高点与自动探头！沿西侧青色光柱金属斜坡登上集装箱高台（贴箱边按右键开镜即可自动侧身探头）。',
    'tut.radio.step7In': '已进入铁皮仓库！听：雨声瞬变低通闷响且地面干燥。靠近绿色演练医疗箱按 [E] 回满生命值！',
    'tut.radio.step7Out': '高台视野极佳！现在向西北铁皮仓库（青色光柱入口）移动，进屋体会暴雨隔绝声学并使用演练医疗箱。',
    'tut.radio.step7Entered': '已进入室内！听：雨声瞬变低通闷响且地面干燥（HP 已模拟受损）。靠近绿色演练医疗箱按 [E] 回满生命！',
    'tut.radio.step8': '最终演练：走出南门找到模拟中继器。你可以长按 [E] 无声黑入（不惊动敌人），或按 [G] 贴 C4 强爆摧毁，任选其一即可结业！',
    'tut.missionStartMsg': '演练全部完成！已满状态部署至南侧泊位，切断 3 处通信中继器并登船撤离！',
    'tut.marker.drone': '训练靶机',
    'tut.marker.stealth': '[Q]扫描 · 背后[V]处决',
    'tut.marker.shield': '[4/G]EMP破盾靶',
    'tut.marker.crate': 'EMP 补给箱',
    'tut.marker.ramp': '斜坡高台',
    'tut.marker.wh': '铁皮仓库入口',
    'tut.marker.med': '演练医疗箱',
    'tut.marker.relay': '模拟中继器 (E黑入 / G贴C4)',
    'tut.finishingChip': '8 项演练全部达标',
    'tut.finishingTitle': '新手教程完成 · 即将部署实战',
    'tut.titleGeneric': '新手教程 ({step}/8)',
    'tut.step1.title': '新手教程 (1/8) · 机动、滑铲与枪灯',
    'tut.step1.move': 'WASD移动',
    'tut.step1.sprint': 'Shift冲刺',
    'tut.step1.slide': 'Shift+C滑铲',
    'tut.step1.crouch': 'C下蹲',
    'tut.step1.light': 'F枪灯',
    'tut.step2.title': '新手教程 (2/8) · {weapon} 瞄具与消音',
    'tut.step2.ads': '右键开镜',
    'tut.step2.fire': '射击 {shots}/3',
    'tut.step2.swap': '1/2切副手枪',
    'tut.step2.sup': 'T装卸消音',
    'tut.step3.title': '新手教程 (3/8) · 弱点暴击与换弹',
    'tut.step3.drone': '击毁训练靶机',
    'tut.step3.reload': 'R 换弹至 {mag} 发',
    'tut.step4.title': '新手教程 (4/8) · 脉冲扫描与背后暗杀',
    'tut.step4.scan': 'Q 脉冲扫描',
    'tut.step4.takedown': '背后按 V 处决',
    'tut.step5.title': '新手教程 (5/8) · EMP 破盾战术投掷',
    'tut.step5.cycle': '4 切换道具',
    'tut.step5.empKill': 'G 投EMP破盾并击杀',
    'tut.step6.title': '新手教程 (6/8) · 高台与探头',
    'tut.step6.climb': '登西侧集装箱高台',
    'tut.step7.title': '新手教程 (7/8) · 室内声学与医疗',
    'tut.step7.enter': '进入铁皮仓库',
    'tut.step7.medkit': 'E 使用医疗箱',
    'tut.step8.title': '新手教程 (8/8) · 中继器双路线切断',
    'tut.step8.sever': '长按E黑入 或 G贴C4',
    'tut.interact.crate': '按 [E] 补满 EMP / 破片战术投掷物',
    'tut.interact.medkit': '按 [E] 使用演练医疗箱 (恢复满生命)',
    'tut.interact.simRelay': '长按 [E] 无声黑入 或 按 [G] 贴 C4 强爆模拟中继器',

    // Training
    'train.speaker.timed': '教官 // 限时打靶',
    'train.speaker.endless': '守望者 // 无尽防线',
    'train.speaker.stageEvac': '撤离一号 // 关卡练习 4/6',
    'train.speaker.stage': '教官 // 关卡练习 {id}/6',
    'train.speaker.airdrop': '守望者 // 战术空投',
    'train.radio.timedStart': '限时 {sec} 秒打靶开始！瞄准红色核心一枪秒杀暴击，保持连击倍率！',
    'train.radio.endlessStart': '无尽波次防线已启动！清完每波可解锁战术空投增益并回复护甲，尽可能守住更久！',
    'train.radio.stageExtract': '关卡四：终局全面封锁突围！全速冲破机器防线，前往东北泊位长按 [E] 登船撤离！',
    'train.radio.stageStart': '{name}：消灭区域敌兵并切断 {relay} 号中继器即可通关！',
    'train.radio.airdropLoaded': '已装载「{name}」！下一波将在 2.5 秒后切入。',
    'train.radio.stageRelayCut': '{id} 号中继器已切断！敌方增援已抵达，肃清剩余 {rem} 个敌对目标即可过关！',
    'train.radio.endlessWave': '第 {wave} 波机械集群来袭（共 {total} 个目标），注意掩体走位！',
    'train.hud.score': '得分 {score}',
    'train.hud.combo': '连击 {combo} (x{mult})',
    'train.hud.kills': '击毁 {kills}',
    'train.hud.timedTitle': '限时打靶 · 剩余 {mins}:{secs}',
    'train.hud.endlessBreatherTitle': '无尽波次 · 空投整备 ({sec}s)',
    'train.hud.endlessWaveTitle': '无尽波次 · 第 {wave} 波',
    'train.hud.endlessReady': '整备就绪',
    'train.hud.endlessRemaining': '剩余敌机 {count}',
    'train.hud.perks': '增益 {count}',
    'train.hud.totalKills': '总击杀 {kills}',
    'train.hud.survived': '存活 {mins}:{secs}',
    'train.hud.extractBerth': '东北泊位登船撤离',
    'train.hud.activeEnemies': '活跃敌机 {count}',
    'train.hud.elapsed': '用时 {mins}:{secs}',
    'train.hud.relayTarget': '{id}号中继器',
    'train.hud.remainingEnemies': '剩余敌机 {count}',
    'train.hud.practiceHits': '无伤演练 (受击{hits})',
    'train.hud.stageTitle': '关卡练习 {id}/6 · {name}',
    'train.airdropOptionTitle': '{name}（第 {wave} 波空投）',
    'train.stageNotCleared': '尚未通关',
    'train.stageBestOfficial': '正式最快 {time}',
    'train.stagePracticeCleared': '演练已通关（未记正式用时）',
    'train.stageCardTitle': '关卡 {id} · {name}',
    'train.best.timedHtml': '<span>{dur}秒档个人最佳</span><strong>{score} 分 · 击毁 {kills}</strong>',
    'train.best.waveNum': '第 {wave} 波',
    'train.best.noWave': '暂无波次',
    'train.best.endlessHtml': '<span>无尽历史最佳</span><strong>{waveTxt} · 击杀 {kills} · {time}</strong>',
    'train.best.stageFastest': '最快 {time}',
    'train.best.stagePracticeOnly': '仅演练通关',
    'train.best.stageHtml': '<span>关卡 {id} 战绩</span><strong>{txt}</strong>',
    'train.startTimed': '开始限时打靶（锁定视角）',
    'train.startEndless': '开始无尽波次（锁定视角）',
    'train.startStage': '开始关卡 {id}（锁定视角）',
    'train.debrief.timedTitle': '限时打靶结算 // 训练完成',
    'train.debrief.timedDesc': '{dur} 秒靶场冲刺结束！累计击毁 {kills} 个移动靶，最高连击 {maxCombo} 连。',
    'train.debrief.finalScore': '最终得分',
    'train.debrief.killsCrits': '击毁 / 暴击',
    'train.debrief.maxCombo': '最高连击',
    'train.debrief.accuracy': '命中率',
    'train.debrief.timedRadio': '限时打靶结束，总得分 {score} 分，击毁 {kills} 个目标！',
    'train.debrief.endlessTitle': '无尽防线结算 // 阵亡撤出',
    'train.debrief.endlessDesc': '你在第 {wave} 波机器集群攻势下坚守 {time}，累计消灭 {kills} 台敌机。',
    'train.debrief.waveReached': '抵达波次',
    'train.debrief.waveValue': '第 {wave} 波',
    'train.debrief.totalKills': '总击杀数',
    'train.debrief.survivalTime': '存活时间',
    'train.debrief.critsAcc': '暴击 / 命中',
    'train.debrief.endlessRadio': '无尽波次防线已失守，最终抵达第 {wave} 波，累计消灭 {kills} 台敌机。',
    'train.debrief.stageClearTitle': '关卡练习 {id}/6 // 通关完成',
    'train.debrief.stageFailTitle': '关卡练习 {id}/6 // 行动失败',
    'train.debrief.stagePracticeDesc': '「{name}」演练路线完成！（已开启无伤防阵亡，模拟受击 {hits} 次；未计入正式最快用时）',
    'train.debrief.stageClearDesc': '成功攻克「{name}」，干净利落地完成了战区专项目标！',
    'train.debrief.stageFailDesc': '你在「{name}」战区中阵亡。可复盘路线、开启无伤练路线或再次挑战！',
    'train.debrief.modePractice': '演练(受击{hits})',
    'train.debrief.modeOfficial': '正式挑战',
    'train.debrief.stageTime': '关卡用时',
    'train.debrief.challengeMode': '挑战模式',
    'train.debrief.stageClearRadio': '关卡「{name}」专项训练完成！实战节奏与切入路线已校准。',
    'train.debrief.stageFailRadio': '关卡练习「{name}」行动失败，重整装备后再战。',

    // App / Menus / Debrief / Prompts
    'app.speaker.instructor': '教官',
    'app.speaker.watcher': '守望者 // 频道 04',
    'app.speaker.evac': '撤离一号 // EVAC-01',
    'app.warmupFallbackHigh': '当前显卡不支持极限管线，已平滑切回高画质',
    'app.warmupDone': '极限画质管线预热完成',
    'app.careerBestTime': ' · 最快 {time}',
    'app.careerClearedHtml': '<span>特遣档案 // 最高评价 <strong>{grade} ({score}分)</strong></span><strong>通关 {clears} 次{timeTxt} · 涂装 {skins}/3</strong>',
    'app.careerEmptyHtml': '<span>特遣档案 // 尚未通关</span><strong>A/S级或零警报通关解锁战术涂装</strong>',
    'app.skinUnlocked': '✓ 已解锁 · 点击装备',
    'app.diffSummaryHtml': '<span class="diff-sum-tag">{name}</span><span>{summary} · 评分 {mult}x</span>',
    'app.loadoutMutatorOne': ' · 1 项词缀',
    'app.loadoutMutatorMany': ' · {count} 项词缀',
    'app.loadoutSummary': '武器配装与挑战词缀（{weapon} · {skin}{mutTxt}）',
    'app.pause.tutTitle': '战术暂停（新手教程）',
    'app.pause.tutDesc': '可继续当前新手演练，或随时跳过教程直接投入 04 号码头实战。',
    'app.pause.trainTimedTitle': '战术暂停（限时打靶训练）',
    'app.pause.trainEndlessTitle': '战术暂停（无尽波次防线）',
    'app.pause.trainStageTitle': '战术暂停（关卡练习 {id}/6）',
    'app.pause.trainDesc': '当前训练进度已冻结。可继续训练、重新开始本项训练，或进入训练中心切换子模式。',
    'app.pause.combatTitle': '战术暂停',
    'app.pause.combatDesc': '调整画质档位、鼠标灵敏度或主音量，随时重返暴雨战场。',
    'app.trainCenter.title': '训练中心 // 靶场 · 无尽 · 关卡练习',
    'app.trainCenter.desc': '选择限时打靶、无尽波次生存或六大战区专项练习，每项训练独立保存个人最佳战绩。',
    'app.btn.deployLock': '开始实战部署（锁定视角）',
    'app.btn.replayTutorial': '重玩新手教程',
    'app.btn.resumeTutorial': '继续新手教程',
    'app.btn.skipTutorial': '跳过教程直入实战',
    'app.btn.openTrainingCenter': '进入训练中心',
    'app.btn.resumeTraining': '继续训练（锁定视角）',
    'app.btn.restartTraining': '重开本项训练',
    'app.btn.switchTrainMode': '切换训练子模式',
    'app.btn.resumeCombat': '继续战斗（锁定视角）',
    'app.btn.restartCombat': '重新开始任务',
    'app.btn.nextStage': '下一关：关卡 {id}/6',
    'app.btn.retryStage': '再战本关',
    'app.btn.playAgainTraining': '再来一局（本项训练）',
    'app.btn.redeployCombat': '再次部署任务',
    'app.interact.medkit': '按 [E] 使用应急医疗箱 (+45 HP)',
    'app.interact.ammoCrate': '按 [E] 补满战术弹药与手雷',
    'app.interact.breaker': '按 [E] 静默切断 {label}',
    'app.interact.relay': '长按 [E] 无声黑入 {id} · 按 [G] 贴 C4 强破',
    'app.interact.holdoutWait': '死守撤离区！锚链解锁倒计时 {sec}s',
    'app.interact.boardBoat': '长按 [E] 登上撤离快艇',
    'app.radio.lowHp': '警告：护甲生命值严重受损！立即寻找掩体或使用医疗箱！',
    'app.radio.ammoEmpty': '弹匣打空，正在紧急换弹！',
    'app.radio.lowReserve': '警告：备用弹药余量见底！靠近闪烁黄标的战术弹药箱 [E] 可补满弹药与投掷物！',
    'app.radio.breakerShot': '{label} 已被击毁断电，周边侦查照明瘫痪！',
    'app.radio.missionStart': '风暴已掩护你渗入 04 号码头。潜行无声黑入 [E] 或直接爆破 [G] 切断全部 3 处通信中继器！',
    'app.radio.missionSkip': '已跳过新手引导，直接切入 04 号码头实战！按任意顺序切断 3 处通信中继器！',
    'app.radio.missionSkipMenu': '已跳过引导，直接切入实战部署！按任意顺序切断 3 处通信中继器！',
    'app.radio.missionRestart': '已重新部署至南侧防波堤。切断全部 3 处中继器后向东北码头撤离！',
    'app.radio.alarmTriggered': '潜行暴露！敌方警报发报已接通，码头巡防进入全面交火状态！',
    'app.radio.medkitUsed': '应急医疗箱已注入，生命体征回升。',
    'app.radio.ammoResupplied': '主副武器弹匣与战术手雷已补满！',
    'app.radio.breakerTripped': '{label} 已断电！利用黑暗与掩体无声潜行。',
    'app.radio.evacApproach': '已锁定你的位置！撤离快艇正在靠泊东北栈桥，守住防线！',
    'app.radio.evacBoarding': '撤离锚链解锁中，掩护好自己，马上起航！',
    'app.radio.relayC4': '{name} 已被 C4 爆破 ({count}/3)！敌方防爆重装与机械犬拦截队已逼近！',
    'app.radio.relayStealth': '{name} 已无声切断 ({count}/3)！完美静默侵入，警戒网尚未察觉，继续保持！',
    'app.radio.relayTwo': '{name} 已切断 (2/3)！只剩最后一处，敌方拦截部队正在逼近！',
    'app.radio.relayOne': '{name} 已切断 (1/3)！敌方警戒拦截队正在赶往该区！',
    'app.radio.evacHoldoutStart': '全部 3/3 中继器离线！撤离快艇正在靠泊——向东北泊位机动并死守 30 秒等待锚链解锁！',
    'app.radio.barrelKill': '危化油桶已引爆，周边机械单位遭重创！',
    'app.radio.holdout15s': '锚链解锁剩余 15 秒！敌方增援压近东北码头，守住最后一波攻势！',
    'app.radio.evacUnlocked': '撤离锚链已全部解锁！全速登上东北栈桥绿色信号处的撤离快艇！',
    'app.radio.shieldWarn': '正面防爆盾牌弹反了常规子弹！用 [4]/[G] 切 EMP 瘫痪护盾、穿甲 DMR 或绕后击打散热核！',
    'app.radio.sniperWarn': '警告：高台激光狙已锁定你的位置！小心高处红线激光锁定并立即横向机动回避！',
    'debrief.newRecord': '新纪录',
    'debrief.victoryTitle': '撤离成功 // 评级 {grade}',
    'debrief.defeatTitle': '任务失败 // 行动中止',
    'debrief.victoryDesc': '你成功瘫痪码头通信网并守住撤离倒计时突破机器封锁，顺利登上撤离快艇！',
    'debrief.defeatDesc': '生命体征归零。敌方巡防机械部队已封锁该区域。',
    'debrief.unranked': '未评级 ({score})',
    'debrief.statRankScore': '行动评级 / 评分',
    'debrief.statDiffMult': '行动难度 / 倍率',
    'debrief.statTimeAlarms': '用时 / 警报次数',
    'debrief.alarmCount': '{count}次',
    'debrief.statKillsBreak': '击毁 / 暗杀 / 爆桶',
    'debrief.statAccCrits': '命中率 / 暴击',
    'debrief.speaker.rankS': '撤离一号 // S级完美行动',
    'debrief.radio.rankS': '特遣队长确认：S 级完美撤离评定！整个 04 号码头行动已被总部收录为最高机密战例！',
    'debrief.radio.victory': '全员登船确认！撤离快艇正在驶离 04 号码头，行动圆满成功！',
    'debrief.radio.defeat': '失去特遣队员生命信号，04 号码头撤离行动中止。',
  },
  {
    // HUD runtime
    'hud.enemy.drone': 'Patrol Drone',
    'hud.enemy.hound': 'Assault Hound',
    'hud.enemy.shield': 'Riot Heavy',
    'hud.enemy.sniper': 'Laser Sniper',
    'hud.enemy.recon': 'Recon Beacon',
    'hud.enemy.unknown': 'Hostile Unit',
    'hud.killSuffixSilent': ' // SILENT TAKEDOWN',
    'hud.killSuffixCrit': ' // CRIT',
    'hud.killFeed': 'ELIMINATED {label}{suffix}',
    'hud.dir.N': 'N',
    'hud.dir.NE': 'NE',
    'hud.dir.E': 'E',
    'hud.dir.SE': 'SE',
    'hud.dir.S': 'S',
    'hud.dir.SW': 'SW',
    'hud.dir.W': 'W',
    'hud.dir.NW': 'NW',
    'hud.markerRelay': 'Relay {id}',
    'hud.markerEvac': 'Evac Boat',
    'hud.objCutRelays': 'Sever Comms Relays ({count}/3)',
    'hud.objHoldout': '3/3 Relays Offline · Hold Evac Zone for Extraction',
    'hud.objExtract': 'Evac Boat Ready · Board at NE Berth',
    'hud.stealthPatrol': 'Status: Stealth',
    'hud.stealthSniperLock': '⚠ SNIPER LASER LOCK!',
    'hud.stealthCallIn': '⚠ HOSTILE CALLING BACKUP!',
    'hud.stealthCombat': 'Status: Combat',
    'hud.stealthSuspicious': 'Status: Alert ({pct}%)',
    'hud.supOn': '[T] Sup: ON',
    'hud.scanCooldown': '[Q] Scan {sec}s',
    'hud.diffBenchmark': 'Difficulty: Baseline',
    'hud.diffLabel': 'Difficulty: {name}',
    'hud.flashOff': 'Light: OFF',

    // Tutorial
    'tut.primaryFallback': 'Primary',
    'tut.sight.dmr': '{weapon} Mil-Dot Sniper Scope',
    'tut.sight.shotgun': '{weapon} Open Circle Reflex Sight',
    'tut.sight.carbine': '{weapon} Wide-View Holo Sight',
    'tut.speaker.stealth': 'INSTRUCTOR // STEALTH CHECK',
    'tut.speaker.shield': 'INSTRUCTOR // BREACH CHECK',
    'tut.speaker.complete': 'INSTRUCTOR // GRADUATION',
    'tut.speaker.step': 'INSTRUCTOR // DRILL {step}/8',
    'tut.blocked.melee': 'Target is immune to standard gunfire! Press [Q] to pulse scan, flank behind it, and press [V] for a silent takedown!',
    'tut.blocked.emp': 'Ballistic shield blocks frontal rounds! Press [4]/[G] to throw an EMP grenade to disable the shield, then engage!',
    'tut.radio.complete': 'All 8 tactical drills complete! Full reset at the south berth in 2s—deploying to live 0/3 relay extraction!',
    'tut.radio.step1': 'Welcome to Pier 04. Warm up basic movement: WASD to move, hold Shift to sprint, press C while sprinting to slide, C to crouch in cover, and F to toggle your weapon light.',
    'tut.radio.step2': 'Good movement! Hold RMB to ADS with your "{sight}" and fire 3 rounds, press [1]/[2] to switch to sidearm, then press [T] to attach/detach your suppressor.',
    'tut.radio.step3': 'Training drone deployed 13m ahead! Strike the red center core for a 2x gold crit to destroy it, then press [R] to top off your magazine ({mag} rds).',
    'tut.radio.step4': 'Stealth takedown drill: press [Q] for tactical pulse scan to tag the sentry ahead, sneak behind it and press [V] for a silent execution (bulletproof)!',
    'tut.radio.step5': 'Riot shield target inbound! Press [4] to select EMP Grenade, press [G] to throw and stun its shield, then finish it! (Use the blue crate nearby [E] for unlimited resupply.)',
    'tut.radio.step6': 'Use container high ground and auto-peek! Climb the cyan-lit metal ramp on the west side onto the container deck (ADS near container edges to auto-peek).',
    'tut.radio.step7In': 'Inside the warehouse! Hear the muffled rain acoustics and dry floor. Approach the green drill medkit and press [E] to restore full HP!',
    'tut.radio.step7Out': 'Great vantage point! Move to the NW sheet-metal warehouse (cyan entrance beacon) to test indoor rain acoustics and use the drill medkit.',
    'tut.radio.step7Entered': 'Indoors confirmed! Rain acoustics muffled and floor dry (simulated HP loss applied). Press [E] at the green drill medkit to heal to full!',
    'tut.radio.step8': 'Final drill: exit the south door to the simulated relay. Hold [E] for a silent hack or press [G] to plant C4 for a loud breach—either completes training!',
    'tut.missionStartMsg': 'All drills complete! Deployed at full readiness on the south berth—sever all 3 comms relays and extract!',
    'tut.marker.drone': 'Training Drone',
    'tut.marker.stealth': '[Q] Scan · Back [V] Execute',
    'tut.marker.shield': '[4/G] EMP Shield Target',
    'tut.marker.crate': 'EMP Crate',
    'tut.marker.ramp': 'Container Ramp',
    'tut.marker.wh': 'Warehouse Entry',
    'tut.marker.med': 'Drill Medkit',
    'tut.marker.relay': 'Sim Relay ([E] Hack / [G] C4)',
    'tut.finishingChip': 'All 8 Drills Complete',
    'tut.finishingTitle': 'Tutorial Complete · Deploying',
    'tut.titleGeneric': 'Tutorial ({step}/8)',
    'tut.step1.title': 'Tutorial (1/8) · Movement, Slide & Light',
    'tut.step1.move': 'WASD Move',
    'tut.step1.sprint': 'Shift Sprint',
    'tut.step1.slide': 'Shift+C Slide',
    'tut.step1.crouch': 'C Crouch',
    'tut.step1.light': 'F Light',
    'tut.step2.title': 'Tutorial (2/8) · {weapon} Optics & Sup',
    'tut.step2.ads': 'RMB ADS',
    'tut.step2.fire': 'Fire {shots}/3',
    'tut.step2.swap': '1/2 Sidearm',
    'tut.step2.sup': 'T Suppressor',
    'tut.step3.title': 'Tutorial (3/8) · Crits & Reload',
    'tut.step3.drone': 'Destroy Drone',
    'tut.step3.reload': 'R Reload ({mag})',
    'tut.step4.title': 'Tutorial (4/8) · Scan & Takedown',
    'tut.step4.scan': 'Q Pulse Scan',
    'tut.step4.takedown': 'Behind V Execute',
    'tut.step5.title': 'Tutorial (5/8) · EMP Shield Breach',
    'tut.step5.cycle': '4 Cycle Gear',
    'tut.step5.empKill': 'G EMP Stun & Kill',
    'tut.step6.title': 'Tutorial (6/8) · High Ground & Peek',
    'tut.step6.climb': 'Climb West Deck',
    'tut.step7.title': 'Tutorial (7/8) · Acoustics & Medkit',
    'tut.step7.enter': 'Enter Warehouse',
    'tut.step7.medkit': 'E Use Medkit',
    'tut.step8.title': 'Tutorial (8/8) · Dual Relay Breach',
    'tut.step8.sever': 'Hold E Hack or G C4',
    'tut.interact.crate': 'Press [E] Refill EMP / Frag Grenades',
    'tut.interact.medkit': 'Press [E] Use Drill Medkit (Full HP)',
    'tut.interact.simRelay': 'Hold [E] Hack or Press [G] Plant C4 on Sim Relay',

    // Training
    'train.speaker.timed': 'INSTRUCTOR // TIMED RANGE',
    'train.speaker.endless': 'OVERWATCH // ENDLESS',
    'train.speaker.stageEvac': 'EVAC-01 // STAGE DRILL 4/6',
    'train.speaker.stage': 'INSTRUCTOR // STAGE DRILL {id}/6',
    'train.speaker.airdrop': 'OVERWATCH // AIRDROP',
    'train.radio.timedStart': '{sec}s timed target sprint live! Strike red cores for 1-shot crits and keep your combo multiplier!',
    'train.radio.endlessStart': 'Endless wave defense active! Clear each wave to unlock tactical airdrops and restore armor—hold as long as you can!',
    'train.radio.stageExtract': 'Stage 4: Final lockdown breakout! Punch through the mech perimeter and hold [E] at the NE berth to extract!',
    'train.radio.stageStart': '{name}: Eliminate sector hostiles and sever Relay {relay} to clear!',
    'train.radio.airdropLoaded': '"{name}" installed! Next wave inbound in 2.5 seconds.',
    'train.radio.stageRelayCut': 'Relay {id} severed! Hostile interceptors inbound—eliminate {rem} remaining targets to clear!',
    'train.radio.endlessWave': 'Wave {wave} mech swarm inbound ({total} hostiles)—use cover and watch your flanks!',
    'train.hud.score': 'Score {score}',
    'train.hud.combo': 'Combo {combo} (x{mult})',
    'train.hud.kills': 'Kills {kills}',
    'train.hud.timedTitle': 'Timed Range · {mins}:{secs}',
    'train.hud.endlessBreatherTitle': 'Endless · Resupply ({sec}s)',
    'train.hud.endlessWaveTitle': 'Endless · Wave {wave}',
    'train.hud.endlessReady': 'Standby',
    'train.hud.endlessRemaining': 'Hostiles {count}',
    'train.hud.perks': 'Perks {count}',
    'train.hud.totalKills': 'Kills {kills}',
    'train.hud.survived': 'Time {mins}:{secs}',
    'train.hud.extractBerth': 'Board Boat at NE Berth',
    'train.hud.activeEnemies': 'Active {count}',
    'train.hud.elapsed': 'Time {mins}:{secs}',
    'train.hud.relayTarget': 'Relay {id}',
    'train.hud.remainingEnemies': 'Hostiles {count}',
    'train.hud.practiceHits': 'Drill (Hits {hits})',
    'train.hud.stageTitle': 'Stage {id}/6 · {name}',
    'train.airdropOptionTitle': '{name} (Wave {wave} Airdrop)',
    'train.stageNotCleared': 'Not Cleared',
    'train.stageBestOfficial': 'Best {time}',
    'train.stagePracticeCleared': 'Drill Cleared (Unranked)',
    'train.stageCardTitle': 'Stage {id} · {name}',
    'train.best.timedHtml': '<span>{dur}s Personal Best</span><strong>{score} pts · {kills} Kills</strong>',
    'train.best.waveNum': 'Wave {wave}',
    'train.best.noWave': 'No Waves',
    'train.best.endlessHtml': '<span>Endless Best</span><strong>{waveTxt} · {kills} Kills · {time}</strong>',
    'train.best.stageFastest': 'Best {time}',
    'train.best.stagePracticeOnly': 'Drill Clear Only',
    'train.best.stageHtml': '<span>Stage {id} Record</span><strong>{txt}</strong>',
    'train.startTimed': 'Start Timed Range (Lock Pointer)',
    'train.startEndless': 'Start Endless Waves (Lock Pointer)',
    'train.startStage': 'Start Stage {id} (Lock Pointer)',
    'train.debrief.timedTitle': 'Timed Range // Drill Complete',
    'train.debrief.timedDesc': '{dur}s live-fire sprint complete! Destroyed {kills} moving drones with a {maxCombo}x max combo.',
    'train.debrief.finalScore': 'Final Score',
    'train.debrief.killsCrits': 'Kills / Crits',
    'train.debrief.maxCombo': 'Max Combo',
    'train.debrief.accuracy': 'Accuracy',
    'train.debrief.timedRadio': 'Timed range complete: {score} pts, {kills} targets destroyed!',
    'train.debrief.endlessTitle': 'Endless Defense // Fallen',
    'train.debrief.endlessDesc': 'You held out through Wave {wave} for {time}, neutralizing {kills} hostiles.',
    'train.debrief.waveReached': 'Wave Reached',
    'train.debrief.waveValue': 'Wave {wave}',
    'train.debrief.totalKills': 'Total Kills',
    'train.debrief.survivalTime': 'Survival Time',
    'train.debrief.critsAcc': 'Crits / Acc',
    'train.debrief.endlessRadio': 'Endless perimeter overrun at Wave {wave}—{kills} hostiles neutralized.',
    'train.debrief.stageClearTitle': 'Stage Drill {id}/6 // Cleared',
    'train.debrief.stageFailTitle': 'Stage Drill {id}/6 // Failed',
    'train.debrief.stagePracticeDesc': '"{name}" route drill complete! (Invulnerable mode: {hits} simulated hits; unranked time.)',
    'train.debrief.stageClearDesc': '"{name}" cleared cleanly—all tactical sector objectives achieved!',
    'train.debrief.stageFailDesc': 'KIA in "{name}". Review your route, enable invulnerable drill, or redeploy!',
    'train.debrief.modePractice': 'Drill ({hits} hits)',
    'train.debrief.modeOfficial': 'Ranked',
    'train.debrief.stageTime': 'Stage Time',
    'train.debrief.challengeMode': 'Mode',
    'train.debrief.stageClearRadio': 'Stage "{name}" drill complete! Pacing and entry lines calibrated.',
    'train.debrief.stageFailRadio': 'Stage drill "{name}" failed—regroup and redeploy.',

    // App / Menus / Debrief / Prompts
    'app.speaker.instructor': 'INSTRUCTOR',
    'app.speaker.watcher': 'OVERWATCH // CH-04',
    'app.speaker.evac': 'EVAC-01',
    'app.warmupFallbackHigh': 'Extreme pipeline unsupported on this GPU; switched to High preset',
    'app.warmupDone': 'Extreme graphics pipeline ready',
    'app.careerBestTime': ' · Best {time}',
    'app.careerClearedHtml': '<span>Operative Dossier // Top Rank <strong>{grade} ({score} pts)</strong></span><strong>{clears} Clears{timeTxt} · Skins {skins}/3</strong>',
    'app.careerEmptyHtml': '<span>Operative Dossier // No Clears</span><strong>Clear at A/S Rank or Zero Alarms to unlock finishes</strong>',
    'app.skinUnlocked': '✓ Unlocked · Click to equip',
    'app.diffSummaryHtml': '<span class="diff-sum-tag">{name}</span><span>{summary} · Score {mult}x</span>',
    'app.loadoutMutatorOne': ' · 1 Mutator',
    'app.loadoutMutatorMany': ' · {count} Mutators',
    'app.loadoutSummary': 'Loadout & Challenge Mutators ({weapon} · {skin}{mutTxt})',
    'app.pause.tutTitle': 'Tactical Pause (Tutorial)',
    'app.pause.tutDesc': 'Resume your tactical tutorial or skip straight into the live Pier 04 operation.',
    'app.pause.trainTimedTitle': 'Tactical Pause (Timed Range)',
    'app.pause.trainEndlessTitle': 'Tactical Pause (Endless Waves)',
    'app.pause.trainStageTitle': 'Tactical Pause (Stage Drill {id}/6)',
    'app.pause.trainDesc': 'Training session paused. Resume, restart this drill, or open the Training Center to switch modes.',
    'app.pause.combatTitle': 'Tactical Pause',
    'app.pause.combatDesc': 'Adjust graphics, mouse sensitivity, or audio settings before returning to the storm.',
    'app.trainCenter.title': 'Training Center // Range · Endless · Drills',
    'app.trainCenter.desc': 'Select Timed Range, Endless Waves, or 6 Sector Drills. Personal bests are saved per mode.',
    'app.btn.deployLock': 'Deploy to Operation (Lock Pointer)',
    'app.btn.replayTutorial': 'Replay Tutorial',
    'app.btn.resumeTutorial': 'Resume Tutorial',
    'app.btn.skipTutorial': 'Skip Tutorial -> Deploy',
    'app.btn.openTrainingCenter': 'Open Training Center',
    'app.btn.resumeTraining': 'Resume Training (Lock Pointer)',
    'app.btn.restartTraining': 'Restart This Drill',
    'app.btn.switchTrainMode': 'Switch Training Mode',
    'app.btn.resumeCombat': 'Resume Combat (Lock Pointer)',
    'app.btn.restartCombat': 'Restart Operation',
    'app.btn.nextStage': 'Next Stage: {id}/6',
    'app.btn.retryStage': 'Retry Stage',
    'app.btn.playAgainTraining': 'Play Again (This Drill)',
    'app.btn.redeployCombat': 'Redeploy Operation',
    'app.interact.medkit': 'Press [E] Use Field Medkit (+45 HP)',
    'app.interact.ammoCrate': 'Press [E] Refill Tactical Ammo & Grenades',
    'app.interact.breaker': 'Press [E] Cut {label}',
    'app.interact.relay': 'Hold [E] Hack {id} · [G] Plant C4',
    'app.interact.holdoutWait': 'Hold Evac Zone! Anchor unlock in {sec}s',
    'app.interact.boardBoat': 'Hold [E] Board Evac Boat',
    'app.radio.lowHp': 'WARNING: Armor critical! Take cover or find a medkit immediately!',
    'app.radio.ammoEmpty': 'Magazine dry—emergency reload!',
    'app.radio.lowReserve': 'WARNING: Reserve ammo low! Press [E] at any flashing yellow ammo crate to resupply!',
    'app.radio.breakerShot': '{label} shot out—surrounding area lights offline!',
    'app.radio.missionStart': 'The storm masks your insertion into Pier 04. Hold [E] to stealth-hack or [G] to C4-breach all 3 comms relays!',
    'app.radio.missionSkip': 'Tutorial skipped—live drop into Pier 04! Sever all 3 comms relays in any order!',
    'app.radio.missionSkipMenu': 'Tutorial skipped—deploying to live operation! Sever all 3 comms relays in any order!',
    'app.radio.missionRestart': 'Redeployed at the south seawall. Sever all 3 relays and extract at the NE dock!',
    'app.radio.alarmTriggered': 'Stealth compromised! Hostile alarm active—dock patrols engaging!',
    'app.radio.medkitUsed': 'Field medkit applied—vitals stabilizing.',
    'app.radio.ammoResupplied': 'Primary, sidearm, and tactical grenades resupplied!',
    'app.radio.breakerTripped': '{label} powered down! Use darkness and cover to stay unseen.',
    'app.radio.evacApproach': 'Visual on your position! Evac boat docking at NE pier—hold the line!',
    'app.radio.evacBoarding': 'Unlatching evac moorings—keep your head down, casting off soon!',
    'app.radio.relayC4': '{name} breached with C4 ({count}/3)! Riot heavies and hound interceptors inbound!',
    'app.radio.relayStealth': '{name} silently severed ({count}/3)! Clean ghost breach—patrol net unaware!',
    'app.radio.relayTwo': '{name} offline (2/3)! One relay left—hostile intercept squad closing in!',
    'app.radio.relayOne': '{name} offline (1/3)! Hostile response squad converging on that sector!',
    'app.radio.evacHoldoutStart': 'All 3/3 relays offline! Evac boat inbound—move to NE berth and hold for 30s!',
    'app.radio.barrelKill': 'Hazmat drum detonated—nearby hostiles heavily damaged!',
    'app.radio.holdout15s': '15s to anchor release! Final reinforcements pushing NE dock—hold the line!',
    'app.radio.evacUnlocked': 'Evac moorings released! Sprint to the green beacon on the NE pier and board EVAC-01!',
    'app.radio.shieldWarn': 'Frontal riot shield deflected standard rounds! Throw EMP [4]/[G], use AP DMR, or flank the rear core!',
    'app.radio.sniperWarn': 'WARNING: Elevated laser sniper locked onto you! Watch the red beam and strafe out of line!',
    'debrief.newRecord': 'NEW PB',
    'debrief.victoryTitle': 'EXTRACTION COMPLETE // RANK {grade}',
    'debrief.defeatTitle': 'OPERATION FAILED // MIA',
    'debrief.victoryDesc': 'Comms network severed and extraction countdown held—you broke the perimeter and boarded EVAC-01!',
    'debrief.defeatDesc': 'Vital signs flatlined. Hostile autonomous patrols have locked down the pier.',
    'debrief.unranked': 'Unranked ({score})',
    'debrief.statRankScore': 'Rank / Score',
    'debrief.statDiffMult': 'Difficulty / Mult',
    'debrief.statTimeAlarms': 'Time / Alarms',
    'debrief.alarmCount': '{count}',
    'debrief.statKillsBreak': 'Kills / Melee / Barrels',
    'debrief.statAccCrits': 'Accuracy / Crits',
    'debrief.speaker.rankS': 'EVAC-01 // S-RANK CLEAR',
    'debrief.radio.rankS': 'Command confirms S-Rank flawless extraction! Pier 04 operation logged as top-secret benchmark!',
    'debrief.radio.victory': 'All hands aboard! Evac boat clearing Pier 04—mission accomplished!',
    'debrief.radio.defeat': 'Operative vitals lost. Pier 04 extraction aborted.',
  }
);

if (typeof document !== 'undefined' && document.body && typeof document.querySelectorAll === 'function') {
  I18n.applyDOM(document);
}
