import {
  ALL_TABLE_MODIFIERS,
  BallGroup,
  CheatPreview,
  GameSetupOptions,
  GameState,
  TableModifier,
  computeAimPreview,
  computeCheatPreview,
  evaluateShotOutcome,
  findNearestValidCueBallPosition,
  formatStateModifiersLabel,
  getPhysicsFlagsFromState,
  getRemainingBallsForGroup,
  getTableModifiers,
  hasModifier,
  isPlayerOnEightBall,
  isSharedCheatEnabled,
} from './game/rules';
import {
  INFINITE_PREVIEW_BORDER,
  TableViewport,
  computeTableViewport,
  screenToTable,
} from './game/viewport';
import { MultiplayerCoordinator, RoomSummary } from './net/sync';
import { BALL_COLORS, BALL_RADIUS, FIXED_DT, RAIL_BORDER } from './physics/constants';
import {
  CueStrikeParams,
  ShotTelemetry,
  applyCueStrike,
  cloneBalls,
  createInitialTelemetry,
  getMaxBallSpeed,
  simulateUntilRest,
  stepPhysics,
} from './physics/engine';
import { clamp } from './physics/vector';
import { renderPoolTable } from './ui/renderer';
import { CameraViewMode, Pool3DRenderer } from './ui/renderer3d';
import { BilliardSoundEngine } from './ui/sound';

// DOM Elements
const stageEl = document.getElementById('table-stage') as HTMLElement;
const canvas3d = document.getElementById('pool-canvas-3d') as HTMLCanvasElement;
const canvas = document.getElementById('pool-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const camPillGroup = document.getElementById('cam-pill-group') as HTMLElement;
const camPillButtons = Array.from(
  camPillGroup.querySelectorAll<HTMLButtonElement>('.cam-pill-btn')
);
const soundToggleBtn = document.getElementById('sound-toggle-btn') as HTMLButtonElement;
const soundIconOn = document.getElementById('sound-icon-on') as HTMLElement;
const soundIconOff = document.getElementById('sound-icon-off') as HTMLElement;

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
const installAppBtn = document.getElementById('install-app-btn') as HTMLButtonElement;

const winnerBanner = document.getElementById('winner-banner') as HTMLElement;
const winnerTitle = document.getElementById('winner-title') as HTMLElement;
const rematchBtn = document.getElementById('rematch-btn') as HTMLButtonElement;

const controlDock = document.getElementById('control-dock') as HTMLElement;
const spinTrigger = document.getElementById('spin-trigger') as HTMLButtonElement;
const spinDotMini = document.getElementById('spin-dot-mini') as HTMLElement;
const fineAimWrap = document.getElementById('fine-aim-wrap') as HTMLElement;
const fineAimLeft = document.getElementById('fine-aim-left') as HTMLButtonElement;
const fineAimRight = document.getElementById('fine-aim-right') as HTMLButtonElement;
const fineAimWheel = document.getElementById('fine-aim-wheel') as HTMLElement;
const fineAimTicks = document.getElementById('fine-aim-ticks') as HTMLElement;
const powerTrack = document.getElementById('power-track') as HTMLElement;
const powerFill = document.getElementById('power-fill') as HTMLElement;
const powerThumb = document.getElementById('power-thumb') as HTMLElement;
const powerHint = document.getElementById('power-hint') as HTMLElement;
const shootBtn = document.getElementById('shoot-btn') as HTMLButtonElement;

// Modals
const spinModal = document.getElementById('spin-modal') as HTMLElement;
const spinPad = document.getElementById('spin-pad') as HTMLElement;
const spinContactDot = document.getElementById('spin-contact-dot') as HTMLElement;
const spinResetBtn = document.getElementById('spin-reset-btn') as HTMLButtonElement;
const spinDoneBtn = document.getElementById('spin-done-btn') as HTMLButtonElement;

const roomModal = document.getElementById('room-modal') as HTMLElement;
const modalRoomStatus = document.getElementById('modal-room-status') as HTMLElement;
const playerNameInput = document.getElementById('player-name-input') as HTMLInputElement;
const gameModeSelect = document.getElementById('game-mode-select') as HTMLSelectElement;
const secretCheatOption = document.getElementById('secret-cheat-option') as HTMLOptionElement;
const modifierChipsContainer = document.getElementById('modifier-chips') as HTMLElement;
const modifierChipButtons = Array.from(
  modifierChipsContainer.querySelectorAll<HTMLButtonElement>('.modifier-chip')
);
const newRoomBtn = document.getElementById('new-room-btn') as HTMLButtonElement;
const copyLinkBtn = document.getElementById('copy-link-btn') as HTMLButtonElement;
const leaveRoomBtn = document.getElementById('leave-room-btn') as HTMLButtonElement;
const joinRoomForm = document.getElementById('join-room-form') as HTMLFormElement;
const joinCodeInput = document.getElementById('join-code-input') as HTMLInputElement;
const newRackBtn = document.getElementById('new-rack-btn') as HTMLButtonElement;
const closeModalBtn = document.getElementById('close-modal-btn') as HTMLButtonElement;
const roomsCountBadge = document.getElementById('rooms-count-badge') as HTMLElement;
const activeRoomsList = document.getElementById('active-rooms-list') as HTMLElement;

const nameModal = document.getElementById('name-modal') as HTMLElement;
const nameModalForm = document.getElementById('name-modal-form') as HTMLFormElement;
const nameModalInput = document.getElementById('name-modal-input') as HTMLInputElement;

// Audio & 3D Renderer Initialization
const soundEngine = new BilliardSoundEngine();
const STORAGE_CAM_MODE_KEY = 'pool8_cam_mode_v1';
let cameraViewMode: CameraViewMode = 'cue';
try {
  const savedCam = localStorage.getItem(STORAGE_CAM_MODE_KEY) as CameraViewMode | null;
  if (savedCam === 'cue' || savedCam === 'broadcast' || savedCam === 'overhead' || savedCam === '2d') {
    cameraViewMode = savedCam;
  }
} catch {
  // Ignore storage errors
}

let renderer3d: Pool3DRenderer | null = null;
try {
  renderer3d = new Pool3DRenderer(canvas3d);
} catch {
  // Graceful fallback to 2D canvas if WebGL is disabled
  cameraViewMode = '2d';
}

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
let currentTimeScale = 1;
let lastFrameTime = performance.now();

// Pre-allocated collision sound tracking buffers (zero per-step GC allocations)
const preStepVx = new Float64Array(16);
const preStepVy = new Float64Array(16);
const preStepPocketed = new Uint8Array(16);

// Pointer Interaction State
let isDraggingCueBall = false;
let isAimingOnCanvas = false;
let isOrbitingCamera3D = false;
let isPullingPower = false;
let isDraggingSpin = false;
let isDraggingFineAim = false;
let lastFineAimX = 0;
let fineTickOffset = 0;
let lastAimPointerAngle = 0;
let lastAimClientX = 0;
let lastAimClientY = 0;
let lastAimMoveTime = 0;
let lastAimBroadcastAt = 0;
const active3DPointers = new Map<number, { x: number; y: number }>();
let prevPinchDist = 0;
let prevPinchMidX = 0;
let prevPinchMidY = 0;

let cachedCheatKey = '';
let cachedCheatPreview: CheatPreview | null = null;
let lastOrientedSeq = -1;
let lastOrientedRackSeed = -1;
const selectedModifiers = new Set<TableModifier>();
const STORAGE_SECRET_CHEAT_KEY = 'pool8_secret_cheat_v1';
let secretCheatForAshton = false;
try {
  secretCheatForAshton = localStorage.getItem(STORAGE_SECRET_CHEAT_KEY) === '1';
} catch {
  // Ignore storage errors
}
let coordinator!: MultiplayerCoordinator;

function syncSoundButtonUi(): void {
  const muted = soundEngine.isMuted();
  soundToggleBtn.classList.toggle('muted', muted);
  soundIconOn.classList.toggle('hidden', muted);
  soundIconOff.classList.toggle('hidden', !muted);
}
syncSoundButtonUi();

soundToggleBtn.addEventListener('click', () => {
  soundEngine.toggleMuted();
  syncSoundButtonUi();
});

function setCameraViewMode(mode: CameraViewMode): void {
  const effectiveMode: CameraViewMode = !renderer3d ? '2d' : mode;
  cameraViewMode = effectiveMode;
  try {
    localStorage.setItem(STORAGE_CAM_MODE_KEY, effectiveMode);
  } catch {
    // Ignore storage errors
  }

  for (const btn of camPillButtons) {
    const isMatch = btn.dataset.cam === effectiveMode;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-pressed', String(isMatch));
  }

  const use2d = effectiveMode === '2d';
  canvas3d.classList.toggle('hidden', use2d);
  canvas.classList.toggle('hidden', !use2d);

  if (renderer3d && !use2d) {
    renderer3d.setCameraMode(effectiveMode);
  }
  resizeCanvas();
}

for (const btn of camPillButtons) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.cam as CameraViewMode | undefined;
    if (mode) {
      setCameraViewMode(mode);
    }
  });
}

