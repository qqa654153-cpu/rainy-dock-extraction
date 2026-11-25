import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const voiceLogicPath = path.join(rootDir, 'src', 'voice_logic.js');
const logicSrc = fs.readFileSync(voiceLogicPath, 'utf8');
const logicMatch = logicSrc.match(/const GameLogic = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
assert.ok(logicMatch, 'Expected GameLogic IIFE in src/voice_logic.js');
const allGameJs = fs.readdirSync(path.join(rootDir, 'src'))
  .filter((f) => f.endsWith('.js') && f !== 'three.bundle.js')
  .map((f) => fs.readFileSync(path.join(rootDir, 'src', f), 'utf8'))
  .join('\n');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(logicMatch[0], sandbox);
const GameLogic = sandbox.window.__GAME_LOGIC__;
assert.ok(GameLogic, 'GameLogic should attach to window.__GAME_LOGIC__');
assert.equal(sandbox.window.GameLogic, GameLogic, 'GameLogic must also attach to window.GameLogic for module lookups');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

test('voice priority preemption & cooldown matrix', () => {
  assert.equal(GameLogic.selectVoiceAction(null, 1, 5000, 4000), 'skip_cooldown');
  assert.equal(GameLogic.selectVoiceAction(null, 1, 5000, 5000), 'play');
  assert.equal(GameLogic.selectVoiceAction({ priority: 3 }, 1, 0, 1000), 'skip_busy');
  assert.equal(GameLogic.selectVoiceAction({ priority: 2 }, 1, 0, 1000), 'skip_busy');
  assert.equal(GameLogic.selectVoiceAction({ priority: 1 }, 1, 0, 1000), 'skip_busy');
  assert.equal(GameLogic.selectVoiceAction({ priority: 1 }, 2, 0, 1000), 'play');
  assert.equal(GameLogic.selectVoiceAction({ priority: 2 }, 3, 0, 1000), 'play');
  assert.equal(GameLogic.selectVoiceAction({ priority: 3 }, 3, 0, 1000), 'play');
});

test('voice watchdog timeout bounds', () => {
  assert.equal(GameLogic.computeWatchdogTimeoutMs(''), 4000);
  assert.equal(GameLogic.computeWatchdogTimeoutMs('好的'), 4000);
  const mid = GameLogic.computeWatchdogTimeoutMs('弹匣打空，正在紧急换弹！');
  assert.ok(mid >= 4000 && mid <= 22000, `Unexpected mid timeout ${mid}`);
  assert.equal(GameLogic.computeWatchdogTimeoutMs('测'.repeat(300)), 22000);
});

test('directional damage indicator relative angles', () => {
  const origin = { x: 0, z: 0 };
  assert.ok(Math.abs(GameLogic.computeRelativeHitAngleDeg(origin, 0, { x: 0, z: -10 }) - 0) < 0.01);
  assert.ok(Math.abs(GameLogic.computeRelativeHitAngleDeg(origin, 0, { x: 10, z: 0 }) - 90) < 0.01);
  assert.ok(Math.abs(GameLogic.computeRelativeHitAngleDeg(origin, 0, { x: -10, z: 0 }) + 90) < 0.01);
  assert.ok(Math.abs(Math.abs(GameLogic.computeRelativeHitAngleDeg(origin, 0, { x: 0, z: 10 })) - 180) < 0.01);

  // Turning right (yaw = -PI/2) aims camera toward +X (East)
  assert.ok(Math.abs(GameLogic.computeRelativeHitAngleDeg(origin, -Math.PI / 2, { x: 10, z: 0 }) - 0) < 0.01);
  assert.ok(Math.abs(GameLogic.computeRelativeHitAngleDeg(origin, -Math.PI / 2, { x: 0, z: 10 }) - 90) < 0.01);
  assert.equal(GameLogic.computeRelativeHitAngleDeg(origin, 1.2, origin), 0);
});

test('explosion falloff distance & boundary cutoffs', () => {
  assert.equal(GameLogic.computeExplosionFalloff(0, 8, 120), 120);
  assert.equal(GameLogic.computeExplosionFalloff(4, 8, 120), 75);
  assert.equal(GameLogic.computeExplosionFalloff(7.99, 8, 120), 30);
  assert.equal(GameLogic.computeExplosionFalloff(8, 8, 120), 0);
  assert.equal(GameLogic.computeExplosionFalloff(12, 8, 120), 0);
  assert.equal(GameLogic.computeExplosionFalloff(1, 0, 120), 0);
});

test('voice_pack.js matches voice_manifest.json and contains all runtime clip IDs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'voices/voice_manifest.json'), 'utf8'));
  const packSrc = fs.readFileSync(path.join(rootDir, 'voices/voice_pack.js'), 'utf8');
  const packBox = { window: {} };
  vm.createContext(packBox);
  vm.runInContext(packSrc, packBox);
  const pack = packBox.window.__VOICE_PACK__;
  assert.ok(pack && pack.clips && pack.roles);
  assert.equal(Object.keys(pack.clips).length, manifest.clips.length);

  for (const clip of manifest.clips) {
    const entry = pack.clips[clip.id];
    assert.ok(entry, `Missing clip in voice_pack.js: ${clip.id}`);
    assert.ok(typeof entry.data === 'string' && entry.data.length > 200, `Empty audio data for ${clip.id}`);
    assert.equal(entry.role, clip.role);
  }

  const staticVoiceIds = [...allGameJs.matchAll(/voiceId:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(staticVoiceIds.length >= 15, 'Expected static voiceId references in src/*.js');
  for (const id of staticVoiceIds) {
    assert.ok(pack.clips[id], `Static voiceId '${id}' missing from voice_pack.js`);
  }
  for (const relayId of ['A', 'B', 'C']) {
    for (const count of [1, 2]) {
      const rid = `relay_${relayId}_${count}`;
      assert.ok(pack.clips[rid], `Dynamic relay voiceId '${rid}' missing from voice_pack.js`);
    }
  }
});

test('explosive barrel chain-detonation state transitions are non-reentrant', () => {
  const barrels = [
    { id: 0, hp: 45, state: 'intact', x: 0, z: 0, chainTimer: -1 },
    { id: 1, hp: 45, state: 'intact', x: 3.5, z: 0, chainTimer: -1 },
    { id: 2, hp: 45, state: 'intact', x: 15, z: 0, chainTimer: -1 },
  ];
  let boomCount = 0;
  function damageBarrel(b, dmg) {
    if (b.state === 'exploded' || b.state === 'chaining') return;
    b.hp -= dmg;
    if (b.hp <= 0) explodeBarrel(b);
    else if (b.hp <= 15 && b.state === 'intact') b.state = 'burning';
  }
  function explodeBarrel(b) {
    if (b.state === 'exploded') return;
    b.state = 'exploded';
    boomCount++;
    for (const other of barrels) {
      if (other !== b && (other.state === 'intact' || other.state === 'burning')) {
        if (Math.hypot(other.x - b.x, other.z - b.z) <= 6.2) {
          other.state = 'chaining';
          other.chainTimer = 0.16;
        }
      }
    }
  }

  damageBarrel(barrels[0], 35); // hp = 10 <= 15 -> burning
  assert.equal(barrels[0].state, 'burning');
  damageBarrel(barrels[0], 20); // hp <= 0 -> explodes barrel 0, chains barrel 1
  assert.equal(barrels[0].state, 'exploded');
  assert.equal(barrels[1].state, 'chaining');
  assert.equal(barrels[2].state, 'intact');
  explodeBarrel(barrels[0]); // re-entrant call must no-op
  assert.equal(boomCount, 1);
  explodeBarrel(barrels[1]); // chained barrel explodes once without re-triggering barrel 0
  assert.equal(barrels[1].state, 'exploded');
  assert.equal(boomCount, 2);
});

test('TRAINING_STAGES metadata covers 6 tactical stages and all training voiceIds exist in voice_pack.js', () => {
  assert.equal(GameLogic.TRAINING_STAGES.length, 6);
  assert.deepEqual(Array.from(GameLogic.TRAINING_STAGES, (s) => s.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(GameLogic.TRAINING_STAGES[0].relayId, 'A');
  assert.equal(GameLogic.TRAINING_STAGES[1].relayId, 'B');
  assert.equal(GameLogic.TRAINING_STAGES[2].relayId, 'C');
  assert.equal(GameLogic.TRAINING_STAGES[3].isExtractStage, true);
  assert.equal(GameLogic.TRAINING_STAGES[4].stealthDrill, true);
  assert.equal(GameLogic.TRAINING_STAGES[5].relayId, 'C');

  const packPath = path.join(rootDir, 'voices', 'voice_pack.js');
  const packCtx = { window: {} };
  vm.runInNewContext(fs.readFileSync(packPath, 'utf8'), packCtx);
  const clips = packCtx.window.__VOICE_PACK__.clips;
  for (const s of GameLogic.TRAINING_STAGES) {
    assert.ok(clips[s.voiceId], `Missing stage voice clip: ${s.voiceId}`);
  }
  for (const id of ['train_timed_start', 'train_timed_end', 'train_endless_start', 'train_endless_wave', 'train_stage_clear']) {
    assert.ok(clips[id], `Missing training voice clip: ${id}`);
  }
});

test('computeTimedTargetScore rewards weakpoint crits and caps combo multiplier at 3.0x', () => {
  const body1 = GameLogic.computeTimedTargetScore({ basePoints: 100, isCrit: false, comboCount: 1 });
  assert.equal(body1.points, 100);
  assert.equal(body1.multiplier, 1);

  const crit3 = GameLogic.computeTimedTargetScore({ basePoints: 100, isCrit: true, comboCount: 3 });
  assert.equal(crit3.multiplier, 1.3);
  assert.equal(crit3.points, 260);

  const capped = GameLogic.computeTimedTargetScore({ basePoints: 100, isCrit: true, comboCount: 25 });
  assert.equal(capped.multiplier, 3);
  assert.equal(capped.points, 600);
});

test('computeEndlessWaveSpec escalates waves smoothly and enforces scaling caps', () => {
  const w1 = GameLogic.computeEndlessWaveSpec(1);
  assert.equal(w1.wave, 1);
  assert.equal(w1.droneCount, 2);
  assert.equal(w1.houndCount, 2);
  assert.equal(w1.totalCount, 4);
  assert.equal(w1.maxConcurrent, 4);
  assert.equal(w1.hpScale, 1);

  const w5 = GameLogic.computeEndlessWaveSpec(5);
  assert.ok(w5.totalCount > w1.totalCount);
  assert.ok(w5.maxConcurrent > w1.maxConcurrent && w5.maxConcurrent <= 10);

  const w30 = GameLogic.computeEndlessWaveSpec(30);
  assert.equal(w30.maxConcurrent, 10);
  assert.equal(w30.hpScale, 1.65);
  assert.equal(w30.speedScale, 1.25);
  assert.equal(w30.cooldownScale, 0.72);
});

test('updateTrainingRecords isolates timed durations, endless highs, and stage invulnerable practice', () => {
  let records = GameLogic.createDefaultTrainingRecords();

  const r1 = GameLogic.updateTrainingRecords(records, 'timed', { duration: 60, score: 1200, kills: 7 });
  assert.equal(r1.isNewRecord, true);
  assert.ok(r1.notes.includes('最高分'));
  records = r1.nextRecords;
  assert.equal(records.timed['60'].bestScore, 1200);
  assert.equal(records.timed['30'].bestScore, 0);

  const r2 = GameLogic.updateTrainingRecords(records, 'timed', { duration: 60, score: 900, kills: 8 });
  assert.equal(r2.isNewRecord, false);
  records = r2.nextRecords;
  assert.equal(records.timed['60'].bestScore, 1200);
  assert.equal(records.timed['60'].bestKills, 8);

  const e1 = GameLogic.updateTrainingRecords(records, 'endless', { wave: 4, kills: 29, time: 182.44 });
  assert.equal(e1.isNewRecord, true);
  records = e1.nextRecords;
  assert.equal(records.endless.bestWave, 4);
  assert.equal(records.endless.bestKills, 29);
  assert.equal(records.endless.bestTime, 182.4);

  // Invulnerable practice clear marks practiceCleared without setting official cleared/bestTime
  const sPrac = GameLogic.updateTrainingRecords(records, 'stage', { stageId: 2, cleared: true, time: 31.2, invulnerable: true });
  assert.equal(sPrac.isNewRecord, false);
  records = sPrac.nextRecords;
  assert.equal(records.stages['2'].practiceCleared, true);
  assert.equal(records.stages['2'].cleared, false);
  assert.equal(records.stages['2'].bestTime, null);

  // Failed normal run does not record clear
  const sFail = GameLogic.updateTrainingRecords(records, 'stage', { stageId: 2, cleared: false, time: 20.0, invulnerable: false });
  records = sFail.nextRecords;
  assert.equal(records.stages['2'].cleared, false);

  // Official normal clears track bestTime
  const sWin1 = GameLogic.updateTrainingRecords(records, 'stage', { stageId: 2, cleared: true, time: 48.56, invulnerable: false });
  assert.equal(sWin1.isNewRecord, true);
  records = sWin1.nextRecords;
  assert.equal(records.stages['2'].cleared, true);
  assert.equal(records.stages['2'].bestTime, 48.6);

  const sWin2 = GameLogic.updateTrainingRecords(records, 'stage', { stageId: 2, cleared: true, time: 52.1, invulnerable: false });
  assert.equal(sWin2.isNewRecord, false);
  assert.equal(sWin2.nextRecords.stages['2'].bestTime, 48.6);
});

test('3-state stealth detection respects FOV cone, crouch stealth factor, and decay', () => {
  const s1 = GameLogic.evaluateStealthStep({
    state: 'PATROL', suspicion: 0, dt: 0.4, hasLOS: true, dist: 12, angleDeg: 10, playerStealthFactor: 1.0,
  });
  assert.equal(s1.state, 'SUSPICIOUS');
  assert.ok(s1.suspicion > 0.22);

  // Behind enemy at 8m yields zero perception and decays suspicion back toward PATROL
  const sBehind = GameLogic.evaluateStealthStep({
    state: 'SUSPICIOUS', suspicion: 0.1, dt: 0.6, hasLOS: true, dist: 8, angleDeg: 150, playerStealthFactor: 1.0,
  });
  assert.equal(sBehind.perceived, false);
  assert.equal(sBehind.state, 'PATROL');

  // Crouching shrinks effective detection range
  const sCrouch = GameLogic.evaluateStealthStep({
    state: 'PATROL', suspicion: 0, dt: 0.5, hasLOS: true, dist: 19, angleDeg: 0, detectRange: 26, playerStealthFactor: 0.62,
  });
  assert.equal(sCrouch.perceived, false);

  // Sustained direct FOV transitions cleanly to COMBAT
  const sCombat = GameLogic.evaluateStealthStep({
    state: 'SUSPICIOUS', suspicion: 0.85, dt: 0.5, hasLOS: true, dist: 10, angleDeg: 5, playerStealthFactor: 1.0,
  });
  assert.equal(sCombat.state, 'COMBAT');
  assert.equal(sCombat.suspicion, 1);
});

test('A* NavGrid routes around static obstacle walls while ignoring high roofs and disabled boxes', () => {
  const boxes = [
    { minX: -2, maxX: 2, minY: 0, maxY: 2.6, minZ: -6, maxZ: 6, disabled: false },
    { minX: -10, maxX: 10, minY: 5.0, maxY: 6.2, minZ: -10, maxZ: 10, disabled: false }, // overhead roof
    { minX: 4, maxX: 6, minY: 0, maxY: 1.5, minZ: -2, maxZ: 2, disabled: true }, // exploded barrel
  ];
  const grid = GameLogic.buildNavGrid(boxes, { minX: -12, maxX: 12, minZ: -12, maxZ: 12, cellSize: 1.0, padding: 0.45 });
  const path = GameLogic.findGridPath(grid, { x: -6, z: 0 }, { x: 6, z: 0 });
  assert.ok(path.length >= 3, 'Expected multi-step path detouring around wall');
  for (const pt of path) {
    assert.ok(!(pt.x > -1.8 && pt.x < 1.8 && pt.z > -5.8 && pt.z < 5.8), `Path cut through wall at (${pt.x},${pt.z})`);
  }
  const end = path[path.length - 1];
  assert.equal(end.x, 6);
  assert.equal(end.z, 0);
});

test('weapon damage matrix enforces frontal shield blocking, DMR pierce, EMP stun bypass, and suppressor scaling', () => {
  const car = GameLogic.WEAPON_CATALOG.car47;
  const dmr = GameLogic.WEAPON_CATALOG.dmr;

  const blocked = GameLogic.computeShotDamage({ weaponCfg: car, hitShield: true, enemyEmpStunned: false });
  assert.equal(blocked.blockedByShield, true);
  assert.equal(blocked.finalDamage, 0);

  const dmrPierce = GameLogic.computeShotDamage({ weaponCfg: dmr, hitShield: true, enemyEmpStunned: false });
  assert.equal(dmrPierce.piercedShield, true);
  assert.ok(dmrPierce.finalDamage > 0);

  const empCrit = GameLogic.computeShotDamage({ weaponCfg: car, hitShield: true, enemyEmpStunned: true, isCrit: true });
  assert.equal(empCrit.blockedByShield, false);
  assert.equal(empCrit.finalDamage, 54);

  const suppressedCar = GameLogic.computeShotDamage({ weaponCfg: car, suppressorAttached: true, isCrit: false });
  assert.equal(suppressedCar.finalDamage, Math.round(car.baseDamage * car.silencerDamageMult));
});

test('mission rating, medal grants, career skin unlocks, and endless airdrop rolling work deterministically', () => {
  const sReport = GameLogic.computeMissionRating({
    elapsedSec: 175, kills: 18, shotsFired: 100, shotsHit: 68, crits: 8,
    alarmsTriggered: 0, stealthRelays: 3, damageTaken: 0, barrelKills: 2, meleeKills: 2,
    difficulty: 'veteran', mutators: ['blackout'],
  });
  assert.equal(sReport.grade, 'S');
  assert.ok(sReport.medals.includes('暴雨幽灵'));
  assert.ok(sReport.medals.includes('零伤突围'));
  assert.ok(sReport.medals.includes('爆破大师'));

  let career = GameLogic.createDefaultCareerProfile();
  const upd = GameLogic.updateCareerRecords(career, { victory: true, ...sReport, elapsedSec: 175 });
  assert.equal(upd.nextProfile.bestGrade, 'S');
  assert.ok(upd.nextProfile.unlockedSkins.includes('night_ops'));
  assert.ok(upd.nextProfile.unlockedSkins.includes('hazmat_blue'));

  const options = GameLogic.rollEndlessAirdropOptions(['ap_rounds'], () => 0.15);
  assert.equal(options.length, 3);
  const ids = new Set(options.map((o) => o.id));
  assert.equal(ids.size, 3);
  assert.equal(ids.has('ap_rounds'), false);

  const wave6 = GameLogic.computeEndlessWaveSpec(6);
  assert.ok(wave6.shieldCount >= 1 && wave6.sniperCount >= 1 && wave6.reconCount >= 1);
});

test('HTML shell preserves file:// classic scripts and Phase 3 DOM hooks match Career skin thresholds', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  assert.equal(/<script[^>]+type=["']module["']/i.test(html), false, 'Must preserve classic script loading for file://');
  for (const id of ['loadout-panel', 'career-best-strip', 'airdrop-dialog', 'airdrop-options', 'stealth-chip', 'holdout-bar', 'wpn-slot-badge', 'sup-status', 'grenade-status', 'scan-status']) {
    assert.ok(html.includes(`id="${id}"`), `Missing Phase 3 DOM element #${id} in index.html`);
  }
  for (const wId of Object.keys(GameLogic.WEAPON_CATALOG).filter((k) => k !== 'pistol')) {
    assert.ok(html.includes(`value="${wId}"`), `Missing loadout weapon option ${wId}`);
  }

  // Verify progressive career unlock paths (A rank -> night_ops; 3 clears -> hazmat_blue)
  let c = GameLogic.createDefaultCareerProfile();
  const rA = GameLogic.updateCareerRecords(c, { victory: true, grade: 'A', score: 4100, elapsedSec: 210, medals: [] });
  assert.ok(rA.nextProfile.unlockedSkins.includes('night_ops'));
  assert.equal(rA.nextProfile.unlockedSkins.includes('hazmat_blue'), false);
  const r2 = GameLogic.updateCareerRecords(rA.nextProfile, { victory: true, grade: 'B', score: 3100, elapsedSec: 230, medals: [] });
  const r3 = GameLogic.updateCareerRecords(r2.nextProfile, { victory: true, grade: 'B', score: 3200, elapsedSec: 225, medals: [] });
  assert.equal(r3.nextProfile.clears, 3);
  assert.ok(r3.nextProfile.unlockedSkins.includes('hazmat_blue'));
});

test('computeAdsSensitivityScale and computeAdsOpticsState switch DMR 2.5D scope vs 3D optics & realism cleanly', () => {
  assert.equal(GameLogic.computeAdsSensitivityScale(75, 75), 1);
  const dmrScale = GameLogic.computeAdsSensitivityScale(34, 75);
  assert.ok(dmrScale > 0.38 && dmrScale < 0.45, `Unexpected DMR scale ${dmrScale}`);
  assert.ok(GameLogic.computeAdsSensitivityScale(5, 75) >= 0.25);

  const carFull = GameLogic.computeAdsOpticsState({ weaponId: 'car47', adsAlpha: 1.0, difficulty: 'standard' });
  assert.equal(carFull.mode, '3d_optic');
  assert.equal(carFull.hideViewmodel3D, false);
  assert.equal(carFull.scopeOverlayOpacity, 0);
  assert.equal(carFull.crosshairLineOpacity, 0);
  assert.ok(carFull.crosshairDotOpacity >= 0.78);

  const dmrMid = GameLogic.computeAdsOpticsState({ weaponId: 'dmr', adsAlpha: 0.4, difficulty: 'standard' });
  assert.equal(dmrMid.mode, '3d_optic');
  assert.equal(dmrMid.hideViewmodel3D, false);
  assert.equal(dmrMid.scopeOverlayOpacity, 0);

  const dmrFull = GameLogic.computeAdsOpticsState({ weaponId: 'dmr', adsAlpha: 0.96, difficulty: 'standard' });
  assert.equal(dmrFull.mode, '2d_scope');
  assert.equal(dmrFull.hideViewmodel3D, true);
  assert.equal(dmrFull.scopeOverlayOpacity, 1);
  assert.equal(dmrFull.crosshairDotOpacity, 0);

  const dmrReload = GameLogic.computeAdsOpticsState({ weaponId: 'dmr', adsAlpha: 0.96, isReloading: true, difficulty: 'standard' });
  assert.equal(dmrReload.hideViewmodel3D, false);
  assert.equal(dmrReload.scopeOverlayOpacity, 0);

  const realAds = GameLogic.computeAdsOpticsState({ weaponId: 'car47', adsAlpha: 1.0, difficulty: 'realistic' });
  assert.equal(realAds.crosshairDotOpacity, 0);
  assert.equal(realAds.crosshairLineOpacity, 0);

  const realismAds = GameLogic.computeAdsOpticsState({ weaponId: 'car47', adsAlpha: 1.0, difficulty: 'realism' });
  assert.equal(realismAds.crosshairDotOpacity, 0);
  assert.equal(realismAds.crosshairLineOpacity, 0);

  const realismDmrScope = GameLogic.computeAdsOpticsState({ weaponId: 'dmr', adsAlpha: 0.96, difficulty: 'realism' });
  assert.equal(realismDmrScope.mode, '2d_scope');
  assert.equal(realismDmrScope.scopeOverlayOpacity, 1);
  assert.equal(realismDmrScope.crosshairDotOpacity, 0);
});

test('4-tier DIFFICULTIES, aim assist cone, stealth detectMult, rating multiplier, and difficulty DOM structure', () => {
  const tiers = ['recruit', 'standard', 'veteran', 'realism'];
  for (const id of tiers) {
    assert.ok(GameLogic.DIFFICULTIES[id], `Missing difficulty tier '${id}'`);
  }
  const r = GameLogic.getDifficultyConfig('recruit');
  const s = GameLogic.getDifficultyConfig('standard');
  const v = GameLogic.getDifficultyConfig('veteran');
  const x = GameLogic.getDifficultyConfig('realism');

  assert.equal(GameLogic.getDifficultyConfig('realistic').id, 'realism');
  assert.equal(GameLogic.getDifficultyConfig('nonexistent').id, 'standard');

  assert.ok(r.aimAssistDeg > 2 && r.recoilScale < 1 && r.spreadScale < 1);
  assert.ok(r.enemyHpMult < 1 && r.enemyDmgMult < 1 && r.enemySpeedScale < 1 && r.enemyCooldownScale > 1);
  assert.ok(r.stealthDetectMult < 1 && r.callInTimerScale > 1);
  assert.equal(r.playerRegenCap, 100);
  assert.ok(r.ammoReserveMult > 1 && r.scoreMult < 1);

  assert.equal(s.aimAssistDeg, 0);
  assert.equal(s.enemyHpMult, 1.0);
  assert.equal(s.playerRegenCap, 65);
  assert.equal(s.scoreMult, 1.0);

  assert.ok(v.enemyHpMult > 1 && v.enemyDmgMult > s.enemyDmgMult && v.enemyCooldownScale < 1);
  assert.ok(v.playerCritBonus > 0 && v.scoreMult === 1.25);

  assert.equal(x.hideHudHints, true);
  assert.ok(x.playerRegenCap < s.playerRegenCap && x.playerCritBonus > v.playerCritBonus && x.scoreMult === 1.5);

  // Aim assist cone gently pulls nearby in-cone targets, skips out-of-cone targets
  const assistInCone = GameLogic.selectAimAssistDirection({
    origin: { x: 0, y: 1.6, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    candidates: [{ x: 0.35, y: 1.6, z: -15 }],
    maxAngleDeg: r.aimAssistDeg,
    maxRange: 65,
    blend: 0.9,
  });
  assert.equal(assistInCone.assisted, true);
  assert.ok(assistInCone.dir.x > 0 && assistInCone.dir.z < 0);
  const mag = Math.hypot(assistInCone.dir.x, assistInCone.dir.y, assistInCone.dir.z);
  assert.ok(Math.abs(mag - 1) < 1e-4);

  const assistOutCone = GameLogic.selectAimAssistDirection({
    origin: { x: 0, y: 1.6, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    candidates: [{ x: 4.5, y: 1.6, z: -10 }],
    maxAngleDeg: r.aimAssistDeg,
    maxRange: 65,
  });
  assert.equal(assistOutCone.assisted, false);
  assert.ok(Math.abs(assistOutCone.dir.x) < 1e-5);

  // Stealth detection scaling
  const stepBase = GameLogic.evaluateStealthStep({
    state: 'PATROL',
    suspicion: 0,
    hasLOS: true,
    dist: 16,
    detectRange: 26,
    playerStealthFactor: 1.0,
    detectMult: s.stealthDetectMult,
    dt: 0.25,
  });
  const stepRecruit = GameLogic.evaluateStealthStep({
    state: 'PATROL',
    suspicion: 0,
    hasLOS: true,
    dist: 16,
    detectRange: 26,
    playerStealthFactor: 1.0,
    detectMult: r.stealthDetectMult,
    dt: 0.25,
  });
  const stepRealism = GameLogic.evaluateStealthStep({
    state: 'PATROL',
    suspicion: 0,
    hasLOS: true,
    dist: 16,
    detectRange: 26,
    playerStealthFactor: 1.0,
    detectMult: x.stealthDetectMult,
    dt: 0.25,
  });
  assert.ok(stepRecruit.suspicion < stepBase.suspicion && stepBase.suspicion < stepRealism.suspicion);

  // Mission score scaling & career unlock parity on recruit
  const perf = {
    elapsedSec: 175,
    kills: 18,
    shotsFired: 120,
    shotsHit: 72,
    crits: 14,
    alarmsTriggered: 0,
    stealthRelays: 3,
    damageTaken: 25,
    barrelKills: 2,
    meleeKills: 3,
    mutators: [],
  };
  const scoreRec = GameLogic.computeMissionRating({ ...perf, difficulty: 'recruit' }).score;
  const scoreStd = GameLogic.computeMissionRating({ ...perf, difficulty: 'standard' }).score;
  const scoreVet = GameLogic.computeMissionRating({ ...perf, difficulty: 'veteran' }).score;
  const scoreReal = GameLogic.computeMissionRating({ ...perf, difficulty: 'realism' }).score;
  assert.ok(scoreRec < scoreStd && scoreStd < scoreVet && scoreVet < scoreReal);

  const recruitCareer = GameLogic.updateCareerRecords(GameLogic.createDefaultCareerProfile(), {
    victory: true,
    grade: 'A',
    score: scoreRec,
    elapsedSec: 175,
    medals: [],
  });
  assert.equal(recruitCareer.nextProfile.clears, 1);
  assert.ok(recruitCareer.nextProfile.unlockedSkins.includes('night_ops'));

  // HTML structure assertions for redesigned difficulty menu & accordion/card MWG compliance
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  for (const id of ['difficulty-panel', 'diff-summary', 'disclosure-loadout', 'disclosure-settings', 'difficulty-badge']) {
    assert.ok(html.includes(`id="${id}"`), `Missing difficulty UI element #${id}`);
  }
  for (const diffId of tiers) {
    assert.ok(html.includes(`value="${diffId}"`), `Missing difficulty radio option '${diffId}'`);
  }
  assert.ok(html.includes('interpolate-size: allow-keywords'), 'Missing MWG accordion interpolate-size rule');
  assert.ok(html.includes('::details-content'), 'Missing MWG ::details-content styling');
  assert.equal(/<summary[^>]*>(?:(?!<\/summary>)[\s\S])*?<h[1-6]\b/i.test(html), false, 'Summary must not contain heading tags');
});

test('8-step tutorial voice clips, 3-rifle optics groups, and #scope-overlay DOM exist without dmrScopeExt blockage', () => {
  assert.equal(GameLogic.TUTORIAL_TOTAL_STEPS, 8);
  assert.equal(GameLogic.TUTORIAL_STEP_VOICES.length, 10);

  const packCtx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(rootDir, 'voices', 'voice_pack.js'), 'utf8'), packCtx);
  const clips = packCtx.window.__VOICE_PACK__.clips;
  for (const vid of GameLogic.TUTORIAL_STEP_VOICES) {
    assert.ok(clips[vid], `Missing 8-step tutorial clip '${vid}' in voice_pack.js`);
  }

  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  assert.ok(html.includes('id="scope-overlay"'), 'Missing #scope-overlay in index.html');
  assert.ok(html.includes('id="scope-svg"'), 'Missing #scope-svg in index.html');
  assert.ok(html.includes('@media (prefers-reduced-motion'), 'Missing prefers-reduced-motion rule in index.html');

  const weaponSrc = fs.readFileSync(path.join(rootDir, 'src', 'weapon.js'), 'utf8');
  assert.equal(/this\.dmrScopeExt|\bdmrScopeExt\s*=/.test(weaponSrc), false, 'Legacy dmrScopeExt cylinder blockage must be removed');
  for (const sym of ['holoGroup', 'sgReflexGroup', 'dmrScopeGroup', 'setAds3DHidden']) {
    assert.ok(weaponSrc.includes(sym), `Missing optics symbol '${sym}' in src/weapon.js`);
  }
});

test('extreme quality preset, DRS scaling curve, UI controls, and non-collision detail groups', () => {
  assert.ok(Array.isArray(GameLogic.QUALITY_PRESETS));
  assert.ok(GameLogic.QUALITY_PRESETS.includes('extreme'));
  assert.equal(GameLogic.sanitizeQualityPreset('extreme'), 'extreme');
  assert.equal(GameLogic.sanitizeQualityPreset('invalid_tier'), 'high');

  // DRS drops step under sustained low FPS and recovers above 58 FPS
  assert.ok(GameLogic.computeDrsScale(1.0, 46, true, 0.5) < 1.0);
  assert.ok(GameLogic.computeDrsScale(0.75, 62, true, 0.5) > 0.75);
  assert.equal(GameLogic.computeDrsScale(0.8, 40, false, 0.5), 1.0);
  assert.ok(GameLogic.computeDrsScale(0.68, 30, true, 1.0) >= 0.65);

  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  assert.ok(/<option\b[^>]*\bvalue="extreme"/i.test(html), 'Missing extreme quality option in index.html');
  assert.ok(html.includes('id="opt-drs"'), 'Missing DRS toggle switch #opt-drs in index.html');
  assert.ok(html.includes('src/extreme_gfx.js'), 'Missing src/extreme_gfx.js script include');

  const levelSrc = fs.readFileSync(path.join(rootDir, 'src', 'level.js'), 'utf8');
  const enemySrc = fs.readFileSync(path.join(rootDir, 'src', 'enemy.js'), 'utf8');
  assert.ok(levelSrc.includes('extremeDetailGroup') && levelSrc.includes('setExtremeDetail'));
  assert.ok(enemySrc.includes('extremeDetailGroup') && enemySrc.includes('setExtremeDetail'));
});

test('extreme pixel cap, viewport DRS math, virtual light scoring, and slab AABB raycast', () => {
  assert.equal(GameLogic.EXTREME_MAX_PIXELS, 2304000);

  const cap1080 = GameLogic.computeExtremePixelCap(1920, 1080, 1.0);
  assert.equal(cap1080.width, 1920);
  assert.equal(cap1080.height, 1080);
  assert.equal(cap1080.capScale, 1.0);

  const cap1600 = GameLogic.computeExtremePixelCap(2560, 1600, 1.5);
  assert.ok(cap1600.width * cap1600.height <= GameLogic.EXTREME_MAX_PIXELS);
  assert.equal(cap1600.width % 2, 0);
  assert.equal(cap1600.height % 2, 0);
  assert.ok(cap1600.capScale < 1.0);

  const vp = GameLogic.computeActiveViewportSize(1920, 1200, 0.72);
  assert.equal(vp.activeW % 2, 0);
  assert.equal(vp.activeH % 2, 0);
  assert.ok(vp.activeW < 1920 && vp.activeH < 1200);
  assert.ok(Math.abs(vp.uvScaleX - vp.activeW / 1920) < 1e-6);
  assert.ok(vp.uvMaxX < vp.uvScaleX && vp.uvMaxY < vp.uvScaleY);

  assert.equal(GameLogic.scoreVirtualLight(0, 0, 0, 0, 20, 5, 0, 0, 0), -1);
  const nearScore = GameLogic.scoreVirtualLight(2, 1, 2, 20, 22, 6, 0, 1, 0);
  const farScore = GameLogic.scoreVirtualLight(40, 1, 40, 20, 22, 6, 0, 1, 0);
  assert.ok(nearScore > farScore && farScore > 0);

  // Slab AABB intersection: unit cube centered at (0, 1, -5) => bounds [-1..1, 0..2, -6..-4]
  const hitDist = GameLogic.raycastAABB(0, 1, 0, 0, 0, -1, -1, 0, -6, 1, 2, -4, 0.1, 20);
  assert.ok(Math.abs(hitDist - 4.0) < 1e-5, `Expected hit distance 4.0, got ${hitDist}`);
  assert.equal(GameLogic.raycastAABB(0, 1, 0, 0, 1, 0, -1, 0, -6, 1, 2, -4, 0.1, 20), -1);
  assert.equal(GameLogic.raycastAABB(0, 1, 0, 0, 0, 1, -1, 0, -6, 1, 2, -4, 0.1, 20), -1);
});

test('5060 extreme pipeline static contracts: LightPool, MRT temporal filter, zero-alloc DRS, non-blocking warmup UI', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(rootDir, 'src', 'render.js'), 'utf8');
  const extremeSrc = fs.readFileSync(path.join(rootDir, 'src', 'extreme_gfx.js'), 'utf8');
  const weaponSrc = fs.readFileSync(path.join(rootDir, 'src', 'weapon.js'), 'utf8');
  const levelSrc = fs.readFileSync(path.join(rootDir, 'src', 'level.js'), 'utf8');
  const enemySrc = fs.readFileSync(path.join(rootDir, 'src', 'enemy.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(rootDir, 'src', 'app.js'), 'utf8');

  assert.ok(html.includes('id="gfx-warmup-banner"') && html.includes('popover="manual"'));
  assert.ok(html.includes('transition-behavior: allow-discrete'));
  assert.ok(html.includes(':is(:popover-open, .\\:popover-open)'));
  assert.equal(/#(?:objective-card|bottom-left|bottom-right)\s*\{[^}]*backdrop-filter/s.test(html), false, 'HUD cards must not use backdrop-filter');

  assert.ok(renderSrc.includes('class LightPool') && renderSrc.includes('prepareExtremeAsync'));
  assert.ok(renderSrc.includes('setDrsViewport'));
  assert.equal(/whSpotShadow\.castShadow\s*=\s*whVisible/.test(renderSrc), false, 'whSpotShadow.castShadow must remain locked instead of toggling dynamically');

  assert.ok(extremeSrc.includes('yieldToMainThread') && extremeSrc.includes('temporalResolveMat') && extremeSrc.includes('bilateralMrtMat'));
  assert.ok(extremeSrc.includes('vExtViewAxisX') && extremeSrc.includes('warmupShadersAsync') && extremeSrc.includes('bakeExtremeAssetsAsync'));

  assert.equal((weaponSrc.match(/new THREE\.PointLight/g) || []).length, 1, 'weapon.js may only keep vmRimLight as permanent PointLight');
  assert.equal((levelSrc.match(/new THREE\.PointLight/g) || []).length, 0, 'level.js lights must use LightPool');
  assert.equal((enemySrc.match(/new THREE\.PointLight/g) || []).length, 0, 'enemy.js lights must use LightPool');
  assert.ok(levelSrc.includes('raycastBoxes'));

  assert.ok(appSrc.includes('_compassPipPool') && appSrc.includes('prepareExtremeAsync') && appSrc.includes('_showWarmupBanner'));
});

test('aerial collision resolution, floor height, safe spawn, and steering helpers', () => {
  const warehouseBox = {
    minX: -22.2, maxX: -1.8, minY: 0, maxY: 7.82, minZ: -32.2, maxZ: -13.8, disabled: false,
  };
  const containerBox = {
    minX: 4.0, maxX: 9.0, minY: 0, maxY: 2.6, minZ: -6.0, maxZ: -3.5, disabled: false,
  };
  const extremeBraceBox = {
    minX: 12.0, maxX: 13.0, minY: 0, maxY: 14.0, minZ: 4.0, maxZ: 5.0, disabled: true,
  };
  const highBeamBox = {
    minX: 14.0, maxX: 16.0, minY: 12.0, maxY: 15.0, minZ: 0.0, maxZ: 10.0, disabled: false,
  };
  const boxes = [warehouseBox, containerBox, extremeBraceBox, highBeamBox];

  // 1. Inside warehouse aerial no-fly volume must push strictly outside (XZ or Y)
  const inWh = { x: -20.9, y: 4.0, z: -20.0 };
  assert.equal(GameLogic.resolveAerialObstacle(inWh, boxes, 1.0, 0.45), true);
  assert.ok(
    inWh.x <= warehouseBox.minX - 0.99 ||
    inWh.x >= warehouseBox.maxX + 0.99 ||
    inWh.z <= warehouseBox.minZ - 0.99 ||
    inWh.z >= warehouseBox.maxZ + 0.99 ||
    inWh.y >= warehouseBox.maxY + 0.44,
    `Expected drone pushed out of warehouse box, got ${JSON.stringify(inWh)}`
  );

  // 2. Just dipping into warehouse roof must push upward onto rooftop clearance
  const onRoof = { x: -12.0, y: 8.0, z: -22.0 };
  assert.equal(GameLogic.resolveAerialObstacle(onRoof, boxes, 1.0, 0.45), true);
  assert.ok(onRoof.y >= warehouseBox.maxY + 0.45 - 1e-5, `Expected roof push-up, got y=${onRoof.y}`);

  // 3. Disabled (extremeOnly when disabled) box is ignored; enabled is resolved
  const braceProbe = { x: 12.5, y: 5.0, z: 4.5 };
  assert.equal(GameLogic.resolveAerialObstacle(braceProbe, boxes, 1.0, 0.45), false);
  extremeBraceBox.disabled = false;
  assert.equal(GameLogic.resolveAerialObstacle(braceProbe, boxes, 1.0, 0.45), true);
  extremeBraceBox.disabled = true;

  // 4. EMP / hover floor height respects rooftops/containers underneath while ignoring overhead beams
  assert.equal(GameLogic.getAerialFloorHeight(0, 0, 5.0, boxes, 0.95), 0);
  assert.ok(Math.abs(GameLogic.getAerialFloorHeight(6.5, -4.75, 4.5, boxes, 0.95) - 2.6) < 1e-5);
  assert.equal(GameLogic.getAerialFloorHeight(15.0, 5.0, 5.0, boxes, 0.95), 0);

  // 5. findSafeAerialSpawn relocates preferred coordinate inside warehouse into conflict-free air
  const safeWh = GameLogic.findSafeAerialSpawn(
    { x: -12.0, y: 4.0, z: -22.0 },
    boxes,
    { radiusXZ: 1.05, halfY: 0.5, minY: 2.0 }
  );
  assert.ok(safeWh.y >= 2.0);
  assert.equal(
    GameLogic.resolveAerialObstacle({ x: safeWh.x, y: safeWh.y, z: safeWh.z }, boxes, 1.05, 0.5),
    false,
    `Safe spawn must be completely clear of obstacles, got ${JSON.stringify(safeWh)}`
  );

  // 6. computeAerialSteerVector: climbs over low container, detours horizontally around tall warehouse
  const aerialGrid = GameLogic.buildNavGrid([warehouseBox, containerBox], {
    cellSize: 2, padding: 1.0, maxStepHeight: 2.75, ceilingMinY: 8.5,
    minX: -30, maxX: 20, minZ: -38, maxZ: 20,
  });
  const climbSteer = GameLogic.computeAerialSteerVector(
    { x: 2.0, y: 2.0, z: -4.75 },
    { x: 11.0, y: 2.0, z: -4.75 },
    boxes,
    aerialGrid,
    { radiusXZ: 1.0, halfY: 0.45, lookahead: 4.2, maxClimbY: 6.8, flankSign: 1 }
  );
  assert.equal(climbSteer.blockedAhead, true);
  assert.ok(
    climbSteer.climbTargetY !== null && climbSteer.climbTargetY >= containerBox.maxY + 0.45,
    `Expected climbTargetY over low container, got ${JSON.stringify(climbSteer)}`
  );

  const whSteer = GameLogic.computeAerialSteerVector(
    { x: -12.0, y: 4.0, z: -11.5 },
    { x: -12.0, y: 4.0, z: -36.0 },
    boxes,
    aerialGrid,
    { radiusXZ: 1.0, halfY: 0.45, lookahead: 4.2, maxClimbY: 6.8, flankSign: 1 }
  );
  assert.equal(whSteer.blockedAhead, true);
  assert.equal(whSteer.climbTargetY, null, 'Tall warehouse (7.82m) should steer horizontally, not climb');
  assert.ok(Math.abs(whSteer.dirX) > 0.2, `Expected lateral bypass steering around warehouse, got ${JSON.stringify(whSteer)}`);
});

test('level floating-prop fixes & aerial collision/interaction static invariants', () => {
  const levelSrc = fs.readFileSync(path.join(rootDir, 'src', 'level.js'), 'utf8');
  const enemySrc = fs.readFileSync(path.join(rootDir, 'src', 'enemy.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(rootDir, 'src', 'app.js'), 'utf8');

  // Breaker & floating prop anchors
  assert.equal(levelSrc.includes('z: -15.6'), false, 'Old floating breaker_B z=-15.6 must be removed');
  assert.ok(levelSrc.includes('-14.295'), 'breaker_B must mount flush to warehouse south wall inner face');
  assert.ok(levelSrc.includes('-19.5') && levelSrc.includes('-2.18'), 'breaker_A must mount on light pole');
  assert.ok(levelSrc.includes('lampMount') && levelSrc.includes('lampJunction'));
  assert.ok(levelSrc.includes('trolley') && levelSrc.includes('beaconMast') && levelSrc.includes('mountStem'));
  assert.ok(levelSrc.includes('evacPad') && levelSrc.includes('1.78') && levelSrc.includes('3.78'));

  // Aerial collision & nav grid plumbing
  assert.ok(levelSrc.includes('aerialBoxes') && levelSrc.includes('aerialNavGrid') && levelSrc.includes('setExtremeAerialEnabled'));
  assert.ok(levelSrc.includes('warehouseBox') && levelSrc.includes('findSafeAerialSpawn'));

  // Training Stage 3 & patrol/sniper/endless spawn fixes
  assert.equal(logicSrc.includes('[15.0, 7.0, 4.0]'), false, 'Stage 3 drone spawn must not sit inside gantry bay');
  assert.ok(logicSrc.includes('[15.2, 7.2, 15.0]'));
  assert.ok(enemySrc.includes('_computeAerialNavSteer') && enemySrc.includes('resolveAerial') && enemySrc.includes('getAerialFloor'));
  assert.ok(enemySrc.includes('(-17.5, 6.0, 3.5)') && enemySrc.includes('(5.5, 6.4, -6.5)') && enemySrc.includes('(22.5, 10.4, 4.5)'));

  // App LOS breaker check & recon/endless safe aerial spawns
  assert.ok(appSrc.includes('hasLineOfSight(interactEye, br.pos)'));
  assert.ok(appSrc.includes('findSafeAerialSpawn'));
  assert.ok(appSrc.includes('[11.5, 6.8, -7.5]'));
});

test('computePlayerHitbox & segmentHitsCapsule defend against fast-bolt tunneling across stances', () => {
  const standHb = GameLogic.computePlayerHitbox({ pos: { x: 4, y: 0, z: -6 }, curEye: 1.68, crouching: false, sliding: false });
  const crouchHb = GameLogic.computePlayerHitbox({ pos: { x: 4, y: 0, z: -6 }, curEye: 1.08, crouching: true, sliding: false });
  const slideHb = GameLogic.computePlayerHitbox({ pos: { x: 4, y: 0, z: -6 }, curEye: 0.86, crouching: false, sliding: true });
  assert.ok(crouchHb.top.y < standHb.top.y && slideHb.top.y < crouchHb.top.y, 'Stance height should shrink stand -> crouch -> slide');
  assert.ok(slideHb.radius < standHb.radius && crouchHb.radius < standHb.radius);

  const leanRight = GameLogic.computePlayerHitbox({
    pos: { x: 4, y: 0, z: -6 },
    curEye: 1.68,
    leanDir: 1,
    rightX: 1,
    rightZ: 0,
  });
  assert.ok(Math.abs(leanRight.center.x - 4.44) < 0.01, 'Lean should offset hitbox center laterally');

  // 110 m/s sniper bolt over 0.05s step travels 5.5m (from z=-8.75 to z=-3.25) straight through standHb (z=-6)
  assert.equal(
    GameLogic.segmentHitsCapsule({ x: 4, y: 1.2, z: -8.75 }, { x: 4, y: 1.2, z: -3.25 }, standHb.bottom, standHb.top, standHb.radius),
    true,
    'Fast 110 m/s sniper sweep segment must hit standing capsule without tunneling'
  );
  // Headshot-height bolt (y=1.65) should miss crouched & sliding capsules!
  assert.equal(
    GameLogic.segmentHitsCapsule({ x: 4, y: 1.65, z: -8.75 }, { x: 4, y: 1.65, z: -3.25 }, standHb.bottom, standHb.top, standHb.radius),
    true
  );
  assert.equal(
    GameLogic.segmentHitsCapsule({ x: 4, y: 1.65, z: -8.75 }, { x: 4, y: 1.65, z: -3.25 }, crouchHb.bottom, crouchHb.top, crouchHb.radius),
    false,
    'Crouching should duck under high head-level shots'
  );
  assert.equal(
    GameLogic.segmentHitsCapsule({ x: 4, y: 1.65, z: -8.75 }, { x: 4, y: 1.65, z: -3.25 }, slideHb.bottom, slideHb.top, slideHb.radius),
    false
  );
});

test('computeExplosionFalloff occluded attenuation & spatial/stealth/settings helpers', () => {
  assert.equal(GameLogic.computeExplosionFalloff(0, 8, 120, false), 120);
  assert.equal(GameLogic.computeExplosionFalloff(0, 8, 120, true), 36, 'Cover occlusion should reduce explosion damage to 30%');
  assert.equal(GameLogic.computeExplosionFalloff(7.99, 8, 10, true), 1, 'Occluded hits inside radius floor at 1');
  assert.equal(GameLogic.computeExplosionFalloff(8.5, 8, 120, true), 0);

  // Spatial audio L/R pan & rear lowpass filter (yaw=0 -> looking toward -Z, right is +X, behind is +Z)
  const rightSrc = GameLogic.computeSpatialAudioParams({ x: 0, y: 0, z: 0 }, 0, { x: 10, y: 0, z: 0 }, 60);
  const leftSrc = GameLogic.computeSpatialAudioParams({ x: 0, y: 0, z: 0 }, 0, { x: -10, y: 0, z: 0 }, 60);
  const frontSrc = GameLogic.computeSpatialAudioParams({ x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0, z: -10 }, 60);
  const rearSrc = GameLogic.computeSpatialAudioParams({ x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0, z: 10 }, 60);
  assert.ok(rightSrc.pan > 0.85 && leftSrc.pan < -0.85);
  assert.equal(frontSrc.lpFreq, 20000);
  assert.equal(rearSrc.lpFreq, 2600);

  // Suppressed gunshot alert gradient
  assert.equal(GameLogic.classifySoundAlert(3.2, 11, true, true), 'COMBAT');
  assert.equal(GameLogic.classifySoundAlert(6.5, 11, true, true), 'SUSPICIOUS');
  assert.equal(GameLogic.classifySoundAlert(12.5, 11, true, true), 'NONE');
  assert.equal(GameLogic.classifySoundAlert(10.0, 40, true, false), 'COMBAT');
  assert.equal(GameLogic.classifySoundAlert(35.0, 40, true, false), 'SUSPICIOUS');
  assert.equal(GameLogic.classifySoundAlert(4.0, 22, false, false), 'SUSPICIOUS');

  // Persistent user settings sanitizer
  const clean = GameLogic.sanitizeUserSettings({
    sensitivity: 9.9,
    volume: -0.5,
    voiceVolume: 2.0,
    voiceMode: 'bogus',
    toggleAds: 1,
    invertY: 'yes',
  });
  assert.deepEqual({ ...clean }, {
    sensitivity: 2.5,
    volume: 0,
    voiceVolume: 1,
    voiceMode: 'radio',
    voiceLang: 'auto',
    toggleAds: true,
    invertY: true,
  });
});

test('quality polish & QoL static contracts in index.html, src/app.js, and src/enemy.js', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(rootDir, 'src', 'app.js'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(rootDir, 'src', 'i18n.js'), 'utf8');
  const enemySrc = fs.readFileSync(path.join(rootDir, 'src', 'enemy.js'), 'utf8');

  // HTML QoL & copy fixes
  assert.ok(html.includes('.hitmarker.blocked'));
  assert.ok(html.includes('id="perk-strip"') && html.includes('#perk-strip[hidden]'));
  assert.ok(html.includes('id="kill-feed"') && html.includes('#hud[data-realism="true"] #kill-feed'));
  assert.ok(html.includes('id="opt-toggle-ads"') && html.includes('id="opt-invert-y"'));
  assert.ok(html.includes('2.3x 暴击') && !html.includes('2.4x 暴击'));
  assert.ok(html.includes('id="ammo-res">/ 180'));
  assert.ok(html.includes('低于 55 FPS'));

  // app.js fixes & QoL hooks
  assert.ok(appSrc.includes('storm_pier_settings_v1'));
  assert.ok(appSrc.includes("dataset.action = 'restart-combat'"));
  assert.ok(appSrc.includes('this.audio.updateListener') && appSrc.includes('this.weapon.updateThrowPreview'));
  assert.ok(appSrc.includes('playTinnitusFlash'));
  assert.ok(!appSrc.includes('注意蓝色激光线') && !i18nSrc.includes('注意蓝色激光线'), 'Sniper laser warning must reference red laser, not blue');
  assert.ok(appSrc.includes('app.radio.sniperWarn') && i18nSrc.includes('小心高处红线激光锁定'));

  // Ensure weapon.onBreakerHit does NOT re-call this.level.triggerBreaker
  const breakerHookMatch = appSrc.match(/this\.weapon\.onBreakerHit\s*=\s*\(breaker\)\s*=>\s*\{[\s\S]*?\n\s*\};/);
  assert.ok(breakerHookMatch, 'Expected weapon.onBreakerHit handler in src/app.js');
  assert.equal(breakerHookMatch[0].includes('triggerBreaker'), false, 'onBreakerHit must not double-call level.triggerBreaker');

  // Ensure __GAME_DEBUG__.getState does not have duplicate `difficulty:` keys
  const getStateMatch = appSrc.match(/getState\(\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(getStateMatch, 'Expected __GAME_DEBUG__.getState object literal');
  const diffKeys = getStateMatch[1].match(/^\s*difficulty:/gm) || [];
  assert.equal(diffKeys.length, 1, `Expected single difficulty key in getState(), found ${diffKeys.length}`);

  // enemy.js hitbox field alignment & dying/compaction lifecycle
  assert.ok(enemySrc.includes('playerController.crouching') && enemySrc.includes('playerController.leanDir'));
  assert.ok(enemySrc.includes('GameLogic.computePlayerHitbox(_hbArg)') && enemySrc.includes('GameLogic.segmentHitsCapsule'));
  assert.ok(enemySrc.includes('updateDying') && enemySrc.includes('disposeVisuals'));
});

test('bakeRainOcclusionHeightmap & sampleRainOcclusionHeight filter dynamic/thin/disabled boxes accurately', () => {
  assert.deepEqual({ ...GameLogic.RAIN_OCCLUSION_BOUNDS }, {
    minX: -55,
    maxX: 55,
    minZ: -45,
    maxZ: 45,
    maxHeight: 24,
  });

  const boxes = [
    // Warehouse sloped roof boxes (matches src/level.js)
    { minX: -22.4, maxX: -1.6, minY: 6.35, maxY: 6.95, minZ: -32.3, maxZ: -13.7, disabled: false, isDynamic: false },
    { minX: -18.5, maxX: -5.5, minY: 6.85, maxY: 7.40, minZ: -32.3, maxZ: -13.7, disabled: false, isDynamic: false },
    { minX: -15.0, maxX: -9.0, minY: 7.30, maxY: 7.82, minZ: -32.3, maxZ: -13.7, disabled: false, isDynamic: false },
    // Walk-through / ground container roof
    { minX: 2.5, maxX: 8.5, minY: 0, maxY: 2.6, minZ: -10.75, maxZ: -8.25, disabled: false, isDynamic: false },
    // Thin pole (< 0.75m in both X and Z) -> must NOT occlude rain
    { minX: 20.0, maxX: 20.48, minY: 0, maxY: 7.7, minZ: 20.0, maxZ: 20.48, disabled: false, isDynamic: false },
    // Low crate (< 1.5m) -> must NOT occlude rain
    { minX: 22.0, maxX: 23.6, minY: 0, maxY: 1.3, minZ: 22.0, maxZ: 23.6, disabled: false, isDynamic: false },
    // Disabled box -> must NOT occlude rain
    { minX: 25.0, maxX: 28.0, minY: 0, maxY: 3.5, minZ: 20.0, maxZ: 23.0, disabled: true, isDynamic: false },
    // Dynamic explosive barrel (isDynamic: true, even with maxY >= 1.5) -> must NOT occlude rain
    { minX: 2.3, maxX: 3.3, minY: 0, maxY: 1.65, minZ: 10.7, maxZ: 11.7, disabled: false, isDynamic: true },
  ];

  const occMap = GameLogic.bakeRainOcclusionHeightmap(boxes, { width: 256, height: 256 });
  assert.equal(occMap.width, 256);
  assert.equal(occMap.height, 256);
  assert.ok(ArrayBuffer.isView(occMap.heights) && occMap.heights.constructor.name === 'Uint8Array');
  assert.equal(occMap.heights.length, 256 * 256);

  // Open ground
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 0, 0), 0);
  // Warehouse roof (center ridge & outer slope)
  assert.ok(GameLogic.sampleRainOcclusionHeight(occMap, -12, -22) >= 7.7, 'Warehouse center roof should be >= 7.7m');
  assert.ok(GameLogic.sampleRainOcclusionHeight(occMap, -21, -22) >= 6.9, 'Warehouse side roof should be >= 6.9m');
  // Walk-through container roof
  assert.ok(GameLogic.sampleRainOcclusionHeight(occMap, 5.5, -9.5) >= 2.5, 'Container roof should be >= 2.5m');
  // Excluded objects: thin pole, low crate, disabled box, dynamic barrel
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 20.24, 20.24), 0, 'Thin pole should not occlude');
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 22.8, 22.8), 0, 'Low crate (<1.5m) should not occlude');
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 26.5, 21.5), 0, 'Disabled box should not occlude');
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 2.8, 11.2), 0, 'Dynamic barrel should not occlude');
  // Out of bounds
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, -60, 0), 0);
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 60, 0), 0);
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 0, -50), 0);
  assert.equal(GameLogic.sampleRainOcclusionHeight(occMap, 0, 50), 0);
  assert.equal(GameLogic.sampleRainOcclusionHeight(null, 0, 0), 0);
});

