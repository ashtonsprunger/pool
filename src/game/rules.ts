import {
  BALL_DIAMETER,
  BALL_RADIUS,
  CORNER_JAW_OFFSET,
  FIXED_DT,
  FOOT_SPOT,
  HEAD_SPOT,
  HEAD_STRING_X,
  POCKETS,
  SIDE_JAW_HALF_WIDTH,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from '../physics/constants';
import {
  BallState,
  CueStrikeParams,
  ShotTelemetry,
  applyCueStrike,
  areBallsMoving,
  cloneBalls,
  createBall,
  createInitialTelemetry,
  stepPhysics,
} from '../physics/engine';
import { clamp } from '../physics/vector';

export type BallGroup = 'solids' | 'stripes';
export type PlayerIndex = 0 | 1;

export interface GameState {
  seq: number;
  updatedAt: number;
  rackSeed: number;
  cheatMode?: boolean;
  balls: BallState[];
  currentPlayer: PlayerIndex;
  playerGroups: [BallGroup | null, BallGroup | null];
  tableOpen: boolean;
  isBreakShot: boolean;
  ballInHand: boolean;
  winner: PlayerIndex | null;
  statusMessage: string;
  lastFoulReason: string | null;
  shotCount: number;
}

export function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    balls: cloneBalls(state.balls),
    playerGroups: [state.playerGroups[0], state.playerGroups[1]],
  };
}

export function getBallGroup(ballId: number): BallGroup | 'eight' | 'cue' {
  if (ballId === 0) return 'cue';
  if (ballId === 8) return 'eight';
  if (ballId >= 1 && ballId <= 7) return 'solids';
  return 'stripes';
}

export function getRemainingBallsForGroup(balls: readonly BallState[], group: BallGroup): BallState[] {
  return balls.filter((b) => !b.pocketed && getBallGroup(b.id) === group);
}

export function isPlayerOnEightBall(state: GameState, player: PlayerIndex): boolean {
  const group = state.playerGroups[player];
  if (!group) return false;
  return getRemainingBallsForGroup(state.balls, group).length === 0;
}

/**
 * Simple deterministic Mulberry32 PRNG so both peers generate identical racks from rackSeed.
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates an official WPA 8-Ball triangle rack with:
 * - Apex ball centered at FOOT_SPOT (75, 25)
 * - 8-ball at the center of the triangle (row 2, col 1)
 * - Bottom two corners (row 4, col 0 and row 4, col 4) guaranteed to be different groups (one solid, one stripe)
 * - Cue ball at HEAD_SPOT (25, 25) ready for break placement in the kitchen
 */
export function createRack(seed: number = 1337): BallState[] {
  const rng = createSeededRng(seed);
  const solids = [1, 2, 3, 4, 5, 6, 7];
  const stripes = [9, 10, 11, 12, 13, 14, 15];

  // Deterministic Fisher-Yates shuffle
  const shuffle = (arr: number[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };
  shuffle(solids);
  shuffle(stripes);

  // Pick one solid and one stripe for the two back corners
  const cornerSolid = solids.pop()!;
  const cornerStripe = stripes.pop()!;
  const swapCorners = rng() < 0.5;
  const bottomLeftCorner = swapCorners ? cornerStripe : cornerSolid;
  const bottomRightCorner = swapCorners ? cornerSolid : cornerStripe;

  const remaining = [...solids, ...stripes];
  shuffle(remaining);

  const balls: BallState[] = [createBall(0, HEAD_SPOT.x, HEAD_SPOT.y)];

  // Slight micro-gap (0.0015 in) with tiny deterministic jitter (~0.0005 in) for realistic break energy transfer
  const spacing = BALL_DIAMETER + 0.0015;
  const rowDx = spacing * Math.sqrt(3) * 0.5;
  const colDy = spacing;

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      let id: number;
      if (row === 2 && col === 1) {
        id = 8; // WPA: 8-ball in center of 3rd row
      } else if (row === 4 && col === 0) {
        id = bottomLeftCorner;
      } else if (row === 4 && col === 4) {
        id = bottomRightCorner;
      } else {
        id = remaining.pop()!;
      }

      const jitterX = (rng() - 0.5) * 0.0008;
      const jitterY = (rng() - 0.5) * 0.0008;
      const x = FOOT_SPOT.x + row * rowDx + jitterX;
      const y = FOOT_SPOT.y + (col - row * 0.5) * colDy + jitterY;
      balls.push(createBall(id, x, y));
    }
  }

  // Sort by id 0..15 for canonical indexing
  balls.sort((a, b) => a.id - b.id);
  return balls;
}

