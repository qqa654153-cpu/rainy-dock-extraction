// ============================================================================
// 模块 4：集装箱码头关卡建造与碰撞世界 (LevelBuilder)
// 包含：湿滑码头地板与防波堤、堆叠/斜坡/贯通集装箱、室内铁皮仓库、
// 龙门吊与高架平台、东北泊位撤离船只、3处可交互中继器、补给箱及AABB射线碰撞。
// ============================================================================

const LevelBuilder = (() => {
  'use strict';

  const _losDir = new THREE.Vector3();
  const _tmpVecA = new THREE.Vector3();
  const _tmpUp = new THREE.Vector3(0, 1, 0);

  class CollisionWorld {
    constructor() {
      this.boxes = [];   // 静态障碍 AABB: { minX, maxX, minY, maxY, minZ, maxZ, metal }
      this.aerialBoxes = []; // 空中敌机专用的 3D 障碍体积（包含仓库整体外壳、高架结构、立柱）
      this.ramps = [];   // 斜坡: { minX, maxX, minZ, maxZ, axis, y0, y1 }
      this.rayMeshes = []; // 供精确子弹射线检测的 Mesh 数组
    }

    addBox(minX, maxX, minY, maxY, minZ, maxZ, isMetal = true, opts = null) {
      const entry = {
        minX,
        maxX,
        minY,
        maxY,
        minZ,
        maxZ,
        isMetal,
        disabled: false,
        isDynamic: !!(opts && opts.isDynamic),
      };
      this.boxes.push(entry);
      if (!(opts && opts.aerialSkip)) {
        this.aerialBoxes.push(entry);
      }
      return entry;
    }

    addAerialBox(minX, maxX, minY, maxY, minZ, maxZ, opts = null) {
      const extremeOnly = !!(opts && opts.extremeOnly);
      const entry = {
        minX, maxX, minY, maxY, minZ, maxZ,
        isMetal: true,
        extremeOnly,
        disabled: extremeOnly,
      };
      this.aerialBoxes.push(entry);
      return entry;
    }

    setExtremeAerialEnabled(enabled) {
      const next = !!enabled;
      for (let i = 0; i < this.aerialBoxes.length; i++) {
        const b = this.aerialBoxes[i];
        if (b.extremeOnly) {
          b.disabled = !next;
        }
      }
    }

    resolveAerial(pos, radiusXZ = 1.0, halfY = 0.45) {
      if (typeof GameLogic !== 'undefined' && typeof GameLogic.resolveAerialObstacle === 'function') {
        return GameLogic.resolveAerialObstacle(pos, this.aerialBoxes, radiusXZ, halfY);
      }
      return false;
    }

    getAerialFloor(x, z, curY, radiusXZ = 0.95) {
      if (typeof GameLogic !== 'undefined' && typeof GameLogic.getAerialFloorHeight === 'function') {
        return GameLogic.getAerialFloorHeight(x, z, curY, this.aerialBoxes, radiusXZ);
      }
      return 0;
    }

    findSafeAerialSpawn(preferredPos, opts = {}) {
      if (typeof GameLogic !== 'undefined' && typeof GameLogic.findSafeAerialSpawn === 'function') {
        return GameLogic.findSafeAerialSpawn(preferredPos, this.aerialBoxes, opts);
      }
      return { x: preferredPos.x, y: preferredPos.y, z: preferredPos.z };
    }

    addRamp(minX, maxX, minZ, maxZ, axis, y0, y1) {
      this.ramps.push({ minX, maxX, minZ, maxZ, axis, y0, y1 });
    }

    getGroundHeight(x, z, curY) {
      let h = 0;
      // 检查可站立斜坡
      for (let i = 0; i < this.ramps.length; i++) {
        const r = this.ramps[i];
        if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) {
          const t = r.axis === 'z'
            ? (z - r.minZ) / (r.maxZ - r.minZ)
            : (x - r.minX) / (r.maxX - r.minX);
          const rh = r.y0 + (r.y1 - r.y0) * Math.max(0, Math.min(1, t));
          if (rh <= curY + 0.7 && rh > h) h = rh;
        }
      }
      // 检查可行走平台顶面（集装箱顶、高台、船甲板）
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (b.disabled) continue;
        if (x >= b.minX - 0.15 && x <= b.maxX + 0.15 && z >= b.minZ - 0.15 && z <= b.maxZ + 0.15) {
          if (b.maxY <= curY + 0.55 && b.maxY > h) {
            h = b.maxY;
          }
        }
      }
      return h;
    }

    resolveCircleXZ(pos, radius, feetY) {
      // 限制在码头 + 东北栈桥 + 船甲板安全边界内（防坠海且无边缘突变）
      pos.x = Math.max(-39.5, Math.min(31.4, pos.x));
      if (pos.x > 26.8) {
        pos.z = Math.max(-31.2, Math.min(-19.8, pos.z));
      } else if (pos.x > 21.3) {
        pos.z = Math.max(-33.0, Math.min(-16.8, pos.z));
      } else {
        pos.z = Math.max(-33.5, Math.min(31.5, pos.z));
      }

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < this.boxes.length; i++) {
          const b = this.boxes[i];
          if (b.disabled) continue;
          if (feetY >= b.maxY - 0.35 || feetY + 1.65 <= b.minY) continue;

          const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
          const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
          const dx = pos.x - cx;
          const dz = pos.z - cz;
          const distSq = dx * dx + dz * dz;
          if (distSq < radius * radius) {
            const dist = Math.sqrt(distSq);
            if (dist > 0.0001) {
              const push = radius - dist;
              pos.x += (dx / dist) * push;
              pos.z += (dz / dist) * push;
            } else {
              // 实体中心处于箱体内部时推向最近边缘
              const dLeft = Math.abs(pos.x - b.minX);
              const dRight = Math.abs(b.maxX - pos.x);
              const dBack = Math.abs(pos.z - b.minZ);
              const dFront = Math.abs(b.maxZ - pos.z);
              const m = Math.min(dLeft, dRight, dBack, dFront);
              if (m === dLeft) pos.x = b.minX - radius;
              else if (m === dRight) pos.x = b.maxX + radius;
              else if (m === dBack) pos.z = b.minZ - radius;
              else pos.z = b.maxZ + radius;
            }
          }
        }
      }
    }

    hasLineOfSight(a, b) {
      _losDir.subVectors(b, a);
      const len = _losDir.length();
      if (len < 0.05) return true;
      _losDir.divideScalar(len);
      const invX = 1 / (_losDir.x || 1e-8);
      const invY = 1 / (_losDir.y || 1e-8);
      const invZ = 1 / (_losDir.z || 1e-8);

      for (let i = 0; i < this.boxes.length; i++) {
        const box = this.boxes[i];
        if (box.disabled) continue;
        const t1 = (box.minX - a.x) * invX;
        const t2 = (box.maxX - a.x) * invX;
        const t3 = (box.minY - a.y) * invY;
        const t4 = (box.maxY - a.y) * invY;
        const t5 = (box.minZ - a.z) * invZ;
        const t6 = (box.maxZ - a.z) * invZ;
        const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
        const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));
        if (tmax >= 0 && tmin <= tmax && tmin < len - 0.15) {
          return false;
        }
      }
      return true;
    }

    raycastBoxes(origin, dir, minDist = 0.001, maxDist = 1000, outPoint = null) {
      let bestDist = maxDist;
      let hit = false;
      const ox = origin.x;
      const oy = origin.y;
      const oz = origin.z;
      const dx = dir.x;
      const dy = dir.y;
      const dz = dir.z;
      const useFn = typeof GameLogic !== 'undefined' && typeof GameLogic.raycastAABB === 'function';
      for (let i = 0; i < this.boxes.length; i++) {
        const box = this.boxes[i];
        if (box.disabled) continue;
        let d = -1;
        if (useFn) {
          d = GameLogic.raycastAABB(ox, oy, oz, dx, dy, dz, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, minDist, bestDist);
        } else {
          const invX = 1 / (dx || 1e-8);
          const invY = 1 / (dy || 1e-8);
          const invZ = 1 / (dz || 1e-8);
          const t1 = (box.minX - ox) * invX;
          const t2 = (box.maxX - ox) * invX;
          const t3 = (box.minY - oy) * invY;
          const t4 = (box.maxY - oy) * invY;
          const t5 = (box.minZ - oz) * invZ;
          const t6 = (box.maxZ - oz) * invZ;
          const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
          const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));
          if (tmax >= minDist && tmin <= tmax && tmin >= minDist && tmin < bestDist) d = tmin;
        }
        if (d >= minDist && d < bestDist) {
          bestDist = d;
          hit = true;
        }
      }
      if (dy < -1e-4 && oy > 0) {
        const tFloor = -oy / dy;
        if (tFloor >= minDist && tFloor < bestDist) {
          const hx = ox + dx * tFloor;
          const hz = oz + dz * tFloor;
          if (hx >= -43 && hx <= 32 && hz >= -35 && hz <= 34) {
            bestDist = tFloor;
            hit = true;
          }
        }
      }
      if (!hit) return -1;
      if (outPoint) {
        outPoint.set(ox + dx * bestDist, oy + dy * bestDist, oz + dz * bestDist);
      }
      return bestDist;
    }
  }

  class Builder {
    constructor(renderEngine, texFactory) {
      this.render = renderEngine;
      this.scene = renderEngine.scene;
      this.tex = texFactory;
      this.collision = new CollisionWorld();
      this.relays = [];
      this.supplyCrates = [];
      this.ammoCrates = [];
      this.breakers = [];
      this.barrels = [];
      this.alarmLights = [];
      this.perimeterLights = [];
      this.warehouseLights = null;
      this.aSearchlight = null;
      this.animatedProps = [];
      this.navGrid = null;
      this.aerialNavGrid = null;
      this.activeMutators = [];
      this.extraction = null;
      this.tutorialBeacon = null;
      this.tutorialMedkit = null;
      this.tutorialRelay = null;
      this.tutorialAmmoCrate = null;
      this.onBarrelExplode = null;
      this.barrelFlashLight = this.render.createVirtualLight({
        color: 0xff6b22,
        intensity: 0,
        distance: 22,
        decay: 1.5,
        priority: 9.0,
      });
      this._barrelFlashTimer = 0;
      this.warehouseBox = { minX: -22, maxX: -2, minZ: -32, maxZ: -14, maxY: 6.5 };
      this._containerSpecs = [];
      this._boatGroup = null;
      this.rainOcclusionMap = null;
      this.extremeDetailGroup = new THREE.Group();
      this.extremeDetailGroup.visible = false;
      this.scene.add(this.extremeDetailGroup);
    }

    build() {
      this._buildDockFloorAndQuay();
      this._buildContainers();
      this._buildWarehouse();
      this._buildGantryCrane();
      this._buildExtractionBoat();
      this._buildRelays();
      this._buildSupplyCrates();
      this._buildPerimeterLights();
      this._buildTutorialProps();
      this._buildExtremeLevelDetails();
      this.rainOcclusionMap = (typeof window !== 'undefined' && window.GameLogic && window.GameLogic.bakeRainOcclusionHeightmap)
        ? window.GameLogic.bakeRainOcclusionHeightmap(this.collision.boxes, { width: 256, height: 256 })
        : null;
      if (window.GameLogic && window.GameLogic.buildNavGrid) {
        this.navGrid = window.GameLogic.buildNavGrid(this.collision.boxes);
        this.aerialNavGrid = window.GameLogic.buildNavGrid(this.collision.aerialBoxes, {
          minX: -40,
          maxX: 29,
          minZ: -33,
          maxZ: 31,
          cellSize: 1.25,
          padding: 1.0,
          maxStepHeight: 2.75,
          ceilingMinY: 8.5,
        });
      }
      return this;
    }

    _addSolidMesh(mesh, isMetal = true, skipCollision = false, boxOpts = null) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.collision.rayMeshes.push(mesh);
      if (!skipCollision) {
        mesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(mesh);
        this.collision.addBox(box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z, isMetal, boxOpts);
      }
      return mesh;
    }

    _buildDockFloorAndQuay() {
      // 主码头湿滑沥青地面
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(66, 1.5, 70),
        this.tex.asphaltData.asphaltMat
      );
      floor.position.set(-10, -0.75, 0);
      floor.receiveShadow = true;
      this.scene.add(floor);
      this.collision.rayMeshes.push(floor);

      // 东北侧延伸栈桥码头 (x: +23..+26, z: -34..-16)，与主码头地面在 x=23 齐平衔接、无共面重叠
      const pierGeo = new THREE.BoxGeometry(3, 1.5, 18);
      const pierUv = pierGeo.attributes.uv;
      if (pierUv) {
        for (let i = 0; i < pierUv.count; i++) {
          if (i < 8) {
            // +X / -X 面：u 沿 Z(18m)，v 沿 Y(1.5m)
            pierUv.setY(i, pierUv.getY(i) * (1.5 / 18));
          } else if (i < 16) {
            // +Y / -Y 面：u 沿 X(3m)，v 沿 Z(18m)
            pierUv.setX(i, pierUv.getX(i) * (3 / 18));
          } else {
            // +Z / -Z 面：u 沿 X(3m)，v 沿 Y(1.5m)
            pierUv.setXY(i, pierUv.getX(i) * (3 / 18), pierUv.getY(i) * (1.5 / 18));
          }
        }
        pierUv.needsUpdate = true;
      }
      const pier = new THREE.Mesh(pierGeo, this.tex.concreteFloor);
      pier.position.set(24.5, -0.75, -25);
      pier.receiveShadow = true;
      this.scene.add(pier);
      this.collision.rayMeshes.push(pier);

      // 沿东岸/北岸水泥护缘石 + 黄色警示边缘条
      const curbMat = this.tex.concreteFloor;
      const curbs = [
        [22.3, 0.2, 8.95, 0.8, 0.4, 49.9],
        [-9.55, 0.2, -34.6, 65.1, 0.4, 0.8],
        [-42.6, 1.4, 0, 1.0, 2.8, 70],
        [0, 1.2, 34.4, 46, 2.4, 1.0],
      ];
      for (const [x, y, z, w, h, d] of curbs) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), curbMat);
        m.position.set(x, y, z);
        this._addSolidMesh(m, false);
      }
    }

    _placeContainer(x, y, z, w, h, d, colorKey, rotY = 0) {
      this._containerSpecs.push({ x, y, z, w, h, d, rotY });
      const mat = this.tex.containers[colorKey] || this.tex.containers.rustRed;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y + h * 0.5, z);
      m.rotation.y = rotY;
      return this._addSolidMesh(m, true);
    }

    _buildContainers() {
      // 南侧出生点前掩体群
      this._placeContainer(-6.5, 0, 19.5, 6.0, 2.6, 2.5, 'navyBlue');
      this._placeContainer(7.2, 0, 21.0, 6.0, 2.6, 2.5, 'rustRed');

      // 西侧集装箱堆场迷宫与高台掩体（围绕中继器 A: -24, 0, +3.5）
      this._placeContainer(-28, 0, 14, 12.0, 2.6, 2.5, 'rustRed');
      this._placeContainer(-28, 2.6, 14, 6.0, 2.6, 2.5, 'ochreYellow');
      this._placeContainer(-16, 0, 10, 2.5, 2.6, 6.0, 'oliveSteel');
      this._placeContainer(-32, 0, 2, 2.5, 2.6, 12.0, 'navyBlue');
      this._placeContainer(-32, 2.6, 2, 2.5, 2.6, 6.0, 'rustRed');
      this._placeContainer(-18, 0, -4, 6.0, 2.6, 2.5, 'ochreYellow');
      this._placeContainer(-28, 0, -9, 12.0, 2.6, 2.5, 'oliveSteel');
      this._placeContainer(-25, 2.6, -9, 6.0, 2.6, 2.5, 'navyBlue');

      // 供玩家攀爬上集的斜坡集装箱门板 (通往 -16, 2.6, 10 顶部狙击位)
      const rampMesh = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 6.6), this.tex.metalFrame);
      rampMesh.position.set(-16, 1.32, 15.9);
      rampMesh.rotation.x = 0.42;
      this._addSolidMesh(rampMesh, true, true);
      this.collision.addRamp(-17.2, -14.8, 12.8, 19.0, 'z', 2.65, 0.0);

      // 中央交战区散落箱体与油桶掩体
      this._placeContainer(1.5, 0, 8.5, 6.0, 2.6, 2.5, 'ochreYellow');
      this._placeContainer(1.5, 2.6, 8.5, 6.0, 2.6, 2.5, 'rustRed');
      this._placeContainer(-6.0, 0, -2.5, 2.5, 2.6, 6.0, 'navyBlue');
      this._placeContainer(5.5, 0, -9.5, 6.0, 2.6, 2.5, 'oliveSteel');

      // 散落木箱与危化品油桶（低矮掩体，可蹲伏掩护）
      const crates = [
        [-2.2, 0, 23.0, 1.5, 1.2, 1.5],
        [-21.5, 0, 6.5, 1.6, 1.3, 1.6],
        [9.5, 0, 2.0, 1.8, 1.3, 1.4],
        [10.5, 0, -18.5, 1.6, 1.3, 1.6],
      ];
      for (const [cx, cy, cz, w, h, d] of crates) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.tex.woodCrate);
        c.position.set(cx, cy + h * 0.5, cz);
        this._addSolidMesh(c, false);
      }

      const barrelGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.25, 14);
      const baseBarrels = [
        [2.8, 11.2, false], [-22.5, -1.2, false], [11.5, 13.5, false], [16.5, -17.5, false],
        [-13.5, -10.5, false], [15.5, -6.5, false],
        // 词缀：爆破狂潮（explosive_tide）额外红桶点位
        [-10.5, 4.5, true], [-21.5, -6.5, true], [14.0, 2.0, true], [-4.5, -18.5, true],
      ];
      for (const [bx, bz, isExtraMutator] of baseBarrels) {
        const mat = this.tex.hazardBarrel.clone();
        const b = new THREE.Mesh(barrelGeo, mat);
        b.position.set(bx, 0.625, bz);
        b.castShadow = true;
        b.receiveShadow = true;
        b.visible = !isExtraMutator;
        this.scene.add(b);
        const aabbBox = this.collision.addBox(bx - 0.5, bx + 0.5, 0, 1.28, bz - 0.5, bz + 0.5, true, { isDynamic: true });
        if (isExtraMutator) aabbBox.disabled = true;
        const barrelObj = {
          id: this.barrels.length,
          hp: 45,
          maxHp: 45,
          state: isExtraMutator ? 'exploded' : 'intact', // intact | burning | chaining | exploded
          isExtraMutator,
          pos: new THREE.Vector3(bx, 0.625, bz),
          mesh: b,
          mat,
          aabbBox,
          burnTimer: 0,
          chainTimer: -1,
        };
        b.userData = { barrel: barrelObj, isBarrel: true, noDecal: true };
        this.barrels.push(barrelObj);
      }
    }

    getActiveBarrelHitboxes() {
      const list = [];
      for (let i = 0; i < this.barrels.length; i++) {
        if (this.barrels[i].state !== 'exploded') {
          list.push(this.barrels[i].mesh);
        }
      }
      return list;
    }

    getBreakerHitboxes() {
      const list = [];
      for (let i = 0; i < this.breakers.length; i++) {
        if (!this.breakers[i].tripped) {
          list.push(this.breakers[i].mesh);
        }
      }
      return list;
    }

    flashExplosionLight(pos) {
      if (!this.barrelFlashLight) return;
      this.barrelFlashLight.position.set(pos.x, pos.y + 0.9, pos.z);
      this.barrelFlashLight.intensity = 42;
      this._barrelFlashTimer = 0.28;
    }

    _buildWarehouse() {
      // 西北室内铁皮仓库 (x: -22..-2, z: -32..-14, y: 0..6.5)
      const wallMat = this.tex.warehouseWall;
      const roofMat = this.tex.warehouseRoof;

      // 水泥地坪（覆盖外部地面以突出干湿分明，略高于水面反射平面避免闪烁）
      const whFloor = new THREE.Mesh(new THREE.BoxGeometry(20, 0.06, 18), this.tex.concreteFloor);
      whFloor.position.set(-12, -0.011, -23);
      whFloor.receiveShadow = true;
      this.scene.add(whFloor);
      this.collision.rayMeshes.push(whFloor);

      // 北墙 (-32) 与 西墙 (-22) 完整壁面（角部错开收口，零共面重叠）
      const wallSpecs = [
        [-12, 3.25, -32, 20.35, 6.5, 0.35],
        [-22, 3.25, -23, 0.35, 6.5, 17.65],
        // 南墙 (-14) 留出 x: -15..-9 宽6m高4.3m卷帘门
        [-18.5875, 3.25, -14, 7.175, 6.5, 0.35],
        [-5.4125, 3.25, -14, 7.175, 6.5, 0.35],
        [-12.0, 5.4, -14, 6.0, 2.2, 0.35],
        // 东墙 (-2) 留出 z: -26..-20 宽6m高4.3m侧门直通撤离栈桥
        [-2, 3.25, -28.9125, 0.35, 6.5, 5.825],
        [-2, 3.25, -17.0875, 0.35, 6.5, 5.825],
        [-2, 5.4, -23, 0.35, 2.2, 6.0],
      ];
      for (const [x, y, z, w, h, d] of wallSpecs) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        m.position.set(x, y, z);
        this._addSolidMesh(m, true, false, { aerialSkip: true });
      }

      // 人字坡铁皮屋顶（两片坡面 + 南北山墙三角封板，确保室内绝对密闭无天光漏缝）
      const roofLeft = new THREE.Mesh(new THREE.BoxGeometry(10.8, 0.18, 18.8), roofMat);
      roofLeft.position.set(-17.1, 7.05, -23);
      roofLeft.rotation.z = 0.14;
      this._addSolidMesh(roofLeft, true, true);

      const roofRight = new THREE.Mesh(new THREE.BoxGeometry(10.8, 0.18, 18.8), roofMat);
      roofRight.position.set(-6.9, 7.05, -23);
      roofRight.rotation.z = -0.14;
      this._addSolidMesh(roofRight, true, true);

      const gableShape = new THREE.Shape();
      gableShape.moveTo(-10.0, 6.50);
      gableShape.lineTo(10.0, 6.50);
      gableShape.lineTo(0, 7.73);
      gableShape.closePath();
      const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: 0.32, bevelEnabled: false });
      const gableNorth = new THREE.Mesh(gableGeo, wallMat);
      gableNorth.position.set(-12, 0, -32.16);
      this._addSolidMesh(gableNorth, true, true);
      const gableSouth = new THREE.Mesh(gableGeo, wallMat);
      gableSouth.position.set(-12, 0, -14.16);
      this._addSolidMesh(gableSouth, true, true);

      // 仓库屋顶射线/LOS 碰撞台阶体（地面 NavGrid 因 minY>=6.35 自动忽略，同时防止敌机视距/弹道穿透屋顶）
      this.collision.addBox(-22.4, -1.6, 6.35, 6.95, -32.3, -13.7, true, { aerialSkip: true });
      this.collision.addBox(-18.5, -5.5, 6.85, 7.40, -32.3, -13.7, true, { aerialSkip: true });
      this.collision.addBox(-15.0, -9.0, 7.30, 7.82, -32.3, -13.7, true, { aerialSkip: true });

      // 空中敌机专用的铁皮仓库整体外壳禁飞体积（禁止无人机从门洞飞入或穿透屋顶/山墙）
      this.collision.addAerialBox(-22.2, -1.8, 0, 7.82, -32.2, -13.8);

      // 仓库内部钢结构柱与货物掩体
      const pillarGeo = new THREE.BoxGeometry(0.45, 6.4, 0.45);
      for (const [px, pz] of [[-12, -23], [-17, -20], [-7, -26]]) {
        const p = new THREE.Mesh(pillarGeo, this.tex.metalFrame);
        p.position.set(px, 3.2, pz);
        this._addSolidMesh(p, true, false, { aerialSkip: true });
      }
      const inCrates = [
        [-11, 0, -21, 2.2, 1.35, 1.5],
        [-16.5, 0, -18.5, 1.8, 1.4, 1.8],
        [-7.5, 0, -28.5, 2.6, 2.0, 1.6],
      ];
      for (const [cx, cy, cz, w, h, d] of inCrates) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.tex.woodCrate);
        c.position.set(cx, cy + h * 0.5, cz);
        this._addSolidMesh(c, false, false, { aerialSkip: true });
      }

      // 仓库室内摇晃高压钠灯 + 门前溢出体积光柱（顶部刚性吊杆直连屋脊）
      const lampMount = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.46, 8), this.tex.metalFrame);
      lampMount.position.set(-12, 7.11, -22);
      this.scene.add(lampMount);
      const lampJunction = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.26), this.tex.metalFrame);
      lampJunction.position.set(-12, 6.42, -22);
      this.scene.add(lampJunction);

      const lampPivot = new THREE.Group();
      lampPivot.position.set(-12, 6.4, -22);
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), this.tex.metalFrame);
      cord.position.y = -0.75;
      lampPivot.add(cord);

      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.45, 12, 1, true), this.tex.metalFrame);
      shade.position.y = -1.55;
      lampPivot.add(shade);

      const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffc670 });
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 8),
        bulbMat
      );
      bulb.position.y = -1.65;
      lampPivot.add(bulb);

      const whLight = this.render.createVirtualLight({
        color: 0xffaa4d,
        intensity: 38,
        distance: 28,
        decay: 1.5,
        y: -1.7,
        hostObject: lampPivot,
        priority: 5.0,
      });

      const lampCone = this.render.createBeam(0xffae52, 0.35, 4.8, 6.0, 0.16);
      lampCone.position.y = -1.65;
      lampPivot.add(lampCone);

      this.scene.add(lampPivot);
      this.animatedProps.push((t) => {
        lampPivot.rotation.z = Math.sin(t * 1.35) * 0.06;
        lampPivot.rotation.x = Math.cos(t * 1.1) * 0.035;
      });

      // 南大门溢出光束
      const doorSpill = this.render.createBeam(0xffa448, 2.2, 5.4, 11.0, 0.11);
      doorSpill.position.set(-12, 3.8, -13.8);
      doorSpill.rotation.x = -0.95;
      this.scene.add(doorSpill);

      this.warehouseLights = {
        whLight,
        bulbMat,
        lampCone,
        doorSpill,
        baseIntensity: 38,
        disabled: false,
      };
    }

    _buildGantryCrane() {
      // 东侧龙门吊 (跨度 x: 10..20.5, z: -3..+13, 高 16.5m)
      const craneMat = this.tex.craneYellow;
      const frameMat = this.tex.metalFrame;
      const mergeList = [];

      // 四根立柱
      const legCoords = [
        [10.2, -2.5], [10.2, 12.5],
        [20.2, -2.5], [20.2, 12.5],
      ];
      for (const [lx, lz] of legCoords) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.95, 15.8, 0.95), craneMat);
        leg.position.set(lx, 7.9, lz);
        this._addSolidMesh(leg, true);
      }

      // 合并顶部钢架大梁（减少 Draw Call）
      const topBeamGeo = new THREE.BoxGeometry(24, 1.4, 1.2);
      topBeamGeo.translate(18.5, 16.2, -2.5);
      mergeList.push(topBeamGeo);

      const topBeamGeo2 = new THREE.BoxGeometry(24, 1.4, 1.2);
      topBeamGeo2.translate(18.5, 16.2, 12.5);
      mergeList.push(topBeamGeo2);

      for (const bx of [10.2, 15.2, 20.2, 26.5]) {
        const cross = new THREE.BoxGeometry(1.1, 1.2, 16.2);
        cross.translate(bx, 16.2, 5.0);
        mergeList.push(cross);
      }

      // 起重天车轨道梁与行车滑车（锚固 4 根吊索钢缆，杜绝空中悬断）
      for (const rz of [2.8, 7.2]) {
        const railGeo = new THREE.BoxGeometry(10.0, 0.5, 0.45);
        railGeo.translate(15.2, 15.85, rz);
        mergeList.push(railGeo);
      }
      const trolley = new THREE.BoxGeometry(3.2, 0.65, 5.2);
      trolley.translate(15.2, 15.8, 5.0);
      mergeList.push(trolley);

      // 起重吊具（悬吊在空中）
      const spreader = new THREE.BoxGeometry(3.2, 1.1, 6.2);
      spreader.translate(15.2, 11.8, 5.0);
      mergeList.push(spreader);

      const mergedGeo = window.THREE_UTILS.mergeGeometries(mergeList, false);
      const craneTop = new THREE.Mesh(mergedGeo, craneMat);
      craneTop.castShadow = true;
      craneTop.receiveShadow = true;
      this.scene.add(craneTop);
      this.collision.rayMeshes.push(craneTop);

      // 龙门吊顶部钢梁、天车、吊具与钢缆碰撞体（防子弹/LOS/空中敌机穿模）
      this.collision.addBox(6.5, 30.5, 15.5, 16.9, -3.1, -1.9, true);
      this.collision.addBox(6.5, 30.5, 15.5, 16.9, 11.9, 13.1, true);
      for (const bx of [10.2, 15.2, 20.2, 26.5]) {
        this.collision.addBox(bx - 0.55, bx + 0.55, 15.6, 16.8, -3.1, 13.1, true);
      }
      this.collision.addBox(13.6, 16.8, 15.45, 16.15, 2.4, 7.6, true);
      this.collision.addBox(13.6, 16.8, 11.25, 12.35, 1.9, 8.1, true);
      this.collision.addAerialBox(13.85, 16.55, 12.35, 15.55, 2.65, 7.35);

      // 极限画质斜拉 K 撑外立面框架碰撞（仅在开启极限细节时启用）
      this.collision.addAerialBox(10.0, 20.4, 9.6, 15.6, -2.75, -2.25, { extremeOnly: true });
      this.collision.addAerialBox(10.0, 20.4, 9.6, 15.6, 12.25, 12.75, { extremeOnly: true });
      this.collision.addAerialBox(9.95, 10.45, 9.2, 16.0, -2.75, 12.75, { extremeOnly: true });
      this.collision.addAerialBox(19.95, 20.45, 9.2, 16.0, -2.75, 12.75, { extremeOnly: true });

      // 吊索钢缆
      const cableGeo = new THREE.CylinderGeometry(0.05, 0.05, 4.0, 6);
      for (const [cx, cz] of [[14.0, 2.8], [16.4, 2.8], [14.0, 7.2], [16.4, 7.2]]) {
        const c = new THREE.Mesh(cableGeo, frameMat);
        c.position.set(cx, 13.8, cz);
        this.scene.add(c);
      }

      // 龙门吊高架控制台平台 (x: 14.5..20.0, z: +0.5..+7.5, 顶面 y = 2.5m) + 金属斜坡
      const plat = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2.5, 7.0), frameMat);
      plat.position.set(17.25, 1.25, 4.0);
      this._addSolidMesh(plat, true);

      // 平台护栏（低矮遮挡 + 视觉细节）
      const rail = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.9, 0.16), craneMat);
      rail.position.set(17.25, 2.95, 0.58);
      this._addSolidMesh(rail, true);

      // 斜坡从 z = +13.5 (y = 0) 升至 z = +7.2 (y = 2.58)
      const rampGeo = new THREE.BoxGeometry(3.2, 0.25, 6.8);
      const rampMesh = new THREE.Mesh(rampGeo, frameMat);
      rampMesh.position.set(17.25, 1.29, 10.35);
      rampMesh.rotation.x = 0.40;
      this._addSolidMesh(rampMesh, true, true);
      this.collision.addRamp(15.65, 18.85, 7.2, 13.5, 'z', 2.58, 0.0);

      // 龙门吊双组扫射强光体积光柱（悬臂支架刚性挂接在 x=15.2 横梁下沿）
      const searchPositions = [
        [15.2, 15.18, 2.0, 0],
        [15.2, 15.18, 8.0, 1],
      ];
      for (const [sx, sy, sz, idx] of searchPositions) {
        const mountStem = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.42, 0.24), frameMat);
        mountStem.position.set(sx, 15.48, sz);
        this.scene.add(mountStem);

        const pivot = new THREE.Group();
        pivot.position.set(sx, sy, sz);
        const housing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.9), frameMat);
        pivot.add(housing);

        const beam = this.render.createBeam(0x9ce4ff, 0.42, 4.6, 28, 0.22);
        pivot.add(beam);

        const targetAnchor = new THREE.Object3D();
        targetAnchor.position.set(0, -18, 0);
        pivot.add(targetAnchor);

        this.scene.add(pivot);
        this.render.registerSearchlight(pivot, targetAnchor, idx);
      }

      // 顶峰航空警示红灯（钢制立柱底座锚接在 x=20.2 顶梁上）
      const beaconMast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 0.48, 8), frameMat);
      beaconMast.position.set(20.2, 16.92, 5.0);
      this.scene.add(beaconMast);

      const avBeacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xff2b2b })
      );
      avBeacon.position.set(20.2, 17.2, 5.0);
      this.scene.add(avBeacon);
      const avLight = this.render.createVirtualLight({
        color: 0xff2525,
        intensity: 16,
        distance: 26,
        decay: 1.6,
        x: avBeacon.position.x,
        y: avBeacon.position.y,
        z: avBeacon.position.z,
        priority: 4.0,
      });
      this.alarmLights.push({ light: avLight, mesh: avBeacon, baseIntensity: 16 });
    }

    _buildExtractionBoat() {
      // 东北泊位战术撤离船 (x: +29.2, z: -25.5)
      const boatGroup = new THREE.Group();
      boatGroup.position.set(29.2, -0.8, -25.5);
      this._boatGroup = boatGroup;

      const hull = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.0, 13.5), this.tex.boatHull);
      hull.position.y = 0.6;
      hull.castShadow = true;
      hull.receiveShadow = true;
      hull.userData.noDecal = true;
      boatGroup.add(hull);
      this.collision.rayMeshes.push(hull);

      // 船头斜尖
      const bow = new THREE.Mesh(new THREE.ConeGeometry(2.6, 4.2, 4), this.tex.boatHull);
      bow.rotation.x = -Math.PI / 2;
      bow.rotation.y = Math.PI / 4;
      bow.scale.set(1.0, 1.0, 0.52);
      bow.position.set(0, 0.85, -8.4);
      boatGroup.add(bow);

      // 驾驶舱与暖色仪表窗光
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.2, 4.2), this.tex.metalFrame);
      cabin.position.set(0, 2.6, -2.5);
      cabin.castShadow = true;
      cabin.userData.noDecal = true;
      boatGroup.add(cabin);
      this.collision.rayMeshes.push(cabin);

      const winMat = new THREE.MeshBasicMaterial({ color: 0xffba66 });
      const win = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.75, 0.15), winMat);
      win.position.set(0, 3.0, -0.38);
      boatGroup.add(win);

      // 驾驶舱雷达桅杆与红绿航行灯
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 2.6, 8), this.tex.metalFrame);
      mast.position.set(0, 4.9, -2.5);
      boatGroup.add(mast);

      const portBracket = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.14), this.tex.metalFrame);
      portBracket.position.set(-1.76, 3.68, -2.5);
      boatGroup.add(portBracket);
      const portLight = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
      portLight.position.set(-1.78, 3.78, -2.5);
      boatGroup.add(portLight);

      const stbdBracket = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.14), this.tex.metalFrame);
      stbdBracket.position.set(1.76, 3.68, -2.5);
      boatGroup.add(stbdBracket);
      const stbdLight = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshBasicMaterial({ color: 0x22ff77 }));
      stbdLight.position.set(1.78, 3.78, -2.5);
      boatGroup.add(stbdLight);

      // 登船跳板：连接东北栈桥 (x=24.2, y=0) 至 船甲板 (x=27.2, y=0.88)
      const gangplank = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.2, 2.6), this.tex.craneYellow);
      gangplank.position.set(25.7, 0.44, -24.0);
      gangplank.rotation.z = 0.247;
      this._addSolidMesh(gangplank, true, true);
      this.collision.addRamp(24.0, 27.4, -25.3, -22.7, 'x', 0.0, 0.88);

      // 船甲板可站立区域盒体 + 驾驶舱与桅杆碰撞体积
      this.collision.addBox(27.0, 31.8, -1.2, 0.8, -31.8, -19.2, true);
      this.collision.addBox(27.4, 31.0, 0.7, 3.05, -30.1, -25.9, true);
      this.collision.addAerialBox(28.9, 29.5, 3.0, 5.6, -28.3, -27.7);

      // 撤离信标全息发射底座（贴合甲板） + 解锁绿光信标柱
      const evacPad = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.22, 12), this.tex.metalFrame);
      evacPad.position.set(0, 1.71, 2.2);
      boatGroup.add(evacPad);

      const evacBeaconMat = new THREE.MeshBasicMaterial({ color: 0x26ff8f });
      const evacOrb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), evacBeaconMat);
      evacOrb.position.set(0, 2.15, 2.2);
      evacOrb.visible = false;
      boatGroup.add(evacOrb);

      const evacLight = this.render.createVirtualLight({
        color: 0x26ff8f,
        intensity: 0,
        distance: 28,
        decay: 1.5,
        x: 0,
        y: 2.8,
        z: 2.2,
        hostObject: boatGroup,
        priority: 5.5,
      });

      const evacBeam = this.render.createBeam(0x28ff93, 1.1, 2.6, 24, 0.28);
      evacBeam.position.set(0, 25.0, 2.2);
      evacBeam.visible = false;
      boatGroup.add(evacBeam);

      this.scene.add(boatGroup);
      this.animatedProps.push((t) => {
        // 船身随海浪轻柔起伏摇曳
        boatGroup.position.y = -0.8 + Math.sin(t * 1.4) * 0.1;
        boatGroup.rotation.z = Math.sin(t * 1.1) * 0.018;
      });

      this.extraction = {
        pos: new THREE.Vector3(28.5, 0.85, -24.0),
        orb: evacOrb,
        light: evacLight,
        beam: evacBeam,
        unlocked: false,
      };
    }

    _addBreakerBox(id, label, pos, onTrip, mountSpec = null, labelEn = '') {
      const g = new THREE.Group();
      g.position.copy(pos);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.56, 0.24), this.tex.metalFrame);
      box.castShadow = true;
      box.receiveShadow = true;
      g.add(box);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0x38d8ff });
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.26), ledMat);
      led.position.y = 0.14;
      g.add(led);

      if (mountSpec && mountSpec.type === 'wall') {
        const dz = mountSpec.dirZ || 1;
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.62, 0.04), this.tex.metalFrame);
        plate.position.set(0, 0, dz * 0.11);
        g.add(plate);
        const conduit = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.2, 6), this.tex.metalFrame);
        conduit.position.set(0, 1.38, dz * 0.105);
        g.add(conduit);
      } else if (mountSpec && mountSpec.type === 'pole') {
        const collar = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.44), this.tex.metalFrame);
        collar.position.set(0, 0, -0.18);
        g.add(collar);
      }

      this.scene.add(g);
      this.collision.rayMeshes.push(box);

      const resolvedEn = labelEn || (mountSpec && mountSpec.labelEn) || label;
      const breaker = {
        id,
        label,
        labelEn: resolvedEn,
        nameEn: resolvedEn,
        pos: pos.clone(),
        group: g,
        mesh: box,
        ledMat,
        light: null,
        tripped: false,
        onTrip,
      };
      box.userData = { isBreaker: true, breaker, noDecal: true };
      this.breakers.push(breaker);
      return breaker;
    }

    triggerBreaker(breaker) {
      if (!breaker || breaker.tripped) return false;
      breaker.tripped = true;
      breaker.ledMat.color.setHex(0x28323e);
      if (this.render) {
        this.render.spawnSparks(breaker.pos, new THREE.Vector3(0, 0, 1), 12, 1.3);
      }
      if (breaker.onTrip) breaker.onTrip(true);
      return true;
    }

    isPointInRelayASearchlight(pos) {
      const sl = this.aSearchlight;
      if (!sl || !sl.active || !sl.beam || !sl.beam.visible) return false;
      const dx = pos.x - sl.spotWorld.x;
      const dz = pos.z - sl.spotWorld.z;
      return (dx * dx + dz * dz) <= 22.0;
    }

    _buildRelays() {
      const specs = [
        { id: 'A', name: '中继器 A（西侧探照灯堆场）', nameEn: 'Relay A (West Searchlight Yard)', pos: new THREE.Vector3(-24.0, 0.0, 3.5) },
        { id: 'B', name: '中继器 B（铁皮仓库内部）', nameEn: 'Relay B (Sheet-Metal Warehouse)', pos: new THREE.Vector3(-15.5, 0.019, -25.5), aerialSkip: true },
        { id: 'C', name: '中继器 C（龙门吊高台控制）', nameEn: 'Relay C (Gantry Crane Deck)', pos: new THREE.Vector3(17.25, 2.5, 3.2) },
      ];

      for (const spec of specs) {
        const g = new THREE.Group();
        g.position.copy(spec.pos);

        const base = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 0.85), this.tex.metalFrame);
        base.position.y = 0.75;
        base.castShadow = true;
        base.receiveShadow = true;
        base.userData.noDecal = true;
        g.add(base);
        this.collision.rayMeshes.push(base);

        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 0.5, 0.08),
          new THREE.MeshBasicMaterial({ color: 0xffa62b })
        );
        panel.position.set(0, 1.05, 0.44);
        g.add(panel);

        // C4 炸药视觉挂载（选定强破爆破方式后显现闪烁）
        const c4Vis = this._createC4VisualGroup();
        g.add(c4Vis.c4Group);
        const c4Group = c4Vis.c4Group;
        const c4LedMat = c4Vis.c4LedMat;

        const dishPivot = new THREE.Group();
        dishPivot.position.set(0, 1.75, 0);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.6, 8), this.tex.metalFrame);
        dishPivot.add(mast);
        const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.08, 0.25, 12), this.tex.craneYellow);
        dish.rotation.x = 0.9;
        dish.position.set(0, 0.35, 0.1);
        dishPivot.add(dish);
        g.add(dishPivot);

        const light = this.render.createVirtualLight({
          color: 0xff9f24,
          intensity: 10,
          distance: 14,
          decay: 1.6,
          x: 0,
          y: 2.0,
          z: 0,
          hostObject: g,
          priority: 3.5,
        });

        this.scene.add(g);
        this.collision.addBox(
          spec.pos.x - 0.6, spec.pos.x + 0.6,
          spec.pos.y, spec.pos.y + 1.6,
          spec.pos.z - 0.5, spec.pos.z + 0.5,
          true,
          spec.aerialSkip ? { aerialSkip: true } : null
        );

        this.relays.push({
          id: spec.id,
          name: spec.name,
          nameEn: spec.nameEn,
          pos: spec.pos.clone().add(new THREE.Vector3(0, 1.3, 0)),
          group: g,
          panel,
          dishPivot,
          light,
          c4Group,
          c4LedMat,
          severed: false,
          method: null,
          disabledByMode: false,
        });
      }

      // 差异化场景机关 A：西侧堆场高架旋转探照灯 + 可射击/EMP/关闭的配电箱
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 5.4, 8), this.tex.metalFrame);
      tower.position.set(-19.5, 2.7, -2.5);
      this.scene.add(tower);
      this.collision.rayMeshes.push(tower);
      this.collision.addBox(-19.76, -19.24, 0, 5.7, -2.76, -2.24, true);
      const slPivot = new THREE.Group();
      slPivot.position.set(-19.5, 5.4, -2.5);
      const slLamp = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.5, 10), this.tex.metalFrame);
      slLamp.rotation.x = Math.PI * 0.5;
      slPivot.add(slLamp);
      const slBeam = this.render.createBeam(0xd9eeff, 0.28, 3.6, 15.0, 0.14);
      slBeam.rotation.x = Math.PI * 0.5;
      slBeam.position.z = 7.6;
      slPivot.add(slBeam);
      const slPoint = this.render.createVirtualLight({
        color: 0xd9eeff,
        intensity: 16,
        distance: 18,
        decay: 1.5,
        x: 0,
        y: -1.8,
        z: 6.2,
        hostObject: slPivot,
        priority: 7.5,
      });
      slPivot.rotation.x = 0.52;
      this.scene.add(slPivot);

      this.aSearchlight = {
        pivot: slPivot,
        beam: slBeam,
        point: slPoint,
        active: true,
        spotWorld: new THREE.Vector3(-23.0, 0, 3.5),
      };

      this._addBreakerBox(
        'breaker_A',
        'A区探照灯配电箱',
        new THREE.Vector3(-19.5, 1.4, -2.18),
        (tripped) => {
          if (!this.aSearchlight) return;
          this.aSearchlight.active = !tripped;
          this.aSearchlight.beam.visible = !tripped;
          this.aSearchlight.point.intensity = tripped ? 0 : 16;
        },
        { type: 'pole' },
        'Zone A Searchlight Breaker Box'
      );

      // 差异化场景机关 B：仓库南门内侧照明配电闸刀（紧贴南墙内壁 z=-14.175）
      this._addBreakerBox(
        'breaker_B',
        'B区仓库照明总闸',
        new THREE.Vector3(-6.0, 1.4, -14.295),
        (tripped) => {
          if (!this.warehouseLights) return;
          this.warehouseLights.disabled = tripped;
          const offByMode = this.activeMutators.includes('blackout');
          const on = !tripped && !offByMode;
          this.warehouseLights.whLight.intensity = on ? this.warehouseLights.baseIntensity : 0;
          this.warehouseLights.lampCone.visible = on;
          this.warehouseLights.doorSpill.visible = on;
          this.warehouseLights.bulbMat.color.setHex(on ? 0xffc670 : 0x262930);
        },
        { type: 'wall', dirZ: 1 },
        'Zone B Warehouse Main Breaker'
      );
    }

    _buildSupplyCrates() {
      const positions = [
        new THREE.Vector3(-6.2, 0.019, -24.5),
        new THREE.Vector3(11.5, 0.0, 7.5),
      ];
      for (const p of positions) {
        const g = new THREE.Group();
        g.position.copy(p);
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.6), this.tex.woodCrate);
        box.position.y = 0.275;
        g.add(box);
        const crossMat = new THREE.MeshBasicMaterial({ color: 0x3bf08c });
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.64), crossMat);
        strip.position.y = 0.4;
        g.add(strip);
        const light = this.render.createVirtualLight({
          color: 0x38e882,
          intensity: 5,
          distance: 7,
          decay: 1.8,
          y: 0.9,
          hostObject: g,
          priority: 1.0,
        });
        this.scene.add(g);
        this.supplyCrates.push({ pos: p.clone().add(new THREE.Vector3(0, 0.5, 0)), group: g, used: false });
      }

      // 4 处战术弹药补给箱（补充备弹与投掷物，支持冷却再生）
      const ammoPositions = [
        { name: '南侧码头弹药箱', nameEn: 'South Pier Ammo Crate', pos: new THREE.Vector3(-2.5, 0.0, 25.5) },
        { name: '西区高台前弹药箱', nameEn: 'West Platform Ammo Crate', pos: new THREE.Vector3(-19.5, 0.0, 13.5) },
        { name: '仓库内西南角弹药箱', nameEn: 'Warehouse SW Corner Ammo Crate', pos: new THREE.Vector3(-19.2, 0.019, -18.0) },
        { name: '东侧龙门区弹药箱', nameEn: 'East Gantry Zone Ammo Crate', pos: new THREE.Vector3(14.0, 0.0, -5.5) },
      ];
      for (const spec of ammoPositions) {
        const g = new THREE.Group();
        g.position.copy(spec.pos);
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.5, 0.65), this.tex.metalFrame);
        box.position.y = 0.25;
        box.castShadow = true;
        box.receiveShadow = true;
        g.add(box);
        const stripMat = new THREE.MeshBasicMaterial({ color: 0xffb838 });
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.69), stripMat);
        strip.position.y = 0.36;
        g.add(strip);
        const light = this.render.createVirtualLight({
          color: 0xffb838,
          intensity: 4.5,
          distance: 6.5,
          decay: 1.8,
          y: 0.85,
          hostObject: g,
          priority: 1.0,
        });
        this.scene.add(g);
        this.ammoCrates.push({
          name: spec.name,
          nameEn: spec.nameEn,
          pos: spec.pos.clone().add(new THREE.Vector3(0, 0.5, 0)),
          group: g,
          stripMat,
          light,
          cooldown: 0,
        });
      }
    }

    _buildPerimeterLights() {
      const poles = [
        [-4.0, 28.0, 0x7cb8ff],
        [-25.0, 18.0, 0xffaa4d],
        [14.0, -14.0, 0x7cb8ff],
      ];
      for (const [px, pz, col] of poles) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 7.5, 8), this.tex.metalFrame);
        pole.position.set(px, 3.75, pz);
        this.scene.add(pole);
        this.collision.rayMeshes.push(pole);
        this.collision.addBox(px - 0.24, px + 0.24, 0, 7.7, pz - 0.24, pz + 0.24, true);
        const headMat = new THREE.MeshBasicMaterial({ color: col });
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.25, 0.4), headMat);
        head.position.set(px, 7.5, pz);
        this.scene.add(head);
        const pl = this.render.createVirtualLight({
          color: col,
          intensity: 24,
          distance: 34,
          decay: 1.45,
          x: px,
          y: 7.1,
          z: pz,
          priority: 2.5,
        });
        this.perimeterLights.push({ headMat, light: pl, baseIntensity: 24, baseColor: col });
      }
    }

    _createC4VisualGroup() {
      const c4Group = new THREE.Group();
      c4Group.position.set(0.12, 1.02, 0.52);
      c4Group.visible = false;
      const c4Brick = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.08), this.tex.metalFrame);
      c4Group.add(c4Brick);
      const c4LedMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
      const c4Led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.09), c4LedMat);
      c4Led.position.set(0.05, 0.03, 0.01);
      c4Group.add(c4Led);
      return { c4Group, c4LedMat };
    }

    _buildTutorialProps() {
      // 1. 青色立体引导信标光柱（随教程步骤动态切换坐标，实战时隐藏）
      const beaconGroup = new THREE.Group();
      const beaconBeam = this.render.createBeam(0x48d5ff, 0.52, 1.35, 18, 0.3);
      beaconBeam.position.y = 18.0;
      beaconGroup.add(beaconBeam);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.95, 0.055, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0x48d5ff, transparent: true, opacity: 0.88 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.03;
      beaconGroup.add(ring);
      beaconGroup.visible = false;
      this.scene.add(beaconGroup);
      this.tutorialBeacon = { group: beaconGroup, ring };

      // 2. 西北仓库内演练医疗箱（-9.5, 0.019, -23.5，紧贴仓库水泥地面）
      const medPos = new THREE.Vector3(-9.5, 0.019, -23.5);
      const medGroup = new THREE.Group();
      medGroup.position.copy(medPos);
      const medBox = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.56, 0.62), this.tex.woodCrate);
      medBox.position.y = 0.28;
      medGroup.add(medBox);
      const medMat = new THREE.MeshBasicMaterial({ color: 0x48f5a8 });
      const strip1 = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.1, 0.65), medMat);
      strip1.position.y = 0.4;
      medGroup.add(strip1);
      const strip2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.44), medMat);
      strip2.position.y = 0.56;
      medGroup.add(strip2);
      const medLight = this.render.createVirtualLight({
        color: 0x48f5a8,
        intensity: 7,
        distance: 9,
        decay: 1.7,
        y: 0.95,
        hostObject: medGroup,
        priority: 1.2,
      });
      medGroup.visible = false;
      this.scene.add(medGroup);
      this.tutorialMedkit = {
        pos: medPos.clone().add(new THREE.Vector3(0, 0.5, 0)),
        group: medGroup,
        used: false,
      };

      // 3. 仓库南门外模拟通信中继器（-12.0, 0.0, -7.5，实战时隐藏）
      const simPos = new THREE.Vector3(-12.0, 0.0, -7.5);
      const simGroup = new THREE.Group();
      simGroup.position.copy(simPos);
      const simBase = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.45, 0.78), this.tex.metalFrame);
      simBase.position.y = 0.725;
      simGroup.add(simBase);
      const simPanelMat = new THREE.MeshBasicMaterial({ color: 0x48d5ff });
      const simPanel = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.44, 0.08), simPanelMat);
      simPanel.position.set(0, 1.02, 0.41);
      simGroup.add(simPanel);
      const simPanelBack = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.44, 0.08), simPanelMat);
      simPanelBack.position.set(0, 1.02, -0.41);
      simGroup.add(simPanelBack);
      const simPivot = new THREE.Group();
      simPivot.position.set(0, 1.68, 0);
      const simMast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.55, 8), this.tex.metalFrame);
      simPivot.add(simMast);
      const simDish = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.08, 0.22, 12),
        new THREE.MeshBasicMaterial({ color: 0x48d5ff })
      );
      simDish.rotation.x = 0.9;
      simDish.position.set(0, 0.32, 0.09);
      simPivot.add(simDish);
      simGroup.add(simPivot);
      const simLight = this.render.createVirtualLight({
        color: 0x48d5ff,
        intensity: 12,
        distance: 15,
        decay: 1.6,
        x: 0,
        y: 2.0,
        z: 0,
        hostObject: simGroup,
        priority: 3.5,
      });
      const simC4 = this._createC4VisualGroup();
      simGroup.add(simC4.c4Group);
      simGroup.visible = false;
      this.scene.add(simGroup);
      this.tutorialRelay = {
        id: 'SIM',
        name: '模拟通信中继器',
        nameEn: 'Simulated Comms Relay',
        pos: simPos.clone().add(new THREE.Vector3(0, 1.3, 0)),
        group: simGroup,
        panel: simPanel,
        dishPivot: simPivot,
        light: simLight,
        c4Group: simC4.c4Group,
        c4LedMat: simC4.c4LedMat,
        c4Planted: false,
        c4Timer: 0,
        severed: false,
      };

      // 4. 步骤 5 专属 EMP / 手雷演练补给箱（无限补充防丢空卡步，2.4, 0.0, 20.5）
      const cratePos = new THREE.Vector3(2.4, 0.0, 20.5);
      const crateGroup = new THREE.Group();
      crateGroup.position.copy(cratePos);
      const crateBody = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.56, 0.64), this.tex.metalFrame);
      crateBody.position.y = 0.28;
      crateGroup.add(crateBody);
      const crateStrip = new THREE.Mesh(
        new THREE.BoxGeometry(0.84, 0.1, 0.67),
        new THREE.MeshBasicMaterial({ color: 0x38d9ff })
      );
      crateStrip.position.y = 0.44;
      crateGroup.add(crateStrip);
      const crateLight = this.render.createVirtualLight({
        color: 0x38d9ff,
        intensity: 5.5,
        distance: 8,
        decay: 1.6,
        y: 0.9,
        hostObject: crateGroup,
        priority: 1.2,
      });
      crateGroup.visible = false;
      this.scene.add(crateGroup);
      this.tutorialAmmoCrate = {
        pos: cratePos.clone().add(new THREE.Vector3(0, 0.5, 0)),
        group: crateGroup,
      };
    }

    setTutorialGuide(active, step, enteredWarehouse = false) {
      if (!this.tutorialBeacon || !this.tutorialMedkit || !this.tutorialRelay) return;
      if (!active) {
        this.tutorialBeacon.group.visible = false;
        this.tutorialMedkit.group.visible = false;
        this.tutorialRelay.group.visible = false;
        if (this.tutorialAmmoCrate) this.tutorialAmmoCrate.group.visible = false;
        return;
      }

      // 步骤 5 显示 EMP 手雷补给箱；步骤 7 显示医疗箱；步骤 8 显示模拟中继器
      if (this.tutorialAmmoCrate) this.tutorialAmmoCrate.group.visible = (step === 5);
      this.tutorialMedkit.group.visible = (step === 7 && !this.tutorialMedkit.used);
      this.tutorialRelay.group.visible = (step === 8);

      if (step === 4) {
        this.tutorialBeacon.group.position.set(-3.5, 0.0, 13.0);
        this.tutorialBeacon.group.visible = true;
      } else if (step === 5) {
        this.tutorialBeacon.group.position.set(2.4, 0.0, 20.5);
        this.tutorialBeacon.group.visible = true;
      } else if (step === 6) {
        this.tutorialBeacon.group.position.set(-16.0, 2.6, 10.0);
        this.tutorialBeacon.group.visible = true;
      } else if (step === 7 && !this.tutorialMedkit.used) {
        if (!enteredWarehouse) {
          this.tutorialBeacon.group.position.set(-12.0, 0.0, -14.0);
        } else {
          this.tutorialBeacon.group.position.set(-9.5, 0.019, -23.5);
        }
        this.tutorialBeacon.group.visible = true;
      } else if (step === 8 && !this.tutorialRelay.severed) {
        this.tutorialBeacon.group.position.set(-12.0, 0.0, -7.5);
        this.tutorialBeacon.group.visible = true;
      } else {
        this.tutorialBeacon.group.visible = false;
      }
    }

    setRelaySeveredVisual(relay, method = 'hack') {
      if (!relay) return;
      relay.severed = true;
      relay.method = method;
      if (method === 'c4') {
        relay.panel.material.color.setHex(0x281414);
        relay.light.color.setHex(0xff5b2e);
        relay.light.intensity = 2.0;
        if (relay.c4Group) relay.c4Group.visible = false;
      } else {
        relay.panel.material.color.setHex(0x1f362a);
        relay.light.color.setHex(0x22cc66);
        relay.light.intensity = 3.5;
        if (relay.c4Group) relay.c4Group.visible = false;
      }
    }

    setRelayModeState(activeIds = null) {
      for (const r of this.relays) {
        r.method = null;
        if (r.c4Group) r.c4Group.visible = false;
        if (activeIds === null || activeIds.includes(r.id)) {
          r.disabledByMode = false;
          r.severed = false;
          r.panel.material.color.setHex(0xffa62b);
          r.light.color.setHex(0xff9f24);
          r.light.intensity = 10;
        } else {
          r.disabledByMode = true;
          r.severed = false;
          r.panel.material.color.setHex(0x222c38);
          r.light.color.setHex(0x3a4a5e);
          r.light.intensity = 0.6;
        }
      }
    }

    applyMutators(mutators = []) {
      this.activeMutators = Array.isArray(mutators) ? [...mutators] : [];
      const isBlackout = this.activeMutators.includes('blackout');
      const isExplosiveTide = this.activeMutators.includes('explosive_tide');

      for (const pl of this.perimeterLights) {
        pl.light.intensity = isBlackout ? 0 : pl.baseIntensity;
        pl.headMat.color.setHex(isBlackout ? 0x161c24 : pl.baseColor);
      }
      if (this.warehouseLights) {
        const on = !isBlackout && !this.warehouseLights.disabled;
        this.warehouseLights.whLight.intensity = on ? this.warehouseLights.baseIntensity : 0;
        this.warehouseLights.lampCone.visible = on;
        this.warehouseLights.doorSpill.visible = on;
        this.warehouseLights.bulbMat.color.setHex(on ? 0xffc670 : 0x262930);
      }
      for (const b of this.barrels) {
        if (!b.isExtraMutator) continue;
        if (isExplosiveTide) {
          b.hp = b.maxHp;
          b.state = 'intact';
          b.burnTimer = 0;
          b.chainTimer = -1;
          b.mesh.visible = true;
          b.mat.emissive.setHex(0x000000);
          b.mat.emissiveIntensity = 0;
          if (b.aabbBox) b.aabbBox.disabled = false;
        } else {
          b.state = 'exploded';
          b.mesh.visible = false;
          if (b.aabbBox) b.aabbBox.disabled = true;
        }
      }
    }

    refreshSuppliesAndBarrels() {
      for (const c of this.supplyCrates) {
        c.used = false;
        c.group.visible = true;
      }
      for (const ac of this.ammoCrates) {
        ac.cooldown = 0;
        ac.stripMat.color.setHex(0xffb838);
        ac.light.intensity = 4.5;
      }
      const isExplosiveTide = this.activeMutators.includes('explosive_tide');
      for (const b of this.barrels) {
        if (b.isExtraMutator && !isExplosiveTide) {
          b.state = 'exploded';
          b.mesh.visible = false;
          if (b.aabbBox) b.aabbBox.disabled = true;
          continue;
        }
        b.hp = b.maxHp;
        b.state = 'intact';
        b.burnTimer = 0;
        b.chainTimer = -1;
        b.mesh.visible = true;
        b.mat.emissive.setHex(0x000000);
        b.mat.emissiveIntensity = 0;
        if (b.aabbBox) b.aabbBox.disabled = false;
      }
      if (this.barrelFlashLight) {
        this.barrelFlashLight.intensity = 0;
        this._barrelFlashTimer = 0;
      }
    }

    resetWorldState(mutators = null) {
      if (mutators !== null) {
        this.activeMutators = Array.isArray(mutators) ? [...mutators] : [];
      }
      for (const br of this.breakers) {
        br.tripped = false;
        br.ledMat.color.setHex(0x38d8ff);
        if (br.onTrip) br.onTrip(false);
      }
      if (this.aSearchlight) {
        this.aSearchlight.active = true;
        this.aSearchlight.beam.visible = true;
        this.aSearchlight.point.intensity = 16;
      }
      this.setRelayModeState(null);
      this.refreshSuppliesAndBarrels();
      this.applyMutators(this.activeMutators);
      if (this.extraction) {
        this.extraction.unlocked = false;
        this.extraction.orb.visible = false;
        this.extraction.beam.visible = false;
        this.extraction.light.intensity = 0;
      }
      if (this.tutorialMedkit) {
        this.tutorialMedkit.used = false;
        this.tutorialMedkit.group.visible = false;
      }
      if (this.tutorialRelay) {
        this.tutorialRelay.severed = false;
        this.tutorialRelay.c4Planted = false;
        this.tutorialRelay.c4Timer = 0;
        if (this.tutorialRelay.c4Group) this.tutorialRelay.c4Group.visible = false;
        this.tutorialRelay.panel.material.color.setHex(0x48d5ff);
        this.tutorialRelay.light.color.setHex(0x48d5ff);
        this.tutorialRelay.light.intensity = 12;
        this.tutorialRelay.group.visible = false;
      }
      if (this.tutorialAmmoCrate) {
        this.tutorialAmmoCrate.group.visible = false;
      }
      if (this.tutorialBeacon) {
        this.tutorialBeacon.group.visible = false;
      }
      if (this.render && this.render.clearBulletDecals) {
        this.render.clearBulletDecals();
      }
    }

    unlockExtraction() {
      if (!this.extraction || this.extraction.unlocked) return;
      this.extraction.unlocked = true;
      this.extraction.orb.visible = true;
      this.extraction.beam.visible = true;
      this.extraction.light.intensity = 28;
    }

    update(dt, lockdownMode = false) {
      const t = this.render.time;
      for (let i = 0; i < this.animatedProps.length; i++) {
        this.animatedProps[i](t);
      }
      for (let i = 0; i < this.relays.length; i++) {
        const r = this.relays[i];
        if (!r.severed && !r.disabledByMode) {
          r.dishPivot.rotation.y += dt * 1.4;
          r.light.intensity = 8 + Math.sin(t * 5 + i) * 3;
        }
        if (r.c4Group && r.c4Group.visible && r.c4LedMat) {
          const blink = Math.sin(t * 16) > 0;
          r.c4LedMat.color.setHex(blink ? 0xff2b20 : 0x3a0c0a);
        }
      }
      if (this.aSearchlight && this.aSearchlight.active) {
        const yaw = -2.1 + Math.sin(t * 0.65) * 0.65;
        this.aSearchlight.pivot.rotation.y = yaw;
        const reach = 7.2;
        this.aSearchlight.spotWorld.set(
          this.aSearchlight.pivot.position.x + Math.sin(yaw) * reach,
          0,
          this.aSearchlight.pivot.position.z + Math.cos(yaw) * reach
        );
      }
      for (let i = 0; i < this.ammoCrates.length; i++) {
        const ac = this.ammoCrates[i];
        if (ac.cooldown > 0) {
          ac.cooldown = Math.max(0, ac.cooldown - dt);
          if (ac.cooldown === 0) {
            ac.stripMat.color.setHex(0xffb838);
            ac.light.intensity = 4.5;
          }
        }
      }
      if (this.tutorialRelay && this.tutorialRelay.group.visible && !this.tutorialRelay.severed) {
        this.tutorialRelay.dishPivot.rotation.y += dt * 1.6;
        this.tutorialRelay.light.intensity = 10 + Math.sin(t * 5.2) * 3;
        if (this.tutorialRelay.c4Group && this.tutorialRelay.c4Group.visible && this.tutorialRelay.c4LedMat) {
          this.tutorialRelay.c4LedMat.color.setHex(Math.sin(t * 16) > 0 ? 0xff2b20 : 0x3a0c0a);
        }
      }
      if (this.tutorialBeacon && this.tutorialBeacon.group.visible) {
        const s = 0.92 + Math.sin(t * 4.2) * 0.14;
        this.tutorialBeacon.ring.scale.set(s, s, 1);
      }
      for (let i = 0; i < this.alarmLights.length; i++) {
        const al = this.alarmLights[i];
        const freq = lockdownMode ? 9.5 : 2.6;
        const pulse = 0.25 + 0.75 * Math.max(0, Math.sin(t * freq + i));
        al.light.intensity = al.baseIntensity * (lockdownMode ? 2.2 : 1.0) * pulse;
      }
      if (this.extraction && this.extraction.unlocked) {
        this.extraction.light.intensity = 22 + Math.sin(t * 6) * 8;
      }

      // 危险油桶燃烧预警与连锁引爆倒计时
      if (this._barrelFlashTimer > 0) {
        this._barrelFlashTimer -= dt;
        if (this.barrelFlashLight) {
          this.barrelFlashLight.intensity = Math.max(0, (this._barrelFlashTimer / 0.28) * 42);
        }
      }
      for (let i = 0; i < this.barrels.length; i++) {
        const b = this.barrels[i];
        if (b.state === 'burning') {
          const pulse = 0.7 + 0.6 * Math.sin(t * 28);
          b.mat.emissive.setHex(0xff4d14);
          b.mat.emissiveIntensity = pulse;
          if (this.barrelFlashLight && this._barrelFlashTimer <= 0) {
            this.barrelFlashLight.position.set(b.pos.x, b.pos.y + 0.7, b.pos.z);
            this.barrelFlashLight.intensity = 8 + pulse * 6;
          }
          if (Math.random() < dt * 18) {
            _tmpVecA.set(b.pos.x, b.pos.y + 0.55, b.pos.z);
            this.render.spawnSparks(_tmpVecA, _tmpUp, 2, 0.7);
            _tmpVecA.y = b.pos.y + 0.65;
            this.render.spawnSmoke(_tmpVecA, 1, 0.38, 1.1, 0xff9a52);
          }
          b.burnTimer -= dt;
          if (b.burnTimer <= 0 && this.onBarrelExplode) {
            this.onBarrelExplode(b);
          }
        } else if (b.state === 'chaining') {
          b.mat.emissive.setHex(0xff5511);
          b.mat.emissiveIntensity = 1.4;
          b.chainTimer -= dt;
          if (b.chainTimer <= 0 && this.onBarrelExplode) {
            this.onBarrelExplode(b);
          }
        }
      }
    }

    _buildExtremeLevelDetails() {
      if (typeof ExtremeGfx === 'undefined' || !ExtremeGfx.mergeGeometriesSafe) return;
      const tx = ExtremeGfx.createTransformedGeo;
      const merge = ExtremeGfx.mergeGeometriesSafe;
      const frameMat = this.tex.metalFrame;
      const darkSteelMat = new THREE.MeshPhysicalMaterial({ color: 0x262d36, metalness: 0.88, roughness: 0.34 });
      const amberLedMat = new THREE.MeshBasicMaterial({ color: 0xffa030 });
      const grp = this.extremeDetailGroup;
      const dummy = new THREE.Object3D();

      // 1. 集装箱 ISO 角件与双门锁杆（InstancedMesh 零冗余 Draw Call）
      const corners = [];
      const lockRods = [];
      for (const c of this._containerSpecs) {
        const hw = c.w * 0.5 - 0.11;
        const hd = c.d * 0.5 - 0.11;
        const cosR = Math.cos(c.rotY || 0);
        const sinR = Math.sin(c.rotY || 0);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            for (const sy of [0.11, c.h - 0.11]) {
              const lx = sx * hw;
              const lz = sz * hd;
              corners.push({
                x: c.x + lx * cosR - lz * sinR,
                y: c.y + sy,
                z: c.z + lx * sinR + lz * cosR,
                ry: c.rotY || 0,
              });
            }
          }
        }
        // 长边端门双锁杆
        const endSign = c.w >= c.d;
        for (const offset of [-0.38, 0.38]) {
          const lx = endSign ? hw + 0.14 : offset;
          const lz = endSign ? offset : hd + 0.14;
          lockRods.push({
            x: c.x + lx * cosR - lz * sinR,
            y: c.y + c.h * 0.5,
            z: c.z + lx * sinR + lz * cosR,
            h: c.h - 0.24,
            ry: c.rotY || 0,
          });
        }
      }
      if (corners.length > 0) {
        const cornerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), darkSteelMat, corners.length);
        cornerMesh.castShadow = true;
        cornerMesh.receiveShadow = true;
        corners.forEach((p, idx) => {
          dummy.position.set(p.x, p.y, p.z);
          dummy.rotation.set(0, p.ry, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          cornerMesh.setMatrixAt(idx, dummy.matrix);
        });
        cornerMesh.instanceMatrix.needsUpdate = true;
        grp.add(cornerMesh);
      }
      if (lockRods.length > 0) {
        const rodMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.032, 0.032, 1, 8), darkSteelMat, lockRods.length);
        rodMesh.castShadow = false;
        lockRods.forEach((p, idx) => {
          dummy.position.set(p.x, p.y, p.z);
          dummy.rotation.set(0, p.ry, 0);
          dummy.scale.set(1, p.h, 1);
          dummy.updateMatrix();
          rodMesh.setMatrixAt(idx, dummy.matrix);
        });
        rodMesh.instanceMatrix.needsUpdate = true;
        grp.add(rodMesh);
      }

      // 2. 码头系缆桩 (Bollards) 与防撞护缘反光警示灯珠（按所在护缘/栈桥高度精准落地）
      const bollardSpecs = [
        [22.3, 0.39, 24], [22.3, 0.39, 12], [22.3, 0.39, 0], [22.3, 0.39, -12],
        [25.6, 0.0, -18], [25.6, 0.0, -32],
        [8, 0.39, -34.6], [-4, 0.39, -34.6], [-18, 0.39, -34.6], [-30, 0.39, -34.6],
      ];
      const bollardBaseGeo = merge([
        tx(new THREE.CylinderGeometry(0.18, 0.22, 0.48, 12), { y: 0.24 }),
        tx(new THREE.CylinderGeometry(0.24, 0.19, 0.11, 12), { y: 0.52 }),
        tx(new THREE.BoxGeometry(0.54, 0.08, 0.14), { y: 0.42 }),
      ]);
      if (bollardBaseGeo) {
        const bollards = new THREE.InstancedMesh(bollardBaseGeo, darkSteelMat, bollardSpecs.length);
        bollards.castShadow = true;
        bollards.receiveShadow = true;
        bollardSpecs.forEach(([bx, by, bz], i) => {
          dummy.position.set(bx, by, bz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          bollards.setMatrixAt(i, dummy.matrix);
        });
        bollards.instanceMatrix.needsUpdate = true;
        grp.add(bollards);
      }

      const reflectorSpecs = [];
      for (let z = -12; z <= 28; z += 5) reflectorSpecs.push([22.1, 0.43, z]);
      for (let z = -32; z <= -17; z += 5) reflectorSpecs.push([25.8, 0.03, z]);
      for (let x = -38; x <= 20; x += 6) reflectorSpecs.push([x, 0.43, -34.3]);
      const reflMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.08, 0.16), amberLedMat, reflectorSpecs.length);
      reflectorSpecs.forEach(([rx, ry, rz], i) => {
        dummy.position.set(rx, ry, rz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        reflMesh.setMatrixAt(i, dummy.matrix);
      });
      reflMesh.instanceMatrix.needsUpdate = true;
      grp.add(reflMesh);

      // 3. 仓库内部屋顶人字钢桁架 + 工业卷帘门箱 + 排水地漏篦子 + 龙门吊斜拉 K 撑
      const steelGeos = [];
      // 仓库钢屋架
      for (const tz of [-28, -23, -18]) {
        steelGeos.push(tx(new THREE.BoxGeometry(19.65, 0.22, 0.24), { x: -12, y: 6.28, z: tz }));
        steelGeos.push(tx(new THREE.BoxGeometry(10.0, 0.18, 0.2), { x: -17, y: 6.96, z: tz, rz: 0.14 }));
        steelGeos.push(tx(new THREE.BoxGeometry(10.0, 0.18, 0.2), { x: -7, y: 6.96, z: tz, rz: -0.14 }));
        steelGeos.push(tx(new THREE.BoxGeometry(0.18, 1.35, 0.18), { x: -12, y: 6.95, z: tz }));
      }
      // 卷帘门盒与防雨导轨
      steelGeos.push(tx(new THREE.BoxGeometry(6.3, 0.45, 0.55), { x: -12, y: 4.35, z: -13.9 }));
      steelGeos.push(tx(new THREE.BoxGeometry(0.55, 0.45, 6.3), { x: -1.9, y: 4.35, z: -23 }));
      // 仓库内墙电力线管桥架（紧贴北墙 -31.825 与西墙 -21.825）
      steelGeos.push(tx(new THREE.BoxGeometry(19.6, 0.12, 0.16), { x: -12, y: 3.6, z: -31.745 }));
      steelGeos.push(tx(new THREE.BoxGeometry(0.16, 0.12, 17.6), { x: -21.745, y: 3.6, z: -23 }));

      // 龙门吊斜拉钢梁与平台护栏支柱
      for (const gz of [-2.5, 12.5]) {
        steelGeos.push(tx(new THREE.BoxGeometry(11.6, 0.34, 0.34), { x: 15.2, y: 12.6, z: gz, rz: 0.48 }));
        steelGeos.push(tx(new THREE.BoxGeometry(11.6, 0.34, 0.34), { x: 15.2, y: 12.6, z: gz, rz: -0.48 }));
      }
      for (const gx of [10.2, 20.2]) {
        steelGeos.push(tx(new THREE.BoxGeometry(0.32, 0.32, 16.0), { x: gx, y: 11.2, z: 5.0 }));
        steelGeos.push(tx(new THREE.BoxGeometry(0.28, 0.28, 16.8), { x: gx, y: 12.6, z: 5.0, rx: 0.42 }));
        steelGeos.push(tx(new THREE.BoxGeometry(0.28, 0.28, 16.8), { x: gx, y: 12.6, z: 5.0, rx: -0.42 }));
      }
      for (let sx = 14.8; sx <= 19.6; sx += 1.2) {
        steelGeos.push(tx(new THREE.BoxGeometry(0.08, 0.95, 0.08), { x: sx, y: 2.98, z: 0.58 }));
      }

      // 地面暴雨排水铁篦子
      for (const [dx, dz] of [[-10, 4], [2, -6], [-20, 10], [8, 16]]) {
        steelGeos.push(tx(new THREE.BoxGeometry(1.1, 0.02, 0.72), { x: dx, y: 0.012, z: dz }));
      }

      const steelMerged = merge(steelGeos);
      if (steelMerged) {
        const steelMesh = new THREE.Mesh(steelMerged, frameMat);
        steelMesh.castShadow = true;
        steelMesh.receiveShadow = true;
        grp.add(steelMesh);
      }

      // 4. 码头与船只悬垂系泊缆绳 (TubeGeometry)
      const ropePoints = [
        [new THREE.Vector3(25.6, 0.42, -18.0), new THREE.Vector3(26.5, 0.22, -19.5), new THREE.Vector3(27.2, 0.85, -20.5)],
        [new THREE.Vector3(25.6, 0.42, -32.0), new THREE.Vector3(26.5, 0.22, -30.5), new THREE.Vector3(27.2, 0.85, -29.8)],
      ];
      for (const pts of ropePoints) {
        const curve = new THREE.QuadraticBezierCurve3(pts[0], pts[1], pts[2]);
        const rope = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.045, 6, false), darkSteelMat);
        rope.castShadow = false;
        grp.add(rope);
      }

      // 5. 撤离船只高精度栏杆、双弦外挂机与旋转航海雷达
      if (this._boatGroup) {
        const boatExt = new THREE.Group();
        boatExt.visible = false;
        const bGeos = [];
        for (const bx of [-2.45, 2.45]) {
          bGeos.push(tx(new THREE.CylinderGeometry(0.035, 0.035, 12.6, 8), { x: bx, y: 2.1, z: 0, rx: Math.PI / 2 }));
          for (let bz = -6.0; bz <= 6.0; bz += 2.0) {
            bGeos.push(tx(new THREE.CylinderGeometry(0.03, 0.03, 0.65, 6), { x: bx, y: 1.78, z: bz }));
          }
        }
        // 双缸舷外推进器
        for (const ox of [-1.1, 1.1]) {
          bGeos.push(tx(new THREE.BoxGeometry(0.65, 1.15, 0.85), { x: ox, y: 1.15, z: 7.05 }));
        }
        const bMerged = merge(bGeos);
        if (bMerged) {
          const bMesh = new THREE.Mesh(bMerged, darkSteelMat);
          bMesh.castShadow = true;
          boatExt.add(bMesh);
        }
        const radarBar = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.14, 0.22), frameMat);
        radarBar.position.set(0, 6.22, -2.5);
        boatExt.add(radarBar);
        this.animatedProps.push((t) => {
          radarBar.rotation.y = t * 2.2;
        });

        this._boatGroup.add(boatExt);
        this._boatExtGroup = boatExt;
      }
    }

    setExtremeDetail(enabled) {
      const next = !!enabled;
      if (this.collision && this.collision.setExtremeAerialEnabled) {
        this.collision.setExtremeAerialEnabled(next);
      }
      if (this.extremeDetailGroup) {
        this.extremeDetailGroup.visible = next;
        if (next && this.render && this.render.syncNewObjectForExtreme) {
          this.render.syncNewObjectForExtreme(this.extremeDetailGroup);
        }
      }
      if (this._boatExtGroup) {
        this._boatExtGroup.visible = next;
        if (next && this.render && this.render.syncNewObjectForExtreme) {
          this.render.syncNewObjectForExtreme(this._boatExtGroup);
        }
      }
    }
  }

  return { CollisionWorld, Builder };
})();