function isPlayerAshton(): boolean {
  const nameFromInput = playerNameInput ? playerNameInput.value.trim() : '';
  const nameFromCoord = coordinator ? coordinator.getMyPlayerName().trim() : '';
  const effective = (nameFromInput || nameFromCoord).toLowerCase();
  return effective === 'ashton';
}

function setSecretCheatForAshton(enabled: boolean): void {
  secretCheatForAshton = enabled;
  try {
    if (enabled) {
      localStorage.setItem(STORAGE_SECRET_CHEAT_KEY, '1');
    } else {
      localStorage.removeItem(STORAGE_SECRET_CHEAT_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

function isLocalCheatActive(state: GameState): boolean {
  if (isSharedCheatEnabled(state)) return true;
  return secretCheatForAshton && isPlayerAshton();
}

function syncModifierChipButtonsUi(): void {
  for (const btn of modifierChipButtons) {
    const mod = btn.dataset.mod as TableModifier | undefined;
    const isActive = Boolean(mod && selectedModifiers.has(mod));
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
}

function syncControlsFromState(state: GameState): void {
  selectedModifiers.clear();
  for (const mod of getTableModifiers(state)) {
    selectedModifiers.add(mod);
  }
  syncModifierChipButtonsUi();

  const sharedCheat = isSharedCheatEnabled(state);
  const ashton = isPlayerAshton();
  gameModeSelect.value =
    secretCheatForAshton && ashton && !sharedCheat
      ? 'secret_cheat'
      : sharedCheat
      ? 'cheat'
      : 'normal';
}

for (const btn of modifierChipButtons) {
  btn.addEventListener('click', () => {
    const mod = btn.dataset.mod as TableModifier | undefined;
    if (!mod) return;
    if (selectedModifiers.has(mod)) {
      selectedModifiers.delete(mod);
    } else {
      selectedModifiers.add(mod);
    }
    syncModifierChipButtonsUi();
  });
}

function resolveSelectedGameSetup(): GameSetupOptions {
  const val = gameModeSelect.value;
  let cheatMode = false;
  if (val === 'secret_cheat' && isPlayerAshton()) {
    setSecretCheatForAshton(true);
    cheatMode = false;
  } else if (val === 'cheat') {
    setSecretCheatForAshton(false);
    cheatMode = true;
  } else {
    setSecretCheatForAshton(false);
    cheatMode = false;
  }
  const modifiers = ALL_TABLE_MODIFIERS.filter((m) => selectedModifiers.has(m));
  return { modifiers, cheatMode };
}

// Parse initial URL ?room=CODE
const urlParams = new URLSearchParams(window.location.search);
const initialRoomParam = urlParams.get('room');
if (initialRoomParam) {
  roomModal.classList.add('hidden');
}

coordinator = new MultiplayerCoordinator(initialRoomParam, {
  onStateUpdated: (newState) => {
    if (!coordinator) return;
    isSimulating = false;
    pendingSettledStateFromRemote = null;
    if (newState.seq !== lastOrientedSeq || newState.rackSeed !== lastOrientedRackSeed) {
      autoOrientAimTowardLegalTarget();
    }
    syncHud();
  },
  onRemoteAim: (aim) => {
    if (!coordinator) return;
    if (!isSimulating && !coordinator.isMyTurn()) {
      aimAngle = aim.angle;
      pullBackPower = aim.power;
      spinX = aim.spinX;
      spinY = aim.spinY;
      updatePowerUi(pullBackPower);
      updateSpinUi();
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
      }
    }
  },
  onRemoteShot: (shot) => {
    if (!coordinator) return;
    const state = coordinator.getState();
    const cueBall = state.balls.find((b) => b.id === 0);
    if (cueBall) {
      cueBall.x = shot.cueX;
      cueBall.y = shot.cueY;
      applyCueStrike(cueBall, shot.strike);
    }
    renderer3d?.notifyShotFired(shot.cueX, shot.cueY, shot.strike);
    soundEngine.playCueStrike(shot.strike.power);
    activeTelemetry = createInitialTelemetry();
    pendingSettledStateFromRemote = shot.settledState;
    physicsAccumulator = 0;
    currentTimeScale = 1;
    lastFrameTime = performance.now();
    isSimulating = true;
    pullBackPower = 0;
    updatePowerUi(0);
    syncHud();
  },
  onConnectionChanged: () => {
    if (!coordinator) return;
    syncHud();
  },
});

syncControlsFromState(coordinator.getState());

function resizeCanvas(): void {
  const rect = stageEl.getBoundingClientRect();
  if (renderer3d && cameraViewMode !== '2d') {
    renderer3d.resize(rect.width, rect.height);
  }
  const isInfinite = coordinator ? hasModifier(coordinator.getState(), 'infinite') : false;
  const borderInches = isInfinite ? INFINITE_PREVIEW_BORDER : RAIL_BORDER;
  viewport = computeTableViewport(rect.width, rect.height, 3.5, borderInches);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(viewport.widthCss * dpr);
  canvas.height = Math.round(viewport.heightCss * dpr);
  canvas.style.width = `${viewport.widthCss}px`;
  canvas.style.height = `${viewport.heightCss}px`;
}

window.addEventListener('resize', resizeCanvas);
setCameraViewMode(cameraViewMode);

/**
 * Automatically points the cue stick toward the closest legal object ball at the start of a turn.
 */
function autoOrientAimTowardLegalTarget(): void {
  const state = coordinator.getState();
  const isCheat = isLocalCheatActive(state);
  lastOrientedSeq = state.seq;
  lastOrientedRackSeed = state.rackSeed;
  if (isCheat && pullBackPower < 0.05) {
    pullBackPower = state.isBreakShot ? 0.72 : 0.42;
  } else if (!isCheat) {
    pullBackPower = 0;
  }
  updatePowerUi(pullBackPower);

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

function formatStatusWithPlayerNames(rawMessage: string, p1Label: string, p2Label: string): string {
  return rawMessage
    .replace(/\bPlayer 1\b/g, p1Label)
    .replace(/\bPlayer 2\b/g, p2Label);
}

function renderActiveRoomsList(): void {
  const rooms: RoomSummary[] = coordinator.getActiveRooms();
  roomsCountBadge.textContent = String(rooms.length);
  activeRoomsList.innerHTML = '';

  if (rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rooms-empty';
    empty.textContent = 'No active rooms yet — create a new room or join with a code.';
    activeRoomsList.appendChild(empty);
    return;
  }

  const myName = coordinator.getMyPlayerName();

  for (const r of rooms) {
    const p1 = r.hostName || (r.mySeat === 0 && myName ? myName : 'Player 1');
    const p2 =
      r.guestName ||
      (r.mySeat === 1 && myName ? myName : r.guestClientId ? 'Player 2' : 'Waiting...');
    const isMyTurnInRoom =
      r.winner === null && r.mySeat !== null && r.currentPlayer === r.mySeat;

    const card = document.createElement('div');
    card.className = 'room-card';
    if (r.isCurrentRoom) card.classList.add('current-room');
    if (isMyTurnInRoom) card.classList.add('my-turn-room');

    const main = document.createElement('div');
    main.className = 'room-card-main';

    const top = document.createElement('div');
    top.className = 'room-card-top';

    const playersEl = document.createElement('span');
    playersEl.className = 'room-card-players';
    playersEl.textContent = `${p1} vs ${p2}`;

    const codeEl = document.createElement('span');
    codeEl.className = 'room-card-code';
    codeEl.textContent = `#${r.roomCode}`;

    const modeEl = document.createElement('span');
    modeEl.className = 'room-card-mode';
    modeEl.textContent = r.modeLabel;

    top.appendChild(playersEl);
    top.appendChild(codeEl);
    top.appendChild(modeEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'room-card-status';
    if (isMyTurnInRoom) {
      statusEl.classList.add('my-turn');
    }

    if (r.winner !== null) {
      const winName = r.winner === 0 ? p1 : p2;
      statusEl.textContent = `Finished · ${winName} won`;
    } else if (isMyTurnInRoom) {
      statusEl.textContent = 'Your Turn — Tap to play';
    } else if (r.mySeat !== null) {
      const oppName = r.mySeat === 0 ? p2 : p1;
      statusEl.textContent = !r.guestClientId
        ? 'Waiting for opponent to join'
        : `${oppName}'s Turn`;
    } else if (!r.guestClientId) {
      statusEl.textContent = 'Open Seat — Tap to join';
    } else {
      statusEl.textContent = formatStatusWithPlayerNames(r.statusMessage, p1, p2);
    }

    main.appendChild(top);
    main.appendChild(statusEl);

    const actions = document.createElement('div');
    actions.className = 'room-card-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = isMyTurnInRoom || r.isCurrentRoom ? 'room-card-btn primary' : 'room-card-btn';
    openBtn.textContent = r.isCurrentRoom ? 'Playing' : r.mySeat === null && !r.guestClientId ? 'Join' : 'Open';
    openBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!requireNameFromModalInput()) return;
      if (coordinator.getRoomCode() !== r.roomCode) {
        coordinator.joinRoom(r.roomCode, false);
      }
      roomModal.classList.add('hidden');
      syncHud();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'room-card-remove';
    removeBtn.title = 'Remove room';
    removeBtn.setAttribute('aria-label', `Remove room ${r.roomCode}`);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      coordinator.removeRoom(r.roomCode);
      syncHud();
    });

    actions.appendChild(openBtn);
    actions.appendChild(removeBtn);

    card.appendChild(main);
    card.appendChild(actions);

    card.addEventListener('click', () => {
      if (!requireNameFromModalInput()) return;
      if (coordinator.getRoomCode() !== r.roomCode) {
        coordinator.joinRoom(r.roomCode, false);
      }
      roomModal.classList.add('hidden');
      syncHud();
    });

    activeRoomsList.appendChild(card);
  }
}

function hasRequiredMultiplayerName(): boolean {
  if (!coordinator.getRoomCode()) return true;
  return coordinator.getMyPlayerName().trim().length > 0;
}

function syncHud(): void {
  const state = coordinator.getState();
  const roomCode = coordinator.getRoomCode();
  const mySeat = coordinator.getMySeat();
  const peerOnline = coordinator.isPeerConnected();
  const myName = coordinator.getMyPlayerName();
  const hostName = coordinator.getHostName();
  const guestName = coordinator.getGuestName();
  const isSpectator =
    Boolean(roomCode) &&
    mySeat === null &&
    Boolean(coordinator.getHostClientId()) &&
    Boolean(coordinator.getGuestClientId());

  if (document.activeElement !== playerNameInput) {
    playerNameInput.value = myName;
  }

  // If in a multiplayer room and the player hasn't entered a name yet, prompt them immediately
  if (roomCode && !myName && roomModal.classList.contains('hidden')) {
    nameModal.classList.remove('hidden');
  } else if (myName) {
    nameModal.classList.add('hidden');
  }

  const p1Display = roomCode
    ? hostName || (mySeat === 0 && myName ? myName : 'Player 1')
    : 'Player 1';
  const p2Display = roomCode
    ? guestName || (mySeat === 1 && myName ? myName : peerOnline ? 'Player 2' : 'Waiting...')
    : 'Player 2';
  const p2StatusName = roomCode
    ? guestName || (mySeat === 1 && myName ? myName : 'Player 2')
    : 'Player 2';

  // Player names & turn highlight
  if (roomCode && mySeat !== null) {
    p1Name.textContent = mySeat === 0 ? `${p1Display} (You)` : p1Display;
    p2Name.textContent = mySeat === 1 ? `${p2Display} (You)` : p2Display;
  } else if (isSpectator) {
    p1Name.textContent = p1Display;
    p2Name.textContent = p2Display;
  } else {
    p1Name.textContent = p1Display;
    p2Name.textContent = p2Display;
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

  // Status message with real player names
  const formattedStatus = roomCode
    ? formatStatusWithPlayerNames(state.statusMessage, p1Display, p2StatusName)
    : state.statusMessage;
  statusChip.textContent = formattedStatus;
  statusChip.classList.toggle('foul', state.lastFoulReason !== null && state.winner === null);

  // Room button & Game Mode UI state
  const isInfinite = hasModifier(state, 'infinite');
  const targetBorder = isInfinite ? INFINITE_PREVIEW_BORDER : RAIL_BORDER;
  if (viewport.borderInches !== targetBorder) {
    resizeCanvas();
  }
  const ashton = isPlayerAshton();
  secretCheatOption.classList.toggle('hidden', !ashton);
  secretCheatOption.disabled = !ashton;
  if (!ashton && gameModeSelect.value === 'secret_cheat') {
    gameModeSelect.value = isSharedCheatEnabled(state) ? 'cheat' : 'normal';
  }

  const isCheat = isLocalCheatActive(state);
  const modeTag = formatStateModifiersLabel(state);
  const modeSuffix = modeTag === 'Normal' ? '' : ` · ${modeTag}`;
  const modeLabel = modeTag === 'Normal' ? '' : ` (${modeTag})`;

  if (roomModal.classList.contains('hidden')) {
    syncControlsFromState(state);
  }
  fineAimWrap.classList.toggle('hidden', !isCheat);
  shootBtn.classList.toggle('hidden', !isCheat);
  if (isCheat && pullBackPower < 0.05 && !isSimulating) {
    pullBackPower = state.isBreakShot ? 0.72 : 0.42;
  } else if (!isCheat && !isPullingPower && !isSimulating) {
    pullBackPower = 0;
  }
  updatePowerUi(pullBackPower);

  const allRooms = coordinator.getActiveRooms();
  const otherMyTurnCount = allRooms.filter(
    (r) => !r.isCurrentRoom && r.winner === null && r.mySeat !== null && r.currentPlayer === r.mySeat
  ).length;
  const turnBadgeSuffix = otherMyTurnCount > 0 ? ` (${otherMyTurnCount})` : '';

  if (!roomCode) {
    connDot.className = otherMyTurnCount > 0 ? 'conn-dot waiting' : 'conn-dot';
    roomBtnLabel.textContent = `Rooms${modeSuffix}${turnBadgeSuffix}`;
    modalRoomStatus.textContent = `Local Pass & Play${modeLabel}`;
    copyLinkBtn.textContent = 'Share New Room';
  } else {
    connDot.className = peerOnline ? 'conn-dot connected' : 'conn-dot waiting';
    const baseRoomLabel = isSpectator ? `Room ${roomCode} (View)` : `Room ${roomCode}`;
    roomBtnLabel.textContent = `${baseRoomLabel}${modeSuffix}${turnBadgeSuffix}`;
    const opponentName = mySeat === 0 ? guestName : mySeat === 1 ? hostName : null;
    modalRoomStatus.textContent = isSpectator
      ? `Room ${roomCode} — Spectating`
      : peerOnline
      ? `Room ${roomCode} — ${opponentName ? `vs ${opponentName}` : 'Opponent Connected'}`
      : `Room ${roomCode} — Waiting for Opponent`;
  }

  renderActiveRoomsList();

  // Winner overlay (allow 3D pocket-drop rattle to finish briefly if winning 8-ball is falling!)
  const dropStillFalling =
    cameraViewMode !== '2d' && Boolean(renderer3d && renderer3d.hasActivePocketDrops());
  if (state.winner !== null && !isSimulating && !dropStillFalling) {
    winnerBanner.classList.remove('hidden');
    winnerTitle.textContent = formattedStatus;
  } else if (state.winner !== null && !isSimulating && dropStillFalling) {
    winnerBanner.classList.add('hidden');
    window.setTimeout(() => {
      syncHud();
    }, 360);
  } else {
    winnerBanner.classList.add('hidden');
  }

  // Enable/disable controls based on turn & required multiplayer name
  const canControl =
    !isSimulating &&
    state.winner === null &&
    coordinator.isMyTurn() &&
    hasRequiredMultiplayerName();
  controlDock.classList.toggle('disabled', !canControl);
}

function maybeBroadcastAim(): void {
  const now = performance.now();
  if (now - lastAimBroadcastAt < 60) return;
  lastAimBroadcastAt = now;
  const state = coordinator.getState();
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall) return;
  // In Secret Cheat mode, keep broadcasted power at 0 while aiming so opponent sees normal aiming
  const isSecretOnly = secretCheatForAshton && isPlayerAshton() && !isSharedCheatEnabled(state);
  const broadcastPower = isSecretOnly && !isPullingPower ? 0 : pullBackPower;
  coordinator.broadcastAim(aimAngle, broadcastPower, spinX, spinY, cueBall.x, cueBall.y);
}

// ============================================================================
// 3D WebGL Canvas Pointer, Pinch-Zoom & Camera Tilt Controls (#pool-canvas-3d)
// ============================================================================
canvas3d.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas3d.addEventListener(
  'wheel',
  (ev) => {
    if (!renderer3d || cameraViewMode === '2d') return;
    ev.preventDefault();
    const zoomScale = ev.deltaY > 0 ? 1.07 : 0.935;
    renderer3d.adjustCameraGesture(0, 0, zoomScale);
  },
  { passive: false }
);

function computeTwoFingerMetrics(): { dist: number; midX: number; midY: number } | null {
  if (active3DPointers.size < 2) return null;
  const pts = Array.from(active3DPointers.values());
  const a = pts[0];
  const b = pts[1];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    midX: (a.x + b.x) * 0.5,
    midY: (a.y + b.y) * 0.5,
  };
}

canvas3d.addEventListener('pointerdown', (ev) => {
  soundEngine.unlock();
  if (!renderer3d) return;

  const state = coordinator.getState();
  if (!hasRequiredMultiplayerName()) {
    nameModal.classList.remove('hidden');
    nameModalInput.focus();
    return;
  }

  canvas3d.setPointerCapture(ev.pointerId);
  active3DPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  // Multi-touch (2 fingers): pinch to zoom & drag vertically/horizontally to tilt/orbit camera!
  if (active3DPointers.size >= 2) {
    isAimingOnCanvas = false;
    isDraggingCueBall = false;
    isOrbitingCamera3D = false;
    const metrics = computeTwoFingerMetrics();
    if (metrics) {
      prevPinchDist = metrics.dist;
      prevPinchMidX = metrics.midX;
      prevPinchMidY = metrics.midY;
    }
    return;
  }

  const canShootNow = !isSimulating && state.winner === null && coordinator.isMyTurn();

  // Desktop right/middle click, Shift+drag, or swiping in TV mode when not shooting -> camera orbit/tilt!
  if (
    ev.button === 2 ||
    ev.button === 1 ||
    ev.shiftKey ||
    (!canShootNow && cameraViewMode === 'broadcast')
  ) {
    isOrbitingCamera3D = true;
    isAimingOnCanvas = false;
    isDraggingCueBall = false;
    lastAimClientX = ev.clientX;
    lastAimClientY = ev.clientY;
    return;
  }

  if (!canShootNow) return;

  const rect = canvas3d.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const pt = renderer3d.screenToTable(sx, sy);
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return;

  // Check both 3D raycast distance and projected screen-pixel distance so grabbing cue ball works from low angles
  const cueScreen = renderer3d.tableToScreen(cueBall.x, cueBall.y);
  const screenDistToCue = Math.hypot(sx - cueScreen.x, sy - cueScreen.y);
  const tableDistToCue = pt ? Math.hypot(pt.x - cueBall.x, pt.y - cueBall.y) : Infinity;

  if (state.ballInHand && (tableDistToCue <= BALL_RADIUS * 2.6 || screenDistToCue <= 34)) {
    isDraggingCueBall = true;
    isAimingOnCanvas = false;
    return;
  }

  isAimingOnCanvas = true;
  isDraggingCueBall = false;
  lastAimClientX = ev.clientX;
  lastAimClientY = ev.clientY;
  lastAimMoveTime = performance.now();
  if (pt) {
    lastAimPointerAngle = Math.atan2(pt.y - cueBall.y, pt.x - cueBall.x);
  }
});

canvas3d.addEventListener('pointermove', (ev) => {
  if (!renderer3d) return;
  if (active3DPointers.has(ev.pointerId)) {
    active3DPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  }

  // Two-finger pinch zoom & camera tilt
  if (active3DPointers.size >= 2) {
    const metrics = computeTwoFingerMetrics();
    if (metrics && prevPinchDist > 8) {
      const zoomScale = prevPinchDist / Math.max(12, metrics.dist);
      const dMidX = metrics.midX - prevPinchMidX;
      const dMidY = metrics.midY - prevPinchMidY;
      renderer3d.adjustCameraGesture(-dMidX * 0.0055, dMidY * 0.0045, zoomScale);
      prevPinchDist = metrics.dist;
      prevPinchMidX = metrics.midX;
      prevPinchMidY = metrics.midY;
    }
    return;
  }

  if (isOrbitingCamera3D) {
    const dx = ev.clientX - lastAimClientX;
    const dy = ev.clientY - lastAimClientY;
    lastAimClientX = ev.clientX;
    lastAimClientY = ev.clientY;
    renderer3d.adjustCameraGesture(-dx * 0.0055, dy * 0.0045, 1.0);
    return;
  }

  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  if (!isDraggingCueBall && !isAimingOnCanvas) return;

  const rect = canvas3d.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const pt = renderer3d.screenToTable(sx, sy);
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return;

  if (isDraggingCueBall && state.ballInHand) {
    if (pt) {
      const valid = findNearestValidCueBallPosition(pt.x, pt.y, state.balls, state.isBreakShot);
      cueBall.x = valid.x;
      cueBall.y = valid.y;
      maybeBroadcastAim();
    }
    return;
  }

  if (isAimingOnCanvas) {
    if (cameraViewMode === 'cue') {
      // Velocity-adaptive horizontal swipe aiming: slow drag = surgical precision, fast swipe = quick turn
      const now = performance.now();
      const dtMs = Math.max(4, now - lastAimMoveTime);
      const dx = ev.clientX - lastAimClientX;
      lastAimClientX = ev.clientX;
      lastAimClientY = ev.clientY;
      lastAimMoveTime = now;

      const speedPxPerMs = Math.abs(dx) / dtMs;
      const sensitivity = clamp(0.00085 + speedPxPerMs * 0.005, 0.00085, 0.0056);
      aimAngle += dx * sensitivity;
      maybeBroadcastAim();
    } else if (pt) {
      // Overhead / Broadcast 3D view: smooth relative angle rotation around cue ball
      const dist = Math.hypot(pt.x - cueBall.x, pt.y - cueBall.y);
      const curAngle = Math.atan2(pt.y - cueBall.y, pt.x - cueBall.x);
      if (dist >= BALL_RADIUS * 1.4) {
        let delta = curAngle - lastAimPointerAngle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const sensitivity = dist > 25 ? 0.65 : 0.9;
        aimAngle += delta * sensitivity;
        maybeBroadcastAim();
      }
      lastAimPointerAngle = curAngle;
    }
  }
});

const endCanvas3DPointer = (ev: PointerEvent) => {
  active3DPointers.delete(ev.pointerId);
  if (active3DPointers.size === 0) {
    if (isDraggingCueBall) {
      const cueBall = coordinator.getState().balls.find((b) => b.id === 0);
      if (cueBall && !cueBall.pocketed) {
        coordinator.persistCueBallPlacement(cueBall.x, cueBall.y);
        maybeBroadcastAim();
      }
    }
    isDraggingCueBall = false;
    isAimingOnCanvas = false;
    isOrbitingCamera3D = false;
  } else if (active3DPointers.size === 2) {
    const metrics = computeTwoFingerMetrics();
    if (metrics) {
      prevPinchDist = metrics.dist;
      prevPinchMidX = metrics.midX;
      prevPinchMidY = metrics.midY;
    }
  }
};
canvas3d.addEventListener('pointerup', endCanvas3DPointer);
canvas3d.addEventListener('pointercancel', endCanvas3DPointer);

// ============================================================================
// Classic 2D Canvas Pointer Events (#pool-canvas)
// ============================================================================
canvas.addEventListener('pointerdown', (ev) => {
  soundEngine.unlock();
  const state = coordinator.getState();
  if (!hasRequiredMultiplayerName()) {
    nameModal.classList.remove('hidden');
    nameModalInput.focus();
    return;
  }
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

  // Otherwise aim the cue stick relatively from its current angle (never snap on pointerdown)
  isAimingOnCanvas = true;
  isDraggingCueBall = false;
  lastAimPointerAngle = Math.atan2(pt.y - cueBall.y, pt.x - cueBall.x);
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
    const dist = Math.hypot(pt.x - cueBall.x, pt.y - cueBall.y);
    const curAngle = Math.atan2(pt.y - cueBall.y, pt.x - cueBall.x);
    if (dist >= BALL_RADIUS * 1.5) {
      let delta = curAngle - lastAimPointerAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;

      // Smooth relative rotation from current aimAngle
      const sensitivity = dist > 25 ? 0.65 : 0.9;
      aimAngle += delta * sensitivity;
      maybeBroadcastAim();
    }
    lastAimPointerAngle = curAngle;
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

// Power Slider Events (Pull-back to Shoot in normal mode; Set Power in Cheat Mode)
function updatePowerUi(power: number): void {
  const isCheat = coordinator ? isLocalCheatActive(coordinator.getState()) : false;
  const pct = Math.round(power * 100);
  powerFill.style.width = `${pct}%`;
  const trackWidth = powerTrack.clientWidth || 260;
  const maxLeft = Math.max(6, trackWidth - 32);
  powerThumb.style.left = `${6 + power * (maxLeft - 6)}px`;
  if (isCheat) {
    powerHint.textContent = `Power: ${Math.max(5, pct)}%`;
  } else if (power <= 0.03) {
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
  soundEngine.unlock();
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  isPullingPower = true;
  powerTrack.setPointerCapture(ev.pointerId);
  const rawPower = computePowerFromPointer(ev.clientX);
  const isCheat = isLocalCheatActive(state);
  pullBackPower = isCheat ? clamp(rawPower, 0.05, 1.0) : rawPower;
  updatePowerUi(pullBackPower);
  maybeBroadcastAim();
});

powerTrack.addEventListener('pointermove', (ev) => {
  if (!isPullingPower) return;
  const state = coordinator.getState();
  const rawPower = computePowerFromPointer(ev.clientX);
  const isCheat = isLocalCheatActive(state);
  pullBackPower = isCheat ? clamp(rawPower, 0.05, 1.0) : rawPower;
  updatePowerUi(pullBackPower);
  maybeBroadcastAim();
});

const finishPowerPull = () => {
  if (!isPullingPower) return;
  isPullingPower = false;
  const state = coordinator.getState();

  // In Cheat Mode, releasing the power slider keeps the selected power; player taps Shoot to fire
  if (isLocalCheatActive(state)) {
    pullBackPower = clamp(pullBackPower, 0.05, 1.0);
    updatePowerUi(pullBackPower);
    maybeBroadcastAim();
    return;
  }

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
  const state = coordinator.getState();
  if (!isLocalCheatActive(state)) {
    pullBackPower = 0;
  }
  updatePowerUi(pullBackPower);
});

// Shoot Button (Cheat Mode)
shootBtn.addEventListener('click', () => {
  soundEngine.unlock();
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  const finalPower = clamp(pullBackPower || 0.42, 0.05, 1.0);
  executeShot({
    angle: aimAngle,
    power: finalPower,
    spinX,
    spinY,
  });
});

// Fine Angle Adjustment Controls (Cheat Mode)
function nudgeFineAngle(deltaRad: number, tickPx: number): void {
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  aimAngle += deltaRad;
  fineTickOffset = (fineTickOffset + tickPx) % 36;
  fineAimTicks.style.backgroundPositionX = `${fineTickOffset}px`;
  maybeBroadcastAim();
}

fineAimLeft.addEventListener('click', () => {
  nudgeFineAngle(-0.0014, -3);
});

fineAimRight.addEventListener('click', () => {
  nudgeFineAngle(0.0014, 3);
});

fineAimWheel.addEventListener('pointerdown', (ev) => {
  const state = coordinator.getState();
  if (isSimulating || state.winner !== null || !coordinator.isMyTurn()) return;
  isDraggingFineAim = true;
  lastFineAimX = ev.clientX;
  fineAimWheel.setPointerCapture(ev.pointerId);
});

fineAimWheel.addEventListener('pointermove', (ev) => {
  if (!isDraggingFineAim) return;
  const dx = ev.clientX - lastFineAimX;
  lastFineAimX = ev.clientX;
  // 0.0011 rad (~0.063 deg) per pixel of drag for ultra-precise angle control
  nudgeFineAngle(dx * 0.0011, dx);
});

const endFineAimDrag = () => {
  isDraggingFineAim = false;
};
fineAimWheel.addEventListener('pointerup', endFineAimDrag);
fineAimWheel.addEventListener('pointercancel', endFineAimDrag);

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
  const flags = getPhysicsFlagsFromState(state);
  const simBalls = cloneBalls(state.balls);
  const simCue = simBalls.find((b) => b.id === 0)!;
  applyCueStrike(simCue, strike);
  const simTelemetry = createInitialTelemetry();
  simulateUntilRest(simBalls, simTelemetry, undefined, flags);
  const settledState = evaluateShotOutcome(state, simBalls, simTelemetry);

  // 2. Record pending shot in localStorage & broadcast to peer
  coordinator.recordShotStart(cueX, cueY, strike, settledState);

  // 3. Trigger 3D cue strike animation, sound & real-time 240Hz visual physics simulation
  renderer3d?.notifyShotFired(cueX, cueY, strike);
  soundEngine.playCueStrike(strike.power);

  applyCueStrike(cueBall, strike);
  activeTelemetry = createInitialTelemetry();
  pendingSettledStateFromRemote = settledState;
  physicsAccumulator = 0;
  currentTimeScale = 1;
  lastFrameTime = performance.now();
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
function requireNameFromModalInput(): string | null {
  const val = playerNameInput.value.trim() || coordinator.getMyPlayerName().trim();
  if (!val) {
    playerNameInput.classList.add('input-error');
    playerNameInput.focus();
    return null;
  }
  playerNameInput.classList.remove('input-error');
  coordinator.setMyPlayerName(val);
  return val;
}

playerNameInput.addEventListener('input', () => {
  if (playerNameInput.value.trim().length > 0) {
    playerNameInput.classList.remove('input-error');
  }
  const ashton = isPlayerAshton();
  secretCheatOption.classList.toggle('hidden', !ashton);
  secretCheatOption.disabled = !ashton;
});

gameModeSelect.addEventListener('change', () => {
  if (gameModeSelect.value === 'secret_cheat' && isPlayerAshton()) {
    setSecretCheatForAshton(true);
    syncHud();
  } else if (
    (gameModeSelect.value === 'normal' || gameModeSelect.value === 'cheat') &&
    secretCheatForAshton
  ) {
    setSecretCheatForAshton(false);
    syncHud();
  }
});

playerNameInput.addEventListener('change', () => {
  const trimmed = playerNameInput.value.trim();
  if (trimmed.length > 0) {
    playerNameInput.classList.remove('input-error');
    coordinator.setMyPlayerName(trimmed);
    syncHud();
  }
});

nameModalForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const trimmed = nameModalInput.value.trim();
  if (!trimmed) {
    nameModalInput.classList.add('input-error');
    nameModalInput.focus();
    return;
  }
  nameModalInput.classList.remove('input-error');
  coordinator.setMyPlayerName(trimmed);
  playerNameInput.value = trimmed;
  nameModal.classList.add('hidden');
  syncHud();
});

roomBtn.addEventListener('click', () => {
  syncControlsFromState(coordinator.getState());
  syncHud();
  roomModal.classList.remove('hidden');
  if (!coordinator.getMyPlayerName()) {
    playerNameInput.focus();
  }
});

closeModalBtn.addEventListener('click', () => {
  soundEngine.unlock();
  if (coordinator.getRoomCode() && !coordinator.getMyPlayerName()) {
    if (!requireNameFromModalInput()) return;
  }
  roomModal.classList.add('hidden');
  syncControlsFromState(coordinator.getState());
  syncHud();
});

async function copyInviteLinkForRoom(code: string, btn: HTMLButtonElement, defaultLabel: string): Promise<void> {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
  try {
    await navigator.clipboard.writeText(shareUrl);
    btn.textContent = `Copied (${code})!`;
  } catch {
    btn.textContent = `Room: ${code}`;
  }
  window.setTimeout(() => {
    btn.textContent = defaultLabel;
  }, 2200);
}

newRoomBtn.addEventListener('click', async () => {
  soundEngine.unlock();
  if (!requireNameFromModalInput()) return;
  const code = coordinator.createMultiplayerRoom(resolveSelectedGameSetup());
  autoOrientAimTowardLegalTarget();
  syncHud();
  await copyInviteLinkForRoom(code, newRoomBtn, '+ New Room');
});

copyLinkBtn.addEventListener('click', async () => {
  soundEngine.unlock();
  if (!requireNameFromModalInput()) return;

  let code = coordinator.getRoomCode();
  if (!code) {
    code = coordinator.createMultiplayerRoom(resolveSelectedGameSetup());
    autoOrientAimTowardLegalTarget();
  }
  syncHud();
  await copyInviteLinkForRoom(code, copyLinkBtn, 'Copy Invite Link');
});

leaveRoomBtn.addEventListener('click', () => {
  coordinator.leaveRoomToSolo();
  roomModal.classList.add('hidden');
  syncHud();
});

joinRoomForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  soundEngine.unlock();
  if (!requireNameFromModalInput()) return;

  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length >= 2) {
    coordinator.joinRoom(code, false);
    joinCodeInput.value = '';
    roomModal.classList.add('hidden');
    syncHud();
  }
});

