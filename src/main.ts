import {
  BallGroup,
  GameState,
  computeAimPreview,
  evaluateShotOutcome,
  findNearestValidCueBallPosition,
  getRemainingBallsForGroup,
  isPlayerOnEightBall,
} from './game/rules';
import {
  TableViewport,
  computeTableViewport,
  screenToTable,
} from './game/viewport';
import { MultiplayerCoordinator } from './net/sync';
import { BALL_COLORS, BALL_RADIUS, FIXED_DT } from './physics/constants';
import {
  CueStrikeParams,
  ShotTelemetry,
  applyCueStrike,
  cloneBalls,
  createInitialTelemetry,
  simulateUntilRest,
  stepPhysics,
} from './physics/engine';
import { clamp } from './physics/vector';
import { renderPoolTable } from './ui/renderer';

// DOM Elements
const stageEl = document.getElementById('table-stage') as HTMLElement;
const canvas = document.getElementById('pool-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const p1Pill = document.getElementById('p1-pill') as HTMLElement;
const p2Pill = document.getElementById('p2-pill') as HTMLElement;
const p1Name = document.getElementById('p1-name') as HTMLElement;
const p2Name = document.getElementById('p2-name') as HTMLElement;
const p1GroupTag = document.getElementById('p1-group') as HTMLElement;
const p2GroupTag = document.getElementById('p2-group') as HTMLElement;
const p1BallsEl = document.getElementById('p1-balls') as HTMLElement;
const p2BallsEl = document.getElementById('p2-balls') as HTMLElement;
const statusChip = document.getElementById('status-chip') as HTMLElement;

const roomBtn = document.getElementById('room-btn') as HTMLButtonElement;
const connDot = document.getElementById('conn-dot') as HTMLElement;
const roomBtnLabel = document.getElementById('room-btn-label') as HTMLElement;

const winnerBanner = document.getElementById('winner-banner') as HTMLElement;
const winnerTitle = document.getElementById('winner-title') as HTMLElement;
const rematchBtn = document.getElementById('rematch-btn') as HTMLButtonElement;

const controlDock = document.getElementById('control-dock') as HTMLElement;
const spinTrigger = document.getElementById('spin-trigger') as HTMLButtonElement;
const spinDotMini = document.getElementById('spin-dot-mini') as HTMLElement;
const powerTrack = document.getElementById('power-track') as HTMLElement;
const powerFill = document.getElementById('power-fill') as HTMLElement;
const powerThumb = document.getElementById('power-thumb') as HTMLElement;
const powerHint = document.getElementById('power-hint') as HTMLElement;

// Modals
const spinModal = document.getElementById('spin-modal') as HTMLElement;
const spinPad = document.getElementById('spin-pad') as HTMLElement;
const spinContactDot = document.getElementById('spin-contact-dot') as HTMLElement;
const spinResetBtn = document.getElementById('spin-reset-btn') as HTMLButtonElement;
const spinDoneBtn = document.getElementById('spin-done-btn') as HTMLButtonElement;

const roomModal = document.getElementById('room-modal') as HTMLElement;
const modalRoomStatus = document.getElementById('modal-room-status') as HTMLElement;
const copyLinkBtn = document.getElementById('copy-link-btn') as HTMLButtonElement;
const leaveRoomBtn = document.getElementById('leave-room-btn') as HTMLButtonElement;
const joinRoomForm = document.getElementById('join-room-form') as HTMLFormElement;
const joinCodeInput = document.getElementById('join-code-input') as HTMLInputElement;
const newRackBtn = document.getElementById('new-rack-btn') as HTMLButtonElement;
const closeModalBtn = document.getElementById('close-modal-btn') as HTMLButtonElement;

// Application State
let viewport: TableViewport = computeTableViewport(window.innerWidth, window.innerHeight - 110);
let aimAngle = 0; // Radians (0 points right toward the foot spot rack)
let spinX = 0;
let spinY = 0;
let pullBackPower = 0;
let isSimulating = false;
let activeTelemetry: ShotTelemetry = createInitialTelemetry();
let pendingSettledStateFromRemote: GameState | null = null;
let physicsAccumulator = 0;
let lastFrameTime = performance.now();

// Pointer Interaction State
let isDraggingCueBall = false;
let isAimingOnCanvas = false;
let lastAimPointerAngle = 0;
let lastAimBroadcastAt = 0;

// Parse initial URL ?room=CODE
const urlParams = new URLSearchParams(window.location.search);
const initialRoomParam = urlParams.get('room');

const coordinator = new MultiplayerCoordinator(initialRoomParam, {
  onStateUpdated: (_newState) => {
    isSimulating = false;
    pendingSettledStateFromRemote = null;
    autoOrientAimTowardLegalTarget();
    syncHud();
  },
  onRemoteAim: (aim) => {
    if (!isSimulating && !coordinator.isMyTurn()) {
      aimAngle = aim.angle;
      pullBackPower = aim.power;
      spinX = aim.spinX;
      spinY = aim.spinY;
      const state = coordinator.getState();
      const cueBall = state.balls.find((b) => b.id === 0);
      if (state.ballInHand && cueBall && !cueBall.pocketed) {
        const valid = findNearestValidCueBallPosition(
          aim.cueX,
          aim.cueY,
          state.balls,
          state.isBreakShot
        );
        cueBall.x = valid.x;
        cueBall.y = valid.y;
        coordinator.persistCueBallPlacement(valid.x, valid.y);
      }
    }
  },
  onRemoteShot: (shot) => {
    const state = coordinator.getState();
    const cueBall = state.balls.find((b) => b.id === 0);
    if (cueBall) {
      cueBall.x = shot.cueX;
      cueBall.y = shot.cueY;
      applyCueStrike(cueBall, shot.strike);
    }
    activeTelemetry = createInitialTelemetry();
    pendingSettledStateFromRemote = shot.settledState;
    isSimulating = true;
    pullBackPower = 0;
    updatePowerUi(0);
    syncHud();
  },
  onConnectionChanged: () => {
    syncHud();
  },
});

function resizeCanvas(): void {
  const rect = stageEl.getBoundingClientRect();
  viewport = computeTableViewport(rect.width, rect.height);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(viewport.widthCss * dpr);
  canvas.height = Math.round(viewport.heightCss * dpr);
  canvas.style.width = `${viewport.widthCss}px`;
  canvas.style.height = `${viewport.heightCss}px`;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/**
 * Automatically points the cue stick toward the closest legal object ball at the start of a turn.
 */
function autoOrientAimTowardLegalTarget(): void {
  const state = coordinator.getState();
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return;

  if (state.isBreakShot) {
    aimAngle = Math.atan2(25 - cueBall.y, 75 - cueBall.x);
    return;
  }

  const shooterGroup = state.playerGroups[state.currentPlayer];
  const onEight = isPlayerOnEightBall(state, state.currentPlayer);

  let bestDist = Infinity;
  let bestBall = null;

  for (const b of state.balls) {
    if (b.id === 0 || b.pocketed) continue;
    const isLegal = state.tableOpen
      ? b.id !== 8
      : onEight
      ? b.id === 8
      : (shooterGroup === 'solids' && b.id >= 1 && b.id <= 7) ||
        (shooterGroup === 'stripes' && b.id >= 9 && b.id <= 15);
    if (!isLegal) continue;
    const d = Math.hypot(b.x - cueBall.x, b.y - cueBall.y);
    if (d < bestDist) {
      bestDist = d;
      bestBall = b;
    }
  }

  if (bestBall) {
    aimAngle = Math.atan2(bestBall.y - cueBall.y, bestBall.x - cueBall.x);
  }
}

function renderMiniBalls(container: HTMLElement, group: BallGroup | null, state: GameState): void {
  container.innerHTML = '';
  if (!group) {
    // Open table: show 7 neutral dots
    for (let i = 0; i < 7; i++) {
      const dot = document.createElement('span');
      dot.className = 'mini-ball';
      dot.style.backgroundColor = 'rgba(255,255,255,0.18)';
      container.appendChild(dot);
    }
    return;
  }

  const remaining = getRemainingBallsForGroup(state.balls, group);
  if (remaining.length === 0) {
    // Show 8-ball target indicator
    const eightDot = document.createElement('span');
    eightDot.className = 'mini-ball';
    eightDot.style.backgroundColor = BALL_COLORS[8];
    container.appendChild(eightDot);
    return;
  }

  for (const b of remaining) {
    const dot = document.createElement('span');
    dot.className = b.id >= 9 ? 'mini-ball stripe' : 'mini-ball';
    dot.style.backgroundColor = BALL_COLORS[b.id];
    dot.style.setProperty('--ball-color', BALL_COLORS[b.id]);
    container.appendChild(dot);
  }
}

function syncHud(): void {
  const state = coordinator.getState();
  const roomCode = coordinator.getRoomCode();
  const mySeat = coordinator.getMySeat();
  const peerOnline = coordinator.isPeerConnected();
  const isSpectator =
    Boolean(roomCode) &&
    mySeat === null &&
    Boolean(coordinator.getHostClientId()) &&
    Boolean(coordinator.getGuestClientId());

  // Player names & turn highlight
  if (roomCode && mySeat !== null) {
    p1Name.textContent = mySeat === 0 ? 'P1 (You)' : 'P1';
    p2Name.textContent = mySeat === 1 ? 'P2 (You)' : 'P2';
  } else if (isSpectator) {
    p1Name.textContent = 'P1';
    p2Name.textContent = 'P2';
  } else {
    p1Name.textContent = 'Player 1';
    p2Name.textContent = 'Player 2';
  }

  p1Pill.classList.toggle('active-turn', state.currentPlayer === 0 && state.winner === null);
  p2Pill.classList.toggle('active-turn', state.currentPlayer === 1 && state.winner === null);

  const formatGroupTag = (p: 0 | 1): string => {
    const g = state.playerGroups[p];
    if (!g) return 'Open';
    if (isPlayerOnEightBall(state, p)) return '8-Ball';
    return g === 'solids' ? 'Solids' : 'Stripes';
  };

  p1GroupTag.textContent = formatGroupTag(0);
  p2GroupTag.textContent = formatGroupTag(1);

  renderMiniBalls(p1BallsEl, state.playerGroups[0], state);
  renderMiniBalls(p2BallsEl, state.playerGroups[1], state);

  // Status message
  statusChip.textContent = state.statusMessage;
  statusChip.classList.toggle('foul', state.lastFoulReason !== null && state.winner === null);

  // Room button
  if (!roomCode) {
    connDot.className = 'conn-dot';
    roomBtnLabel.textContent = 'Multiplayer';
    modalRoomStatus.textContent = 'Mode: Local Pass & Play';
    leaveRoomBtn.classList.add('hidden');
  } else {
    connDot.className = peerOnline ? 'conn-dot connected' : 'conn-dot waiting';
    roomBtnLabel.textContent = isSpectator ? `Room ${roomCode} (View)` : `Room ${roomCode}`;
    modalRoomStatus.textContent = isSpectator
      ? `Room ${roomCode} — Spectating`
      : peerOnline
      ? `Room ${roomCode} — Opponent Connected`
      : `Room ${roomCode} — Waiting for Opponent`;
    leaveRoomBtn.classList.remove('hidden');
  }

  // Winner overlay
  if (state.winner !== null && !isSimulating) {
    winnerBanner.classList.remove('hidden');
    winnerTitle.textContent = state.statusMessage;
  } else {
    winnerBanner.classList.add('hidden');
  }

  // Enable/disable controls based on turn
  const canControl = !isSimulating && state.winner === null && coordinator.isMyTurn();
  controlDock.classList.toggle('disabled', !canControl);
}

function maybeBroadcastAim(): void {
  const now = performance.now();
  if (now - lastAimBroadcastAt < 60) return;
  lastAimBroadcastAt = now;
  const cueBall = coordinator.getState().balls.find((b) => b.id === 0);
  if (!cueBall) return;
  coordinator.broadcastAim(aimAngle, pullBackPower, spinX, spinY, cueBall.x, cueBall.y);
}

// Canvas Pointer Events (Aiming & Ball-in-Hand Placement)
canvas.addEventListener('pointerdown', (ev) => {
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;

  canvas.setPointerCapture(ev.pointerId);
  const rect = canvas.getBoundingClientRect();
  const pt = screenToTable(viewport, ev.clientX - rect.left, ev.clientY - rect.top);
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return;

  const distToCue = Math.hypot(pt.x - cueBall.x, pt.y - cueBall.y);

  // If Ball-in-Hand and touching on/near the cue ball, drag the cue ball
  if (state.ballInHand && distToCue <= BALL_RADIUS * 2.5) {
    isDraggingCueBall = true;
    isAimingOnCanvas = false;
    return;
  }

  // Otherwise aim the cue stick
  isAimingOnCanvas = true;
  isDraggingCueBall = false;
  lastAimPointerAngle = Math.atan2(pt.y - cueBall.y, pt.x - cueBall.x);

  // If user taps far from cue ball, snap aim toward the tapped point initially
  if (distToCue > BALL_RADIUS * 2.5) {
    aimAngle = lastAimPointerAngle;
    maybeBroadcastAim();
  }
});

canvas.addEventListener('pointermove', (ev) => {
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  if (!isDraggingCueBall && !isAimingOnCanvas) return;

  const rect = canvas.getBoundingClientRect();
  const pt = screenToTable(viewport, ev.clientX - rect.left, ev.clientY - rect.top);
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return;

  if (isDraggingCueBall && state.ballInHand) {
    const valid = findNearestValidCueBallPosition(pt.x, pt.y, state.balls, state.isBreakShot);
    cueBall.x = valid.x;
    cueBall.y = valid.y;
    maybeBroadcastAim();
  } else if (isAimingOnCanvas) {
    const curAngle = Math.atan2(pt.y - cueBall.y, pt.x - cueBall.x);
    let delta = curAngle - lastAimPointerAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // Fine-aim sensitivity scaling based on distance from cue ball
    const dist = Math.hypot(pt.x - cueBall.x, pt.y - cueBall.y);
    const sensitivity = dist > 25 ? 0.65 : 1.0;
    aimAngle += delta * sensitivity;
    lastAimPointerAngle = curAngle;
    maybeBroadcastAim();
  }
});

const endCanvasPointer = () => {
  if (isDraggingCueBall) {
    const cueBall = coordinator.getState().balls.find((b) => b.id === 0);
    if (cueBall && !cueBall.pocketed) {
      coordinator.persistCueBallPlacement(cueBall.x, cueBall.y);
      maybeBroadcastAim();
    }
  }
  isDraggingCueBall = false;
  isAimingOnCanvas = false;
};
canvas.addEventListener('pointerup', endCanvasPointer);
canvas.addEventListener('pointercancel', endCanvasPointer);

// Power Slider Events (Pull-back to Shoot)
let isPullingPower = false;

function updatePowerUi(power: number): void {
  const pct = Math.round(power * 100);
  powerFill.style.width = `${pct}%`;
  const trackWidth = powerTrack.clientWidth || 260;
  const maxLeft = Math.max(6, trackWidth - 32);
  powerThumb.style.left = `${6 + power * (maxLeft - 6)}px`;
  if (power <= 0.03) {
    powerHint.textContent = 'Pull to shoot';
  } else {
    powerHint.textContent = `${pct}% — Release to shoot`;
  }
}

function computePowerFromPointer(clientX: number): number {
  const rect = powerTrack.getBoundingClientRect();
  return clamp((clientX - rect.left - 16) / Math.max(1, rect.width - 32), 0, 1);
}

powerTrack.addEventListener('pointerdown', (ev) => {
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  isPullingPower = true;
  powerTrack.setPointerCapture(ev.pointerId);
  pullBackPower = computePowerFromPointer(ev.clientX);
  updatePowerUi(pullBackPower);
  maybeBroadcastAim();
});

powerTrack.addEventListener('pointermove', (ev) => {
  if (!isPullingPower) return;
  pullBackPower = computePowerFromPointer(ev.clientX);
  updatePowerUi(pullBackPower);
  maybeBroadcastAim();
});

const finishPowerPull = () => {
  if (!isPullingPower) return;
  isPullingPower = false;
  const finalPower = pullBackPower;
  pullBackPower = 0;
  updatePowerUi(0);

  if (finalPower >= 0.04) {
    executeShot({
      angle: aimAngle,
      power: finalPower,
      spinX,
      spinY,
    });
  } else {
    maybeBroadcastAim();
  }
};

powerTrack.addEventListener('pointerup', finishPowerPull);
powerTrack.addEventListener('pointercancel', () => {
  isPullingPower = false;
  pullBackPower = 0;
  updatePowerUi(0);
});

/**
 * Executes a shot on the local table, pre-computing the deterministic settled outcome
 * so LocalStorage & remote peers are guaranteed to stay in sync even if a tab closes mid-shot.
 */
function executeShot(strike: CueStrikeParams): void {
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null) return;

  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return;

  const cueX = cueBall.x;
  const cueY = cueBall.y;

  // 1. Pre-compute deterministic settled state for persistence & peer sync
  const simBalls = cloneBalls(state.balls);
  const simCue = simBalls.find((b) => b.id === 0)!;
  applyCueStrike(simCue, strike);
  const simTelemetry = createInitialTelemetry();
  simulateUntilRest(simBalls, simTelemetry);
  const settledState = evaluateShotOutcome(state, simBalls, simTelemetry);

  // 2. Record pending shot in localStorage & broadcast to peer
  coordinator.recordShotStart(cueX, cueY, strike, settledState);

  // 3. Start real-time 240Hz visual physics simulation
  applyCueStrike(cueBall, strike);
  activeTelemetry = createInitialTelemetry();
  pendingSettledStateFromRemote = settledState;
  isSimulating = true;

  // Reset spin to center after shot
  spinX = 0;
  spinY = 0;
  updateSpinUi();
  syncHud();
}

// Cue Ball Spin Modal Controls
function updateSpinUi(): void {
  spinDotMini.style.left = `${50 + spinX * 38}%`;
  spinDotMini.style.top = `${50 - spinY * 38}%`;
  spinContactDot.style.left = `${50 + spinX * 40}%`;
  spinContactDot.style.top = `${50 - spinY * 40}%`;
}

spinTrigger.addEventListener('click', () => {
  spinModal.classList.remove('hidden');
});

spinDoneBtn.addEventListener('click', () => {
  spinModal.classList.add('hidden');
});

spinResetBtn.addEventListener('click', () => {
  spinX = 0;
  spinY = 0;
  updateSpinUi();
  maybeBroadcastAim();
});

let isDraggingSpin = false;
const handleSpinPadPointer = (ev: PointerEvent) => {
  const rect = spinPad.getBoundingClientRect();
  const radius = rect.width * 0.5;
  let dx = (ev.clientX - (rect.left + radius)) / (radius * 0.82);
  let dy = -(ev.clientY - (rect.top + radius)) / (radius * 0.82);
  const mag = Math.hypot(dx, dy);
  if (mag > 1) {
    dx /= mag;
    dy /= mag;
  }
  spinX = dx;
  spinY = dy;
  updateSpinUi();
  maybeBroadcastAim();
};

spinPad.addEventListener('pointerdown', (ev) => {
  isDraggingSpin = true;
  spinPad.setPointerCapture(ev.pointerId);
  handleSpinPadPointer(ev);
});
spinPad.addEventListener('pointermove', (ev) => {
  if (isDraggingSpin) handleSpinPadPointer(ev);
});
spinPad.addEventListener('pointerup', () => {
  isDraggingSpin = false;
});

// Room & Multiplayer Modal Controls
roomBtn.addEventListener('click', () => {
  syncHud();
  roomModal.classList.remove('hidden');
});

closeModalBtn.addEventListener('click', () => {
  roomModal.classList.add('hidden');
});

copyLinkBtn.addEventListener('click', async () => {
  let code = coordinator.getRoomCode();
  if (!code) {
    code = coordinator.createMultiplayerRoom();
  }
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
  try {
    await navigator.clipboard.writeText(shareUrl);
    copyLinkBtn.textContent = `Copied (${code})!`;
  } catch {
    copyLinkBtn.textContent = `Room: ${code}`;
  }
  syncHud();
  window.setTimeout(() => {
    copyLinkBtn.textContent = 'Invite / Copy Link';
  }, 2200);
});

leaveRoomBtn.addEventListener('click', () => {
  coordinator.leaveRoomToSolo();
  roomModal.classList.add('hidden');
  syncHud();
});

joinRoomForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length >= 2) {
    coordinator.joinRoom(code, false);
    joinCodeInput.value = '';
    roomModal.classList.add('hidden');
    syncHud();
  }
});

