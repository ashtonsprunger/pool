import * as THREE from 'three';
import { AimPreview, CheatPreview, GameState, hasModifier } from '../game/rules';
import {
  BALL_COLORS,
  BALL_RADIUS,
  CORNER_JAW_OFFSET,
  CUSHION_HEIGHT,
  CUSHION_THICKNESS,
  DIAMOND_OFFSET,
  FOOT_SPOT,
  GRAVITY,
  HEAD_SPOT,
  HEAD_STRING_X,
  POCKETS,
  RAIL_BORDER,
  SIDE_JAW_HALF_WIDTH,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from '../physics/constants';
import {
  CueStrikeParams,
  INFINITE_POCKETS,
  INFINITE_SIDE_PORTALS,
} from '../physics/engine';
import { clamp } from '../physics/vector';
import { RenderInputState } from './renderer';
import {
  createBallTextures,
  createClothTexture,
  createPoolHallEnvironment,
  createSoftShadowTexture,
  createWoodRailTexture,
} from './textures3d';

export type CameraViewMode = 'cue' | 'broadcast' | 'overhead' | '2d';

export interface PocketLike {
  id: number;
  x: number;
  y: number;
  radius: number;
  renderRadius: number;
  type: 'corner' | 'side';
  renderX?: number;
  renderY?: number;
}

export interface PocketDropState {
  ballId: number;
  pocketId: number;
  x: number;
  y: number; // Canonical table Y (worldZ = y - 25)
  height: number; // World Y height (slate = 0, resting on slate = BALL_RADIUS)
  vx: number;
  vy: number;
  vHeight: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  settled: boolean;
  age: number;
  slotIndex: number;
}

export function txToWorldX(tx: number): number {
  return tx - TABLE_LENGTH * 0.5;
}

export function tyToWorldZ(ty: number): number {
  return ty - TABLE_WIDTH * 0.5;
}

export function worldXToTx(wx: number): number {
  return wx + TABLE_LENGTH * 0.5;
}

export function worldZToTy(wz: number): number {
  return wz + TABLE_WIDTH * 0.5;
}

export function engineQuatToThreeQuat(
  qx: number,
  qy: number,
  qz: number,
  qw: number
): [number, number, number, number] {
  return [-qx, -qz, -qy, qw];
}

function pocketRenderX(pk: PocketLike): number {
  return pk.renderX ?? pk.x;
}

function pocketRenderY(pk: PocketLike): number {
  return pk.renderY ?? pk.y;
}

/**
 * Advances a pocketed ball's 3D gravity drop, cylindrical pocket-liner rim bounce,
 * and dampened leather basket floor impact over stepDt seconds.
 */
export function stepPocketDropPhysics(
  drop: PocketDropState,
  pk: PocketLike,
  stepDt: number
): void {
  drop.age += stepDt;
  if (drop.settled) return;

  const cx = pocketRenderX(pk);
  const cy = pocketRenderY(pk);
  const maxWallR = Math.max(0.55, pk.renderRadius - BALL_RADIUS * 0.92);

  // Integrate 3D gravity & position
  drop.vHeight -= GRAVITY * stepDt;
  drop.x += drop.vx * stepDt;
  drop.y += drop.vy * stepDt;
  drop.height += drop.vHeight * stepDt;

  // Reflect/damp against cylindrical rubber/leather pocket liner wall
  const dx = drop.x - cx;
  const dy = drop.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > maxWallR && dist > 1e-4) {
    const nx = dx / dist;
    const ny = dy / dist;
    drop.x = cx + nx * maxWallR;
    drop.y = cy + ny * maxWallR;
    const vn = drop.vx * nx + drop.vy * ny;
    if (vn > 0) {
      drop.vx -= 1.38 * vn * nx;
      drop.vy -= 1.38 * vn * ny;
      drop.vx *= 0.68;
      drop.vy *= 0.68;
    }
  }

  // Visual tumble spin while dropping into pocket
  const horizSpd = Math.hypot(drop.vx, drop.vy);
  if (horizSpd > 0.5 || Math.abs(drop.vHeight) > 2) {
    const spinStep = stepDt * 6.0;
    const dqW = Math.cos(spinStep * 0.5);
    const dqX = Math.sin(spinStep * 0.5);
    const nx = dqW * drop.qx + dqX * drop.qw;
    const nw = dqW * drop.qw - dqX * drop.qx;
    const nLen = Math.hypot(nx, drop.qy, drop.qz, nw) || 1;
    drop.qx = nx / nLen;
    drop.qw = nw / nLen;
  }

  // Leather pocket basket floor collision
  const floorH = -3.08 + Math.min(2, Math.floor(drop.slotIndex / 2)) * 0.72;
  if (drop.height <= floorH) {
    drop.height = floorH;
    if (drop.vHeight < -18) {
      drop.vHeight = -drop.vHeight * 0.24;
      drop.vx *= 0.52;
      drop.vy *= 0.52;
    } else {
      drop.vHeight = 0;
      drop.vx *= 0.75;
      drop.vy *= 0.75;
      if (Math.hypot(drop.vx, drop.vy) < 1.2) {
        drop.vx = 0;
        drop.vy = 0;
        drop.settled = true;
      }
    }
  }
}

