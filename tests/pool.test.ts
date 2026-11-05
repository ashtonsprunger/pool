import { describe, expect, it } from 'vitest';
import {
  BALL_DIAMETER,
  BALL_RADIUS,
  FOOT_SPOT,
  HEAD_SPOT,
  HEAD_STRING_X,
  POCKETS,
  TABLE_ASPECT_RATIO,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from '../src/physics/constants';
import {
  applyCueStrike,
  createBall,
  createInitialTelemetry,
  simulateUntilRest,
} from '../src/physics/engine';
import {
  computeAimPreview,
  createInitialGameState,
  createRack,
  evaluateShotOutcome,
  findNearestValidCueBallPosition,
  getBallGroup,
  isValidCueBallPosition,
} from '../src/game/rules';
import {
  computeTableViewport,
  screenToTable,
  tableToScreen,
} from '../src/game/viewport';
import { resolvePendingShot } from '../src/net/sync';

describe('WPA Pool Table & Ball Specifications', () => {
  it('enforces exact 2:1 regulation playing surface and ball dimensions', () => {
    expect(TABLE_LENGTH).toBe(100.0);
    expect(TABLE_WIDTH).toBe(50.0);
    expect(TABLE_ASPECT_RATIO).toBe(2.0);
    expect(BALL_DIAMETER).toBe(2.25);
    expect(BALL_RADIUS).toBe(1.125);
    expect(HEAD_STRING_X).toBe(25.0);
    expect(HEAD_SPOT).toEqual({ x: 25.0, y: 25.0 });
    expect(FOOT_SPOT).toEqual({ x: 75.0, y: 25.0 });
    expect(POCKETS.length).toBe(6);
  });

  it('generates valid WPA 8-ball racks across multiple seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const balls = createRack(seed);
      expect(balls.length).toBe(16);

      // Cue ball at head spot
      const cue = balls.find((b) => b.id === 0)!;
      expect(cue.x).toBeCloseTo(HEAD_SPOT.x, 2);
      expect(cue.y).toBeCloseTo(HEAD_SPOT.y, 2);

      // Apex ball at foot spot (75, 25)
      const objectBalls = balls.filter((b) => b.id !== 0);
      const minXBall = objectBalls.reduce((min, b) => (b.x < min.x ? b : min), objectBalls[0]);
      expect(minXBall.x).toBeCloseTo(FOOT_SPOT.x, 2);
      expect(minXBall.y).toBeCloseTo(FOOT_SPOT.y, 2);

      // 8-ball must be in the center of row 2 (x ≈ 75 + 2 * sqrt(3) * R, y ≈ 25)
      const eight = balls.find((b) => b.id === 8)!;
      const expectedEightX = FOOT_SPOT.x + 2 * (BALL_DIAMETER + 0.0015) * Math.sqrt(3) * 0.5;
      expect(eight.x).toBeCloseTo(expectedEightX, 2);
      expect(eight.y).toBeCloseTo(FOOT_SPOT.y, 2);

      // Back two corner balls (highest X, min Y and max Y) must be different groups (1 solid, 1 stripe)
      const backRow = objectBalls.filter(
        (b) => b.x > FOOT_SPOT.x + 3.5 * BALL_DIAMETER * Math.sqrt(3) * 0.5
      );
      expect(backRow.length).toBe(5);
      const topCorner = backRow.reduce((min, b) => (b.y < min.y ? b : min), backRow[0]);
      const bottomCorner = backRow.reduce((max, b) => (b.y > max.y ? b : max), backRow[0]);
      expect(getBallGroup(topCorner.id)).not.toBe(getBallGroup(bottomCorner.id));
    }
  });
});

