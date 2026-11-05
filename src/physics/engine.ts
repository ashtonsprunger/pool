import {
  BALL_DIAMETER,
  BALL_FRICTION,
  BALL_RADIUS,
  BALL_RESTITUTION,
  CUSHION_FRICTION,
  CUSHION_RESTITUTION,
  CUSHION_SEGMENTS,
  FIXED_DT,
  GRAVITY,
  JAW_KNUCKLES,
  MAX_SHOT_SPEED,
  MU_ROLL,
  MU_SLIDE,
  MU_SPIN,
  POCKETS,
  STOP_SPEED_THRESHOLD,
  STOP_SPIN_THRESHOLD,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from './constants';
import { clamp, closestPointOnSegment } from './vector';

export interface BallState {
  id: number;          // 0 = cue ball, 1..7 = solids, 8 = eight ball, 9..15 = stripes
  x: number;           // X position in inches [0, 100]
  y: number;           // Y position in inches [0, 50]
  vx: number;          // Linear velocity X (in/s)
  vy: number;          // Linear velocity Y (in/s)
  wx: number;          // Angular velocity around X axis (rad/s)
  wy: number;          // Angular velocity around Y axis (rad/s)
  wz: number;          // Angular velocity around Z axis / sidespin (rad/s)
  pocketed: boolean;   // Whether pocketed
  pocketId: number | null; // ID of pocket it dropped into
  // Visual orientation quaternion [x, y, z, w] for authentic 3D ball rolling render
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface ShotTelemetry {
  firstContactBallId: number | null;
  pocketedBallIds: number[];
  cushionContactsAfterFirstHit: number;
  objectBallsDrivenToCushion: Set<number>;
  cueBallPocketed: boolean;
}

export function createInitialTelemetry(): ShotTelemetry {
  return {
    firstContactBallId: null,
    pocketedBallIds: [],
    cushionContactsAfterFirstHit: 0,
    objectBallsDrivenToCushion: new Set<number>(),
    cueBallPocketed: false,
  };
}

export function createBall(id: number, x: number, y: number): BallState {
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    pocketed: false,
    pocketId: null,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
  };
}

export function cloneBalls(balls: readonly BallState[]): BallState[] {
  return balls.map((b) => ({ ...b }));
}

export interface CueStrikeParams {
  angle: number;       // Aim direction in radians
  power: number;       // Normalized power in [0, 1]
  spinX: number;       // Left/Right english in [-1, 1] (positive = right english)
  spinY: number;       // Bottom/Top spin in [-1, 1] (positive = topspin/follow, negative = backspin/draw)
}

/**
 * Applies a physical cue stick strike to the cue ball.
 * Models off-center impact on a homogeneous sphere (I = 2/5 m R^2).
 */
export function applyCueStrike(cueBall: BallState, params: CueStrikeParams): void {
  if (!Number.isFinite(params.power) || params.power <= 0) {
    cueBall.vx = 0;
    cueBall.vy = 0;
    cueBall.wx = 0;
    cueBall.wy = 0;
    cueBall.wz = 0;
    return;
  }
  const angle = Number.isFinite(params.angle) ? params.angle : 0;
  const power = clamp(params.power, 0.01, 1.0);
  // Non-linear power curve for fine touch on soft shots and full power on breaks
  const speed = MAX_SHOT_SPEED * Math.pow(power, 1.15);

  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  // Clamp tip offset to miscue limit (|s| <= 0.85)
  let sx = Number.isFinite(params.spinX) ? params.spinX : 0;
  let sy = Number.isFinite(params.spinY) ? params.spinY : 0;
  const sMag = Math.hypot(sx, sy);
  if (sMag > 0.85) {
    sx = (sx / sMag) * 0.85;
    sy = (sy / sMag) * 0.85;
  }

  cueBall.vx = dirX * speed;
  cueBall.vy = dirY * speed;

  // Top/back spin axis is perpendicular to shot direction in the XY plane: (-dirY, dirX)
  // For pure rolling, w_roll = speed / R. With full topspin/draw, omega reaches ~2.2 * speed / R.
  const topSpinRate = (2.5 * speed * sy) / BALL_RADIUS;
  cueBall.wx = -dirY * topSpinRate;
  cueBall.wy = dirX * topSpinRate;

  // Sidespin (English) around vertical Z axis
  cueBall.wz = -(2.2 * speed * sx) / BALL_RADIUS;
}

/**
 * Updates visual 3D rotation quaternion of a ball from its angular velocity (wx, wy, wz).
 */
function integrateQuaternion(b: BallState, dt: number): void {
  const wx = b.wx;
  const wy = b.wy;
  const wz = b.wz;
  const wMag = Math.hypot(wx, wy, wz);
  if (wMag < 1e-6) return;

  const halfAngle = 0.5 * wMag * dt;
  const s = Math.sin(halfAngle) / wMag;
  const dqW = Math.cos(halfAngle);
  const dqX = wx * s;
  const dqY = wy * s;
  const dqZ = wz * s;

  // q_new = dq * q
  const nx = dqW * b.qx + dqX * b.qw + dqY * b.qz - dqZ * b.qy;
  const ny = dqW * b.qy - dqX * b.qz + dqY * b.qw + dqZ * b.qx;
  const nz = dqW * b.qz + dqX * b.qy - dqY * b.qx + dqZ * b.qw;
  const nw = dqW * b.qw - dqX * b.qx - dqY * b.qy - dqZ * b.qz;

  const norm = Math.hypot(nx, ny, nz, nw) || 1;
  b.qx = nx / norm;
  b.qy = ny / norm;
  b.qz = nz / norm;
  b.qw = nw / norm;
}

/**
 * Advances a single ball's position, linear velocity, and 3D angular velocity over dt,
 * accurately modeling the transition from sliding friction (MU_SLIDE) to rolling resistance (MU_ROLL).
 * In frictionless mode, cloth friction is completely removed so balls glide without deceleration.
 */
function stepBallMotion(b: BallState, dt: number, frictionless: boolean = false): void {
  if (b.pocketed) return;

  // 1. Advance position
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  if (frictionless) {
    const vMag = Math.hypot(b.vx, b.vy);
    // Stop cutoff once pocketed balls and collisions/rails have drained kinetic energy
    if (vMag < 1.1) {
      b.vx = 0;
      b.vy = 0;
      b.wx = 0;
      b.wy = 0;
      b.wz = 0;
      return;
    }
    b.wy = b.vx / BALL_RADIUS;
    b.wx = -b.vy / BALL_RADIUS;
    integrateQuaternion(b, dt);
    return;
  }

  // 2. Cloth contact point relative to ball center is (0, 0, -R).
  // Slip velocity of ball bottom relative to cloth: u = v + w x (0, 0, -R) = (vx - R*wy, vy + R*wx)
  const ux = b.vx - BALL_RADIUS * b.wy;
  const uy = b.vy + BALL_RADIUS * b.wx;
  const uMag = Math.hypot(ux, uy);

  // Rate at which slip speed closes under sliding friction is (7/2) * mu_s * g
  const maxSlipDelta = 3.5 * MU_SLIDE * GRAVITY * dt;

  if (uMag > maxSlipDelta && uMag > 1e-5) {
    // Ball remains in SLIDING regime throughout dt
    const invU = 1 / uMag;
    const dv = MU_SLIDE * GRAVITY * dt;
    b.vx -= dv * ux * invU;
    b.vy -= dv * uy * invU;

    const dw = (2.5 * MU_SLIDE * GRAVITY * dt) / BALL_RADIUS;
    b.wx -= dw * uy * invU;
    b.wy += dw * ux * invU;
  } else {
    // Ball transitions to (or is already in) PURE ROLLING regime
    if (uMag > 1e-6) {
      // Apply the exact (2/7) impulse needed to zero out slip
      b.vx -= (2 / 7) * ux;
      b.vy -= (2 / 7) * uy;
    }

    // Apply rolling resistance over remaining time
    const vMag = Math.hypot(b.vx, b.vy);
    const rollDecel = MU_ROLL * GRAVITY * dt;
    if (vMag > rollDecel && vMag > STOP_SPEED_THRESHOLD) {
      const scale = (vMag - rollDecel) / vMag;
      b.vx *= scale;
      b.vy *= scale;
    } else {
      b.vx = 0;
      b.vy = 0;
    }

    // Lock horizontal spin to pure rolling condition: u = 0 => wy = vx/R, wx = -vy/R
    b.wy = b.vx / BALL_RADIUS;
    b.wx = -b.vy / BALL_RADIUS;
  }

  // 3. Vertical-axis spin (English / wz) decay due to cloth rotational friction
  const wzDecel = ((2.5 * MU_SPIN * GRAVITY) / BALL_RADIUS) * dt;
  if (Math.abs(b.wz) > wzDecel && Math.abs(b.wz) > STOP_SPIN_THRESHOLD) {
    b.wz -= Math.sign(b.wz) * wzDecel;
  } else {
    b.wz = 0;
  }

  // Snap to complete rest if below thresholds
  if (
    Math.hypot(b.vx, b.vy) < STOP_SPEED_THRESHOLD &&
    Math.hypot(b.wx, b.wy) * BALL_RADIUS < STOP_SPEED_THRESHOLD
  ) {
    b.vx = 0;
    b.vy = 0;
    b.wx = 0;
    b.wy = 0;
  }

  integrateQuaternion(b, dt);
}

/**
 * Checks if any ball has entered a pocket's drop zone.
 */
function checkPockets(balls: BallState[], telemetry: ShotTelemetry): void {
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.pocketed) continue;

    for (let p = 0; p < POCKETS.length; p++) {
      const pocket = POCKETS[p];
      const dx = b.x - pocket.x;
      const dy = b.y - pocket.y;
      if (dx * dx + dy * dy <= pocket.radius * pocket.radius) {
        b.pocketed = true;
        b.pocketId = pocket.id;
        b.vx = 0;
        b.vy = 0;
        b.wx = 0;
        b.wy = 0;
        b.wz = 0;
        if (b.id === 0) {
          telemetry.cueBallPocketed = true;
        } else if (!telemetry.pocketedBallIds.includes(b.id)) {
          telemetry.pocketedBallIds.push(b.id);
        }
        break;
      }
    }
  }
}

