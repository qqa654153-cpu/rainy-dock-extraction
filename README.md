# Rainy Dock: Tactical Extraction (暴雨夜码头 · 战术撤离行动)

[English](#english) | [简体中文](#简体中文)

---

## English

**Live Demo (GitHub Pages):** https://qqa654153-cpu.github.io/rainy-dock-extraction/

> Infiltrate Container Pier 04 during a torrential night storm while rogue autonomous units hold the dock. Sever all 3 communication relays in any order, survive the extraction holdout countdown, and board the boat at the Northeast Pier.

### Core Features

- **Zero-Build 3D WebGL / Three.js Tactical Shooter**: Pure static frontend with zero build step and zero backend—runs directly in any modern browser. Features **4 Graphics Quality Presets** (`Low` / `Medium` / `High` / `Extreme` with SSR/GTAO, dynamic shadows, volumetric fog, high-detail meshes, and AgX tone mapping) plus **Dynamic Resolution Scaling (DRS)** to hold a smooth 60 FPS target when Extreme mode dips below 55 FPS.
- **Multiple Tactical Game Modes**:
  - **Tutorial**: 8-step interactive field onboarding covering movement/slide, optics/suppressor toggling, critical hits, pulse scan & silent melee takedowns, EMP shield-breaking, container elevation & auto-lean, warehouse storm acoustics, and silent vs. C4 relay breaching (`Tab` skips straight to combat).
  - **Tactical Extraction**: Full Pier 04 infiltration—disable Relay A (West Containers), Relay B (Corrugated Warehouse), and Relay C (East Gantry) via silent hack or C4 breach, hold out during the 30-second lockdown countdown, and board the evac boat at the Northeast berth. Includes optional silent power breakers (`E`).
  - **Training Center**:
    - **Timed Target Sprint**: Invulnerable shooting range with **30s / 60s / 90s** timers; hitting red optical cores scores instant crits and stacks combo multipliers up to 3.0x.
    - **Endless Waves**: Escalating combat waves (introducing Recon units from Wave 2 and Shield/Sniper units from Wave 3+) with between-wave armor/ammo resupply and pick-1-of-3 **Tactical Airdrop Perks**.
    - **6 Stage Drills**: Jump straight into any of Pier 04's 6 tactical sectors (West Containers A, Warehouse CQB B, East Gantry C, Final Lockdown Extraction, Stealth & Comms Interrupt, and Shield Breach & Counter-Sniper) with an optional **Invulnerable Practice** toggle for death-free route rehearsal.
- **4 Difficulties & Stackable Mutators** *(Tutorial and Timed Target Sprint lock to Standard balance)*:
  - **Difficulties**: **Recruit** (gentle reticle aim assist, reduced recoil/spread, full HP regen, 0.75x score), **Standard** (1.00x classic tactical balance), **Veteran** (+25% score, faster/deadlier enemies, tighter call-in interrupt window, +15% weak-point crit bonus), and **Realism** (+50% score, hardcore no-2D-crosshair mode relying on 3D holographic & 2.5D optical scopes, minimal HUD, high lethality).
  - **Mutators**: Stack **Blackout (+20%)**, **Explosive Tide (+15%)**, and **Elite Patrol (+25%)** to push your **C / B / A / S** mission rating multiplier.
- **Weapons, Tactical Systems & Unlocks**:
  - **Primary `[1]`**: **CAR-47 Carbine** (balanced full-auto, 30-rd mag), **MK-14 DMR** (semi-auto precision rifle with 2.5D optical scope, 2.3x crit, high armor pierce), and **M890 Breacher** (7-pellet close-quarters shotgun).
  - **Sidearm `[2]`**: **Suppressed USP-9** (pre-suppressed 15-rd tactical pistol with 2.2x crit multiplier).
  - **Tactical Toolkit**: On-the-fly suppressor attach/detach (`T`), silent backstab takedowns (`V`), parabolic throwable preview (`Hold G` / `4` to cycle **EMP Grenade**, **M67 Frag**, and **Sonic Decoy**), tactical pulse scan (`Q`), automatic corner lean when ADS near cover, and unlockable weapon skins (**Standard Dark Steel**, **Night Ops Ghost**, **Navy HAZMAT**).
- **Full EN/ZH Localization & Dual Edge-TTS Neural Radio Voice Packs**:
  - **Instant In-Game Language Switching**: Powered by `src/i18n.js` (`?lang=en` / `?lang=zh`, persisted in `localStorage`, auto-detecting browser locale on first launch). Hot-switches menus, HUD, compass bearings, tutorial prompts, training records, and debriefs without reloading.
  - **Lazy-Loaded Bilingual Radio Voice Packs**: Pre-synthesized Edge-TTS neural audio across 3 radio operators (`INSTRUCTOR`, `OVERWATCH // CH-04`, `EVAC-01` — 50 tactical clips) stored in `voices/voice_pack_en.js` and `voices/voice_pack.js`, loaded on demand with **independent Voice Language selection** (`Auto (Follow UI)`, `English Voice`, or `中文语音`), tactical walkie-talkie DSP filtering vs. clean audio mode, and automatic Web Speech API fallback.

### Controls

| Key / Input | Action |
| --- | --- |
| `W` `A` `S` `D` / `Arrow Keys` | Move |
| `Mouse` | Aim / Look |
| `Left Click` | Fire |
| `Hold Right Click` | Aim Down Sights — auto-leans near cover edges (Toggle ADS available in Settings); cancels throwable preview |
| `Hold Shift` (moving forward) | Sprint |
| `C` / `Ctrl` | Crouch |
| `Shift + C` | Tactical Slide |
| `Space` | Jump |
| `R` | Reload |
| `1` / `2` / `Mouse Wheel` | Switch Primary / Secondary weapon |
| `T` | Attach / Detach Suppressor on the fly |
| `F` | Toggle Weapon Flashlight |
| `Hold G` / `4` | Hold `G` for parabolic throwable preview & release to throw (`Right Click` cancels) / Press `4` to cycle throwable (EMP / Frag / Decoy) |
| `Q` | Tactical Pulse Scan (highlights enemies & relays) |
| `V` | Melee Strike / Silent Backstab Takedown |
| `E` | Interact — use medkits/ammo crates, flip power breakers, hold to silently hack relays or board extraction boat |
| `G` (near Relay) | Plant C4 for loud relay breach |
| `Tab` | Skip Tutorial and deploy straight into combat |
| `Esc` | Pause game / Release pointer lock |

### Local Run

No build tools or dependencies are required. Serve the repository root with any static HTTP server:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/` in your browser (or append `?lang=en` / `?lang=zh` to select the initial UI language; opening `index.html` directly via `file://` is also supported).

### Directory Structure

```text
.
├── index.html                   # Entry page, tactical HUD, and settings/mode menus
├── README.md                    # Bilingual documentation (English / 简体中文)
├── src/
│   ├── i18n.js                  # EN/ZH localization dictionary, detection & live DOM switcher
│   ├── three.bundle.js          # Bundled Three.js WebGL library
│   ├── tex.js                   # Procedural PBR texture and puddle mask generator
│   ├── extreme_gfx.js           # Extreme preset GPU pipeline (SSR/GTAO, volumetric fog, AgX)
│   ├── audio.js                 # Procedural Web Audio synthesizer & radio DSP filter chain
│   ├── voice_logic.js           # Core game logic, catalogs, scoring & lazy-loading VoiceEngine
│   ├── render.js                # 3D render engine, puddle reflections, DRS & rain particles
│   ├── level.js                 # Pier 04 container yard geometry, relays, crates & AABB collision
│   ├── weapon.js                # Viewmodels, optics/2.5D scope, ballistics & throwables
│   ├── enemy.js                 # Enemy AI, 3-stage stealth alert, A* navigation & projectiles
│   └── app.js                   # Main 60fps loop, HUD updates, tutorial, training & mission flow
├── voices/
│   ├── voice_manifest.json      # Bilingual voice script & metadata (50 clips across 3 operators)
│   ├── voice_pack.js            # Pre-synthesized Chinese Edge-TTS neural radio voice pack
│   └── voice_pack_en.js         # Pre-synthesized English Edge-TTS neural radio voice pack
└── scripts/
    ├── generate_voices.py       # Dual-language Edge-TTS / Windows SAPI voice pack generator
    └── test_logic.mjs           # Node logic & localization verification test suite
```

---

## 简体中文

**在线试玩（GitHub Pages）：** https://qqa654153-cpu.github.io/rainy-dock-extraction/

> 渗透至被机器军团控制的 04 号集装箱码头。任意顺序切断 3 处通信中继器，守住 30 秒撤离倒计时后前往东北泊位登船撤离。

### 游戏特色

- **纯前端 3D WebGL / Three.js 战术射击**：免构建、免后端，打开网页即可游玩；支持 **4 档画质预设**（低 / 中 / 高 / 极限画质，含 SSR/GTAO、动态投影、体积雾、高模与 AgX 色调映射）以及 **动态分辨率保护（DRS）**，在极限画质低于 55 FPS 时自动阶梯降分辨率稳住 60 FPS。
- **多模式战术玩法**：
  - **新手教程**：8 项引导演练覆盖机动滑铲、开镜与消音热装卸、红核暴击与换弹、Q 脉冲扫描与 V 背后无声处决、EMP 破盾与补雷、集装箱高台与自动探头、仓库暴雨声学隔绝与医疗箱，以及无声黑入 / C4 强爆破拆（按 `Tab` 可随时跳过直入实战）。
  - **实战撤离**：渗透 04 号码头，以无声黑入或 C4 强破任意顺序切断中继器 A（西侧集装箱区）、B（铁皮仓库）、C（东侧龙门吊），守住 30 秒封锁倒计时后前往东北泊位登船；支持切断场景配电闸刀（`E`）静默熄灯潜行。
  - **训练模式**：
    - **限时模式**：安全靶场冲刺（无敌不受伤），可选 **30 / 60 / 90 秒**，击中红核触发 1 枪暴击秒杀并叠加连击倍率（最高 3.0x）。
    - **无尽模式**：真实战斗波次生存（第 2 波起出现警戒侦察单位，第 3 波起加入防爆重装与高台激光狙击），每波肃清自动回血补弹并触发三选一 **战术空投增益**。
    - **关卡练习**：自由任选 **6 大战术战区**（西区集装箱 A、铁皮仓库 CQB B、龙门吊高台 C、终局封锁撤离、潜行暗杀与发报打断、重装破盾与反狙），支持开启 **无伤练路线** 开关。
- **4 档难度与可叠加挑战词缀** *（新手教程与限时靶场固定标准基准）*：
  - **4 档难度**：**新兵护航**（温和准星磁吸、低后坐、脱战回满 100 血，0.75x 评分）、**标准行动**（1.00x 原版平衡）、**老兵特遣**（+25% 评分，敌军更快更准、缩短发报打断窗、弱点暴击 +15%）、**拟真夜战**（+50% 评分，硬核去 2D 准星强依赖 3D 全息与 2.5D 倍镜、精简 HUD、高致死）。
  - **3 项挑战词缀**：可叠加 **全图停电 (+20%)**、**高爆狂潮 (+15%)**、**精锐巡防 (+25%)**，提升 **C / B / A / S** 行动评分倍率。
- **武器配装、战术道具与解锁系统**：
  - **主武器 `[1]`**：**CAR-47 卡宾枪**（全自动均衡突击，30 发弹匣）、**MK-14 DMR**（半自动高穿甲精确射手步枪，配备 2.5D 高倍光学瞄具与 2.3x 暴击倍率）、**M890 破门霰弹**（7 枚钢珠近战清场）。
  - **标配副武器 `[2]`**：**消音 USP-9**（预装消音器，15 发弹匣，2.2x 爆头倍率）。
  - **战术装备与涂装**：支持消音器热装卸（`T`）、背后无声处决（`V`）、投掷物抛物线预瞄（按住 `G` / 按 `4` 切换 **EMP 电磁雷 / M67 破片雷 / 声波诱饵器**）、战术脉冲扫描（`Q`）、靠墙开镜自动探头，以及通关/高评级解锁枪械涂装（**标准暗钢**、**夜幕幽灵**、**海军蓝 HAZMAT**）。
- **EN/ZH 双语界面热切换与双语神经语音电台**：
  - **双语界面即时切换**：由 `src/i18n.js` 驱动（支持 `?lang=zh` / `?lang=en`、`localStorage` 持久化与浏览器语言自动识别），可在局内或菜单即时热切换中英文，实时刷新菜单、HUD、罗盘方位、教程提示、训练记录与结算评定，无需刷新页面。
  - **按需加载中英双语神经语音包与音字独立设置**：内置 3 位电台角色（`教官` / `INSTRUCTOR`、`守望者 // 频道 04` / `OVERWATCH // CH-04`、`撤离一号 // EVAC-01`）共 50 条 Edge-TTS 神经语音，分别封装于 `voices/voice_pack.js` 与 `voices/voice_pack_en.js` 并**按需动态加载**；支持 **音字独立设置**（语音语言可选 `自动跟随界面` / `中文语音` / `English Voice`）、战术对讲机 DSP 滤波与清晰原声模式切换，离线或包缺失时自动无缝降级至浏览器 `speechSynthesis`。

### 操作指南

| 按键 | 功能说明 |
| --- | --- |
| `W` `A` `S` `D` / `方向键` | 移动 |
| `鼠标移动` | 视角瞄准 |
| `鼠标左键` | 开火 |
| `按住鼠标右键` | 开镜瞄准（靠墙自动探头，可在设置中切换 Toggle ADS；也可取消投掷物预瞄） |
| `按住 Shift`（前进时） | 冲刺 |
| `C` / `Ctrl` | 下蹲 |
| `Shift + C` | 战术滑铲 |
| `Space` | 跳跃 |
| `R` | 换弹 |
| `1` / `2` / `鼠标滚轮` | 切换主武器 / 副武器 |
| `T` | 消音器热装卸 |
| `F` | 开关战术枪灯 |
| `按住 G` / `4` | 按住 `G` 抛物线预瞄并松手投掷（右键取消）/ 按 `4` 切换投掷物（EMP / 破片 / 诱饵） |
| `Q` | 战术脉冲扫描（标记敌军与中继器） |
| `V` | 近战攻击 / 背后无声处决 |
| `E` | 交互（使用医疗箱/弹药箱、切断电闸、长按无声黑入中继器或登船撤离） |
| `G`（靠近中继器） | 贴装 C4 强爆破拆中继器 |
| `Tab` | 教程期间跳过引导，直接切入实战 |
| `Esc` | 暂停游戏 / 释放鼠标指针 |

### 本地运行

由于项目采用纯静态前端架构且无构建步骤，可直接在仓库根目录启动任意静态服务器进行本地体验：

```bash
python -m http.server 8080
```

然后在浏览器访问 `http://localhost:8080/`（也可通过 `?lang=zh` 或 `?lang=en` 指定初始语言，或直接双击打开 `index.html`）。

### 目录结构

```text
.
├── index.html                   # 游戏主页面、战术 HUD 与设置/模式菜单
├── README.md                    # 中英双语项目说明文档 (English / 简体中文)
├── src/
│   ├── i18n.js                  # EN/ZH 双语词典、语言检测与页面/HUD 实时热切换模块
│   ├── three.bundle.js          # Three.js WebGL 核心库
│   ├── tex.js                   # 程序化 PBR 纹理与地面积水掩膜生成器
│   ├── extreme_gfx.js           # 极限画质 GPU 渲染管线（SSR/GTAO、体积雾、AgX）
│   ├── audio.js                 # Web Audio 程序化实时音效与对讲机 DSP 滤波链
│   ├── voice_logic.js           # 核心逻辑、武器/难度词条、评分系统与按需语音引擎
│   ├── render.js                # 3D 渲染引擎、水洼倒影、DRS 与 GPU 暴雨粒子
│   ├── level.js                 # 04 号码头关卡建筑、中继器、补给箱与 AABB 碰撞
│   ├── weapon.js                # 枪械视模、全息/2.5D 倍镜、弹道与投掷物系统
│   ├── enemy.js                 # 敌军 AI、三段潜行警戒、A* 寻路与等离子弹道
│   └── app.js                   # 60fps 主循环、HUD 更新、教程、训练与撤离任务流
├── voices/
│   ├── voice_manifest.json      # 中英双语语音脚本与角色元数据（3 位角色共 50 条台词）
│   ├── voice_pack.js            # 中文 Edge-TTS 神经语音电台离线包
│   └── voice_pack_en.js         # 英文 Edge-TTS 神经语音电台离线包
└── scripts/
    ├── generate_voices.py       # 中英双语 Edge-TTS / Windows SAPI 语音包生成脚本
    └── test_logic.mjs           # Node 逻辑与双语本地化自动化校验脚本
```