describe('3D-Spin Rigid-Body Pool Physics', () => {
  it('models topspin (follow) and backspin (draw) accurately on straight-in shots', () => {
    // 1. Topspin (Follow) shot: cue ball at (20, 20) shooting right at ball 1 at (30, 20)
    const followBalls = [createBall(0, 20, 20), createBall(1, 30, 20)];
    applyCueStrike(followBalls[0], { angle: 0, power: 0.28, spinX: 0, spinY: 0.85 });
    const followTel = createInitialTelemetry();
    simulateUntilRest(followBalls, followTel);
    // Cue ball impacts at x = 27.75 and must follow forward well past x = 32
    expect(followBalls[0].x).toBeGreaterThan(32.0);

    // 2. Backspin (Draw) shot: same positions, strong bottom spin
    const drawBalls = [createBall(0, 20, 20), createBall(1, 30, 20)];
    applyCueStrike(drawBalls[0], { angle: 0, power: 0.28, spinX: 0, spinY: -0.85 });
    const drawTel = createInitialTelemetry();
    simulateUntilRest(drawBalls, drawTel);
    // Cue ball impacts at x = 27.75 and must draw backward behind x = 25
    expect(drawBalls[0].x).toBeLessThan(25.0);
  });

  it('models running and reverse english (sidespin) on cushion rebound', () => {
    // Shoot straight up toward the top rail (angle = -PI/2) at x = 30, y = 25
    const rightEnglishBalls = [createBall(0, 30, 25)];
    applyCueStrike(rightEnglishBalls[0], {
      angle: -Math.PI / 2,
      power: 0.4,
      spinX: 0.8,
      spinY: 0,
    });
    simulateUntilRest(rightEnglishBalls, createInitialTelemetry());

    const leftEnglishBalls = [createBall(0, 30, 25)];
    applyCueStrike(leftEnglishBalls[0], {
      angle: -Math.PI / 2,
      power: 0.4,
      spinX: -0.8,
      spinY: 0,
    });
    simulateUntilRest(leftEnglishBalls, createInitialTelemetry());

    // Right and left english must deflect the cue ball to opposite sides of x = 30
    expect(rightEnglishBalls[0].x).toBeGreaterThan(31.5);
    expect(leftEnglishBalls[0].x).toBeLessThan(28.5);
  });

  it('prevents tunneling and overlaps on a maximum-power break shot', () => {
    const state = createInitialGameState(42);
    const cueBall = state.balls.find((b) => b.id === 0)!;
    applyCueStrike(cueBall, { angle: 0, power: 1.0, spinX: 0, spinY: 0.2 });
    const tel = createInitialTelemetry();
    simulateUntilRest(state.balls, tel);

    expect(tel.firstContactBallId).not.toBeNull();

    // Verify all non-pocketed balls are strictly inside the playing surface and non-overlapping
    const active = state.balls.filter((b) => !b.pocketed);
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      expect(a.x).toBeGreaterThanOrEqual(BALL_RADIUS - 0.05);
      expect(a.x).toBeLessThanOrEqual(TABLE_LENGTH - BALL_RADIUS + 0.05);
      expect(a.y).toBeGreaterThanOrEqual(BALL_RADIUS - 0.05);
      expect(a.y).toBeLessThanOrEqual(TABLE_WIDTH - BALL_RADIUS + 0.05);

      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(BALL_DIAMETER - 0.05);
      }
    }
  });
});