/**
 * Resolves collisions between a ball and cushion segments + jaw knuckles,
 * incorporating restitution, english (wz) throw, and topspin/backspin retention.
 */
function resolveCushionCollisions(
  balls: BallState[],
  telemetry: ShotTelemetry,
  frictionless: boolean = false
): void {
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.pocketed) continue;

    // Skip cushion collision if ball is already deep inside a pocket capture zone
    let inPocketThroat = false;
    for (let p = 0; p < POCKETS.length; p++) {
      const pk = POCKETS[p];
      if (Math.hypot(b.x - pk.x, b.y - pk.y) < pk.radius * 0.98) {
        inPocketThroat = true;
        break;
      }
    }
    if (inPocketThroat) continue;

    let hitRailThisStep = false;

    // 1. Check line segments (interior of segments: 0 < t < 1)
    for (let s = 0; s < CUSHION_SEGMENTS.length; s++) {
      const seg = CUSHION_SEGMENTS[s];
      const cp = closestPointOnSegment(b.x, b.y, seg.ax, seg.ay, seg.bx, seg.by);
      if (cp.t <= 0.0001 || cp.t >= 0.9999) continue;

      const dx = b.x - cp.x;
      const dy = b.y - cp.y;
      const dist = Math.hypot(dx, dy);

      if (dist < BALL_RADIUS) {
        const nx = seg.nx;
        const ny = seg.ny;
        // Ignore back-face contacts if a ball is behind a jaw segment
        const signedDist = dx * nx + dy * ny;
        if (signedDist < -BALL_RADIUS * 0.4) continue;

        const penetration = BALL_RADIUS - dist;
        b.x += nx * penetration;
        b.y += ny * penetration;

        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          applyCushionImpulse(b, nx, ny, -vn, seg.isJaw, frictionless);
          if (!seg.isJaw) {
            hitRailThisStep = true;
          }
        }
      }
    }

    // 2. Check jaw knuckle vertices (rounded point corners where main rails meet pocket jaws)
    for (let k = 0; k < JAW_KNUCKLES.length; k++) {
      const kn = JAW_KNUCKLES[k];
      const dx = b.x - kn.x;
      const dy = b.y - kn.y;
      const dist = Math.hypot(dx, dy);
      if (dist < BALL_RADIUS && dist > 1e-6) {
        const nx = dx / dist;
        const ny = dy / dist;
        const penetration = BALL_RADIUS - dist;
        b.x += nx * penetration;
        b.y += ny * penetration;

        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          applyCushionImpulse(b, nx, ny, -vn, true, frictionless);
          hitRailThisStep = true;
        }
      }
    }

    // Safety outer boundary clamp outside the 2.0-in pocket throats
    const throatMargin = 2.5;
    const minBoundX = -throatMargin;
    const maxBoundX = TABLE_LENGTH + throatMargin;
    const minBoundY = -throatMargin;
    const maxBoundY = TABLE_WIDTH + throatMargin;
    if (b.x < minBoundX) { b.x = minBoundX; if (b.vx < 0) b.vx = -b.vx * 0.5; }
    if (b.x > maxBoundX) { b.x = maxBoundX; if (b.vx > 0) b.vx = -b.vx * 0.5; }
    if (b.y < minBoundY) { b.y = minBoundY; if (b.vy < 0) b.vy = -b.vy * 0.5; }
    if (b.y > maxBoundY) { b.y = maxBoundY; if (b.vy > 0) b.vy = -b.vy * 0.5; }

    if (hitRailThisStep) {
      if (telemetry.firstContactBallId !== null) {
        telemetry.cushionContactsAfterFirstHit++;
      }
      if (b.id !== 0) {
        telemetry.objectBallsDrivenToCushion.add(b.id);
      }
    }
  }
}