export function createInitialGameState(
  seed: number = ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) & 0x7fffffff) || 1,
  cheatMode: boolean = false
): GameState {
  return {
    seq: 1,
    updatedAt: Date.now(),
    rackSeed: seed,
    cheatMode,
    balls: createRack(seed),
    currentPlayer: 0,
    playerGroups: [null, null],
    tableOpen: true,
    isBreakShot: true,
    ballInHand: true,
    winner: null,
    statusMessage: 'Break Shot — Drag cue ball in kitchen or aim & shoot',
    lastFoulReason: null,
    shotCount: 0,
  };
}

/**
 * Checks whether placing the cue ball at (x, y) is legal under WPA rules.
 * On the break shot, cue ball center must be on or behind the head string (x <= 25.0 in).
 */
export function isValidCueBallPosition(
  x: number,
  y: number,
  balls: readonly BallState[],
  isBreakShot: boolean
): boolean {
  const minX = BALL_RADIUS + 0.02;
  const maxX = isBreakShot ? HEAD_STRING_X : TABLE_LENGTH - BALL_RADIUS - 0.02;
  const minY = BALL_RADIUS + 0.02;
  const maxY = TABLE_WIDTH - BALL_RADIUS - 0.02;

  if (x < minX || x > maxX || y < minY || y > maxY) {
    return false;
  }

  // Must not be inside any pocket capture zone
  for (const p of POCKETS) {
    if (Math.hypot(x - p.x, y - p.y) < p.radius + 0.35) {
      return false;
    }
  }

  // Must not overlap any non-pocketed object ball
  const minSafeDist = BALL_DIAMETER + 0.02;
  for (const b of balls) {
    if (b.id === 0 || b.pocketed) continue;
    if (Math.hypot(x - b.x, y - b.y) < minSafeDist) {
      return false;
    }
  }

  return true;
}

/**
 * Finds the nearest valid cue ball placement to (targetX, targetY) so dragging Ball-in-Hand feels smooth.
 */
export function findNearestValidCueBallPosition(
  targetX: number,
  targetY: number,
  balls: readonly BallState[],
  isBreakShot: boolean
): { x: number; y: number } {
  const minX = BALL_RADIUS + 0.02;
  const maxX = isBreakShot ? HEAD_STRING_X : TABLE_LENGTH - BALL_RADIUS - 0.02;
  const minY = BALL_RADIUS + 0.02;
  const maxY = TABLE_WIDTH - BALL_RADIUS - 0.02;

  const cx = clamp(targetX, minX, maxX);
  const cy = clamp(targetY, minY, maxY);

  if (isValidCueBallPosition(cx, cy, balls, isBreakShot)) {
    return { x: cx, y: cy };
  }

  // Push out of any overlapping ball or pocket
  let px = cx;
  let py = cy;
  const minSafeDist = BALL_DIAMETER + 0.04;
  for (let iter = 0; iter < 8; iter++) {
    for (const b of balls) {
      if (b.id === 0 || b.pocketed) continue;
      const dx = px - b.x;
      const dy = py - b.y;
      const d = Math.hypot(dx, dy);
      if (d < minSafeDist) {
        const nx = d > 1e-4 ? dx / d : -1;
        const ny = d > 1e-4 ? dy / d : 0;
        px = clamp(b.x + nx * minSafeDist, minX, maxX);
        py = clamp(b.y + ny * minSafeDist, minY, maxY);
      }
    }
    if (isValidCueBallPosition(px, py, balls, isBreakShot)) {
      return { x: px, y: py };
    }
  }

  // Spiral search around (cx, cy)
  for (let r = 0.5; r <= 20; r += 0.5) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const tx = clamp(cx + Math.cos(ang) * r, minX, maxX);
      const ty = clamp(cy + Math.sin(ang) * r, minY, maxY);
      if (isValidCueBallPosition(tx, ty, balls, isBreakShot)) {
        return { x: tx, y: ty };
      }
    }
  }

  return { x: HEAD_SPOT.x, y: HEAD_SPOT.y };
}

