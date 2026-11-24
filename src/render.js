// ============================================================================
// 模块 3：渲染引擎、半分辨率水洼倒影、体积光柱与 GPU 暴雨系统 (RenderEngine)
// ============================================================================

const RenderEngine = (() => {
  'use strict';

  class PuddleReflector extends THREE.Mesh {
    constructor(width, depth, puddleTex, texWidth, texHeight, rainOccTex = null) {
      const geo = new THREE.PlaneGeometry(width, depth);
      const occTex = rainOccTex || (() => {
        const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
        t.flipY = false;
        t.minFilter = THREE.NearestFilter;
        t.magFilter = THREE.NearestFilter;
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
        return t;
      })();
      const uniforms = {
        tDiffuse: { value: null },
        tPuddle: { value: puddleTex },
        tRainOcclusion: { value: occTex },
        uRainOccBounds: { value: new THREE.Vector4(-55, -45, 1 / 110, 1 / 90) },
        uRainOccMaxH: { value: 24.0 },
        uRippleLayers: { value: 2.0 },
        textureMatrix: { value: new THREE.Matrix4() },
        uTime: { value: 0 },
        uWorldSize: { value: new THREE.Vector2(width, depth) },
        uCameraPos: { value: new THREE.Vector3() },
        uSunsetDir: { value: new THREE.Vector3(-0.82, 0.14, -0.55).normalize() },
        uMuzzlePos: { value: new THREE.Vector3() },
        uMuzzleIntensity: { value: 0 },
        uSpot1Pos: { value: new THREE.Vector3() },
        uSpot1Color: { value: new THREE.Color(0x9ce4ff) },
        uSpot2Pos: { value: new THREE.Vector3() },
        uSpot2Color: { value: new THREE.Color(0x9ce4ff) },
        uUseReflection: { value: 1.0 },
        uExtremeMode: { value: 0.0 },
      };

      const mat = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */ `
          uniform mat4 textureMatrix;
          varying vec4 vProjUv;
          varying vec3 vWorldPos;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldPos = worldPos.xyz;
            vProjUv = textureMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * viewMatrix * worldPos;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform sampler2D tPuddle;
          uniform sampler2D tRainOcclusion;
          uniform vec4 uRainOccBounds;
          uniform float uRainOccMaxH;
          uniform float uRippleLayers;
          uniform float uTime;
          uniform vec2 uWorldSize;
          uniform vec3 uCameraPos;
          uniform vec3 uSunsetDir;
          uniform vec3 uMuzzlePos;
          uniform float uMuzzleIntensity;
          uniform vec3 uSpot1Pos;
          uniform vec3 uSpot1Color;
          uniform vec3 uSpot2Pos;
          uniform vec3 uSpot2Color;
          uniform float uUseReflection;
          uniform float uExtremeMode;

          varying vec4 vProjUv;
          varying vec3 vWorldPos;

          float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }

          // 2x2 邻域抖动多尺度雨滴涟漪：消除单元格边界裁剪，支持双环色散与初始落点闪光
          vec3 computeRainRipples(vec2 xz, float time) {
            vec2 grad = vec2(0.0);
            float glint = 0.0;
            for (int layer = 0; layer < 3; layer++) {
              if (float(layer) >= uRippleLayers - 0.5) break;
              float scale = layer == 0 ? 1.55 : (layer == 1 ? 2.65 : 4.35);
              float amp = layer == 0 ? 0.14 : (layer == 1 ? 0.11 : 0.08);
              vec2 uv = xz * scale;
              vec2 baseCell = floor(uv - 0.5);
              for (int iy = 0; iy <= 1; iy++) {
                for (int ix = 0; ix <= 1; ix++) {
                  vec2 cell = baseCell + vec2(float(ix), float(iy));
                  float rnd = hash21(cell + float(layer) * 19.3);
                  float speed = 0.88 + 0.38 * rnd;
                  float timePhase = time * speed + rnd * 13.7;
                  float cycle = floor(timePhase);
                  float t = fract(timePhase);
                  float activeRnd = hash21(cell + vec2(cycle * 7.13, float(layer) * 31.7));
                  if (activeRnd > 0.42) {
                    vec2 jitter = vec2(
                      hash21(cell + vec2(cycle * 11.3 + 3.1, float(layer) * 5.7)) - 0.5,
                      hash21(cell + vec2(cycle * 17.9 + 7.7, float(layer) * 9.1)) - 0.5
                    ) * 0.44;
                    vec2 center = cell + 0.5 + jitter;
                    vec2 d = uv - center;
                    float dist = length(d);
                    float maxR = 0.54;
                    float r1 = t * maxR;
                    float r2 = max(0.0, t - 0.08) * (maxR * 0.78);
                    float ring1 = dist - r1;
                    float ring2 = dist - r2;
                    float edgeFade = smoothstep(0.74, 0.50, dist);
                    float lifeFade = (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.04, t) * edgeFade;
                    float w1 = sin(ring1 * 48.0) * exp(-abs(ring1) * 24.0);
                    float w2 = sin(ring2 * 64.0) * exp(-abs(ring2) * 30.0) * 0.55 * step(0.08, t);
                    float wave = (w1 + w2) * lifeFade;
                    grad += (d / max(0.0001, dist)) * wave * amp;
                    if (t < 0.12) {
                      float glintT = 1.0 - smoothstep(0.0, 0.12, t);
                      glint += exp(-dist * dist * 160.0) * glintT * edgeFade;
                    }
                  }
                }
              }
            }
            return vec3(grad, min(1.5, glint));
          }

          void main() {
            // 严格裁剪在主码头与东北栈桥地面范围内，防止水洼浮在海面上
            float inMainDock = step(-43.0, vWorldPos.x) * step(vWorldPos.x, 22.0) * step(-34.2, vWorldPos.z) * step(vWorldPos.z, 34.0);
            float inPier = step(14.0, vWorldPos.x) * step(vWorldPos.x, 26.0) * step(-34.0, vWorldPos.z) * step(vWorldPos.z, -16.0);
            if (max(inMainDock, inPier) < 0.5) discard;

            vec2 pUv = vWorldPos.xz / uWorldSize + 0.5;
            // 配合 CanvasTexture 默认 flipY = true 对齐世界 -Z -> v=1
            pUv.y = 1.0 - pUv.y;
            float puddle = texture2D(tPuddle, clamp(pUv, 0.0, 1.0)).r;
            if (puddle < 0.04) discard;

            vec2 occUv = (vWorldPos.xz - uRainOccBounds.xy) * uRainOccBounds.zw;
            float inOcc = step(0.0, occUv.x) * step(occUv.x, 1.0) * step(0.0, occUv.y) * step(occUv.y, 1.0);
            float roofY = inOcc * texture2D(tRainOcclusion, clamp(occUv, 0.001, 0.999)).r * uRainOccMaxH;
            float rainExposed = 1.0 - step(vWorldPos.y + 0.35, roofY);
            float rippleDistFade = 1.0 - smoothstep(18.0, 38.0, length(uCameraPos - vWorldPos));
            vec3 rippleData = (rainExposed > 0.5 && rippleDistFade > 0.01)
              ? computeRainRipples(vWorldPos.xz, uTime) * rippleDistFade
              : vec3(0.0);
            vec2 ripple = rippleData.xy;
            float impactGlint = rippleData.z;

            vec3 N = normalize(vec3(ripple.x, 1.0, ripple.y));
            vec3 V = normalize(uCameraPos - vWorldPos);

            float fresnel = 0.08 + 0.92 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.2);
            vec3 reflColor = vec3(0.04, 0.07, 0.12);

            if (uUseReflection > 0.5) {
              vec4 uv = vProjUv;
              uv.xy += ripple * 0.34 * uv.w;
              reflColor = texture2DProj(tDiffuse, uv).rgb;
            } else {
              // 低画质模式：基于法线模拟天空渐变反射
              vec3 R = reflect(-V, N);
              float horizon = pow(1.0 - max(R.y, 0.0), 3.0);
              reflColor = mix(vec3(0.04, 0.07, 0.13), vec3(0.32, 0.16, 0.09), horizon * max(0.0, -R.x));
            }

            // 西侧夕阳与高塔探照灯水面动态高光
            vec3 Hsun = normalize(uSunsetDir + V);
            float sunSpec = pow(max(dot(N, Hsun), 0.0), 96.0);
            vec3 specAccum = vec3(1.0, 0.48, 0.2) * sunSpec * 0.95;

            // 枪口动态点光源水洼倒影闪烁
            if (uMuzzleIntensity > 0.01) {
              vec3 L = uMuzzlePos - vWorldPos;
              float dist2 = max(1.0, dot(L, L));
              vec3 Ln = normalize(L);
              vec3 Hm = normalize(Ln + V);
              float mSpec = pow(max(dot(N, Hm), 0.0), 42.0);
              specAccum += vec3(1.0, 0.56, 0.18) * (uMuzzleIntensity * 2.2 / (1.0 + dist2 * 0.06)) * (0.25 + mSpec * 2.0);
            }

            // 扫射探照灯水面光斑与高光
            vec3 L1 = uSpot1Pos - vWorldPos;
            float d1 = length(L1);
            specAccum += uSpot1Color * exp(-d1 * 0.14) * 0.55;

            vec3 L2 = uSpot2Pos - vWorldPos;
            float d2 = length(L2);
            specAccum += uSpot2Color * exp(-d2 * 0.14) * 0.55;

            // 落点瞬时亮斑高光
            if (impactGlint > 0.005) {
              vec3 glintLight = vec3(0.36, 0.50, 0.72)
                + uSpot1Color * exp(-d1 * 0.14) * 0.65
                + uSpot2Color * exp(-d2 * 0.14) * 0.65;
              specAccum += glintLight * impactGlint * 0.52;
            }

            // 水洼边缘极细高光环，增强与湿沥青层次感
            float alpha = smoothstep(0.04, 0.42, puddle) * mix(0.45, 0.92, fresnel);
            vec3 finalCol = reflColor * (0.65 + 0.35 * fresnel) + specAccum * puddle;

            gl_FragColor = vec4(finalCol, alpha);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });

      super(geo, mat);
      this.rotation.x = -Math.PI / 2;
      this.position.y = 0.014;
      this.renderOrder = 2;

      this.renderTarget = new THREE.WebGLRenderTarget(texWidth, texHeight, {
        multisample: 0,
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      mat.uniforms.tDiffuse.value = this.renderTarget.texture;

      this.reflectionCamera = null;
      this.hiddenObjects = [];
      this.enabled = true;

      // 预分配数学对象，保证 0 运行时 GC
      this._reflectorPlane = new THREE.Plane();
      this._normal = new THREE.Vector3();
      this._reflectorWorldPos = new THREE.Vector3();
      this._cameraWorldPos = new THREE.Vector3();
      this._rotationMatrix = new THREE.Matrix4();
      this._lookAtPos = new THREE.Vector3();
      this._clipPlane = new THREE.Vector4();
      this._view = new THREE.Vector3();
      this._target = new THREE.Vector3();
      this._q = new THREE.Vector4();
      this._textureMatrix = mat.uniforms.textureMatrix.value;

      const scope = this;
      this.onBeforeRender = function (renderer, scene, camera) {
        if (!scope.enabled) return;
        if (camera === scope.reflectionCamera) return;

        if (!scope.reflectionCamera) {
          scope.reflectionCamera = camera.clone(false);
        } else {
          scope.reflectionCamera.fov = camera.fov;
          scope.reflectionCamera.aspect = camera.aspect;
          scope.reflectionCamera.near = camera.near;
          scope.reflectionCamera.far = camera.far;
        }

        const rc = scope.reflectionCamera;
        scope._reflectorWorldPos.setFromMatrixPosition(scope.matrixWorld);
        scope._cameraWorldPos.setFromMatrixPosition(camera.matrixWorld);
        scope._rotationMatrix.extractRotation(scope.matrixWorld);
        scope._normal.set(0, 0, 1).applyMatrix4(scope._rotationMatrix);

        scope._view.subVectors(scope._reflectorWorldPos, scope._cameraWorldPos);
        if (scope._view.dot(scope._normal) > 0) return;

        scope._view.reflect(scope._normal).negate().add(scope._reflectorWorldPos);
        scope._rotationMatrix.extractRotation(camera.matrixWorld);
        scope._lookAtPos.set(0, 0, -1).applyMatrix4(scope._rotationMatrix).add(scope._cameraWorldPos);

        scope._target.subVectors(scope._reflectorWorldPos, scope._lookAtPos);
        scope._target.reflect(scope._normal).negate().add(scope._reflectorWorldPos);

        rc.position.copy(scope._view);
        rc.up.set(0, 1, 0).applyMatrix4(scope._rotationMatrix).reflect(scope._normal);
        rc.lookAt(scope._target);
        rc.updateMatrixWorld();
        rc.projectionMatrix.copy(camera.projectionMatrix);

        scope._textureMatrix.set(
          0.5, 0.0, 0.0, 0.5,
          0.0, 0.5, 0.0, 0.5,
          0.0, 0.0, 0.5, 0.5,
          0.0, 0.0, 0.0, 1.0
        );
        scope._textureMatrix.multiply(rc.projectionMatrix);
        scope._textureMatrix.multiply(rc.matrixWorldInverse);
        scope._textureMatrix.multiply(scope.matrixWorld);

        // 斜裁剪面，避免地面以下物体漏入倒影
        scope._reflectorPlane.setFromNormalAndCoplanarPoint(scope._normal, scope._reflectorWorldPos);
        scope._reflectorPlane.applyMatrix4(rc.matrixWorldInverse);
        scope._clipPlane.set(
          scope._reflectorPlane.normal.x,
          scope._reflectorPlane.normal.y,
          scope._reflectorPlane.normal.z,
          scope._reflectorPlane.constant
        );

        const pm = rc.projectionMatrix;
        scope._q.x = (Math.sign(scope._clipPlane.x) + pm.elements[8]) / pm.elements[0];
        scope._q.y = (Math.sign(scope._clipPlane.y) + pm.elements[9]) / pm.elements[5];
        scope._q.z = -1.0;
        scope._q.w = (1.0 + pm.elements[10]) / pm.elements[14];
        scope._clipPlane.multiplyScalar(2.0 / scope._clipPlane.dot(scope._q));
        pm.elements[2] = scope._clipPlane.x;
        pm.elements[6] = scope._clipPlane.y;
        pm.elements[10] = scope._clipPlane.z + 1.0 - 0.004;
        pm.elements[14] = scope._clipPlane.w;

        scope.visible = false;
        const hiddenPrev = [];
        for (let i = 0; i < scope.hiddenObjects.length; i++) {
          const obj = scope.hiddenObjects[i];
          if (obj) {
            hiddenPrev.push(obj.visible);
            obj.visible = false;
          } else {
            hiddenPrev.push(false);
          }
        }

        const prevTarget = renderer.getRenderTarget();
        const prevShadow = renderer.shadowMap.autoUpdate;
        const prevLayerMask = rc.layers.mask;
        if (scope.extremeMode) {
          rc.layers.set(0);
        } else {
          rc.layers.enableAll();
        }
        renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(scope.renderTarget);
        renderer.state.buffers.depth.setMask(true);
        renderer.clear();
        renderer.render(scene, rc);

        rc.layers.mask = prevLayerMask;
        renderer.shadowMap.autoUpdate = prevShadow;
        renderer.setRenderTarget(prevTarget);

        for (let i = 0; i < scope.hiddenObjects.length; i++) {
          if (scope.hiddenObjects[i]) scope.hiddenObjects[i].visible = hiddenPrev[i];
        }
        scope.visible = true;
      };
    }

    setResolution(w, h) {
      this.renderTarget.setSize(Math.max(64, Math.floor(w)), Math.max(64, Math.floor(h)));
    }
  }

  function createVolumetricBeamMaterial(colorHex, opacity = 0.22) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(colorHex) },
        uOpacity: { value: opacity },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormalView;
        varying vec3 vViewDir;
        void main() {
          vUv = uv;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vNormalView = normalize(normalMatrix * normal);
          vViewDir = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vNormalView;
        varying vec3 vViewDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        void main() {
          // 锥面边缘柔和菲涅尔消除多边形硬边
          float fresnel = pow(abs(dot(normalize(vNormalView), normalize(vViewDir))), 1.85);
          // 距离光束顶点纵向衰减（CylinderGeometry v=1 为顶部光源端，v=0 为地面散射端）
          float axial = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
          // 模拟雨雾飘过光柱的斜向体积微粒丝缕
          float mist = 0.65 + 0.35 * noise(vec2(vUv.x * 10.0 + uTime * 0.45, vUv.y * 5.0 + uTime * 2.1));
          float alpha = fresnel * axial * mist * uOpacity;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
    });
  }

  class VirtualPointLight {
    constructor(opts = {}) {
      this.position = new THREE.Vector3(opts.x || 0, opts.y || 0, opts.z || 0);
      this.color = new THREE.Color(opts.color !== undefined ? opts.color : 0xffffff);
      this.intensity = opts.intensity !== undefined ? opts.intensity : 1;
      this.distance = opts.distance !== undefined ? opts.distance : 0;
      this.decay = opts.decay !== undefined ? opts.decay : 2;
      this.visible = opts.visible !== undefined ? opts.visible : true;
      this.priority = opts.priority !== undefined ? opts.priority : 1.0;
      this.hostObject = opts.hostObject || null;
      this.isVirtualLight = true;
      this._worldPos = new THREE.Vector3();
      this._disposed = false;
      this._assignedSlot = -1;
      this._smoothIntensity = 0;
    }

    dispose() {
      this._disposed = true;
      this.intensity = 0;
      this.visible = false;
    }
  }

  /**
   * 固定 6 槽位智能虚拟点光源池：场景物理 PointLight 数量全程恒定，彻底消灭局内 Shader 重编译
   */
  class LightPool {
    constructor(scene, maxSlots = 6) {
      this.maxSlots = maxSlots;
      this.slots = [];
      this.slotOwner = new Array(maxSlots).fill(null);
      for (let i = 0; i < maxSlots; i++) {
        const pl = new THREE.PointLight(0xffffff, 0, 24, 1.5);
        pl.visible = true;
        scene.add(pl);
        this.slots.push(pl);
      }
      this.lights = [];
      this._topLights = new Array(maxSlots).fill(null);
      this._topScores = new Float64Array(maxSlots);
      this._inTop = new Set();
    }

    createLight(opts = {}) {
      const vl = new VirtualPointLight(opts);
      this.lights.push(vl);
      return vl;
    }

    _isHierarchyVisible(obj) {
      let cur = obj;
      while (cur) {
        if (!cur.visible) return false;
        cur = cur.parent;
      }
      return true;
    }

    update(camPos, dt = 0.016) {
      const K = this.maxSlots;
      for (let i = 0; i < K; i++) {
        this._topLights[i] = null;
        this._topScores[i] = -1;
      }

      const cx = camPos.x;
      const cy = camPos.y;
      const cz = camPos.z;

      let idx = 0;
      while (idx < this.lights.length) {
        const vl = this.lights[idx];
        if (vl._disposed) {
          this.lights[idx] = this.lights[this.lights.length - 1];
          this.lights.pop();
          continue;
        }
        idx++;

        if (!vl.visible || vl.intensity <= 0.005) continue;
        if (vl.hostObject) {
          if (!this._isHierarchyVisible(vl.hostObject)) continue;
          vl._worldPos.copy(vl.position).applyMatrix4(vl.hostObject.matrixWorld);
        }

        const p = vl.hostObject ? vl._worldPos : vl.position;
        const score = typeof GameLogic !== 'undefined' && GameLogic.scoreVirtualLight
          ? GameLogic.scoreVirtualLight(p.x, p.y, p.z, vl.intensity, vl.distance, vl.priority, cx, cy, cz)
          : ((vl.priority * Math.min(60, vl.intensity)) / (1 + p.distanceToSquared(camPos) / 256));

        if (score <= 0) continue;

        let minSlot = -1;
        let minScore = score;
        for (let s = 0; s < K; s++) {
          if (!this._topLights[s]) {
            minSlot = s;
            break;
          }
          if (this._topScores[s] < minScore) {
            minScore = this._topScores[s];
            minSlot = s;
          }
        }
        if (minSlot !== -1) {
          this._topLights[minSlot] = vl;
          this._topScores[minSlot] = score;
        }
      }

      this._inTop.clear();
      for (let i = 0; i < K; i++) {
        if (this._topLights[i]) this._inTop.add(this._topLights[i]);
      }

      // 优先保留上一帧已在槽位的光源，避免换槽抖动
      for (let s = 0; s < K; s++) {
        const owner = this.slotOwner[s];
        if (owner && !owner._disposed && this._inTop.has(owner)) {
          owner._assignedSlot = s;
        } else {
          if (owner && owner._assignedSlot === s) {
            owner._assignedSlot = -1;
            owner._smoothIntensity = 0;
          }
          this.slotOwner[s] = null;
        }
      }

      // 将新晋升的 Top 光源分配至空余物理槽位
      for (let i = 0; i < K; i++) {
        const vl = this._topLights[i];
        if (!vl || vl._assignedSlot !== -1) continue;
        for (let s = 0; s < K; s++) {
          if (!this.slotOwner[s]) {
            this.slotOwner[s] = vl;
            vl._assignedSlot = s;
            vl._smoothIntensity = vl.priority >= 7 ? vl.intensity : vl.intensity * 0.25;
            break;
          }
        }
      }

      const rampAlpha = Math.min(1.0, Math.max(0.15, (dt || 0.016) * 18.0));
      for (let s = 0; s < K; s++) {
        const pl = this.slots[s];
        const vl = this.slotOwner[s];
        if (!vl || !vl.visible || vl.intensity <= 0.005) {
          pl.intensity = 0;
          continue;
        }
        const wp = vl.hostObject ? vl._worldPos : vl.position;
        pl.position.copy(wp);
        pl.color.copy(vl.color);
        pl.distance = vl.distance;
        pl.decay = vl.decay;
        if (vl.priority >= 7.0) {
          vl._smoothIntensity = vl.intensity;
        } else {
          vl._smoothIntensity += (vl.intensity - vl._smoothIntensity) * rampAlpha;
        }
        pl.intensity = vl._smoothIntensity;
      }
    }
  }

  class Engine {
    constructor(canvas, texFactory) {
      this.canvas = canvas;
      this.texFactory = texFactory;
      this.quality = 'high';
      this.time = 0;
      this.volumetricMaterials = [];
      this.volumetricMeshes = [];
      this.searchlights = [];
      this.lightningTimer = 7;
      this.lightningFlash = 0;
      this.onLightningFlash = null;
      this.isExtremeActive = false;
      this._extremePrepared = false;
      this.drsEnabled = true;
      this.drsScale = 1.0;
      this.fpsSmooth = 60;
      this._drsCooldown = 0;
      this._whShadowTick = 0;
      this._sparksDirty = false;
      this._lastDt = 0.016;
      this._lastOpticsState = null;

      // 降雨高度遮挡贴图 1x1 零高度后备纹理（确保着色器绑定永不为 null）
      this._fallbackRainOcc = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      this._fallbackRainOcc.flipY = false;
      this._fallbackRainOcc.minFilter = THREE.NearestFilter;
      this._fallbackRainOcc.magFilter = THREE.NearestFilter;
      this._fallbackRainOcc.wrapS = THREE.ClampToEdgeWrapping;
      this._fallbackRainOcc.wrapT = THREE.ClampToEdgeWrapping;
      this._fallbackRainOcc.needsUpdate = true;
      this.rainOcclusionMap = null;
      this._rainOccTex = this._fallbackRainOcc;
      this._rainOccBounds = new THREE.Vector4(-55, -45, 1 / 110, 1 / 90);
      this._rainOccMaxH = 24;

      // 预分配每帧光源同步向量，确保热路径零 GC 分配
      this._tmpFlashPos = new THREE.Vector3();
      this._tmpFlashDir = new THREE.Vector3();
      this._tmpSpotOrigin = new THREE.Vector3();
      this._tmpSpotPos = new THREE.Vector3();
      this._tmpSpotDir = new THREE.Vector3();
      this._lensRainTarget = this._getRainProfile(this.quality).lensRainTarget;

      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.18;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap || THREE.PCFSoftShadowMap;

      this.scene = new THREE.Scene();
      this._origFog = new THREE.FogExp2(0x0a111d, 0.0175);
      this.scene.fog = this._origFog;
      this._initEnvMap();

      this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.06, 260);
      this.camera.rotation.order = 'YXZ';
      this.scene.add(this.camera);

      this.extremeSupported = typeof ExtremeGfx !== 'undefined';
      this.matMgr = this.extremeSupported ? new ExtremeGfx.ExtremeMaterialManager() : null;
      this.gpuBaker = this.extremeSupported ? new ExtremeGfx.GpuPbrBaker(this.renderer) : null;
      this.extremePipeline = this.extremeSupported
        ? new ExtremeGfx.ExtremeRenderPipeline(this.renderer, this.scene, this.camera)
        : null;

      this._initSkyAndLights();
      this._initSeaAndPuddles();
      this._initRainSystem();
      this._initSparkAndSplashPools();
      this._initPostPipeline();
      this.resize();
    }

    _getRainProfile(preset) {
      if (typeof GameLogic !== 'undefined' && typeof GameLogic.getRainQualityProfile === 'function') {
        return GameLogic.getRainQualityProfile(preset);
      }
      if (preset === 'low') return { rainCount: 1000, splashCount: 48, rippleLayers: 1, lensRainTarget: 0.0, fullLighting: false };
      if (preset === 'medium') return { rainCount: 2200, splashCount: 96, rippleLayers: 2, lensRainTarget: 0.55, fullLighting: false };
      if (preset === 'extreme') return { rainCount: 5600, splashCount: 220, rippleLayers: 3, lensRainTarget: 0.95, fullLighting: true };
      return { rainCount: 3800, splashCount: 150, rippleLayers: 2, lensRainTarget: 0.90, fullLighting: true };
    }

    _sampleRainOccHeight(x, z) {
      if (!this.rainOcclusionMap) return 0;
      if (typeof GameLogic !== 'undefined' && typeof GameLogic.sampleRainOcclusionHeight === 'function') {
        return GameLogic.sampleRainOcclusionHeight(this.rainOcclusionMap, x, z);
      }
      return 0;
    }

    setRainOcclusionMap(occMap) {
      this.rainOcclusionMap = occMap || null;
      if (!occMap || !occMap.heights || !occMap.width || !occMap.height) return;

      const width = occMap.width | 0;
      const height = occMap.height | 0;
      const total = width * height;
      const rgba = new Uint8Array(total * 4);
      const heights = occMap.heights;
      for (let i = 0; i < total; i++) {
        const p = i * 4;
        rgba[p] = heights[i] || 0;
        rgba[p + 1] = 0;
        rgba[p + 2] = 0;
        rgba[p + 3] = 255;
      }

      const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
      tex.flipY = false;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;

      if (this._rainOccTex && this._rainOccTex !== this._fallbackRainOcc && this._rainOccTex.dispose) {
        this._rainOccTex.dispose();
      }
      this._rainOccTex = tex;

      const minX = Number.isFinite(occMap.minX) ? occMap.minX : -55;
      const maxX = Number.isFinite(occMap.maxX) ? occMap.maxX : 55;
      const minZ = Number.isFinite(occMap.minZ) ? occMap.minZ : -45;
      const maxZ = Number.isFinite(occMap.maxZ) ? occMap.maxZ : 45;
      const spanX = Math.max(1e-4, maxX - minX);
      const spanZ = Math.max(1e-4, maxZ - minZ);
      const boundsVec4 = new THREE.Vector4(minX, minZ, 1 / spanX, 1 / spanZ);
      const maxH = occMap.maxHeight || 24;

      this._rainOccBounds.copy(boundsVec4);
      this._rainOccMaxH = maxH;

      if (this.rainMat && this.rainMat.uniforms) {
        this.rainMat.uniforms.tRainOcclusion.value = tex;
        this.rainMat.uniforms.uRainOccBounds.value.copy(boundsVec4);
        this.rainMat.uniforms.uRainOccMaxH.value = maxH;
      }
      if (this.splashMat && this.splashMat.uniforms) {
        this.splashMat.uniforms.tRainOcclusion.value = tex;
        this.splashMat.uniforms.uRainOccBounds.value.copy(boundsVec4);
        this.splashMat.uniforms.uRainOccMaxH.value = maxH;
      }
      if (this.puddleReflector && this.puddleReflector.material && this.puddleReflector.material.uniforms) {
        const pu = this.puddleReflector.material.uniforms;
        pu.tRainOcclusion.value = tex;
        pu.uRainOccBounds.value.copy(boundsVec4);
        pu.uRainOccMaxH.value = maxH;
      }
      if (this.matMgr && typeof this.matMgr.setRainOcclusionMap === 'function') {
        this.matMgr.setRainOcclusionMap(tex, boundsVec4, maxH);
      }
    }

    _initEnvMap() {
      // 生成程序化暴风雨暮色环境反射贴图，赋予暗部金属波纹与枪身真实冷暖环境光泽
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 128;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0.0, '#16243d');
      g.addColorStop(0.45, '#2b4466');
      g.addColorStop(0.52, '#624136');
      g.addColorStop(0.65, '#192230');
      g.addColorStop(1.0, '#0c1018');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 128);

      // 西侧夕阳高亮色块与高塔冷蓝光晕
      const sunGrad = ctx.createRadialGradient(54, 62, 4, 54, 62, 48);
      sunGrad.addColorStop(0, 'rgba(255, 130, 58, 0.85)');
      sunGrad.addColorStop(1, 'rgba(255, 130, 58, 0)');
      ctx.fillStyle = sunGrad;
      ctx.fillRect(0, 14, 120, 96);

      const craneGrad = ctx.createRadialGradient(190, 54, 4, 190, 54, 42);
      craneGrad.addColorStop(0, 'rgba(130, 210, 255, 0.65)');
      craneGrad.addColorStop(1, 'rgba(130, 210, 255, 0)');
      ctx.fillStyle = craneGrad;
      ctx.fillRect(140, 10, 100, 90);

      const envTex = new THREE.CanvasTexture(c);
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      envTex.colorSpace = THREE.SRGBColorSpace;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this._stdEnvMap = pmrem.fromEquirectangular(envTex).texture;
      this.scene.environment = this._stdEnvMap;
      this.scene.environmentIntensity = 0.78;
      pmrem.dispose();
      envTex.dispose();
    }

    _initSkyAndLights() {
      // 暴风雨黄昏入夜天穹（西侧低空夕阳残光 + 深蓝乌云 + 闪电脉冲）
      this.skyMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uLightning: { value: 0 },
          uSunDir: { value: new THREE.Vector3(-0.82, 0.14, -0.55).normalize() },
          uExtremeMode: { value: 0.0 },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          layout(location = 1) out highp vec4 gNormalRough;
          uniform float uTime;
          uniform float uLightning;
          uniform vec3 uSunDir;
          uniform float uExtremeMode;
          varying vec3 vDir;

          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }
          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
              mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
              f.y
            );
          }
          float fbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            for (int i = 0; i < 4; i++) {
              v += a * noise(p);
              p *= 2.05;
              a *= 0.5;
            }
            return v;
          }

          void main() {
            vec3 d = normalize(vDir);
            float h = clamp(d.y, 0.0, 1.0);
            vec3 zenith = vec3(0.025, 0.042, 0.088);
            vec3 horizon = vec3(0.068, 0.105, 0.175);
            vec3 col = mix(horizon, zenith, pow(h, 0.55));

            // 滚动乌云层
            vec2 cloudUv = d.xz / (max(0.12, d.y + 0.16)) * 0.9 + vec2(uTime * 0.018, uTime * 0.01);
            float c = fbm(cloudUv * 1.4);

            // 西侧残阳暮光穿透云隙
            float sunAlign = max(0.0, dot(d, uSunDir));
            float duskBand = exp(-abs(d.y - 0.07) * 9.5) * pow(sunAlign, 2.2);
            float sunCore = pow(sunAlign, 18.0) * smoothstep(0.0, 0.25, d.y + 0.04);
            vec3 duskCol = mix(vec3(0.55, 0.17, 0.07), vec3(0.95, 0.45, 0.15), sunCore);
            col += duskCol * duskBand * (1.15 - c * 0.55);
            col += vec3(1.0, 0.55, 0.22) * sunCore * 0.7;

            // 暴雨乌云暗部与远处闪电提亮
            col = mix(col, col * 0.65 + vec3(0.04, 0.06, 0.1), c * 0.65 * smoothstep(0.0, 0.4, h));
            col += vec3(0.45, 0.62, 0.95) * uLightning * (0.35 + c * 0.65);
            col *= (1.0 + sunCore * 0.48 * uExtremeMode);

            gl_FragColor = vec4(col, 1.0);
            gNormalRough = vec4(0.5, 0.5, 0.99, 0.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(210, 32, 20), this.skyMat);
      this.scene.add(this.skyDome);

      // 半球环境光 + 西侧斜射低角度夕阳方向光（投射集装箱长阴影）+ 天空闪电补光
      this.hemiLight = new THREE.HemisphereLight(0x3a5882, 0x0e131b, 0.88);
      this.scene.add(this.hemiLight);

      this.sunsetLight = new THREE.DirectionalLight(0xe87b3b, 1.65);
      this.sunsetLight.position.set(-68, 18, -42);
      this.sunsetTarget = new THREE.Object3D();
      this.scene.add(this.sunsetTarget);
      this.sunsetLight.target = this.sunsetTarget;
      this.sunsetLight.castShadow = true;
      this.sunsetLight.shadow.mapSize.set(2048, 2048);
      this.sunsetLight.shadow.camera.near = 10;
      this.sunsetLight.shadow.camera.far = 165;
      this.sunsetLight.shadow.camera.left = -58;
      this.sunsetLight.shadow.camera.right = 58;
      this.sunsetLight.shadow.camera.top = 50;
      this.sunsetLight.shadow.camera.bottom = -50;
      this.sunsetLight.shadow.bias = -0.0007;
      this.scene.add(this.sunsetLight);

      this.moonFill = new THREE.DirectionalLight(0x5279a8, 0.72);
      this.moonFill.position.set(42, 48, 36);
      this.scene.add(this.moonFill);

      // 固定 6 槽位智能点光源池
      this.lightPool = new LightPool(this.scene, 6);

      // 极限画质专属：仓库顶灯近距离动态投影聚光（shadow.autoUpdate=false，零重编译）与手电筒虚拟反弹点光
      this.whSpotShadow = new THREE.SpotLight(0xffaa4d, 0, 26, Math.PI * 0.44, 0.72, 1.4);
      this.whSpotShadow.position.set(-12, 4.75, -22);
      this.whSpotShadow.target.position.set(-12, 0, -22);
      this.whSpotShadow.castShadow = false;
      this.whSpotShadow.shadow.autoUpdate = false;
      this.whSpotShadow.shadow.mapSize.set(512, 512);
      this.whSpotShadow.shadow.camera.near = 0.6;
      this.whSpotShadow.shadow.camera.far = 18;
      this.whSpotShadow.shadow.bias = -0.0012;
      this.scene.add(this.whSpotShadow);
      this.scene.add(this.whSpotShadow.target);

      this.flashBounceLight = this.createVirtualLight({
        color: 0xd2e7ff,
        intensity: 0,
        distance: 7.5,
        decay: 2.0,
        priority: 7.5,
      });

      // 西侧海平面夕阳斜射体积光柱（God rays）
      const sunShaftPositions = [
        [-38, 12, -24, 0.35],
        [-40, 11, 2, 0.38],
        [-36, 12, 20, 0.3],
      ];
      for (const [sx, sy, sz, op] of sunShaftPositions) {
        const beamMat = createVolumetricBeamMaterial(0xe36c2a, op * 0.42);
        this.volumetricMaterials.push(beamMat);
        const geo = new THREE.CylinderGeometry(3.8, 10.5, 48, 20, 1, true);
        const mesh = new THREE.Mesh(geo, beamMat);
        mesh.position.set(sx, sy, sz);
        mesh.rotation.set(0.32, 0, -1.08);
        this.volumetricMeshes.push(mesh);
        this.scene.add(mesh);
      }
    }

    _initSeaAndPuddles() {
      // 周围漆黑海港波涛海面
      this.seaMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uSunsetDir: { value: new THREE.Vector3(-0.82, 0.14, -0.55).normalize() },
          uCameraPos: { value: new THREE.Vector3() },
          uExtremeMode: { value: 0.0 },
        },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uExtremeMode;
          varying vec3 vWorldPos;
          varying vec3 vViewBasisX;
          varying vec3 vViewBasisY;
          varying vec3 vViewBasisZ;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            float ext = uExtremeMode;
            wp.y += sin(wp.x * 0.35 + uTime * 2.1) * (0.14 + 0.05 * ext)
                  + cos(wp.z * 0.42 + uTime * 1.7) * (0.12 + 0.05 * ext)
                  + sin((wp.x + wp.z) * 0.85 - uTime * 3.1) * 0.04 * ext;
            vWorldPos = wp.xyz;
            vViewBasisX = (viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
            vViewBasisY = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
            vViewBasisZ = (viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          layout(location = 1) out highp vec4 gNormalRough;
          uniform float uTime;
          uniform vec3 uSunsetDir;
          uniform vec3 uCameraPos;
          uniform float uExtremeMode;
          varying vec3 vWorldPos;
          varying vec3 vViewBasisX;
          varying vec3 vViewBasisY;
          varying vec3 vViewBasisZ;

          vec2 seaOctEncode(vec3 n) {
            n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-6);
            if (n.z < 0.0) {
              vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
              n.xy = (1.0 - abs(n.yx)) * s;
            }
            return n.xy * 0.5 + 0.5;
          }

          void main() {
            float nx = cos(vWorldPos.x * 0.8 + uTime * 2.8) * 0.18 + sin(vWorldPos.z * 1.4 - uTime * 2.1) * 0.1;
            float nz = sin(vWorldPos.z * 0.9 + uTime * 2.4) * 0.18;
            if (uExtremeMode > 0.5) {
              nx += cos(vWorldPos.x * 2.6 - vWorldPos.z * 1.9 + uTime * 4.1) * 0.085;
              nz += sin(vWorldPos.z * 2.9 + vWorldPos.x * 1.6 - uTime * 3.7) * 0.085;
            }
            vec3 N = normalize(vec3(nx, 1.0, nz));
            vec3 V = normalize(uCameraPos - vWorldPos);
            float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0);
            vec3 H = normalize(uSunsetDir + V);
            float spec = pow(max(dot(N, H), 0.0), mix(48.0, 92.0, uExtremeMode));
            vec3 col = mix(vec3(0.01, 0.025, 0.05), vec3(0.06, 0.1, 0.16), fresnel);
            col += vec3(0.95, 0.45, 0.18) * spec * (0.75 + 0.45 * uExtremeMode);

            if (uExtremeMode > 0.5) {
              // 码头防波墙边缘泡沫浪线 (东侧 x=22 与北侧 z=-34 附近)
              float dxWall = max(0.0, vWorldPos.x - 21.8);
              float dzWall = max(0.0, -33.8 - vWorldPos.z);
              float quayDist = min(vWorldPos.z > -36.0 ? dxWall : 99.0, vWorldPos.x < 24.0 ? dzWall : 99.0);
              float foamWave = sin(quayDist * 3.6 - uTime * 3.2 + sin(vWorldPos.x * 0.4 + vWorldPos.z * 0.4) * 1.5);
              float foam = exp(-quayDist * 1.15) * (0.45 + 0.55 * smoothstep(-0.2, 0.8, foamWave));
              col += vec3(0.32, 0.42, 0.52) * foam;
            } else {
              float dist = length(vWorldPos - uCameraPos);
              float fogF = 1.0 - exp(-0.0175 * 0.0175 * dist * dist);
              col = mix(col, vec3(0.039, 0.067, 0.114), clamp(fogF, 0.0, 1.0));
            }
            gl_FragColor = vec4(col, 1.0);
            vec3 viewN = normalize(vViewBasisX * N.x + vViewBasisY * N.y + vViewBasisZ * N.z);
            gNormalRough = vec4(seaOctEncode(viewN), 0.09, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      const seaMesh = new THREE.Mesh(new THREE.PlaneGeometry(340, 340, 80, 80), this.seaMat);
      seaMesh.rotation.x = -Math.PI / 2;
      seaMesh.position.y = -1.45;
      this.scene.add(seaMesh);

      // 半分辨率水洼实时平面倒影
      const rw = Math.floor(window.innerWidth * 0.5);
      const rh = Math.floor(window.innerHeight * 0.5);
      this.puddleReflector = new PuddleReflector(
        this.texFactory.worldWidth,
        this.texFactory.worldDepth,
        this.texFactory.asphaltData.puddleTex,
        rw,
        rh,
        this._rainOccTex
      );
      const initProfile = this._getRainProfile(this.quality);
      this.puddleReflector.material.uniforms.uRippleLayers.value = initProfile.rippleLayers;
      this.puddleReflector.material.uniforms.uRainOccBounds.value.copy(this._rainOccBounds);
      this.puddleReflector.material.uniforms.uRainOccMaxH.value = this._rainOccMaxH;
      this.scene.add(this.puddleReflector);
    }

    _initRainSystem() {
      const profile = this._getRainProfile(this.quality);
      this.maxRainCount = 5600;
      const offsets = new Float32Array(this.maxRainCount * 3);
      const seeds = new Float32Array(this.maxRainCount * 3);

      for (let i = 0; i < this.maxRainCount; i++) {
        const i3 = i * 3;
        offsets[i3] = (Math.random() - 0.5) * 38;
        offsets[i3 + 1] = Math.random() * 22;
        offsets[i3 + 2] = (Math.random() - 0.5) * 38;
        seeds[i3] = Math.random();
        seeds[i3 + 1] = Math.random();
        seeds[i3 + 2] = Math.random();
      }

      const baseGeo = new THREE.PlaneGeometry(1, 1);
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = baseGeo.index;
      geo.attributes.position = baseGeo.attributes.position;
      geo.attributes.uv = baseGeo.attributes.uv;
      geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
      geo.instanceCount = Math.min(this.maxRainCount, profile.rainCount);

      this.rainMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uCamPos: { value: new THREE.Vector3() },
          uResolution: { value: new THREE.Vector2(window.innerWidth || 1280, window.innerHeight || 720) },
          uLightning: { value: 0 },
          uSunsetDir: { value: new THREE.Vector3(-0.82, 0.14, -0.55).normalize() },
          uSpot1Pos: { value: new THREE.Vector3(15.2, 0, 2.0) },
          uSpot1Origin: { value: new THREE.Vector3(15.2, 15.18, 2.0) },
          uSpot1Dir: { value: new THREE.Vector3(0, -1, 0) },
          uSpot1Color: { value: new THREE.Color(0x9ce4ff) },
          uSpot2Pos: { value: new THREE.Vector3(15.2, 0, 8.0) },
          uSpot2Origin: { value: new THREE.Vector3(15.2, 15.18, 8.0) },
          uSpot2Dir: { value: new THREE.Vector3(0, -1, 0) },
          uSpot2Color: { value: new THREE.Color(0x9ce4ff) },
          uSpotCount: { value: 0 },
          uFlashPos: { value: new THREE.Vector3() },
          uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
          uFlashOn: { value: 0 },
          uMuzzlePos: { value: new THREE.Vector3() },
          uMuzzleIntensity: { value: 0 },
          uFullLighting: { value: profile.fullLighting ? 1.0 : 0.0 },
          uBlackout: { value: 0.0 },
          tRainOcclusion: { value: this._rainOccTex },
          uRainOccBounds: { value: this._rainOccBounds.clone() },
          uRainOccMaxH: { value: this._rainOccMaxH },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          attribute vec3 aOffset;
          attribute vec3 aSeed;
          uniform float uTime;
          uniform vec3 uCamPos;
          uniform vec2 uResolution;
          uniform sampler2D tRainOcclusion;
          uniform vec4 uRainOccBounds;
          uniform float uRainOccMaxH;

          varying vec2 vUv;
          varying float vAlpha;
          varying float vFade;
          varying float vNearCrisp;
          varying vec3 vWorldPos;

          void main() {
            vec3 box = vec3(38.0, 22.0, 38.0);
            vec2 wind = vec2(2.6 + sin(uTime * 0.55) * 1.15, -0.7 + cos(uTime * 0.42) * 0.45);
            vec2 windDisp = vec2(
              2.6 * uTime - 2.0909 * cos(uTime * 0.55),
              -0.7 * uTime + 1.0714 * sin(uTime * 0.42)
            );
            float fallSpeed = 23.0 + aSeed.x * 9.0;
            float windScale = 0.9 + 0.2 * aSeed.z;

            vec3 p = aOffset;
            p.x += mod(windDisp.x * windScale, box.x);
            p.z += mod(windDisp.y * windScale, box.z);
            p.y -= mod(uTime * fallSpeed, box.y);

            vec3 wrapAnchor = vec3(uCamPos.x, max(uCamPos.y, box.y * 0.5), uCamPos.z);
            vec3 relAnchor = mod(p - wrapAnchor + box * 0.5, box) - box * 0.5;
            vec3 dropCenter = wrapAnchor + relAnchor;
            vec3 rel = dropCenter - uCamPos;
            float camDist = length(rel);
            float horizDist = length(rel.xz);

            float layerTier = aSeed.y;
            float physHalfW = mix(0.0058, 0.0125, (1.0 - layerTier) * 0.7 + aSeed.x * 0.3);
            float halfL = mix(0.24, 0.54, (1.0 - layerTier) * 0.65 + aSeed.x * 0.35);

            // 实例级屋顶提前剔除，避免仓库室内空耗光栅化
            vec2 cOccUv = (dropCenter.xz - uRainOccBounds.xy) * uRainOccBounds.zw;
            float cInOcc = step(0.0, cOccUv.x) * step(cOccUv.x, 1.0) * step(0.0, cOccUv.y) * step(cOccUv.y, 1.0);
            float cRoofY = cInOcc * texture2D(tRainOcclusion, clamp(cOccUv, 0.001, 0.999)).r * uRainOccMaxH;
            if (cRoofY > 0.1 && (dropCenter.y + halfL) < (cRoofY - 0.35)) {
              gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
              vUv = uv;
              vAlpha = 0.0;
              vFade = 0.0;
              vNearCrisp = 0.0;
              vWorldPos = dropCenter;
              return;
            }

            vec3 vel = vec3(wind.x, -fallSpeed, wind.y);
            vec3 velDir = normalize(vel);
            vec3 toCam = camDist > 0.001 ? (uCamPos - dropCenter) / camDist : vec3(0.0, 0.0, 1.0);
            vec3 rawCross = cross(velDir, toCam);
            float crossLen = length(rawCross);
            vec3 camRightFallback = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 side = crossLen > 0.001 ? (rawCross / crossLen) : normalize(camRightFallback);
            vec3 upOrtho = normalize(cross(toCam, side));

            // 透视宽度 + 屏幕像素最小抗锯齿下限钳位（杜绝 1px 闪烁细丝；仰视自然缩成雨珠）
            float viewDepth = max(0.55, -(viewMatrix * vec4(dropCenter, 1.0)).z);
            float projY = max(0.25, abs(projectionMatrix[1][1]));
            float minHalfW = 1.25 * viewDepth / (projY * max(480.0, uResolution.y));
            float aaHalfW = max(physHalfW, minHalfW);
            float aaFade = physHalfW / aaHalfW;

            vec3 streakAxis = -velDir * halfL + upOrtho * (aaHalfW * (1.0 - crossLen));
            vec3 worldPos = dropCenter + side * (position.x * 2.0 * aaHalfW) + streakAxis * (position.y * 2.0);

            vec2 occUv = (worldPos.xz - uRainOccBounds.xy) * uRainOccBounds.zw;
            float inOcc = step(0.0, occUv.x) * step(occUv.x, 1.0) * step(0.0, occUv.y) * step(occUv.y, 1.0);
            float roofY = inOcc * texture2D(tRainOcclusion, clamp(occUv, 0.001, 0.999)).r * uRainOccMaxH;
            float occFade = smoothstep(roofY - 0.16, roofY + 0.14, worldPos.y);

            float distFade = (1.0 - smoothstep(10.5, 18.8, horizDist)) * smoothstep(0.55, 1.35, camDist);
            float fade = aaFade * distFade * occFade;
            float baseDensity = 0.13 + 0.15 * (1.0 - layerTier * 0.55) + 0.05 * aSeed.z;

            vUv = uv;
            vFade = fade;
            vAlpha = baseDensity * fade;
            vNearCrisp = 1.0 - smoothstep(2.5, 12.0, camDist);
            vWorldPos = worldPos;
            gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uCamPos;
          uniform float uLightning;
          uniform vec3 uSunsetDir;
          uniform vec3 uSpot1Pos;
          uniform vec3 uSpot1Origin;
          uniform vec3 uSpot1Dir;
          uniform vec3 uSpot1Color;
          uniform vec3 uSpot2Pos;
          uniform vec3 uSpot2Origin;
          uniform vec3 uSpot2Dir;
          uniform vec3 uSpot2Color;
          uniform float uSpotCount;
          uniform vec3 uFlashPos;
          uniform vec3 uFlashDir;
          uniform float uFlashOn;
          uniform vec3 uMuzzlePos;
          uniform float uMuzzleIntensity;
          uniform float uFullLighting;
          uniform float uBlackout;

          varying vec2 vUv;
          varying float vAlpha;
          varying float vFade;
          varying float vNearCrisp;
          varying vec3 vWorldPos;

          void main() {
            if (vFade < 0.004) discard;

            float x = (vUv.x - 0.5) * 2.0;
            float horiz = exp(-x * x * 7.5);
            float headDist = (vUv.y - 0.14) / 0.14;
            float headCore = exp(-headDist * headDist * 3.8) * exp(-x * x * 4.5);
            float tailStreak = smoothstep(0.0, 0.10, vUv.y) * pow(max(0.0, 1.0 - smoothstep(0.08, 1.0, vUv.y)), 1.35) * horiz;
            float dropShape = clamp(tailStreak * 0.72 + headCore * (0.52 + 0.24 * vNearCrisp), 0.0, 1.25);

            // 暗部基础雨丝保持克制，保障瞄准清晰度
            vec3 litCol = vec3(0.36, 0.47, 0.64) * (1.0 - 0.35 * uBlackout);
            float litAlpha = 0.0;

            // 1. 闪电冷白散射
            if (uLightning > 0.01) {
              litCol += vec3(0.55, 0.72, 1.0) * uLightning * 0.92;
              litAlpha += uLightning * 0.30;
            }

            // 2. 西侧残阳前向米氏散射
            vec3 viewDir = normalize(vWorldPos - uCamPos);
            float sunFwd = pow(max(0.0, dot(viewDir, uSunsetDir)), 4.0);
            litCol += vec3(1.0, 0.52, 0.22) * (0.08 + 0.44 * sunFwd) * (1.0 - 0.65 * uBlackout);
            litAlpha += sunFwd * 0.08 * (1.0 - 0.65 * uBlackout);

            if (uFullLighting > 0.5) {
              // 3. 龙门吊双扫射探照灯光锥散射
              if (uSpotCount > 0.5) {
                vec3 sd1 = vWorldPos - uSpot1Origin;
                float slen1 = length(sd1);
                float sca1 = dot(sd1 / max(0.001, slen1), uSpot1Dir);
                float spot1 = smoothstep(0.89, 0.97, sca1) / (1.0 + slen1 * slen1 * 0.014) * step(slen1, 42.0);
                spot1 += exp(-length(vWorldPos - uSpot1Pos) * 0.16) * 0.16;
                litCol += uSpot1Color * spot1 * 1.15;
                litAlpha += spot1 * 0.28;
              }
              if (uSpotCount > 1.5) {
                vec3 sd2 = vWorldPos - uSpot2Origin;
                float slen2 = length(sd2);
                float sca2 = dot(sd2 / max(0.001, slen2), uSpot2Dir);
                float spot2 = smoothstep(0.89, 0.97, sca2) / (1.0 + slen2 * slen2 * 0.014) * step(slen2, 42.0);
                spot2 += exp(-length(vWorldPos - uSpot2Pos) * 0.16) * 0.16;
                litCol += uSpot2Color * spot2 * 1.15;
                litAlpha += spot2 * 0.28;
              }

              // 4. 战术枪灯聚光散射（近距离淡入避免遮挡准星）
              if (uFlashOn > 0.5) {
                vec3 fd = vWorldPos - uFlashPos;
                float flen = length(fd);
                if (flen > 0.45 && flen < 26.0) {
                  float fca = dot(fd / flen, uFlashDir);
                  float flashCone = smoothstep(0.87, 0.965, fca) * smoothstep(0.45, 1.85, flen) / (1.0 + flen * flen * 0.045);
                  litCol += vec3(0.82, 0.92, 1.0) * flashCone * 1.05;
                  litAlpha += flashCone * 0.32;
                }
              }

              // 5. 枪口焰瞬时照明散射
              if (uMuzzleIntensity > 0.01) {
                vec3 md = vWorldPos - uMuzzlePos;
                float mDist2 = dot(md, md);
                float mGlow = uMuzzleIntensity / (1.0 + mDist2 * 0.32);
                litCol += vec3(1.0, 0.62, 0.24) * min(1.8, mGlow * 0.45);
                litAlpha += min(0.40, mGlow * 0.14);
              }
            }

            float alpha = clamp((vAlpha + litAlpha * vFade) * dropShape, 0.0, 0.72);
            if (alpha < 0.004) discard;
            gl_FragColor = vec4(litCol * (0.72 + 0.35 * headCore), alpha);
          }
        `,
      });

      this.rainLines = new THREE.Mesh(geo, this.rainMat);
      this.rainLines.frustumCulled = false;
      this.rainLines.renderOrder = 5;
      this.rainLines.userData.forceLayer1 = true;
      this.scene.add(this.rainLines);
      this.puddleReflector.hiddenObjects.push(this.rainLines);
    }

    _initSparkAndSplashPools() {
      // 金属火花粒子对象池（InstancedMesh）
      this.maxSparks = 140;
      const sparkGeo = new THREE.BoxGeometry(0.045, 0.045, 0.18);
      const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
      this.sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, this.maxSparks);
      this.sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.sparkMesh.frustumCulled = false;
      this.scene.add(this.sparkMesh);

      this.sparks = Array.from({ length: this.maxSparks }, () => ({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.4,
      }));
      this._dummy = new THREE.Object3D();
      this._zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < this.maxSparks; i++) {
        this.sparkMesh.setMatrixAt(i, this._zeroMat);
      }

      // GPU 实例化 3D 微水花王冠粒子池（取代平面灰圆环）
      const profile = this._getRainProfile(this.quality);
      this.maxSplashes = 220;
      this.activeSplashCount = Math.min(this.maxSplashes, profile.splashCount || 150);

      this._splashPosArr = new Float32Array(this.maxSplashes * 3);
      this._splashPhaseArr = new Float32Array(this.maxSplashes);
      this._splashSeedArr = new Float32Array(this.maxSplashes);
      for (let i = 0; i < this.maxSplashes; i++) {
        this._splashPosArr[i * 3] = 0;
        this._splashPosArr[i * 3 + 1] = 0;
        this._splashPosArr[i * 3 + 2] = 0;
        this._splashPhaseArr[i] = -1.0;
        this._splashSeedArr[i] = Math.random();
      }

      const baseSplashGeo = new THREE.PlaneGeometry(1, 1);
      const splashGeo = new THREE.InstancedBufferGeometry();
      splashGeo.index = baseSplashGeo.index;
      splashGeo.attributes.position = baseSplashGeo.attributes.position;
      splashGeo.attributes.uv = baseSplashGeo.attributes.uv;

      this._splashPosAttr = new THREE.InstancedBufferAttribute(this._splashPosArr, 3);
      this._splashPosAttr.setUsage(THREE.DynamicDrawUsage);
      this._splashPhaseAttr = new THREE.InstancedBufferAttribute(this._splashPhaseArr, 1);
      this._splashPhaseAttr.setUsage(THREE.DynamicDrawUsage);
      const splashSeedAttr = new THREE.InstancedBufferAttribute(this._splashSeedArr, 1);

      splashGeo.setAttribute('aPos', this._splashPosAttr);
      splashGeo.setAttribute('aPhase', this._splashPhaseAttr);
      splashGeo.setAttribute('aSeed', splashSeedAttr);
      splashGeo.instanceCount = this.activeSplashCount;

      this.splashMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uCamPos: { value: new THREE.Vector3() },
          uLightning: { value: 0 },
          uSunsetDir: { value: new THREE.Vector3(-0.82, 0.14, -0.55).normalize() },
          uSpot1Pos: { value: new THREE.Vector3(15.2, 0, 2.0) },
          uSpot1Origin: { value: new THREE.Vector3(15.2, 15.18, 2.0) },
          uSpot1Dir: { value: new THREE.Vector3(0, -1, 0) },
          uSpot1Color: { value: new THREE.Color(0x9ce4ff) },
          uSpot2Pos: { value: new THREE.Vector3(15.2, 0, 8.0) },
          uSpot2Origin: { value: new THREE.Vector3(15.2, 15.18, 8.0) },
          uSpot2Dir: { value: new THREE.Vector3(0, -1, 0) },
          uSpot2Color: { value: new THREE.Color(0x9ce4ff) },
          uSpotCount: { value: 0 },
          uFlashPos: { value: new THREE.Vector3() },
          uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
          uFlashOn: { value: 0 },
          uMuzzlePos: { value: new THREE.Vector3() },
          uMuzzleIntensity: { value: 0 },
          uFullLighting: { value: profile.fullLighting ? 1.0 : 0.0 },
          uBlackout: { value: 0.0 },
          tRainOcclusion: { value: this._rainOccTex },
          uRainOccBounds: { value: this._rainOccBounds.clone() },
          uRainOccMaxH: { value: this._rainOccMaxH },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          attribute vec3 aPos;
          attribute float aPhase;
          attribute float aSeed;

          uniform vec3 uCamPos;
          uniform sampler2D tRainOcclusion;
          uniform vec4 uRainOccBounds;
          uniform float uRainOccMaxH;

          varying vec2 vUv;
          varying float vPhase;
          varying float vSeed;
          varying float vFade;
          varying vec3 vWorldPos;

          void main() {
            if (aPhase < 0.0 || aPhase >= 1.0) {
              gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
              vUv = uv;
              vPhase = -1.0;
              vSeed = aSeed;
              vFade = 0.0;
              vWorldPos = aPos;
              return;
            }

            vec2 occUv = (aPos.xz - uRainOccBounds.xy) * uRainOccBounds.zw;
            float inOcc = step(0.0, occUv.x) * step(occUv.x, 1.0) * step(0.0, occUv.y) * step(occUv.y, 1.0);
            float roofY = inOcc * texture2D(tRainOcclusion, clamp(occUv, 0.001, 0.999)).r * uRainOccMaxH;
            float occ = 1.0 - step(aPos.y + 0.35, roofY);

            vec3 toCam = uCamPos - aPos;
            float camDist = length(toCam);
            float distFade = (1.0 - smoothstep(10.5, 16.5, camDist)) * smoothstep(0.55, 1.15, camDist);

            vec2 flatToCam = toCam.xz;
            float hLen = length(flatToCam);
            vec3 fwd = hLen > 0.001 ? vec3(flatToCam.x / hLen, 0.0, flatToCam.y / hLen) : vec3(0.0, 0.0, 1.0);
            vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));

            float splashW = mix(0.20, 0.34, aSeed);
            float splashH = mix(0.15, 0.25, fract(aSeed * 7.13));
            vec3 worldPos = aPos + right * (position.x * splashW) + vec3(0.0, (position.y + 0.5) * splashH, 0.0);

            vUv = uv;
            vPhase = aPhase;
            vSeed = aSeed;
            vFade = occ * distFade;
            vWorldPos = worldPos;
            gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uCamPos;
          uniform float uLightning;
          uniform vec3 uSunsetDir;
          uniform vec3 uSpot1Pos;
          uniform vec3 uSpot1Origin;
          uniform vec3 uSpot1Dir;
          uniform vec3 uSpot1Color;
          uniform vec3 uSpot2Pos;
          uniform vec3 uSpot2Origin;
          uniform vec3 uSpot2Dir;
          uniform vec3 uSpot2Color;
          uniform float uSpotCount;
          uniform vec3 uFlashPos;
          uniform vec3 uFlashDir;
          uniform float uFlashOn;
          uniform vec3 uMuzzlePos;
          uniform float uMuzzleIntensity;
          uniform float uFullLighting;
          uniform float uBlackout;

          varying vec2 vUv;
          varying float vPhase;
          varying float vSeed;
          varying float vFade;
          varying vec3 vWorldPos;

          void main() {
            if (vPhase < 0.0 || vFade < 0.005) discard;

            float ux = vUv.x * 2.0 - 1.0;
            float uy = vUv.y;
            float t = clamp(vPhase, 0.0, 1.0);
            float lifeEnv = smoothstep(0.0, 0.14, t) * (1.0 - smoothstep(0.56, 1.0, t));

            // 地面柔和扩散微雾底托
            float baseRadius = 0.22 + 0.56 * pow(max(0.0001, t), 0.7);
            float mistX = ux / max(0.15, baseRadius);
            float mistY = (uy - 0.09) / 0.20;
            float mist = exp(-(mistX * mistX * 2.6 + mistY * mistY * 3.4))
                       * smoothstep(0.0, 0.06, uy)
                       * (1.0 - t * 0.62) * 0.44;

            // 3~5 颗抛物线跃起/落回的微型王冠水珠
            float droplets = 0.0;
            for (int i = 0; i < 5; i++) {
              float h1 = fract(sin(vSeed * 43.17 + float(i) * 19.73) * 43758.5453);
              float h2 = fract(sin(vSeed * 91.31 + float(i) * 37.41) * 28461.9137);
              if (i < 4 || h2 >= 0.35) {
                float signDir = mod(float(i), 2.0) < 0.5 ? -1.0 : 1.0;
                float vx = i == 4 ? (h1 - 0.5) * 0.28 : signDir * (0.28 + 0.55 * h1);
                float vy = 1.48 + 0.48 * h2;
                float dx = vx * t;
                float dy = 0.05 + vy * t - 1.38 * t * t;
                float sx = (ux - dx) / 0.072;
                float sy = (uy - dy) / 0.092;
                float bead = exp(-(sx * sx + sy * sy) * 2.3) * (1.0 - smoothstep(0.66, 1.0, t));
                droplets += bead;
              }
            }
            droplets = min(1.35, droplets);

            float shape = mist * 0.42 + droplets * 0.85;
            if (shape * lifeEnv * vFade < 0.005) discard;

            vec3 litCol = vec3(0.32, 0.44, 0.60) * (1.0 - 0.35 * uBlackout);
            vec3 viewDir = normalize(vWorldPos - uCamPos);
            float sunAlign = pow(max(0.0, dot(viewDir, uSunsetDir)), 2.5);
            litCol += vec3(0.95, 0.48, 0.20) * (0.10 + 0.28 * sunAlign) * (1.0 - 0.65 * uBlackout);
            if (uLightning > 0.01) {
              litCol += vec3(0.60, 0.78, 1.0) * uLightning * 1.05;
            }

            if (uFullLighting > 0.5) {
              if (uSpotCount > 0.5) {
                vec3 sd1 = vWorldPos - uSpot1Origin;
                float slen1 = length(sd1);
                float sca1 = dot(sd1 / max(0.001, slen1), uSpot1Dir);
                float s1 = smoothstep(0.88, 0.965, sca1) / (1.0 + slen1 * slen1 * 0.014) * step(slen1, 42.0)
                         + exp(-length(vWorldPos - uSpot1Pos) * 0.16) * 0.52;
                litCol += uSpot1Color * s1 * 1.1;
              }
              if (uSpotCount > 1.5) {
                vec3 sd2 = vWorldPos - uSpot2Origin;
                float slen2 = length(sd2);
                float sca2 = dot(sd2 / max(0.001, slen2), uSpot2Dir);
                float s2 = smoothstep(0.88, 0.965, sca2) / (1.0 + slen2 * slen2 * 0.014) * step(slen2, 42.0)
                         + exp(-length(vWorldPos - uSpot2Pos) * 0.16) * 0.52;
                litCol += uSpot2Color * s2 * 1.1;
              }
              if (uFlashOn > 0.5) {
                vec3 fd = vWorldPos - uFlashPos;
                float flen = length(fd);
                if (flen > 0.35 && flen < 26.0) {
                  float fca = dot(fd / flen, uFlashDir);
                  float flashCone = smoothstep(0.87, 0.965, fca) / (1.0 + flen * flen * 0.045);
                  litCol += vec3(0.84, 0.93, 1.0) * flashCone * 1.05;
                }
              }
              if (uMuzzleIntensity > 0.01) {
                vec3 md = vWorldPos - uMuzzlePos;
                float mGlow = uMuzzleIntensity / (1.0 + dot(md, md) * 0.28);
                litCol += vec3(1.0, 0.62, 0.24) * min(1.6, mGlow * 0.45);
              }
            }

            float alpha = clamp(shape * lifeEnv * vFade, 0.0, 0.74);
            gl_FragColor = vec4(litCol * (0.58 + 0.55 * droplets), alpha);
          }
        `,
      });

      this.splashMesh = new THREE.Mesh(splashGeo, this.splashMat);
      this.splashMesh.frustumCulled = false;
      this.splashMesh.renderOrder = 4;
      this.splashMesh.userData.forceLayer1 = true;
      this.scene.add(this.splashMesh);
      this.puddleReflector.hiddenObjects.push(this.splashMesh);

      this.splashes = Array.from({ length: this.maxSplashes }, (_, idx) => ({
        x: 999,
        y: 0,
        z: 999,
        phase: idx / this.maxSplashes,
        speed: 2.1 + Math.random() * 0.85,
        active: false,
      }));

      // 弹孔贴花环形对象池（InstancedMesh）
      this.maxDecals = 72;
      this.decalCursor = 0;
      const decalGeo = new THREE.PlaneGeometry(0.18, 0.18);
      const decalMat = new THREE.MeshStandardMaterial({
        map: this.texFactory.bulletDecalTex,
        transparent: true,
        alphaTest: 0.08,
        roughness: 0.85,
        metalness: 0.05,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, this.maxDecals);
      this.decalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.decalMesh.frustumCulled = false;
      this.decalMesh.renderOrder = 3;
      this.scene.add(this.decalMesh);
      this.clearBulletDecals();

      this._decalPos = new THREE.Vector3();
      this._decalNormal = new THREE.Vector3();
      this._decalQuat = new THREE.Quaternion();
      this._rollQuat = new THREE.Quaternion();
      this._zAxis = new THREE.Vector3(0, 0, 1);
      this._tmpColor = new THREE.Color();

      // 枪口/命中/爆炸烟尘广告牌粒子池（InstancedMesh）
      this.maxSmoke = 48;
      const smokeGeo = new THREE.PlaneGeometry(1, 1);
      const smokeMat = new THREE.MeshBasicMaterial({
        map: this.texFactory.smokePuffTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      });
      this.smokeMesh = new THREE.InstancedMesh(smokeGeo, smokeMat, this.maxSmoke);
      this.smokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.smokeMesh.frustumCulled = false;
      this.smokeMesh.renderOrder = 6;
      this.scene.add(this.smokeMesh);

      this.smokes = Array.from({ length: this.maxSmoke }, () => ({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.6,
        startScale: 0.25,
        endScale: 0.8,
        roll: 0,
      }));
      for (let i = 0; i < this.maxSmoke; i++) {
        this.smokeMesh.setMatrixAt(i, this._zeroMat);
        this.smokeMesh.setColorAt(i, this._tmpColor.setHex(0xd0d8e0));
      }
      this.smokeMesh.instanceMatrix.needsUpdate = true;
      if (this.smokeMesh.instanceColor) this.smokeMesh.instanceColor.needsUpdate = true;
    }

    clearBulletDecals() {
      if (!this.decalMesh) return;
      for (let i = 0; i < this.maxDecals; i++) {
        this.decalMesh.setMatrixAt(i, this._zeroMat);
      }
      this.decalMesh.instanceMatrix.needsUpdate = true;
      this.decalCursor = 0;
    }

    spawnBulletDecal(point, normal) {
      if (!this.decalMesh) return;
      this._decalNormal.copy(normal).normalize();
      this._decalQuat.setFromUnitVectors(this._zAxis, this._decalNormal);
      this._rollQuat.setFromAxisAngle(this._zAxis, Math.random() * Math.PI * 2);
      this._decalQuat.multiply(this._rollQuat);

      this._decalPos.copy(point).addScaledVector(this._decalNormal, 0.016);
      const s = 0.78 + Math.random() * 0.52;
      this._dummy.position.copy(this._decalPos);
      this._dummy.quaternion.copy(this._decalQuat);
      this._dummy.scale.set(s, s, 1);
      this._dummy.updateMatrix();
      this.decalMesh.setMatrixAt(this.decalCursor, this._dummy.matrix);
      this.decalMesh.instanceMatrix.needsUpdate = true;
      this.decalCursor = (this.decalCursor + 1) % this.maxDecals;
    }

    spawnSmoke(origin, count = 3, baseScale = 0.28, speed = 1.4, colorHex = 0xcfd8e3) {
      if (!this.smokeMesh) return;
      let spawned = 0;
      let colorDirty = false;
      for (let i = 0; i < this.maxSmoke && spawned < count; i++) {
        const sm = this.smokes[i];
        if (!sm.active) {
          sm.active = true;
          sm.pos.copy(origin);
          sm.vel.set(
            (Math.random() - 0.5) * speed,
            0.4 + Math.random() * speed * 0.9,
            (Math.random() - 0.5) * speed
          );
          sm.life = 0;
          sm.maxLife = 0.38 + Math.random() * 0.42;
          sm.startScale = baseScale * (0.75 + Math.random() * 0.4);
          sm.endScale = baseScale * (2.1 + Math.random() * 1.1);
          sm.roll = Math.random() * Math.PI * 2;
          this.smokeMesh.setColorAt(i, this._tmpColor.setHex(colorHex));
          colorDirty = true;
          spawned++;
        }
      }
      if (colorDirty && this.smokeMesh.instanceColor) {
        this.smokeMesh.instanceColor.needsUpdate = true;
      }
    }

    _initPostPipeline() {
      const w = Math.max(2, window.innerWidth);
      const h = Math.max(2, window.innerHeight);
      this.postEnabled = true;
      this.lensRainAlpha = 1.0;
      this.indoors = false;
      this.lowHpFactor = 0;
      this.scanPulseTimer = 0;
      this.blackoutMode = false;

      const rtType = THREE.HalfFloatType || THREE.UnsignedByteType;
      const linCs = THREE.LinearSRGBColorSpace || THREE.NoColorSpace;
      this.hdrTarget = new THREE.WebGLRenderTarget(w, h, {
        type: rtType,
        colorSpace: linCs,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
      });
      this.bloomTargetA = new THREE.WebGLRenderTarget(Math.max(2, (w / 4) | 0), Math.max(2, (h / 4) | 0), {
        type: rtType,
        colorSpace: linCs,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      this.bloomTargetB = this.bloomTargetA.clone();

      this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.postScene = new THREE.Scene();
      const quadGeo = new THREE.PlaneGeometry(2, 2);

      const postVert = /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `;

      this.brightMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uThreshold: { value: 0.86 },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        vertexShader: postVert,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform float uThreshold;
          varying vec2 vUv;
          void main() {
            vec3 c = texture2D(tDiffuse, vUv).rgb;
            float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
            float soft = smoothstep(uThreshold * 0.75, uThreshold * 1.45, luma);
            gl_FragColor = vec4(c * soft, 1.0);
          }
        `,
      });

      this.blurMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uTexel: { value: new THREE.Vector2(1 / 320, 1 / 180) },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        vertexShader: postVert,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform vec2 uTexel;
          varying vec2 vUv;
          void main() {
            vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
            sum += texture2D(tDiffuse, vUv + uTexel * 1.3846).rgb * 0.316216 * 0.5;
            sum += texture2D(tDiffuse, vUv - uTexel * 1.3846).rgb * 0.316216 * 0.5;
            sum += texture2D(tDiffuse, vUv + uTexel * 3.2307).rgb * 0.070270 * 0.5;
            sum += texture2D(tDiffuse, vUv - uTexel * 3.2307).rgb * 0.070270 * 0.5;
            sum += texture2D(tDiffuse, vUv + uTexel * 5.1).rgb * 0.02 * 0.5;
            sum += texture2D(tDiffuse, vUv - uTexel * 5.1).rgb * 0.02 * 0.5;
            gl_FragColor = vec4(sum, 1.0);
          }
        `,
      });

      this.compMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: this.hdrTarget.texture },
          tBloom: { value: this.bloomTargetA.texture },
          uBloomStrength: { value: 0.44 },
          uTime: { value: 0 },
          uLensRain: { value: 1.0 },
          uLowHp: { value: 0.0 },
          uScanWave: { value: 0.0 },
          uAspect: { value: w / h },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: true,
        vertexShader: postVert,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform sampler2D tBloom;
          uniform float uBloomStrength;
          uniform float uTime;
          uniform float uLensRain;
          uniform float uLowHp;
          uniform float uScanWave;
          uniform float uAspect;
          varying vec2 vUv;

          float hash21(vec2 p) {
            p = fract(p * vec2(234.34, 435.345));
            p += dot(p, p + 34.23);
            return fract(p.x * p.y);
          }

          vec3 computeLensRain(vec2 uv, float t) {
            float centerDist = length((uv - 0.5) * vec2(uAspect, 1.0));
            float centerClear = smoothstep(0.24, 0.64, centerDist);
            if (centerClear < 0.005) return vec3(0.0);

            vec2 refractOff = vec2(0.0);
            float rimSpec = 0.0;

            // 1. 重力粘滞-滑动 (slip-stick) 大水滴 + 滑落尾迹收缩微珠
            for (int l = 0; l < 2; l++) {
              float sx = l == 0 ? 5.6 : 8.8;
              float sy = l == 0 ? 2.1 : 3.2;
              vec2 grid = vec2(uv.x * uAspect * sx, uv.y * sy);
              float colId = floor(grid.x);
              float colRnd = hash21(vec2(colId, float(l) * 17.3 + 5.1));
              float rate = 0.34 + 0.24 * colRnd;
              float rawT = t * rate + colRnd * 11.3;
              float ft = fract(rawT);
              float slipT = floor(rawT) + ft - 0.13 * sin(ft * 6.2831853);
              grid.y += slipT;

              vec2 id = floor(grid);
              vec2 gv = fract(grid) - 0.5;
              float n = hash21(id + float(l) * 31.7);
              if (n > 0.56) {
                float wiggle = sin(grid.y * 4.2 + colRnd * 9.0) * 0.12;
                float dropX = (n - 0.78) * 0.62 + wiggle;
                float dropY = sin(t * 1.4 + n * 6.2831) * 0.08 - 0.12;
                vec2 dScreen = vec2((gv.x - dropX) / sx, (gv.y - dropY) / sy);
                float dropR = l == 0 ? 0.0155 : 0.0105;
                float dLen = length(dScreen);
                float r = dLen / dropR;
                if (r < 1.0) {
                  float dome = 1.0 - r * r;
                  refractOff += -vec2(dScreen.x / uAspect, dScreen.y) * dome * (l == 0 ? 0.85 : 0.72);
                  float rim = smoothstep(0.55, 0.90, r) * (1.0 - smoothstep(0.90, 1.02, r));
                  vec2 dn = dScreen / max(0.0001, dLen);
                  float skyFacing = clamp(dn.y * 0.78 - dn.x * 0.32 + 0.30, 0.0, 1.0);
                  rimSpec += rim * skyFacing * (l == 0 ? 0.55 : 0.38);
                }

                // 滑动路径上方保留逐渐收缩蒸发的小水珠尾迹
                float trailScreenY = (gv.y - dropY) / sy;
                if (trailScreenY > 0.018 && trailScreenY < 0.22) {
                  float wakeFade = smoothstep(0.22, 0.035, trailScreenY) * smoothstep(0.012, 0.035, trailScreenY);
                  float subY = trailScreenY * 36.0;
                  float subId = floor(subY);
                  float subGvY = (fract(subY) - 0.5) / 36.0;
                  float subRnd = hash21(vec2(id.x + subId * 13.7, id.y + float(l) * 41.3));
                  if (subRnd > 0.44) {
                    vec2 wScreen = vec2(dScreen.x - (subRnd - 0.72) * 0.006, subGvY);
                    float wR = 0.0048 * (0.40 + 0.60 * wakeFade);
                    float wLen = length(wScreen);
                    float wr = wLen / max(0.0008, wR);
                    if (wr < 1.0) {
                      float wdome = 1.0 - wr * wr;
                      refractOff += -vec2(wScreen.x / uAspect, wScreen.y) * wdome * 0.55 * wakeFade;
                      float wrim = smoothstep(0.50, 0.90, wr) * (1.0 - smoothstep(0.90, 1.02, wr));
                      rimSpec += wrim * 0.22 * wakeFade;
                    }
                  }
                }
              }
            }

            // 2. 镜片外缘静止微细水珠
            vec2 staticGrid = vec2(uv.x * uAspect, uv.y) * 24.0;
            vec2 sId = floor(staticGrid);
            vec2 sGv = fract(staticGrid) - 0.5;
            float sn = hash21(sId + 71.9);
            if (sn > 0.72) {
              float outerMask = smoothstep(0.32, 0.74, centerDist);
              float lifePulse = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(t * 0.42 + sn * 6.2831));
              vec2 sp = (vec2(hash21(sId + 2.3), hash21(sId + 8.7)) - 0.5) * 0.48;
              vec2 sdScreen = (sGv - sp) / 24.0;
              float sRad = (0.0044 + 0.0028 * sn) * (0.55 + 0.45 * lifePulse);
              float sdLen = length(sdScreen);
              float sr = sdLen / sRad;
              if (sr < 1.0) {
                float sdome = 1.0 - sr * sr;
                refractOff += -vec2(sdScreen.x / uAspect, sdScreen.y) * sdome * 0.48 * outerMask * lifePulse;
                float srim = smoothstep(0.55, 0.90, sr) * (1.0 - smoothstep(0.90, 1.02, sr));
                vec2 sdn = sdScreen / max(0.0001, sdLen);
                float sSky = clamp(sdn.y * 0.75 - sdn.x * 0.30 + 0.28, 0.0, 1.0);
                rimSpec += srim * sSky * 0.18 * outerMask * lifePulse;
              }
            }

            return vec3(refractOff * centerClear, min(0.85, rimSpec) * centerClear);
          }

          void main() {
            vec2 sampleUv = vUv;
            float rimSpec = 0.0;
            if (uLensRain > 0.02) {
              vec3 lensRain = computeLensRain(vUv, uTime);
              sampleUv = clamp(vUv + lensRain.xy * uLensRain, 0.001, 0.999);
              rimSpec = lensRain.z;
            }

            vec3 col = texture2D(tDiffuse, sampleUv).rgb;
            vec3 bloom = texture2D(tBloom, sampleUv).rgb * uBloomStrength;
            col += bloom;
            if (rimSpec > 0.001) {
              col += vec3(0.42, 0.58, 0.84) * rimSpec * uLensRain * 0.24;
            }

            if (uScanWave > 0.001 && uScanWave < 0.999) {
              float distC = length((vUv - 0.5) * vec2(uAspect, 1.0));
              float waveR = uScanWave * 1.15;
              float ring = exp(-abs(distC - waveR) * 28.0) * (1.0 - uScanWave);
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

            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });

      this.postQuad = new THREE.Mesh(quadGeo, this.compMat);
      this.postQuad.frustumCulled = false;
      this.postScene.add(this.postQuad);
    }

    triggerScanPulse() {
      this.scanPulseTimer = 1.15;
    }

    setEnvironmentEffects({ indoors = false, lowHpFactor = 0, blackout = false } = {}) {
      this.indoors = !!indoors;
      this.lowHpFactor = Math.max(0, Math.min(1, lowHpFactor || 0));
      if (this.blackoutMode !== !!blackout) {
        this.blackoutMode = !!blackout;
        this._origFog.density = blackout ? 0.0245 : 0.0175;
        if (!this.isExtremeActive) {
          this.scene.fog = this._origFog;
        }
        this.scene.environmentIntensity = this.isExtremeActive
          ? (blackout ? 0.34 : 0.96)
          : (blackout ? 0.26 : 0.78);
        if (this.hemiLight) this.hemiLight.intensity = blackout ? 0.35 : 0.88;
      }
    }

    spawnSparks(origin, normal, count = 12, colorScale = 1) {
      let spawned = 0;
      for (let i = 0; i < this.maxSparks && spawned < count; i++) {
        const s = this.sparks[i];
        if (!s.active) {
          s.active = true;
          s.pos.copy(origin);
          s.vel.set(
            normal.x * (3 + Math.random() * 5) + (Math.random() - 0.5) * 6,
            normal.y * (2 + Math.random() * 5) + 1.5 + Math.random() * 4,
            normal.z * (3 + Math.random() * 5) + (Math.random() - 0.5) * 6
          );
          s.life = 0;
          s.maxLife = (0.22 + Math.random() * 0.25) * colorScale;
          this._sparksDirty = true;
          spawned++;
        }
      }
    }

    createBeam(colorHex, topR, botR, length, opacity = 0.22) {
      const mat = createVolumetricBeamMaterial(colorHex, opacity);
      this.volumetricMaterials.push(mat);
      const geo = new THREE.CylinderGeometry(topR, botR, length, 20, 1, true);
      geo.translate(0, -length * 0.5, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.forceLayer1 = true;
      this.volumetricMeshes.push(mesh);
      if (this.isExtremeActive) mesh.layers.set(1);
      return mesh;
    }

    disposeBeam(mesh) {
      if (!mesh) return;
      const mIdx = this.volumetricMeshes.indexOf(mesh);
      if (mIdx >= 0) this.volumetricMeshes.splice(mIdx, 1);
      if (mesh.material) {
        const matIdx = this.volumetricMaterials.indexOf(mesh.material);
        if (matIdx >= 0) this.volumetricMaterials.splice(matIdx, 1);
        if (mesh.material.dispose) mesh.material.dispose();
      }
      if (mesh.geometry && mesh.geometry.dispose) {
        mesh.geometry.dispose();
      }
      if (mesh.parent) mesh.parent.remove(mesh);
    }

    registerSearchlight(pivot, targetAnchor, uniformIdx) {
      this.searchlights.push({ pivot, targetAnchor, uniformIdx });
    }

    createVirtualLight(opts = {}) {
      if (this.lightPool) {
        return this.lightPool.createLight(opts);
      }
      const pl = new THREE.PointLight(opts.color !== undefined ? opts.color : 0xffffff, opts.intensity ?? 1, opts.distance ?? 0, opts.decay ?? 2);
      pl.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
      this.scene.add(pl);
      return pl;
    }

    getExtremeInternalSize() {
      const w = Math.max(320, window.innerWidth || 1280);
      const h = Math.max(240, window.innerHeight || 720);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (typeof GameLogic !== 'undefined' && GameLogic.computeExtremePixelCap) {
        return GameLogic.computeExtremePixelCap(w, h, dpr, 1.5);
      }
      return { width: Math.floor(w * dpr) & ~1, height: Math.floor(h * dpr) & ~1, capScale: 1.0, effectiveDpr: dpr };
    }

    setDrsEnabled(enabled) {
      this.drsEnabled = !!enabled;
      if (this.extremePipeline) this.extremePipeline.drsEnabled = this.drsEnabled;
      if (!this.drsEnabled && this.drsScale !== 1.0) {
        this.drsScale = 1.0;
        if (this.isExtremeActive && this.extremePipeline) {
          this.extremePipeline.setDrsViewport(this.drsScale);
        }
      }
    }

    syncSceneLayers(extremeEnabled) {
      const assignLayer = (obj) => {
        if (!obj || (!obj.isMesh && !obj.isLine && !obj.isPoints)) return;
        if (!extremeEnabled) {
          obj.layers.set(0);
          return;
        }
        const m = obj.material;
        const isTransparentMat = Array.isArray(m)
          ? m.some((it) => it && it.transparent)
          : !!(m && m.transparent);
        const toLayer1 = !!(obj.userData && obj.userData.forceLayer1)
          || isTransparentMat
          || obj === this.puddleReflector
          || obj === this.rainLines
          || obj === this.splashMesh
          || obj === this.decalMesh
          || obj === this.smokeMesh
          || this.volumetricMeshes.includes(obj);
        obj.layers.set(toLayer1 ? 1 : 0);
      };
      this.scene.traverse(assignLayer);
      if (!extremeEnabled) {
        this.camera.layers.enableAll();
      }
    }

    syncNewObjectForExtreme(root) {
      if (!root) return;
      if (this.isExtremeActive && this.matMgr) {
        this.matMgr.syncSceneMaterials(root, true);
        root.traverse((obj) => {
          if (!obj || (!obj.isMesh && !obj.isLine && !obj.isPoints)) return;
          const m = obj.material;
          const isTransparentMat = Array.isArray(m)
            ? m.some((it) => it && it.transparent)
            : !!(m && m.transparent);
          obj.layers.set((obj.userData && obj.userData.forceLayer1) || isTransparentMat ? 1 : 0);
        });
      }
    }

    _configureSunShadow(extreme) {
      if (!this.sunsetLight) return;
      const maxTex = this.extremePipeline ? this.extremePipeline.caps.maxTexSize : 2048;
      const desiredSize = extreme ? Math.min(2048, maxTex) : 2048;
      if (this.sunsetLight.shadow.mapSize.x !== desiredSize) {
        this.sunsetLight.shadow.mapSize.set(desiredSize, desiredSize);
        if (this.sunsetLight.shadow.map) {
          this.sunsetLight.shadow.map.dispose();
          this.sunsetLight.shadow.map = null;
        }
      }
      const sc = this.sunsetLight.shadow.camera;
      if (extreme) {
        sc.left = -28;
        sc.right = 28;
        sc.top = 28;
        sc.bottom = -28;
        sc.near = 10;
        sc.far = 155;
        this.sunsetLight.shadow.radius = 2.0;
        this.sunsetLight.shadow.bias = -0.00045;
        this.sunsetLight.shadow.normalBias = 0.025;
      } else {
        sc.left = -58;
        sc.right = 58;
        sc.top = 50;
        sc.bottom = -50;
        sc.near = 10;
        sc.far = 165;
        this.sunsetLight.shadow.radius = 1.0;
        this.sunsetLight.shadow.bias = -0.0007;
        this.sunsetLight.shadow.normalBias = 0.0;
        this.sunsetTarget.position.set(0, 0, 0);
        this.sunsetTarget.updateMatrixWorld();
        this.sunsetLight.position.set(-68, 18, -42);
      }
      sc.updateProjectionMatrix();
    }

    _applyExtremeTexturesAndUniforms(baked) {
      if (!baked) return;
      if (baked.extremeEnvMap) {
        this.scene.environment = baked.extremeEnvMap;
      }
      this.scene.environmentIntensity = this.blackoutMode ? 0.34 : 0.96;
      if (this.matMgr) {
        if (baked.detailNoise) this.matMgr.setBakedDetailNoise(baked.detailNoise);
        if (this.texFactory && this.texFactory.asphaltData) {
          this.matMgr.setPuddleMap(
            this.texFactory.asphaltData.puddleTex,
            this.texFactory.worldWidth,
            this.texFactory.worldDepth
          );
        }
        if (typeof this.matMgr.setRainOcclusionMap === 'function' && this._rainOccTex) {
          this.matMgr.setRainOcclusionMap(this._rainOccTex, this._rainOccBounds, this._rainOccMaxH);
        }
      }
    }

    async prepareExtremeAsync({ onProgress = null, isCancelled = null, onPrepareDetail = null, extraShadowLights = [] } = {}) {
      if (!this.extremeSupported || !this.extremePipeline || !this.extremePipeline.caps.supported) {
        return false;
      }
      if (this._extremePrepared) {
        if (onPrepareDetail) onPrepareDetail(true);
        if (onProgress) onProgress(1.0, '极限画质已预热');
        return true;
      }

      const maxAniso = this.extremePipeline.caps.maxAniso;
      const report = (pct, msg) => {
        if (onProgress) onProgress(pct, msg);
      };

      try {
        const baked = await this.gpuBaker.bakeExtremeAssetsAsync(
          maxAniso,
          (p, msg) => report(p * 0.45, msg),
          isCancelled
        );
        if (!baked || (isCancelled && isCancelled())) {
          return false;
        }

        report(0.48, '装配极高细节资产与材质');
        this.texFactory.upgradeForExtreme(this.gpuBaker, maxAniso, baked);
        this._applyExtremeTexturesAndUniforms(baked);

        if (onPrepareDetail) onPrepareDetail(true);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.autoUpdate = true;
        this._configureSunShadow(true);
        if (this.whSpotShadow) {
          this.whSpotShadow.castShadow = true;
          this.whSpotShadow.shadow.autoUpdate = false;
          this.whSpotShadow.intensity = 0;
        }

        if (this.matMgr) this.matMgr.syncSceneMaterials(this.scene, true);
        this.syncSceneLayers(true);

        const cap = this.getExtremeInternalSize();
        this.extremePipeline.resize(cap.width, cap.height);

        const allShadowLights = [this.sunsetLight, this.whSpotShadow, ...(extraShadowLights || [])].filter(Boolean);
        const warmed = await this.extremePipeline.warmupShadersAsync(
          allShadowLights,
          (p, msg) => report(0.5 + p * 0.5, msg),
          isCancelled
        );

        if (!warmed || (isCancelled && isCancelled())) {
          if (onPrepareDetail) onPrepareDetail(false);
          this.texFactory.restoreStandardQuality();
          this.scene.environment = this._stdEnvMap;
          if (this.whSpotShadow) {
            this.whSpotShadow.castShadow = false;
            this.whSpotShadow.intensity = 0;
          }
          this._configureSunShadow(false);
          if (this.matMgr) this.matMgr.syncSceneMaterials(this.scene, false);
          this.syncSceneLayers(false);
          return false;
        }

        this._extremePrepared = true;
        return true;
      } catch (err) {
        if (onPrepareDetail) onPrepareDetail(false);
        throw err;
      }
    }

    setQuality(preset) {
      let targetPreset = typeof GameLogic !== 'undefined' && GameLogic.sanitizeQualityPreset
        ? GameLogic.sanitizeQualityPreset(preset)
        : (preset || 'high');
      if (targetPreset === 'extreme' && (!this.extremeSupported || !this.extremePipeline || !this.extremePipeline.caps.supported)) {
        targetPreset = 'high';
      }

      const wasExtreme = this.isExtremeActive;
      this.quality = targetPreset;
      const dpr = window.devicePixelRatio || 1;
      const rainProfile = this._getRainProfile(targetPreset);

      this._lensRainTarget = rainProfile.lensRainTarget;
      if (this._lensRainTarget <= 0.001) {
        this.lensRainAlpha = 0;
      }
      if (this.rainLines && this.rainLines.geometry) {
        this.rainLines.geometry.instanceCount = Math.min(this.maxRainCount, rainProfile.rainCount);
      }
      if (this.rainMat && this.rainMat.uniforms) {
        this.rainMat.uniforms.uFullLighting.value = rainProfile.fullLighting ? 1.0 : 0.0;
      }
      this.activeSplashCount = Math.min(this.maxSplashes, rainProfile.splashCount);
      if (this.splashMesh && this.splashMesh.geometry) {
        this.splashMesh.geometry.instanceCount = this.activeSplashCount;
      }
      if (this.splashMat && this.splashMat.uniforms) {
        this.splashMat.uniforms.uFullLighting.value = rainProfile.fullLighting ? 1.0 : 0.0;
      }
      if (this.puddleReflector && this.puddleReflector.material && this.puddleReflector.material.uniforms) {
        this.puddleReflector.material.uniforms.uRippleLayers.value = rainProfile.rippleLayers;
      }

      if (targetPreset === 'extreme') {
        this.isExtremeActive = true;
        this.drsScale = 1.0;
        this.fpsSmooth = 60;
        this.renderer.setPixelRatio(Math.min(dpr, 1.5));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.autoUpdate = true;
        this.renderer.toneMapping = THREE.AgXToneMapping || THREE.ACESFilmicToneMapping;
        this.scene.fog = null;

        const maxAniso = this.extremePipeline.caps.maxAniso;
        const baked = this.texFactory.upgradeForExtreme(this.gpuBaker, maxAniso, this.gpuBaker.cachedAssets);
        this._applyExtremeTexturesAndUniforms(baked);

        this.skyMat.uniforms.uExtremeMode.value = 1.0;
        this.seaMat.uniforms.uExtremeMode.value = 1.0;
        // 极限画质取消 PuddleReflector 二次场景重绘，地面水洼与涟漪直接融入主 PBR 与 MRT+SSR
        this.puddleReflector.enabled = false;
        this.puddleReflector.visible = false;
        this.puddleReflector.extremeMode = false;
        this.puddleReflector.material.uniforms.uUseReflection.value = 0.0;
        this.puddleReflector.material.uniforms.uExtremeMode.value = 0.0;

        this.postEnabled = true;

        this._configureSunShadow(true);
        if (this.whSpotShadow) {
          this.whSpotShadow.castShadow = true;
          this.whSpotShadow.shadow.autoUpdate = false;
          this.whSpotShadow.intensity = 0;
        }
        if (this.matMgr) this.matMgr.syncSceneMaterials(this.scene, true);
        this.syncSceneLayers(true);
        this.extremePipeline.enabled = true;
        this.extremePipeline.resetHistory();
        this._extremePrepared = true;
      } else {
        this.isExtremeActive = false;
        if (this.extremePipeline) this.extremePipeline.enabled = false;
        if (wasExtreme) {
          this.texFactory.restoreStandardQuality();
          this.scene.environment = this._stdEnvMap;
          this.scene.environmentIntensity = this.blackoutMode ? 0.26 : 0.78;
          this.scene.fog = this._origFog;
          this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
          this.skyMat.uniforms.uExtremeMode.value = 0.0;
          this.seaMat.uniforms.uExtremeMode.value = 0.0;
          this.puddleReflector.extremeMode = false;
          this.puddleReflector.material.uniforms.uExtremeMode.value = 0.0;
          if (this.whSpotShadow) {
            this.whSpotShadow.intensity = 0;
            this.whSpotShadow.castShadow = false;
            this.whSpotShadow.shadow.autoUpdate = false;
          }
          if (this.flashBounceLight) this.flashBounceLight.intensity = 0;
          this._configureSunShadow(false);
          if (this.matMgr) this.matMgr.syncSceneMaterials(this.scene, false);
          this.syncSceneLayers(false);
        }

        if (targetPreset === 'high') {
          this.renderer.setPixelRatio(Math.min(dpr, 1.5));
          this.renderer.shadowMap.enabled = true;
          this.puddleReflector.enabled = true;
          this.puddleReflector.visible = true;
          this.puddleReflector.material.uniforms.uUseReflection.value = 1.0;
          this.puddleReflector.setResolution(window.innerWidth * 0.5, window.innerHeight * 0.5);
          this.postEnabled = true;
          if (this.compMat) this.compMat.uniforms.uBloomStrength.value = 0.44;
        } else if (targetPreset === 'medium') {
          this.renderer.setPixelRatio(Math.min(dpr, 1.25));
          this.renderer.shadowMap.enabled = true;
          this.puddleReflector.enabled = true;
          this.puddleReflector.visible = true;
          this.puddleReflector.material.uniforms.uUseReflection.value = 1.0;
          this.puddleReflector.setResolution(window.innerWidth * 0.36, window.innerHeight * 0.36);
          this.postEnabled = true;
          if (this.compMat) this.compMat.uniforms.uBloomStrength.value = 0.28;
        } else {
          this.renderer.setPixelRatio(Math.min(dpr, 1.0));
          this.renderer.shadowMap.enabled = false;
          this.puddleReflector.enabled = false;
          this.puddleReflector.visible = false;
          this.puddleReflector.material.uniforms.uUseReflection.value = 0.0;
          this.postEnabled = false;
        }
      }
      this.resize();
    }

    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      const dpr = window.devicePixelRatio || 1;
      const targetPr = this.quality === 'medium' ? Math.min(dpr, 1.25) : (this.quality === 'low' ? Math.min(dpr, 1.0) : Math.min(dpr, 1.5));
      this.renderer.setPixelRatio(targetPr);
      this.renderer.setSize(w, h, false);

      if (this.quality === 'high') {
        this.puddleReflector.setResolution(w * 0.5, h * 0.5);
      } else if (this.quality === 'medium') {
        this.puddleReflector.setResolution(w * 0.36, h * 0.36);
      }

      const pr = this.renderer.getPixelRatio ? this.renderer.getPixelRatio() : 1;
      const pw = Math.max(2, Math.floor(w * pr));
      const ph = Math.max(2, Math.floor(h * pr));
      if (this.isExtremeActive && this.extremePipeline) {
        const cap = this.getExtremeInternalSize();
        this.extremePipeline.resize(cap.width, cap.height);
        this.extremePipeline.setDrsViewport(this.drsScale);
      } else if (this.hdrTarget && this.quality !== 'low') {
        this.hdrTarget.setSize(pw, ph);
        const bw = Math.max(2, (pw / 4) | 0);
        const bh = Math.max(2, (ph / 4) | 0);
        this.bloomTargetA.setSize(bw, bh);
        this.bloomTargetB.setSize(bw, bh);
        if (this.compMat) this.compMat.uniforms.uAspect.value = w / Math.max(1, h);
      }
      if (this.rainMat && this.rainMat.uniforms && this.rainMat.uniforms.uResolution) {
        if (this.isExtremeActive && this.extremePipeline) {
          this.rainMat.uniforms.uResolution.value.set(
            Math.max(2, this.extremePipeline.activeWidth || pw),
            Math.max(2, this.extremePipeline.activeHeight || ph)
          );
        } else {
          this.rainMat.uniforms.uResolution.value.set(pw, ph);
        }
      }
    }

    update(dt, muzzlePos, muzzleIntensity, opticsState = null) {
      this.time += dt;
      this._lastDt = dt;
      this._lastOpticsState = opticsState;
      const op = opticsState || {};
      const safeDt = Math.max(0.002, Math.min(0.1, dt || 0.016));
      const instFps = 1 / safeDt;
      this.fpsSmooth += (instFps - this.fpsSmooth) * Math.min(1, safeDt * 2.5);

      this.camera.updateMatrixWorld();
      const cam = this.camera.position;

      if (this.matMgr) {
        this.matMgr.sharedUniforms.uExtTime.value = this.time;
      }
      if (this.scanPulseTimer > 0) {
        this.scanPulseTimer = Math.max(0, this.scanPulseTimer - dt);
      }
      const occH = this._sampleRainOccHeight(cam.x, cam.z);
      const shelter = this.indoors || (occH > cam.y + 0.35);
      const adsAlpha = op.adsAlpha || 0;
      const isDmrScoped = !!op.isDmrScoped;
      const adsScale = isDmrScoped ? 0 : (1 - adsAlpha * 0.86);
      const pitchBoost = 1.0 + Math.max(0, Math.min(0.25, this.camera.rotation.x * 0.22));
      const targetRain = shelter ? 0.0 : this._lensRainTarget * adsScale * pitchBoost;
      const fadeRate = (adsAlpha > 0.05 || isDmrScoped) ? 9.0 : (shelter ? 2.4 : 1.8);
      this.lensRainAlpha += (targetRain - this.lensRainAlpha) * Math.min(1, safeDt * fadeRate);
      if (this.compMat) {
        this.compMat.uniforms.uTime.value = this.time;
        this.compMat.uniforms.uLensRain.value = this.lensRainAlpha;
        this.compMat.uniforms.uLowHp.value = this.lowHpFactor;
        this.compMat.uniforms.uScanWave.value = this.scanPulseTimer > 0 ? (1 - this.scanPulseTimer / 1.15) : 0;
      }

      if (this.flashBounceLight) {
        const bounce = op.flashBounce;
        if (bounce && bounce.intensity > 0.01) {
          this.flashBounceLight.position.copy(bounce.position);
          this.flashBounceLight.intensity = bounce.intensity;
        } else {
          this.flashBounceLight.intensity = 0;
        }
      }

      // 极限画质专属：紧贴玩家纹理素对齐紧致阴影视锥 + 锁定阴影宏仓库聚光 + 零分配 Viewport DRS
      if (this.isExtremeActive) {
        const smSize = this.sunsetLight.shadow.mapSize.x || 2048;
        const texelStep = 56 / smSize;
        const px = Math.round(cam.x / texelStep) * texelStep;
        const pz = Math.round(cam.z / texelStep) * texelStep;
        this.sunsetTarget.position.set(px, 0, pz);
        this.sunsetTarget.updateMatrixWorld();
        this.sunsetLight.position.set(px - 68, 18, pz - 42);

        if (this.whSpotShadow) {
          const whOn = !!op.whLightOn;
          const dxWh = cam.x - (-12);
          const dzWh = cam.z - (-22);
          const nearWh = dxWh * dxWh + dzWh * dzWh < 34 * 34;
          if (whOn && nearWh) {
            const turnedOn = this.whSpotShadow.intensity < 1;
            this.whSpotShadow.intensity = 34;
            this._whShadowTick = (this._whShadowTick + 1) & 1;
            if (turnedOn || this._whShadowTick === 0) {
              this.whSpotShadow.shadow.needsUpdate = true;
            }
          } else {
            this.whSpotShadow.intensity = 0;
          }
        }

        this._drsCooldown = Math.max(0, this._drsCooldown - safeDt);
        if (typeof GameLogic !== 'undefined' && GameLogic.computeDrsScale) {
          const nextDrs = GameLogic.computeDrsScale(this.drsScale, this.fpsSmooth, this.drsEnabled, safeDt);
          if (Math.abs(nextDrs - this.drsScale) >= 0.03 && this._drsCooldown <= 0) {
            this.drsScale = nextDrs;
            this._drsCooldown = 0.65;
            if (this.extremePipeline) this.extremePipeline.setDrsViewport(this.drsScale);
          }
        }
      }

      // 偶发远空闪电脉冲
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 14 + Math.random() * 18;
        this.lightningFlash = 0.75 + Math.random() * 0.35;
        if (this.onLightningFlash) this.onLightningFlash(this.lightningFlash);
      }
      if (this.lightningFlash > 0) {
        this.lightningFlash = Math.max(0, this.lightningFlash - dt * 4.5);
      }

      this.skyMat.uniforms.uTime.value = this.time;
      this.skyMat.uniforms.uLightning.value = this.lightningFlash;
      const baseHemi = this.blackoutMode ? 0.35 : 0.88;
      this.hemiLight.intensity = baseHemi + this.lightningFlash * 0.75;

      this.seaMat.uniforms.uTime.value = this.time;
      this.seaMat.uniforms.uCameraPos.value.copy(cam);

      for (let i = 0; i < this.volumetricMaterials.length; i++) {
        this.volumetricMaterials[i].uniforms.uTime.value = this.time;
      }

      const pu = this.puddleReflector.material.uniforms;
      const mInt = muzzleIntensity || 0;
      if (this.puddleReflector.enabled) {
        pu.uTime.value = this.time;
        pu.uCameraPos.value.copy(cam);
        if (muzzlePos) {
          pu.uMuzzlePos.value.copy(muzzlePos);
        }
        pu.uMuzzleIntensity.value = mInt;
      }

      const rm = this.rainMat.uniforms;
      const sm = this.splashMat.uniforms;
      rm.uTime.value = this.time;
      rm.uCamPos.value.copy(cam);
      rm.uLightning.value = this.lightningFlash;
      rm.uBlackout.value = this.blackoutMode ? 1.0 : 0.0;
      rm.uMuzzleIntensity.value = mInt;
      if (muzzlePos) rm.uMuzzlePos.value.copy(muzzlePos);

      sm.uTime.value = this.time;
      sm.uCamPos.value.copy(cam);
      sm.uLightning.value = this.lightningFlash;
      sm.uBlackout.value = this.blackoutMode ? 1.0 : 0.0;
      sm.uMuzzleIntensity.value = mInt;
      if (muzzlePos) sm.uMuzzlePos.value.copy(muzzlePos);

      const flashlight = op.flashlight || null;
      if (flashlight && flashlight.intensity > 0.1) {
        flashlight.getWorldPosition(this._tmpFlashPos);
        if (flashlight.target) {
          flashlight.target.getWorldPosition(this._tmpFlashDir).sub(this._tmpFlashPos).normalize();
        } else {
          this.camera.getWorldDirection(this._tmpFlashDir);
        }
        rm.uFlashPos.value.copy(this._tmpFlashPos);
        rm.uFlashDir.value.copy(this._tmpFlashDir);
        rm.uFlashOn.value = 1.0;
        sm.uFlashPos.value.copy(this._tmpFlashPos);
        sm.uFlashDir.value.copy(this._tmpFlashDir);
        sm.uFlashOn.value = 1.0;
      } else {
        rm.uFlashOn.value = 0.0;
        sm.uFlashOn.value = 0.0;
      }

      const spotCount = Math.min(2, this.searchlights.length);
      rm.uSpotCount.value = spotCount;
      sm.uSpotCount.value = spotCount;
      for (let i = 0; i < this.searchlights.length; i++) {
        const sl = this.searchlights[i];
        const phase = this.time * (i === 0 ? 0.52 : -0.44) + i * 1.4;
        sl.pivot.rotation.y = Math.sin(phase) * 0.58;
        sl.pivot.rotation.x = 0.62 + Math.cos(phase * 0.7) * 0.14;
        sl.pivot.updateMatrixWorld(true);
        if (i < 2) {
          sl.pivot.getWorldPosition(this._tmpSpotOrigin);
          sl.targetAnchor.getWorldPosition(this._tmpSpotPos);
          this._tmpSpotDir.copy(this._tmpSpotPos).sub(this._tmpSpotOrigin).normalize();
          if (i === 0) {
            rm.uSpot1Origin.value.copy(this._tmpSpotOrigin);
            rm.uSpot1Pos.value.copy(this._tmpSpotPos);
            rm.uSpot1Dir.value.copy(this._tmpSpotDir);
            sm.uSpot1Origin.value.copy(this._tmpSpotOrigin);
            sm.uSpot1Pos.value.copy(this._tmpSpotPos);
            sm.uSpot1Dir.value.copy(this._tmpSpotDir);
            if (this.puddleReflector.enabled) pu.uSpot1Pos.value.copy(this._tmpSpotPos);
          } else {
            rm.uSpot2Origin.value.copy(this._tmpSpotOrigin);
            rm.uSpot2Pos.value.copy(this._tmpSpotPos);
            rm.uSpot2Dir.value.copy(this._tmpSpotDir);
            sm.uSpot2Origin.value.copy(this._tmpSpotOrigin);
            sm.uSpot2Pos.value.copy(this._tmpSpotPos);
            sm.uSpot2Dir.value.copy(this._tmpSpotDir);
            if (this.puddleReflector.enabled) pu.uSpot2Pos.value.copy(this._tmpSpotPos);
          }
        } else if (this.puddleReflector.enabled) {
          sl.targetAnchor.getWorldPosition(pu.uSpot2Pos.value);
        }
      }

      if (this.lightPool) {
        this.lightPool.update(cam, safeDt);
      }

      // 更新金属火花池（脏标记按需上传）
      let sparkDirty = !!this._sparksDirty;
      this._sparksDirty = false;
      for (let i = 0; i < this.maxSparks; i++) {
        const s = this.sparks[i];
        if (!s.active) continue;
        sparkDirty = true;
        s.life += dt;
        if (s.life >= s.maxLife) {
          s.active = false;
          this.sparkMesh.setMatrixAt(i, this._zeroMat);
          continue;
        }
        s.vel.y -= 16 * dt;
        s.pos.addScaledVector(s.vel, dt);
        if (s.pos.y < 0.03) {
          s.pos.y = 0.03;
          s.vel.y = Math.abs(s.vel.y) * 0.42;
          s.vel.x *= 0.7;
          s.vel.z *= 0.7;
        }
        const scale = 1 - s.life / s.maxLife;
        this._dummy.position.copy(s.pos);
        this._dummy.lookAt(s.pos.x + s.vel.x, s.pos.y + s.vel.y, s.pos.z + s.vel.z);
        this._dummy.scale.set(scale, scale, scale * 1.6);
        this._dummy.updateMatrix();
        this.sparkMesh.setMatrixAt(i, this._dummy.matrix);
      }
      if (sparkDirty) {
        this.sparkMesh.instanceMatrix.needsUpdate = true;
      }

      // 更新 3D 水花王冠实例缓冲（仅更新 0..activeSplashCount-1，零 Vector3 分配）
      const cx = cam.x;
      const cz = cam.z;
      const activeCount = Math.min(this.maxSplashes, this.activeSplashCount || 0);
      for (let i = 0; i < activeCount; i++) {
        const sp = this.splashes[i];
        sp.phase += dt * sp.speed;
        const outOfRange = Math.abs(sp.x - cx) > 17.5 || Math.abs(sp.z - cz) > 17.5;
        if (sp.phase >= 1 || outOfRange) {
          if (sp.phase >= 1) sp.phase -= Math.floor(sp.phase);
          const x = cx + (Math.random() - 0.5) * 32;
          const z = cz + (Math.random() - 0.5) * 32;
          sp.x = x;
          sp.z = z;
          const inMainDock = x >= -42.0 && x <= 22.0 && z >= -34.0 && z <= 33.5;
          const inPier = x >= 14.0 && x <= 26.0 && z >= -34.0 && z <= -16.0;
          const insideWh = x > -22.2 && x < -1.8 && z > -32.2 && z < -13.8;
          if ((inMainDock || inPier) && !insideWh) {
            sp.y = this._sampleRainOccHeight(x, z) + 0.015;
            sp.active = true;
            const i3 = i * 3;
            this._splashPosArr[i3] = x;
            this._splashPosArr[i3 + 1] = sp.y;
            this._splashPosArr[i3 + 2] = z;
          } else {
            sp.active = false;
          }
        }
        this._splashPhaseArr[i] = sp.active ? sp.phase : -1.0;
      }
      this._splashPosAttr.needsUpdate = true;
      this._splashPhaseAttr.needsUpdate = true;

      // 更新烟尘粒子池（面朝摄像机广告牌膨胀消散）
      if (this.smokeMesh) {
        let smokeDirty = false;
        for (let i = 0; i < this.maxSmoke; i++) {
          const sm = this.smokes[i];
          if (!sm.active) continue;
          smokeDirty = true;
          sm.life += dt;
          if (sm.life >= sm.maxLife) {
            sm.active = false;
            this.smokeMesh.setMatrixAt(i, this._zeroMat);
            continue;
          }
          const t = sm.life / sm.maxLife;
          sm.vel.multiplyScalar(Math.max(0, 1 - dt * 1.8));
          sm.vel.y += 0.35 * dt;
          sm.pos.addScaledVector(sm.vel, dt);
          sm.roll += dt * 0.9;
          const sc = (sm.startScale + (sm.endScale - sm.startScale) * t) * (1 - 0.18 * t * t);
          this._dummy.position.copy(sm.pos);
          this._dummy.quaternion.copy(this.camera.quaternion);
          this._rollQuat.setFromAxisAngle(this._zAxis, sm.roll);
          this._dummy.quaternion.multiply(this._rollQuat);
          this._dummy.scale.set(sc, sc, 1);
          this._dummy.updateMatrix();
          this.smokeMesh.setMatrixAt(i, this._dummy.matrix);
        }
        if (smokeDirty) {
          this.smokeMesh.instanceMatrix.needsUpdate = true;
        }
      }
    }

    render() {
      if (this.isExtremeActive && this.extremePipeline && this.extremePipeline.enabled) {
        const op = this._lastOpticsState || {};
        const ok = this.extremePipeline.renderFrame({
          sunsetLight: this.sunsetLight,
          searchlights: this.searchlights,
          flashlight: op.flashlight || null,
          time: this.time,
          lensRainAlpha: this.lensRainAlpha,
          lowHpFactor: this.lowHpFactor,
          scanWave: this.scanPulseTimer > 0 ? (1 - this.scanPulseTimer / 1.15) : 0,
          blackout: this.blackoutMode,
          adsAlpha: op.adsAlpha || 0,
          isDmrScoped: !!op.isDmrScoped,
          muzzleHeat: op.muzzleHeat || 0,
          dt: this._lastDt || 0.016,
        });
        if (ok) return;
      }

      if (!this.postEnabled || !this.hdrTarget || !this.compMat) {
        this.renderer.render(this.scene, this.camera);
        return;
      }

      const prevClear = this.renderer.autoClear;
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(this.hdrTarget);
      this.renderer.render(this.scene, this.camera);

      // 1. 提取高亮像素用于轻量化四分之一分辨率 Bloom
      this.brightMat.uniforms.tDiffuse.value = this.hdrTarget.texture;
      this.postQuad.material = this.brightMat;
      this.renderer.setRenderTarget(this.bloomTargetA);
      this.renderer.render(this.postScene, this.postCamera);

      // 2. 横向/纵向分离高斯模糊两遍
      const bw = Math.max(1, this.bloomTargetA.width);
      const bh = Math.max(1, this.bloomTargetA.height);
      this.blurMat.uniforms.tDiffuse.value = this.bloomTargetA.texture;
      this.blurMat.uniforms.uTexel.value.set(1.2 / bw, 0);
      this.postQuad.material = this.blurMat;
      this.renderer.setRenderTarget(this.bloomTargetB);
      this.renderer.render(this.postScene, this.postCamera);

      this.blurMat.uniforms.tDiffuse.value = this.bloomTargetB.texture;
      this.blurMat.uniforms.uTexel.value.set(0, 1.2 / bh);
      this.renderer.setRenderTarget(this.bloomTargetA);
      this.renderer.render(this.postScene, this.postCamera);

      // 3. 合成 Bloom + 镜头雨滴 + Q 扫描环 + 低血量脉冲并输出至默认帧缓冲执行 ACES 色调映射
      this.compMat.uniforms.tDiffuse.value = this.hdrTarget.texture;
      this.compMat.uniforms.tBloom.value = this.bloomTargetA.texture;
      this.postQuad.material = this.compMat;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.postScene, this.postCamera);
      this.renderer.autoClear = prevClear;
    }
  }

  return Engine;
})();
