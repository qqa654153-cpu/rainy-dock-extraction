// ============================================================================
// 模块 3B：极限画质 (Extreme) 3A 级渲染管线与 GPU 程序化 PBR 合成器
// 包含：
//   1. GpuPbrBaker           - 2-Pass Height->Normal + 异步分帧 PBR 贴图与 PMREM 烘焙
//   2. ExtremeMaterialManager- 预烘焙噪声微法线/雨痕/地面水洼涟漪 + MRT G-Buffer 注入
//   3. ExtremeRenderPipeline - WebGL2 MRT + Half-Res LinearZ + 时空重投影(AO/SSR/体积雾)
//                              + Dual-Kawase 4级 Bloom + AgX + FXAA 3.11 + RCAS 上采样
// ============================================================================

const ExtremeGfx = (() => {
  'use strict';

  const _warmupText = (key, fallback, params) => {
    const i18n = typeof I18n !== 'undefined' ? I18n : (typeof window !== 'undefined' ? window.I18n : null);
    return i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : fallback;
  };

  const FULLSCREEN_VERT = /* glsl */ `
    out vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  async function yieldToMainThread(useRaf = true) {
    if (useRaf && typeof requestAnimationFrame === 'function') {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return;
    }
    if (typeof window !== 'undefined' && window.scheduler && typeof window.scheduler.yield === 'function') {
      await window.scheduler.yield();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function detectCapabilities(renderer) {
    const gl = renderer && renderer.getContext ? renderer.getContext() : null;
    const isWebGL2 = !!(renderer && renderer.capabilities && renderer.capabilities.isWebGL2);
    if (!gl || !isWebGL2) {
      return { supported: false, reason: 'WebGL2 unavailable', maxAniso: 4, maxTexSize: 2048 };
    }
    const hasColorFloat = !!(
      gl.getExtension('EXT_color_buffer_float') ||
      gl.getExtension('EXT_color_buffer_half_float')
    );
    const hasLinearHalf = !!(
      gl.getExtension('OES_texture_half_float_linear') ||
      gl.getExtension('OES_texture_float_linear') ||
      isWebGL2
    );
    const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS) || 1;
    const maxAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) || 1;
    const maxAniso = renderer.capabilities.getMaxAnisotropy
      ? Math.min(16, renderer.capabilities.getMaxAnisotropy() || 8)
      : 8;
    const maxTexSize = renderer.capabilities.maxTextureSize || 4096;
    const mrtOk = maxDrawBuffers >= 3 && maxAttachments >= 3;
    return {
      supported: hasColorFloat && hasLinearHalf && mrtOk,
      reason: !hasColorFloat ? 'Missing EXT_color_buffer_float' : (!mrtOk ? 'Insufficient MRT attachments' : 'ok'),
      maxAniso,
      maxTexSize,
    };
  }

  // --------------------------------------------------------------------------
  // 1. GPU 程序化 PBR 贴图与高动态暮色 HDRI 环境贴图烘焙器 (支持分帧异步烘焙)
  // --------------------------------------------------------------------------
  const BAKER_NOISE_LIB = /* glsl */ `
    float hash21(vec2 p, float seed) {
      p = fract(p * vec2(234.34, 435.345) + seed * 0.137);
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float vnoiseTile(vec2 uv, float freq, float seed) {
      vec2 p = uv * freq;
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash21(mod(i, freq), seed);
      float b = hash21(mod(i + vec2(1.0, 0.0), freq), seed);
      float c = hash21(mod(i + vec2(0.0, 1.0), freq), seed);
      float d = hash21(mod(i + vec2(1.0, 1.0), freq), seed);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbmTile(vec2 uv, float baseFreq, float seed) {
      float s = 0.0;
      float a = 0.5;
      float f = baseFreq;
      for (int i = 0; i < 5; i++) {
        s += a * vnoiseTile(uv, f, seed + float(i) * 17.0);
        f *= 2.0;
        a *= 0.5;
      }
      return s;
    }
    float voronoiTile(vec2 uv, float freq, float seed) {
      vec2 p = uv * freq;
      vec2 n = floor(p);
      vec2 f = fract(p);
      float md = 8.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 cell = mod(n + g, freq);
          vec2 o = vec2(hash21(cell, seed), hash21(cell + 19.3, seed + 5.0));
          vec2 r = g + o - f;
          md = min(md, dot(r, r));
        }
      }
      return sqrt(md);
    }
  `;

  class GpuPbrBaker {
    constructor(renderer) {
      this.renderer = renderer;
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      this.quad.frustumCulled = false;
      this.scene.add(this.quad);
      this.disposables = [];
      this.cachedAssets = null;
    }

    _bakeTargetRt(w, h, fragmentShader, uniforms = {}, opts = {}) {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: opts.type || THREE.UnsignedByteType,
        colorSpace: opts.isColor ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace,
        minFilter: opts.nearest ? THREE.NearestFilter : (opts.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter),
        magFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
        wrapS: opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
        wrapT: opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
        generateMipmaps: !!opts.generateMipmaps,
        depthBuffer: false,
      });
      if (opts.anisotropy) {
        rt.texture.anisotropy = opts.anisotropy;
      }

      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader,
      });

      const prevTarget = this.renderer.getRenderTarget();
      const prevAutoClear = this.renderer.autoClear;
      this.quad.material = mat;
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.autoClear = prevAutoClear;

      mat.dispose();
      if (!opts.transient) {
        this.disposables.push(rt);
      }
      return rt;
    }

    _bakeTarget(w, h, fragmentShader, uniforms = {}, opts = {}) {
      return this._bakeTargetRt(w, h, fragmentShader, uniforms, opts).texture;
    }

    _createBakeSteps(maxAniso = 16) {
      const state = {
        asphaltBaseRt: null,
        concreteBaseRt: null,
        hdrEquirectRt: null,
        assets: {},
        aniso: Math.min(16, Math.max(4, maxAniso || 8)),
      };

      const steps = [
        {
          label: _warmupText('warmup.bakeMicroNoise', '烘焙微表面细节噪点'),
          run: () => {
            state.assets.detailNoise = this._bakeTarget(256, 256, /* glsl */ `
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                float r = fbmTile(vUv, 16.0, 13.7);
                float g = vnoiseTile(vUv, 48.0, 51.3) * 0.65 + vnoiseTile(vUv, 96.0, 91.1) * 0.35;
                float b = 1.0 - smoothstep(0.0, 0.72, voronoiTile(vUv, 24.0, 7.1));
                fragColor = vec4(r, g, b, 1.0);
              }
            `, {}, { isColor: false, generateMipmaps: true, repeat: true, anisotropy: Math.min(8, state.aniso) });
          },
        },
        {
          label: _warmupText('warmup.bakeAsphaltHeight', '烘焙湿滑沥青高度场'),
          run: () => {
            state.asphaltBaseRt = this._bakeTargetRt(1024, 1024, /* glsl */ `
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                float pebble = 1.0 - smoothstep(0.0, 0.55, voronoiTile(vUv, 110.0, 3.1));
                float fine = fbmTile(vUv, 48.0, 11.7);
                float crack = smoothstep(0.020, 0.0, abs(fbmTile(vUv, 4.0, 71.0) - 0.5));
                float h = pebble * 0.42 + fine * 0.32 - crack * 0.55;
                fragColor = vec4(h, pebble, fine, crack);
              }
            `, {}, { type: THREE.HalfFloatType, nearest: true, generateMipmaps: false, transient: true });
          },
        },
        {
          label: _warmupText('warmup.synthAsphaltMaps', '合成沥青漫反射与粗糙度'),
          run: () => {
            const baseTex = state.asphaltBaseRt.texture;
            state.assets.asphaltDiff = this._bakeTarget(1024, 1024, /* glsl */ `
              uniform sampler2D tBase;
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                vec4 b = texelFetch(tBase, ivec2(gl_FragCoord.xy), 0);
                float pebble = b.g;
                float grit = b.b;
                float crack = b.a;
                float stain = fbmTile(vUv, 5.0, 29.3);
                vec3 col = mix(vec3(0.008, 0.010, 0.014), vec3(0.024, 0.028, 0.035), grit * 0.6 + pebble * 0.4);
                col *= mix(0.70, 1.12, stain);
                col *= (1.0 - crack * 0.62);
                fragColor = vec4(col, 1.0);
              }
            `, { tBase: { value: baseTex } }, { isColor: true, generateMipmaps: true, repeat: true, anisotropy: state.aniso });

            state.assets.asphaltRough = this._bakeTarget(1024, 1024, /* glsl */ `
              uniform sampler2D tBase;
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                vec4 b = texelFetch(tBase, ivec2(gl_FragCoord.xy), 0);
                float pebble = b.g;
                float oilPatch = smoothstep(0.42, 0.68, fbmTile(vUv, 4.0, 41.0));
                float fineR = fbmTile(vUv, 48.0, 19.0);
                float rough = mix(0.12, 0.44, pebble * 0.65 + fineR * 0.35);
                rough = mix(rough, 0.07, oilPatch * 0.72);
                fragColor = vec4(vec3(rough), 1.0);
              }
            `, { tBase: { value: baseTex } }, { isColor: false, generateMipmaps: true, repeat: true, anisotropy: state.aniso });
          },
        },
        {
          label: _warmupText('warmup.genAsphaltNormal', '生成沥青高精度法线贴图'),
          run: () => {
            const baseTex = state.asphaltBaseRt.texture;
            state.assets.asphaltNorm = this._bakeTarget(1024, 1024, /* glsl */ `
              uniform sampler2D tBase;
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              void main() {
                ivec2 c = ivec2(gl_FragCoord.xy);
                float hL = texelFetch(tBase, (c + ivec2(1023, 0)) & 1023, 0).r;
                float hR = texelFetch(tBase, (c + ivec2(1, 0)) & 1023, 0).r;
                float hD = texelFetch(tBase, (c + ivec2(0, 1023)) & 1023, 0).r;
                float hU = texelFetch(tBase, (c + ivec2(0, 1)) & 1023, 0).r;
                vec3 n = normalize(vec3((hL - hR) * 0.95, (hD - hU) * 0.95, 1.0));
                fragColor = vec4(n * 0.5 + 0.5, 1.0);
              }
            `, { tBase: { value: baseTex } }, { isColor: false, generateMipmaps: true, repeat: true, anisotropy: state.aniso });
            state.asphaltBaseRt.dispose();
            state.asphaltBaseRt = null;
          },
        },
        {
          label: _warmupText('warmup.bakeConcreteBase', '烘焙工业水泥地坪材质'),
          run: () => {
            state.concreteBaseRt = this._bakeTargetRt(1024, 1024, /* glsl */ `
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                float n1 = fbmTile(vUv, 14.0, 77.0);
                float n2 = fbmTile(vUv, 32.0, 93.0);
                vec2 g = abs(fract(vUv * 4.0) - 0.5);
                float seam = smoothstep(0.484, 0.494, max(g.x, g.y));
                float h = n1 * 0.35 + n2 * 0.22 - seam * 0.55;
                fragColor = vec4(h, n1, n2, seam);
              }
            `, {}, { type: THREE.HalfFloatType, nearest: true, generateMipmaps: false, transient: true });

            state.assets.concreteDiff = this._bakeTarget(1024, 1024, /* glsl */ `
              uniform sampler2D tBase;
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                vec4 b = texelFetch(tBase, ivec2(gl_FragCoord.xy), 0);
                float n1 = mix(fbmTile(vUv, 6.0, 77.0), b.g, 0.35);
                float tire = smoothstep(0.14, 0.0, abs(vUv.x - 0.52 + sin(vUv.y * 6.283) * 0.04));
                vec3 base = mix(vec3(0.035, 0.040, 0.048), vec3(0.072, 0.078, 0.090), n1 * 0.65 + b.b * 0.35);
                base = mix(base, vec3(0.016, 0.018, 0.022), b.a * 0.72 + tire * 0.22);
                fragColor = vec4(base, 1.0);
              }
            `, { tBase: { value: state.concreteBaseRt.texture } }, { isColor: true, generateMipmaps: true, repeat: true, anisotropy: state.aniso });
          },
        },
        {
          label: _warmupText('warmup.synthConcreteMaps', '合成水泥粗糙度与法线'),
          run: () => {
            const baseTex = state.concreteBaseRt.texture;
            state.assets.concreteRough = this._bakeTarget(1024, 1024, /* glsl */ `
              uniform sampler2D tBase;
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                float n1 = fbmTile(vUv, 8.0, 81.0);
                float polish = smoothstep(0.45, 0.75, fbmTile(vUv, 3.0, 12.0));
                float r = mix(0.46, 0.88, n1 * 0.7 + (1.0 - polish) * 0.3);
                fragColor = vec4(vec3(r), 1.0);
              }
            `, { tBase: { value: baseTex } }, { isColor: false, generateMipmaps: true, repeat: true, anisotropy: state.aniso });

            state.assets.concreteNorm = this._bakeTarget(1024, 1024, /* glsl */ `
              uniform sampler2D tBase;
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              void main() {
                ivec2 c = ivec2(gl_FragCoord.xy);
                float hL = texelFetch(tBase, (c + ivec2(1023, 0)) & 1023, 0).r;
                float hR = texelFetch(tBase, (c + ivec2(1, 0)) & 1023, 0).r;
                float hD = texelFetch(tBase, (c + ivec2(0, 1023)) & 1023, 0).r;
                float hU = texelFetch(tBase, (c + ivec2(0, 1)) & 1023, 0).r;
                vec3 n = normalize(vec3((hL - hR) * 2.8, (hD - hU) * 2.8, 1.0));
                fragColor = vec4(n * 0.5 + 0.5, 1.0);
              }
            `, { tBase: { value: baseTex } }, { isColor: false, generateMipmaps: true, repeat: true, anisotropy: state.aniso });

            state.concreteBaseRt.dispose();
            state.concreteBaseRt = null;
          },
        },
        {
          label: _warmupText('warmup.bakeHdrProbe', '烘焙暮色 HDR 环境光探针'),
          run: () => {
            state.hdrEquirectRt = this._bakeTargetRt(512, 256, /* glsl */ `
              in vec2 vUv;
              layout(location = 0) out vec4 fragColor;
              ${BAKER_NOISE_LIB}
              void main() {
                float phi = (vUv.x - 0.5) * 6.2831853;
                float theta = (1.0 - vUv.y) * 3.14159265;
                vec3 d = normalize(vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi)));
                vec3 sunDir = normalize(vec3(-0.82, 0.14, -0.55));
                float h = clamp(d.y, -1.0, 1.0);
                vec3 skyCol = mix(vec3(0.04, 0.075, 0.14), vec3(0.015, 0.028, 0.065), pow(max(h, 0.0), 0.55));
                float clouds = fbmTile(vec2(vUv.x * 2.0, max(0.01, h) * 1.4), 4.0, 5.0);
                float sunDot = max(0.0, dot(d, sunDir));
                skyCol += vec3(1.15, 0.48, 0.16) * pow(sunDot, 5.0) * 1.45 * (1.1 - clouds * 0.45);
                skyCol += vec3(6.5, 3.2, 1.35) * pow(sunDot, 64.0);
                vec3 craneDir = normalize(vec3(0.62, 0.34, 0.25));
                skyCol += vec3(1.8, 2.9, 4.2) * pow(max(0.0, dot(d, craneDir)), 28.0);
                vec3 sodiumDir = normalize(vec3(-0.45, 0.16, -0.68));
                skyCol += vec3(2.4, 1.35, 0.45) * pow(max(0.0, dot(d, sodiumDir)), 24.0);
                vec3 groundCol = mix(vec3(0.025, 0.038, 0.062), vec3(0.01, 0.015, 0.024), clamp(-h * 2.5, 0.0, 1.0));
                vec3 finalCol = h >= 0.0 ? skyCol : mix(skyCol * 0.45, groundCol, smoothstep(0.0, -0.18, h));
                fragColor = vec4(finalCol, 1.0);
              }
            `, {}, { type: THREE.HalfFloatType, isColor: false, generateMipmaps: false, repeat: false, transient: true });

            const pmrem = new THREE.PMREMGenerator(this.renderer);
            const envRt = pmrem.fromEquirectangular(state.hdrEquirectRt.texture);
            pmrem.dispose();
            state.hdrEquirectRt.dispose();
            state.hdrEquirectRt = null;
            this.disposables.push(envRt);
            state.assets.extremeEnvMap = envRt.texture;
          },
        },
      ];

      const cleanupTransients = () => {
        if (state.asphaltBaseRt) { state.asphaltBaseRt.dispose(); state.asphaltBaseRt = null; }
        if (state.concreteBaseRt) { state.concreteBaseRt.dispose(); state.concreteBaseRt = null; }
        if (state.hdrEquirectRt) { state.hdrEquirectRt.dispose(); state.hdrEquirectRt = null; }
      };

      const finalize = () => {
        const a = state.assets;
        if (a.asphaltDiff) {
          a.asphaltDiff.repeat.set(24, 20);
          a.asphaltRough.repeat.set(24, 20);
          a.asphaltNorm.repeat.set(24, 20);
        }
        if (a.concreteDiff) {
          a.concreteDiff.repeat.set(4, 4);
          a.concreteRough.repeat.set(4, 4);
          a.concreteNorm.repeat.set(4, 4);
        }
        this.cachedAssets = a;
        return a;
      };

      return { steps, cleanupTransients, finalize };
    }

    bakeExtremeAssets(maxAniso = 16) {
      if (this.cachedAssets) return this.cachedAssets;
      const { steps, finalize } = this._createBakeSteps(maxAniso);
      for (const s of steps) s.run();
      return finalize();
    }

    async bakeExtremeAssetsAsync(maxAniso = 16, onProgress = null, isCancelled = null) {
      if (this.cachedAssets) {
        if (onProgress) onProgress(1.0, _warmupText('warmup.reusePbr', '复用已烘焙 PBR 纹理'));
        return this.cachedAssets;
      }
      const { steps, cleanupTransients, finalize } = this._createBakeSteps(maxAniso);
      try {
        for (let i = 0; i < steps.length; i++) {
          if (isCancelled && isCancelled()) {
            cleanupTransients();
            return null;
          }
          if (onProgress) onProgress(i / steps.length, steps[i].label);
          steps[i].run();
          if (i + 1 < steps.length) {
            await yieldToMainThread(true);
          }
        }
        if (isCancelled && isCancelled()) {
          cleanupTransients();
          return null;
        }
        const res = finalize();
        if (onProgress) onProgress(1.0, _warmupText('warmup.bakeComplete', 'PBR 纹理烘焙完成'));
        return res;
      } catch (err) {
        cleanupTransients();
        throw err;
      }
    }

    dispose() {
      for (const d of this.disposables) {
        if (d && d.dispose) d.dispose();
      }
      this.disposables.length = 0;
      this.cachedAssets = null;
      if (this.quad && this.quad.geometry) this.quad.geometry.dispose();
    }
  }

  // --------------------------------------------------------------------------
  // 2. 物理材质升级与世界空间微法线 / 雨痕 / 沥青水洼涟漪 / MRT G-Buffer 注入器
  // --------------------------------------------------------------------------
  class ExtremeMaterialManager {
    constructor() {
      const noiseData = new Uint8Array(4 * 4 * 4);
      for (let i = 0; i < noiseData.length; i += 4) {
        noiseData[i] = 128;
        noiseData[i + 1] = 128;
        noiseData[i + 2] = 128;
        noiseData[i + 3] = 255;
      }
      this._fallbackNoise = new THREE.DataTexture(noiseData, 4, 4, THREE.RGBAFormat);
      this._fallbackNoise.wrapS = THREE.RepeatWrapping;
      this._fallbackNoise.wrapT = THREE.RepeatWrapping;
      this._fallbackNoise.needsUpdate = true;

      const blackData = new Uint8Array([0, 0, 0, 255]);
      this._fallbackPuddle = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
      this._fallbackPuddle.needsUpdate = true;

      this._fallbackRainOcc = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      this._fallbackRainOcc.flipY = false;
      this._fallbackRainOcc.minFilter = THREE.NearestFilter;
      this._fallbackRainOcc.magFilter = THREE.NearestFilter;
      this._fallbackRainOcc.wrapS = THREE.ClampToEdgeWrapping;
      this._fallbackRainOcc.wrapT = THREE.ClampToEdgeWrapping;
      this._fallbackRainOcc.needsUpdate = true;

      this.sharedUniforms = {
        uExtTime: { value: 0 },
        uExtMrtActive: { value: 1 },
        uExtWetness: { value: 1.0 },
        uExtDetailNoise: { value: this._fallbackNoise },
        uExtPuddleMap: { value: this._fallbackPuddle },
        uExtWorldSize: { value: new THREE.Vector2(110, 90) },
        uExtRainOccMap: { value: this._fallbackRainOcc },
        uExtRainOccBounds: { value: new THREE.Vector4(-55, -45, 1 / 110, 1 / 90) },
        uExtRainOccMaxH: { value: 24.0 },
      };
      this.patchedMaterials = new WeakSet();
      this.upgradedMaterials = new Map();
    }

    setBakedDetailNoise(tex) {
      if (tex) {
        this.sharedUniforms.uExtDetailNoise.value = tex;
      }
    }

    setPuddleMap(tex, worldW = 110, worldD = 90) {
      if (tex) {
        this.sharedUniforms.uExtPuddleMap.value = tex;
      }
      this.sharedUniforms.uExtWorldSize.value.set(worldW || 110, worldD || 90);
    }

    setRainOcclusionMap(tex, boundsVec4, maxHeight = 24) {
      this.sharedUniforms.uExtRainOccMap.value = tex || this._fallbackRainOcc;
      if (boundsVec4 && this.sharedUniforms.uExtRainOccBounds.value) {
        this.sharedUniforms.uExtRainOccBounds.value.copy(boundsVec4);
      }
      this.sharedUniforms.uExtRainOccMaxH.value = (Number.isFinite(maxHeight) && maxHeight > 0) ? maxHeight : 24.0;
    }

    /**
     * 注入预烘焙细节微法线、户外湿滑雨水流痕、地面水洼动态涟漪及 MRT location=1 法线/粗糙度输出
     */
    patchMaterialForExtreme(mat, opts = {}) {
      if (!mat || mat.transparent || mat.isShaderMaterial || mat.isLineBasicMaterial) return mat;
      if (this.patchedMaterials.has(mat)) {
        if (mat.userData && mat.userData._extEnablePatch) {
          mat.userData._extEnablePatch();
        }
        return mat;
      }
      this.patchedMaterials.add(mat);

      const isBasic = !!mat.isMeshBasicMaterial;
      const isViewmodel = !!opts.isViewmodel;
      const isPorous = !!opts.isPorous;
      const isAsphalt = !!(opts.isAsphalt || (mat.userData && mat.userData.isAsphalt));
      const rainStreakScale = opts.rainStreakScale !== undefined ? opts.rainStreakScale : (isViewmodel ? 0.15 : 1.0);
      const prevCompile = mat.onBeforeCompile;
      const prevCacheKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
      const shared = this.sharedUniforms;

      const extCacheKey = () => {
        const base = prevCacheKey ? prevCacheKey() : '';
        return `${base}_EXT_MRT2_${isBasic ? 'B' : 'P'}_${isViewmodel ? 'VM' : 'W'}_${isPorous ? 'POR' : 'MET'}_${isAsphalt ? 'ASP' : 'STD'}`;
      };

      const extCompile = (shader, renderer) => {
        if (prevCompile) prevCompile.call(mat, shader, renderer);
        shader.uniforms.uExtTime = shared.uExtTime;
        shader.uniforms.uExtWetness = shared.uExtWetness;
        shader.uniforms.uExtDetailNoise = shared.uExtDetailNoise;
        shader.uniforms.uExtPuddleMap = shared.uExtPuddleMap;
        shader.uniforms.uExtWorldSize = shared.uExtWorldSize;
        shader.uniforms.uExtRainOccMap = shared.uExtRainOccMap;
        shader.uniforms.uExtRainOccBounds = shared.uExtRainOccBounds;
        shader.uniforms.uExtRainOccMaxH = shared.uExtRainOccMaxH;

        if (!isBasic) {
          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              `#include <common>
              varying vec3 vExtWorldPos;
              varying vec3 vExtWorldNormal;
              varying vec3 vExtLocalPos;
              ${isAsphalt ? `
              varying vec3 vExtViewAxisX;
              varying vec3 vExtViewAxisY;
              varying vec3 vExtViewAxisZ;` : ''}`
            )
            .replace(
              '#include <project_vertex>',
              `#include <project_vertex>
              vExtLocalPos = transformed;
              vec4 extWp = vec4(transformed, 1.0);
              #ifdef USE_INSTANCING
                extWp = instanceMatrix * extWp;
              #endif
              extWp = modelMatrix * extWp;
              vExtWorldPos = extWp.xyz;
              vec3 extWn = objectNormal;
              #ifdef USE_INSTANCING
                extWn = mat3(instanceMatrix) * extWn;
              #endif
              vExtWorldNormal = normalize(mat3(modelMatrix) * extWn);
              ${isAsphalt ? `
              vExtViewAxisX = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
              vExtViewAxisY = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
              vExtViewAxisZ = normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);` : ''}`
            );

          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
              layout(location = 1) out highp vec4 gNormalRough;
              uniform float uExtTime;
              uniform float uExtWetness;
              uniform sampler2D uExtDetailNoise;
              uniform sampler2D uExtPuddleMap;
              uniform vec2 uExtWorldSize;
              uniform sampler2D uExtRainOccMap;
              uniform vec4 uExtRainOccBounds;
              uniform float uExtRainOccMaxH;
              varying vec3 vExtWorldPos;
              varying vec3 vExtWorldNormal;
              varying vec3 vExtLocalPos;
              ${isAsphalt ? `
              varying vec3 vExtViewAxisX;
              varying vec3 vExtViewAxisY;
              varying vec3 vExtViewAxisZ;

              float extHash21(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
              }

              vec2 extHash22(vec2 p) {
                vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
                p3 += dot(p3, p3.yzx + 33.33);
                return fract((p3.xx + p3.yz) * p3.zy);
              }

              vec2 extRainRipples(vec2 xz, float time) {
                vec2 grad = vec2(0.0);
                const mat2 rot1 = mat2(0.80, 0.60, -0.60, 0.80);
                const mat2 rot1T = mat2(0.80, -0.60, 0.60, 0.80);
                const mat2 rot2 = mat2(-0.470588, 0.882353, -0.882353, -0.470588);
                const mat2 rot2T = mat2(-0.470588, -0.882353, 0.882353, -0.470588);
                for (int layer = 0; layer < 3; layer++) {
                  float scale = layer == 0 ? 1.75 : (layer == 1 ? 3.05 : 4.95);
                  float weight = layer == 0 ? 0.15 : (layer == 1 ? 0.105 : 0.068);
                  float sparsity = layer == 0 ? 0.44 : (layer == 1 ? 0.50 : 0.56);
                  vec2 p = xz * scale;
                  if (layer == 1) p = rot1 * p + vec2(7.3, 13.1);
                  else if (layer == 2) p = rot2 * p + vec2(19.7, 5.9);

                  vec2 anchor = floor(p - 0.5);
                  vec2 layerGrad = vec2(0.0);
                  for (int j = 0; j < 2; j++) {
                    for (int i = 0; i < 2; i++) {
                      vec2 cell = anchor + vec2(float(i), float(j));
                      vec2 hCell = extHash22(cell + float(layer) * 29.7);
                      float speed = mix(0.82, 1.32, hCell.x);
                      float localT = time * speed + hCell.y;
                      float cycle = floor(localT);
                      float t = fract(localT);

                      vec2 cycleSeed = cell + vec2(cycle * 17.13 + float(layer) * 41.3, cycle * 7.91);
                      float activeRnd = extHash21(cycleSeed);
                      if (activeRnd > sparsity) continue;

                      vec2 jitter = extHash22(cycleSeed + vec2(3.7, 11.3));
                      vec2 center = cell + 0.22 + jitter * 0.56;
                      vec2 d = p - center;
                      float dist = length(d);
                      if (dist > 0.66) continue;

                      float borderCut = smoothstep(0.66, 0.42, dist);
                      vec2 radDir = d / (dist + 0.015);

                      float lifeEnv = smoothstep(0.0, 0.045, t) * smoothstep(0.96, 0.24, t);
                      float r1 = 0.03 + t * 0.47;
                      float dr1 = dist - r1;
                      float wave1 = sin(dr1 * 56.0) * exp(-dr1 * dr1 * 210.0);

                      float t2 = max(0.0, t - 0.07);
                      float r2 = 0.015 + t2 * 0.34;
                      float dr2 = dist - r2;
                      float wave2 = sin(dr2 * 38.0) * exp(-dr2 * dr2 * 115.0) * smoothstep(0.07, 0.18, t) * 0.62;

                      float ringSlope = (wave1 + wave2) * lifeEnv;

                      float glintEnv = smoothstep(0.0, 0.02, t) * smoothstep(0.14, 0.03, t);
                      vec2 glintGrad = d * (exp(-dist * dist * 200.0) * glintEnv * 18.0 * sin(t * 42.0 + 0.4));

                      layerGrad += (radDir * ringSlope + glintGrad) * borderCut;
                    }
                  }
                  if (layer == 1) layerGrad = rot1T * layerGrad;
                  else if (layer == 2) layerGrad = rot2T * layerGrad;
                  grad += layerGrad * weight;
                }
                return grad;
              }` : ''}

              vec2 extOctEncode(vec3 n) {
                n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-6);
                if (n.z < 0.0) {
                  vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
                  n.xy = (1.0 - abs(n.yx)) * s;
                }
                return n.xy * 0.5 + 0.5;
              }`
            )
            .replace(
              '#include <map_fragment>',
              `#include <map_fragment>
              float dxWh = max(-22.0 - vExtWorldPos.x, max(0.0, vExtWorldPos.x + 2.0));
              float dzWh = max(-32.0 - vExtWorldPos.z, max(0.0, vExtWorldPos.z + 14.0));
              float extOutdoorMask = ${isViewmodel ? '0.25' : 'smoothstep(0.3, 2.2, length(vec2(dxWh, dzWh)))'};
              float extPorousMask = ${isPorous ? '0.32' : '0.12'};
              float extTopWet = clamp(vExtWorldNormal.y * 0.7 + 0.35, 0.0, 1.0);
              diffuseColor.rgb *= (1.0 - extPorousMask * extOutdoorMask * extTopWet * uExtWetness);
              ${isAsphalt ? `
              vec2 extPuddleUv = clamp(vec2(vExtWorldPos.x / uExtWorldSize.x + 0.5, 1.0 - (vExtWorldPos.z / uExtWorldSize.y + 0.5)), 0.0, 1.0);
              float extPuddle = texture2D(uExtPuddleMap, extPuddleUv).r * smoothstep(0.65, 0.92, vExtWorldNormal.y) * extOutdoorMask * uExtWetness;
              diffuseColor.rgb *= (1.0 - extPuddle * 0.42);` : ''}`
            )
            .replace(
              '#include <roughnessmap_fragment>',
              `#include <roughnessmap_fragment>
              vec3 extWn = normalize(vExtWorldNormal);
              float extVert = 1.0 - abs(extWn.y);
              vec2 extWallUv = abs(extWn.x) > abs(extWn.z) ? vExtWorldPos.zy : vExtWorldPos.xy;
              float extStreak = texture2D(uExtDetailNoise, vec2(extWallUv.x * 0.28, extWallUv.y * 0.048 + uExtTime * 0.065)).r;
              float extStreakMask = smoothstep(0.54, 0.84, extStreak) * extVert * extOutdoorMask * ${rainStreakScale.toFixed(2)} * uExtWetness;
              float extTopDrop = clamp(extWn.y, 0.0, 1.0) * extOutdoorMask;
              roughnessFactor = clamp(
                mix(roughnessFactor, roughnessFactor * 0.34, extTopDrop * 0.78 * uExtWetness) - extStreakMask * 0.38,
                0.04, 1.0
              );
              ${isAsphalt ? `
              roughnessFactor = mix(roughnessFactor, 0.045, smoothstep(0.04, 0.36, extPuddle));` : ''}`
            )
            .replace(
              '#include <normal_fragment_maps>',
              `#include <normal_fragment_maps>
              vec3 extCoord = ${isViewmodel ? 'vExtLocalPos * 1.85' : 'vExtWorldPos * 0.24'};
              vec3 extDetSample = texture2D(uExtDetailNoise, extCoord.xz + extCoord.y * 0.42).rgb;
              vec3 extMicroBump = vec3((extDetSample.r - 0.5) * 0.075, (extDetSample.g - 0.5) * 0.075, 1.0);
              float extDrip = texture2D(uExtDetailNoise, vec2((abs(vExtWorldNormal.x) > abs(vExtWorldNormal.z) ? vExtWorldPos.z : vExtWorldPos.x) * 0.48, vExtWorldPos.y * 0.095 + uExtTime * 0.11)).g;
              float extDripStrength = smoothstep(0.58, 0.88, extDrip) * (1.0 - abs(vExtWorldNormal.y)) * extOutdoorMask * ${rainStreakScale.toFixed(2)} * uExtWetness;
              normal = normalize(normal + vec3(extMicroBump.x, extMicroBump.y + extDripStrength * 0.14, 0.0));
              ${isAsphalt ? `
              if (extPuddle > 0.04) {
                float pBlend = smoothstep(0.04, 0.42, extPuddle);
                vec3 calmNormal = normalize(mix(normal, normalize(vExtViewAxisY), pBlend * 0.86));
                float camDist = length(vExtWorldPos - cameraPosition);
                if (camDist < 38.0) {
                  vec2 extOccUv = (vExtWorldPos.xz - uExtRainOccBounds.xy) * uExtRainOccBounds.zw;
                  float extInOcc = step(0.0, extOccUv.x) * step(extOccUv.x, 1.0) * step(0.0, extOccUv.y) * step(extOccUv.y, 1.0);
                  float rainRoofY = extInOcc * texture2D(uExtRainOccMap, clamp(extOccUv, 0.001, 0.999)).r * uExtRainOccMaxH;
                  if (rainRoofY <= vExtWorldPos.y + 0.35) {
                    float rippleFade = (1.0 - smoothstep(18.0, 38.0, camDist)) * pBlend;
                    vec2 rippleGrad = extRainRipples(vExtWorldPos.xz, uExtTime) * rippleFade;
                    calmNormal = normalize(calmNormal + vExtViewAxisX * rippleGrad.x + vExtViewAxisZ * rippleGrad.y);
                  }
                }
                normal = calmNormal;
              }` : ''}`
            )
            .replace(
              '#include <dithering_fragment>',
              `#include <dithering_fragment>
              gNormalRough = vec4(extOctEncode(normalize(normal)), clamp(roughnessFactor, 0.03, 1.0), 1.0);`
            );
        } else {
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
              layout(location = 1) out highp vec4 gNormalRough;`
            )
            .replace(
              '#include <dithering_fragment>',
              `#include <dithering_fragment>
              gNormalRough = vec4(0.5, 0.5, 0.95, 0.0);`
            );
        }
      };

      mat.userData = mat.userData || {};
      mat.userData._extEnablePatch = () => {
        if (mat.onBeforeCompile !== extCompile) {
          mat.onBeforeCompile = extCompile;
          mat.customProgramCacheKey = extCacheKey;
          mat.needsUpdate = true;
        }
      };
      mat.userData._extDisablePatch = () => {
        if (mat.onBeforeCompile === extCompile) {
          mat.onBeforeCompile = prevCompile;
          if (prevCacheKey) {
            mat.customProgramCacheKey = prevCacheKey;
          } else {
            mat.customProgramCacheKey = () => '';
          }
          mat.needsUpdate = true;
        }
      };
      mat.userData._extEnablePatch();
      return mat;
    }

    setMaterialPatchEnabled(mat, enabled) {
      if (!mat || !mat.userData) return;
      if (enabled && mat.userData._extEnablePatch) {
        mat.userData._extEnablePatch();
      } else if (!enabled && mat.userData._extDisablePatch) {
        mat.userData._extDisablePatch();
      }
    }

    upgradeToPhysical(stdMat, physOpts = {}) {
      const { _extMeta, ...assignable } = physOpts || {};
      if (!stdMat || stdMat.isMeshPhysicalMaterial) {
        if (stdMat) {
          if (stdMat.userData && !stdMat.userData._extOrigPhysSaved) {
            stdMat.userData._extOrigPhysSaved = true;
            stdMat.userData._extOrigPhys = {
              clearcoat: stdMat.clearcoat || 0,
              clearcoatRoughness: stdMat.clearcoatRoughness || 0,
              anisotropy: stdMat.anisotropy || 0,
              sheen: stdMat.sheen || 0,
              iridescence: stdMat.iridescence || 0,
            };
          }
          Object.assign(stdMat, assignable);
          this.patchMaterialForExtreme(stdMat, _extMeta);
        }
        return stdMat;
      }
      if (this.upgradedMaterials.has(stdMat)) {
        const cached = this.upgradedMaterials.get(stdMat);
        this.patchMaterialForExtreme(cached, _extMeta);
        return cached;
      }
      const p = new THREE.MeshPhysicalMaterial({
        color: stdMat.color ? stdMat.color.clone() : new THREE.Color(0xffffff),
        map: stdMat.map || null,
        roughnessMap: stdMat.roughnessMap || null,
        metalnessMap: stdMat.metalnessMap || null,
        normalMap: stdMat.normalMap || null,
        normalScale: stdMat.normalScale ? stdMat.normalScale.clone() : new THREE.Vector2(1, 1),
        aoMap: stdMat.aoMap || null,
        emissive: stdMat.emissive ? stdMat.emissive.clone() : new THREE.Color(0x000000),
        emissiveIntensity: stdMat.emissiveIntensity ?? 1,
        metalness: stdMat.metalness ?? 0.5,
        roughness: stdMat.roughness ?? 0.5,
        side: stdMat.side ?? THREE.FrontSide,
        vertexColors: !!stdMat.vertexColors,
        clearcoat: assignable.clearcoat ?? 0.45,
        clearcoatRoughness: assignable.clearcoatRoughness ?? 0.18,
        anisotropy: assignable.anisotropy ?? 0.0,
        sheen: assignable.sheen ?? 0.0,
        sheenRoughness: assignable.sheenRoughness ?? 0.65,
        sheenColor: assignable.sheenColor || new THREE.Color(0x6e85a0),
        ior: assignable.ior ?? 1.5,
      });
      this.patchMaterialForExtreme(p, _extMeta);
      this.upgradedMaterials.set(stdMat, p);
      return p;
    }

    syncSceneMaterials(root, enabled, isViewmodelRoot = false) {
      if (!root) return;
      this.sharedUniforms.uExtWetness.value = enabled ? 1.0 : 0.0;
      const seen = new Set();
      root.traverse((obj) => {
        if (!obj || !obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m || seen.has(m)) continue;
          seen.add(m);
          if (m.transparent || m.isShaderMaterial || m.isLineBasicMaterial) continue;
          if (enabled) {
            let isVm = isViewmodelRoot;
            if (!isVm) {
              let p = obj;
              while (p) {
                if (p.userData && p.userData.isViewmodel) {
                  isVm = true;
                  break;
                }
                p = p.parent;
              }
            }
            const porous = !!(m.userData && m.userData.isPorous);
            const isAsphalt = !!(m.userData && m.userData.isAsphalt);
            this.patchMaterialForExtreme(m, { isViewmodel: isVm, isPorous: porous, isAsphalt });
          } else {
            this.setMaterialPatchEnabled(m, false);
            if (m.isMeshPhysicalMaterial && m.userData && m.userData._extOrigPhys) {
              Object.assign(m, m.userData._extOrigPhys);
            }
          }
        }
      });
    }
  }

  // --------------------------------------------------------------------------
  // 3. 极限画质渲染管线：MRT G-Buffer + Half-Res LinearZ + 时空重投影 + 5-tap 双边降噪
  //                        + Dual-Kawase 4级 Bloom + AgX + FXAA 3.11 + RCAS 上采样
  // --------------------------------------------------------------------------
  class ExtremeRenderPipeline {
    constructor(renderer, scene, camera) {
      this.renderer = renderer;
      this.scene = scene;
      this.camera = camera;
      this.caps = detectCapabilities(renderer);
      this.enabled = false;
      this.initialized = false;
      this.drsScale = 1.0;
      this.drsEnabled = true;

      this.postScene = new THREE.Scene();
      this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      this.quad.frustumCulled = false;
      this.postScene.add(this.quad);

      this.width = 2;
      this.height = 2;
      this.activeWidth = 2;
      this.activeHeight = 2;
      this._expToggle = 0;
      this._histToggle = 0;
      this._historyValid = false;
      this._frameIndex = 0;

      this._fullUvScale = new THREE.Vector2(1, 1);
      this._fullUvMin = new THREE.Vector2(0, 0);
      this._fullUvMax = new THREE.Vector2(1, 1);
      this._halfUvScale = new THREE.Vector2(1, 1);
      this._halfUvMin = new THREE.Vector2(0, 0);
      this._halfUvMax = new THREE.Vector2(1, 1);
      this._prevHalfUvScale = new THREE.Vector2(1, 1);
      this._prevHalfUvMax = new THREE.Vector2(1, 1);

      this._viewRayScale = new THREE.Vector2(1, 1);
      this._invViewRayScale = new THREE.Vector2(1, 1);
      this._depthParams = new THREE.Vector2(0.2, 1.0);
      this._fullMaxTexel = new THREE.Vector2(1, 1);
      this._halfTexel = new THREE.Vector2(1, 1);

      this._invProj = new THREE.Matrix4();
      this._invView = new THREE.Matrix4();
      this._prevViewProj = new THREE.Matrix4();
      this._sunDirView = new THREE.Vector3();
      this._flashDirView = new THREE.Vector3();
      this._spot1Origin = new THREE.Vector3(14.2, 15.4, 2.0);
      this._spot1Dir = new THREE.Vector3(0, -1, 0);
      this._spot2Origin = new THREE.Vector3(16.2, 15.4, 8.0);
      this._spot2Dir = new THREE.Vector3(0, -1, 0);
      this._flashWorldPos = new THREE.Vector3();
      this._flashWorldDir = new THREE.Vector3();
    }

    _mkRt(rw, rh, opts = {}) {
      const hf = THREE.HalfFloatType;
      const linCs = THREE.LinearSRGBColorSpace || THREE.NoColorSpace;
      const rt = new THREE.WebGLRenderTarget(Math.max(1, rw | 0), Math.max(1, rh | 0), {
        type: opts.type || hf,
        colorSpace: opts.colorSpace || linCs,
        minFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
        magFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
        depthBuffer: !!opts.depthBuffer,
        count: opts.count || 1,
      });
      rt.userData = rt.userData || {};
      rt.userData._activeW = rt.width;
      rt.userData._activeH = rt.height;
      return rt;
    }

    _applyTargetViewport(rt, aw, ah) {
      if (!rt) return;
      const bw = Math.max(1, rt.width);
      const bh = Math.max(1, rt.height);
      const w = Math.max(1, Math.min(bw, aw | 0));
      const h = Math.max(1, Math.min(bh, ah | 0));
      rt.viewport.set(0, 0, w, h);
      rt.scissor.set(0, 0, w, h);
      rt.scissorTest = (w < bw || h < bh);
      rt.userData._activeW = w;
      rt.userData._activeH = h;
    }

    _getTargetUvBounds(rt, outScale, outMin, outMax, outTexel) {
      const bw = Math.max(1, rt.width);
      const bh = Math.max(1, rt.height);
      const aw = Math.max(1, (rt.userData && rt.userData._activeW) || bw);
      const ah = Math.max(1, (rt.userData && rt.userData._activeH) || bh);
      if (outScale) outScale.set(aw / bw, ah / bh);
      if (outMin) outMin.set(0.5 / bw, 0.5 / bh);
      if (outMax) outMax.set((aw - 0.5) / bw, (ah - 0.5) / bh);
      if (outTexel) outTexel.set(1 / bw, 1 / bh);
    }

    _initTargetsAndShaders(w, h) {
      if (this.initialized) return;
      this.initialized = true;
      const linCs = THREE.LinearSRGBColorSpace || THREE.NoColorSpace;

      this.gTarget = this._mkRt(w, h, { count: 2, depthBuffer: true });
      this.gTarget.depthTexture = new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0));
      this.gTarget.depthTexture.format = THREE.DepthFormat;
      this.gTarget.depthTexture.type = THREE.UnsignedIntType;

      const hw = Math.max(8, w >> 1);
      const hh = Math.max(8, h >> 1);
      this.halfGeomA = this._mkRt(hw, hh, { nearest: true });
      this.halfGeomB = this._mkRt(hw, hh, { nearest: true });

      this.hdrColorMips = [
        this._mkRt(Math.max(8, w >> 1), Math.max(8, h >> 1)),
        this._mkRt(Math.max(4, w >> 2), Math.max(4, h >> 2)),
        this._mkRt(Math.max(2, w >> 3), Math.max(2, h >> 3)),
        this._mkRt(Math.max(1, w >> 4), Math.max(1, h >> 4)),
      ];

      this.aoTarget = this._mkRt(hw, hh);
      this.ssrTarget = this._mkRt(hw, hh);
      this.volTarget = this._mkRt(hw, hh);

      this.temporalHistA = this._mkRt(hw, hh, { count: 3 });
      this.temporalHistB = this._mkRt(hw, hh, { count: 3 });
      this.temporalFinal = this._mkRt(hw, hh, { count: 3 });

      this.hdrTarget = this._mkRt(w, h, { depthBuffer: true });

      this.bloomDown = [
        this._mkRt(Math.max(8, w >> 1), Math.max(8, h >> 1)),
        this._mkRt(Math.max(4, w >> 2), Math.max(4, h >> 2)),
        this._mkRt(Math.max(2, w >> 3), Math.max(2, h >> 3)),
        this._mkRt(Math.max(1, w >> 4), Math.max(1, h >> 4)),
      ];
      this.bloomUp = [
        this._mkRt(Math.max(8, w >> 1), Math.max(8, h >> 1)),
        this._mkRt(Math.max(4, w >> 2), Math.max(4, h >> 2)),
        this._mkRt(Math.max(2, w >> 3), Math.max(2, h >> 3)),
      ];

      this.expDown16 = this._mkRt(16, 16);
      this.expHistA = this._mkRt(1, 1);
      this.expHistB = this._mkRt(1, 1);
      this.ldrTarget = this._mkRt(w, h, { type: THREE.UnsignedByteType, colorSpace: linCs });

      const COMMON_DECODE = /* glsl */ `
        vec3 octDecode(vec2 f) {
          f = f * 2.0 - 1.0;
          vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
          float t = max(-n.z, 0.0);
          n.x += n.x >= 0.0 ? -t : t;
          n.y += n.y >= 0.0 ? -t : t;
          return normalize(n);
        }
        vec3 viewPosFromLinearZ(vec2 normUv, float linZ, vec2 rayScale) {
          return vec3((normUv * 2.0 - 1.0) * rayScale * linZ, -linZ);
        }
        vec2 normUvFromViewPos(vec3 vp, vec2 invRayScale) {
          return (vp.xy / max(0.05, -vp.z)) * invRayScale * 0.5 + 0.5;
        }
        vec2 toTexUv(vec2 normUv, vec2 uvScale, vec2 uvMin, vec2 uvMax) {
          return clamp(normUv * uvScale, uvMin, uvMax);
        }
        float ignTemporal(vec2 p, float phase) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)) + phase * 0.6180339887));
        }
      `;

      // Pass 1: 半分辨率线性深度 + 八面体法线 + 打包粗糙度/Lit掩膜（Nearest texelFetch 零渗色）
      this.halfDepthNormalMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDepth: { value: this.gTarget.depthTexture },
          tNormalRough: { value: this.gTarget.textures[1] },
          uDepthParams: { value: this._depthParams },
          uFullMaxTexel: { value: this._fullMaxTexel },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDepth;
          uniform sampler2D tNormalRough;
          uniform vec2 uDepthParams;
          uniform ivec2 uFullMaxTexel;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            ivec2 tc = clamp(ivec2(gl_FragCoord.xy) * 2, ivec2(0), uFullMaxTexel);
            float d = texelFetch(tDepth, tc, 0).r;
            vec4 nr = texelFetch(tNormalRough, tc, 0);
            float linZ = 500.0;
            if (d < 0.9998) {
              float ndcZ = d * 2.0 - 1.0;
              linZ = clamp(uDepthParams.x / max(1e-5, uDepthParams.y - ndcZ), 0.05, 480.0);
            }
            float rough = clamp(nr.z, 0.03, 1.0);
            float packedRough = nr.w < 0.2 ? -rough : rough;
            fragColor = vec4(linZ, nr.x, nr.y, packedRough);
          }
        `,
      });

      // Pass 2: 2x2 Tent Mip 降采样（供粗糙度锥形 SSR 查表，支持 DRS UV 夹紧）
      this.downsampleMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: null },
          uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
          uSrcUvScale: { value: new THREE.Vector2(1, 1) },
          uSrcUvMin: { value: new THREE.Vector2(0, 0) },
          uSrcUvMax: { value: new THREE.Vector2(1, 1) },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform vec2 uTexel;
          uniform vec2 uSrcUvScale;
          uniform vec2 uSrcUvMin;
          uniform vec2 uSrcUvMax;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            vec2 baseUv = vUv * uSrcUvScale;
            vec3 c = texture(tDiffuse, clamp(baseUv + vec2(-1.0, -1.0) * uTexel, uSrcUvMin, uSrcUvMax)).rgb;
            c += texture(tDiffuse, clamp(baseUv + vec2( 1.0, -1.0) * uTexel, uSrcUvMin, uSrcUvMax)).rgb;
            c += texture(tDiffuse, clamp(baseUv + vec2(-1.0,  1.0) * uTexel, uSrcUvMin, uSrcUvMax)).rgb;
            c += texture(tDiffuse, clamp(baseUv + vec2( 1.0,  1.0) * uTexel, uSrcUvMin, uSrcUvMax)).rgb;
            fragColor = vec4(min(c * 0.25, vec3(24.0)), 1.0);
          }
        `,
      });

      // Pass 3a: 半分辨率时空 GTAO (4x3 = 12 taps) + 5 步微距接触阴影（无矩阵循环）
      this.gtaoMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tHalfGeom: { value: this.halfGeomA.texture },
          uViewRayScale: { value: this._viewRayScale },
          uInvViewRayScale: { value: this._invViewRayScale },
          uHalfUvScale: { value: this._halfUvScale },
          uHalfUvMin: { value: this._halfUvMin },
          uHalfUvMax: { value: this._halfUvMax },
          uSunDirView: { value: this._sunDirView },
          uFramePhase: { value: 0.0 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tHalfGeom;
          uniform vec2 uViewRayScale;
          uniform vec2 uInvViewRayScale;
          uniform vec2 uHalfUvScale;
          uniform vec2 uHalfUvMin;
          uniform vec2 uHalfUvMax;
          uniform vec3 uSunDirView;
          uniform float uFramePhase;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          ${COMMON_DECODE}
          void main() {
            vec2 centerUv = toTexUv(vUv, uHalfUvScale, uHalfUvMin, uHalfUvMax);
            vec4 hg = texture(tHalfGeom, centerUv);
            float linZ = hg.r;
            if (linZ > 450.0 || hg.a < 0.0) {
              fragColor = vec4(1.0, 1.0, 0.0, 1.0);
              return;
            }
            vec3 vp = viewPosFromLinearZ(vUv, linZ, uViewRayScale);
            vec3 vn = octDecode(hg.gb);

            float worldRadius = clamp(0.45 + linZ * 0.04, 0.45, 1.85);
            float noiseA = ignTemporal(gl_FragCoord.xy, uFramePhase);
            float aoAccum = 0.0;
            for (int d = 0; d < 4; d++) {
              float ang = (float(d) + noiseA) * (3.14159265 / 2.0);
              vec3 dirView = vec3(cos(ang), sin(ang), 0.0);
              float maxSin = 0.0;
              for (int s = 1; s <= 3; s++) {
                float frac = (float(s) - 0.35 + 0.35 * noiseA) / 3.0;
                vec3 sampleVp = vp + dirView * (worldRadius * frac);
                vec2 suvNorm = normUvFromViewPos(sampleVp, uInvViewRayScale);
                if (suvNorm.x <= 0.002 || suvNorm.x >= 0.998 || suvNorm.y <= 0.002 || suvNorm.y >= 0.998) continue;
                vec4 shg = texture(tHalfGeom, toTexUv(suvNorm, uHalfUvScale, uHalfUvMin, uHalfUvMax));
                if (shg.r > 450.0) continue;
                vec3 sPos = viewPosFromLinearZ(suvNorm, shg.r, uViewRayScale);
                vec3 delta = sPos - vp;
                float len = length(delta);
                if (len < 0.02 || len > worldRadius * 1.8) continue;
                float horizon = dot(delta / len, vn);
                float falloff = 1.0 - smoothstep(worldRadius * 0.5, worldRadius * 1.75, len);
                maxSin = max(maxSin, horizon * falloff);
              }
              aoAccum += 1.0 - clamp(maxSin, 0.0, 0.95);
            }
            float ao = pow(clamp(aoAccum * 0.25, 0.0, 1.0), 1.35);

            float contact = 1.0;
            if (linZ < 36.0) {
              vec3 rayDir = normalize(uSunDirView);
              float stepLen = 0.085 * (0.65 + 0.35 * noiseA);
              float thickness = 0.08 + linZ * 0.008;
              for (int i = 1; i <= 5; i++) {
                vec3 p = vp + rayDir * (stepLen * float(i));
                vec2 suvNorm = normUvFromViewPos(p, uInvViewRayScale);
                if (suvNorm.x <= 0.0 || suvNorm.x >= 1.0 || suvNorm.y <= 0.0 || suvNorm.y >= 1.0) break;
                float sz = -texture(tHalfGeom, toTexUv(suvNorm, uHalfUvScale, uHalfUvMin, uHalfUvMax)).r;
                float diff = p.z - sz;
                if (diff < -0.012 && diff > -thickness) {
                  contact = 0.38;
                  break;
                }
              }
            }
            fragColor = vec4(ao, contact, 0.0, 1.0);
          }
        `,
      });

      // Pass 3b: 半分辨率粗糙度感知 SSR（16步 + 4步二分精化，零矩阵乘法）
      this.ssrMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tHalfGeom: { value: this.halfGeomA.texture },
          tMip0: { value: this.hdrColorMips[0].texture },
          tMip1: { value: this.hdrColorMips[1].texture },
          tMip2: { value: this.hdrColorMips[2].texture },
          tMip3: { value: this.hdrColorMips[3].texture },
          uViewRayScale: { value: this._viewRayScale },
          uInvViewRayScale: { value: this._invViewRayScale },
          uHalfUvScale: { value: this._halfUvScale },
          uHalfUvMin: { value: this._halfUvMin },
          uHalfUvMax: { value: this._halfUvMax },
          uMipUvScale: { value: [new THREE.Vector2(1, 1), new THREE.Vector2(1, 1), new THREE.Vector2(1, 1), new THREE.Vector2(1, 1)] },
          uMipUvMin: { value: [new THREE.Vector2(0, 0), new THREE.Vector2(0, 0), new THREE.Vector2(0, 0), new THREE.Vector2(0, 0)] },
          uMipUvMax: { value: [new THREE.Vector2(1, 1), new THREE.Vector2(1, 1), new THREE.Vector2(1, 1), new THREE.Vector2(1, 1)] },
          uFramePhase: { value: 0.0 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tHalfGeom;
          uniform sampler2D tMip0;
          uniform sampler2D tMip1;
          uniform sampler2D tMip2;
          uniform sampler2D tMip3;
          uniform vec2 uViewRayScale;
          uniform vec2 uInvViewRayScale;
          uniform vec2 uHalfUvScale;
          uniform vec2 uHalfUvMin;
          uniform vec2 uHalfUvMax;
          uniform vec2 uMipUvScale[4];
          uniform vec2 uMipUvMin[4];
          uniform vec2 uMipUvMax[4];
          uniform float uFramePhase;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          ${COMMON_DECODE}
          vec3 sampleHdrPyramid(vec2 normUv, float rough) {
            float lod = clamp((rough - 0.04) / 0.62, 0.0, 1.0) * 3.0;
            vec2 u0 = toTexUv(normUv, uMipUvScale[0], uMipUvMin[0], uMipUvMax[0]);
            vec2 u1 = toTexUv(normUv, uMipUvScale[1], uMipUvMin[1], uMipUvMax[1]);
            vec2 u2 = toTexUv(normUv, uMipUvScale[2], uMipUvMin[2], uMipUvMax[2]);
            vec2 u3 = toTexUv(normUv, uMipUvScale[3], uMipUvMin[3], uMipUvMax[3]);
            if (lod < 1.0) return mix(texture(tMip0, u0).rgb, texture(tMip1, u1).rgb, lod);
            if (lod < 2.0) return mix(texture(tMip1, u1).rgb, texture(tMip2, u2).rgb, lod - 1.0);
            return mix(texture(tMip2, u2).rgb, texture(tMip3, u3).rgb, lod - 2.0);
          }
          void main() {
            vec2 centerUv = toTexUv(vUv, uHalfUvScale, uHalfUvMin, uHalfUvMax);
            vec4 hg = texture(tHalfGeom, centerUv);
            float linZ = hg.r;
            float rough = abs(hg.a);
            if (linZ > 450.0 || hg.a < 0.0 || rough > 0.66) {
              fragColor = vec4(0.0);
              return;
            }
            vec3 vp = viewPosFromLinearZ(vUv, linZ, uViewRayScale);
            vec3 vn = octDecode(hg.gb);
            vec3 V = normalize(-vp);
            vec3 R = normalize(reflect(-V, vn));
            if (R.z > 0.24) {
              fragColor = vec4(0.0);
              return;
            }

            float jitter = ignTemporal(gl_FragCoord.xy, uFramePhase);
            float stepSize = 0.28;
            vec3 march = vp + vn * 0.045 + R * (stepSize * jitter);
            vec2 hitNormUv = vec2(0.0);
            bool hit = false;

            for (int i = 0; i < 16; i++) {
              march += R * stepSize;
              stepSize *= 1.18;
              if (march.z > -0.05) break;
              vec2 normUv = normUvFromViewPos(march, uInvViewRayScale);
              if (normUv.x < 0.0 || normUv.x > 1.0 || normUv.y < 0.0 || normUv.y > 1.0) break;
              float sz = -texture(tHalfGeom, toTexUv(normUv, uHalfUvScale, uHalfUvMin, uHalfUvMax)).r;
              float delta = sz - march.z;
              if (delta > 0.0 && delta < max(0.36, stepSize * 1.65)) {
                vec3 a = march - R * stepSize;
                vec3 b = march;
                for (int k = 0; k < 4; k++) {
                  vec3 mid = 0.5 * (a + b);
                  vec2 muv = normUvFromViewPos(mid, uInvViewRayScale);
                  float msz = -texture(tHalfGeom, toTexUv(muv, uHalfUvScale, uHalfUvMin, uHalfUvMax)).r;
                  if (msz > mid.z) b = mid;
                  else a = mid;
                }
                hitNormUv = normUvFromViewPos(0.5 * (a + b), uInvViewRayScale);
                hit = hitNormUv.x > 0.002 && hitNormUv.x < 0.998 && hitNormUv.y > 0.002 && hitNormUv.y < 0.998;
                break;
              }
            }

            if (!hit) {
              fragColor = vec4(0.0);
              return;
            }
            vec3 refl = sampleHdrPyramid(hitNormUv, rough);
            vec2 edge = smoothstep(0.0, 0.09, hitNormUv) * smoothstep(1.0, 0.91, hitNormUv);
            float fresnel = 0.04 + 0.96 * pow(1.0 - clamp(dot(vn, V), 0.0, 1.0), 4.0);
            float roughFade = 1.0 - smoothstep(0.18, 0.66, rough);
            float viewFade = 1.0 - smoothstep(0.0, 0.24, R.z);
            float alpha = clamp(edge.x * edge.y * fresnel * roughFade * viewFade, 0.0, 0.92);
            fragColor = vec4(refl * alpha, alpha);
          }
        `,
      });

      // Pass 3c: 半分辨率阴影感知体积雾与雨雾丁达尔光柱 (10步 + 时序抖动)
      this.volumetricMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tHalfGeom: { value: this.halfGeomA.texture },
          uViewRayScale: { value: this._viewRayScale },
          uHalfUvScale: { value: this._halfUvScale },
          uHalfUvMin: { value: this._halfUvMin },
          uHalfUvMax: { value: this._halfUvMax },
          uSunShadowMap: { value: null },
          uSunShadowMatrix: { value: new THREE.Matrix4() },
          uCamWorld: { value: this._invView },
          uCamPos: { value: new THREE.Vector3() },
          uSunDir: { value: new THREE.Vector3(-0.82, 0.14, -0.55).normalize() },
          uFlashPos: { value: this._flashWorldPos },
          uFlashDir: { value: this._flashWorldDir },
          uFlashOn: { value: 1.0 },
          uSpot1Origin: { value: this._spot1Origin },
          uSpot1Dir: { value: this._spot1Dir },
          uSpot2Origin: { value: this._spot2Origin },
          uSpot2Dir: { value: this._spot2Dir },
          uBlackout: { value: 0.0 },
          uTime: { value: 0.0 },
          uFramePhase: { value: 0.0 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tHalfGeom;
          uniform vec2 uViewRayScale;
          uniform vec2 uHalfUvScale;
          uniform vec2 uHalfUvMin;
          uniform vec2 uHalfUvMax;
          uniform sampler2DShadow uSunShadowMap;
          uniform mat4 uSunShadowMatrix;
          uniform mat4 uCamWorld;
          uniform vec3 uCamPos;
          uniform vec3 uSunDir;
          uniform vec3 uFlashPos;
          uniform vec3 uFlashDir;
          uniform float uFlashOn;
          uniform vec3 uSpot1Origin;
          uniform vec3 uSpot1Dir;
          uniform vec3 uSpot2Origin;
          uniform vec3 uSpot2Dir;
          uniform float uBlackout;
          uniform float uTime;
          uniform float uFramePhase;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          ${COMMON_DECODE}

          float hgPhase(float cosTheta, float g) {
            float g2 = g * g;
            return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.05, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
          }
          float sampleSunShadow(vec3 wp) {
            vec4 sc = uSunShadowMatrix * vec4(wp, 1.0);
            sc.xyz /= max(1e-5, sc.w);
            if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
            return texture(uSunShadowMap, vec3(sc.xy, sc.z - 0.0014));
          }
          float spotConeFactor(vec3 p, vec3 origin, vec3 dir, float cosOuter, float cosInner, float maxDist) {
            vec3 v = p - origin;
            float d = length(v);
            if (d > maxDist || d < 0.3) return 0.0;
            float ca = dot(v / d, dir);
            return smoothstep(cosOuter, cosInner, ca) / (1.0 + d * d * 0.032);
          }

          void main() {
            float linZ = texture(tHalfGeom, toTexUv(vUv, uHalfUvScale, uHalfUvMin, uHalfUvMax)).r;
            vec3 vp = viewPosFromLinearZ(vUv, linZ, uViewRayScale);
            vec3 wpEnd = (uCamWorld * vec4(vp, 1.0)).xyz;
            vec3 ray = wpEnd - uCamPos;
            float rayLen = length(ray);
            vec3 rayDir = ray / max(1e-5, rayLen);
            float maxMarch = min(rayLen, 72.0);

            float jitter = ignTemporal(gl_FragCoord.xy, uFramePhase);
            float sunPhase = hgPhase(dot(rayDir, uSunDir), 0.62);
            vec3 accum = vec3(0.0);
            const int STEPS = 10;
            float ds = maxMarch / float(STEPS);

            for (int i = 0; i < STEPS; i++) {
              float t = (float(i) + jitter) * ds;
              vec3 p = uCamPos + rayDir * t;
              float heightDensity = exp(-max(0.0, p.y) * 0.14);
              float dxWh = max(-22.0 - p.x, max(0.0, p.x + 2.0));
              float dzWh = max(-32.0 - p.z, max(0.0, p.z + 14.0));
              float outWh = smoothstep(0.0, 2.0, length(vec2(dxWh, dzWh)));
              float localFog = mix(0.28, 1.0, outWh) * (0.45 + 0.55 * heightDensity);
              float nearFade = smoothstep(1.2, 4.5, t) * exp(-t * 0.045);

              float sunVis = sampleSunShadow(p);
              accum += vec3(0.88, 0.42, 0.17) * (sunVis * sunPhase * 0.068 * localFog * (1.0 - uBlackout * 0.7)) * exp(-t * 0.015);

              if (uFlashOn > 0.5 && t < 24.0) {
                float fl = spotConeFactor(p, uFlashPos, uFlashDir, 0.86, 0.96, 24.0);
                accum += vec3(0.72, 0.86, 1.0) * (fl * 0.14 * localFog * nearFade);
              }
              float s1 = spotConeFactor(p, uSpot1Origin, uSpot1Dir, 0.90, 0.97, 36.0);
              float s2 = spotConeFactor(p, uSpot2Origin, uSpot2Dir, 0.90, 0.97, 36.0);
              accum += vec3(0.45, 0.82, 1.0) * ((s1 + s2) * 0.28 * localFog * nearFade * (1.0 - uBlackout * 0.5));
            }

            accum *= ds * 0.055;
            float fogBase = mix(0.0115, 0.0195, uBlackout);
            float avgH = max(0.0, mix(uCamPos.y, wpEnd.y, 0.42));
            float distFog = 1.0 - exp(-fogBase * fogBase * rayLen * rayLen * (0.65 + 0.45 * exp(-avgH * 0.18)));
            if (linZ > 450.0) distFog = 0.0;
            fragColor = vec4(clamp(accum, 0.0, 1.2), clamp(distFog, 0.0, 0.72));
          }
        `,
      });

      // Pass 4a: 单遍 MRT 时序重投影 + 邻域夹紧（零拖影积累 AO / SSR / Vol，无静态模糊累积）
      this.temporalResolveMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tHalfGeomCur: { value: this.halfGeomA.texture },
          tHalfGeomPrev: { value: this.halfGeomB.texture },
          tAoCur: { value: this.aoTarget.texture },
          tSsrCur: { value: this.ssrTarget.texture },
          tVolCur: { value: this.volTarget.texture },
          tAoPrev: { value: this.temporalHistA.textures[0] },
          tSsrPrev: { value: this.temporalHistA.textures[1] },
          tVolPrev: { value: this.temporalHistA.textures[2] },
          uViewRayScale: { value: this._viewRayScale },
          uCamWorld: { value: this._invView },
          uPrevViewProj: { value: this._prevViewProj },
          uHalfUvScale: { value: this._halfUvScale },
          uHalfUvMin: { value: this._halfUvMin },
          uHalfUvMax: { value: this._halfUvMax },
          uPrevHalfUvScale: { value: this._prevHalfUvScale },
          uPrevHalfUvMax: { value: this._prevHalfUvMax },
          uHalfTexel: { value: this._halfTexel },
          uTemporalReset: { value: 1.0 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tHalfGeomCur;
          uniform sampler2D tHalfGeomPrev;
          uniform sampler2D tAoCur;
          uniform sampler2D tSsrCur;
          uniform sampler2D tVolCur;
          uniform sampler2D tAoPrev;
          uniform sampler2D tSsrPrev;
          uniform sampler2D tVolPrev;
          uniform vec2 uViewRayScale;
          uniform mat4 uCamWorld;
          uniform mat4 uPrevViewProj;
          uniform vec2 uHalfUvScale;
          uniform vec2 uHalfUvMin;
          uniform vec2 uHalfUvMax;
          uniform vec2 uPrevHalfUvScale;
          uniform vec2 uPrevHalfUvMax;
          uniform vec2 uHalfTexel;
          uniform float uTemporalReset;
          in vec2 vUv;
          layout(location = 0) out vec4 outAo;
          layout(location = 1) out vec4 outSsr;
          layout(location = 2) out vec4 outVol;
          ${COMMON_DECODE}

          void main() {
            vec2 curUv = toTexUv(vUv, uHalfUvScale, uHalfUvMin, uHalfUvMax);
            vec4 curAo = texture(tAoCur, curUv);
            vec4 curSsr = texture(tSsrCur, curUv);
            vec4 curVol = texture(tVolCur, curUv);
            if (uTemporalReset > 0.5) {
              outAo = curAo;
              outSsr = curSsr;
              outVol = curVol;
              return;
            }

            vec4 hgCur = texture(tHalfGeomCur, curUv);
            float linZ = hgCur.r;
            vec3 vp = viewPosFromLinearZ(vUv, linZ, uViewRayScale);
            vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;
            vec4 prevClip = uPrevViewProj * vec4(wp, 1.0);
            vec2 prevNormUv = (prevClip.xy / max(1e-4, prevClip.w)) * 0.5 + 0.5;
            bool inBounds = prevClip.w > 0.05 && prevNormUv.x > 0.002 && prevNormUv.x < 0.998 && prevNormUv.y > 0.002 && prevNormUv.y < 0.998;
            if (!inBounds) {
              outAo = curAo;
              outSsr = curSsr;
              outVol = curVol;
              return;
            }

            vec2 prevUv = toTexUv(prevNormUv, uPrevHalfUvScale, uHalfUvMin, uPrevHalfUvMax);
            vec4 hgPrev = texture(tHalfGeomPrev, prevUv);
            float zRatio = abs(hgPrev.r - linZ) / max(0.35, linZ);
            float wZ = exp(-zRatio * 10.0);
            float wN = linZ > 450.0 ? 1.0 : pow(max(0.0, dot(octDecode(hgCur.gb), octDecode(hgPrev.gb))), 6.0);
            float vmReact = linZ < 1.05 ? 0.35 : 1.0;
            float conf = clamp(wZ * wN * vmReact, 0.0, 1.0);

            // 5-tap '+' 空间邻域最小/最大包络夹紧，彻底杜绝移动目标拖影
            vec2 offX = vec2(uHalfTexel.x, 0.0);
            vec2 offY = vec2(0.0, uHalfTexel.y);
            vec2 uL = clamp(curUv - offX, uHalfUvMin, uHalfUvMax);
            vec2 uR = clamp(curUv + offX, uHalfUvMin, uHalfUvMax);
            vec2 uD = clamp(curUv - offY, uHalfUvMin, uHalfUvMax);
            vec2 uU = clamp(curUv + offY, uHalfUvMin, uHalfUvMax);

            vec4 aoMin = min(curAo, min(min(texture(tAoCur, uL), texture(tAoCur, uR)), min(texture(tAoCur, uD), texture(tAoCur, uU))));
            vec4 aoMax = max(curAo, max(max(texture(tAoCur, uL), texture(tAoCur, uR)), max(texture(tAoCur, uD), texture(tAoCur, uU))));
            vec4 ssrMin = min(curSsr, min(min(texture(tSsrCur, uL), texture(tSsrCur, uR)), min(texture(tSsrCur, uD), texture(tSsrCur, uU))));
            vec4 ssrMax = max(curSsr, max(max(texture(tSsrCur, uL), texture(tSsrCur, uR)), max(texture(tSsrCur, uD), texture(tSsrCur, uU))));
            vec4 volMin = min(curVol, min(min(texture(tVolCur, uL), texture(tVolCur, uR)), min(texture(tVolCur, uD), texture(tVolCur, uU))));
            vec4 volMax = max(curVol, max(max(texture(tVolCur, uL), texture(tVolCur, uR)), max(texture(tVolCur, uD), texture(tVolCur, uU))));

            vec4 prevAo = clamp(texture(tAoPrev, prevUv), aoMin - 0.04, aoMax + 0.04);
            vec4 prevSsr = clamp(texture(tSsrPrev, prevUv), ssrMin - 0.08, ssrMax + 0.08);
            vec4 prevVol = clamp(texture(tVolPrev, prevUv), volMin - 0.05, volMax + 0.05);

            outAo = mix(curAo, prevAo, 0.78 * conf);
            outSsr = mix(curSsr, prevSsr, 0.72 * conf);
            outVol = mix(curVol, prevVol, 0.82 * conf);
          }
        `,
      });

      // Pass 4b: 单遍 5-tap Cross-Bilateral MRT 清理Pass（替代原先4遍7-tap分离滤波）
      this.bilateralMrtMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tHalfGeom: { value: this.halfGeomA.texture },
          tAo: { value: this.temporalHistA.textures[0] },
          tSsr: { value: this.temporalHistA.textures[1] },
          tVol: { value: this.temporalHistA.textures[2] },
          uHalfUvScale: { value: this._halfUvScale },
          uHalfUvMin: { value: this._halfUvMin },
          uHalfUvMax: { value: this._halfUvMax },
          uHalfTexel: { value: this._halfTexel },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tHalfGeom;
          uniform sampler2D tAo;
          uniform sampler2D tSsr;
          uniform sampler2D tVol;
          uniform vec2 uHalfUvScale;
          uniform vec2 uHalfUvMin;
          uniform vec2 uHalfUvMax;
          uniform vec2 uHalfTexel;
          in vec2 vUv;
          layout(location = 0) out vec4 outAo;
          layout(location = 1) out vec4 outSsr;
          layout(location = 2) out vec4 outVol;
          ${COMMON_DECODE}

          void main() {
            vec2 uv = toTexUv(vUv, uHalfUvScale, uHalfUvMin, uHalfUvMax);
            vec4 hgC = texture(tHalfGeom, uv);
            vec4 cAo = texture(tAo, uv);
            vec4 cSsr = texture(tSsr, uv);
            vec4 cVol = texture(tVol, uv);

            float cz = hgC.r;
            if (cz > 450.0) {
              outAo = cAo;
              outSsr = cSsr;
              outVol = cVol;
              return;
            }
            vec3 cn = octDecode(hgC.gb);
            float rough = abs(hgC.a);

            vec4 sumAo = cAo;
            vec4 sumVol = cVol;
            float wSum = 1.0;

            vec2 stepUv = uHalfTexel * 1.35;
            vec2 offs[4];
            offs[0] = vec2(-stepUv.x, 0.0);
            offs[1] = vec2( stepUv.x, 0.0);
            offs[2] = vec2(0.0, -stepUv.y);
            offs[3] = vec2(0.0,  stepUv.y);

            for (int i = 0; i < 4; i++) {
              vec2 suv = clamp(uv + offs[i], uHalfUvMin, uHalfUvMax);
              vec4 hgS = texture(tHalfGeom, suv);
              float dw = exp(-abs(hgS.r - cz) * 3.5 / max(1.0, cz * 0.25));
              float nw = pow(max(0.0, dot(cn, octDecode(hgS.gb))), 6.0);
              float w = 0.65 * dw * max(0.05, nw);
              sumAo += texture(tAo, suv) * w;
              sumVol += texture(tVol, suv) * w;
              wSum += w;
            }

            outAo = sumAo / wSum;
            outVol = sumVol / wSum;
            // SSR 仅在微粗糙以上适度柔和，镜像水洼保留最高解析力
            if (rough > 0.14) {
              vec4 ssrNb = (
                texture(tSsr, clamp(uv + offs[0], uHalfUvMin, uHalfUvMax)) +
                texture(tSsr, clamp(uv + offs[1], uHalfUvMin, uHalfUvMax)) +
                texture(tSsr, clamp(uv + offs[2], uHalfUvMin, uHalfUvMax)) +
                texture(tSsr, clamp(uv + offs[3], uHalfUvMin, uHalfUvMax))
              ) * 0.25;
              outSsr = mix(cSsr, ssrNb, smoothstep(0.14, 0.55, rough) * 0.45);
            } else {
              outSsr = cSsr;
            }
          }
        `,
      });

      // Pass 5: 合成不透明 HDR + GTAO/接触阴影 + SSR + 体积雾 -> hdrTarget
      this.opaqueCompMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tColor: { value: this.gTarget.textures[0] },
          tNormalRough: { value: this.gTarget.textures[1] },
          tAo: { value: this.temporalFinal.textures[0] },
          tSsr: { value: this.temporalFinal.textures[1] },
          tVol: { value: this.temporalFinal.textures[2] },
          uFullUvScale: { value: this._fullUvScale },
          uFullUvMin: { value: this._fullUvMin },
          uFullUvMax: { value: this._fullUvMax },
          uHalfUvScale: { value: this._halfUvScale },
          uHalfUvMin: { value: this._halfUvMin },
          uHalfUvMax: { value: this._halfUvMax },
          uBlackout: { value: 0.0 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tColor;
          uniform sampler2D tNormalRough;
          uniform sampler2D tAo;
          uniform sampler2D tSsr;
          uniform sampler2D tVol;
          uniform vec2 uFullUvScale;
          uniform vec2 uFullUvMin;
          uniform vec2 uFullUvMax;
          uniform vec2 uHalfUvScale;
          uniform vec2 uHalfUvMin;
          uniform vec2 uHalfUvMax;
          uniform float uBlackout;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            vec2 fuv = clamp(vUv * uFullUvScale, uFullUvMin, uFullUvMax);
            vec2 huv = clamp(vUv * uHalfUvScale, uHalfUvMin, uHalfUvMax);
            vec3 col = texture(tColor, fuv).rgb;
            vec4 nr = texture(tNormalRough, fuv);
            vec2 aoPair = texture(tAo, huv).rg;
            vec4 ssr = texture(tSsr, huv);
            vec4 vol = texture(tVol, huv);

            if (nr.w > 0.2) {
              float ao = mix(1.0, aoPair.x * mix(0.45, 1.0, aoPair.y), 0.88);
              col *= ao;
              col = mix(col, col + ssr.rgb * (1.0 - nr.z * 0.65), ssr.a * 0.88);
            }

            vec3 fogTint = mix(vec3(0.0045, 0.0085, 0.0175), vec3(0.0018, 0.0028, 0.0052), uBlackout);
            col = mix(col, fogTint, vol.a) + vol.rgb;
            fragColor = vec4(col, 1.0);
          }
        `,
      });

      // Pass 6: 将 gTarget.depthTexture 写入 hdrTarget 硬件深度缓冲以支持 Layer 1 透明精确遮挡
      this.depthCopyMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDepth: { value: this.gTarget.depthTexture },
          uFullUvScale: { value: this._fullUvScale },
          uFullUvMin: { value: this._fullUvMin },
          uFullUvMax: { value: this._fullUvMax },
        },
        depthTest: true,
        depthWrite: true,
        depthFunc: THREE.AlwaysDepth,
        colorWrite: false,
        toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDepth;
          uniform vec2 uFullUvScale;
          uniform vec2 uFullUvMin;
          uniform vec2 uFullUvMax;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            gl_FragDepth = texture(tDepth, clamp(vUv * uFullUvScale, uFullUvMin, uFullUvMax)).r;
            fragColor = vec4(0.0);
          }
        `,
      });

      // Pass 7: Dual-Kawase 4 级 Bloom（带 Karis 抑制与 DRS UV 边界安全）
      this.bloomPrefilterMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: this.hdrTarget.texture },
          uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
          uSrcUvScale: { value: this._fullUvScale },
          uSrcUvMin: { value: this._fullUvMin },
          uSrcUvMax: { value: this._fullUvMax },
          uThreshold: { value: 0.92 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform vec2 uTexel;
          uniform vec2 uSrcUvScale;
          uniform vec2 uSrcUvMin;
          uniform vec2 uSrcUvMax;
          uniform float uThreshold;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
          vec3 karisSample(vec2 uv) {
            vec3 c = min(texture(tDiffuse, clamp(uv, uSrcUvMin, uSrcUvMax)).rgb, vec3(18.0));
            return c / (1.0 + luma(c));
          }
          void main() {
            vec2 baseUv = vUv * uSrcUvScale;
            vec3 c = karisSample(baseUv) * 0.4;
            c += (karisSample(baseUv + vec2(-1.0, -1.0) * uTexel) +
                  karisSample(baseUv + vec2( 1.0, -1.0) * uTexel) +
                  karisSample(baseUv + vec2(-1.0,  1.0) * uTexel) +
                  karisSample(baseUv + vec2( 1.0,  1.0) * uTexel)) * 0.15;
            float br = max(max(c.r, c.g), c.b);
            float soft = smoothstep(uThreshold * 0.72, uThreshold * 1.55, br);
            fragColor = vec4(c * soft, 1.0);
          }
        `,
      });

      this.kawaseDownMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: null },
          uHalfPixel: { value: new THREE.Vector2(0.5 / w, 0.5 / h) },
          uSrcUvScale: { value: new THREE.Vector2(1, 1) },
          uSrcUvMin: { value: new THREE.Vector2(0, 0) },
          uSrcUvMax: { value: new THREE.Vector2(1, 1) },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform vec2 uHalfPixel;
          uniform vec2 uSrcUvScale;
          uniform vec2 uSrcUvMin;
          uniform vec2 uSrcUvMax;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            vec2 baseUv = vUv * uSrcUvScale;
            vec3 sum = texture(tDiffuse, clamp(baseUv, uSrcUvMin, uSrcUvMax)).rgb * 4.0;
            sum += texture(tDiffuse, clamp(baseUv - uHalfPixel, uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv + uHalfPixel, uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv + vec2(uHalfPixel.x, -uHalfPixel.y), uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv - vec2(uHalfPixel.x, -uHalfPixel.y), uSrcUvMin, uSrcUvMax)).rgb;
            fragColor = vec4(sum / 8.0, 1.0);
          }
        `,
      });

      this.kawaseUpMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: null },
          tAdd: { value: null },
          uHalfPixel: { value: new THREE.Vector2(0.5 / w, 0.5 / h) },
          uSrcUvScale: { value: new THREE.Vector2(1, 1) },
          uSrcUvMin: { value: new THREE.Vector2(0, 0) },
          uSrcUvMax: { value: new THREE.Vector2(1, 1) },
          uAddUvScale: { value: new THREE.Vector2(1, 1) },
          uAddUvMin: { value: new THREE.Vector2(0, 0) },
          uAddUvMax: { value: new THREE.Vector2(1, 1) },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform sampler2D tAdd;
          uniform vec2 uHalfPixel;
          uniform vec2 uSrcUvScale;
          uniform vec2 uSrcUvMin;
          uniform vec2 uSrcUvMax;
          uniform vec2 uAddUvScale;
          uniform vec2 uAddUvMin;
          uniform vec2 uAddUvMax;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            vec2 baseUv = vUv * uSrcUvScale;
            vec3 sum = texture(tDiffuse, clamp(baseUv + vec2(-uHalfPixel.x * 2.0, 0.0), uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv + vec2(-uHalfPixel.x, uHalfPixel.y), uSrcUvMin, uSrcUvMax)).rgb * 2.0;
            sum += texture(tDiffuse, clamp(baseUv + vec2(0.0, uHalfPixel.y * 2.0), uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv + vec2(uHalfPixel.x, uHalfPixel.y), uSrcUvMin, uSrcUvMax)).rgb * 2.0;
            sum += texture(tDiffuse, clamp(baseUv + vec2(uHalfPixel.x * 2.0, 0.0), uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv + vec2(uHalfPixel.x, -uHalfPixel.y), uSrcUvMin, uSrcUvMax)).rgb * 2.0;
            sum += texture(tDiffuse, clamp(baseUv + vec2(0.0, -uHalfPixel.y * 2.0), uSrcUvMin, uSrcUvMax)).rgb;
            sum += texture(tDiffuse, clamp(baseUv + vec2(-uHalfPixel.x, -uHalfPixel.y), uSrcUvMin, uSrcUvMax)).rgb * 2.0;
            vec3 up = sum / 12.0;
            vec2 addUv = clamp(vUv * uAddUvScale, uAddUvMin, uAddUvMax);
            fragColor = vec4(up * 0.58 + texture(tAdd, addUv).rgb * 0.65, 1.0);
          }
        `,
      });

      // Pass 8: 16x16 均值采样与 1x1 乒乓时序自动曝光
      this.expSampleMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: this.hdrTarget.texture },
          uFullUvScale: { value: this._fullUvScale },
          uFullUvMin: { value: this._fullUvMin },
          uFullUvMax: { value: this._fullUvMax },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform vec2 uFullUvScale;
          uniform vec2 uFullUvMin;
          uniform vec2 uFullUvMax;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            vec3 c = texture(tDiffuse, clamp(vUv * uFullUvScale, uFullUvMin, uFullUvMax)).rgb;
            float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.02, 6.0);
            fragColor = vec4(l, 0.0, 0.0, 1.0);
          }
        `,
      });

      this.expAdaptMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tGrid: { value: this.expDown16.texture },
          tPrev: { value: this.expHistA.texture },
          uAdaptAlpha: { value: 0.05 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tGrid;
          uniform sampler2D tPrev;
          uniform float uAdaptAlpha;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;
          void main() {
            float sum = 0.0;
            for (int y = 0; y < 4; y++) {
              for (int x = 0; x < 4; x++) {
                vec2 suv = (vec2(float(x), float(y)) + 0.5) / 4.0;
                sum += texture(tGrid, suv).r;
              }
            }
            float avgLum = sum / 16.0;
            float targetExp = clamp(0.14 / max(0.06, avgLum), 0.85, 1.10);
            float prev = texture(tPrev, vec2(0.5)).r;
            if (prev < 0.1) prev = 0.96;
            float nextExp = mix(prev, targetExp, uAdaptAlpha);
            fragColor = vec4(nextExp, avgLum, 0.0, 1.0);
          }
        `,
      });

      // Pass 9: HDR 相机光学（ADS 周边散景 + 枪口热浪 + 边缘雨滴 + 微色散 + AgX 色调映射）-> ldrTarget
      this.opticsAgxMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: this.hdrTarget.texture },
          tBloom: { value: this.bloomUp[0].texture },
          tExposure: { value: this.expHistB.texture },
          uFullUvScale: { value: this._fullUvScale },
          uFullUvMin: { value: this._fullUvMin },
          uFullUvMax: { value: this._fullUvMax },
          uBloomUvScale: { value: new THREE.Vector2(1, 1) },
          uBloomUvMin: { value: new THREE.Vector2(0, 0) },
          uBloomUvMax: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uAspect: { value: 16 / 9 },
          uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
          uLensRain: { value: 1.0 },
          uLowHp: { value: 0.0 },
          uScanWave: { value: 0.0 },
          uAdsAlpha: { value: 0.0 },
          uIsDmrScoped: { value: 0.0 },
          uMuzzleHeat: { value: 0.0 },
          uBloomStrength: { value: 0.36 },
          uBaseExposure: { value: 0.96 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform sampler2D tBloom;
          uniform sampler2D tExposure;
          uniform vec2 uFullUvScale;
          uniform vec2 uFullUvMin;
          uniform vec2 uFullUvMax;
          uniform vec2 uBloomUvScale;
          uniform vec2 uBloomUvMin;
          uniform vec2 uBloomUvMax;
          uniform float uTime;
          uniform float uAspect;
          uniform vec2 uTexel;
          uniform float uLensRain;
          uniform float uLowHp;
          uniform float uScanWave;
          uniform float uAdsAlpha;
          uniform float uIsDmrScoped;
          uniform float uMuzzleHeat;
          uniform float uBloomStrength;
          uniform float uBaseExposure;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;

          float hash21(vec2 p) {
            p = fract(p * vec2(234.34, 435.345));
            p += dot(p, p + 34.23);
            return fract(p.x * p.y);
          }

          vec3 computeLensRain(vec2 uv, float t) {
            float centerDist = length((uv - 0.5) * vec2(uAspect, 1.0));
            float edgeMask = smoothstep(0.24, 0.64, centerDist);
            if (edgeMask <= 0.001) return vec3(0.0);

            vec2 st = vec2((uv.x - 0.5) * uAspect, uv.y - 0.5);
            vec2 offset = vec2(0.0);
            float rimSpec = 0.0;
            vec3 hDir = normalize(vec3(-0.34, 0.78, 0.52) + vec3(0.0, 0.0, 1.0));

            // 1. Gravity slip-stick sliding streaks + clinging shrinking wake micro-droplets
            for (int l = 0; l < 2; l++) {
              vec2 grid = (l == 0) ? vec2(13.5, 4.6) : vec2(21.0, 7.2);
              float boxRatio = grid.x / grid.y;
              float speed = (l == 0) ? 0.34 : 0.48;

              vec2 p = st * grid + vec2(float(l) * 3.7, t * speed);
              vec2 id = floor(p);
              vec2 gv = fract(p) - 0.5;
              float n = hash21(id + float(l) * 37.13);
              if (n > 0.64) {
                float n2 = fract(n * 31.73);
                float n3 = fract(n * 73.19);
                float cycleFreq = (l == 0) ? (0.36 + 0.14 * n2) : (0.48 + 0.18 * n2);
                float u = fract(t * cycleFreq + n3);

                // Slip-stick: clings during [0..0.68], breaks tension & slides fast [0.68..1.0]
                float ySlide = -0.28 + 0.56 * (smoothstep(0.0, 0.68, u) - smoothstep(0.68, 1.0, u));
                float dropX = (n2 - 0.5) * 0.44 + sin(st.y * 16.0 + n * 24.0) * 0.035;

                vec2 dMain = vec2(gv.x - dropX, (gv.y - ySlide) * boxRatio);
                dMain.y *= (dMain.y > 0.0) ? 0.72 : 1.08;
                float rMain = length(dMain);
                float dropRad = mix(0.14, 0.175, n3);
                if (rMain < dropRad) {
                  float rn = rMain / dropRad;
                  float dome = sqrt(max(0.0, 1.0 - rn * rn));
                  float str = (l == 0) ? 0.022 : 0.014;
                  offset += -(dMain / dropRad) * (1.0 - rn * rn) * str;

                  vec3 nVec = vec3(dMain / dropRad, dome);
                  float dSpec = pow(max(0.0, dot(nVec, hDir)), 30.0) * 0.42;
                  float dRim = pow(1.0 - dome, 2.8) * smoothstep(1.0, 0.70, rn) * (0.28 + 0.72 * max(0.0, nVec.y * 0.65 - nVec.x * 0.25 + 0.25));
                  rimSpec += (dSpec + dRim * 0.52) * (l == 0 ? 0.95 : 0.72);
                }

                // Clinging shrinking wake micro-droplets fixed to glass behind sliding drop
                if (gv.y > ySlide + 0.02 && gv.y < 0.48) {
                  float distAbove = gv.y - ySlide;
                  float wakeEnv = smoothstep(0.02, 0.08, distAbove) * smoothstep(0.47, 0.18, gv.y);
                  float streakMask = smoothstep(0.036, 0.0, abs(gv.x - dropX)) * wakeEnv;
                  offset += vec2(-(gv.x - dropX), 0.0) * streakMask * (l == 0 ? 0.08 : 0.05);

                  float trailCoordY = st.y * grid.y * 7.0;
                  float trailId = floor(trailCoordY);
                  float trailF = fract(trailCoordY) - 0.5;
                  float wHash = hash21(vec2(id.x + float(l) * 19.3, trailId));
                  if (wHash > 0.42) {
                    float wakeX = dropX + (fract(wHash * 17.3) - 0.5) * 0.055;
                    float wakeYOff = (fract(wHash * 43.1) - 0.5) * 0.22;
                    vec2 dWake = vec2(gv.x - wakeX, (trailF - wakeYOff) * (boxRatio / 7.0));
                    float rWake = length(dWake);
                    float wakeRad = mix(0.022, 0.068, wakeEnv) * (0.75 + 0.5 * fract(wHash * 9.7));
                    if (rWake < wakeRad) {
                      float wrn = rWake / wakeRad;
                      float wDome = sqrt(max(0.0, 1.0 - wrn * wrn));
                      float wStr = (l == 0) ? 0.009 : 0.006;
                      offset += -(dWake / wakeRad) * (1.0 - wrn * wrn) * wStr * wakeEnv;

                      vec3 wn = vec3(dWake / wakeRad, wDome);
                      float wSpec = pow(max(0.0, dot(wn, hDir)), 28.0) * 0.34;
                      float wRim = pow(1.0 - wDome, 2.6) * smoothstep(1.0, 0.68, wrn) * (0.25 + 0.75 * max(0.0, wn.y * 0.6 + 0.3));
                      rimSpec += (wSpec + wRim * 0.45) * wakeEnv * (l == 0 ? 0.62 : 0.45);
                    }
                  }
                }
              }
            }

            // 2. Subtle outer static micro-beads around lens perimeter
            float outerMask = smoothstep(0.32, 0.72, centerDist);
            if (outerMask > 0.01) {
              for (int b = 0; b < 2; b++) {
                float bScale = (b == 0) ? 34.0 : 58.0;
                vec2 bp = st * bScale + float(b) * vec2(11.3, 7.9);
                vec2 bId = floor(bp);
                vec2 bGv = fract(bp) - 0.5;
                float bn = hash21(bId + float(b) * 53.1 + 91.7);
                if (bn > 0.62) {
                  vec2 bPos = (vec2(fract(bn * 19.7), fract(bn * 47.3)) - 0.5) * 0.44;
                  vec2 bd = bGv - bPos;
                  float br = length(bd);
                  float bRad = mix(0.11, 0.21, fract(bn * 83.1));
                  if (br < bRad) {
                    float rn = br / bRad;
                    float dome = sqrt(max(0.0, 1.0 - rn * rn));
                    float bFade = (0.72 + 0.28 * sin(t * 0.45 + bn * 6.2831)) * outerMask;
                    float bStr = (b == 0) ? 0.0065 : 0.0038;
                    offset += -(bd / bRad) * (1.0 - rn * rn) * bStr * bFade;

                    vec3 bnVec = vec3(bd / bRad, dome);
                    float bSpec = pow(max(0.0, dot(bnVec, hDir)), 28.0) * 0.30;
                    float bRim = pow(1.0 - dome, 2.8) * smoothstep(1.0, 0.72, rn) * (0.28 + 0.72 * max(0.0, bnVec.y * 0.65 - bnVec.x * 0.25 + 0.25));
                    rimSpec += (bSpec + bRim * 0.40) * bFade * (b == 0 ? 0.42 : 0.26);
                  }
                }
              }
            }

            return vec3(offset * edgeMask, clamp(rimSpec, 0.0, 1.0) * edgeMask);
          }

          vec3 agxDefaultContrastApprox(vec3 x) {
            vec3 x2 = x * x;
            vec3 x4 = x2 * x2;
            return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
          }
          vec3 agxToneMapping(vec3 color) {
            const mat3 LINEAR_SRGB_TO_REC2020 = mat3(
              vec3(0.6274, 0.0691, 0.0164),
              vec3(0.3293, 0.9195, 0.0880),
              vec3(0.0433, 0.0113, 0.8956)
            );
            const mat3 LINEAR_REC2020_TO_SRGB = mat3(
              vec3( 1.6605, -0.1246, -0.0182),
              vec3(-0.5876,  1.1329, -0.1006),
              vec3(-0.0728, -0.0083,  1.1187)
            );
            const mat3 AgXInsetMatrix = mat3(
              vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
              vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
              vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
            );
            const mat3 AgXOutsetMatrix = mat3(
              vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
              vec3(-0.11060664309660323, 1.157823702216272,  -0.11060664309660294),
              vec3(-0.016493938717834573,-0.016493938717834257, 1.2519364065950405)
            );
            const float AgxMinEv = -12.47393;
            const float AgxMaxEv =  4.026069;
            color = LINEAR_SRGB_TO_REC2020 * color;
            color = AgXInsetMatrix * max(color, 1e-10);
            color = clamp(log2(color), AgxMinEv, AgxMaxEv);
            color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
            color = agxDefaultContrastApprox(color);
            color = AgXOutsetMatrix * color;
            color = pow(max(vec3(0.0), color), vec3(2.2));
            color = LINEAR_REC2020_TO_SRGB * color;
            return clamp(color, 0.0, 1.0);
          }
          vec3 linearToSRGB(vec3 c) {
            vec3 lo = c * 12.92;
            vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
            return mix(lo, hi, step(vec3(0.0031308), c));
          }

          void main() {
            vec2 sampleNormUv = vUv;
            vec3 lensRain = vec3(0.0);
            if (uLensRain > 0.02) {
              lensRain = computeLensRain(vUv, uTime);
              sampleNormUv = clamp(vUv + lensRain.xy * uLensRain, 0.001, 0.999);
            }
            if (uMuzzleHeat > 0.04) {
              vec2 heatOrigin = mix(vec2(0.56, 0.42), vec2(0.50, 0.44), uAdsAlpha);
              vec2 hd = sampleNormUv - heatOrigin;
              float hr = length(hd * vec2(uAspect, 1.0));
              float heatEnv = exp(-hr * 11.0) * smoothstep(0.015, 0.06, length((sampleNormUv - 0.5) * vec2(uAspect, 1.0)));
              float wave = sin(sampleNormUv.y * 85.0 - uTime * 22.0) * cos(sampleNormUv.x * 60.0 + uTime * 14.0);
              sampleNormUv = clamp(sampleNormUv + vec2(wave * 0.0018, -0.0012) * uMuzzleHeat * heatEnv, 0.001, 0.999);
            }

            float centerDist = length((sampleNormUv - 0.5) * vec2(uAspect, 1.0));
            vec2 texUv = clamp(sampleNormUv * uFullUvScale, uFullUvMin, uFullUvMax);
            vec3 col = texture(tDiffuse, texUv).rgb;

            float dofBlurMask = uAdsAlpha * smoothstep(uIsDmrScoped > 0.5 ? 0.34 : 0.24, uIsDmrScoped > 0.5 ? 0.52 : 0.58, centerDist);
            if (dofBlurMask > 0.02) {
              vec3 bokeh = col;
              float r = dofBlurMask * 3.4;
              for (int k = 0; k < 6; k++) {
                float a = float(k) * 1.0471975;
                vec2 off = vec2(cos(a), sin(a)) * uTexel * r;
                bokeh += texture(tDiffuse, clamp(texUv + off, uFullUvMin, uFullUvMax)).rgb;
              }
              col = bokeh / 7.0;
            }

            float caStrength = 0.0008 + uAdsAlpha * 0.0016 * smoothstep(0.28, 0.72, centerDist);
            vec2 caVec = (sampleNormUv - 0.5) * caStrength * centerDist * uFullUvScale;
            if (caStrength > 0.0009) {
              col.r = mix(col.r, texture(tDiffuse, clamp(texUv + caVec, uFullUvMin, uFullUvMax)).r, 0.65);
              col.b = mix(col.b, texture(tDiffuse, clamp(texUv - caVec, uFullUvMin, uFullUvMax)).b, 0.65);
            }

            col += texture(tBloom, clamp(sampleNormUv * uBloomUvScale, uBloomUvMin, uBloomUvMax)).rgb * uBloomStrength;

            if (uLensRain > 0.02 && lensRain.z > 0.001) {
              vec3 skyRimTint = vec3(0.52, 0.66, 0.84);
              float sceneLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
              float rimGain = 0.085 + 0.125 * clamp(sceneLum * 1.8, 0.0, 1.0);
              col += skyRimTint * (lensRain.z * uLensRain * rimGain);
            }

            if (uScanWave > 0.001 && uScanWave < 0.999) {
              float waveR = uScanWave * 1.15;
              float ring = exp(-abs(centerDist - waveR) * 28.0) * (1.0 - uScanWave);
              float grid = smoothstep(0.92, 1.0, sin(vUv.y * 140.0)) * ring * 0.35;
              col += vec3(0.15, 0.78, 1.0) * (ring * 0.42 + grid);
            }

            if (uLowHp > 0.02) {
              float luma = dot(col, vec3(0.299, 0.587, 0.114));
              col = mix(col, vec3(luma) * vec3(1.05, 0.82, 0.82), uLowHp * 0.48);
              float vig = smoothstep(0.28, 0.88, length(vUv - 0.5));
              float pulse = 0.75 + 0.25 * sin(uTime * 7.5);
              col = mix(col, col * vec3(1.15, 0.32, 0.28), vig * uLowHp * 0.55 * pulse);
            }

            float edgeVig = 1.0 - smoothstep(0.55, 1.15, centerDist) * 0.22;
            col *= edgeVig;

            float autoExp = clamp(texture(tExposure, vec2(0.5)).r, 0.88, 1.28);
            vec3 mapped = agxToneMapping(col * uBaseExposure * autoExp);
            fragColor = vec4(linearToSRGB(mapped), 1.0);
          }
        `,
      });

      // Pass 10: FXAA 3.11 + FidelityFX RCAS 上采样锐化（原生输出分辨率）-> Screen
      this.finalAaSharpenMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tDiffuse: { value: this.ldrTarget.texture },
          uFullUvScale: { value: this._fullUvScale },
          uFullUvMin: { value: this._fullUvMin },
          uFullUvMax: { value: this._fullUvMax },
          uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
          uTime: { value: 0 },
          uSharpness: { value: 0.28 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform vec2 uFullUvScale;
          uniform vec2 uFullUvMin;
          uniform vec2 uFullUvMax;
          uniform vec2 uTexel;
          uniform float uTime;
          uniform float uSharpness;
          in vec2 vUv;
          layout(location = 0) out vec4 fragColor;

          float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

          vec3 sampleSafe(vec2 uv) {
            return texture(tDiffuse, clamp(uv, uFullUvMin, uFullUvMax)).rgb;
          }

          vec3 fxaa(vec2 uv) {
            vec3 rgbM  = sampleSafe(uv);
            vec3 rgbNW = sampleSafe(uv + vec2(-1.0, -1.0) * uTexel);
            vec3 rgbNE = sampleSafe(uv + vec2( 1.0, -1.0) * uTexel);
            vec3 rgbSW = sampleSafe(uv + vec2(-1.0,  1.0) * uTexel);
            vec3 rgbSE = sampleSafe(uv + vec2( 1.0,  1.0) * uTexel);

            float lM = luma(rgbM);
            float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
            float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
            float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
            float range = lMax - lMin;
            if (range < max(0.0312, lMax * 0.125)) return rgbM;

            vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
            float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
            float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
            dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;

            vec3 rgbA = 0.5 * (
              sampleSafe(uv + dir * (1.0 / 3.0 - 0.5)) +
              sampleSafe(uv + dir * (2.0 / 3.0 - 0.5))
            );
            vec3 rgbB = rgbA * 0.5 + 0.25 * (
              sampleSafe(uv + dir * -0.5) +
              sampleSafe(uv + dir *  0.5)
            );
            float lB = luma(rgbB);
            return (lB < lMin || lB > lMax) ? rgbA : rgbB;
          }

          void main() {
            vec2 baseUv = clamp(vUv * uFullUvScale, uFullUvMin, uFullUvMax);
            vec3 c = fxaa(baseUv);
            vec3 n = sampleSafe(baseUv + vec2(0.0, uTexel.y));
            vec3 s = sampleSafe(baseUv - vec2(0.0, uTexel.y));
            vec3 e = sampleSafe(baseUv + vec2(uTexel.x, 0.0));
            vec3 w = sampleSafe(baseUv - vec2(uTexel.x, 0.0));
            vec3 minC = min(c, min(min(n, s), min(e, w)));
            vec3 maxC = max(c, max(max(n, s), max(e, w)));
            // FidelityFX RCAS 安全权重：取三通道最小 headroom 防止 RGB 色相撕裂，且限制 |w| <= 0.165 (< 0.25) 保证分母 1+4w 恒正
            vec3 ampVec = clamp(min(minC, 1.0 - maxC) / max(maxC, vec3(1e-4)), 0.0, 1.0);
            float amp = min(ampVec.r, min(ampVec.g, ampVec.b));
            float rcasPeak = mix(0.08, 0.165, clamp(uSharpness, 0.0, 1.0));
            float wRcas = clamp(-sqrt(amp) * rcasPeak, -0.165, 0.0);
            float rcasDenom = max(0.30, 1.0 + 4.0 * wRcas);
            vec3 sharp = (c + (n + s + e + w) * wRcas) / rcasDenom;
            sharp = clamp(sharp, max(vec3(0.0), minC - 0.04), min(vec3(1.0), maxC + 0.04));

            float grain = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 131.7, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
            fragColor = vec4(clamp(sharp + grain * 0.008, 0.0, 1.0), 1.0);
          }
        `,
      });
    }

    _runQuad(material, target) {
      this.quad.material = material;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.postScene, this.postCamera);
    }

    resetHistory() {
      this._historyValid = false;
    }

    resize(rw, rh) {
      const w = Math.max(64, (Math.floor(rw) & ~1) || 64);
      const h = Math.max(64, (Math.floor(rh) & ~1) || 64);
      if (!this.initialized) {
        this._initTargetsAndShaders(w, h);
      }
      if (this.width !== w || this.height !== h) {
        this.width = w;
        this.height = h;
        const hw = Math.max(8, w >> 1);
        const hh = Math.max(8, h >> 1);

        this.gTarget.setSize(w, h);
        this.hdrTarget.setSize(w, h);
        this.ldrTarget.setSize(w, h);
        this.halfGeomA.setSize(hw, hh);
        this.halfGeomB.setSize(hw, hh);
        this.aoTarget.setSize(hw, hh);
        this.ssrTarget.setSize(hw, hh);
        this.volTarget.setSize(hw, hh);
        this.temporalHistA.setSize(hw, hh);
        this.temporalHistB.setSize(hw, hh);
        this.temporalFinal.setSize(hw, hh);

        for (let i = 0; i < this.hdrColorMips.length; i++) {
          this.hdrColorMips[i].setSize(Math.max(4, w >> (i + 1)), Math.max(4, h >> (i + 1)));
        }
        for (let i = 0; i < this.bloomDown.length; i++) {
          this.bloomDown[i].setSize(Math.max(4, w >> (i + 1)), Math.max(4, h >> (i + 1)));
        }
        for (let i = 0; i < this.bloomUp.length; i++) {
          this.bloomUp[i].setSize(Math.max(4, w >> (i + 1)), Math.max(4, h >> (i + 1)));
        }
        this._historyValid = false;
      }
      this.setDrsViewport(this.drsScale);
    }

    /**
     * 零分配 DRS Viewport/Scissor 更新：在预分配 RenderTarget 内缩放绘制区域，永不触发重分配
     */
    setDrsViewport(drsScale = 1.0) {
      if (!this.initialized) return;
      const vp = typeof GameLogic !== 'undefined' && GameLogic.computeActiveViewportSize
        ? GameLogic.computeActiveViewportSize(this.width, this.height, drsScale)
        : (() => {
            const s = Math.max(0.5, Math.min(1.0, Number.isFinite(drsScale) ? drsScale : 1.0));
            const aw = s >= 0.999 ? this.width : Math.min(this.width, Math.max(64, Math.floor((this.width * s) / 2) * 2));
            const ah = s >= 0.999 ? this.height : Math.min(this.height, Math.max(64, Math.floor((this.height * s) / 2) * 2));
            return { activeW: aw, activeH: ah, uvScaleX: aw / this.width, uvScaleY: ah / this.height, uvMaxX: (aw - 0.5) / this.width, uvMaxY: (ah - 0.5) / this.height };
          })();

      this.drsScale = drsScale;
      this.activeWidth = vp.activeW;
      this.activeHeight = vp.activeH;

      const aw = vp.activeW;
      const ah = vp.activeH;
      const hw = Math.max(4, aw >> 1);
      const hh = Math.max(4, ah >> 1);

      this._applyTargetViewport(this.gTarget, aw, ah);
      this._applyTargetViewport(this.hdrTarget, aw, ah);
      this._applyTargetViewport(this.ldrTarget, aw, ah);

      this._applyTargetViewport(this.halfGeomA, hw, hh);
      this._applyTargetViewport(this.halfGeomB, hw, hh);
      this._applyTargetViewport(this.aoTarget, hw, hh);
      this._applyTargetViewport(this.ssrTarget, hw, hh);
      this._applyTargetViewport(this.volTarget, hw, hh);
      this._applyTargetViewport(this.temporalHistA, hw, hh);
      this._applyTargetViewport(this.temporalHistB, hw, hh);
      this._applyTargetViewport(this.temporalFinal, hw, hh);

      this._getTargetUvBounds(this.gTarget, this._fullUvScale, this._fullUvMin, this._fullUvMax, null);
      this._getTargetUvBounds(this.halfGeomA, this._halfUvScale, this._halfUvMin, this._halfUvMax, this._halfTexel);
      this._fullMaxTexel.set(Math.max(0, aw - 1), Math.max(0, ah - 1));

      for (let i = 0; i < this.hdrColorMips.length; i++) {
        const mw = Math.max(2, aw >> (i + 1));
        const mh = Math.max(2, ah >> (i + 1));
        this._applyTargetViewport(this.hdrColorMips[i], mw, mh);
        this._getTargetUvBounds(
          this.hdrColorMips[i],
          this.ssrMat.uniforms.uMipUvScale.value[i],
          this.ssrMat.uniforms.uMipUvMin.value[i],
          this.ssrMat.uniforms.uMipUvMax.value[i],
          null
        );
      }
      for (let i = 0; i < this.bloomDown.length; i++) {
        this._applyTargetViewport(this.bloomDown[i], Math.max(2, aw >> (i + 1)), Math.max(2, ah >> (i + 1)));
      }
      for (let i = 0; i < this.bloomUp.length; i++) {
        this._applyTargetViewport(this.bloomUp[i], Math.max(2, aw >> (i + 1)), Math.max(2, ah >> (i + 1)));
      }

      this._getTargetUvBounds(
        this.bloomUp[0],
        this.opticsAgxMat.uniforms.uBloomUvScale.value,
        this.opticsAgxMat.uniforms.uBloomUvMin.value,
        this.opticsAgxMat.uniforms.uBloomUvMax.value,
        null
      );

      this.bloomPrefilterMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      this.opticsAgxMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      this.finalAaSharpenMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      // 略低于 1.0 时适度提升 RCAS 锐化补偿上采样柔和感
      const sNorm = aw / Math.max(1, this.width);
      this.finalAaSharpenMat.uniforms.uSharpness.value = Math.min(1.0, Math.max(0.0, 0.30 + (1.0 - sNorm) * 1.4));
    }

    /**
     * 按真实渲染目标与相机制动状态微批异步预热所有场景及管线着色器，杜绝首帧/切档卡死
     */
    async warmupShadersAsync(shadowLights = [], onProgress = null, isCancelled = null) {
      if (!this.initialized) return false;
      const report = (pct, text) => {
        if (onProgress) onProgress(pct, text);
      };

      const prevTarget = this.renderer.getRenderTarget();
      const prevLayerMask = this.camera.layers.mask;
      const prevAutoClear = this.renderer.autoClear;

      try {
        // 1. 预先初始化阴影贴图，确保 depthTexture / shadow.map 非空
        this.camera.layers.set(0);
        this.renderer.setRenderTarget(this.gTarget);
        for (const sl of shadowLights) {
          if (sl && sl.castShadow && sl.shadow) {
            sl.shadow.needsUpdate = true;
          }
        }
        report(0.08, _warmupText('warmup.collectVariants', '收集场景材质变体'));
        await yieldToMainThread(true);
        if (isCancelled && isCancelled()) return false;

        // 2. 收集并去重 Layer 0（写 gTarget）与 Layer 1（写 hdrTarget）唯一网格变体
        const seenKeys = new Set();
        const layer0Proxies = [];
        const layer1Proxies = [];
        this.scene.traverseVisible((obj) => {
          if (!obj || !obj.geometry || !obj.material) return;
          if (!(obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite)) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          const isLayer1 = (obj.layers.mask & 2) !== 0 && (obj.layers.mask & 1) === 0;
          for (const mat of mats) {
            if (!mat) continue;
            const kind = obj.isInstancedMesh ? 'I' : obj.isPoints ? 'P' : obj.isLine ? 'L' : 'M';
            const key = `${mat.id}_${kind}_${obj.receiveShadow ? 1 : 0}_${isLayer1 ? 1 : 0}_${!!obj.instanceColor}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            let proxy;
            if (obj.isInstancedMesh) {
              proxy = new THREE.InstancedMesh(obj.geometry, mat, Math.max(1, Math.min(1, obj.count)));
              if (obj.instanceColor) proxy.instanceColor = obj.instanceColor;
            } else if (obj.isPoints) {
              proxy = new THREE.Points(obj.geometry, mat);
            } else if (obj.isLine) {
              proxy = new THREE.Line(obj.geometry, mat);
            } else {
              proxy = new THREE.Mesh(obj.geometry, mat);
            }
            proxy.receiveShadow = obj.receiveShadow;
            proxy.castShadow = obj.castShadow;
            proxy.layers.mask = obj.layers.mask;
            proxy.frustumCulled = false;

            if (isLayer1) layer1Proxies.push(proxy);
            else layer0Proxies.push(proxy);
          }
        });

        const compileQueue = [];
        const batchSize = 3;
        for (let i = 0; i < layer0Proxies.length; i += batchSize) {
          compileQueue.push({ layer: 0, target: this.gTarget, items: layer0Proxies.slice(i, i + batchSize) });
        }
        for (let i = 0; i < layer1Proxies.length; i += batchSize) {
          compileQueue.push({ layer: 1, target: this.hdrTarget, items: layer1Proxies.slice(i, i + batchSize) });
        }

        const postPasses = [
          [this.halfDepthNormalMat, this.halfGeomA],
          [this.downsampleMat, this.hdrColorMips[0]],
          [this.gtaoMat, this.aoTarget],
          [this.ssrMat, this.ssrTarget],
          [this.volumetricMat, this.volTarget],
          [this.temporalResolveMat, this.temporalHistA],
          [this.bilateralMrtMat, this.temporalFinal],
          [this.opaqueCompMat, this.hdrTarget],
          [this.depthCopyMat, this.hdrTarget],
          [this.bloomPrefilterMat, this.bloomDown[0]],
          [this.kawaseDownMat, this.bloomDown[1]],
          [this.kawaseUpMat, this.bloomUp[0]],
          [this.expSampleMat, this.expDown16],
          [this.expAdaptMat, this.expHistA],
          [this.opticsAgxMat, this.ldrTarget],
          [this.finalAaSharpenMat, null],
        ];

        const totalSteps = Math.max(1, compileQueue.length + Math.ceil(postPasses.length / 4));
        let done = 0;

        for (const batch of compileQueue) {
          if (isCancelled && isCancelled()) return false;
          const group = new THREE.Group();
          for (const p of batch.items) group.add(p);
          this.camera.layers.set(batch.layer);
          this.renderer.setRenderTarget(batch.target);
          await this.renderer.compileAsync(group, this.camera, this.scene);
          done++;
          report(
            0.12 + 0.65 * (done / totalSteps),
            _warmupText('warmup.compileSceneShaders', `异步预编译场景着色器 (${done}/${compileQueue.length})`, { done, total: compileQueue.length })
          );
          await yieldToMainThread(true);
        }

        for (let i = 0; i < postPasses.length; i++) {
          if (isCancelled && isCancelled()) return false;
          const [mat, target] = postPasses[i];
          this.quad.material = mat;
          this.renderer.setRenderTarget(target);
          await this.renderer.compileAsync(this.postScene, this.postCamera, this.postScene);
          if ((i & 3) === 3 || i === postPasses.length - 1) {
            done++;
            report(0.12 + 0.85 * Math.min(1, done / totalSteps), _warmupText('warmup.compilePostPipeline', '异步预编译后期与光学管线'));
            await yieldToMainThread(true);
          }
        }

        this._historyValid = false;
        report(1.0, _warmupText('warmup.pipelineReady', '极限画质管线就绪'));
        return true;
      } finally {
        this.renderer.setRenderTarget(prevTarget);
        this.camera.layers.mask = prevLayerMask;
        this.renderer.autoClear = prevAutoClear;
      }
    }

    renderFrame(state) {
      if (!this.initialized) return false;
      const {
        sunsetLight,
        searchlights,
        flashlight,
        time,
        lensRainAlpha,
        lowHpFactor,
        scanWave,
        blackout,
        adsAlpha,
        isDmrScoped,
        muzzleHeat,
        dt,
      } = state;

      this.camera.updateMatrixWorld();
      const pe = this.camera.projectionMatrix.elements;
      this._viewRayScale.set(1 / Math.max(1e-5, pe[0]), 1 / Math.max(1e-5, pe[5]));
      this._invViewRayScale.set(pe[0], pe[5]);
      this._depthParams.set(-pe[14], -pe[10]);
      this._invProj.copy(this.camera.projectionMatrixInverse);
      this._invView.copy(this.camera.matrixWorld);
      this._frameIndex = (this._frameIndex + 1) & 1023;
      const framePhase = this._frameIndex % 16;

      // 1. 仅渲染 Layer 0（不透明实体 + 天空 + 海面）至 MRT G-Buffer
      const prevAutoClear = this.renderer.autoClear;
      const prevLayersMask = this.camera.layers.mask;
      this.camera.layers.set(0);
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(this.gTarget);
      this.renderer.render(this.scene, this.camera);

      // 2. 半分辨率 LinearZ + OctNormal + Rough 预处理（Nearest 零边界渗色）
      const curGeom = this._histToggle === 0 ? this.halfGeomA : this.halfGeomB;
      const prevGeom = this._histToggle === 0 ? this.halfGeomB : this.halfGeomA;
      this._runQuad(this.halfDepthNormalMat, curGeom);

      // 3. HDR 色彩金字塔供粗糙度锥形 SSR 查表
      for (let i = 0; i < this.hdrColorMips.length; i++) {
        const srcRt = i === 0 ? this.gTarget : this.hdrColorMips[i - 1];
        const srcTex = i === 0 ? this.gTarget.textures[0] : srcRt.texture;
        const dstRt = this.hdrColorMips[i];
        const dmU = this.downsampleMat.uniforms;
        dmU.tDiffuse.value = srcTex;
        this._getTargetUvBounds(srcRt, dmU.uSrcUvScale.value, dmU.uSrcUvMin.value, dmU.uSrcUvMax.value, dmU.uTexel.value);
        this._runQuad(this.downsampleMat, dstRt);
      }

      // 4a. 半分辨率时空 GTAO + 微距接触阴影
      this._sunDirView.set(-0.82, 0.14, -0.55).normalize().transformDirection(this.camera.matrixWorldInverse);
      this.gtaoMat.uniforms.tHalfGeom.value = curGeom.texture;
      this.gtaoMat.uniforms.uFramePhase.value = framePhase;
      this._runQuad(this.gtaoMat, this.aoTarget);

      // 4b. 半分辨率粗糙度感知 SSR
      this.ssrMat.uniforms.tHalfGeom.value = curGeom.texture;
      this.ssrMat.uniforms.uFramePhase.value = framePhase;
      this._runQuad(this.ssrMat, this.ssrTarget);

      // 4c. 半分辨率阴影感知体积雾
      const vu = this.volumetricMat.uniforms;
      vu.tHalfGeom.value = curGeom.texture;
      vu.uSunShadowMap.value = sunsetLight && sunsetLight.shadow && sunsetLight.shadow.map
        ? (sunsetLight.shadow.map.depthTexture || sunsetLight.shadow.map.texture)
        : null;
      if (sunsetLight && sunsetLight.shadow) {
        vu.uSunShadowMatrix.value.copy(sunsetLight.shadow.matrix);
      }
      vu.uCamPos.value.copy(this.camera.position);
      vu.uBlackout.value = blackout ? 1.0 : 0.0;
      vu.uTime.value = time;
      vu.uFramePhase.value = framePhase;
      if (flashlight) {
        flashlight.getWorldPosition(this._flashWorldPos);
        flashlight.target.getWorldPosition(this._flashWorldDir).sub(this._flashWorldPos).normalize();
        vu.uFlashOn.value = flashlight.intensity > 0.1 ? 1.0 : 0.0;
      } else {
        vu.uFlashOn.value = 0.0;
      }
      if (searchlights && searchlights.length >= 2) {
        searchlights[0].pivot.getWorldPosition(this._spot1Origin);
        searchlights[0].targetAnchor.getWorldPosition(this._spot1Dir).sub(this._spot1Origin).normalize();
        searchlights[1].pivot.getWorldPosition(this._spot2Origin);
        searchlights[1].targetAnchor.getWorldPosition(this._spot2Dir).sub(this._spot2Origin).normalize();
      }
      this._runQuad(this.volumetricMat, this.volTarget);

      // 5a. MRT 时序重投影 + 邻域夹紧（AO / SSR / Vol 同步积累，零拖影）
      const prevHist = this._histToggle === 0 ? this.temporalHistA : this.temporalHistB;
      const nextHist = this._histToggle === 0 ? this.temporalHistB : this.temporalHistA;
      const tu = this.temporalResolveMat.uniforms;
      tu.tHalfGeomCur.value = curGeom.texture;
      tu.tHalfGeomPrev.value = prevGeom.texture;
      tu.tAoPrev.value = prevHist.textures[0];
      tu.tSsrPrev.value = prevHist.textures[1];
      tu.tVolPrev.value = prevHist.textures[2];
      tu.uTemporalReset.value = this._historyValid ? 0.0 : 1.0;
      this._runQuad(this.temporalResolveMat, nextHist);

      // 5b. 单遍 5-tap Cross-Bilateral MRT 清理（与时序历史解耦）
      const bu = this.bilateralMrtMat.uniforms;
      bu.tHalfGeom.value = curGeom.texture;
      bu.tAo.value = nextHist.textures[0];
      bu.tSsr.value = nextHist.textures[1];
      bu.tVol.value = nextHist.textures[2];
      this._runQuad(this.bilateralMrtMat, this.temporalFinal);

      // 保存当前帧 ViewProj 与 HalfUv 比例供下一帧重投影使用
      this._prevViewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      this._prevHalfUvScale.copy(this._halfUvScale);
      this._prevHalfUvMax.copy(this._halfUvMax);
      this._histToggle = 1 - this._histToggle;
      this._historyValid = true;

      // 6. 合成不透明像素并恢复硬件深度，随后渲染 Layer 1（雨丝/光束/烟雾/准星）
      this.opaqueCompMat.uniforms.uBlackout.value = blackout ? 1.0 : 0.0;
      this._runQuad(this.opaqueCompMat, this.hdrTarget);
      this.renderer.autoClear = false;
      this.quad.material = this.depthCopyMat;
      this.renderer.setRenderTarget(this.hdrTarget);
      this.renderer.render(this.postScene, this.postCamera);

      this.camera.layers.set(1);
      this.renderer.render(this.scene, this.camera);
      this.camera.layers.mask = prevLayersMask;
      this.renderer.autoClear = true;

      // 7. Dual-Kawase 4 级 Bloom（逐层传递精准 DRS UV 包络）
      this._getTargetUvBounds(
        this.hdrTarget,
        this.bloomPrefilterMat.uniforms.uSrcUvScale.value,
        this.bloomPrefilterMat.uniforms.uSrcUvMin.value,
        this.bloomPrefilterMat.uniforms.uSrcUvMax.value,
        this.bloomPrefilterMat.uniforms.uTexel.value
      );
      this._runQuad(this.bloomPrefilterMat, this.bloomDown[0]);
      for (let i = 1; i < this.bloomDown.length; i++) {
        const prev = this.bloomDown[i - 1];
        const ku = this.kawaseDownMat.uniforms;
        ku.tDiffuse.value = prev.texture;
        this._getTargetUvBounds(prev, ku.uSrcUvScale.value, ku.uSrcUvMin.value, ku.uSrcUvMax.value, null);
        ku.uHalfPixel.value.set(0.5 / prev.width, 0.5 / prev.height);
        this._runQuad(this.kawaseDownMat, this.bloomDown[i]);
      }
      for (let i = this.bloomUp.length - 1; i >= 0; i--) {
        const src = i === this.bloomUp.length - 1 ? this.bloomDown[i + 1] : this.bloomUp[i + 1];
        const add = this.bloomDown[i];
        const ku = this.kawaseUpMat.uniforms;
        ku.tDiffuse.value = src.texture;
        ku.tAdd.value = add.texture;
        this._getTargetUvBounds(src, ku.uSrcUvScale.value, ku.uSrcUvMin.value, ku.uSrcUvMax.value, null);
        this._getTargetUvBounds(add, ku.uAddUvScale.value, ku.uAddUvMin.value, ku.uAddUvMax.value, null);
        ku.uHalfPixel.value.set(0.5 / src.width, 0.5 / src.height);
        this._runQuad(this.kawaseUpMat, this.bloomUp[i]);
      }

      // 8. GPU 时序自动曝光 (16x16 -> 1x1 乒乓)
      this._runQuad(this.expSampleMat, this.expDown16);
      const prevExp = this._expToggle === 0 ? this.expHistA : this.expHistB;
      const nextExp = this._expToggle === 0 ? this.expHistB : this.expHistA;
      this.expAdaptMat.uniforms.tPrev.value = prevExp.texture;
      this.expAdaptMat.uniforms.uAdaptAlpha.value = Math.min(0.25, Math.max(0.015, (dt || 0.016) * 2.4));
      this._runQuad(this.expAdaptMat, nextExp);
      this._expToggle = 1 - this._expToggle;

      // 9. HDR 相机光学（ADS DoF / 热浪 / 边缘雨滴 / 微色散 / AgX）-> ldrTarget
      const ou = this.opticsAgxMat.uniforms;
      ou.tExposure.value = nextExp.texture;
      ou.uTime.value = time;
      ou.uAspect.value = this.activeWidth / Math.max(1, this.activeHeight);
      ou.uLensRain.value = lensRainAlpha;
      ou.uLowHp.value = lowHpFactor;
      ou.uScanWave.value = scanWave;
      ou.uAdsAlpha.value = adsAlpha || 0;
      ou.uIsDmrScoped.value = isDmrScoped ? 1.0 : 0.0;
      ou.uMuzzleHeat.value = muzzleHeat || 0;
      this._runQuad(this.opticsAgxMat, this.ldrTarget);

      // 10. FXAA 3.11 + RCAS 上采样锐化 -> 原生画布
      this.finalAaSharpenMat.uniforms.uTime.value = time;
      this._runQuad(this.finalAaSharpenMat, null);

      this.renderer.autoClear = prevAutoClear;
      return true;
    }

    dispose() {
      const targets = [
        this.gTarget, this.halfGeomA, this.halfGeomB, this.aoTarget, this.ssrTarget, this.volTarget,
        this.temporalHistA, this.temporalHistB, this.temporalFinal,
        this.hdrTarget, this.expDown16, this.expHistA, this.expHistB, this.ldrTarget,
        ...(this.hdrColorMips || []), ...(this.bloomDown || []), ...(this.bloomUp || []),
      ];
      for (const t of targets) {
        if (t && t.dispose) t.dispose();
      }
      const mats = [
        this.halfDepthNormalMat, this.downsampleMat, this.gtaoMat, this.ssrMat,
        this.volumetricMat, this.temporalResolveMat, this.bilateralMrtMat,
        this.opaqueCompMat, this.depthCopyMat, this.bloomPrefilterMat,
        this.kawaseDownMat, this.kawaseUpMat, this.expSampleMat,
        this.expAdaptMat, this.opticsAgxMat, this.finalAaSharpenMat,
      ];
      for (const m of mats) {
        if (m && m.dispose) m.dispose();
      }
      if (this.quad && this.quad.geometry) this.quad.geometry.dispose();
    }
  }

  const _tmpMat = new THREE.Matrix4();
  const _tmpQuat = new THREE.Quaternion();
  const _tmpEuler = new THREE.Euler();
  const _tmpPos = new THREE.Vector3();
  const _tmpScale = new THREE.Vector3();

  function createTransformedGeo(geo, opts = {}) {
    if (!geo) return null;
    _tmpPos.set(opts.x || 0, opts.y || 0, opts.z || 0);
    _tmpEuler.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
    _tmpQuat.setFromEuler(_tmpEuler);
    _tmpScale.set(opts.sx ?? 1, opts.sy ?? 1, opts.sz ?? 1);
    _tmpMat.compose(_tmpPos, _tmpQuat, _tmpScale);
    geo.applyMatrix4(_tmpMat);
    return geo;
  }

  function mergeGeometriesSafe(geos) {
    const valid = (geos || []).filter(Boolean);
    if (!valid.length) return null;
    const prepped = [];
    for (const g of valid) {
      const ng = g.index ? g.toNonIndexed() : g.clone();
      if (!ng.attributes.normal) ng.computeVertexNormals();
      if (!ng.attributes.uv && ng.attributes.position) {
        const count = ng.attributes.position.count;
        ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      for (const name of Object.keys(ng.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') {
          ng.deleteAttribute(name);
        }
      }
      prepped.push(ng);
      g.dispose();
    }
    let merged = null;
    if (typeof window !== 'undefined' && window.THREE_UTILS && window.THREE_UTILS.mergeGeometries) {
      merged = window.THREE_UTILS.mergeGeometries(prepped, false);
    } else if (typeof THREE_UTILS !== 'undefined' && THREE_UTILS.mergeGeometries) {
      merged = THREE_UTILS.mergeGeometries(prepped, false);
    }
    if (!merged) {
      let totalVerts = 0;
      for (const ng of prepped) totalVerts += ng.attributes.position.count;
      const posArr = new Float32Array(totalVerts * 3);
      const normArr = new Float32Array(totalVerts * 3);
      const uvArr = new Float32Array(totalVerts * 2);
      let off = 0;
      for (const ng of prepped) {
        const c = ng.attributes.position.count;
        posArr.set(ng.attributes.position.array, off * 3);
        normArr.set(ng.attributes.normal.array, off * 3);
        uvArr.set(ng.attributes.uv.array, off * 2);
        off += c;
      }
      merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      merged.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
      merged.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    }
    for (const ng of prepped) ng.dispose();
    return merged;
  }

  return {
    detectCapabilities,
    yieldToMainThread,
    GpuPbrBaker,
    ExtremeMaterialManager,
    ExtremeRenderPipeline,
    createTransformedGeo,
    mergeGeometriesSafe,
  };
})();