test('getRainQualityProfile returns expected budgets and falls back to high', () => {
  assert.deepEqual({ ...GameLogic.getRainQualityProfile('low') }, {
    rainCount: 1000,
    splashCount: 48,
    rippleLayers: 1,
    lensRainTarget: 0.0,
    fullLighting: false,
  });
  assert.deepEqual({ ...GameLogic.getRainQualityProfile('medium') }, {
    rainCount: 2200,
    splashCount: 96,
    rippleLayers: 2,
    lensRainTarget: 0.55,
    fullLighting: false,
  });
  assert.deepEqual({ ...GameLogic.getRainQualityProfile('high') }, {
    rainCount: 3800,
    splashCount: 150,
    rippleLayers: 2,
    lensRainTarget: 0.90,
    fullLighting: true,
  });
  assert.deepEqual({ ...GameLogic.getRainQualityProfile('extreme') }, {
    rainCount: 5600,
    splashCount: 220,
    rippleLayers: 3,
    lensRainTarget: 0.95,
    fullLighting: true,
  });
  const fallback = GameLogic.getRainQualityProfile('unknown_preset');
  assert.deepEqual({ ...fallback }, { ...GameLogic.getRainQualityProfile('high') });
  fallback.rainCount = 1;
  assert.equal(GameLogic.getRainQualityProfile('high').rainCount, 3800, 'Returned profile must not alias internal table');
});