/**
 * Spots a ball (such as the 8-ball pocketed on the break) on the Foot Spot,
 * or along the long string toward the foot rail if obstructed.
 */
export function spotBallOnFootSpot(ballId: number, balls: BallState[]): void {
  const targetBall = balls.find((b) => b.id === ballId);
  if (!targetBall) return;

  targetBall.pocketed = false;
  targetBall.pocketId = null;
  targetBall.vx = 0;
  targetBall.vy = 0;
  targetBall.wx = 0;
  targetBall.wy = 0;
  targetBall.wz = 0;

  const isFree = (x: number, y: number): boolean => {
    for (const b of balls) {
      if (b.id === ballId || b.pocketed) continue;
      if (Math.hypot(x - b.x, y - b.y) < BALL_DIAMETER + 0.02) {
        return false;
      }
    }
    return true;
  };

  // Search from Foot Spot (75, 25) toward Foot Rail along long string
  for (let x = FOOT_SPOT.x; x <= TABLE_LENGTH - BALL_RADIUS - 0.1; x += 0.1) {
    if (isFree(x, FOOT_SPOT.y)) {
      targetBall.x = x;
      targetBall.y = FOOT_SPOT.y;
      return;
    }
  }
  // Fallback: search toward Center Spot along long string
  for (let x = FOOT_SPOT.x; x >= BALL_RADIUS + 0.1; x -= 0.1) {
    if (isFree(x, FOOT_SPOT.y)) {
      targetBall.x = x;
      targetBall.y = FOOT_SPOT.y;
      return;
    }
  }
  targetBall.x = FOOT_SPOT.x;
  targetBall.y = FOOT_SPOT.y;
}

/**
 * Respawns the cue ball after a scratch at a valid default position for the incoming player.
 */
function respawnCueBall(balls: BallState[], isBreakShot: boolean): void {
  const cueBall = balls.find((b) => b.id === 0);
  if (!cueBall) return;
  cueBall.pocketed = false;
  cueBall.pocketId = null;
  cueBall.vx = 0;
  cueBall.vy = 0;
  cueBall.wx = 0;
  cueBall.wy = 0;
  cueBall.wz = 0;

  const pos = findNearestValidCueBallPosition(HEAD_SPOT.x, HEAD_SPOT.y, balls, isBreakShot);
  cueBall.x = pos.x;
  cueBall.y = pos.y;
}

/**
 * Evaluates a completed shot according to Official WPA 8-Ball Rules
 * and returns the next GameState.
 */