const handleStartNewRack = () => {
  soundEngine.unlock();
  isSimulating = false;
  pendingSettledStateFromRemote = null;
  coordinator.startNewGame(resolveSelectedGameSetup());
  autoOrientAimTowardLegalTarget();
  roomModal.classList.add('hidden');
  syncHud();
};

newRackBtn.addEventListener('click', handleStartNewRack);
rematchBtn.addEventListener('click', handleStartNewRack);

// Close modals on backdrop click
for (const backdrop of [spinModal, roomModal]) {
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) {
      backdrop.classList.add('hidden');
      syncHud();
    }
  });
}

function getMemoizedCheatPreview(state: GameState): CheatPreview | null {
  const cueBall = state.balls.find((b) => b.id === 0);
  if (!cueBall || cueBall.pocketed) return null;
  const effectivePower = clamp(pullBackPower || (state.isBreakShot ? 0.72 : 0.42), 0.05, 1.0);
  const modeKey = formatStateModifiersLabel(state);
  const key = `${state.seq}_${modeKey}_${cueBall.x.toFixed(4)}_${cueBall.y.toFixed(4)}_${aimAngle.toFixed(6)}_${effectivePower.toFixed(4)}_${spinX.toFixed(3)}_${spinY.toFixed(3)}`;
  if (key !== cachedCheatKey || !cachedCheatPreview) {
    cachedCheatKey = key;
    cachedCheatPreview = computeCheatPreview(state, {
      angle: aimAngle,
      power: effectivePower,
      spinX,
      spinY,
    });
  }
  return cachedCheatPreview;
}