/**
 * Applies physical cushion rebound impulse including K-66 rubber restitution,
 * running/reverse sidespin (english) throw, and high-nose cushion contact spin effects.
 */
function applyCushionImpulse(
  b: BallState,
  nx: number,
  ny: number,
  approachSpeed: number,
  isJaw: boolean,
  frictionless: boolean = false
): void {
  // Tangent vector t = (-ny, nx) so that n x t = +z
  const tx = -ny;
  const ty = nx;

  const vt = b.vx * tx + b.vy * ty;
  if (frictionless) {
    // Dampen both normal and tangential velocity on rail bounce so shallow and direct rail hits lose energy
    const normalRestitution = isJaw ? 0.66 : 0.74;
    const tangentRetention = 0.84;
    const newVn = Math.max(0, approachSpeed * normalRestitution);
    const newVt = vt * tangentRetention;
    b.vx = nx * newVn + tx * newVt;
    b.vy = ny * newVn + ty * newVt;
    return;
  }

  const restitution = isJaw ? CUSHION_RESTITUTION * 0.85 : CUSHION_RESTITUTION;

  // Normal rebound velocity
  // Forward/backward spin perpendicular to cushion (w_t = wx*tx + wy*ty) slightly modifies rebound
  const wt = b.wx * tx + b.wy * ty;
  const spinNormalBoost = clamp(-wt * BALL_RADIUS * 0.08, -approachSpeed * 0.2, approachSpeed * 0.2);
  const newVn = Math.max(0, approachSpeed * restitution + spinNormalBoost);

  // Tangential slip at cushion nose due to tangential motion and english (wz)
  const slipT = vt - BALL_RADIUS * b.wz;
  const maxFrictionImpulse = CUSHION_FRICTION * (1 + restitution) * approachSpeed;
  const dVt = -Math.sign(slipT) * Math.min(maxFrictionImpulse, (2 / 7) * Math.abs(slipT));

  const newVt = vt + dVt;
  b.wz -= (2.5 * dVt) / BALL_RADIUS;

  // Dampen normal-axis spin slightly from cushion nose compression
  b.wx *= 0.82;
  b.wy *= 0.82;

  b.vx = nx * newVn + tx * newVt;
  b.vy = ny * newVn + ty * newVt;
}