export function evaluateShotOutcome(
  prevState: GameState,
  settledBalls: BallState[],
  telemetry: ShotTelemetry
): GameState {
  const shooter = prevState.currentPlayer;
  const opponent: PlayerIndex = shooter === 0 ? 1 : 0;
  const balls = cloneBalls(settledBalls);

  const playerGroups: [BallGroup | null, BallGroup | null] = [
    prevState.playerGroups[0],
    prevState.playerGroups[1],
  ];
  let tableOpen = prevState.tableOpen;
  const wasBreakShot = prevState.isBreakShot;

  // Check if shooter was already on the 8-ball BEFORE the shot began
  const wasShootingAtEight = isPlayerOnEightBall(prevState, shooter);
  const shooterGroupBefore = playerGroups[shooter];

  // Ensure balls pocketed during this shot are marked pocketed on the cloned BallState array
  for (const pid of telemetry.pocketedBallIds) {
    const b = balls.find((x) => x.id === pid);
    if (b && pid !== 0) b.pocketed = true;
  }
  const cueBallObj = balls.find((x) => x.id === 0);
  const cueScratched = telemetry.cueBallPocketed || Boolean(cueBallObj?.pocketed);

  // 1. BREAK SHOT EVALUATION
  if (wasBreakShot) {
    // WPA: If 8-ball is pocketed on the break, it is spotted back on the foot spot (never a loss of game)
    const eightPocketedOnBreak = telemetry.pocketedBallIds.includes(8);
    if (eightPocketedOnBreak) {
      spotBallOnFootSpot(8, balls);
    }

    const otherObjectBallsPocketed = telemetry.pocketedBallIds.filter((id) => id !== 8 && id !== 0);
    const anyObjectBallPocketed = eightPocketedOnBreak || otherObjectBallsPocketed.length > 0;
    const legalBreakDrive =
      telemetry.firstContactBallId !== null &&
      (anyObjectBallPocketed || telemetry.objectBallsDrivenToCushion.size >= 4);

    if (cueScratched) {
      respawnCueBall(balls, false);
      return {
        ...prevState,
        seq: prevState.seq + 1,
        updatedAt: Date.now(),
        balls,
        currentPlayer: opponent,
        tableOpen: true,
        isBreakShot: false,
        ballInHand: true,
        winner: null,
        lastFoulReason: 'Scratch on break',
        statusMessage: `Foul (Scratch on break) — Player ${opponent + 1} Ball in Hand`,
        shotCount: prevState.shotCount + 1,
      };
    }

    if (!legalBreakDrive) {
      return {
        ...prevState,
        seq: prevState.seq + 1,
        updatedAt: Date.now(),
        balls,
        currentPlayer: opponent,
        tableOpen: true,
        isBreakShot: false,
        ballInHand: true,
        winner: null,
        lastFoulReason: 'Illegal break (fewer than 4 balls to a rail and none pocketed)',
        statusMessage: `Illegal Break — Player ${opponent + 1} Ball in Hand`,
        shotCount: prevState.shotCount + 1,
      };
    }

    // Legal break with no foul: table ALWAYS stays OPEN after the break shot
    const nextPlayer = anyObjectBallPocketed ? shooter : opponent;
    return {
      ...prevState,
      seq: prevState.seq + 1,
      updatedAt: Date.now(),
      balls,
      currentPlayer: nextPlayer,
      tableOpen: true,
      isBreakShot: false,
      ballInHand: false,
      winner: null,
      lastFoulReason: null,
      statusMessage: anyObjectBallPocketed
        ? `Player ${shooter + 1} continues — Open Table`
        : `Player ${opponent + 1}'s Turn — Open Table`,
      shotCount: prevState.shotCount + 1,
    };
  }

  // 2. NORMAL (POST-BREAK) SHOT EVALUATION
  let foulReason: string | null = null;
  const firstHit = telemetry.firstContactBallId;

  if (firstHit === null) {
    foulReason = 'No ball contacted';
  } else if (tableOpen) {
    if (firstHit === 8) {
      foulReason = 'Cannot contact the 8-ball first on an open table';
    }
  } else {
    // Table is closed (groups assigned)
    if (wasShootingAtEight) {
      if (firstHit !== 8) {
        foulReason = 'Must contact the 8-ball first';
      }
    } else {
      const hitGroup = getBallGroup(firstHit);
      if (hitGroup !== shooterGroupBefore) {
        foulReason =
          hitGroup === 'eight'
            ? 'Cannot contact the 8-ball before clearing your group'
            : `Wrong ball first (must hit ${shooterGroupBefore})`;
      }
    }
  }

  // Check rail / pocket requirement after contact
  if (
    foulReason === null &&
    telemetry.pocketedBallIds.length === 0 &&
    telemetry.cushionContactsAfterFirstHit === 0
  ) {
    foulReason = 'No ball pocketed or driven to a cushion after contact';
  }

  // Check cue ball scratch
  if (cueScratched) {
    foulReason = 'Scratch — cue ball pocketed';
    respawnCueBall(balls, false);
  }

  const eightPocketed = telemetry.pocketedBallIds.includes(8);

  // 3. CHECK 8-BALL WIN / LOSS
  if (eightPocketed) {
    if (wasShootingAtEight && foulReason === null) {
      return {
        ...prevState,
        seq: prevState.seq + 1,
        updatedAt: Date.now(),
        balls,
        currentPlayer: shooter,
        playerGroups,
        tableOpen,
        isBreakShot: false,
        ballInHand: false,
        winner: shooter,
        lastFoulReason: null,
        statusMessage: `Player ${shooter + 1} Wins!`,
        shotCount: prevState.shotCount + 1,
      };
    } else {
      const lossReason =
        foulReason !== null
          ? `Player ${shooter + 1} fouled while pocketing the 8-ball (${foulReason})`
          : `Player ${shooter + 1} pocketed the 8-ball early`;
      return {
        ...prevState,
        seq: prevState.seq + 1,
        updatedAt: Date.now(),
        balls,
        currentPlayer: opponent,
        playerGroups,
        tableOpen,
        isBreakShot: false,
        ballInHand: false,
        winner: opponent,
        lastFoulReason: foulReason ?? 'Illegally pocketed 8-ball',
        statusMessage: `Player ${opponent + 1} Wins! (${lossReason})`,
        shotCount: prevState.shotCount + 1,
      };
    }
  }

  // 4. STANDARD FOUL (8-ball NOT pocketed)
  if (foulReason !== null) {
    return {
      ...prevState,
      seq: prevState.seq + 1,
      updatedAt: Date.now(),
      balls,
      currentPlayer: opponent,
      playerGroups,
      tableOpen,
      isBreakShot: false,
      ballInHand: true,
      winner: null,
      lastFoulReason: foulReason,
      statusMessage: `Foul (${foulReason}) — Player ${opponent + 1} Ball in Hand`,
      shotCount: prevState.shotCount + 1,
    };
  }

  // 5. LEGAL SHOT (No foul, 8-ball not pocketed)
  const pocketedSolids = telemetry.pocketedBallIds.filter((id) => getBallGroup(id) === 'solids');
  const pocketedStripes = telemetry.pocketedBallIds.filter((id) => getBallGroup(id) === 'stripes');

  if (tableOpen) {
    if (pocketedSolids.length > 0 || pocketedStripes.length > 0) {
      let claimedGroup: BallGroup;
      if (pocketedSolids.length > 0 && pocketedStripes.length === 0) {
        claimedGroup = 'solids';
      } else if (pocketedStripes.length > 0 && pocketedSolids.length === 0) {
        claimedGroup = 'stripes';
      } else {
        // Both groups pocketed on open table: group of first contacted ball determines assignment
        claimedGroup = getBallGroup(firstHit!) === 'stripes' ? 'stripes' : 'solids';
      }
      const otherGroup: BallGroup = claimedGroup === 'solids' ? 'stripes' : 'solids';
      playerGroups[shooter] = claimedGroup;
      playerGroups[opponent] = otherGroup;
      tableOpen = false;

      return {
        ...prevState,
        seq: prevState.seq + 1,
        updatedAt: Date.now(),
        balls,
        currentPlayer: shooter,
        playerGroups,
        tableOpen: false,
        isBreakShot: false,
        ballInHand: false,
        winner: null,
        lastFoulReason: null,
        statusMessage: `Player ${shooter + 1} claims ${claimedGroup === 'solids' ? 'Solids' : 'Stripes'} — Shoot again`,
        shotCount: prevState.shotCount + 1,
      };
    }

    // Open table, nothing pocketed
    return {
      ...prevState,
      seq: prevState.seq + 1,
      updatedAt: Date.now(),
      balls,
      currentPlayer: opponent,
      playerGroups,
      tableOpen: true,
      isBreakShot: false,
      ballInHand: false,
      winner: null,
      lastFoulReason: null,
      statusMessage: `Player ${opponent + 1}'s Turn — Open Table`,
      shotCount: prevState.shotCount + 1,
    };
  }

  // Table is closed: check if shooter pocketed at least one of their own group's balls
  const shooterPocketedOwn =
    shooterGroupBefore === 'solids'
      ? pocketedSolids.length > 0
      : pocketedStripes.length > 0;

  const nextPlayer = shooterPocketedOwn ? shooter : opponent;
  const nextGroup = playerGroups[nextPlayer];
  const nextOnEight =
    nextGroup !== null && getRemainingBallsForGroup(balls, nextGroup).length === 0;

  const groupLabel = nextOnEight
    ? '8-Ball'
    : nextGroup === 'solids'
    ? 'Solids'
    : 'Stripes';

  return {
    ...prevState,
    seq: prevState.seq + 1,
    updatedAt: Date.now(),
    balls,
    currentPlayer: nextPlayer,
    playerGroups,
    tableOpen: false,
    isBreakShot: false,
    ballInHand: false,
    winner: null,
    lastFoulReason: null,
    statusMessage: shooterPocketedOwn
      ? `Player ${shooter + 1} continues (${groupLabel})`
      : `Player ${opponent + 1}'s Turn (${groupLabel})`,
    shotCount: prevState.shotCount + 1,
  };
}