test('rain upgrade static contracts across level.js, app.js, render.js, and extreme_gfx.js', () => {
  const levelSrc = fs.readFileSync(path.join(rootDir, 'src', 'level.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(rootDir, 'src', 'app.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(rootDir, 'src', 'render.js'), 'utf8');
  const extremeSrc = fs.readFileSync(path.join(rootDir, 'src', 'extreme_gfx.js'), 'utf8');

  // level.js: barrel isDynamic + baked rainOcclusionMap
  assert.ok(levelSrc.includes('isDynamic: !!(opts && opts.isDynamic)'));
  assert.ok(levelSrc.includes('{ isDynamic: true }'));
  assert.ok(levelSrc.includes('this.rainOcclusionMap') && levelSrc.includes('bakeRainOcclusionHeightmap'));

  // app.js: wires level.rainOcclusionMap to render
  assert.ok(appSrc.includes('setRainOcclusionMap(this.level.rainOcclusionMap)'));

  // render.js: legacy RingGeometry/LineSegments rain removed, GPU instanced rain + splash + occlusion + lens rain present
  assert.equal(renderSrc.includes('RingGeometry(0.06, 0.1, 12)'), false, 'Legacy RingGeometry splash ring must be removed');
  assert.equal(renderSrc.includes('LineSegments(geo, this.rainMat)'), false, 'Legacy LineSegments rain must be removed');
  assert.equal(/\bnew THREE\.LineSegments\b/.test(renderSrc), false, 'render.js should not instantiate THREE.LineSegments for rain');
  for (const sym of [
    'setRainOcclusionMap',
    'tRainOcclusion',
    'uRainOccBounds',
    'uRainOccMaxH',
    'uRippleLayers',
    'InstancedBufferGeometry',
    'this.rainMat',
    'this.splashMat',
    'uFullLighting',
    'computeRainRipples',
    'computeLensRain',
    'sampleRainOcclusionHeight',
    'getRainQualityProfile',
  ]) {
    assert.ok(renderSrc.includes(sym), `Missing rain contract symbol '${sym}' in src/render.js`);
  }

  // extreme_gfx.js: occlusion uniforms, seamless 2x2 ripples, GLSL3 computeLensRain
  for (const sym of [
    'setRainOcclusionMap',
    'uExtRainOccMap',
    'uExtRainOccBounds',
    'uExtRainOccMaxH',
    'extRainRipples',
    'computeLensRain',
  ]) {
    assert.ok(extremeSrc.includes(sym), `Missing rain contract symbol '${sym}' in src/extreme_gfx.js`);
  }
  const opticsMatch = extremeSrc.match(/this\.opticsAgxMat\s*=\s*new THREE\.ShaderMaterial\(\{[\s\S]*?\n\s*\}\);/);
  assert.ok(opticsMatch, 'Expected opticsAgxMat ShaderMaterial in src/extreme_gfx.js');
  assert.ok(opticsMatch[0].includes('glslVersion: THREE.GLSL3'), 'opticsAgxMat must use GLSL3');
  assert.equal(opticsMatch[0].includes('texture2D('), false, 'GLSL3 opticsAgxMat must not use texture2D()');
});

test('level geometry zero-overlap invariants for floor, pier, curbs, wallSpecs, and gable base', () => {
  const levelSrc = fs.readFileSync(path.join(rootDir, 'src', 'level.js'), 'utf8');

  // Static removal / addition contracts for pier & gable Z-fighting fix
  assert.equal(levelSrc.includes('BoxGeometry(12, 1.5, 18)'), false, 'Old overlapping pier BoxGeometry(12, 1.5, 18) must be removed');
  assert.equal(levelSrc.includes('pier.position.set(20, -0.75, -25)'), false, 'Old overlapping pier position (20, -0.75, -25) must be removed');
  assert.ok(levelSrc.includes('BoxGeometry(3, 1.5, 18)'), 'Pier must use BoxGeometry(3, 1.5, 18)');
  assert.ok(levelSrc.includes('pier.position.set(24.5, -0.75, -25)'), 'Pier must sit at (24.5, -0.75, -25)');
  assert.ok(levelSrc.includes('pierGeo.attributes.uv'), 'Pier UVs must be rescaled via pierGeo.attributes.uv');
  assert.ok(levelSrc.includes('1.5 / 18') && levelSrc.includes('3 / 18') && levelSrc.includes('needsUpdate = true'));
  assert.ok(levelSrc.includes('gableShape.moveTo(-10.0, 6.50)'), 'Gable base must start at y=6.50 flush with wall tops');
  assert.equal(levelSrc.includes('6.32'), false, 'Old overlapping gable base y=6.32 must be removed');

  function boxFromCenterSize(x, y, z, w, h, d) {
    return {
      minX: x - w * 0.5, maxX: x + w * 0.5,
      minY: y - h * 0.5, maxY: y + h * 0.5,
      minZ: z - d * 0.5, maxZ: z + d * 0.5,
    };
  }

  function overlapVolume3D(a, b) {
    const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
    const oy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    const oz = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
    return ox * oy * oz;
  }

  // Parse floor BoxGeometry & position
  const floorMatch = levelSrc.match(/const floor = new THREE\.Mesh\(\s*new THREE\.BoxGeometry\(([^)]+)\),\s*[\s\S]*?floor\.position\.set\(([^)]+)\)/);
  assert.ok(floorMatch, 'Expected floor BoxGeometry & position in src/level.js');
  const [fw, fh, fd] = floorMatch[1].split(',').map((s) => Number(s.trim()));
  const [fx, fy, fz] = floorMatch[2].split(',').map((s) => Number(s.trim()));
  const floorBox = boxFromCenterSize(fx, fy, fz, fw, fh, fd);
  assert.deepEqual(floorBox, { minX: -43, maxX: 23, minY: -1.5, maxY: 0, minZ: -35, maxZ: 35 });

  // Parse pier BoxGeometry & position
  const pierMatch = levelSrc.match(/const pierGeo = new THREE\.BoxGeometry\(([^)]+)\);[\s\S]*?pier\.position\.set\(([^)]+)\)/);
  assert.ok(pierMatch, 'Expected pierGeo BoxGeometry & pier.position.set in src/level.js');
  const [pw, ph, pd] = pierMatch[1].split(',').map((s) => Number(s.trim()));
  const [px, py, pz] = pierMatch[2].split(',').map((s) => Number(s.trim()));
  const pierBox = boxFromCenterSize(px, py, pz, pw, ph, pd);
  assert.deepEqual(pierBox, { minX: 23, maxX: 26, minY: -1.5, maxY: 0, minZ: -34, maxZ: -16 });

  // Floor & pier must have zero 3D overlap volume
  assert.equal(overlapVolume3D(floorBox, pierBox), 0, 'Main dock floor and pier must have zero 3D overlap volume');

  // Parse curbs & verify all pairs have zero 3D overlap volume
  const curbsMatch = levelSrc.match(/const curbs = (\[[\s\S]*?\]);/);
  assert.ok(curbsMatch, 'Expected curbs array in src/level.js');
  const curbs = vm.runInNewContext(curbsMatch[1], {});
  assert.equal(curbs.length, 4);
  const curbBoxes = curbs.map(([x, y, z, w, h, d]) => boxFromCenterSize(x, y, z, w, h, d));
  for (let i = 0; i < curbBoxes.length; i++) {
    for (let j = i + 1; j < curbBoxes.length; j++) {
      const vol = overlapVolume3D(curbBoxes[i], curbBoxes[j]);
      assert.ok(vol < 1e-9, `Curb pair (${i}, ${j}) overlaps with volume ${vol}`);
    }
  }

  // Parse wallSpecs & verify all pairs have zero 3D overlap volume
  const wallMatch = levelSrc.match(/const wallSpecs = (\[[\s\S]*?\]);/);
  assert.ok(wallMatch, 'Expected wallSpecs array in src/level.js');
  const wallSpecs = vm.runInNewContext(wallMatch[1], {});
  assert.equal(wallSpecs.length, 8);
  const wallBoxes = wallSpecs.map(([x, y, z, w, h, d]) => boxFromCenterSize(x, y, z, w, h, d));
  for (let i = 0; i < wallBoxes.length; i++) {
    assert.ok(wallBoxes[i].maxY <= 6.5 + 1e-9, `Wall ${i} exceeds gable base y=6.50`);
    for (let j = i + 1; j < wallBoxes.length; j++) {
      const vol = overlapVolume3D(wallBoxes[i], wallBoxes[j]);
      assert.ok(vol < 1e-9, `Wall pair (${i}, ${j}) overlaps with volume ${vol}`);
    }
  }
});