describe('Standard WPA 8-Ball Rules State Machine', () => {
  it('enforces kitchen constraint on break and full-table ball-in-hand after break', () => {
    const state = createInitialGameState(100);
    // On break: x = 20 is in kitchen (valid), x = 35 is past head string (invalid)
    expect(isValidCueBallPosition(20, 25, state.balls, true)).toBe(true);
    expect(isValidCueBallPosition(35, 25, state.balls, true)).toBe(false);

    // Post-break ball-in-hand: x = 35 is valid
    expect(isValidCueBallPosition(35, 25, state.balls, false)).toBe(true);

    // Clamping a dragged position outside kitchen on break clamps to x <= 25
    const clamped = findNearestValidCueBallPosition(45, 25, state.balls, true);
    expect(clamped.x).toBeLessThanOrEqual(HEAD_STRING_X);
  });

  it('keeps table OPEN after break even when balls are pocketed, and spots 8-ball if pocketed on break', () => {
    const state = createInitialGameState(101);
    const tel = createInitialTelemetry();
    tel.firstContactBallId = 1;
    tel.pocketedBallIds = [1, 8]; // Solid 1 and 8-ball both pocketed on break
    state.balls.find((b) => b.id === 1)!.pocketed = true;
    state.balls.find((b) => b.id === 8)!.pocketed = true;

    const next = evaluateShotOutcome(state, state.balls, tel);
    expect(next.winner).toBeNull();
    expect(next.tableOpen).toBe(true); // Table ALWAYS stays open after break
    expect(next.playerGroups).toEqual([null, null]);
    expect(next.currentPlayer).toBe(0); // Breaker continues
    // 8-ball must be re-spotted on the table
    expect(next.balls.find((b) => b.id === 8)!.pocketed).toBe(false);
  });

  it('assigns groups on the first legal post-break shot that pockets an object ball', () => {
    const state = createInitialGameState(102);
    state.isBreakShot = false;
    state.ballInHand = false;
    state.tableOpen = true;

    const tel = createInitialTelemetry();
    tel.firstContactBallId = 9; // Hit stripe 9
    tel.pocketedBallIds = [9];
    state.balls.find((b) => b.id === 9)!.pocketed = true;

    const next = evaluateShotOutcome(state, state.balls, tel);
    expect(next.tableOpen).toBe(false);
    expect(next.playerGroups[0]).toBe('stripes');
    expect(next.playerGroups[1]).toBe('solids');
    expect(next.currentPlayer).toBe(0); // Continues turn
  });

  it('awards ball-in-hand on foul and does not assign groups if foul occurs on open table', () => {
    const state = createInitialGameState(103);
    state.isBreakShot = false;
    state.tableOpen = true;

    // Hit 8-ball first on open table and pocket a solid
    const tel = createInitialTelemetry();
    tel.firstContactBallId = 8;
    tel.pocketedBallIds = [2];
    state.balls.find((b) => b.id === 2)!.pocketed = true;

    const next = evaluateShotOutcome(state, state.balls, tel);
    expect(next.tableOpen).toBe(true);
    expect(next.playerGroups).toEqual([null, null]);
    expect(next.currentPlayer).toBe(1);
    expect(next.ballInHand).toBe(true);
  });

  it('treats scratching on the 8-ball WITHOUT pocketing the 8-ball as a standard foul (not loss of game)', () => {
    const state = createInitialGameState(104);
    state.isBreakShot = false;
    state.tableOpen = false;
    state.playerGroups = ['solids', 'stripes'];
    // Pocket all solids (1..7) prior to this shot so Player 0 is on the 8-ball
    for (let id = 1; id <= 7; id++) {
      state.balls.find((b) => b.id === id)!.pocketed = true;
    }

    const tel = createInitialTelemetry();
    tel.firstContactBallId = 8;
    tel.cueBallPocketed = true; // Scratched, but 8-ball is NOT pocketed
    state.balls.find((b) => b.id === 0)!.pocketed = true;

    const next = evaluateShotOutcome(state, state.balls, tel);
    expect(next.winner).toBeNull(); // Not a loss of game under WPA rules!
    expect(next.currentPlayer).toBe(1);
    expect(next.ballInHand).toBe(true);
  });

  it('awards win when legally pocketing the 8-ball, and loss when pocketing 8-ball early or on the same shot as last group ball', () => {
    // 1. Pocketing 8-ball on the same shot as last solid -> LOSS
    const stateSameShot = createInitialGameState(105);
    stateSameShot.isBreakShot = false;
    stateSameShot.tableOpen = false;
    stateSameShot.playerGroups = ['solids', 'stripes'];
    for (let id = 1; id <= 6; id++) {
      stateSameShot.balls.find((b) => b.id === id)!.pocketed = true;
    }
    // Ball 7 is still on the table at the start of the shot!
    const telSame = createInitialTelemetry();
    telSame.firstContactBallId = 7;
    telSame.pocketedBallIds = [7, 8];
    stateSameShot.balls.find((b) => b.id === 7)!.pocketed = true;
    stateSameShot.balls.find((b) => b.id === 8)!.pocketed = true;

    const outSame = evaluateShotOutcome(stateSameShot, stateSameShot.balls, telSame);
    expect(outSame.winner).toBe(1); // Player 0 loses because 7 was not cleared prior to the shot

    // 2. Pocketing 8-ball after all 7 solids were cleared -> WIN
    const stateWin = createInitialGameState(106);
    stateWin.isBreakShot = false;
    stateWin.tableOpen = false;
    stateWin.playerGroups = ['solids', 'stripes'];
    for (let id = 1; id <= 7; id++) {
      stateWin.balls.find((b) => b.id === id)!.pocketed = true;
    }
    const telWin = createInitialTelemetry();
    telWin.firstContactBallId = 8;
    telWin.pocketedBallIds = [8];
    stateWin.balls.find((b) => b.id === 8)!.pocketed = true;

    const outWin = evaluateShotOutcome(stateWin, stateWin.balls, telWin);
    expect(outWin.winner).toBe(0); // Player 0 wins!
  });
});