export interface AimPreview {
  cueX: number;
  cueY: number;
  ghostX: number;
  ghostY: number;
  hitBall: BallState | null;
  isLegalTarget: boolean;
  targetDirX: number;
  targetDirY: number;
  tangentDirX: number;
  tangentDirY: number;
}

/**
 * Raycasts a swept sphere of radius BALL_RADIUS from the cue ball along aimAngle
 * to compute the exact ghost-ball position, target ball legality, and deflection lines.
 */
export function computeAimPreview(
  state: GameState,
  aimAngle: number
): AimPreview {
  const cueBall = state.balls.find((b) => b.id === 0)!;
  const dx = Math.cos(aimAngle);
  const dy = Math.sin(aimAngle);

  let minT = Infinity;
  let hitBall: BallState | null = null;

  // 1. Check intersection with all non-pocketed object balls (swept circle radius = 2 * BALL_RADIUS)
  const hitRadius = BALL_DIAMETER;
  for (const b of state.balls) {
    if (b.id === 0 || b.pocketed) continue;
    const ocx = b.x - cueBall.x;
    const ocy = b.y - cueBall.y;
    const proj = ocx * dx + ocy * dy;
    if (proj <= 0) continue;

    const perpSq = ocx * ocx + ocy * ocy - proj * proj;
    if (perpSq >= hitRadius * hitRadius) continue;

    const t = proj - Math.sqrt(hitRadius * hitRadius - perpSq);
    if (t > 0 && t < minT) {
      minT = t;
      hitBall = b;
    }
  }

  // 2. Check cushion wall distance if no ball hit before wall, respecting pocket openings
  const minX = BALL_RADIUS;
  const maxX = TABLE_LENGTH - BALL_RADIUS;
  const minY = BALL_RADIUS;
  const maxY = TABLE_WIDTH - BALL_RADIUS;

  const isOnVerticalRail = (y: number) =>
    y >= CORNER_JAW_OFFSET && y <= TABLE_WIDTH - CORNER_JAW_OFFSET;
  const isOnHorizontalRail = (x: number) =>
    (x >= CORNER_JAW_OFFSET && x <= 50 - SIDE_JAW_HALF_WIDTH) ||
    (x >= 50 + SIDE_JAW_HALF_WIDTH && x <= TABLE_LENGTH - CORNER_JAW_OFFSET);

  if (dx > 1e-6) {
    const tRail = (maxX - cueBall.x) / dx;
    if (tRail > 0) {
      const yAtRail = cueBall.y + dy * tRail;
      const tStop = isOnVerticalRail(yAtRail) ? tRail : (TABLE_LENGTH + 1.0 - cueBall.x) / dx;
      minT = Math.min(minT, Math.max(0, tStop));
    }
  }
  if (dx < -1e-6) {
    const tRail = (minX - cueBall.x) / dx;
    if (tRail > 0) {
      const yAtRail = cueBall.y + dy * tRail;
      const tStop = isOnVerticalRail(yAtRail) ? tRail : (-1.0 - cueBall.x) / dx;
      minT = Math.min(minT, Math.max(0, tStop));
    }
  }
  if (dy > 1e-6) {
    const tRail = (maxY - cueBall.y) / dy;
    if (tRail > 0) {
      const xAtRail = cueBall.x + dx * tRail;
      const tStop = isOnHorizontalRail(xAtRail) ? tRail : (TABLE_WIDTH + 1.0 - cueBall.y) / dy;
      minT = Math.min(minT, Math.max(0, tStop));
    }
  }
  if (dy < -1e-6) {
    const tRail = (minY - cueBall.y) / dy;
    if (tRail > 0) {
      const xAtRail = cueBall.x + dx * tRail;
      const tStop = isOnHorizontalRail(xAtRail) ? tRail : (-1.0 - cueBall.y) / dy;
      minT = Math.min(minT, Math.max(0, tStop));
    }
  }

  // If wall was closer than hitBall, clear hitBall
  if (hitBall) {
    const ocx = hitBall.x - cueBall.x;
    const ocy = hitBall.y - cueBall.y;
    const proj = ocx * dx + ocy * dy;
    const perpSq = ocx * ocx + ocy * ocy - proj * proj;
    const ballT = proj - Math.sqrt(Math.max(0, hitRadius * hitRadius - perpSq));
    if (ballT > minT + 1e-4) {
      hitBall = null;
    }
  }

  const ghostX = cueBall.x + dx * minT;
  const ghostY = cueBall.y + dy * minT;

  let isLegalTarget = true;
  let targetDirX = 0;
  let targetDirY = 0;
  let tangentDirX = 0;
  let tangentDirY = 0;

  if (hitBall) {
    const nx = hitBall.x - ghostX;
    const ny = hitBall.y - ghostY;
    const nLen = Math.hypot(nx, ny) || 1;
    targetDirX = nx / nLen;
    targetDirY = ny / nLen;

    // 90-degree tangent line for cue ball stun path
    const cross = dx * targetDirY - dy * targetDirX;
    tangentDirX = cross >= 0 ? targetDirY : -targetDirY;
    tangentDirY = cross >= 0 ? -targetDirX : targetDirX;

    // Check target legality
    if (state.isBreakShot) {
      isLegalTarget = true;
    } else if (state.tableOpen) {
      isLegalTarget = hitBall.id !== 8;
    } else if (isPlayerOnEightBall(state, state.currentPlayer)) {
      isLegalTarget = hitBall.id === 8;
    } else {
      isLegalTarget = getBallGroup(hitBall.id) === state.playerGroups[state.currentPlayer];
    }
  }

  return {
    cueX: cueBall.x,
    cueY: cueBall.y,
    ghostX,
    ghostY,
    hitBall,
    isLegalTarget,
    targetDirX,
    targetDirY,
    tangentDirX,
    tangentDirY,
  };
}