const handleStartNewRack = () => {
  isSimulating = false;
  pendingSettledStateFromRemote = null;
  coordinator.startNewGame();
  autoOrientAimTowardLegalTarget();
  roomModal.classList.add('hidden');
  syncHud();
};

newRackBtn.addEventListener('click', handleStartNewRack);
rematchBtn.addEventListener('click', handleStartNewRack);

// Close modals on backdrop click
for (const backdrop of [spinModal, roomModal]) {
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) backdrop.classList.add('hidden');
  });
}

// Main 60-120fps Render & 240Hz Fixed-Timestep Physics Loop
function animate(now: number): void {
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  const state = coordinator.getState();

  if (isSimulating) {
    physicsAccumulator += dt;
    while (physicsAccumulator >= FIXED_DT) {
      physicsAccumulator -= FIXED_DT;
      const stillMoving = stepPhysics(state.balls, activeTelemetry, FIXED_DT);
      if (!stillMoving) {
        isSimulating = false;
        physicsAccumulator = 0;
        const nextState =
          pendingSettledStateFromRemote ??
          evaluateShotOutcome(state, state.balls, activeTelemetry);
        pendingSettledStateFromRemote = null;
        coordinator.commitSettledState(nextState);
        autoOrientAimTowardLegalTarget();
        syncHud();
        break;
      }
    }
  }

  const showAim = !isSimulating && state.winner === null;
  const aimPreview = showAim ? computeAimPreview(state, aimAngle) : null;

  renderPoolTable(
    ctx,
    viewport,
    state,
    {
      aimAngle,
      shotPower: pullBackPower,
      pullBackAmount: pullBackPower,
      spinX,
      spinY,
      showAim,
      isDraggingCueBall,
    },
    aimPreview
  );

  requestAnimationFrame(animate);
}

autoOrientAimTowardLegalTarget();
syncHud();
requestAnimationFrame(animate);