describe('Responsive Viewport & Mid-Shot Reconnect Recovery', () => {
  it('accurately maps coordinates round-trip in both landscape and portrait orientations', () => {
    const landscapeVp = computeTableViewport(1200, 700);
    expect(landscapeVp.isPortrait).toBe(false);
    const lScreen = tableToScreen(landscapeVp, 75, 25);
    const lTable = screenToTable(landscapeVp, lScreen.x, lScreen.y);
    expect(lTable.x).toBeCloseTo(75, 5);
    expect(lTable.y).toBeCloseTo(25, 5);

    const portraitVp = computeTableViewport(390, 844);
    expect(portraitVp.isPortrait).toBe(true);
    const pScreen = tableToScreen(portraitVp, 25, 12.5);
    const pTable = screenToTable(portraitVp, pScreen.x, pScreen.y);
    expect(pTable.x).toBeCloseTo(25, 5);
    expect(pTable.y).toBeCloseTo(12.5, 5);
  });

  it('deterministically resolves a pending mid-shot state upon tab reopen', () => {
    const baseState = createInitialGameState(77);
    const resolved = resolvePendingShot({
      baseState,
      cueX: 25,
      cueY: 25,
      strike: { angle: 0, power: 0.9, spinX: 0, spinY: 0 },
    });
    expect(resolved.seq).toBe(baseState.seq + 1);
    expect(resolved.isBreakShot).toBe(false);
    expect(resolved.shotCount).toBe(1);
  });

  it('computes accurate ghost-ball aim previews', () => {
    const state = createInitialGameState(88);
    const preview = computeAimPreview(state, 0);
    expect(preview.hitBall).not.toBeNull();
    expect(preview.isLegalTarget).toBe(true);
    expect(preview.ghostX).toBeCloseTo(FOOT_SPOT.x - BALL_DIAMETER, 1);
  });

  it('handles illegal break (< 4 cushions and 0 pocketed) and simultaneous break scratch + 8-ball pocketed', () => {
    // 1. Illegal break: hits ball 1, only 2 balls touch a cushion, 0 pocketed
    const state1 = createInitialGameState(201);
    const tel1 = createInitialTelemetry();
    tel1.firstContactBallId = 1;
    tel1.objectBallsDrivenToCushion.add(1);
    tel1.objectBallsDrivenToCushion.add(2);

    const out1 = evaluateShotOutcome(state1, state1.balls, tel1);
    expect(out1.currentPlayer).toBe(1);
    expect(out1.ballInHand).toBe(true);
    expect(out1.tableOpen).toBe(true);
    expect(out1.isBreakShot).toBe(false);

    // 2. Simultaneous scratch + 8-ball pocketed on break -> 8-ball spotted, opponent ball-in-hand, no winner
    const state2 = createInitialGameState(202);
    // Move ball 1 onto the foot spot (75, 25) to also test obstructed foot-spot re-spotting!
    const b1 = state2.balls.find((b) => b.id === 1)!;
    b1.x = FOOT_SPOT.x;
    b1.y = FOOT_SPOT.y;

    const tel2 = createInitialTelemetry();
    tel2.firstContactBallId = 1;
    tel2.pocketedBallIds = [8];
    tel2.cueBallPocketed = true;

    const out2 = evaluateShotOutcome(state2, state2.balls, tel2);
    expect(out2.winner).toBeNull();
    expect(out2.currentPlayer).toBe(1);
    expect(out2.ballInHand).toBe(true);
    const spottedEight = out2.balls.find((b) => b.id === 8)!;
    expect(spottedEight.pocketed).toBe(false);
    // Since (75, 25) was obstructed by ball 1, 8-ball must be spotted along the long string without overlapping ball 1
    expect(Math.hypot(spottedEight.x - b1.x, spottedEight.y - b1.y)).toBeGreaterThanOrEqual(
      BALL_DIAMETER
    );
  });

  it('guards applyCueStrike against zero, negative, or NaN power/spin inputs', () => {
    const ball = createBall(0, 25, 25);
    applyCueStrike(ball, { angle: 0, power: 0, spinX: 0, spinY: 0 });
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);

    applyCueStrike(ball, { angle: NaN, power: -1, spinX: NaN, spinY: Infinity });
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);
  });
});