export class Pool3DRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private envMap: THREE.Texture;

  // Dimensions & orientation
  private widthCss = 800;
  private heightCss = 450;
  private isPortrait = false;

  // Camera state
  private cameraMode: CameraViewMode = 'cue';
  private camPos = new THREE.Vector3(-48, 28, 0);
  private camTarget = new THREE.Vector3(10, 1.2, 0);
  private camUp = new THREE.Vector3(0, 1, 0);
  private camFov = 44;
  private camInitialized = false;

  // User adjustable camera offsets (pinch zoom / 2-finger tilt / orbit)
  private cueCamPitch = 0.43; // ~24.6 deg
  private cueCamZoom = 1.0;
  private broadcastOrbitOffset = 0;
  private broadcastPitchOffset = 0;
  private broadcastZoom = 1.0;

  // Shot camera hold & strike animation
  private shotReleaseElapsed = 999;
  private strikeAnimActive = false;
  private strikeAnimElapsed = 0;
  private strikeStartPull = 0;
  private strikeAngle = 0;
  private strikeCueX = 25;
  private strikeCueY = 25;
  private strikeSpinX = 0;
  private strikeSpinY = 0;

  // Groups for standard vs Infinite table & modifier visuals
  private standardTableGroup = new THREE.Group();
  private infiniteTableGroup = new THREE.Group();
  private portalsDecorGroup = new THREE.Group();
  private pinballDecorGroup = new THREE.Group();
  private blackHoleDecorGroup = new THREE.Group();
  private infinitePortalsGroup = new THREE.Group();
  private infiniteBlackHoleGroup = new THREE.Group();
  private kitchenZoneMesh!: THREE.Mesh;
  private headStringLine!: THREE.Line;

  // Cloth materials for Frictionless swap
  private classicClothMat!: THREE.MeshStandardMaterial;
  private iceClothMat!: THREE.MeshStandardMaterial;
  private slateBedMesh!: THREE.Mesh;
  private infiniteCenterBedMesh!: THREE.Mesh;
  private cushionMeshes: THREE.Mesh[] = [];
  private classicCushionMat!: THREE.MeshStandardMaterial;
  private iceCushionMat!: THREE.MeshStandardMaterial;

  // Ball meshes & contact shadows (0..15)
  private ballMeshes: THREE.Mesh[] = [];
  private ballMaterials: THREE.MeshPhysicalMaterial[] = [];
  private ballShadows: THREE.Mesh[] = [];
  private ballAmbientShadows: THREE.Mesh[] = [];

  // Infinite mode neighbor / seam-wrap ghost pool
  private infiniteBallPool: THREE.Mesh[] = [];
  private infiniteBallMats: THREE.MeshStandardMaterial[] = [];

  // Cheat & Aim preview 3D objects
  private aimGroup = new THREE.Group();
  private normalAimLine!: THREE.LineSegments;
  private normalAimGeo!: THREE.BufferGeometry;
  private normalAimPositions = new Float32Array(18 * 3);
  private normalAimColors = new Float32Array(18 * 3);
  private ghostBallMesh!: THREE.Mesh;
  private ghostBallRing!: THREE.Mesh;

  private cheatLinesMesh!: THREE.LineSegments;
  private cheatLinesGeo!: THREE.BufferGeometry;
  private cheatLinePositions = new Float32Array(6000 * 3);
  private cheatLineColors = new Float32Array(6000 * 3);
  private cheatGhostMeshes: THREE.Mesh[] = [];
  private cheatGhostRings: THREE.Mesh[] = [];

  // Ball-in-hand halo
  private bihHaloGroup = new THREE.Group();
  private bihRingMesh!: THREE.Mesh;
  private bihDiscMesh!: THREE.Mesh;

  // 3D Cue Stick
  private cuePivot = new THREE.Group();
  private cueStickMeshGroup = new THREE.Group();

  // Pocket drop tracking
  private dropStates = new Map<number, PocketDropState>();
  private lastKnownBalls = new Map<
    number,
    { x: number; y: number; vx: number; vy: number; pocketed: boolean }
  >();
  private lastRackSeed = -1;
  private animClock = 0;

  // Reusable math temporaries (zero per-frame GC allocations)
  private tmpRaycaster = new THREE.Raycaster();
  private tmpNdc = new THREE.Vector2();
  private tmpPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BALL_RADIUS);
  private tmpHit = new THREE.Vector3();
  private tmpDesiredPos = new THREE.Vector3();
  private tmpDesiredTarget = new THREE.Vector3();
  private tmpDesiredUp = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    // Cap pixel ratio at 2.0 so flagship 3x-4x mobile OLED screens run at locked 60-120fps
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = false; // Contact decals replace heavy shadow maps on mobile

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#090d12');
    this.scene.fog = new THREE.FogExp2('#090d12', 0.0024);

    this.camera = new THREE.PerspectiveCamera(44, 16 / 9, 1.2, 520);

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.envMap = createPoolHallEnvironment(this.renderer);
    this.scene.environment = this.envMap;

    this.setupLighting();
    this.buildStandardTable(maxAniso);
    this.buildInfiniteTable(maxAniso);
    this.buildBallsAndShadows(maxAniso);
    this.buildCueStick();
    this.buildAimAndPreviewHelpers();
  }

  public setCameraMode(mode: CameraViewMode): void {
    this.cameraMode = mode;
  }

  public getCameraMode(): CameraViewMode {
    return this.cameraMode;
  }

  public adjustCameraGesture(deltaAzimuthRad: number, deltaPitchRad: number, zoomScale: number): void {
    if (this.cameraMode === 'cue') {
      this.cueCamPitch = clamp(this.cueCamPitch + deltaPitchRad, 0.20, 1.02);
      this.cueCamZoom = clamp(this.cueCamZoom * zoomScale, 0.68, 1.55);
    } else if (this.cameraMode === 'broadcast') {
      this.broadcastOrbitOffset += deltaAzimuthRad;
      this.broadcastPitchOffset = clamp(this.broadcastPitchOffset + deltaPitchRad, -0.35, 0.42);
      this.broadcastZoom = clamp(this.broadcastZoom * zoomScale, 0.65, 1.45);
    }
  }

  public resize(widthCss: number, heightCss: number): void {
    this.widthCss = Math.max(200, widthCss);
    this.heightCss = Math.max(200, heightCss);
    this.isPortrait = this.heightCss > this.widthCss * 1.06;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.widthCss, this.heightCss, true);
    this.camera.aspect = this.widthCss / this.heightCss;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Triggers the crisp forward cue-stick strike animation and holds the behind-cue camera
   * briefly through impact before gliding up to follow the shot.
   */
  public notifyShotFired(cueX: number, cueY: number, strike: CueStrikeParams): void {
    this.shotReleaseElapsed = 0;
    this.strikeAnimActive = true;
    this.strikeAnimElapsed = 0;
    this.strikeStartPull = clamp(strike.power, 0.08, 1.0);
    this.strikeAngle = strike.angle;
    this.strikeCueX = cueX;
    this.strikeCueY = cueY;
    this.strikeSpinX = strike.spinX;
    this.strikeSpinY = strike.spinY;
  }

  /**
   * Raycasts a screen CSS coordinate (relative to canvas top-left) onto the 3D ball-center plane
   * and returns exact canonical table coordinates (tx in 0..100, ty in 0..50).
   */
  public screenToTable(sx: number, sy: number): { x: number; y: number } | null {
    this.tmpNdc.x = (sx / Math.max(1, this.widthCss)) * 2 - 1;
    this.tmpNdc.y = -(sy / Math.max(1, this.heightCss)) * 2 + 1;
    this.tmpRaycaster.setFromCamera(this.tmpNdc, this.camera);

    const hit = this.tmpRaycaster.ray.intersectPlane(this.tmpPlane, this.tmpHit);
    if (!hit) return null;
    return {
      x: worldXToTx(hit.x),
      y: worldZToTy(hit.z),
    };
  }

  /**
   * Projects a canonical table coordinate (tx, ty) to canvas CSS pixel coordinates.
   */
  public tableToScreen(tx: number, ty: number, height: number = BALL_RADIUS): { x: number; y: number } {
    this.tmpHit.set(txToWorldX(tx), height, tyToWorldZ(ty));
    this.tmpHit.project(this.camera);
    return {
      x: (this.tmpHit.x * 0.5 + 0.5) * this.widthCss,
      y: (-this.tmpHit.y * 0.5 + 0.5) * this.heightCss,
    };
  }

  /**
   * Returns true if any pocketed ball is still actively falling/rattling down into a pocket well.
   */
  public hasActivePocketDrops(): boolean {
    for (const drop of this.dropStates.values()) {
      if (!drop.settled && drop.age < 0.65) return true;
    }
    return false;
  }

  private setupLighting(): void {
    // Soft ambient pool-hall fill
    const hemi = new THREE.HemisphereLight('#fff8eb', '#0b2219', 0.72);
    this.scene.add(hemi);

    // Overhead warm pool-table lamp canopy light (centered above slate)
    const keyLight = new THREE.SpotLight('#fff6e5', 2.45, 220, Math.PI * 0.44, 0.58, 0.85);
    keyLight.position.set(0, 64, 0);
    keyLight.target.position.set(0, 0, 0);
    this.scene.add(keyLight);
    this.scene.add(keyLight.target);

    // Subtle secondary rim lights at head & foot ends so rails gleam nicely from low angles
    const headFill = new THREE.PointLight('#e0f2fe', 0.55, 150, 1.1);
    headFill.position.set(-54, 34, -20);
    this.scene.add(headFill);

    const footFill = new THREE.PointLight('#fef3c7', 0.5, 150, 1.1);
    footFill.position.set(54, 34, 20);
    this.scene.add(footFill);

    // Subtle dark billiard room floor beneath the table legs
    const floorGeo = new THREE.PlaneGeometry(360, 360);
    const floorMat = new THREE.MeshStandardMaterial({
      color: '#0b0f14',
      roughness: 0.88,
      metalness: 0.05,
      envMapIntensity: 0.15,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -28;
    this.scene.add(floor);
  }

  private buildStandardTable(maxAniso: number): void {
    const classicClothTex = createClothTexture('classic', maxAniso);
    const iceClothTex = createClothTexture('ice', maxAniso);
    const woodTex = createWoodRailTexture(maxAniso);

    this.classicClothMat = new THREE.MeshStandardMaterial({
      map: classicClothTex,
      color: '#ffffff',
      roughness: 0.86,
      metalness: 0.0,
      envMapIntensity: 0.12,
    });

    this.iceClothMat = new THREE.MeshStandardMaterial({
      map: iceClothTex,
      color: '#ccf2ff',
      roughness: 0.24,
      metalness: 0.08,
      envMapIntensity: 0.65,
    });

    this.classicCushionMat = new THREE.MeshStandardMaterial({
      map: classicClothTex,
      color: '#0d8a56',
      roughness: 0.78,
      metalness: 0.0,
      envMapIntensity: 0.16,
    });

    this.iceCushionMat = new THREE.MeshStandardMaterial({
      map: iceClothTex,
      color: '#7dd3fc',
      roughness: 0.28,
      metalness: 0.1,
      envMapIntensity: 0.55,
    });

    // 1. Slate Bed with 6 real circular pocket holes punched right through the mesh!
    const ct = CUSHION_THICKNESS; // 2.0
    const hw = TABLE_LENGTH * 0.5 + ct + 0.35;
    const hh = TABLE_WIDTH * 0.5 + ct + 0.35;

    const bedShape = new THREE.Shape();
    bedShape.moveTo(-hw, -hh);
    bedShape.lineTo(hw, -hh);
    bedShape.lineTo(hw, hh);
    bedShape.lineTo(-hw, hh);
    bedShape.closePath();

    for (const pk of POCKETS) {
      const hx = txToWorldX(pk.renderX);
      const hy = -tyToWorldZ(pk.renderY);
      const hole = new THREE.Path();
      hole.absarc(hx, hy, pk.renderRadius, 0, Math.PI * 2, true);
      bedShape.holes.push(hole);
    }

    const bedGeo = new THREE.ExtrudeGeometry(bedShape, {
      depth: 0.75,
      bevelEnabled: false,
      curveSegments: 28,
    });
    const uvAttr = bedGeo.attributes.uv;
    for (let i = 0; i < uvAttr.count; i++) {
      uvAttr.setXY(i, uvAttr.getX(i) / 100, uvAttr.getY(i) / 50);
    }
    bedGeo.rotateX(-Math.PI / 2);
    bedGeo.translate(0, -0.75, 0);

    this.slateBedMesh = new THREE.Mesh(bedGeo, this.classicClothMat);
    this.standardTableGroup.add(this.slateBedMesh);

    // 2. Six 3D K-66 Rubber Cushions (exact WPA jaw cut geometry!)
    const C = CORNER_JAW_OFFSET; // 3.27
    const S1 = 50.0 - SIDE_JAW_HALF_WIDTH; // 47.45
    const S2 = 50.0 + SIDE_JAW_HALF_WIDTH; // 52.55
    const CJ = C - 1.55; // 1.72
    const SJ = 0.5;

    const cushionPolys: [number, number][][] = [
      [
        [CJ, -ct],
        [C, 0],
        [S1, 0],
        [S1 + SJ, -ct],
      ],
      [
        [S2 - SJ, -ct],
        [S2, 0],
        [100 - C, 0],
        [100 - CJ, -ct],
      ],
      [
        [C, 50],
        [CJ, 50 + ct],
        [S1 + SJ, 50 + ct],
        [S1, 50],
      ],
      [
        [S2, 50],
        [S2 - SJ, 50 + ct],
        [100 - CJ, 50 + ct],
        [100 - C, 50],
      ],
      [
        [-ct, CJ],
        [-ct, 50 - CJ],
        [0, 50 - C],
        [0, C],
      ],
      [
        [100, C],
        [100, 50 - C],
        [100 + ct, 50 - CJ],
        [100 + ct, CJ],
      ],
    ];

    const aoStripMat = new THREE.MeshBasicMaterial({
      color: '#000000',
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });

    for (const poly of cushionPolys) {
      const shape = new THREE.Shape();
      poly.forEach(([tx, ty], idx) => {
        const sx = txToWorldX(tx);
        const sy = -tyToWorldZ(ty);
        if (idx === 0) shape.moveTo(sx, sy);
        else shape.lineTo(sx, sy);
      });
      shape.closePath();

      const cGeo = new THREE.ExtrudeGeometry(shape, {
        depth: CUSHION_HEIGHT,
        bevelEnabled: true,
        bevelThickness: 0.14,
        bevelSize: 0.12,
        bevelSegments: 2,
      });
      const cUv = cGeo.attributes.uv;
      for (let i = 0; i < cUv.count; i++) {
        cUv.setXY(i, cUv.getX(i) / 80, cUv.getY(i) / 80);
      }
      cGeo.rotateX(-Math.PI / 2);
      const cMesh = new THREE.Mesh(cGeo, this.classicCushionMat);
      cMesh.position.y = 0.04;
      this.cushionMeshes.push(cMesh);
      this.standardTableGroup.add(cMesh);
    }

    // Subtle cushion-nose ambient occlusion strips on the slate bed
    const addAoStrip = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      inwardNx: number,
      inwardNy: number
    ) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const width = 0.85;
      const geo = new THREE.PlaneGeometry(len, width);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, aoStripMat);
      const mx = (x1 + x2) * 0.5 + inwardNx * (width * 0.42);
      const my = (y1 + y2) * 0.5 + inwardNy * (width * 0.42);
      mesh.position.set(txToWorldX(mx), 0.012, tyToWorldZ(my));
      mesh.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
      this.standardTableGroup.add(mesh);
    };
    addAoStrip(C, 0, S1, 0, 0, 1);
    addAoStrip(S2, 0, 100 - C, 0, 0, 1);
    addAoStrip(C, 50, S1, 50, 0, -1);
    addAoStrip(S2, 50, 100 - C, 50, 0, -1);
    addAoStrip(0, C, 0, 50 - C, 1, 0);
    addAoStrip(100, C, 100, 50 - C, -1, 0);

    // 3. Six Contoured Hardwood Mahogany Rail Sections fitted cleanly between the 6 pocket castings
    const rb = RAIL_BORDER; // 5.25
    const woodMat = new THREE.MeshStandardMaterial({
      map: woodTex,
      roughness: 0.32,
      metalness: 0.06,
      envMapIntensity: 0.55,
    });

    const addWoodRailSegment = (tx1: number, ty1: number, tx2: number, ty2: number) => {
      const s = new THREE.Shape();
      const xA = txToWorldX(Math.min(tx1, tx2));
      const xB = txToWorldX(Math.max(tx1, tx2));
      const yA = -tyToWorldZ(Math.max(ty1, ty2));
      const yB = -tyToWorldZ(Math.min(ty1, ty2));
      s.moveTo(xA, yA);
      s.lineTo(xB, yA);
      s.lineTo(xB, yB);
      s.lineTo(xA, yB);
      s.closePath();

      const g = new THREE.ExtrudeGeometry(s, {
        depth: 2.35,
        bevelEnabled: true,
        bevelThickness: 0.16,
        bevelSize: 0.14,
        bevelSegments: 2,
      });
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) / 45, uv.getY(i) / 16);
      }
      g.rotateX(-Math.PI / 2);
      g.translate(0, -0.65, 0);
      const m = new THREE.Mesh(g, woodMat);
      this.standardTableGroup.add(m);
    };

    const pkGapCorner = 1.55;
    const pkGapSide = 2.55;
    addWoodRailSegment(pkGapCorner, -rb, 50 - pkGapSide, -ct);
    addWoodRailSegment(50 + pkGapSide, -rb, 100 - pkGapCorner, -ct);
    addWoodRailSegment(pkGapCorner, 50 + ct, 50 - pkGapSide, 50 + rb);
    addWoodRailSegment(50 + pkGapSide, 50 + ct, 100 - pkGapCorner, 50 + rb);
    addWoodRailSegment(-rb, pkGapCorner, -ct, 50 - pkGapCorner);
    addWoodRailSegment(100 + ct, pkGapCorner, 100 + rb, 50 - pkGapCorner);

    // 4. Brushed Gunmetal / Brass Pocket Castings + Deep 3D Recessed Pocket Wells!
    const castingMat = new THREE.MeshStandardMaterial({
      color: '#2c333d',
      roughness: 0.28,
      metalness: 0.85,
      envMapIntensity: 1.0,
    });
    const brassTrimMat = new THREE.MeshStandardMaterial({
      color: '#d4af37',
      roughness: 0.25,
      metalness: 0.88,
      envMapIntensity: 1.1,
    });

    this.buildPocketWells(this.standardTableGroup, POCKETS, castingMat, brassTrimMat, true);

    // 5. 18 Inlaid Mother-of-Pearl / Brass Diamond Sights on the rails
    const diamondShape = new THREE.Shape();
    const ds = 0.36;
    diamondShape.moveTo(0, ds);
    diamondShape.lineTo(ds * 0.72, 0);
    diamondShape.lineTo(0, -ds);
    diamondShape.lineTo(-ds * 0.72, 0);
    diamondShape.closePath();
    const diamondGeo = new THREE.ShapeGeometry(diamondShape);
    diamondGeo.rotateX(-Math.PI / 2);

    const placeDiamond = (tx: number, ty: number, rotY: number = 0) => {
      const dm = new THREE.Mesh(diamondGeo, brassTrimMat);
      dm.position.set(txToWorldX(tx), 1.87, tyToWorldZ(ty));
      dm.rotation.y = rotY;
      this.standardTableGroup.add(dm);
    };

    for (let i = 1; i <= 7; i++) {
      if (i === 4) continue;
      placeDiamond(i * 12.5, -DIAMOND_OFFSET, 0);
      placeDiamond(i * 12.5, TABLE_WIDTH + DIAMOND_OFFSET, 0);
    }
    for (let j = 1; j <= 3; j++) {
      placeDiamond(-DIAMOND_OFFSET, j * 12.5, Math.PI / 2);
      placeDiamond(TABLE_LENGTH + DIAMOND_OFFSET, j * 12.5, Math.PI / 2);
    }

    // 6. Table Markings (Head Spot, Foot Spot, Head String Line, Break Kitchen Zone)
    this.buildTableMarkings(this.standardTableGroup);

    // 7. Tapered Architectural Cabinet Apron & 4 Sturdy Legs beneath the slate
    const apronMat = new THREE.MeshStandardMaterial({
      map: woodTex,
      color: '#8c6b58',
      roughness: 0.45,
      metalness: 0.08,
      envMapIntensity: 0.35,
    });
    const apronGeo = new THREE.BoxGeometry(TABLE_LENGTH + rb * 1.75, 6.8, TABLE_WIDTH + rb * 1.75);
    const apronMesh = new THREE.Mesh(apronGeo, apronMat);
    apronMesh.position.set(0, -4.3, 0);
    this.standardTableGroup.add(apronMesh);

    const legGeo = new THREE.CylinderGeometry(3.4, 2.5, 21, 16);
    for (const lx of [-36, 36]) {
      for (const lz of [-17, 17]) {
        const leg = new THREE.Mesh(legGeo, apronMat);
        leg.position.set(lx, -17.5, lz);
        this.standardTableGroup.add(leg);

        const footCap = new THREE.Mesh(
          new THREE.CylinderGeometry(2.65, 2.8, 1.4, 16),
          brassTrimMat
        );
        footCap.position.set(lx, -27.3, lz);
        this.standardTableGroup.add(footCap);
      }
    }

    // 8. Special Modifier Overlays on Standard Table (Portals, Pinball, Black Hole)
    this.buildSpecialModifierOverlays();
    this.standardTableGroup.add(this.portalsDecorGroup);
    this.standardTableGroup.add(this.pinballDecorGroup);
    this.standardTableGroup.add(this.blackHoleDecorGroup);

    this.scene.add(this.standardTableGroup);
  }

  private buildPocketWells(
    parent: THREE.Group,
    pockets: readonly PocketLike[],
    castingMat: THREE.Material,
    brassTrimMat: THREE.Material,
    includeOuterCastings: boolean
  ): void {
    const wellWallMat = new THREE.MeshStandardMaterial({
      color: '#090c10',
      roughness: 0.92,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const wellFloorMat = new THREE.MeshStandardMaterial({
      color: '#05070a',
      roughness: 0.95,
      metalness: 0.0,
    });
    const lipRimMat = new THREE.MeshStandardMaterial({
      color: '#161c24',
      roughness: 0.65,
      metalness: 0.25,
    });

    const wellDepth = 4.25;

    for (const pk of pockets) {
      const wx = txToWorldX(pocketRenderX(pk));
      const wz = tyToWorldZ(pocketRenderY(pk));
      const r = pk.renderRadius;

      // Cylindrical recessed leather/rubber pocket liner
      const wallGeo = new THREE.CylinderGeometry(r + 0.04, r * 0.92, wellDepth, 28, 1, true);
      const wallMesh = new THREE.Mesh(wallGeo, wellWallMat);
      wallMesh.position.set(wx, -wellDepth * 0.5, wz);
      parent.add(wallMesh);

      // Dark leather pocket bottom basket
      const bottomGeo = new THREE.CircleGeometry(r * 0.92, 24);
      bottomGeo.rotateX(-Math.PI / 2);
      const bottomMesh = new THREE.Mesh(bottomGeo, wellFloorMat);
      bottomMesh.position.set(wx, -wellDepth, wz);
      parent.add(bottomMesh);

      // Subtle beveled slate lip ring right at y = -0.02
      const lipGeo = new THREE.RingGeometry(r - 0.08, r + 0.22, 28);
      lipGeo.rotateX(-Math.PI / 2);
      const lipMesh = new THREE.Mesh(lipGeo, lipRimMat);
      lipMesh.position.set(wx, 0.008, wz);
      parent.add(lipMesh);

      if (includeOuterCastings) {
        // Curved outer corner / side pocket metal casting (Gold Crown / Pro-Am style)
        const ox = pk.type === 'corner' ? Math.sign(wx) : 0;
        const oz = Math.sign(wz);
        const centerAngle = Math.atan2(-oz, ox);
        const arcSpan = pk.type === 'corner' ? Math.PI * 1.18 : Math.PI * 1.02;
        const startAngle = centerAngle - arcSpan * 0.5;

        const cShape = new THREE.Shape();
        const rInner = r;
        const rOuter = pk.type === 'corner' ? r + 2.15 : r + 1.85;
        cShape.absarc(0, 0, rOuter, startAngle, startAngle + arcSpan, false);
        cShape.absarc(0, 0, rInner, startAngle + arcSpan, startAngle, true);
        cShape.closePath();

        const cGeo = new THREE.ExtrudeGeometry(cShape, {
          depth: 2.42,
          bevelEnabled: true,
          bevelThickness: 0.12,
          bevelSize: 0.1,
          bevelSegments: 2,
          curveSegments: 20,
        });
        cGeo.rotateX(-Math.PI / 2);
        cGeo.translate(wx, -0.65, wz);
        const castingMesh = new THREE.Mesh(cGeo, castingMat);
        parent.add(castingMesh);

        // Thin gold/brass accent arc along top of casting
        const trimShape = new THREE.Shape();
        trimShape.absarc(0, 0, rOuter - 0.25, startAngle + 0.08, startAngle + arcSpan - 0.08, false);
        trimShape.absarc(0, 0, rInner + 0.35, startAngle + arcSpan - 0.08, startAngle + 0.08, true);
        trimShape.closePath();
        const trimGeo = new THREE.ShapeGeometry(trimShape, 18);
        trimGeo.rotateX(-Math.PI / 2);
        const trimMesh = new THREE.Mesh(trimGeo, brassTrimMat);
        trimMesh.position.set(wx, 1.9, wz);
        parent.add(trimMesh);
      }
    }
  }

  private buildTableMarkings(parent: THREE.Group): void {
    const spotOuterMat = new THREE.MeshBasicMaterial({
      color: '#071c12',
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const spotInnerMat = new THREE.MeshBasicMaterial({
      color: '#e2e8f0',
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });

    for (const sp of [HEAD_SPOT, FOOT_SPOT]) {
      const outer = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), spotOuterMat);
      outer.rotation.x = -Math.PI / 2;
      outer.position.set(txToWorldX(sp.x), 0.015, tyToWorldZ(sp.y));
      parent.add(outer);

      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), spotInnerMat);
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(txToWorldX(sp.x), 0.018, tyToWorldZ(sp.y));
      parent.add(inner);
    }

    const hsPts = [
      new THREE.Vector3(txToWorldX(HEAD_STRING_X), 0.02, tyToWorldZ(0)),
      new THREE.Vector3(txToWorldX(HEAD_STRING_X), 0.02, tyToWorldZ(TABLE_WIDTH)),
    ];
    const hsGeo = new THREE.BufferGeometry().setFromPoints(hsPts);
    const hsMat = new THREE.LineBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.16,
    });
    this.headStringLine = new THREE.Line(hsGeo, hsMat);
    parent.add(this.headStringLine);

    const kGeo = new THREE.PlaneGeometry(HEAD_STRING_X, TABLE_WIDTH);
    kGeo.rotateX(-Math.PI / 2);
    const kMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.04,
      depthWrite: false,
    });
    this.kitchenZoneMesh = new THREE.Mesh(kGeo, kMat);
    this.kitchenZoneMesh.position.set(txToWorldX(HEAD_STRING_X * 0.5), 0.012, 0);
    parent.add(this.kitchenZoneMesh);
  }

  private buildSpecialModifierOverlays(): void {
    const buildPortalAt = (parent: THREE.Group, pk: PocketLike, hex: string) => {
      const wx = txToWorldX(pocketRenderX(pk));
      const wz = tyToWorldZ(pocketRenderY(pk));
      const outerRing = new THREE.Mesh(
        new THREE.TorusGeometry(pk.renderRadius * 0.9, 0.16, 12, 32),
        new THREE.MeshBasicMaterial({ color: hex })
      );
      outerRing.rotation.x = Math.PI / 2;
      outerRing.position.set(wx, 0.14, wz);
      parent.add(outerRing);

      const coreDisc = new THREE.Mesh(
        new THREE.CircleGeometry(pk.renderRadius * 0.86, 28),
        new THREE.MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.55,
        })
      );
      coreDisc.rotation.x = -Math.PI / 2;
      coreDisc.position.set(wx, 0.06, wz);
      parent.add(coreDisc);
    };

    buildPortalAt(this.portalsDecorGroup, POCKETS[1], '#38bdf8');
    buildPortalAt(this.portalsDecorGroup, POCKETS[4], '#fb923c');

    const neonMat = new THREE.MeshBasicMaterial({ color: '#f43f5e' });
    const neonGlowMat = new THREE.MeshBasicMaterial({
      color: '#fb7185',
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const C = CORNER_JAW_OFFSET;
    const S1 = 50 - SIDE_JAW_HALF_WIDTH;
    const S2 = 50 + SIDE_JAW_HALF_WIDTH;
    const rails: [number, number, number, number][] = [
      [C, 0, S1, 0],
      [S2, 0, 100 - C, 0],
      [C, 50, S1, 50],
      [S2, 50, 100 - C, 50],
      [0, C, 0, 50 - C],
      [100, C, 100, 50 - C],
    ];
    for (const [x1, y1, x2, y2] of rails) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const barGeo = new THREE.CylinderGeometry(0.14, 0.14, len, 8);
      barGeo.rotateZ(Math.PI / 2);
      const bar = new THREE.Mesh(barGeo, neonMat);
      bar.position.set(
        txToWorldX((x1 + x2) * 0.5),
        CUSHION_HEIGHT + 0.05,
        tyToWorldZ((y1 + y2) * 0.5)
      );
      bar.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
      this.pinballDecorGroup.add(bar);

      const glowGeo = new THREE.PlaneGeometry(len, 1.2);
      glowGeo.rotateX(-Math.PI / 2);
      const glow = new THREE.Mesh(glowGeo, neonGlowMat);
      glow.position.set(txToWorldX((x1 + x2) * 0.5), 0.03, tyToWorldZ((y1 + y2) * 0.5));
      glow.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
      this.pinballDecorGroup.add(glow);
    }

    const buildBlackHoleRings = (parent: THREE.Group, pockets: readonly PocketLike[]) => {
      for (const pk of pockets) {
        const wx = txToWorldX(pk.x);
        const wz = tyToWorldZ(pk.y);
        const horizonRing = new THREE.Mesh(
          new THREE.RingGeometry(pk.renderRadius * 0.96, pk.renderRadius + 0.55, 32),
          new THREE.MeshBasicMaterial({
            color: '#a855f7',
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
          })
        );
        horizonRing.rotation.x = -Math.PI / 2;
        horizonRing.position.set(wx, 0.035, wz);
        parent.add(horizonRing);

        const outerWell = new THREE.Mesh(
          new THREE.RingGeometry(5.6, 6.0, 40),
          new THREE.MeshBasicMaterial({
            color: '#c084fc',
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
          })
        );
        outerWell.rotation.x = -Math.PI / 2;
        outerWell.position.set(wx, 0.025, wz);
        parent.add(outerWell);
      }
    };

    buildBlackHoleRings(this.blackHoleDecorGroup, POCKETS);
    buildBlackHoleRings(this.infiniteBlackHoleGroup, INFINITE_POCKETS);
    buildPortalAt(this.infinitePortalsGroup, INFINITE_SIDE_PORTALS[0], '#38bdf8');
    buildPortalAt(this.infinitePortalsGroup, INFINITE_SIDE_PORTALS[1], '#fb923c');
  }

  private buildInfiniteTable(maxAniso: number): void {
    const bdr = 18.0;
    const totalL = TABLE_LENGTH + bdr * 2;
    const totalW = TABLE_WIDTH + bdr * 2;

    const infShape = new THREE.Shape();
    const hw = totalL * 0.5;
    const hh = totalW * 0.5;
    infShape.moveTo(-hw, -hh);
    infShape.lineTo(hw, -hh);
    infShape.lineTo(hw, hh);
    infShape.lineTo(-hw, hh);
    infShape.closePath();

    for (const pk of INFINITE_POCKETS) {
      const hx = txToWorldX(pk.x);
      const hy = -tyToWorldZ(pk.y);
      const hole = new THREE.Path();
      hole.absarc(hx, hy, pk.renderRadius, 0, Math.PI * 2, true);
      infShape.holes.push(hole);
    }

    const neighborTex = createClothTexture('classic', maxAniso);
    const neighborMat = new THREE.MeshStandardMaterial({
      map: neighborTex,
      color: '#5c7a6b',
      roughness: 0.9,
      metalness: 0.0,
      envMapIntensity: 0.08,
    });

    const outerGeo = new THREE.ExtrudeGeometry(infShape, {
      depth: 0.8,
      bevelEnabled: false,
      curveSegments: 24,
    });
    const oUv = outerGeo.attributes.uv;
    for (let i = 0; i < oUv.count; i++) {
      oUv.setXY(i, oUv.getX(i) / 100, oUv.getY(i) / 50);
    }
    outerGeo.rotateX(-Math.PI / 2);
    outerGeo.translate(0, -0.82, 0);
    this.infiniteTableGroup.add(new THREE.Mesh(outerGeo, neighborMat));

    const centerShape = new THREE.Shape();
    centerShape.moveTo(-50, -25);
    centerShape.lineTo(50, -25);
    centerShape.lineTo(50, 25);
    centerShape.lineTo(-50, 25);
    centerShape.closePath();
    for (const pk of INFINITE_POCKETS) {
      const hx = txToWorldX(pk.x);
      const hy = -tyToWorldZ(pk.y);
      const hole = new THREE.Path();
      hole.absarc(hx, hy, pk.renderRadius, 0, Math.PI * 2, true);
      centerShape.holes.push(hole);
    }
    const centerGeo = new THREE.ShapeGeometry(centerShape, 24);
    const cUv = centerGeo.attributes.uv;
    for (let i = 0; i < cUv.count; i++) {
      cUv.setXY(i, cUv.getX(i) / 100, cUv.getY(i) / 50);
    }
    centerGeo.rotateX(-Math.PI / 2);
    this.infiniteCenterBedMesh = new THREE.Mesh(centerGeo, this.classicClothMat);
    this.infiniteCenterBedMesh.position.y = 0.005;
    this.infiniteTableGroup.add(this.infiniteCenterBedMesh);

    const seamMat = new THREE.LineDashedMaterial({
      color: '#7dd3fc',
      dashSize: 0.9,
      gapSize: 0.6,
      transparent: true,
      opacity: 0.78,
    });
    const addSeamLine = (x1: number, y1: number, x2: number, y2: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(txToWorldX(x1), 0.03, tyToWorldZ(y1)),
        new THREE.Vector3(txToWorldX(x2), 0.03, tyToWorldZ(y2)),
      ]);
      const ln = new THREE.Line(g, seamMat);
      ln.computeLineDistances();
      this.infiniteTableGroup.add(ln);
    };
    addSeamLine(0, -bdr, 0, TABLE_WIDTH + bdr);
    addSeamLine(TABLE_LENGTH, -bdr, TABLE_LENGTH, TABLE_WIDTH + bdr);
    addSeamLine(-bdr, 0, TABLE_LENGTH + bdr, 0);
    addSeamLine(-bdr, TABLE_WIDTH, TABLE_LENGTH + bdr, TABLE_WIDTH);

    const dummyMat = new THREE.MeshStandardMaterial({ color: '#1e293b' });
    this.buildPocketWells(this.infiniteTableGroup, INFINITE_POCKETS, dummyMat, dummyMat, false);

    const baseFrame = new THREE.Mesh(
      new THREE.BoxGeometry(totalL + 1.2, 4.5, totalW + 1.2),
      new THREE.MeshStandardMaterial({ color: '#111827', roughness: 0.6, metalness: 0.3 })
    );
    baseFrame.position.set(0, -3.1, 0);
    this.infiniteTableGroup.add(baseFrame);

    this.infiniteTableGroup.add(this.infinitePortalsGroup);
    this.infiniteTableGroup.add(this.infiniteBlackHoleGroup);
    this.infiniteTableGroup.visible = false;
    this.scene.add(this.infiniteTableGroup);
  }

  private buildBallsAndShadows(maxAniso: number): void {
    const ballTextures = createBallTextures(maxAniso);
    const shadowTex = createSoftShadowTexture();

    const sphereGeo = new THREE.SphereGeometry(BALL_RADIUS, 32, 24);
    const shadowPlaneGeo = new THREE.PlaneGeometry(BALL_RADIUS * 2.55, BALL_RADIUS * 2.55);
    shadowPlaneGeo.rotateX(-Math.PI / 2);

    const tightShadowGeo = new THREE.PlaneGeometry(BALL_RADIUS * 1.65, BALL_RADIUS * 1.65);
    tightShadowGeo.rotateX(-Math.PI / 2);

    for (let id = 0; id <= 15; id++) {
      const mat = new THREE.MeshPhysicalMaterial({
        map: ballTextures[id],
        roughness: 0.09,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.045,
        envMapIntensity: 1.15,
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.set(0, BALL_RADIUS, 0);
      this.scene.add(mesh);
      this.ballMeshes.push(mesh);
      this.ballMaterials.push(mat);

      const dirShadowMat = new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.44,
        depthWrite: false,
      });
      const dirShadow = new THREE.Mesh(shadowPlaneGeo, dirShadowMat);
      dirShadow.position.set(0, 0.02, 0);
      this.scene.add(dirShadow);
      this.ballShadows.push(dirShadow);

      const tightShadowMat = new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      });
      const tightShadow = new THREE.Mesh(tightShadowGeo, tightShadowMat);
      tightShadow.position.set(0, 0.024, 0);
      this.scene.add(tightShadow);
      this.ballAmbientShadows.push(tightShadow);

      const ghostNeighborMat = new THREE.MeshStandardMaterial({
        map: ballTextures[id],
        roughness: 0.25,
        metalness: 0.0,
        transparent: true,
        opacity: 0.36,
      });
      this.infiniteBallMats.push(ghostNeighborMat);
    }

    const lowSphereGeo = new THREE.SphereGeometry(BALL_RADIUS, 18, 14);
    for (let i = 0; i < 64; i++) {
      const m = new THREE.Mesh(lowSphereGeo, this.infiniteBallMats[0]);
      m.visible = false;
      this.scene.add(m);
      this.infiniteBallPool.push(m);
    }
  }

  private buildCueStick(): void {
    const tipLen = 0.18;
    const ferruleLen = 0.65;
    const shaftLen = 28.0;
    const buttLen = 28.0;

    const tipGeo = new THREE.CylinderGeometry(0.24, 0.255, tipLen, 16);
    tipGeo.rotateZ(Math.PI / 2);
    tipGeo.translate(-tipLen * 0.5, 0, 0);
    const tipMesh = new THREE.Mesh(
      tipGeo,
      new THREE.MeshStandardMaterial({ color: '#0284c7', roughness: 0.78 })
    );
    this.cueStickMeshGroup.add(tipMesh);

    const ferGeo = new THREE.CylinderGeometry(0.255, 0.268, ferruleLen, 16);
    ferGeo.rotateZ(Math.PI / 2);
    ferGeo.translate(-(tipLen + ferruleLen * 0.5), 0, 0);
    const ferMesh = new THREE.Mesh(
      ferGeo,
      new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.22 })
    );
    this.cueStickMeshGroup.add(ferMesh);

    const shaftGeo = new THREE.CylinderGeometry(0.268, 0.42, shaftLen, 18);
    shaftGeo.rotateZ(Math.PI / 2);
    shaftGeo.translate(-(tipLen + ferruleLen + shaftLen * 0.5), 0, 0);
    const shaftMesh = new THREE.Mesh(
      shaftGeo,
      new THREE.MeshStandardMaterial({
        color: '#f3dec0',
        roughness: 0.28,
        metalness: 0.02,
        envMapIntensity: 0.45,
      })
    );
    this.cueStickMeshGroup.add(shaftMesh);

    const jointGeo = new THREE.CylinderGeometry(0.42, 0.43, 0.85, 18);
    jointGeo.rotateZ(Math.PI / 2);
    jointGeo.translate(-(tipLen + ferruleLen + shaftLen + 0.425), 0, 0);
    const jointMesh = new THREE.Mesh(
      jointGeo,
      new THREE.MeshStandardMaterial({ color: '#d4af37', roughness: 0.22, metalness: 0.88 })
    );
    this.cueStickMeshGroup.add(jointMesh);

    const buttStart = tipLen + ferruleLen + shaftLen + 0.85;
    const buttGeo = new THREE.CylinderGeometry(0.43, 0.62, buttLen, 18);
    buttGeo.rotateZ(Math.PI / 2);
    buttGeo.translate(-(buttStart + buttLen * 0.5), 0, 0);
    const buttMesh = new THREE.Mesh(
      buttGeo,
      new THREE.MeshStandardMaterial({
        color: '#2b140e',
        roughness: 0.26,
        metalness: 0.08,
        envMapIntensity: 0.6,
      })
    );
    this.cueStickMeshGroup.add(buttMesh);

    const wrapGeo = new THREE.CylinderGeometry(0.495, 0.575, 13.5, 18);
    wrapGeo.rotateZ(Math.PI / 2);
    wrapGeo.translate(-(buttStart + 16.5), 0, 0);
    const wrapMesh = new THREE.Mesh(
      wrapGeo,
      new THREE.MeshStandardMaterial({ color: '#111827', roughness: 0.85 })
    );
    this.cueStickMeshGroup.add(wrapMesh);

    this.cueStickMeshGroup.rotation.z = -0.088;
    this.cuePivot.add(this.cueStickMeshGroup);
    this.scene.add(this.cuePivot);
  }

  private buildAimAndPreviewHelpers(): void {
    this.normalAimGeo = new THREE.BufferGeometry();
    this.normalAimGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.normalAimPositions, 3)
    );
    this.normalAimGeo.setAttribute('color', new THREE.BufferAttribute(this.normalAimColors, 3));
    const normalLineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
    });
    this.normalAimLine = new THREE.LineSegments(this.normalAimGeo, normalLineMat);
    this.normalAimLine.frustumCulled = false;
    this.aimGroup.add(this.normalAimLine);

    const ghostGeo = new THREE.SphereGeometry(BALL_RADIUS, 24, 18);
    const ghostMat = new THREE.MeshPhysicalMaterial({
      color: '#e0f2fe',
      roughness: 0.15,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    this.ghostBallMesh = new THREE.Mesh(ghostGeo, ghostMat);
    this.aimGroup.add(this.ghostBallMesh);

    const ghostRingGeo = new THREE.RingGeometry(BALL_RADIUS * 0.92, BALL_RADIUS * 1.12, 32);
    ghostRingGeo.rotateX(-Math.PI / 2);
    this.ghostBallRing = new THREE.Mesh(
      ghostRingGeo,
      new THREE.MeshBasicMaterial({
        color: '#38bdf8',
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    this.aimGroup.add(this.ghostBallRing);

    this.cheatLinesGeo = new THREE.BufferGeometry();
    this.cheatLinesGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.cheatLinePositions, 3)
    );
    this.cheatLinesGeo.setAttribute('color', new THREE.BufferAttribute(this.cheatLineColors, 3));
    this.cheatLinesMesh = new THREE.LineSegments(
      this.cheatLinesGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.82,
      })
    );
    this.cheatLinesMesh.frustumCulled = false;
    this.aimGroup.add(this.cheatLinesMesh);

    for (let id = 0; id <= 15; id++) {
      const gm = new THREE.Mesh(
        ghostGeo,
        new THREE.MeshStandardMaterial({
          map: this.ballMaterials[id].map,
          roughness: 0.25,
          transparent: true,
          opacity: 0.58,
          depthWrite: false,
        })
      );
      gm.visible = false;
      this.aimGroup.add(gm);
      this.cheatGhostMeshes.push(gm);

      const gr = new THREE.Mesh(
        ghostRingGeo,
        new THREE.MeshBasicMaterial({
          color: '#ffffff',
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        })
      );
      gr.visible = false;
      this.aimGroup.add(gr);
      this.cheatGhostRings.push(gr);
    }

    const bihRingGeo = new THREE.RingGeometry(BALL_RADIUS * 1.32, BALL_RADIUS * 1.54, 36);
    bihRingGeo.rotateX(-Math.PI / 2);
    this.bihRingMesh = new THREE.Mesh(
      bihRingGeo,
      new THREE.MeshBasicMaterial({
        color: '#38bdf8',
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      })
    );
    this.bihDiscMesh = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.32, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: '#38bdf8',
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      })
    );
    this.bihHaloGroup.add(this.bihRingMesh);
    this.bihHaloGroup.add(this.bihDiscMesh);
    this.bihHaloGroup.position.y = 0.032;
    this.scene.add(this.bihHaloGroup);

    this.scene.add(this.aimGroup);
  }

  private updatePocketDrops(state: GameState, dt: number, isSimulating: boolean): void {
    const isInfinite = hasModifier(state, 'infinite');
    const pockets: readonly PocketLike[] = isInfinite ? INFINITE_POCKETS : POCKETS;

    if (state.rackSeed !== this.lastRackSeed || (state.isBreakShot && state.shotCount === 0)) {
      this.lastRackSeed = state.rackSeed;
      this.dropStates.clear();
      this.lastKnownBalls.clear();
    }

    for (const b of state.balls) {
      const prev = this.lastKnownBalls.get(b.id);

      if (!b.pocketed) {
        this.dropStates.delete(b.id);
        this.lastKnownBalls.set(b.id, {
          x: b.x,
          y: b.y,
          vx: b.vx,
          vy: b.vy,
          pocketed: false,
        });
      } else {
        if (!this.dropStates.has(b.id)) {
          const pkId = b.pocketId ?? 0;
          const pk = pockets[pkId] ?? pockets[0];
          const pRenderX = pocketRenderX(pk);
          const pRenderY = pocketRenderY(pk);

          let existingInPocket = 0;
          for (const d of this.dropStates.values()) {
            if (d.pocketId === pkId) existingInPocket++;
          }

          if (prev && !prev.pocketed && (isSimulating || Math.hypot(prev.vx, prev.vy) > 0.1)) {
            const toCenterX = pRenderX - prev.x;
            const toCenterY = pRenderY - prev.y;
            const dist = Math.hypot(toCenterX, toCenterY) || 1;
            const entryVx = prev.vx * 0.58 + (toCenterX / dist) * 18;
            const entryVy = prev.vy * 0.58 + (toCenterY / dist) * 18;

            this.dropStates.set(b.id, {
              ballId: b.id,
              pocketId: pkId,
              x: prev.x,
              y: prev.y,
              height: BALL_RADIUS * 0.86,
              vx: entryVx,
              vy: entryVy,
              vHeight: -14.0,
              qx: b.qx,
              qy: b.qy,
              qz: b.qz,
              qw: b.qw,
              settled: false,
              age: 0,
              slotIndex: existingInPocket,
            });
          } else if (b.id !== 0) {
            const angle = existingInPocket * 2.1;
            const offsetR = Math.min(0.85, existingInPocket * 0.42);
            this.dropStates.set(b.id, {
              ballId: b.id,
              pocketId: pkId,
              x: pRenderX + Math.cos(angle) * offsetR,
              y: pRenderY + Math.sin(angle) * offsetR,
              height: -3.05 + Math.floor(existingInPocket / 3) * 0.85,
              vx: 0,
              vy: 0,
              vHeight: 0,
              qx: b.qx,
              qy: b.qy,
              qz: b.qz,
              qw: b.qw,
              settled: true,
              age: 10,
              slotIndex: existingInPocket,
            });
          }
        }
        this.lastKnownBalls.set(b.id, {
          x: b.x,
          y: b.y,
          vx: 0,
          vy: 0,
          pocketed: true,
        });
      }
    }

    const stepDt = Math.min(0.033, dt);
    for (const drop of this.dropStates.values()) {
      const pk = pockets[drop.pocketId] ?? pockets[0];
      stepPocketDropPhysics(drop, pk, stepDt);
    }
  }

  private updateCamera(
    state: GameState,
    input: RenderInputState,
    aimPreview: AimPreview | null,
    isSimulating: boolean,
    isMyTurn: boolean,
    dt: number
  ): void {
    this.shotReleaseElapsed += dt;

    const cueBall = state.balls.find((b) => b.id === 0);
    const cueWx = cueBall && !cueBall.pocketed ? txToWorldX(cueBall.x) : -25;
    const cueWz = cueBall && !cueBall.pocketed ? tyToWorldZ(cueBall.y) : 0;

    const holdCueThroughStrike = this.shotReleaseElapsed < 0.16;
    const actionMoving = isSimulating || this.hasActivePocketDrops();
    let desiredFov = 45;

    if (this.cameraMode === 'overhead') {
      desiredFov = 28;
      const spanLong = hasModifier(state, 'infinite') ? 132 : 114;
      const spanShort = hasModifier(state, 'infinite') ? 82 : 64;
      const aspect = this.widthCss / Math.max(1, this.heightCss);
      const halfFovRad = (desiredFov * 0.5 * Math.PI) / 180;
      const tanHalfV = Math.tan(halfFovRad);
      const tanHalfH = tanHalfV * aspect;

      let height = 145;
      if (!this.isPortrait) {
        height = Math.max((spanLong * 0.52) / tanHalfH, (spanShort * 0.54) / tanHalfV);
        this.tmpDesiredUp.set(0, 0, -1);
      } else {
        height = Math.max((spanShort * 0.54) / tanHalfH, (spanLong * 0.52) / tanHalfV);
        this.tmpDesiredUp.set(1, 0, 0);
      }
      this.tmpDesiredPos.set(0, height, 0.01);
      this.tmpDesiredTarget.set(0, 0, 0);
    } else if (
      this.cameraMode === 'broadcast' ||
      (this.cameraMode === 'cue' && actionMoving && !holdCueThroughStrike) ||
      (this.cameraMode === 'cue' && state.winner !== null)
    ) {
      desiredFov = this.isPortrait ? 46 : 40;
      const zoom = this.cameraMode === 'broadcast' ? this.broadcastZoom : 1.0;
      const orbitOff = this.cameraMode === 'broadcast' ? this.broadcastOrbitOffset : 0;
      const pitchOff = this.cameraMode === 'broadcast' ? this.broadcastPitchOffset : 0;

      let focusX = 0;
      let focusZ = 0;
      if (actionMoving) {
        let sumX = 0;
        let sumZ = 0;
        let count = 0;
        for (const b of state.balls) {
          if (!b.pocketed) {
            sumX += txToWorldX(b.x);
            sumZ += tyToWorldZ(b.y);
            count++;
          }
        }
        if (count > 0) {
          focusX = (sumX / count) * 0.14;
          focusZ = (sumZ / count) * 0.14;
        }
      }

      this.tmpDesiredUp.set(0, 1, 0);
      if (this.isPortrait) {
        const baseAz = Math.PI + orbitOff;
        const pitch = clamp(0.92 + pitchOff, 0.45, 1.35);
        const dist = 128 * zoom;
        this.tmpDesiredPos.set(
          focusX + Math.cos(baseAz) * Math.cos(pitch) * dist,
          Math.sin(pitch) * dist,
          focusZ + Math.sin(baseAz) * Math.cos(pitch) * dist
        );
        this.tmpDesiredTarget.set(focusX + 4, -1.5, focusZ);
      } else {
        const baseAz = Math.PI * 0.5 + orbitOff;
        const pitch = clamp(0.8 + pitchOff, 0.38, 1.35);
        const dist = 92 * zoom;
        this.tmpDesiredPos.set(
          focusX + Math.cos(baseAz) * Math.cos(pitch) * dist,
          Math.sin(pitch) * dist,
          focusZ + Math.sin(baseAz) * Math.cos(pitch) * dist
        );
        this.tmpDesiredTarget.set(focusX, -1.0, focusZ);
      }
    } else {
      this.tmpDesiredUp.set(0, 1, 0);
      const activeAngle = holdCueThroughStrike ? this.strikeAngle : input.aimAngle;
      const dirX = Math.cos(activeAngle);
      const dirZ = Math.sin(activeAngle);

      if (input.isDraggingCueBall && state.ballInHand) {
        desiredFov = this.isPortrait ? 50 : 44;
        const backDist = 44 * this.cueCamZoom;
        const elevH = 42 * this.cueCamZoom;
        this.tmpDesiredPos.set(cueWx - dirX * backDist, elevH, cueWz - dirZ * backDist);
        this.tmpDesiredTarget.set(cueWx + dirX * 12, 0.8, cueWz + dirZ * 12);
      } else if (!isMyTurn && state.winner === null) {
        desiredFov = this.isPortrait ? 50 : 44;
        const backDist = 46;
        this.tmpDesiredPos.set(cueWx - dirX * backDist, 32, cueWz - dirZ * backDist);
        this.tmpDesiredTarget.set(cueWx + dirX * 18, 1.0, cueWz + dirZ * 18);
      } else {
        desiredFov = this.isPortrait ? 52 : 44;
        const pitch = this.cueCamPitch;
        const pullExtra = (input.pullBackAmount || 0) * 4.5;
        const baseRadius = (this.isPortrait ? 36 : 31) * this.cueCamZoom + pullExtra;
        const horizBack = Math.cos(pitch) * baseRadius;
        const camY = Math.max(5.2, Math.sin(pitch) * baseRadius + 1.5);

        let lookDist = 18;
        if (aimPreview && aimPreview.hitBall) {
          const hitDist = Math.hypot(
            aimPreview.ghostX - aimPreview.cueX,
            aimPreview.ghostY - aimPreview.cueY
          );
          lookDist = clamp(hitDist * 0.55, 11, 28);
        }

        this.tmpDesiredPos.set(cueWx - dirX * horizBack, camY, cueWz - dirZ * horizBack);
        this.tmpDesiredTarget.set(
          cueWx + dirX * lookDist,
          BALL_RADIUS * 0.95,
          cueWz + dirZ * lookDist
        );
      }
    }

    if (!this.camInitialized) {
      this.camPos.copy(this.tmpDesiredPos);
      this.camTarget.copy(this.tmpDesiredTarget);
      this.camUp.copy(this.tmpDesiredUp);
      this.camFov = desiredFov;
      this.camInitialized = true;
    } else {
      const smoothRate = this.cameraMode === 'overhead' ? 12 : actionMoving ? 5.5 : 9.5;
      const alpha = 1 - Math.exp(-smoothRate * Math.min(0.05, dt));
      this.camPos.lerp(this.tmpDesiredPos, alpha);
      this.camTarget.lerp(this.tmpDesiredTarget, alpha);
      this.camUp.lerp(this.tmpDesiredUp, alpha).normalize();
      this.camFov += (desiredFov - this.camFov) * alpha;
    }

    if (Math.abs(this.camera.fov - this.camFov) > 0.02) {
      this.camera.fov = this.camFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.up.copy(this.camUp);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  private updateAimAndCheatVisuals(
    state: GameState,
    input: RenderInputState,
    aimPreview: AimPreview | null,
    cheatPreview: CheatPreview | null
  ): void {
    const isInfinite = hasModifier(state, 'infinite');
    const showGuides = input.showAim && state.winner === null && !input.isDraggingCueBall;

    this.normalAimLine.visible = false;
    this.ghostBallMesh.visible = false;
    this.ghostBallRing.visible = false;
    this.cheatLinesMesh.visible = false;
    for (let i = 0; i <= 15; i++) {
      this.cheatGhostMeshes[i].visible = false;
      this.cheatGhostRings[i].visible = false;
    }

    if (!showGuides) return;

    const lineY = 0.065;

    if (cheatPreview) {
      let vIdx = 0;
      const maxVerts = this.cheatLinePositions.length / 3;
      const bdr = 18.0;

      const pushSeg = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        r: number,
        g: number,
        b: number
      ) => {
        if (vIdx + 2 > maxVerts) return;
        const pBase = vIdx * 3;
        this.cheatLinePositions[pBase] = txToWorldX(x1);
        this.cheatLinePositions[pBase + 1] = lineY;
        this.cheatLinePositions[pBase + 2] = tyToWorldZ(y1);
        this.cheatLinePositions[pBase + 3] = txToWorldX(x2);
        this.cheatLinePositions[pBase + 4] = lineY;
        this.cheatLinePositions[pBase + 5] = tyToWorldZ(y2);

        this.cheatLineColors[pBase] = r;
        this.cheatLineColors[pBase + 1] = g;
        this.cheatLineColors[pBase + 2] = b;
        this.cheatLineColors[pBase + 3] = r;
        this.cheatLineColors[pBase + 4] = g;
        this.cheatLineColors[pBase + 5] = b;
        vIdx += 2;
      };

      const tmpColor = new THREE.Color();
      for (const eb of cheatPreview.endBalls) {
        if (!eb.moved || eb.path.length < 2) continue;
        const isCue = eb.id === 0;
        const isCueFoul = isCue && (eb.pocketedThisShot || cheatPreview.isFoul);
        tmpColor.set(
          isCueFoul ? '#f87171' : isCue ? '#ffffff' : BALL_COLORS[eb.id] || '#ffffff'
        );

        let curOx = 0;
        let curOy = 0;
        for (let i = 1; i < eb.path.length; i++) {
          const prev = eb.path[i - 1];
          const curr = eb.path[i];
          const rawDx = curr.x - prev.x;
          const rawDy = curr.y - prev.y;

          if (isInfinite) {
            if (rawDx > TABLE_LENGTH * 0.5) curOx -= TABLE_LENGTH;
            else if (rawDx < -TABLE_LENGTH * 0.5) curOx += TABLE_LENGTH;
            if (rawDy > TABLE_WIDTH * 0.5) curOy -= TABLE_WIDTH;
            else if (rawDy < -TABLE_WIDTH * 0.5) curOy += TABLE_WIDTH;

            if (
              Math.hypot(curr.x + curOx - (prev.x + curOx), curr.y + curOy - (prev.y + curOy)) < 35
            ) {
              for (let gx = -1; gx <= 1; gx++) {
                for (let gy = -1; gy <= 1; gy++) {
                  const x1 = prev.x + gx * TABLE_LENGTH;
                  const y1 = prev.y + gy * TABLE_WIDTH;
                  const stepDx =
                    rawDx > 50 ? rawDx - 100 : rawDx < -50 ? rawDx + 100 : rawDx;
                  const stepDy =
                    rawDy > 25 ? rawDy - 50 : rawDy < -25 ? rawDy + 50 : rawDy;
                  const x2 = x1 + stepDx;
                  const y2 = y1 + stepDy;
                  if (
                    Math.max(x1, x2) >= -bdr &&
                    Math.min(x1, x2) <= TABLE_LENGTH + bdr &&
                    Math.max(y1, y2) >= -bdr &&
                    Math.min(y1, y2) <= TABLE_WIDTH + bdr &&
                    Math.hypot(x2 - x1, y2 - y1) < 28
                  ) {
                    const dim = gx === 0 && gy === 0 ? 1.0 : 0.45;
                    pushSeg(x1, y1, x2, y2, tmpColor.r * dim, tmpColor.g * dim, tmpColor.b * dim);
                  }
                }
              }
            }
          } else if (Math.hypot(rawDx, rawDy) <= 28) {
            pushSeg(prev.x, prev.y, curr.x, curr.y, tmpColor.r, tmpColor.g, tmpColor.b);
          }
        }

        const gm = this.cheatGhostMeshes[eb.id];
        const gr = this.cheatGhostRings[eb.id];
        gm.visible = true;
        gr.visible = true;
        const bs = eb.ballState;
        const [qx3, qy3, qz3, qw3] = engineQuatToThreeQuat(bs.qx, bs.qy, bs.qz, bs.qw);
        gm.position.set(
          txToWorldX(eb.endX),
          eb.pocketedThisShot ? BALL_RADIUS * 0.45 : BALL_RADIUS,
          tyToWorldZ(eb.endY)
        );
        gm.quaternion.set(qx3, qy3, qz3, qw3);

        gr.position.set(txToWorldX(eb.endX), 0.04, tyToWorldZ(eb.endY));
        const ringMat = gr.material as THREE.MeshBasicMaterial;
        ringMat.color.set(
          isCueFoul
            ? '#f87171'
            : eb.pocketedThisShot
            ? '#4ade80'
            : isCue
            ? '#38bdf8'
            : '#ffffff'
        );
      }

      this.cheatLinesGeo.setDrawRange(0, vIdx);
      this.cheatLinesGeo.attributes.position.needsUpdate = true;
      this.cheatLinesGeo.attributes.color.needsUpdate = true;
      this.cheatLinesMesh.visible = vIdx > 0;
      return;
    }

    if (aimPreview) {
      let vIdx = 0;
      const setSeg = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        r: number,
        g: number,
        b: number
      ) => {
        const base = vIdx * 3;
        this.normalAimPositions[base] = txToWorldX(x1);
        this.normalAimPositions[base + 1] = lineY;
        this.normalAimPositions[base + 2] = tyToWorldZ(y1);
        this.normalAimPositions[base + 3] = txToWorldX(x2);
        this.normalAimPositions[base + 4] = lineY;
        this.normalAimPositions[base + 5] = tyToWorldZ(y2);

        this.normalAimColors[base] = r;
        this.normalAimColors[base + 1] = g;
        this.normalAimColors[base + 2] = b;
        this.normalAimColors[base + 3] = r;
        this.normalAimColors[base + 4] = g;
        this.normalAimColors[base + 5] = b;
        vIdx += 2;
      };

      const legal = aimPreview.isLegalTarget;
      const mainC = new THREE.Color(legal ? '#f8fafc' : '#f87171');
      setSeg(
        aimPreview.cueX,
        aimPreview.cueY,
        aimPreview.ghostX,
        aimPreview.ghostY,
        mainC.r,
        mainC.g,
        mainC.b
      );

      if (
        isInfinite &&
        (aimPreview.ghostX < 0 ||
          aimPreview.ghostX > TABLE_LENGTH ||
          aimPreview.ghostY < 0 ||
          aimPreview.ghostY > TABLE_WIDTH)
      ) {
        const shiftX =
          aimPreview.ghostX < 0 ? TABLE_LENGTH : aimPreview.ghostX > TABLE_LENGTH ? -TABLE_LENGTH : 0;
        const shiftY =
          aimPreview.ghostY < 0 ? TABLE_WIDTH : aimPreview.ghostY > TABLE_WIDTH ? -TABLE_WIDTH : 0;
        setSeg(
          aimPreview.cueX + shiftX,
          aimPreview.cueY + shiftY,
          aimPreview.ghostX + shiftX,
          aimPreview.ghostY + shiftY,
          mainC.r,
          mainC.g,
          mainC.b
        );
      }

      if (aimPreview.hitBall && legal) {
        const hx = aimPreview.hitBall.x;
        const hy = aimPreview.hitBall.y;
        const effHx = isInfinite
          ? hx + Math.round((aimPreview.ghostX - hx) / TABLE_LENGTH) * TABLE_LENGTH
          : hx;
        const effHy = isInfinite
          ? hy + Math.round((aimPreview.ghostY - hy) / TABLE_WIDTH) * TABLE_WIDTH
          : hy;

        const targetC = new THREE.Color('#38bdf8');
        setSeg(
          effHx,
          effHy,
          effHx + aimPreview.targetDirX * 14.5,
          effHy + aimPreview.targetDirY * 14.5,
          targetC.r,
          targetC.g,
          targetC.b
        );

        const tanC = new THREE.Color('#cbd5e1');
        setSeg(
          aimPreview.ghostX,
          aimPreview.ghostY,
          aimPreview.ghostX + aimPreview.tangentDirX * 7.5,
          aimPreview.ghostY + aimPreview.tangentDirY * 7.5,
          tanC.r,
          tanC.g,
          tanC.b
        );
      }

      this.normalAimGeo.setDrawRange(0, vIdx);
      this.normalAimGeo.attributes.position.needsUpdate = true;
      this.normalAimGeo.attributes.color.needsUpdate = true;
      this.normalAimLine.visible = true;

      const wrappedGhostX = isInfinite
        ? ((aimPreview.ghostX % TABLE_LENGTH) + TABLE_LENGTH) % TABLE_LENGTH
        : aimPreview.ghostX;
      const wrappedGhostY = isInfinite
        ? ((aimPreview.ghostY % TABLE_WIDTH) + TABLE_WIDTH) % TABLE_WIDTH
        : aimPreview.ghostY;

      this.ghostBallMesh.visible = true;
      this.ghostBallMesh.position.set(
        txToWorldX(wrappedGhostX),
        BALL_RADIUS,
        tyToWorldZ(wrappedGhostY)
      );
      (this.ghostBallMesh.material as THREE.MeshPhysicalMaterial).color.set(
        legal ? '#e0f2fe' : '#fca5a5'
      );

      this.ghostBallRing.visible = true;
      this.ghostBallRing.position.set(
        txToWorldX(wrappedGhostX),
        0.04,
        tyToWorldZ(wrappedGhostY)
      );
      (this.ghostBallRing.material as THREE.MeshBasicMaterial).color.set(
        legal ? '#38bdf8' : '#f87171'
      );
    }
  }

  private updateCueStick(state: GameState, input: RenderInputState, dt: number): void {
    const cueBall = state.balls.find((b) => b.id === 0);

    if (this.strikeAnimActive) {
      this.strikeAnimElapsed += dt;
      const strikeDuration = 0.085;
      const lingerDuration = 0.24;

      if (this.strikeAnimElapsed <= strikeDuration + lingerDuration) {
        this.cuePivot.visible = true;
        const wx = txToWorldX(this.strikeCueX);
        const wz = tyToWorldZ(this.strikeCueY);

        let tipGap: number;
        if (this.strikeAnimElapsed < strikeDuration) {
          const t = this.strikeAnimElapsed / strikeDuration;
          const eased = 1 - t * t;
          tipGap = BALL_RADIUS + 0.05 + this.strikeStartPull * 13.5 * eased;
        } else {
          const followT = (this.strikeAnimElapsed - strikeDuration) / lingerDuration;
          tipGap = BALL_RADIUS - 0.35 * Math.sin(Math.min(1, followT * 2.2) * Math.PI * 0.5);
        }

        this.positionCuePivot(
          wx,
          wz,
          this.strikeAngle,
          tipGap,
          this.strikeSpinX,
          this.strikeSpinY
        );
        return;
      } else {
        this.strikeAnimActive = false;
      }
    }

    const showCue =
      input.showAim &&
      Boolean(cueBall && !cueBall.pocketed) &&
      state.winner === null &&
      !input.isDraggingCueBall;

    this.cuePivot.visible = showCue;
    if (!showCue || !cueBall) return;

    const pull = input.pullBackAmount || input.shotPower || 0;
    const tipGap = BALL_RADIUS + 0.65 + pull * 13.5;
    this.positionCuePivot(
      txToWorldX(cueBall.x),
      tyToWorldZ(cueBall.y),
      input.aimAngle,
      tipGap,
      input.spinX,
      input.spinY
    );
  }

  private positionCuePivot(
    cueWx: number,
    cueWz: number,
    aimAngle: number,
    tipOffsetFromCenter: number,
    spinX: number,
    spinY: number
  ): void {
    this.cuePivot.position.set(cueWx, BALL_RADIUS, cueWz);
    this.cuePivot.rotation.set(0, -aimAngle, 0);

    const englishOffsetZ = clamp(spinX, -1, 1) * BALL_RADIUS * 0.58;
    const englishOffsetY = clamp(spinY, -1, 1) * BALL_RADIUS * 0.58;
    this.cueStickMeshGroup.position.set(-tipOffsetFromCenter, englishOffsetY, englishOffsetZ);
  }

  public render(
    state: GameState,
    input: RenderInputState,
    aimPreview: AimPreview | null,
    cheatPreview: CheatPreview | null,
    isSimulating: boolean,
    isMyTurn: boolean,
    dt: number
  ): void {
    this.animClock += dt;

    const isInfinite = hasModifier(state, 'infinite');
    const isPortals = hasModifier(state, 'portals');
    const isPinball = hasModifier(state, 'pinball');
    const isBlackHole = hasModifier(state, 'blackhole');
    const isFrictionless = hasModifier(state, 'frictionless');

    this.standardTableGroup.visible = !isInfinite;
    this.infiniteTableGroup.visible = isInfinite;

    if (!isInfinite) {
      this.portalsDecorGroup.visible = isPortals;
      this.pinballDecorGroup.visible = isPinball;
      this.blackHoleDecorGroup.visible = isBlackHole;

      const targetCloth = isFrictionless ? this.iceClothMat : this.classicClothMat;
      const targetCushion = isFrictionless ? this.iceCushionMat : this.classicCushionMat;
      if (this.slateBedMesh.material !== targetCloth) {
        this.slateBedMesh.material = targetCloth;
        for (const cm of this.cushionMeshes) {
          cm.material = targetCushion;
        }
      }
      this.kitchenZoneMesh.visible = state.isBreakShot && state.ballInHand;
      (this.headStringLine.material as THREE.LineBasicMaterial).opacity =
        state.isBreakShot && state.ballInHand ? 0.38 : 0.14;
    } else {
      this.infinitePortalsGroup.visible = isPortals;
      this.infiniteBlackHoleGroup.visible = isBlackHole;
      const targetCloth = isFrictionless ? this.iceClothMat : this.classicClothMat;
      if (this.infiniteCenterBedMesh.material !== targetCloth) {
        this.infiniteCenterBedMesh.material = targetCloth;
      }
    }

    this.updatePocketDrops(state, dt, isSimulating);

    const pockets: readonly PocketLike[] = isInfinite ? INFINITE_POCKETS : POCKETS;
    for (const b of state.balls) {
      const mesh = this.ballMeshes[b.id];
      const dirShadow = this.ballShadows[b.id];
      const tightShadow = this.ballAmbientShadows[b.id];
      if (!mesh) continue;

      if (!b.pocketed) {
        let lipDip = 0;
        for (const pk of pockets) {
          if (isPortals && pk.type === 'side') continue;
          const px = pocketRenderX(pk);
          const py = pocketRenderY(pk);
          const d = Math.hypot(b.x - px, b.y - py);
          if (d < pk.renderRadius + 0.25) {
            const t = clamp(1 - d / (pk.renderRadius + 0.25), 0, 1);
            lipDip = Math.max(lipDip, t * t * 0.55);
          }
        }

        const wx = txToWorldX(b.x);
        const wz = tyToWorldZ(b.y);
        const wy = BALL_RADIUS - lipDip;
        const [qx3, qy3, qz3, qw3] = engineQuatToThreeQuat(b.qx, b.qy, b.qz, b.qw);

        mesh.visible = true;
        mesh.position.set(wx, wy, wz);
        mesh.quaternion.set(qx3, qy3, qz3, qw3);

        const shadowFade = clamp(1 - lipDip * 1.6, 0, 1);
        dirShadow.visible = shadowFade > 0.02;
        tightShadow.visible = shadowFade > 0.02;
        if (dirShadow.visible) {
          dirShadow.position.set(wx + wx * 0.012, 0.02, wz + wz * 0.012);
          (dirShadow.material as THREE.MeshBasicMaterial).opacity = 0.42 * shadowFade;
          tightShadow.position.set(wx, 0.024, wz);
          (tightShadow.material as THREE.MeshBasicMaterial).opacity = 0.6 * shadowFade;
        }
      } else {
        dirShadow.visible = false;
        tightShadow.visible = false;
        const drop = this.dropStates.get(b.id);
        if (drop) {
          const [qx3, qy3, qz3, qw3] = engineQuatToThreeQuat(
            drop.qx,
            drop.qy,
            drop.qz,
            drop.qw
          );
          mesh.visible = true;
          mesh.position.set(txToWorldX(drop.x), drop.height, tyToWorldZ(drop.y));
          mesh.quaternion.set(qx3, qy3, qz3, qw3);
        } else {
          mesh.visible = false;
        }
      }
    }

    let poolIdx = 0;
    if (isInfinite) {
      const bdr = 18.0;
      for (const b of state.balls) {
        if (b.pocketed) continue;
        const [qx3, qy3, qz3, qw3] = engineQuatToThreeQuat(b.qx, b.qy, b.qz, b.qw);
        for (let gx = -1; gx <= 1; gx++) {
          for (let gy = -1; gy <= 1; gy++) {
            if (gx === 0 && gy === 0) continue;
            const nx = b.x + gx * TABLE_LENGTH;
            const ny = b.y + gy * TABLE_WIDTH;
            if (
              nx < -bdr - BALL_RADIUS ||
              nx > TABLE_LENGTH + bdr + BALL_RADIUS ||
              ny < -bdr - BALL_RADIUS ||
              ny > TABLE_WIDTH + bdr + BALL_RADIUS
            ) {
              continue;
            }
            if (poolIdx >= this.infiniteBallPool.length) break;
            const ghost = this.infiniteBallPool[poolIdx++];
            ghost.visible = true;
            const straddlingMain =
              nx + BALL_RADIUS > 0 &&
              nx - BALL_RADIUS < TABLE_LENGTH &&
              ny + BALL_RADIUS > 0 &&
              ny - BALL_RADIUS < TABLE_WIDTH;
            ghost.material = straddlingMain ? this.ballMaterials[b.id] : this.infiniteBallMats[b.id];
            ghost.position.set(txToWorldX(nx), BALL_RADIUS, tyToWorldZ(ny));
            ghost.quaternion.set(qx3, qy3, qz3, qw3);
          }
        }
      }
    }
    for (let i = poolIdx; i < this.infiniteBallPool.length; i++) {
      this.infiniteBallPool[i].visible = false;
    }

    const cueBall = state.balls.find((b) => b.id === 0);
    const showBih = Boolean(state.ballInHand && cueBall && !cueBall.pocketed && state.winner === null);
    this.bihHaloGroup.visible = showBih;
    if (showBih && cueBall) {
      this.bihHaloGroup.position.x = txToWorldX(cueBall.x);
      this.bihHaloGroup.position.z = tyToWorldZ(cueBall.y);
      const pulse = input.isDraggingCueBall ? 1.14 : 1.0 + Math.sin(this.animClock * 4.5) * 0.05;
      this.bihHaloGroup.scale.set(pulse, 1, pulse);
    }

    this.updateAimAndCheatVisuals(state, input, aimPreview, cheatPreview);
    this.updateCueStick(state, input, dt);
    this.updateCamera(state, input, aimPreview, isSimulating, isMyTurn, dt);

    this.renderer.render(this.scene, this.camera);
  }
}