test('voice_manifest.json v2 contains complete ZH & EN role and clip metadata across all 50 clips', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'voices', 'voice_manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.ok(Array.isArray(manifest.clips) && manifest.clips.length === 50, 'Expected 50 manifest clips');

  const expectedRoles = {
    instructor: 'INSTRUCTOR',
    watcher: 'OVERWATCH // CH-04',
    evac: 'EVAC-01',
  };
  for (const [roleId, enLabel] of Object.entries(expectedRoles)) {
    const r = manifest.roles && manifest.roles[roleId];
    assert.ok(r, `Missing role '${roleId}' in manifest`);
    for (const field of ['speakerLabel', 'speakerLabelEn', 'edgeVoice', 'rate', 'pitch', 'edgeVoiceEn', 'rateEn', 'pitchEn']) {
      assert.ok(typeof r[field] === 'string' && r[field].trim().length > 0, `Missing role.${roleId}.${field}`);
    }
    assert.equal(r.speakerLabelEn, enLabel);
    assert.ok(typeof r.speechPitch === 'number' && typeof r.speechRate === 'number');
  }

  const seenIds = new Set();
  for (const clip of manifest.clips) {
    assert.ok(typeof clip.id === 'string' && clip.id.length > 0);
    assert.equal(seenIds.has(clip.id), false, `Duplicate clip id '${clip.id}'`);
    seenIds.add(clip.id);
    assert.ok(manifest.roles[clip.role], `Unknown role '${clip.role}' on clip '${clip.id}'`);
    assert.ok(typeof clip.priority === 'number' && typeof clip.cooldownSec === 'number');
    for (const field of ['displayText', 'ttsText', 'displayTextEn', 'ttsTextEn']) {
      assert.ok(typeof clip[field] === 'string' && clip[field].trim().length > 0, `Missing ${field} on clip '${clip.id}'`);
    }
  }
});

