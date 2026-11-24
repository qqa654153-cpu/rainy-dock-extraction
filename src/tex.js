// ============================================================================
// 模块 1：程序化纹理与 PBR 材质工厂 (TextureFactory)
// 利用 Canvas 2D + 确定性 2D Value Noise / FBM 生成金属波纹、锈迹、划痕、
// 警示标语、粗糙度/法线贴图及地面共享积水掩膜。零外部图像依赖。
// ============================================================================

const TextureFactory = (() => {
  'use strict';

  function hash2(ix, iy, seed = 1337) {
    let n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  function valueNoise2(x, y, periodX = 0, periodY = 0, seed = 1337) {
    const ix0 = Math.floor(x);
    const iy0 = Math.floor(y);
    const fx = smoothstep(x - ix0);
    const fy = smoothstep(y - iy0);

    const wrap = (v, p) => (p > 0 ? ((v % p) + p) % p : v);
    const x0 = wrap(ix0, periodX);
    const x1 = wrap(ix0 + 1, periodX);
    const y0 = wrap(iy0, periodY);
    const y1 = wrap(iy0 + 1, periodY);

    const a = hash2(x0, y0, seed);
    const b = hash2(x1, y0, seed);
    const c = hash2(x0, y1, seed);
    const d = hash2(x1, y1, seed);

    const u = a + (b - a) * fx;
    const v = c + (d - c) * fx;
    return u + (v - u) * fy;
  }

  function fbmTileable(u, v, baseFreq, octaves = 4, seed = 1337) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let freq = baseFreq;
    for (let i = 0; i < octaves; i++) {
      sum += amp * valueNoise2(u * freq, v * freq, freq, freq, seed + i * 71);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function heightFieldToNormalCanvas(heights, w, h, strength = 2.4) {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const data = img.data;

    for (let y = 0; y < h; y++) {
      const ym = (y - 1 + h) % h;
      const yp = (y + 1) % h;
      for (let x = 0; x < w; x++) {
        const xm = (x - 1 + w) % w;
        const xp = (x + 1) % w;

        const hL = heights[y * w + xm];
        const hR = heights[y * w + xp];
        const hU = heights[ym * w + x];
        const hD = heights[yp * w + x];

        let nx = (hL - hR) * strength;
        let ny = (hD - hU) * strength;
        let nz = 1.0;
        const invLen = 1 / Math.hypot(nx, ny, nz);
        nx *= invLen;
        ny *= invLen;
        nz *= invLen;

        const idx = (y * w + x) * 4;
        data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
        data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function configureTexture(tex, isColor = false, repeatX = 1, repeatY = 1, maxAniso = 4) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = maxAniso;
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }

  class Factory {
    constructor(maxAnisotropy = 4) {
      this.maxAniso = Math.min(8, maxAnisotropy || 4);
      this.cache = new Map();
      this.puddleData = null;
      this.puddleSize = 256;
      this.worldWidth = 110;
      this.worldDepth = 90;
    }

    buildAll() {
      this.containers = {
        rustRed: this._createContainerMaterialSet('#7e2c21', 'DOCK-04', 'CAUTION // HEAVY CARGO', 101),
        navyBlue: this._createContainerMaterialSet('#1e3a54', 'MAERSK-88', 'HAZMAT // CLASS 3', 202),
        ochreYellow: this._createContainerMaterialSet('#8f651d', 'PORT-29', 'HIGH VOLTAGE // KEEP CLEAR', 303),
        oliveSteel: this._createContainerMaterialSet('#334634', 'MIL-07', 'RESTRICTED // SECTOR B', 404),
      };
      this.warehouseWall = this._createTinWallMaterial();
      this.warehouseRoof = this._createTinWallMaterial(true);
      this.concreteFloor = this._createConcreteMaterial();
      this.asphaltData = this._createAsphaltAndPuddleTextures();
      this.metalFrame = this._createBrushedMetalMaterial('#464e58', 0.42, 0.82);
      this.craneYellow = this._createContainerMaterialSet('#9d6d19', 'GANTRY-01', 'DANGER // SWINGING LOAD', 505, false);
      this.woodCrate = this._createWoodCrateMaterial();
      this.hazardBarrel = this._createHazardBarrelMaterial();
      this.boatHull = this._createBrushedMetalMaterial('#202b36', 0.34, 0.72);
      this.gunMetal = this._createBrushedMetalMaterial('#262b33', 0.28, 0.9);
      this.gunPolymer = this._createGripPolymerMaterial();
      this.holoReticleTex = this._createHoloReticleTexture();
      this.reflexCircleTex = this._createReflexCircleTexture();
      this.muzzleFlashTex = this._createMuzzleFlashTexture();
      this.bulletDecalTex = this._createBulletDecalTexture();
      this.smokePuffTex = this._createSmokePuffTexture();
      this.droneArmor = this._createEnemyArmorMaterial('#1c222a', '#e07a1f', 701);
      this.houndArmor = this._createEnemyArmorMaterial('#252a32', '#c9342a', 802);
      return this;
    }

    _createContainerMaterialSet(baseHex, codeText, warningText, seed, addTopStripes = true) {
      const size = 512;
      const diffC = createCanvas(size, size);
      const roughC = createCanvas(size, size);
      const diffCtx = diffC.getContext('2d');
      const roughCtx = roughC.getContext('2d');
      const diffImg = diffCtx.createImageData(size, size);
      const roughImg = roughCtx.createImageData(size, size);
      const heights = new Float32Array(size * size);
      const [br, bg, bb] = hexToRgb(baseHex);

      // 逐像素：垂直梯形波纹 + 纵向流挂锈迹 + 随机漆面磨损划痕
      for (let y = 0; y < size; y++) {
        const v = y / size;
        const edgeWear = Math.min(v, 1 - v) < 0.055 ? 1 - Math.min(v, 1 - v) / 0.055 : 0;
        for (let x = 0; x < size; x++) {
          const u = x / size;
          // 梯形波纹槽
          const ribPhase = (u * 22) % 1;
          let ribH = 0;
          if (ribPhase < 0.25) ribH = ribPhase / 0.25;
          else if (ribPhase < 0.5) ribH = 1.0;
          else if (ribPhase < 0.75) ribH = 1 - (ribPhase - 0.5) / 0.25;
          else ribH = 0;

          // 上下加强横梁平滑区域
          const beamMask = v < 0.07 || v > 0.93 ? 1 : 0;
          const hVal = beamMask ? 0.85 : ribH * 0.75;

          const noiseFine = fbmTileable(u, v, 14, 3, seed);
          const rustDrip = fbmTileable(u * 2.4, v * 0.42, 8, 4, seed + 19);
          const scratch = fbmTileable(u * 3.5, v * 1.1, 18, 3, seed + 53);

          const rustFactor = Math.max(0, (rustDrip - 0.56) * 2.5 + edgeWear * 0.48 - 0.08);
          const rustClamped = Math.min(1, rustFactor);
          const metalScratch = scratch > 0.74 && noiseFine > 0.55 ? 0.65 : 0;

          // 压纹凹槽轻微环境光遮蔽
          const ao = 0.72 + 0.28 * hVal;
          let r = br * ao * (0.85 + 0.3 * noiseFine);
          let g = bg * ao * (0.85 + 0.3 * noiseFine);
          let b = bb * ao * (0.85 + 0.3 * noiseFine);

          // 混合铁锈色 (#6b2a14 / #8f3d1c)
          if (rustClamped > 0.02) {
            const rr = 112 + 35 * noiseFine;
            const rg = 44 + 20 * noiseFine;
            const rb = 20 + 10 * noiseFine;
            r = r * (1 - rustClamped) + rr * rustClamped;
            g = g * (1 - rustClamped) + rg * rustClamped;
            b = b * (1 - rustClamped) + rb * rustClamped;
          }

          // 露底金属划痕
          if (metalScratch > 0) {
            r = r * (1 - metalScratch) + 150 * metalScratch;
            g = g * (1 - metalScratch) + 156 * metalScratch;
            b = b * (1 - metalScratch) + 164 * metalScratch;
          }

          // 雨夜自上而下污渍流痕
          const rainStreak = 1 - 0.22 * (1 - v) * fbmTileable(u * 3, v * 0.3, 12, 2, seed + 91);
          const idx = (y * size + x) * 4;
          diffImg.data[idx] = clampByte(r * rainStreak);
          diffImg.data[idx + 1] = clampByte(g * rainStreak);
          diffImg.data[idx + 2] = clampByte(b * rainStreak);
          diffImg.data[idx + 3] = 255;

          // 粗糙度：漆面 0.44、锈迹 0.88、划痕裸铁 0.24（雨水打湿略降低总体粗糙度）
          let rough = 0.44 + noiseFine * 0.14;
          rough = rough * (1 - rustClamped) + 0.88 * rustClamped;
          rough = rough * (1 - metalScratch) + 0.24 * metalScratch;
          const rByte = clampByte(rough * 255);
          roughImg.data[idx] = rByte;
          roughImg.data[idx + 1] = rByte;
          roughImg.data[idx + 2] = rByte;
          roughImg.data[idx + 3] = 255;

          heights[y * size + x] = hVal + noiseFine * 0.09 + rustClamped * 0.14 - metalScratch * 0.08;
        }
      }

      diffCtx.putImageData(diffImg, 0, 0);
      roughCtx.putImageData(roughImg, 0, 0);

      // 叠加黄黑警示条与钢印喷涂标识
      if (addTopStripes) {
        diffCtx.save();
        diffCtx.globalAlpha = 0.78;
        diffCtx.fillStyle = '#d69c18';
        diffCtx.fillRect(0, size - 44, size, 22);
        diffCtx.fillStyle = '#15181d';
        for (let sx = -40; sx < size + 40; sx += 32) {
          diffCtx.beginPath();
          diffCtx.moveTo(sx, size - 44);
          diffCtx.lineTo(sx + 16, size - 44);
          diffCtx.lineTo(sx + 4, size - 22);
          diffCtx.lineTo(sx - 12, size - 22);
          diffCtx.closePath();
          diffCtx.fill();
        }
        diffCtx.restore();
      }

      // 喷涂编号与警示标语（略微做旧半透明）
      diffCtx.save();
      diffCtx.globalAlpha = 0.72;
      diffCtx.fillStyle = '#e8e4d8';
      diffCtx.font = 'bold 42px "Consolas", "Courier New", monospace';
      diffCtx.fillText(codeText, 34, 92);
      diffCtx.font = 'bold 20px "Consolas", "Courier New", monospace';
      diffCtx.fillStyle = '#f0b63a';
      diffCtx.fillText(warningText, 34, 126);

      // 集装箱门框/锁杆细节线
      diffCtx.strokeStyle = 'rgba(15,18,22,0.45)';
      diffCtx.lineWidth = 4;
      diffCtx.strokeRect(4, 4, size - 8, size - 8);
      diffCtx.restore();

      const normalC = heightFieldToNormalCanvas(heights, size, size, 2.8);
      const map = configureTexture(new THREE.CanvasTexture(diffC), true, 1, 1, this.maxAniso);
      const roughMap = configureTexture(new THREE.CanvasTexture(roughC), false, 1, 1, this.maxAniso);
      const normalMap = configureTexture(new THREE.CanvasTexture(normalC), false, 1, 1, this.maxAniso);

      return new THREE.MeshPhysicalMaterial({
        map,
        roughnessMap: roughMap,
        normalMap,
        normalScale: new THREE.Vector2(1.15, 1.15),
        metalness: 0.56,
        roughness: 0.72,
      });
    }

    _createTinWallMaterial(isRoof = false) {
      const size = 512;
      const diffC = createCanvas(size, size);
      const roughC = createCanvas(size, size);
      const diffCtx = diffC.getContext('2d');
      const roughCtx = roughC.getContext('2d');
      const diffImg = diffCtx.createImageData(size, size);
      const roughImg = roughCtx.createImageData(size, size);
      const heights = new Float32Array(size * size);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const u = x / size;
          const rib = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 28);
          const grime = fbmTileable(u, v, 8, 4, 606);
          const rust = Math.max(0, fbmTileable(u * 1.5, v * 0.7, 10, 3, 629) - 0.63) * 2.2;
          const base = (isRoof ? 68 : 82) + rib * 24 + grime * 26;
          const rClamped = Math.min(1, rust);

          const idx = (y * size + x) * 4;
          diffImg.data[idx] = clampByte(base * (1 - rClamped) + 110 * rClamped);
          diffImg.data[idx + 1] = clampByte((base + 4) * (1 - rClamped) + 52 * rClamped);
          diffImg.data[idx + 2] = clampByte((base + 10) * (1 - rClamped) + 28 * rClamped);
          diffImg.data[idx + 3] = 255;

          const rByte = clampByte((0.35 + grime * 0.25 + rClamped * 0.35) * 255);
          roughImg.data[idx] = rByte;
          roughImg.data[idx + 1] = rByte;
          roughImg.data[idx + 2] = rByte;
          roughImg.data[idx + 3] = 255;

          heights[y * size + x] = rib * 0.55 + grime * 0.12;
        }
      }
      diffCtx.putImageData(diffImg, 0, 0);
      roughCtx.putImageData(roughImg, 0, 0);
      const normalC = heightFieldToNormalCanvas(heights, size, size, 2.5);

      return new THREE.MeshPhysicalMaterial({
        map: configureTexture(new THREE.CanvasTexture(diffC), true, isRoof ? 4 : 3, 2, this.maxAniso),
        roughnessMap: configureTexture(new THREE.CanvasTexture(roughC), false, isRoof ? 4 : 3, 2, this.maxAniso),
        normalMap: configureTexture(new THREE.CanvasTexture(normalC), false, isRoof ? 4 : 3, 2, this.maxAniso),
        normalScale: new THREE.Vector2(1.0, 1.0),
        metalness: 0.72,
        roughness: 0.58,
        side: THREE.DoubleSide,
      });
    }

    _createConcreteMaterial() {
      const size = 256;
      const diffC = createCanvas(size, size);
      const roughC = createCanvas(size, size);
      const diffCtx = diffC.getContext('2d');
      const roughCtx = roughC.getContext('2d');
      const diffImg = diffCtx.createImageData(size, size);
      const roughImg = roughCtx.createImageData(size, size);
      const heights = new Float32Array(size * size);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const u = x / size;
          const n1 = fbmTileable(u, v, 8, 4, 777);
          const n2 = fbmTileable(u, v, 24, 2, 789);
          const grid = (x % 64 < 2 || y % 64 < 2) ? 0.72 : 1.0;
          const val = (58 + n1 * 34 + n2 * 14) * grid;
          const idx = (y * size + x) * 4;
          diffImg.data[idx] = clampByte(val);
          diffImg.data[idx + 1] = clampByte(val + 2);
          diffImg.data[idx + 2] = clampByte(val + 5);
          diffImg.data[idx + 3] = 255;

          const rByte = clampByte((0.62 + n1 * 0.25) * 255);
          roughImg.data[idx] = rByte;
          roughImg.data[idx + 1] = rByte;
          roughImg.data[idx + 2] = rByte;
          roughImg.data[idx + 3] = 255;
          heights[y * size + x] = n1 * 0.35 + n2 * 0.2 - (grid < 1 ? 0.25 : 0);
        }
      }
      diffCtx.putImageData(diffImg, 0, 0);
      roughCtx.putImageData(roughImg, 0, 0);
      const normalC = heightFieldToNormalCanvas(heights, size, size, 1.8);

      return new THREE.MeshPhysicalMaterial({
        map: configureTexture(new THREE.CanvasTexture(diffC), true, 4, 4, this.maxAniso),
        roughnessMap: configureTexture(new THREE.CanvasTexture(roughC), false, 4, 4, this.maxAniso),
        normalMap: configureTexture(new THREE.CanvasTexture(normalC), false, 4, 4, this.maxAniso),
        metalness: 0.08,
        roughness: 0.85,
      });
    }

    _createAsphaltAndPuddleTextures() {
      const size = 256;
      const diffC = createCanvas(size, size);
      const roughC = createCanvas(size, size);
      const diffCtx = diffC.getContext('2d');
      const roughCtx = roughC.getContext('2d');
      const diffImg = diffCtx.createImageData(size, size);
      const roughImg = roughCtx.createImageData(size, size);
      const heights = new Float32Array(size * size);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const u = x / size;
          const grit = fbmTileable(u, v, 28, 3, 911);
          const stain = fbmTileable(u, v, 6, 3, 947);
          const cVal = 24 + grit * 26 + stain * 14;
          const idx = (y * size + x) * 4;
          diffImg.data[idx] = clampByte(cVal);
          diffImg.data[idx + 1] = clampByte(cVal + 3);
          diffImg.data[idx + 2] = clampByte(cVal + 7);
          diffImg.data[idx + 3] = 255;

          // 湿滑沥青总体粗糙度低（高光反射感强）
          const rByte = clampByte((0.2 + grit * 0.28 + stain * 0.14) * 255);
          roughImg.data[idx] = rByte;
          roughImg.data[idx + 1] = rByte;
          roughImg.data[idx + 2] = rByte;
          roughImg.data[idx + 3] = 255;
          heights[y * size + x] = grit * 0.4 + stain * 0.15;
        }
      }
      diffCtx.putImageData(diffImg, 0, 0);
      roughCtx.putImageData(roughImg, 0, 0);
      const normalC = heightFieldToNormalCanvas(heights, size, size, 1.6);

      // 生成世界空间连续积水掩膜（确保铁皮仓库内部完全干燥，门外车道水洼密集）
      const pSize = this.puddleSize;
      const puddleC = createCanvas(pSize, pSize);
      const pCtx = puddleC.getContext('2d');
      const pImg = pCtx.createImageData(pSize, pSize);
      const pArr = new Float32Array(pSize * pSize);

      for (let py = 0; py < pSize; py++) {
        const nz = py / pSize;
        const wz = (nz - 0.5) * this.worldDepth;
        for (let px = 0; px < pSize; px++) {
          const nx = px / pSize;
          const wx = (nx - 0.5) * this.worldWidth;

          // 仓库区域 (x: -22..-2, z: -32..-14) 设为干燥，门前做柔和过渡
          const dxWh = Math.max(-22 - wx, 0, wx - -2);
          const dzWh = Math.max(-32 - wz, 0, wz - -14);
          const distWh = Math.hypot(dxWh, dzWh);
          const indoorMask = Math.min(1, Math.max(0, (distWh - 0.5) / 2.2));

          // 结合 FBM 低洼地势与局部高光水塘
          const basin = fbmTileable(nx, nz, 5, 4, 1515);
          const detail = fbmTileable(nx, nz, 14, 2, 1616);
          let puddle = (basin * 0.78 + detail * 0.22 - 0.43) * 4.4;
          puddle = Math.max(0, Math.min(1, puddle)) * indoorMask;

          pArr[py * pSize + px] = puddle;
          const byte = clampByte(puddle * 255);
          const idx = (py * pSize + px) * 4;
          pImg.data[idx] = byte;
          pImg.data[idx + 1] = byte;
          pImg.data[idx + 2] = byte;
          pImg.data[idx + 3] = 255;
        }
      }
      pCtx.putImageData(pImg, 0, 0);
      this.puddleData = pArr;

      const puddleTex = new THREE.CanvasTexture(puddleC);
      puddleTex.wrapS = THREE.ClampToEdgeWrapping;
      puddleTex.wrapT = THREE.ClampToEdgeWrapping;
      puddleTex.needsUpdate = true;

      return {
        asphaltMat: new THREE.MeshPhysicalMaterial({
          map: configureTexture(new THREE.CanvasTexture(diffC), true, 24, 20, this.maxAniso),
          roughnessMap: configureTexture(new THREE.CanvasTexture(roughC), false, 24, 20, this.maxAniso),
          normalMap: configureTexture(new THREE.CanvasTexture(normalC), false, 24, 20, this.maxAniso),
          normalScale: new THREE.Vector2(0.85, 0.85),
          metalness: 0.14,
          roughness: 0.36,
        }),
        puddleTex,
      };
    }

    /**
     * 查询任意世界坐标 (x, z) 的积水深度 [0..1]，供脚步溅水声与弹壳水花判定复用
     */
    samplePuddleMask(wx, wz) {
      if (!this.puddleData) return 0;
      const u = wx / this.worldWidth + 0.5;
      const v = wz / this.worldDepth + 0.5;
      if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return 0;
      const px = Math.min(this.puddleSize - 1, Math.max(0, Math.floor(u * this.puddleSize)));
      // CanvasTexture 默认 flipY = true，纹理 v=0 对应图片底部，直接按世界 Z 对齐采样
      const cy = Math.min(this.puddleSize - 1, Math.max(0, Math.floor(v * this.puddleSize)));
      return this.puddleData[cy * this.puddleSize + px];
    }

    _createBrushedMetalMaterial(hex, roughness = 0.35, metalness = 0.85) {
      const size = 128;
      const c = createCanvas(size, size);
      const rc = createCanvas(size, size);
      const ctx = c.getContext('2d');
      const rCtx = rc.getContext('2d');
      const [br, bg, bb] = hexToRgb(hex);

      for (let y = 0; y < size; y++) {
        const streak = hash2(0, y, 313) * 16 - 8;
        ctx.fillStyle = `rgb(${clampByte(br + streak)},${clampByte(bg + streak)},${clampByte(bb + streak)})`;
        ctx.fillRect(0, y, size, 1);
        const rv = clampByte((roughness + (hash2(1, y, 419) - 0.5) * 0.12) * 255);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(0, y, size, 1);
      }
      return new THREE.MeshPhysicalMaterial({
        map: configureTexture(new THREE.CanvasTexture(c), true, 2, 2, this.maxAniso),
        roughnessMap: configureTexture(new THREE.CanvasTexture(rc), false, 2, 2, this.maxAniso),
        metalness,
        roughness,
      });
    }

    _createGripPolymerMaterial() {
      const size = 128;
      const heights = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const d1 = ((x + y) % 8) < 4 ? 1 : 0;
          const d2 = ((x - y + 128) % 8) < 4 ? 1 : 0;
          heights[y * size + x] = (d1 ^ d2) * 0.5;
        }
      }
      const normC = heightFieldToNormalCanvas(heights, size, size, 1.5);
      return new THREE.MeshPhysicalMaterial({
        color: 0x16191e,
        normalMap: configureTexture(new THREE.CanvasTexture(normC), false, 4, 4, this.maxAniso),
        metalness: 0.15,
        roughness: 0.78,
      });
    }

    _createWoodCrateMaterial() {
      const size = 256;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#5c4228';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 8; i++) {
        const y = i * 32;
        ctx.fillStyle = i % 2 === 0 ? '#694b2d' : '#563c23';
        ctx.fillRect(0, y + 2, size, 28);
        ctx.fillStyle = 'rgba(20,12,6,0.35)';
        ctx.fillRect(0, y, size, 2);
      }
      ctx.strokeStyle = '#3b2917';
      ctx.lineWidth = 18;
      ctx.strokeRect(9, 9, size - 18, size - 18);
      ctx.beginPath();
      ctx.moveTo(12, 12);
      ctx.lineTo(size - 12, size - 12);
      ctx.stroke();

      return new THREE.MeshPhysicalMaterial({
        map: configureTexture(new THREE.CanvasTexture(c), true, 1, 1, this.maxAniso),
        roughness: 0.86,
        metalness: 0.05,
      });
    }

    _createHazardBarrelMaterial() {
      const size = 256;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#8d241b';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#dfb124';
      ctx.fillRect(0, 102, size, 48);
      ctx.fillStyle = '#181818';
      for (let x = -32; x < size + 32; x += 36) {
        ctx.beginPath();
        ctx.moveTo(x, 102);
        ctx.lineTo(x + 18, 102);
        ctx.lineTo(x + 2, 150);
        ctx.lineTo(x - 16, 150);
        ctx.closePath();
        ctx.fill();
      }
      return new THREE.MeshPhysicalMaterial({
        map: configureTexture(new THREE.CanvasTexture(c), true, 1, 1, this.maxAniso),
        roughness: 0.45,
        metalness: 0.65,
      });
    }

    _createEnemyArmorMaterial(baseHex, accentHex, seed) {
      const size = 256;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = baseHex;
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 2;
      for (let i = 32; i < size; i += 48) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }
      ctx.fillStyle = accentHex;
      ctx.fillRect(0, size - 26, size, 12);
      for (let k = 0; k < 28; k++) {
        const sx = hash2(k, 1, seed) * size;
        const sy = hash2(k, 2, seed) * size;
        ctx.fillStyle = 'rgba(210,220,235,0.14)';
        ctx.fillRect(sx, sy, 14, 2);
      }
      return new THREE.MeshPhysicalMaterial({
        map: configureTexture(new THREE.CanvasTexture(c), true, 1, 1, this.maxAniso),
        metalness: 0.78,
        roughness: 0.36,
      });
    }

    _createHoloReticleTexture() {
      const size = 256;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      const mid = size / 2;

      ctx.clearRect(0, 0, size, size);
      ctx.shadowColor = '#ff4b2b';
      ctx.shadowBlur = 6;
      ctx.strokeStyle = 'rgba(255, 101, 59, 0.88)';
      ctx.lineWidth = 3.5;

      // 65 MOA 外环（四段缺口细圆环，不糊视野）
      const r = 56;
      const arcs = [
        [0.24, Math.PI * 0.5 - 0.24],
        [Math.PI * 0.5 + 0.24, Math.PI - 0.24],
        [Math.PI + 0.24, Math.PI * 1.5 - 0.24],
        [Math.PI * 1.5 + 0.24, Math.PI * 2 - 0.24],
      ];
      for (const [a0, a1] of arcs) {
        ctx.beginPath();
        ctx.arc(mid, mid, r, a0, a1);
        ctx.stroke();
      }

      // 精细刻度线
      const ticks = [
        [mid - 74, mid, mid - 46, mid],
        [mid + 46, mid, mid + 74, mid],
        [mid, mid - 74, mid, mid - 46],
        [mid, mid + 46, mid, mid + 74],
      ];
      for (const [x0, y0, x1, y1] of ticks) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // 中心 1 MOA 高亮微点
      ctx.fillStyle = '#ffe5dc';
      ctx.beginPath();
      ctx.arc(mid, mid, 4.0, 0, Math.PI * 2);
      ctx.fill();

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }

    _createReflexCircleTexture() {
      const size = 256;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      const mid = size / 2;

      ctx.clearRect(0, 0, size, size);
      ctx.shadowColor = '#38e6ff';
      ctx.shadowBlur = 7;
      ctx.strokeStyle = 'rgba(72, 232, 255, 0.9)';
      ctx.lineWidth = 4;

      // 霰弹散射开放虚线大环
      const segs = 4;
      for (let i = 0; i < segs; i++) {
        const a0 = i * (Math.PI / 2) + 0.35;
        const a1 = (i + 1) * (Math.PI / 2) - 0.35;
        ctx.beginPath();
        ctx.arc(mid, mid, 76, a0, a1);
        ctx.stroke();
      }

      ctx.fillStyle = '#e8fcff';
      ctx.beginPath();
      ctx.arc(mid, mid, 4.2, 0, Math.PI * 2);
      ctx.fill();

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }

    _createMuzzleFlashTexture() {
      const size = 128;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      const mid = size / 2;
      const grad = ctx.createRadialGradient(mid, mid, 2, mid, mid, mid);
      grad.addColorStop(0, 'rgba(255,252,225,1)');
      grad.addColorStop(0.28, 'rgba(255,180,75,0.92)');
      grad.addColorStop(0.65, 'rgba(255,95,20,0.35)');
      grad.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    _createBulletDecalTexture() {
      const size = 64;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      const mid = size / 2;

      ctx.clearRect(0, 0, size, size);
      // 外圈焦黑弹痕与轻微金属刮白高光
      const scorch = ctx.createRadialGradient(mid, mid, 2, mid, mid, mid * 0.92);
      scorch.addColorStop(0.0, 'rgba(8, 9, 11, 0.96)');
      scorch.addColorStop(0.28, 'rgba(18, 20, 24, 0.85)');
      scorch.addColorStop(0.45, 'rgba(130, 140, 155, 0.32)');
      scorch.addColorStop(0.75, 'rgba(20, 22, 26, 0.16)');
      scorch.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = scorch;
      ctx.beginPath();
      ctx.arc(mid, mid, mid * 0.92, 0, Math.PI * 2);
      ctx.fill();

      // 放射状弹裂细纹
      ctx.strokeStyle = 'rgba(15, 17, 22, 0.68)';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + 0.3;
        const r0 = 5;
        const r1 = 14 + (i % 3) * 4;
        ctx.beginPath();
        ctx.moveTo(mid + Math.cos(ang) * r0, mid + Math.sin(ang) * r0);
        ctx.lineTo(mid + Math.cos(ang) * r1, mid + Math.sin(ang) * r1);
        ctx.stroke();
      }

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }

    _createSmokePuffTexture() {
      const size = 128;
      const c = createCanvas(size, size);
      const ctx = c.getContext('2d');
      const mid = size / 2;
      const g = ctx.createRadialGradient(mid, mid, 4, mid, mid, mid);
      g.addColorStop(0.0, 'rgba(185, 195, 208, 0.55)');
      g.addColorStop(0.45, 'rgba(120, 130, 145, 0.28)');
      g.addColorStop(1.0, 'rgba(60, 70, 82, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }

    _getSurfaceMaterials() {
      const list = [];
      if (this.containers) {
        Object.values(this.containers).forEach((m) => m && list.push(m));
      }
      const singles = [
        this.warehouseWall, this.warehouseRoof, this.concreteFloor,
        this.asphaltData && this.asphaltData.asphaltMat,
        this.metalFrame, this.craneYellow, this.woodCrate,
        this.hazardBarrel, this.boatHull, this.gunMetal,
        this.gunPolymer, this.droneArmor, this.houndArmor,
      ];
      for (const m of singles) {
        if (m) list.push(m);
      }
      return list;
    }

    upgradeForExtreme(baker, maxAniso = 16, prebaked = null) {
      if (!baker && !prebaked) return null;
      const targetAniso = Math.min(16, Math.max(4, maxAniso || 8));

      if (!this._stdBackup) {
        this._stdBackup = {
          asphalt: this.asphaltData && this.asphaltData.asphaltMat ? {
            map: this.asphaltData.asphaltMat.map,
            roughnessMap: this.asphaltData.asphaltMat.roughnessMap,
            normalMap: this.asphaltData.asphaltMat.normalMap,
            roughness: this.asphaltData.asphaltMat.roughness,
          } : null,
          concrete: this.concreteFloor ? {
            map: this.concreteFloor.map,
            roughnessMap: this.concreteFloor.roughnessMap,
            normalMap: this.concreteFloor.normalMap,
            roughness: this.concreteFloor.roughness,
          } : null,
          matProps: new Map(),
          texAniso: new Map(),
        };
        for (const m of this._getSurfaceMaterials()) {
          this._stdBackup.matProps.set(m, {
            clearcoat: m.clearcoat || 0,
            clearcoatRoughness: m.clearcoatRoughness || 0,
            anisotropy: m.anisotropy || 0,
            anisotropyRotation: m.anisotropyRotation || 0,
            sheen: m.sheen || 0,
            sheenRoughness: m.sheenRoughness || 0,
          });
          for (const key of ['map', 'roughnessMap', 'normalMap']) {
            const t = m[key];
            if (t && !this._stdBackup.texAniso.has(t)) {
              this._stdBackup.texAniso.set(t, t.anisotropy || this.maxAniso);
            }
          }
        }
      }

      if (prebaked) {
        this._extremeBaked = prebaked;
      } else if (!this._extremeBaked) {
        this._extremeBaked = (baker.cachedAssets) ? baker.cachedAssets : baker.bakeExtremeAssets(targetAniso);
      }

      if (this.asphaltData && this.asphaltData.asphaltMat) {
        const am = this.asphaltData.asphaltMat;
        am.map = this._extremeBaked.asphaltDiff;
        am.roughnessMap = this._extremeBaked.asphaltRough;
        am.normalMap = this._extremeBaked.asphaltNorm;
        am.roughness = 0.34;
        am.clearcoat = 0.34;
        am.clearcoatRoughness = 0.14;
        am.userData = { ...(am.userData || {}), isPorous: true, isAsphalt: true };
        am.needsUpdate = true;
      }

      if (this.concreteFloor) {
        const cm = this.concreteFloor;
        cm.map = this._extremeBaked.concreteDiff;
        cm.roughnessMap = this._extremeBaked.concreteRough;
        cm.normalMap = this._extremeBaked.concreteNorm;
        cm.roughness = 0.78;
        cm.clearcoat = 0.0;
        cm.clearcoatRoughness = 0.0;
        cm.userData = { ...(cm.userData || {}), isPorous: true };
        cm.needsUpdate = true;
      }

      if (this.woodCrate) this.woodCrate.userData = { ...(this.woodCrate.userData || {}), isPorous: true };
      if (this.warehouseWall) {
        this.warehouseWall.clearcoat = 0.0;
        this.warehouseWall.clearcoatRoughness = 0.0;
      }
      if (this.warehouseRoof) {
        this.warehouseRoof.clearcoat = 0.0;
        this.warehouseRoof.clearcoatRoughness = 0.0;
      }
      if (this.containers) {
        Object.values(this.containers).forEach((m) => {
          m.clearcoat = 0.62;
          m.clearcoatRoughness = 0.14;
          m.needsUpdate = true;
        });
      }
      if (this.craneYellow) {
        this.craneYellow.clearcoat = 0.55;
        this.craneYellow.clearcoatRoughness = 0.18;
      }
      if (this.hazardBarrel) {
        this.hazardBarrel.clearcoat = 0.72;
        this.hazardBarrel.clearcoatRoughness = 0.12;
      }
      if (this.metalFrame) {
        this.metalFrame.anisotropy = 0.0;
        this.metalFrame.anisotropyRotation = 0.0;
        this.metalFrame.clearcoat = 0.0;
        this.metalFrame.clearcoatRoughness = 0.0;
      }
      if (this.boatHull) {
        this.boatHull.clearcoat = 0.68;
        this.boatHull.clearcoatRoughness = 0.15;
      }
      if (this.gunMetal) {
        this.gunMetal.anisotropy = 0.76;
        this.gunMetal.anisotropyRotation = 0.0;
        this.gunMetal.clearcoat = 0.34;
        this.gunMetal.clearcoatRoughness = 0.22;
      }
      if (this.gunPolymer) {
        this.gunPolymer.clearcoat = 0.0;
        this.gunPolymer.clearcoatRoughness = 0.0;
      }
      if (this.droneArmor) {
        this.droneArmor.clearcoat = 0.56;
        this.droneArmor.clearcoatRoughness = 0.18;
        this.droneArmor.anisotropy = 0.0;
      }
      if (this.houndArmor) {
        this.houndArmor.clearcoat = 0.56;
        this.houndArmor.clearcoatRoughness = 0.18;
        this.houndArmor.anisotropy = 0.0;
      }

      for (const m of this._getSurfaceMaterials()) {
        for (const key of ['map', 'roughnessMap', 'normalMap']) {
          const t = m[key];
          if (t && t.anisotropy !== targetAniso) {
            t.anisotropy = targetAniso;
            t.needsUpdate = true;
          }
        }
        m.needsUpdate = true;
      }

      return this._extremeBaked;
    }

    restoreStandardQuality() {
      if (!this._stdBackup) return;
      if (this.asphaltData && this.asphaltData.asphaltMat && this._stdBackup.asphalt) {
        const am = this.asphaltData.asphaltMat;
        am.map = this._stdBackup.asphalt.map;
        am.roughnessMap = this._stdBackup.asphalt.roughnessMap;
        am.normalMap = this._stdBackup.asphalt.normalMap;
        am.roughness = this._stdBackup.asphalt.roughness;
      }
      if (this.concreteFloor && this._stdBackup.concrete) {
        const cm = this.concreteFloor;
        cm.map = this._stdBackup.concrete.map;
        cm.roughnessMap = this._stdBackup.concrete.roughnessMap;
        cm.normalMap = this._stdBackup.concrete.normalMap;
        cm.roughness = this._stdBackup.concrete.roughness;
      }
      for (const [m, orig] of this._stdBackup.matProps.entries()) {
        Object.assign(m, orig);
        m.needsUpdate = true;
      }
      for (const [t, aniso] of this._stdBackup.texAniso.entries()) {
        if (t && t.anisotropy !== aniso) {
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
    }
  }

  return Factory;
})();
