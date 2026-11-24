// ============================================================================
// 模块 2：Web Audio API 全程序化实时音效引擎 (AudioEngine)
// 无任何外部音频文件：实时合成暴雨白/粉红噪音（含进出铁皮仓库动态低通闷响）、
// 远雷、步枪枪声、弹壳落地金属声、金属击中火花声、敌人警报与脚步声。
// ============================================================================

const AudioEngine = (() => {
  'use strict';

  class Engine {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.envDuckGain = null;
      this.voiceGain = null;
      this.radioInput = null;
      this.cleanVoiceInput = null;
      this.rainFilter = null;
      this.rainGain = null;
      this.tinRoofGain = null;
      this.noiseBuffer = null;
      this.volume = 0.72;
      this.voiceVolume = 0.85;
      this.voiceMode = 'radio'; // 'radio' | 'clean' | 'off'
      this.muted = false;
      this.indoors = false;
      this.relayBuzz = null;
      this.carrierHiss = null;
      this.healthLpFilter = null;
      this.bgmGain = null;
      this.musicMode = 'off'; // 'off' | 'stealth' | 'combat' | 'holdout'
      this.bgmTimer = 0;
      this.bgmStep = 0;
      this.lowHpFactor = 0;
      this.heartbeatTimer = 0;
      this._listenerPos = { x: 0, y: 1.68, z: 27.5 };
      this._listenerYaw = 0;
      this._thunderTimers = [];
      this._lastTinnitusAt = -10;
    }

    init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;

      this.ctx = new AC();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 18;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;

      this.healthLpFilter = this.ctx.createBiquadFilter();
      this.healthLpFilter.type = 'lowpass';
      this.healthLpFilter.frequency.value = 20000;
      this.healthLpFilter.Q.value = 0.7;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;

      comp.connect(this.healthLpFilter);
      this.healthLpFilter.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
      this.mainBus = comp;

      // 环境暴雨闪避总线（语音播报时自动压低环境噪底与 BGM）
      this.envDuckGain = this.ctx.createGain();
      this.envDuckGain.gain.value = 1.0;
      this.envDuckGain.connect(this.mainBus);

      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = 0.28;
      this.bgmGain.connect(this.envDuckGain);

      // 独立语音与无线电通道（旁路枪声压限器，保持人声清晰通透）
      this.voiceGain = this.ctx.createGain();
      this.voiceGain.gain.value = this._effectiveVoiceGain();
      this.voiceGain.connect(this.ctx.destination);
      this._buildRadioBus();

      this.noiseBuffer = this._buildPinkNoiseBuffer(3.0);
      this._startRainAmbience();
    }

    _effectiveVoiceGain() {
      if (this.muted || this.voiceMode === 'off') return 0;
      return this.volume * this.voiceVolume * 1.15;
    }

    _buildRadioBus() {
      if (!this.ctx || !this.voiceGain) return;
      this.cleanVoiceInput = this.ctx.createGain();
      this.cleanVoiceInput.gain.value = 1.0;
      this.cleanVoiceInput.connect(this.voiceGain);

      // 中度战术无线电滤波链：310Hz~3200Hz 带通 + 1350Hz 人声穿透激励 + 温和削波 + 压限
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 310;
      hp.Q.value = 0.8;

      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      lp.Q.value = 0.85;

      const presence = this.ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 1350;
      presence.Q.value = 1.2;
      presence.gain.value = 4.5;

      const shaper = this.ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i * 2) / 255 - 1;
        curve[i] = Math.tanh(x * 1.65) / Math.tanh(1.65);
      }
      shaper.curve = curve;

      const rComp = this.ctx.createDynamicsCompressor();
      rComp.threshold.value = -16;
      rComp.knee.value = 12;
      rComp.ratio.value = 4;
      rComp.attack.value = 0.004;
      rComp.release.value = 0.14;

      hp.connect(lp);
      lp.connect(presence);
      presence.connect(shaper);
      shaper.connect(rComp);
      rComp.connect(this.voiceGain);
      this.radioInput = hp;
    }

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
      }
      if (this.voiceGain && this.ctx) {
        this.voiceGain.gain.setTargetAtTime(this._effectiveVoiceGain(), this.ctx.currentTime, 0.05);
      }
    }

    setVoiceVolume(v) {
      this.voiceVolume = Math.max(0, Math.min(1, v));
      if (this.voiceGain && this.ctx) {
        this.voiceGain.gain.setTargetAtTime(this._effectiveVoiceGain(), this.ctx.currentTime, 0.05);
      }
    }

    setVoiceMode(mode) {
      this.voiceMode = mode;
      if (this.voiceGain && this.ctx) {
        this.voiceGain.gain.setTargetAtTime(this._effectiveVoiceGain(), this.ctx.currentTime, 0.05);
      }
    }

    setVoiceDucking(active) {
      if (!this.ctx || !this.envDuckGain) return;
      const target = active ? 0.42 : 1.0;
      const tc = active ? 0.08 : 0.26;
      this.envDuckGain.gain.setTargetAtTime(target, this.ctx.currentTime, tc);
    }

    playRadioPTT(isEnd = false) {
      if (!this.ctx || !this.noiseBuffer || this.voiceMode === 'off') return;
      const now = this.ctx.currentTime;
      const click = this.ctx.createOscillator();
      click.type = 'triangle';
      click.frequency.setValueAtTime(isEnd ? 1120 : 1680, now);
      click.frequency.exponentialRampToValueAtTime(isEnd ? 640 : 1240, now + 0.032);
      const cg = this.ctx.createGain();
      const pttDest = this.voiceGain || this.mainBus;
      const gainScale = this.voiceGain ? 1.0 : this.voiceVolume;
      cg.gain.setValueAtTime(0.055 * gainScale, now);
      cg.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      click.connect(cg);
      cg.connect(pttDest);
      click.start(now);
      click.stop(now + 0.045);

      if (this.voiceMode === 'radio') {
        const hiss = this.ctx.createBufferSource();
        hiss.buffer = this.noiseBuffer;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = isEnd ? 1850 : 2100;
        bp.Q.value = 1.6;
        const hg = this.ctx.createGain();
        hg.gain.setValueAtTime(0.06 * gainScale, now);
        hg.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
        hiss.connect(bp);
        bp.connect(hg);
        hg.connect(pttDest);
        hiss.start(now, Math.random() * 1.2);
        hiss.stop(now + 0.06);
      }
    }

    startRadioCarrier() {
      if (!this.ctx || !this.noiseBuffer || this.voiceMode !== 'radio' || this.carrierHiss) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1700;
      bp.Q.value = 1.1;
      const g = this.ctx.createGain();
      g.gain.value = 0.018;
      src.connect(bp);
      bp.connect(g);
      g.connect(this.voiceGain || this.mainBus);
      src.start();
      this.carrierHiss = { src, g };
    }

    stopRadioCarrier() {
      if (!this.carrierHiss) return;
      try {
        this.carrierHiss.src.stop();
        this.carrierHiss.src.disconnect();
      } catch (e) {}
      this.carrierHiss = null;
    }

    setPaused(paused) {
      this.muted = paused;
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(paused ? 0 : this.volume, this.ctx.currentTime, 0.08);
      }
      if (this.voiceGain && this.ctx) {
        this.voiceGain.gain.setTargetAtTime(this._effectiveVoiceGain(), this.ctx.currentTime, 0.05);
      }
      if (paused) {
        this.stopRelayCutLoop();
        this.stopRadioCarrier();
        this.clearScheduledThunder();
      }
    }

    _buildPinkNoiseBuffer(seconds) {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * seconds);
      const buf = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const out = buf.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + w * 0.5362) * 0.11;
        }
      }
      return buf;
    }

    _startRainAmbience() {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;

      this.rainFilter = this.ctx.createBiquadFilter();
      this.rainFilter.type = 'lowpass';
      this.rainFilter.frequency.value = 3400;
      this.rainFilter.Q.value = 0.7;

      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 180;

      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0.34;

      // 仓库铁皮棚顶雨点敲击共振层（进入室内激活）
      const roofBp = this.ctx.createBiquadFilter();
      roofBp.type = 'bandpass';
      roofBp.frequency.value = 540;
      roofBp.Q.value = 2.6;
      this.tinRoofGain = this.ctx.createGain();
      this.tinRoofGain.gain.value = 0.0;

      src.connect(hp);
      hp.connect(this.rainFilter);
      this.rainFilter.connect(this.rainGain);
      this.rainGain.connect(this.envDuckGain || this.mainBus);

      src.connect(roofBp);
      roofBp.connect(this.tinRoofGain);
      this.tinRoofGain.connect(this.envDuckGain || this.mainBus);

      src.start();
    }

    setMusicMode(mode) {
      if (this.musicMode !== mode) {
        this.musicMode = mode;
        this.bgmStep = 0;
        this.bgmTimer = 0;
      }
    }

    setLowHpFactor(factor) {
      this.lowHpFactor = Math.max(0, Math.min(1, factor || 0));
      if (!this.ctx || !this.healthLpFilter) return;
      const cutoff = 20000 - this.lowHpFactor * 18650; // 跌破危机血量时收窄环境高频至 ~1350Hz
      this.healthLpFilter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.16);
    }

    updateListener(pos, yaw) {
      if (pos) {
        this._listenerPos.x = pos.x || 0;
        this._listenerPos.y = pos.y || 0;
        this._listenerPos.z = pos.z || 0;
      }
      if (Number.isFinite(yaw)) {
        this._listenerYaw = yaw;
      }
    }

    _createSpatialOutput(worldPos, maxDist = 60) {
      if (!this.ctx || !this.mainBus) return { dest: this.mainBus, distAtten: 1 };
      if (!worldPos || typeof GameLogic === 'undefined' || !GameLogic.computeSpatialAudioParams) {
        return { dest: this.mainBus, distAtten: 1 };
      }
      const p = GameLogic.computeSpatialAudioParams(this._listenerPos, this._listenerYaw, worldPos, maxDist);
      let dest = this.mainBus;
      if (typeof this.ctx.createStereoPanner === 'function') {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = p.pan;
        panner.connect(this.mainBus);
        dest = panner;
      }
      if (p.rearFactor > 0.15) {
        const rearLp = this.ctx.createBiquadFilter();
        rearLp.type = 'lowpass';
        rearLp.frequency.value = p.lpFreq;
        rearLp.Q.value = 0.7;
        rearLp.connect(dest);
        dest = rearLp;
      }
      return { dest, distAtten: p.distAtten };
    }

    clearScheduledThunder() {
      for (let i = 0; i < this._thunderTimers.length; i++) {
        clearTimeout(this._thunderTimers[i]);
      }
      this._thunderTimers.length = 0;
    }

    scheduleThunder(delaySec = 1.1, intensity = 0.6) {
      if (!this.ctx || this.muted) return;
      const ms = Math.max(150, Math.min(3500, Math.round((Number(delaySec) || 1.1) * 1000)));
      const id = setTimeout(() => {
        const idx = this._thunderTimers.indexOf(id);
        if (idx >= 0) this._thunderTimers.splice(idx, 1);
        if (!this.muted && this.ctx) {
          this.playThunder(intensity);
        }
      }, ms);
      this._thunderTimers.push(id);
    }

    updateEnvironment(isIndoors, dt) {
      if (!this.ctx || !this.rainFilter) return;
      if (isIndoors !== this.indoors) {
        this.indoors = isIndoors;
        const now = this.ctx.currentTime;
        this.rainFilter.frequency.setTargetAtTime(isIndoors ? 680 : 3400, now, 0.22);
        this.rainGain.gain.setTargetAtTime(isIndoors ? 0.24 : 0.34, now, 0.22);
        this.tinRoofGain.gain.setTargetAtTime(isIndoors ? 0.14 : 0.0, now, 0.25);
      }

      if (!this.muted) {
        this._tickAdaptiveBgm(dt);
        this._tickHeartbeat(dt);
      }
    }

    _tickAdaptiveBgm(dt) {
      if (!this.ctx || !this.bgmGain || this.musicMode === 'off') return;
      const interval = this.musicMode === 'holdout' ? 0.227 : this.musicMode === 'combat' ? 0.258 : 0.375;
      this.bgmTimer -= dt;
      if (this.bgmTimer > 0) return;
      this.bgmTimer += interval;

      const step = this.bgmStep++ % 16;
      const now = this.ctx.currentTime;
      const bassRoots = [73.42, 73.42, 87.31, 65.41]; // D2, D2, F2, C2
      const rootFreq = bassRoots[Math.floor(step / 4) % 4];

      if (this.musicMode === 'stealth') {
        if (step % 4 === 0) {
          this._playBgmTone(rootFreq * 0.5, 'sine', now, 0.32, 0.18);
        }
        if (step % 8 === 4) {
          this._playBgmTone(rootFreq * 1.5, 'triangle', now, 0.2, 0.045);
        }
      } else if (this.musicMode === 'combat' || this.musicMode === 'holdout') {
        const isHoldout = this.musicMode === 'holdout';
        if (step % 2 === 0) {
          this._playBgmTone(rootFreq, 'sawtooth', now, 0.18, isHoldout ? 0.14 : 0.1, 320);
        }
        if (step % 4 === 0 || (isHoldout && step % 4 === 2)) {
          // 合成底鼓脉冲
          const k = this.ctx.createOscillator();
          k.type = 'sine';
          k.frequency.setValueAtTime(115, now);
          k.frequency.exponentialRampToValueAtTime(38, now + 0.09);
          const kg = this.ctx.createGain();
          kg.gain.setValueAtTime(isHoldout ? 0.22 : 0.15, now);
          kg.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
          k.connect(kg);
          kg.connect(this.bgmGain);
          k.start(now);
          k.stop(now + 0.12);
        }
        if (step % 2 === 1 && this.noiseBuffer) {
          const hat = this.ctx.createBufferSource();
          hat.buffer = this.noiseBuffer;
          const hp = this.ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 6200;
          const hg = this.ctx.createGain();
          hg.gain.setValueAtTime(isHoldout ? 0.055 : 0.032, now);
          hg.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
          hat.connect(hp);
          hp.connect(hg);
          hg.connect(this.bgmGain);
          hat.start(now, Math.random() * 0.8);
          hat.stop(now + 0.05);
        }
        if (isHoldout && (step === 0 || step === 8)) {
          this._playBgmTone(rootFreq * 3.0, 'sawtooth', now, 0.45, 0.055, 1100);
        }
      }
    }

    _playBgmTone(freq, type, startTime, dur, gainVal, lpCutoff = 600) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lpCutoff;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, startTime);
      g.gain.linearRampToValueAtTime(gainVal, startTime + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.bgmGain);
      osc.start(startTime);
      osc.stop(startTime + dur + 0.02);
    }

    _tickHeartbeat(dt) {
      if (this.lowHpFactor <= 0.15) return;
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer > 0) return;
      this.heartbeatTimer = 0.92 - this.lowHpFactor * 0.3;
      const now = this.ctx.currentTime;
      for (let i = 0; i < 2; i++) {
        const t = now + i * 0.18;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(i === 0 ? 64 : 52, t);
        osc.frequency.exponentialRampToValueAtTime(34, t + 0.11);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.24 * this.lowHpFactor, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
        osc.connect(g);
        g.connect(this.mainBus);
        osc.start(t);
        osc.stop(t + 0.14);
      }
    }

    playTinnitusFlash(intensity = 1.0) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      if (now - this._lastTinnitusAt < 3.5) return;
      this._lastTinnitusAt = now;
      const scale = Math.max(0.25, Math.min(1.0, Number(intensity) || 1.0));
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(3850, now);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.065 * scale, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0005, now + 1.35);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 1.4);
    }

    playThunder(intensity = 0.55) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const dur = 2.6 + Math.random() * 1.4;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;

      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(160 + intensity * 120, now);
      lp.frequency.exponentialRampToValueAtTime(48, now + dur);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.45 * intensity, now + 0.14);
      g.gain.exponentialRampToValueAtTime(0.18 * intensity, now + 0.7);
      g.gain.linearRampToValueAtTime(0.28 * intensity, now + 1.0);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);

      src.connect(lp);
      lp.connect(g);
      g.connect(this.mainBus);
      src.start(now);
      src.stop(now + dur + 0.05);
    }

    playGunshot(opts = {}) {
      if (!this.ctx) return;
      const suppressed = !!opts.suppressed;
      const wType = opts.weaponType || 'car47';
      const now = this.ctx.currentTime;
      const jitter = 0.96 + Math.random() * 0.08;

      if (suppressed) {
        // 消音状态：干脆压缩“噗嗤”低噪气爆 + 高频膛闭声
        const pop = this.ctx.createOscillator();
        pop.type = 'triangle';
        pop.frequency.setValueAtTime((wType === 'dmr' ? 240 : 310) * jitter, now);
        pop.frequency.exponentialRampToValueAtTime(75, now + 0.055);
        const pg = this.ctx.createGain();
        pg.gain.setValueAtTime(0.28, now);
        pg.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        pop.connect(pg);
        pg.connect(this.mainBus);
        pop.start(now);
        pop.stop(now + 0.07);

        if (this.noiseBuffer) {
          const puff = this.ctx.createBufferSource();
          puff.buffer = this.noiseBuffer;
          const hp = this.ctx.createBiquadFilter();
          hp.type = 'bandpass';
          hp.frequency.setValueAtTime(2400 * jitter, now);
          hp.Q.value = 1.6;
          const hg = this.ctx.createGain();
          hg.gain.setValueAtTime(0.26, now);
          hg.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
          puff.connect(hp);
          hp.connect(hg);
          hg.connect(this.mainBus);
          puff.start(now, Math.random() * 1.1);
          puff.stop(now + 0.08);
        }
        return;
      }

      const heavy = wType === 'shotgun' || wType === 'dmr';
      // 1. 低频胸腔冲击波
      const punch = this.ctx.createOscillator();
      punch.type = 'triangle';
      punch.frequency.setValueAtTime((wType === 'shotgun' ? 120 : wType === 'dmr' ? 140 : 155) * jitter, now);
      punch.frequency.exponentialRampToValueAtTime(wType === 'shotgun' ? 28 : 38, now + (heavy ? 0.13 : 0.085));
      const punchGain = this.ctx.createGain();
      punchGain.gain.setValueAtTime(wType === 'shotgun' ? 0.88 : wType === 'pistol' ? 0.45 : 0.65, now);
      punchGain.gain.exponentialRampToValueAtTime(0.001, now + (heavy ? 0.16 : 0.1));
      punch.connect(punchGain);
      punchGain.connect(this.mainBus);
      punch.start(now);
      punch.stop(now + 0.18);

      // 2. 膛口火药爆鸣噪声尾音（室内混响略增强）
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime((this.indoors ? 1400 : 1950) * jitter, now);
      bp.frequency.exponentialRampToValueAtTime(360, now + 0.16);
      bp.Q.value = wType === 'shotgun' ? 0.6 : 0.85;

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(wType === 'shotgun' ? 1.05 : wType === 'pistol' ? 0.6 : 0.85, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + (this.indoors ? 0.28 : 0.19));

      noise.connect(bp);
      bp.connect(nGain);
      nGain.connect(this.mainBus);
      noise.start(now, Math.random() * 1.2);
      noise.stop(now + 0.3);

      // 3. 枪机金属复位瞬态
      const bolt = this.ctx.createOscillator();
      bolt.type = 'square';
      bolt.frequency.setValueAtTime(2200 * jitter, now + 0.025);
      bolt.frequency.exponentialRampToValueAtTime(880, now + 0.05);
      const bGain = this.ctx.createGain();
      bGain.gain.setValueAtTime(0.09, now + 0.025);
      bGain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      bolt.connect(bGain);
      bGain.connect(this.mainBus);
      bolt.start(now + 0.025);
      bolt.stop(now + 0.06);
    }

    playShellClink(inPuddle = false, worldPos = null) {
      if (!this.ctx) return;
      const delay = 0.27 + Math.random() * 0.11;
      const t = this.ctx.currentTime + delay;
      const pitch = 0.94 + Math.random() * 0.14;
      const vol = inPuddle ? 0.022 : 0.065;
      const sp = this._createSpatialOutput(worldPos, 24);

      const freqs = [3450 * pitch, 5180 * pitch];
      for (let i = 0; i < freqs.length; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freqs[i], t);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol * (i === 0 ? 1 : 0.65), t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + (inPuddle ? 0.025 : 0.055));
        osc.connect(g);
        g.connect(sp.dest);
        osc.start(t);
        osc.stop(t + 0.065);
      }
    }

    playMetalImpact(dist = 10, worldPos = null) {
      if (!this.ctx || dist > 60) return;
      const now = this.ctx.currentTime;
      const atten = Math.max(0.05, 1 - dist / 60);
      const baseF = 1850 + Math.random() * 1450;
      const sp = this._createSpatialOutput(worldPos, 60);

      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(baseF, now);
      osc.frequency.exponentialRampToValueAtTime(baseF * 0.58, now + 0.075);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.14 * atten, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

      osc.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.09);
    }

    playHitmarker(isCrit = false, isKill = false) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(isCrit ? 1950 : 1220, now);
      osc.frequency.exponentialRampToValueAtTime(isCrit ? 2600 : 900, now + 0.045);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(isCrit ? 0.16 : 0.1, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.06);

      if (isKill) {
        const kOsc = this.ctx.createOscillator();
        kOsc.type = 'triangle';
        kOsc.frequency.setValueAtTime(740, now + 0.03);
        kOsc.frequency.exponentialRampToValueAtTime(1180, now + 0.12);
        const kg = this.ctx.createGain();
        kg.gain.setValueAtTime(0.14, now + 0.03);
        kg.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
        kOsc.connect(kg);
        kg.connect(this.mainBus);
        kOsc.start(now + 0.03);
        kOsc.stop(now + 0.14);
      }
    }

    playFootstep(puddleDepth = 0, isMetal = false) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;

      const f = this.ctx.createBiquadFilter();
      if (puddleDepth > 0.25) {
        // 积水踩踏飞溅声
        f.type = 'bandpass';
        f.frequency.setValueAtTime(1100 + Math.random() * 500, now);
        f.Q.value = 1.1;
      } else {
        f.type = 'lowpass';
        f.frequency.setValueAtTime(isMetal ? 920 : 420, now);
      }

      const g = this.ctx.createGain();
      const peak = puddleDepth > 0.25 ? 0.17 : 0.11;
      g.gain.setValueAtTime(peak, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + (puddleDepth > 0.25 ? 0.13 : 0.08));

      src.connect(f);
      f.connect(g);
      g.connect(this.mainBus);
      src.start(now, Math.random() * 1.5);
      src.stop(now + 0.15);

      if (isMetal) {
        const clank = this.ctx.createOscillator();
        clank.type = 'sine';
        clank.frequency.setValueAtTime(320 + Math.random() * 70, now);
        const cg = this.ctx.createGain();
        cg.gain.setValueAtTime(0.04, now);
        cg.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        clank.connect(cg);
        cg.connect(this.mainBus);
        clank.start(now);
        clank.stop(now + 0.055);
      }
    }

    playReloadStage(stage) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      const freq = stage === 'out' ? 540 : stage === 'in' ? 760 : 1280;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.65, now + 0.04);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.09, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.06);
    }

    playEnemyShot(type, dist, worldPos = null) {
      if (!this.ctx || dist > 65) return;
      const now = this.ctx.currentTime;
      const atten = Math.max(0.08, 1 - dist / 65);
      const sp = this._createSpatialOutput(worldPos, 65);
      const osc = this.ctx.createOscillator();
      osc.type = type === 'drone' ? 'sawtooth' : 'square';
      osc.frequency.setValueAtTime(type === 'drone' ? 980 : 620, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.11);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.16 * atten, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.13);
    }

    playEnemyStep(dist, worldPos = null) {
      if (!this.ctx || dist > 36) return;
      const now = this.ctx.currentTime;
      const atten = Math.max(0.03, 1 - dist / 36);
      const sp = this._createSpatialOutput(worldPos, 36);
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(240 + Math.random() * 80, now);
      osc.frequency.exponentialRampToValueAtTime(90, now + 0.04);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.08 * atten, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      osc.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.05);
    }

    playEnemyAlert(isDog = false, worldPos = null) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const sp = this._createSpatialOutput(worldPos, 65);
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(isDog ? 420 : 680, now);
      osc.frequency.linearRampToValueAtTime(isDog ? 940 : 1120, now + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.11 * (worldPos ? Math.max(0.25, sp.distAtten) : 1), now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.19);
    }

    playExplosion(dist = 15, worldPos = null) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const atten = Math.max(0.15, 1 - dist / 75);
      const sp = this._createSpatialOutput(worldPos, 75);

      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1200, now);
      lp.frequency.exponentialRampToValueAtTime(90, now + 0.6);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.55 * atten, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

      src.connect(lp);
      lp.connect(g);
      g.connect(sp.dest);
      src.start(now);
      src.stop(now + 0.68);
    }

    playAlarmKlaxon(repeats = 3) {
      if (!this.ctx) return;
      const start = this.ctx.currentTime;
      for (let i = 0; i < repeats; i++) {
        const t = start + i * 0.72;
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(510, t);
        osc.frequency.linearRampToValueAtTime(790, t + 0.3);
        osc.frequency.linearRampToValueAtTime(510, t + 0.58);

        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1800;

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.17, t + 0.05);
        g.gain.setValueAtTime(0.17, t + 0.48);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.62);

        osc.connect(lp);
        lp.connect(g);
        g.connect(this.mainBus);
        osc.start(t);
        osc.stop(t + 0.64);
      }
    }

    updateRelayCutLoop(progress) {
      if (!this.ctx) return;
      if (!this.relayBuzz) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        const g = this.ctx.createGain();
        g.gain.value = 0.08;
        osc.connect(g);
        g.connect(this.mainBus);
        osc.start();
        this.relayBuzz = { osc, g };
      }
      this.relayBuzz.osc.frequency.setTargetAtTime(160 + progress * 420, this.ctx.currentTime, 0.03);
    }

    stopRelayCutLoop() {
      if (this.relayBuzz) {
        try {
          this.relayBuzz.osc.stop();
          this.relayBuzz.osc.disconnect();
        } catch (e) {}
        this.relayBuzz = null;
      }
    }

    playRelaySevered() {
      this.stopRelayCutLoop();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.35);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.24, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.4);
    }

    playRadioBeep() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1520, now);
      osc.frequency.setValueAtTime(1140, now + 0.045);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.08, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.1);
    }

    playPlayerHit() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.exponentialRampToValueAtTime(38, now + 0.14);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.32, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.17);
    }

    playSwitchClick() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1600, now);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.06, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.035);
    }

    playCountdownTick(urgent = false) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = urgent ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(urgent ? 1320 : 880, now);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(urgent ? 0.14 : 0.08, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.09);
    }

    playComboChime(combo = 1) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      const freq = 540 + Math.min(10, Math.max(0, combo - 1)) * 55;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.18, now + 0.07);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.09, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.12);
    }

    playWaveClear() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const tones = [587.3, 880];
      tones.forEach((freq, idx) => {
        const t = now + idx * 0.11;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.13, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc.connect(g);
        g.connect(this.mainBus);
        osc.start(t);
        osc.stop(t + 0.24);
      });
    }

    playSuppressorToggle(attached) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(attached ? 680 : 1080, now);
      osc.frequency.exponentialRampToValueAtTime(attached ? 1240 : 620, now + 0.075);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.11, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.09);
    }

    playShieldDeflect() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const f = 2250 + Math.random() * 750;
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.exponentialRampToValueAtTime(f * 0.45, now + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.16, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.14);
    }

    playLaserSniperCharge(worldPos = null) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const sp = this._createSpatialOutput(worldPos, 70);
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(420, now);
      osc.frequency.exponentialRampToValueAtTime(1920, now + 0.9);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'bandpass';
      lp.frequency.value = 1400;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.11 * (worldPos ? Math.max(0.25, sp.distAtten) : 1), now + 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.95);
      osc.connect(lp);
      lp.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.98);
    }

    playLaserSniperShot(worldPos = null) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const sp = this._createSpatialOutput(worldPos, 75);
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1600, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.22);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.32 * (worldPos ? Math.max(0.22, sp.distAtten) : 1), now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      osc.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.25);
    }

    playEmpBlast(worldPos = null) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const sp = this._createSpatialOutput(worldPos, 65);
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(840, now);
      osc.frequency.exponentialRampToValueAtTime(46, now + 0.55);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.38 * (worldPos ? Math.max(0.2, sp.distAtten) : 1), now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.58);
      osc.connect(g);
      g.connect(sp.dest);
      osc.start(now);
      osc.stop(now + 0.6);
    }

    playDecoyPulse(worldPos = null) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const sp = this._createSpatialOutput(worldPos, 48);
      for (let i = 0; i < 2; i++) {
        const t = now + i * 0.085;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1750, t);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.09 * (worldPos ? Math.max(0.18, sp.distAtten) : 1), t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        osc.connect(g);
        g.connect(sp.dest);
        osc.start(t);
        osc.stop(t + 0.055);
      }
    }

    playSlide() {
      if (!this.ctx || !this.noiseBuffer) return;
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(980, now);
      bp.frequency.exponentialRampToValueAtTime(320, now + 0.36);
      bp.Q.value = 1.4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.24, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.mainBus);
      src.start(now, Math.random() * 0.7);
      src.stop(now + 0.4);
    }

    playMeleeTakedown() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.exponentialRampToValueAtTime(42, now + 0.14);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.38, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.17);
    }

    playPulseScan() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(1560, now + 0.42);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.18, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
      osc.connect(g);
      g.connect(this.mainBus);
      osc.start(now);
      osc.stop(now + 0.58);
    }

    playAmmoPickup() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [920, 1380].forEach((freq, idx) => {
        const t = now + idx * 0.07;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.11, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(g);
        g.connect(this.mainBus);
        osc.start(t);
        osc.stop(t + 0.09);
      });
    }

    playC4Plant() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [1480, 1980].forEach((f, idx) => {
        const t = now + idx * 0.09;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(f, t);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.08, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
        osc.connect(g);
        g.connect(this.mainBus);
        osc.start(t);
        osc.stop(t + 0.06);
      });
    }
  }

  return Engine;
})();
