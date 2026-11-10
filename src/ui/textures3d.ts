import * as THREE from 'three';
import { BALL_COLORS } from '../physics/constants';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function renderMedallionStamp(ballId: number): ImageData {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cx = size * 0.5;
  const cy = size * 0.5;
  const r = size * 0.46;

  ctx.clearRect(0, 0, size, size);

  // Warm phenolic ivory medallion circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#F7F5EC';
  ctx.fill();

  // Crisp tournament numeral
  ctx.fillStyle = '#111827';
  const isTwoDigit = ballId >= 10;
  ctx.font = `800 ${isTwoDigit ? 56 : 64}px Inter, system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(ballId), cx, cy + 2);

  // Classic underline bar on 6 and 9 so orientation is unambiguous from any 3D angle
  if (ballId === 6 || ballId === 9) {
    ctx.fillRect(cx - 14, cy + 31, 28, 4.5);
  }

  return ctx.getImageData(0, 0, size, size);
}

function sampleStampBilinear(stamp: ImageData, u: number, v: number): [number, number, number, number] {
  const w = stamp.width;
  const h = stamp.height;
  const fx = Math.max(0, Math.min(w - 1.001, u * (w - 1)));
  const fy = Math.max(0, Math.min(h - 1.001, v * (h - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const data = stamp.data;
  const i00 = (y0 * w + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + w * 4;
  const i11 = i01 + 4;

  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const bot = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = top * (1 - ty) + bot * ty;
  }
  return out;
}

/**
 * Generates distortion-free 3D equirectangular textures for all 16 Aramith tournament balls (0..15).
 * Sampling directly in 3D unit-sphere coordinates avoids UV pole pinching so numbers, stripes,
 * and cue-ball measles dots remain razor-sharp at every roll angle.
 */
export function createBallTextures(maxAnisotropy: number = 4): THREE.CanvasTexture[] {
  const W = 512;
  const H = 256;
  const ivory: [number, number, number] = [247, 245, 236];
  const measlesRed: [number, number, number] = [214, 34, 46];
  const textures: THREE.CanvasTexture[] = [];

  // Precompute unit sphere normal table once for all 16 balls
  const normals = new Float32Array(W * H * 3);
  let ptr = 0;
  for (let py = 0; py < H; py++) {
    const theta = ((py + 0.5) / H) * Math.PI; // 0 at north pole (+Y), PI at south pole (-Y)
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let px = 0; px < W; px++) {
      const phi = ((px + 0.5) / W) * Math.PI * 2;
      normals[ptr++] = -Math.cos(phi) * sinT;
      normals[ptr++] = cosT;
      normals[ptr++] = Math.sin(phi) * sinT;
    }
  }

  for (let id = 0; id <= 15; id++) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const data = img.data;

    const ballRgb = hexToRgb(BALL_COLORS[id] || '#FFFFFF');
    const isStripe = id >= 9 && id <= 15;
    const stamp = id > 0 ? renderMedallionStamp(id) : null;
    const medRadius = 0.42;

    for (let i = 0, nIdx = 0; i < W * H; i++, nIdx += 3) {
      const nx = normals[nIdx];
      const ny = normals[nIdx + 1];
      const nz = normals[nIdx + 2];

      let r = ivory[0];
      let g = ivory[1];
      let b = ivory[2];

      if (id === 0) {
        // Aramith Pro-Cup 6-dot measles cue ball
        const maxAxis = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
        const angle = Math.acos(Math.min(1, maxAxis));
        const dotRadius = 0.145;
        const aa = 0.016;
        if (angle < dotRadius + aa) {
          const t = Math.max(0, Math.min(1, (dotRadius + aa - angle) / (aa * 2)));
          r = ivory[0] + (measlesRed[0] - ivory[0]) * t;
          g = ivory[1] + (measlesRed[1] - ivory[1]) * t;
          b = ivory[2] + (measlesRed[2] - ivory[2]) * t;
        }
      } else {
        if (!isStripe) {
          r = ballRgb[0];
          g = ballRgb[1];
          b = ballRgb[2];
        } else {
          // Stripe wraps cleanly across Y=±1 and X=±1, leaving ivory caps around Z=±1
          const absZ = Math.abs(nz);
          const bandHalf = 0.555;
          const aa = 0.014;
          if (absZ < bandHalf + aa) {
            const t = Math.max(0, Math.min(1, (bandHalf + aa - absZ) / (aa * 2)));
            r = ivory[0] + (ballRgb[0] - ivory[0]) * t;
            g = ivory[1] + (ballRgb[1] - ivory[1]) * t;
            b = ivory[2] + (ballRgb[2] - ivory[2]) * t;
          }
        }

        // Dual number medallions at +Y and -Y poles (un-mirrored tangent projection)
        const radialXZ = Math.hypot(nx, nz);
        if (stamp && radialXZ < medRadius) {
          const u = 0.5 + (nx / (medRadius * 2)) * 0.92;
          const v = ny >= 0 ? 0.5 + (nz / (medRadius * 2)) * 0.92 : 0.5 - (nz / (medRadius * 2)) * 0.92;
          const [sr, sg, sb, sa] = sampleStampBilinear(stamp, u, v);
          const edgeAa = Math.max(0, Math.min(1, (medRadius * 0.93 - radialXZ) / 0.018));
          const alpha = (sa / 255) * edgeAa;
          if (alpha > 0) {
            r = r + (sr - r) * alpha;
            g = g + (sg - g) * alpha;
            b = b + (sb - b) * alpha;
          }
        }
      }

      const pIdx = i * 4;
      data[pIdx] = r;
      data[pIdx + 1] = g;
      data[pIdx + 2] = b;
      data[pIdx + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.min(4, maxAnisotropy);
    tex.needsUpdate = true;
    textures.push(tex);
  }

  return textures;
}

/**
 * Generates a realistic tournament worsted Simonis cloth texture with subtle micro-weave.
 */
export function createClothTexture(
  variant: 'classic' | 'ice' = 'classic',
  maxAnisotropy: number = 4
): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const baseR = variant === 'ice' ? 18 : 16;
  const baseG = variant === 'ice' ? 92 : 108;
  const baseB = variant === 'ice' ? 116 : 68;

  // Deterministic hash so cloth grain has zero shimmering
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weave = ((x + y) & 1) === 0 ? 2.5 : -2.5;
      const cross = ((x * 3 + y * 5) & 3) === 0 ? 1.8 : -1.2;
      const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const grain = ((hash - Math.floor(hash)) - 0.5) * 6.5;
      const delta = weave + cross + grain;

      const idx = (y * size + x) * 4;
      data[idx] = Math.max(0, Math.min(255, baseR + delta * 0.65));
      data[idx + 1] = Math.max(0, Math.min(255, baseG + delta));
      data[idx + 2] = Math.max(0, Math.min(255, baseB + delta * 0.8));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 7);
  tex.anisotropy = Math.min(4, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a rich satin-varnished walnut/mahogany hardwood grain texture for the rails & cabinet.
 */
export function createWoodRailTexture(maxAnisotropy: number = 4): THREE.CanvasTexture {
  const w = 512;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x / w;
      const ny = y / h;
      const wave =
        Math.sin(ny * 28 + Math.sin(nx * Math.PI * 4) * 1.4) * 0.5 +
        Math.sin(ny * 67 + nx * 6.28318) * 0.28 +
        Math.cos(nx * 18.849 + ny * 11) * 0.22;
      const t = wave * 0.5 + 0.5;
      const r = 38 + t * 34;
      const g = 19 + t * 18;
      const b = 11 + t * 10;

      const idx = (y * w + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.anisotropy = Math.min(4, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Soft dual-gradient contact + ambient occlusion shadow texture placed on the cloth beneath each ball.
 * Gives crisp grounded ball contact without expensive mobile real-time shadow maps.
 */
export function createSoftShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);
  const cx = size * 0.5;
  const cy = size * 0.5;
  const grad = ctx.createRadialGradient(cx, cy, size * 0.04, cx, cy, size * 0.49);
  grad.addColorStop(0.0, 'rgba(0, 0, 0, 0.78)');
  grad.addColorStop(0.28, 'rgba(0, 0, 0, 0.52)');
  grad.addColorStop(0.58, 'rgba(0, 0, 0, 0.18)');
  grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a pre-filtered studio pool-hall environment map (PMREM) with a classic
 * overhead 3-lamp billiard canopy reflection so phenolic balls & brass castings gleam realistically
 * at essentially zero per-frame GPU cost.
 */
export function createPoolHallEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color('#090d12');

  // Overhead rectangular billiard canopy light box (produces authentic glossy highlights on balls)
  const canopyGeo = new THREE.PlaneGeometry(86, 30);
  const canopyMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#fff9eb').multiplyScalar(3.4),
    side: THREE.DoubleSide,
  });
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(0, 52, 0);
  canopy.rotation.x = Math.PI / 2;
  envScene.add(canopy);

  // Three bright bulb hot-spots inside the overhead billiard fixture
  const bulbGeo = new THREE.SphereGeometry(5.5, 16, 12);
  const bulbMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#ffffff').multiplyScalar(6.0),
  });
  for (const bx of [-26, 0, 26]) {
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(bx, 50, 0);
    envScene.add(bulb);
  }

  // Subtle green felt bounce from below so undersides of balls pick up green baize tint
  const bounceGeo = new THREE.PlaneGeometry(130, 70);
  const bounceMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#0f5e3a').multiplyScalar(0.85),
    side: THREE.DoubleSide,
  });
  const bounce = new THREE.Mesh(bounceGeo, bounceMat);
  bounce.position.set(0, -18, 0);
  bounce.rotation.x = -Math.PI / 2;
  envScene.add(bounce);

  // Subtle cool architectural rim panels around the perimeter
  const rimGeo = new THREE.PlaneGeometry(120, 22);
  const rimMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#38bdf8').multiplyScalar(0.42),
    side: THREE.DoubleSide,
  });
  for (const rz of [-78, 78]) {
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.set(0, 22, rz);
    envScene.add(rim);
  }

  const rt = pmrem.fromScene(envScene, 0.035);
  pmrem.dispose();
  canopyGeo.dispose();
  canopyMat.dispose();
  bulbGeo.dispose();
  bulbMat.dispose();
  bounceGeo.dispose();
  bounceMat.dispose();
  rimGeo.dispose();
  rimMat.dispose();

  return rt.texture;
}