test('dual voice packs (zh & en) expose window.__VOICE_PACKS__ with 50 valid base64 clips and bilingual labels', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'voices', 'voice_manifest.json'), 'utf8'));
  const zhSrc = fs.readFileSync(path.join(rootDir, 'voices', 'voice_pack.js'), 'utf8');
  const enSrc = fs.readFileSync(path.join(rootDir, 'voices', 'voice_pack_en.js'), 'utf8');

  const packBox = { window: {} };
  vm.createContext(packBox);
  vm.runInContext(zhSrc, packBox);
  vm.runInContext(enSrc, packBox);

  const packs = packBox.window.__VOICE_PACKS__;
  assert.ok(packs && packs.zh && packs.en, 'Expected window.__VOICE_PACKS__.zh and .en');
  assert.equal(packBox.window.__VOICE_PACK__, packs.zh, 'window.__VOICE_PACK__ must alias window.__VOICE_PACKS__.zh');

  for (const [lang, pack] of [['zh', packs.zh], ['en', packs.en]]) {
    assert.ok(pack.roles && pack.clips, `Invalid pack structure for ${lang}`);
    for (const roleId of Object.keys(manifest.roles)) {
      const r = pack.roles[roleId];
      assert.ok(r, `Missing role '${roleId}' in ${lang} pack`);
      assert.equal(r.speakerLabel, manifest.roles[roleId].speakerLabel);
      assert.equal(r.speakerLabelEn, manifest.roles[roleId].speakerLabelEn);
    }
    assert.equal(Object.keys(pack.clips).length, 50, `Expected 50 clips in ${lang} pack`);
    for (const clip of manifest.clips) {
      const entry = pack.clips[clip.id];
      assert.ok(entry, `Missing clip '${clip.id}' in ${lang} pack`);
      assert.equal(entry.role, clip.role);
      assert.equal(entry.displayText, clip.displayText);
      assert.equal(entry.displayTextEn, clip.displayTextEn);
      assert.ok(typeof entry.mime === 'string' && entry.mime.startsWith('audio/'));
      assert.ok(typeof entry.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(entry.data), `Invalid base64 data for ${lang}:${clip.id}`);
      const rawBytes = Buffer.from(entry.data, 'base64');
      assert.ok(rawBytes.length > 200, `Audio payload too small for ${lang}:${clip.id}`);
    }
  }
});