// Main 60-120fps Render & 240Hz Fixed-Timestep Physics Loop
function animate(now: number): void {
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  const state = coordinator.getState();
  const flags = getPhysicsFlagsFromState(state);
  const isFrictionless = flags.frictionless;

  if (isSimulating) {
    // In Frictionless mode, once the fastest ball slows below 22 in/s, smoothly ramp up timeScale
    // so the remaining glide/ricochets stay visually brisk without sudden frame jumps.
    let targetTimeScale = 1;
    if (isFrictionless) {
      const maxSpeed = getMaxBallSpeed(state.balls);
      if (maxSpeed > 0 && maxSpeed < 22) {
        targetTimeScale = clamp(24 / Math.max(1.1, maxSpeed), 1.0, 12);
      }
    }
    currentTimeScale += (targetTimeScale - currentTimeScale) * 0.1;

    physicsAccumulator += Math.min(0.033, dt) * currentTimeScale;
    let stepsThisFrame = 0;
    while (physicsAccumulator >= FIXED_DT && stepsThisFrame < 40) {
      physicsAccumulator -= FIXED_DT;
      stepsThisFrame++;

      // Snapshot velocities prior to substep to synthesize exact collision & pocket drop audio
      for (let i = 0; i < state.balls.length; i++) {
        const b = state.balls[i];
        preStepVx[b.id] = b.vx;
        preStepVy[b.id] = b.vy;
        preStepPocketed[b.id] = b.pocketed ? 1 : 0;
      }

      const stillMoving = stepPhysics(state.balls, activeTelemetry, FIXED_DT, flags);

      // Detect pocket drops, ball-ball clicks, and K-66 cushion bounces
      let impulseBalls = 0;
      let maxDeltaV = 0;
      for (let i = 0; i < state.balls.length; i++) {
        const b = state.balls[i];
        if (!preStepPocketed[b.id] && b.pocketed) {
          soundEngine.playPocketDrop(Math.hypot(preStepVx[b.id], preStepVy[b.id]));
        } else if (!b.pocketed) {
          const dv = Math.hypot(b.vx - preStepVx[b.id], b.vy - preStepVy[b.id]);
          if (dv > 4.2) {
            impulseBalls++;
            if (dv > maxDeltaV) maxDeltaV = dv;
          }
        }
      }
      if (impulseBalls >= 2) {
        soundEngine.playBallCollision(maxDeltaV);
      } else if (impulseBalls === 1) {
        soundEngine.playCushionBounce(maxDeltaV);
      }

      if (!stillMoving) {
        isSimulating = false;
        physicsAccumulator = 0;
        currentTimeScale = 1;
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
  const isCheat = isLocalCheatActive(state);
  const aimPreview = showAim && !isCheat ? computeAimPreview(state, aimAngle) : null;
  const cheatPreview = showAim && isCheat ? getMemoizedCheatPreview(state) : null;

  const renderInput = {
    aimAngle,
    shotPower: pullBackPower,
    pullBackAmount: pullBackPower,
    spinX,
    spinY,
    showAim,
    isDraggingCueBall,
  };

  if (renderer3d && cameraViewMode !== '2d') {
    renderer3d.render(
      state,
      renderInput,
      aimPreview,
      cheatPreview,
      isSimulating,
      coordinator.isMyTurn(),
      dt
    );
  } else {
    renderPoolTable(ctx, viewport, state, renderInput, aimPreview, cheatPreview);
  }

  requestAnimationFrame(animate);
}

autoOrientAimTowardLegalTarget();
syncHud();
requestAnimationFrame(animate);

// Progressive Web App (PWA) Service Worker & Android Install Prompt
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let autoPromptAttempted = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

window.addEventListener('beforeinstallprompt', (ev) => {
  deferredInstallPrompt = ev as BeforeInstallPromptEvent;
  installAppBtn.classList.remove('hidden');
});

async function triggerInstallPrompt(): Promise<void> {
  if (!deferredInstallPrompt) return;
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === 'accepted') {
      installAppBtn.classList.add('hidden');
    } else {
      installAppBtn.classList.remove('hidden');
    }
  } catch {
    // Ignore if already used
  }
}

installAppBtn.addEventListener('click', () => {
  triggerInstallPrompt();
});

// Trigger Android native install prompt on first user tap if browser captured beforeinstallprompt
window.addEventListener(
  'pointerup',
  () => {
    if (deferredInstallPrompt && !autoPromptAttempted) {
      autoPromptAttempted = true;
      triggerInstallPrompt();
    }
  },
  { passive: true }
);

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installAppBtn.classList.add('hidden');
});