/**
 * Resolves all ball-to-ball collisions with restitution and frictional throw/spin transfer.
 * Uses multi-pass relaxation so tight 15-ball racks propagate impulse without ID-order bias.
 */
function resolveBallBallCollisions(
  balls: BallState[],
  telemetry: ShotTelemetry,
  frictionless: boolean = false
): void {
  const n = balls.length;
  for (let pass = 0; pass < 3; pass++) {
    let anyCollision = false;

    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (a.pocketed) continue;

      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (b.pocketed) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < BALL_DIAMETER * BALL_DIAMETER) {
          anyCollision = true;
          const dist = Math.sqrt(distSq) || 1e-6;
          // Normal from A to B
          const nx = dx / dist;
          const ny = dy / dist;

          // Positional separation (equal mass)
          const overlap = BALL_DIAMETER - dist;
          if (overlap > 0) {
            const sep = overlap * 0.5005;
            a.x -= nx * sep;
            a.y -= ny * sep;
            b.x += nx * sep;
            b.y += ny * sep;
          }

          // Record first object ball contacted by the cue ball
          if (telemetry.firstContactBallId === null) {
            if (a.id === 0 && b.id !== 0) {
              telemetry.firstContactBallId = b.id;
            } else if (b.id === 0 && a.id !== 0) {
              telemetry.firstContactBallId = a.id;
            }
          }

          // Relative velocity along normal
          const rvx = a.vx - b.vx;
          const rvy = a.vy - b.vy;
          const vn = rvx * nx + rvy * ny;

          if (vn > 0) {
            const restitution = frictionless ? 0.80 : BALL_RESTITUTION;
            // Normal impulse for equal-mass spheres with restitution e
            const jn = 0.5 * (1 + restitution) * vn;

            // Tangent vector t = (-ny, nx)
            const tx = -ny;
            const ty = nx;

            // Tangential relative surface velocity at point of contact (+R*n on A, -R*n on B):
            // With our wz convention (where surface vel at -R*n is vt - R*wz),
            // surface vel at +R*n on A is v_At + R*a.wz, and at -R*n on B is v_Bt - R*b.wz.
            const vt = rvx * tx + rvy * ty + BALL_RADIUS * (a.wz + b.wz);
            const jt = -Math.sign(vt) * Math.min(BALL_FRICTION * jn, (1 / 7) * Math.abs(vt));

            a.vx -= jn * nx - jt * tx;
            a.vy -= jn * ny - jt * ty;
            b.vx += jn * nx - jt * tx;
            b.vy += jn * ny - jt * ty;

            if (frictionless) {
              // Absorb energy on each ball-to-ball impact so multi-ball hits noticeably lose speed
              a.vx *= 0.92;
              a.vy *= 0.92;
              b.vx *= 0.92;
              b.vy *= 0.92;
            }

            // Spin transfer around Z axis (gearing english opposes relative slip)
            const dwz = (2.5 * jt) / BALL_RADIUS;
            a.wz += dwz;
            b.wz += dwz;
          }
        }
      }
    }

    if (!anyCollision) break;
  }
}

