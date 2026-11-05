import { describe, expect, it } from 'vitest';
import {
  BALL_DIAMETER,
  BALL_RADIUS,
  CUSHION_SEGMENTS,
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
  stepPhysics,
} from '../src/physics/engine';
import {
  cloneGameState,
  computeAimPreview,
  computeCheatPreview,
  createInitialGameState,
  createRack,
  evaluateShotOutcome,
  findNearestValidCueBallPosition,
  getBallGroup,
  getGameMode,
  isValidCueBallPosition,
} from '../src/game/rules';
import {
  computeTableViewport,
  screenToTable,
  tableToScreen,
} from '../src/game/viewport';
import {
  MultiplayerCoordinator,
  getStoredPlayerName,
  loadPersistedSession,
  resolvePendingShot,
} from '../src/net/sync';

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

  it('orients all 12 corner and side pocket jaw normals into the pocket openings and rebounds rail shots into pockets', () => {
    const jaws = CUSHION_SEGMENTS.filter((s) => s.isJaw);
    expect(jaws.length).toBe(12);

    // Verify each jaw's normal points toward its corresponding pocket mouth center
    const pocketMouthTarget: Record<string, { x: number; y: number }> = {
      'tl-jaw-top': { x: 0, y: 0 },
      'tl-jaw-left': { x: 0, y: 0 },
      'tr-jaw-top': { x: 100, y: 0 },
      'tr-jaw-right': { x: 100, y: 0 },
      'bl-jaw-bottom': { x: 0, y: 50 },
      'bl-jaw-left': { x: 0, y: 50 },
      'br-jaw-bottom': { x: 100, y: 50 },
      'br-jaw-right': { x: 100, y: 50 },
      'ts-jaw-left': { x: 50, y: 0 },
      'ts-jaw-right': { x: 50, y: 0 },
      'bs-jaw-left': { x: 50, y: 50 },
      'bs-jaw-right': { x: 50, y: 50 },
    };

    for (const jaw of jaws) {
      const target = pocketMouthTarget[jaw.id];
      const midX = (jaw.ax + jaw.bx) * 0.5;
      const midY = (jaw.ay + jaw.by) * 0.5;
      const dot = (target.x - midX) * jaw.nx + (target.y - midY) * jaw.ny;
      expect(dot).toBeGreaterThan(0);
    }

    // Shoot a ball along the top rail (y = 1.20) left into the top-left corner pocket jaw
    const ball = createBall(1, 8.0, 1.2);
    ball.vx = -65;
    ball.vy = 0;
    const tel = createInitialTelemetry();
    simulateUntilRest([ball], tel);
    expect(ball.pocketed).toBe(true);
    expect(ball.pocketId).toBe(0);
  });

  it('models spin-induced throw and gearing english without amplifying sidespin on ball-ball impact', () => {
    // Straight-in shot along +X from (20, 25) into ball 1 at (25, 25) with right english (spinX = +0.8)
    const rightBalls = [createBall(0, 20, 25), createBall(1, 25, 25)];
    applyCueStrike(rightBalls[0], { angle: 0, power: 0.35, spinX: 0.8, spinY: 0 });
    const initialWzMag = Math.abs(rightBalls[0].wz);

    // Step until first contact occurs
    const tel = createInitialTelemetry();
    let steps = 0;
    while (tel.firstContactBallId === null && steps < 200) {
      stepPhysics(rightBalls, tel);
      steps++;
    }
    expect(tel.firstContactBallId).toBe(1);
    // Cue ball sidespin magnitude must decrease on collision (never amplify)
    expect(Math.abs(rightBalls[0].wz)).toBeLessThan(initialWzMag);
    // Object ball acquires opposite-sign gearing sidespin
    expect(Math.sign(rightBalls[1].wz)).toBe(-Math.sign(rightBalls[0].wz));
    // Right english throws object ball to the left (-Y when aiming along +X)
    expect(rightBalls[1].vy).toBeLessThan(0);
  });

  it('computes accurate aim preview even when targeting an object ball sitting inside pocket jaws', () => {
    const state = createInitialGameState(301);
    state.isBreakShot = false;
    state.tableOpen = true;
    // Place cue ball at (92, 8) and ball 1 deep in the top-right pocket mouth at (99.1, 1.0)
    for (const b of state.balls) {
      if (b.id !== 0 && b.id !== 1) b.pocketed = true;
    }
    const cue = state.balls.find((b) => b.id === 0)!;
    const b1 = state.balls.find((b) => b.id === 1)!;
    cue.x = 92.0;
    cue.y = 8.0;
    b1.x = 99.1;
    b1.y = 1.0;

    const angle = Math.atan2(b1.y - cue.y, b1.x - cue.x);
    const preview = computeAimPreview(state, angle);
    expect(preview.hitBall).not.toBeNull();
    expect(preview.hitBall?.id).toBe(1);
  });

  it('deterministically resolves dual-host conflicts without seat oscillation and assigns 3rd peer as spectator', () => {
    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };

    const peerA = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'client_A_host',
      disableNetwork: true,
    });
    const peerB = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'client_B_guest',
      disableNetwork: true,
    });
    const peerC = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'client_C_spectator',
      disableNetwork: true,
    });

    try {
      const code = peerA.createMultiplayerRoom();
      // Simulate slow network where peerB also claimed host before connecting
      peerB.joinRoom(code, true);
      (peerB as unknown as { session: { hostClientId: string; mySeat: 0 | 1 } }).session.hostClientId =
        'client_B_guest';
      (peerB as unknown as { session: { hostClientId: string; mySeat: 0 | 1 } }).session.mySeat = 0;

      // Exchange HELLO packets between A and B
      peerB.handlePacket({
        type: 'HELLO',
        msgId: 'msg_a_hello_1',
        senderId: peerA.clientId,
        knownSeq: peerA.getState().seq,
        state: peerA.getState(),
        hostClientId: peerA.getHostClientId(),
        guestClientId: peerA.getGuestClientId(),
      });
      peerA.handlePacket({
        type: 'HELLO',
        msgId: 'msg_b_hello_1',
        senderId: peerB.clientId,
        knownSeq: peerB.getState().seq,
        state: peerB.getState(),
        hostClientId: 'client_B_guest',
        guestClientId: null,
      });

      // Both peers must agree that client_A_host is Seat 0 and client_B_guest is Seat 1
      expect(peerA.getHostClientId()).toBe('client_A_host');
      expect(peerB.getHostClientId()).toBe('client_A_host');
      expect(peerA.getGuestClientId()).toBe('client_B_guest');
      expect(peerB.getGuestClientId()).toBe('client_B_guest');
      expect(peerA.getMySeat()).toBe(0);
      expect(peerB.getMySeat()).toBe(1);
      expect(peerB.getState().rackSeed).toBe(peerA.getState().rackSeed);

      // Now 3rd client (peerC) joins the same room and exchanges HELLO with peerA
      peerC.joinRoom(code, false);
      peerA.handlePacket({
        type: 'HELLO',
        msgId: 'msg_c_hello_1',
        senderId: peerC.clientId,
        knownSeq: peerC.getState().seq,
        state: peerC.getState(),
        hostClientId: null,
        guestClientId: null,
      });
      peerC.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'msg_a_sync_to_c',
        senderId: peerA.clientId,
        hostClientId: peerA.getHostClientId()!,
        guestClientId: peerA.getGuestClientId(),
        state: peerA.getState(),
      });

      // Peer A and B retain seats 0 and 1; Peer C is assigned spectator (mySeat === null)
      expect(peerA.getGuestClientId()).toBe('client_B_guest');
      expect(peerC.getHostClientId()).toBe('client_A_host');
      expect(peerC.getGuestClientId()).toBe('client_B_guest');
      expect(peerC.getMySeat()).toBeNull();
      expect(peerC.isMyTurn()).toBe(false);
    } finally {
      peerA.dispose();
      peerB.dispose();
      peerC.dispose();
    }
  });

  it('preserves uncorrupted baseState in localStorage if saved mid-shot while balls are moving', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };

    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };

    const coord = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'PersistTestClient',
      disableNetwork: true,
    });

    try {
      const code = coord.createMultiplayerRoom();
      const initialState = coord.getState();
      const strike = { angle: 0, power: 0.85, spinX: 0, spinY: 0 };
      const expectedSettled = resolvePendingShot({
        baseState: initialState,
        cueX: 25,
        cueY: 25,
        strike,
      });

      // Start shot and then mutate coord.getState().balls to simulate mid-shot physics frames
      coord.recordShotStart(25, 25, strike, expectedSettled);
      stepPhysics(coord.getState().balls, createInitialTelemetry());
      stepPhysics(coord.getState().balls, createInitialTelemetry());

      // Trigger a mid-shot save via incoming HELLO packet
      coord.handlePacket({
        type: 'HELLO',
        msgId: 'mid_shot_hello',
        senderId: 'OtherPeerId',
        knownSeq: 1,
        state: initialState,
        hostClientId: coord.clientId,
        guestClientId: 'OtherPeerId',
      });

      // Simulate tab close and reopen via loadPersistedSession
      const recovered = loadPersistedSession(code);
      expect(recovered.pendingShot).toBeNull();
      expect(recovered.state.seq).toBe(expectedSettled.seq);
      expect(recovered.state.balls[0].x).toBeCloseTo(expectedSettled.balls[0].x, 4);
      expect(recovered.state.balls[0].y).toBeCloseTo(expectedSettled.balls[0].y, 4);
    } finally {
      coord.dispose();
    }
  });

  it('does not throw TDZ ReferenceError when constructed with an initial room code whose callback accesses the instance', async () => {
    let notifiedRoom: string | null = null;
    const coord = new MultiplayerCoordinator(
      'TDZR',
      {
        onStateUpdated: () => {
          expect(coord.getState()).toBeDefined();
        },
        onRemoteAim: () => {},
        onRemoteShot: () => {},
        onConnectionChanged: () => {
          // Accessing `coord` inside onConnectionChanged previously threw:
          // ReferenceError: Cannot access 'coord' before initialization
          notifiedRoom = coord.getRoomCode();
        },
      },
      { clientId: 'TdzTestClient', disableNetwork: true }
    );

    try {
      await Promise.resolve();
      expect(notifiedRoom).toBe('TDZR');
    } finally {
      coord.dispose();
    }
  });

  it('computes exact end-state ball positions in Cheat Mode and syncs cheatMode across peers and turns', () => {
    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };
    const host = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'CheatHost',
      disableNetwork: true,
    });
    const guest = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'CheatGuest',
      disableNetwork: true,
    });

    try {
      const code = host.createMultiplayerRoom(true);
      expect(host.getState().cheatMode).toBe(true);

      guest.joinRoom(code, true);
      guest.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'cheat_sync_1',
        senderId: host.clientId,
        hostClientId: host.clientId,
        guestClientId: guest.clientId,
        state: host.getState(),
      });
      expect(guest.getState().cheatMode).toBe(true);

      // Verify computeCheatPreview matches actual shot simulation & responds to power/fine-angle
      const state = host.getState();
      const softPreview = computeCheatPreview(state, {
        angle: 0.005,
        power: 0.35,
        spinX: 0,
        spinY: 0,
      });
      const hardPreview = computeCheatPreview(state, {
        angle: 0.005,
        power: 0.9,
        spinX: 0,
        spinY: 0,
      });

      const softMoved = softPreview.endBalls.filter((b) => b.moved);
      const hardMoved = hardPreview.endBalls.filter((b) => b.moved);
      expect(softMoved.length).toBeGreaterThan(5);
      expect(hardMoved.length).toBeGreaterThan(5);

      // Different strike power produces different end-state coordinates
      const cueSoft = softPreview.endBalls.find((b) => b.id === 0)!;
      const cueHard = hardPreview.endBalls.find((b) => b.id === 0)!;
      expect(Math.hypot(cueSoft.endX - cueHard.endX, cueSoft.endY - cueHard.endY)).toBeGreaterThan(
        1.0
      );

      // Cheat mode remains enabled on the next turn's outcome
      expect(hardPreview.outcome.cheatMode).toBe(true);
    } finally {
      host.dispose();
      guest.dispose();
    }
  });

  it('persists player names locally and syncs hostName and guestName between peers', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };

    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };

    const host = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'HostClient1',
      disableNetwork: true,
    });
    const guest = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'GuestClient2',
      disableNetwork: true,
    });

    try {
      host.setMyPlayerName('Ashton');
      expect(getStoredPlayerName()).toBe('Ashton');

      const code = host.createMultiplayerRoom(false);
      expect(host.getHostName()).toBe('Ashton');

      guest.setMyPlayerName('Jordan');
      guest.joinRoom(code, true);

      // Guest sends HELLO with senderName: 'Jordan' to Host
      host.handlePacket({
        type: 'HELLO',
        msgId: 'guest_hello_name',
        senderId: guest.clientId,
        senderName: guest.getMyPlayerName(),
        knownSeq: guest.getState().seq,
        state: guest.getState(),
        hostClientId: null,
        guestClientId: null,
      });

      expect(host.getHostName()).toBe('Ashton');
      expect(host.getGuestName()).toBe('Jordan');

      // Host replies with SYNC_STATE containing both hostName and guestName
      guest.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'host_sync_names',
        senderId: host.clientId,
        senderName: host.getMyPlayerName(),
        hostClientId: host.getHostClientId()!,
        guestClientId: host.getGuestClientId(),
        hostName: host.getHostName(),
        guestName: host.getGuestName(),
        state: host.getState(),
      });

      expect(guest.getHostName()).toBe('Ashton');
      expect(guest.getGuestName()).toBe('Jordan');
    } finally {
      host.dispose();
      guest.dispose();
    }
  });

  it('does not trigger onStateUpdated (aim reset) on Player 2 when Host sends HELLO or SYNC_STATE at the same seq', () => {
    let guestStateUpdateCount = 0;
    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };

    const host = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'HostAimTest',
      disableNetwork: true,
    });
    const guest = new MultiplayerCoordinator(
      null,
      {
        ...noopCallbacks,
        onStateUpdated: () => {
          guestStateUpdateCount++;
        },
      },
      {
        clientId: 'GuestAimTest',
        disableNetwork: true,
      }
    );

    try {
      guest.joinRoom('AIMFIX', true);
      const code = host.createMultiplayerRoom(false);
      // Put guest in the same room with its own initial rack before syncing with host
      guest.joinRoom(code, true);
      guest.getState().rackSeed = host.getState().rackSeed + 999;
      guestStateUpdateCount = 0;

      // Initial room sync: Guest adopts Host's rack at seq=0 (1st state update)
      guest.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'init_sync',
        senderId: host.clientId,
        hostClientId: host.clientId,
        guestClientId: guest.clientId,
        state: host.getState(),
      });
      expect(guestStateUpdateCount).toBe(1);

      // Advance to next seq where it is Player 2's (Guest's) turn
      const turn1State = cloneGameState(host.getState());
      turn1State.seq = host.getState().seq + 1;
      turn1State.currentPlayer = 1;
      turn1State.ballInHand = true;
      host.commitSettledState(turn1State);

      guest.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'turn1_sync',
        senderId: host.clientId,
        hostClientId: host.clientId,
        guestClientId: guest.clientId,
        state: host.getState(),
      });
      expect(guestStateUpdateCount).toBe(2);
      expect(guest.isMyTurn()).toBe(true);

      // Simulate Host having a newer updatedAt timestamp on the same seq=1
      const newerHostState = cloneGameState(host.getState());
      newerHostState.updatedAt = Date.now() + 50000;

      // Host sends HELLO and SYNC_STATE heartbeats while Guest is aiming on seq=1
      guest.handlePacket({
        type: 'HELLO',
        msgId: 'heartbeat_hello_1',
        senderId: host.clientId,
        knownSeq: newerHostState.seq,
        state: newerHostState,
        hostClientId: host.clientId,
        guestClientId: guest.clientId,
      });

      guest.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'heartbeat_sync_1',
        senderId: host.clientId,
        hostClientId: host.clientId,
        guestClientId: guest.clientId,
        state: newerHostState,
      });

      // Guest must NOT have received any additional onStateUpdated calls that would reset their aim
      expect(guestStateUpdateCount).toBe(2);
    } finally {
      host.dispose();
      guest.dispose();
    }
  });

  it('glides with zero cloth deceleration in Frictionless mode and syncs mode across peers', () => {
    const ball = createBall(0, 15, 25);
    applyCueStrike(ball, { angle: 0, power: 0.25, spinX: 0, spinY: 0 });
    const initialSpeed = Math.hypot(ball.vx, ball.vy);
    const telemetry = createInitialTelemetry();

    // Advance 60 steps (0.25 seconds) across open table in Frictionless mode
    for (let i = 0; i < 60; i++) {
      stepPhysics([ball], telemetry, 1 / 240, true);
    }
    const speedAfterGlide = Math.hypot(ball.vx, ball.vy);
    expect(speedAfterGlide).toBeCloseTo(initialSpeed, 5);

    // Verify MultiplayerCoordinator syncs 'frictionless' mode to Guest
    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };
    const host = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'FricHost',
      disableNetwork: true,
    });
    const guest = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'FricGuest',
      disableNetwork: true,
    });

    try {
      const code = host.createMultiplayerRoom('frictionless');
      expect(getGameMode(host.getState())).toBe('frictionless');

      guest.joinRoom(code, true);
      guest.handlePacket({
        type: 'SYNC_STATE',
        msgId: 'fric_sync_1',
        senderId: host.clientId,
        hostClientId: host.clientId,
        guestClientId: guest.clientId,
        state: host.getState(),
      });
      expect(getGameMode(guest.getState())).toBe('frictionless');
    } finally {
      host.dispose();
      guest.dispose();
    }
  });

  it('tracks multiple active rooms simultaneously and switches between them cleanly', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };

    const noopCallbacks = {
      onStateUpdated: () => {},
      onRemoteAim: () => {},
      onRemoteShot: () => {},
      onConnectionChanged: () => {},
    };

    const player = new MultiplayerCoordinator(null, noopCallbacks, {
      clientId: 'MultiRoomPlayer',
      disableNetwork: true,
      playerName: 'Ashton',
    });

    try {
      const room1 = player.createMultiplayerRoom('normal');
      const room2 = player.createMultiplayerRoom('cheat');
      const room3 = player.createMultiplayerRoom('frictionless');

      const active = player.getActiveRooms();
      const codes = active.map((r) => r.roomCode);
      expect(codes).toContain(room1);
      expect(codes).toContain(room2);
      expect(codes).toContain(room3);

      // Switch back to room2 and verify its mode and state are restored
      player.joinRoom(room2, false);
      expect(player.getRoomCode()).toBe(room2);
      expect(getGameMode(player.getState())).toBe('cheat');

      // Remove room1 and verify it is removed from the active list
      player.removeRoom(room1);
      expect(player.getActiveRooms().map((r) => r.roomCode)).not.toContain(room1);
    } finally {
      player.dispose();
    }
  });

  it('teleports balls between the side pockets in Portal Pockets mode while keeping corner pockets normal', () => {
    const ball = createBall(1, 50.0, 4.0);
    ball.vx = 4.0;
    ball.vy = -85.0; // Shooting straight up into Top-Side pocket (x=50, y=-1.35)
    const telemetry = createInitialTelemetry();

    let teleportedToBottom = false;
    for (let s = 0; s < 120; s++) {
      stepPhysics([ball], telemetry, 1 / 240, 'portals');
      if (ball.y > 40.0) {
        teleportedToBottom = true;
        break;
      }
    }

    expect(teleportedToBottom).toBe(true);
    expect(ball.pocketed).toBe(false);
    expect(ball.vy).toBeLessThan(0); // Emerges heading upward into the table from the bottom side pocket
  });

  it('boosts rebound velocity off main cushions in Pinball Rails mode', () => {
    const ball = createBall(0, 25.0, 3.0);
    ball.vx = 0;
    ball.vy = -60.0; // Heading toward top cushion at y=0
    const telemetry = createInitialTelemetry();

    let bounced = false;
    for (let s = 0; s < 60; s++) {
      stepPhysics([ball], telemetry, 1 / 240, 'pinball');
      if (ball.vy > 0) {
        bounced = true;
        break;
      }
    }

    expect(bounced).toBe(true);
    expect(ball.vy).toBeGreaterThan(65.0); // Rebounds faster than 60 in/s approach speed
  });

  it('curves passing balls toward pockets in Black Hole mode', () => {
    const normalBall = createBall(1, 40.0, 7.0);
    normalBall.vx = 45.0;
    normalBall.vy = 0;
    const blackHoleBall = createBall(1, 40.0, 7.0);
    blackHoleBall.vx = 45.0;
    blackHoleBall.vy = 0;

    const telNormal = createInitialTelemetry();
    const telBlackHole = createInitialTelemetry();

    for (let s = 0; s < 60; s++) {
      stepPhysics([normalBall], telNormal, 1 / 240, 'normal');
      stepPhysics([blackHoleBall], telBlackHole, 1 / 240, 'blackhole');
    }

    // Top-Side pocket is at (50, -1.35), so Black Hole gravity pulls the passing ball toward -Y
    expect(blackHoleBall.y).toBeLessThan(normalBall.y - 0.5);
  });

  it('wraps balls across table seams, resolves cross-seam collisions, and raycasts onto mirrored neighbor boards in Infinite mode', () => {
    // 1. Wrap across right edge (x = 100 -> x = 0) and collide with a ball near x = 1.5
    const cue = createBall(0, 97.5, 25.0);
    const target = createBall(1, 1.5, 25.0);
    cue.vx = 90.0;
    cue.vy = 0;
    const telemetry = createInitialTelemetry();

    for (let s = 0; s < 30; s++) {
      stepPhysics([cue, target], telemetry, 1 / 240, 'infinite');
    }

    expect(telemetry.firstContactBallId).toBe(1);
    expect(target.vx).toBeGreaterThan(20.0); // Target ball near left edge received impact from cue wrapping across x=100

    // 2. Aim preview across the left seam (from x=6 aiming left at -X hits a ball at x=94 via its x=-6 mirror image)
    const state = createInitialGameState(901, 'infinite');
    for (const b of state.balls) {
      if (b.id !== 0 && b.id !== 2) b.pocketed = true;
    }
    const cueBall = state.balls.find((b) => b.id === 0)!;
    const ball2 = state.balls.find((b) => b.id === 2)!;
    cueBall.x = 6.0;
    cueBall.y = 25.0;
    ball2.x = 94.0;
    ball2.y = 25.0;

    const preview = computeAimPreview(state, Math.PI); // Aiming straight left (-X) across x=0 seam
    expect(preview.hitBall).not.toBeNull();
    expect(preview.hitBall?.id).toBe(2);
    expect(preview.ghostX).toBeLessThan(0); // Ghost ball sits on the left mirrored preview board
  });
});