export interface BallTrajectoryPoint {
  x: number;
  y: number;
}

export interface CheatBallEndState {
  id: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  moved: boolean;
  pocketedThisShot: boolean;
  pocketId: number | null;
  path: BallTrajectoryPoint[];
  ballState: BallState;
}

export interface CheatPreview {
  endBalls: CheatBallEndState[];
  outcome: GameState;
  isFoul: boolean;
  foulReason: string | null;
}

/**
 * Simulates the entire shot deterministically with the given CueStrikeParams
 * and returns the exact resting positions, trajectories, and rule evaluation of all balls.
 */
export function computeCheatPreview(
  state: GameState,
  strike: CueStrikeParams,
  maxSteps: number = 240 * 25
): CheatPreview {
  const simBalls = cloneBalls(state.balls);
  const startPositions = new Map<number, { x: number; y: number; wasPocketed: boolean }>();
  const paths = new Map<number, BallTrajectoryPoint[]>();

  for (const b of simBalls) {
    startPositions.set(b.id, { x: b.x, y: b.y, wasPocketed: b.pocketed });
    if (!b.pocketed) {
      paths.set(b.id, [{ x: b.x, y: b.y }]);
    }
  }

  const cueBall = simBalls.find((b) => b.id === 0);
  if (cueBall && !cueBall.pocketed && strike.power > 0.01) {
    applyCueStrike(cueBall, strike);
  }

  const telemetry = createInitialTelemetry();
  let steps = 0;

  while (steps < maxSteps && areBallsMoving(simBalls)) {
    stepPhysics(simBalls, telemetry, FIXED_DT);
    steps++;

    if (steps % 4 === 0) {
      for (const b of simBalls) {
        const path = paths.get(b.id);
        if (!path) continue;
        const last = path[path.length - 1];
        if (b.pocketed) {
          if (b.pocketId !== null && POCKETS[b.pocketId]) {
            const pk = POCKETS[b.pocketId];
            if (Math.hypot(pk.x - last.x, pk.y - last.y) > 0.1) {
              path.push({ x: pk.x, y: pk.y });
            }
          }
        } else if (Math.hypot(b.x - last.x, b.y - last.y) > 0.35) {
          path.push({ x: b.x, y: b.y });
        }
      }
    }
  }

  if (steps >= maxSteps) {
    for (const b of simBalls) {
      b.vx = 0;
      b.vy = 0;
      b.wx = 0;
      b.wy = 0;
      b.wz = 0;
    }
  }

  const endBalls: CheatBallEndState[] = [];
  for (const b of simBalls) {
    const start = startPositions.get(b.id)!;
    if (start.wasPocketed) continue;

    const path = paths.get(b.id) ?? [{ x: start.x, y: start.y }];
    const pocketedThisShot = b.pocketed;
    let endX = b.x;
    let endY = b.y;
    if (pocketedThisShot && b.pocketId !== null && POCKETS[b.pocketId]) {
      endX = POCKETS[b.pocketId].renderX;
      endY = POCKETS[b.pocketId].renderY;
    }
    const last = path[path.length - 1];
    if (Math.hypot(endX - last.x, endY - last.y) > 0.05) {
      path.push({ x: endX, y: endY });
    }

    const moved = pocketedThisShot || Math.hypot(endX - start.x, endY - start.y) > 0.08;
    endBalls.push({
      id: b.id,
      startX: start.x,
      startY: start.y,
      endX,
      endY,
      moved,
      pocketedThisShot,
      pocketId: b.pocketId,
      path,
      ballState: { ...b, x: endX, y: endY },
    });
  }

  const outcome = evaluateShotOutcome(state, simBalls, telemetry);
  return {
    endBalls,
    outcome,
    isFoul: outcome.lastFoulReason !== null,
    foulReason: outcome.lastFoulReason,
  };
}