/**
 * Returns the maximum linear speed (in/s) among all non-pocketed balls on the table.
 */
export function getMaxBallSpeed(balls: readonly BallState[]): number {
  let maxSpeed = 0;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.pocketed) {
      const spd = Math.hypot(b.vx, b.vy);
      if (spd > maxSpeed) maxSpeed = spd;
    }
  }
  return maxSpeed;
}

/**
 * Advances the entire table physics by one fixed timestep (FIXED_DT = 1/240 s),
 * dynamically subdividing into micro-steps when balls are moving fast to prevent tunneling.
 */
export function stepPhysics(
  balls: BallState[],
  telemetry: ShotTelemetry,
  dt: number = FIXED_DT,
  frictionless: boolean = false
): boolean {
  const maxSpeed = getMaxBallSpeed(balls);

  // Adaptive sub-stepping: ensure no ball moves more than 0.22 * BALL_RADIUS per micro-step
  const maxStepDist = BALL_RADIUS * 0.22;
  const subSteps = clamp(Math.ceil((maxSpeed * dt) / maxStepDist), 1, 10);
  const subDt = dt / subSteps;

  for (let s = 0; s < subSteps; s++) {
    for (let i = 0; i < balls.length; i++) {
      stepBallMotion(balls[i], subDt, frictionless);
    }
    checkPockets(balls, telemetry);
    resolveBallBallCollisions(balls, telemetry, frictionless);
    resolveCushionCollisions(balls, telemetry, frictionless);
    checkPockets(balls, telemetry);
  }

  return areBallsMoving(balls);
}

/**
 * Returns true if any non-pocketed ball still has non-zero linear or angular velocity.
 */
export function areBallsMoving(balls: readonly BallState[]): boolean {
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.pocketed) continue;
    if (
      Math.abs(b.vx) > 0 ||
      Math.abs(b.vy) > 0 ||
      Math.abs(b.wx) > 0 ||
      Math.abs(b.wy) > 0 ||
      Math.abs(b.wz) > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Runs a shot synchronously to completion (until all balls stop moving)
 * for deterministic verification, testing, or mid-shot tab-reopen recovery.
 */
export function simulateUntilRest(
  balls: BallState[],
  telemetry: ShotTelemetry,
  maxSteps?: number,
  frictionless: boolean = false
): number {
  const effectiveMaxSteps = maxSteps ?? (frictionless ? 240 * 35 : 240 * 25);
  let steps = 0;
  while (steps < effectiveMaxSteps && areBallsMoving(balls)) {
    stepPhysics(balls, telemetry, FIXED_DT, frictionless);
    steps++;
  }
  // Ensure clean stop if maxSteps reached
  if (steps >= effectiveMaxSteps) {
    for (const b of balls) {
      b.vx = 0;
      b.vy = 0;
      b.wx = 0;
      b.wy = 0;
      b.wz = 0;
    }
  }
  return steps;
}