test('src/i18n.js dictionary parity, placeholder matching, and HTML/JS key resolution', () => {
  const i18nSrc = fs.readFileSync(path.join(rootDir, 'src', 'i18n.js'), 'utf8');
  const i18nBox = { window: {} };
  vm.createContext(i18nBox);
  vm.runInContext(i18nSrc, i18nBox);
  const I18n = i18nBox.window.I18n;
  assert.ok(I18n && I18n.DICT && I18n.DICT.zh && I18n.DICT.en, 'Expected I18n.DICT.zh and .en');

  const zhKeys = Object.keys(I18n.DICT.zh).sort();
  const enKeys = Object.keys(I18n.DICT.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'DICT.zh and DICT.en must have identical key sets');
  assert.ok(zhKeys.length >= 140, `Expected rich i18n dictionary, got ${zhKeys.length} keys`);

  const extractTokens = (str) => [...String(str).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
  for (const key of zhKeys) {
    assert.ok(typeof I18n.DICT.zh[key] === 'string' && I18n.DICT.zh[key].length > 0, `Empty DICT.zh['${key}']`);
    assert.ok(typeof I18n.DICT.en[key] === 'string' && I18n.DICT.en[key].length > 0, `Empty DICT.en['${key}']`);
    assert.deepEqual(extractTokens(I18n.DICT.zh[key]), extractTokens(I18n.DICT.en[key]), `Placeholder mismatch on i18n key '${key}'`);
  }

  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const htmlKeys = [...html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(htmlKeys.length >= 100, 'Expected data-i18n* bindings in index.html');
  for (const key of htmlKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(I18n.DICT.zh, key), `Missing HTML i18n key '${key}' in DICT.zh`);
    assert.ok(Object.prototype.hasOwnProperty.call(I18n.DICT.en, key), `Missing HTML i18n key '${key}' in DICT.en`);
  }

  const jsFiles = fs.readdirSync(path.join(rootDir, 'src')).filter((f) => f.endsWith('.js') && f !== 'three.bundle.js' && f !== 'i18n.js');
  let jsKeyCount = 0;
  for (const file of jsFiles) {
    const src = fs.readFileSync(path.join(rootDir, 'src', file), 'utf8');
    for (const m of src.matchAll(/\bI18n\.t\(\s*(['"])([^'"]+)\1/g)) {
      const key = m[2];
      jsKeyCount++;
      assert.ok(Object.prototype.hasOwnProperty.call(I18n.DICT.zh, key), `Missing JS i18n key '${key}' (${file}) in DICT.zh`);
      assert.ok(Object.prototype.hasOwnProperty.call(I18n.DICT.en, key), `Missing JS i18n key '${key}' (${file}) in DICT.en`);
    }
  }
  assert.ok(jsKeyCount >= 200, `Expected static I18n.t calls across src/*.js, got ${jsKeyCount}`);

  I18n.setLang('en', false);
  assert.equal(I18n.getLang(), 'en');
  assert.equal(I18n.resolveVoiceLang('auto'), 'en');
  assert.equal(I18n.resolveVoiceLang('zh'), 'zh');
  assert.equal(I18n.field({ name: '中文', nameEn: 'English' }, 'name'), 'English');
});

test('all GameLogic catalogs and MEDAL_CATALOG include non-empty English fields and bilingual rating/record IDs', () => {
  for (const w of Object.values(GameLogic.WEAPON_CATALOG)) {
    for (const f of ['nameEn', 'shortNameEn', 'descEn']) {
      assert.ok(typeof w[f] === 'string' && w[f].trim().length > 0, `Missing WEAPON_CATALOG.${w.id}.${f}`);
    }
  }
  for (const t of Object.values(GameLogic.THROWABLE_CATALOG)) {
    for (const f of ['nameEn', 'shortNameEn']) {
      assert.ok(typeof t[f] === 'string' && t[f].trim().length > 0, `Missing THROWABLE_CATALOG.${t.id}.${f}`);
    }
  }
  assert.deepEqual(
    ['recruit', 'standard', 'veteran', 'realism'].map((id) => GameLogic.DIFFICULTIES[id].nameEn),
    ['Recruit', 'Standard', 'Veteran', 'Realism']
  );
  for (const d of Object.values(GameLogic.DIFFICULTIES)) {
    for (const f of ['nameEn', 'badgeEn', 'summaryEn']) {
      assert.ok(typeof d[f] === 'string' && d[f].trim().length > 0, `Missing DIFFICULTIES.${d.id}.${f}`);
    }
  }
  for (const m of Object.values(GameLogic.MUTATORS)) {
    for (const f of ['nameEn', 'descEn']) {
      assert.ok(typeof m[f] === 'string' && m[f].trim().length > 0, `Missing MUTATORS.${m.id}.${f}`);
    }
  }
  for (const s of Object.values(GameLogic.GUN_SKINS)) {
    for (const f of ['nameEn', 'unlockDescEn']) {
      assert.ok(typeof s[f] === 'string' && s[f].trim().length > 0, `Missing GUN_SKINS.${s.id}.${f}`);
    }
  }
  for (const p of GameLogic.AIRDROP_PERKS) {
    for (const f of ['nameEn', 'shortTagEn', 'descEn']) {
      assert.ok(typeof p[f] === 'string' && p[f].trim().length > 0, `Missing AIRDROP_PERKS.${p.id}.${f}`);
    }
  }
  for (const st of GameLogic.TRAINING_STAGES) {
    for (const f of ['nameEn', 'shortNameEn']) {
      assert.ok(typeof st[f] === 'string' && st[f].trim().length > 0, `Missing TRAINING_STAGES[${st.id}].${f}`);
    }
  }

  const expectedMedalIds = ['ghost_of_storm', 'untouchable', 'demo_expert', 'speedrun', 'sharpshooter', 'shadow_blade'];
  assert.deepEqual(Object.keys(GameLogic.MEDAL_CATALOG), expectedMedalIds);
  for (const id of expectedMedalIds) {
    const medal = GameLogic.MEDAL_CATALOG[id];
    assert.ok(medal && medal.id === id && medal.name && medal.nameEn, `Invalid MEDAL_CATALOG.${id}`);
  }

  const rating = GameLogic.computeMissionRating({
    elapsedSec: 150, kills: 12, shotsFired: 20, shotsHit: 18, crits: 7,
    alarmsTriggered: 0, damageTaken: 0, barrelKills: 2, meleeKills: 2,
  });
  assert.deepEqual(Array.from(rating.medalIds), expectedMedalIds);
  const ghostCareer = GameLogic.updateCareerRecords(null, {
    victory: true, grade: 'A', score: 4000, elapsedSec: 150, medalIds: ['ghost_of_storm'],
  });
  assert.equal(ghostCareer.nextProfile.ghostClears, 1);

  const recTimed = GameLogic.updateTrainingRecords(null, 'timed', { duration: 60, score: 500, kills: 5 });
  assert.deepEqual(Array.from(recTimed.noteIds), ['best_score']);
  const recStage = GameLogic.updateTrainingRecords(null, 'stage', { stageId: 1, cleared: true, time: 40 });
  assert.ok(recStage.noteIds.includes('best_time') && recStage.noteIds.includes('first_clear'));
});

test('sanitizeUserSettings validates voiceLang and computeWatchdogTimeoutMs scales EN vs ZH within bounds', () => {
  assert.equal(GameLogic.sanitizeUserSettings(null).voiceLang, 'auto');
  assert.equal(GameLogic.sanitizeUserSettings({ voiceLang: 'zh' }).voiceLang, 'zh');
  assert.equal(GameLogic.sanitizeUserSettings({ voiceLang: 'en' }).voiceLang, 'en');
  assert.equal(GameLogic.sanitizeUserSettings({ voiceLang: 'jp' }).voiceLang, 'auto');

  assert.equal(GameLogic.computeWatchdogTimeoutMs('', 'en'), 4000);
  assert.equal(GameLogic.computeWatchdogTimeoutMs('OK', 'en'), 4000);
  assert.equal(GameLogic.computeWatchdogTimeoutMs('收到', 'zh'), 4000);

  const enSample = 'Overwatch copy. Move to Pier 04 and breach Relay A.'; // 50 chars -> 50*85+2500 = 6750
  const zhSample = '守望者收到，前往零四号码头突入并破解中继器甲。'; // 23 chars -> 23*290+2500 = 9170
  const enMs = GameLogic.computeWatchdogTimeoutMs(enSample, 'en');
  const enAutoMs = GameLogic.computeWatchdogTimeoutMs(enSample);
  const zhMs = GameLogic.computeWatchdogTimeoutMs(zhSample, 'zh');
  assert.equal(enMs, enSample.length * 85 + 2500);
  assert.equal(enAutoMs, enMs);
  assert.equal(zhMs, zhSample.length * 290 + 2500);
  assert.ok(enMs >= 4000 && enMs <= 22000 && zhMs >= 4000 && zhMs <= 22000);
  assert.equal(GameLogic.computeWatchdogTimeoutMs('A'.repeat(400), 'en'), 22000);
  assert.equal(GameLogic.computeWatchdogTimeoutMs('测'.repeat(300), 'zh'), 22000);
});

test('HTML shell loads src/i18n.js classically with #lang-switch & #opt-voice-lang and lazy-loads voice packs', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  assert.equal(/<script[^>]+type=["']module["']/i.test(html), false, 'Must preserve classic scripts');
  const i18nScriptIdx = html.indexOf('src="src/i18n.js"');
  const voiceLogicScriptIdx = html.indexOf('src="src/voice_logic.js"');
  assert.ok(i18nScriptIdx !== -1 && voiceLogicScriptIdx !== -1 && i18nScriptIdx < voiceLogicScriptIdx, 'src/i18n.js must load before src/voice_logic.js');
  assert.ok(html.includes('id="lang-switch"') && html.includes('data-lang="zh"') && html.includes('data-lang="en"'));
  assert.ok(html.includes('id="opt-voice-lang"') && html.includes('value="auto"'));
  assert.equal(/<script\b[^>]*\bsrc=["']voices\/voice_pack(?:_en)?\.js["']/i.test(html), false, 'Must NOT statically eager-load voice_pack*.js in index.html');

  // Verify VoiceEngine lazy-load & dual-lang cache/label APIs
  const appended = [];
  const veBox = {
    performance: { now: () => 1000 },
    setTimeout,
    clearTimeout,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    document: {
      head: { appendChild: (el) => appended.push(el) },
      createElement: (tag) => ({ tagName: tag.toUpperCase(), src: '', async: false, onload: null, onerror: null }),
    },
    window: null,
  };
  veBox.window = veBox;
  vm.createContext(veBox);
  vm.runInContext(logicSrc, veBox);
  const VoiceEngine = vm.runInContext('VoiceEngine', veBox);
  const ve = new VoiceEngine({ voiceMode: 'radio', voiceVolume: 0.85, volume: 0.72, setVoiceDucking() {}, playRadioPTT() {}, startRadioCarrier() {}, stopRadioCarrier() {} });
  assert.equal(ve.voiceLang, 'zh');
  assert.equal(ve.getRoleLabel('instructor', 'en'), 'INSTRUCTOR');
  assert.equal(ve.getRoleLabel('watcher', 'en'), 'OVERWATCH // CH-04');
  assert.equal(ve.getRoleLabel('evac', 'en'), 'EVAC-01');
  const p1 = ve.setVoiceLang('en');
  const p2 = ve.ensurePackLoaded('en');
  assert.equal(ve.voiceLang, 'en');
  assert.equal(p1, p2);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, 'voices/voice_pack_en.js');
});

console.log(`ALL LOGIC TESTS PASSED (${passed}/${passed})`);
