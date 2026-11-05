import mqtt, { MqttClient } from 'mqtt';
import { joinRoom, Room } from 'trystero/mqtt';
import {
  GameState,
  PlayerIndex,
  createInitialGameState,
  evaluateShotOutcome,
} from '../game/rules';
import {
  CueStrikeParams,
  applyCueStrike,
  cloneBalls,
  createInitialTelemetry,
  simulateUntilRest,
} from '../physics/engine';

const STORAGE_CLIENT_ID_KEY = 'pool8_client_id_v1';
const STORAGE_ACTIVE_SESSION_KEY = 'pool8_active_session_v1';
const STORAGE_ROOM_PREFIX = 'pool8_room_v1_';

export interface PendingShotRecord {
  baseState: GameState;
  cueX: number;
  cueY: number;
  strike: CueStrikeParams;
}

export interface PersistedSession {
  roomCode: string | null;
  mySeat: PlayerIndex | null;
  hostClientId: string | null;
  guestClientId: string | null;
  state: GameState;
  pendingShot: PendingShotRecord | null;
}

export type NetPacket =
  | {
      type: 'HELLO';
      msgId: string;
      senderId: string;
      knownSeq: number;
      state: GameState;
      hostClientId: string | null;
      guestClientId: string | null;
    }
  | {
      type: 'SYNC_STATE';
      msgId: string;
      senderId: string;
      hostClientId: string;
      guestClientId: string | null;
      state: GameState;
    }
  | {
      type: 'AIM_UPDATE';
      msgId: string;
      senderId: string;
      seat: PlayerIndex;
      angle: number;
      power: number;
      spinX: number;
      spinY: number;
      cueX: number;
      cueY: number;
    }
  | {
      type: 'SHOT_FIRED';
      msgId: string;
      senderId: string;
      seat: PlayerIndex;
      cueX: number;
      cueY: number;
      strike: CueStrikeParams;
      settledState: GameState;
    }
  | {
      type: 'NEW_GAME';
      msgId: string;
      senderId: string;
      state: GameState;
    };

export interface SyncCallbacks {
  onStateUpdated: (state: GameState, source: 'remote' | 'local' | 'reconnect') => void;
  onRemoteAim: (aim: {
    angle: number;
    power: number;
    spinX: number;
    spinY: number;
    cueX: number;
    cueY: number;
  }) => void;
  onRemoteShot: (shot: {
    cueX: number;
    cueY: number;
    strike: CueStrikeParams;
    settledState: GameState;
  }) => void;
  onConnectionChanged: (info: {
    roomCode: string | null;
    mySeat: PlayerIndex | null;
    peerConnected: boolean;
  }) => void;
}

function generateId(len: number = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_CLIENT_ID_KEY);
    if (existing && existing.length >= 6) return existing;
    const created = generateId(16);
    localStorage.setItem(STORAGE_CLIENT_ID_KEY, created);
    return created;
  } catch {
    return generateId(16);
  }
}

/**
 * Resolves a PendingShotRecord deterministically to its settled GameState.
 * Used when a player closes the tab while balls are still moving and reopens it.
 */
export function resolvePendingShot(pending: PendingShotRecord): GameState {
  const balls = cloneBalls(pending.baseState.balls);
  const cueBall = balls.find((b) => b.id === 0);
  if (cueBall) {
    cueBall.x = pending.cueX;
    cueBall.y = pending.cueY;
    applyCueStrike(cueBall, pending.strike);
  }
  const telemetry = createInitialTelemetry();
  simulateUntilRest(balls, telemetry);
  return evaluateShotOutcome(pending.baseState, balls, telemetry);
}

/**
 * Loads the persisted session from localStorage, automatically resolving any interrupted mid-shot state.
 */
export function loadPersistedSession(urlRoomCode: string | null): PersistedSession {
  try {
    if (urlRoomCode) {
      const roomRaw = localStorage.getItem(STORAGE_ROOM_PREFIX + urlRoomCode.toUpperCase());
      if (roomRaw) {
        const parsed = JSON.parse(roomRaw) as PersistedSession;
        if (parsed.pendingShot) {
          parsed.state = resolvePendingShot(parsed.pendingShot);
          parsed.pendingShot = null;
        }
        return parsed;
      }
    }

    const activeRaw = localStorage.getItem(STORAGE_ACTIVE_SESSION_KEY);
    if (activeRaw) {
      const parsed = JSON.parse(activeRaw) as PersistedSession;
      if (!urlRoomCode || parsed.roomCode === urlRoomCode.toUpperCase()) {
        if (parsed.pendingShot) {
          parsed.state = resolvePendingShot(parsed.pendingShot);
          parsed.pendingShot = null;
        }
        return parsed;
      }
    }
  } catch {
    // Ignore corrupted storage
  }

  return {
    roomCode: urlRoomCode ? urlRoomCode.toUpperCase() : null,
    mySeat: urlRoomCode ? null : null,
    hostClientId: null,
    guestClientId: null,
    state: createInitialGameState(),
    pendingShot: null,
  };
}

export function savePersistedSession(session: PersistedSession): void {
  try {
    const serialized = JSON.stringify(session);
    localStorage.setItem(STORAGE_ACTIVE_SESSION_KEY, serialized);
    if (session.roomCode) {
      localStorage.setItem(STORAGE_ROOM_PREFIX + session.roomCode.toUpperCase(), serialized);
    }
  } catch {
    // Ignore quota errors
  }
}

const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

export class MultiplayerCoordinator {
  public readonly clientId: string;
  private session: PersistedSession;
  private callbacks: SyncCallbacks;
  private seenMsgIds = new Set<string>();

  // Transports
  private bc: BroadcastChannel | null = null;
  private trysteroRoom: Room | null = null;
  private trysteroSend: ((data: NetPacket) => void) | null = null;
  private mqttClients: MqttClient[] = [];
  private peerLastSeenAt = 0;
  private heartbeatTimer: number | null = null;

  constructor(initialUrlRoom: string | null, callbacks: SyncCallbacks) {
    this.clientId = getOrCreateClientId();
    this.callbacks = callbacks;
    this.session = loadPersistedSession(initialUrlRoom);

    if (this.session.roomCode) {
      this.joinRoom(this.session.roomCode, false);
    } else {
      this.save();
    }
  }

  public getState(): GameState {
    return this.session.state;
  }

  public getRoomCode(): string | null {
    return this.session.roomCode;
  }

  public getMySeat(): PlayerIndex | null {
    return this.session.mySeat;
  }

  public isPeerConnected(): boolean {
    return Date.now() - this.peerLastSeenAt < 15000;
  }

  public isMyTurn(): boolean {
    if (!this.session.roomCode) return true; // Solo / Pass-and-Play mode
    if (this.session.mySeat === null) return false;
    return this.session.state.currentPlayer === this.session.mySeat;
  }

  public createMultiplayerRoom(): string {
    const code = generateRoomCode();
    this.session = {
      roomCode: code,
      mySeat: 0,
      hostClientId: this.clientId,
      guestClientId: null,
      state: createInitialGameState(),
      pendingShot: null,
    };
    this.save();
    this.joinRoom(code, true);
    return code;
  }

  public joinRoom(rawCode: string, resetIfNew: boolean = false): void {
    const code = rawCode.trim().toUpperCase();
    if (!code) return;

    this.disconnectTransports();

    // Check if we have a saved session for this room code
    const savedForRoom = loadPersistedSession(code);
    if (savedForRoom.roomCode === code && !resetIfNew && savedForRoom.hostClientId) {
      this.session = savedForRoom;
      if (this.session.hostClientId === this.clientId) {
        this.session.mySeat = 0;
      } else if (this.session.guestClientId === this.clientId) {
        this.session.mySeat = 1;
      }
    } else if (this.session.roomCode !== code) {
      this.session = {
        roomCode: code,
        mySeat: null,
        hostClientId: null,
        guestClientId: null,
        state: createInitialGameState(),
        pendingShot: null,
      };
    }

    this.save();
    this.updateUrlRoomParam(code);

    // 1. BroadcastChannel for instant local tab sync
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.bc = new BroadcastChannel(`pool8_room_${code}`);
        this.bc.onmessage = (ev) => {
          if (ev.data) this.handlePacket(ev.data as NetPacket);
        };
      } catch {
        // Ignore if unsupported
      }
    }

    // 2. Trystero WebRTC P2P Room
    try {
      this.trysteroRoom = joinRoom(
        { appId: 'antigravity-pool-8ball-v1', relayUrls: MQTT_BROKERS },
        code
      );
      const [sendPkt, getPkt] = this.trysteroRoom.makeAction<{ raw: string }>('pkt');
      this.trysteroSend = (pkt: NetPacket) => {
        try {
          sendPkt({ raw: JSON.stringify(pkt) });
        } catch {
          // Ignore send errors
        }
      };
      getPkt((data) => {
        try {
          if (data && typeof data.raw === 'string') {
            this.handlePacket(JSON.parse(data.raw) as NetPacket);
          }
        } catch {
          // Ignore malformed packet
        }
      });
      this.trysteroRoom.onPeerJoin(() => {
        this.peerLastSeenAt = Date.now();
        this.sendHello();
        this.notifyConnection();
      });
    } catch {
      // Fallback to MQTT-over-WSS & BroadcastChannel
    }

    // 3. Direct MQTT-over-WSS Pub/Sub Fallback (works even when WebRTC UDP is blocked by mobile NAT)
    const topic = `antigravity-pool8-v1/room/${code}`;
    for (const brokerUrl of MQTT_BROKERS) {
      try {
        const client = mqtt.connect(brokerUrl, {
          keepalive: 30,
          reconnectPeriod: 3000,
          connectTimeout: 8000,
        });
        client.on('connect', () => {
          client.subscribe(topic, { qos: 0 }, () => {
            this.sendHello();
          });
        });
        client.on('message', (_t, payload) => {
          try {
            const pkt = JSON.parse(payload.toString()) as NetPacket;
            this.handlePacket(pkt);
          } catch {
            // Ignore malformed packets
          }
        });
        this.mqttClients.push(client);
      } catch {
        // Ignore broker failure
      }
    }

    this.sendHello();
    // If no peer claims host within 900ms and we don't have a seat yet, we become host (Seat 0)
    window.setTimeout(() => {
      if (this.session.roomCode === code && this.session.mySeat === null) {
        this.session.hostClientId = this.clientId;
        this.session.mySeat = 0;
        this.save();
        this.notifyConnection();
        this.sendHello();
      }
    }, 900);

    this.heartbeatTimer = window.setInterval(() => {
      if (this.session.roomCode) {
        this.sendHello();
        this.notifyConnection();
      }
    }, 4500);

    this.notifyConnection();
  }

  public leaveRoomToSolo(): void {
    this.disconnectTransports();
    this.session.roomCode = null;
    this.session.mySeat = null;
    this.session.hostClientId = null;
    this.session.guestClientId = null;
    this.save();
    this.updateUrlRoomParam(null);
    this.notifyConnection();
  }

  public recordShotStart(cueX: number, cueY: number, strike: CueStrikeParams, settledState: GameState): void {
    this.session.pendingShot = {
      baseState: this.session.state,
      cueX,
      cueY,
      strike,
    };
    this.save();

    if (this.session.roomCode && this.session.mySeat !== null) {
      this.broadcast({
        type: 'SHOT_FIRED',
        msgId: generateId(),
        senderId: this.clientId,
        seat: this.session.mySeat,
        cueX,
        cueY,
        strike,
        settledState,
      });
    }
  }

  public commitSettledState(newState: GameState): void {
    this.session.state = newState;
    this.session.pendingShot = null;
    this.save();

    if (this.session.roomCode && this.session.hostClientId) {
      this.broadcast({
        type: 'SYNC_STATE',
        msgId: generateId(),
        senderId: this.clientId,
        hostClientId: this.session.hostClientId,
        guestClientId: this.session.guestClientId,
        state: newState,
      });
    }
  }

  public persistCueBallPlacement(x: number, y: number): void {
    const cueBall = this.session.state.balls.find((b) => b.id === 0);
    if (!cueBall) return;
    cueBall.x = x;
    cueBall.y = y;
    this.session.state.updatedAt = Date.now();
    this.save();
  }

  public broadcastAim(
    angle: number,
    power: number,
    spinX: number,
    spinY: number,
    cueX: number,
    cueY: number
  ): void {
    if (!this.session.roomCode || this.session.mySeat === null) return;
    this.broadcast({
      type: 'AIM_UPDATE',
      msgId: generateId(),
      senderId: this.clientId,
      seat: this.session.mySeat,
      angle,
      power,
      spinX,
      spinY,
      cueX,
      cueY,
    });
  }

  public startNewGame(): GameState {
    const fresh = createInitialGameState();
    fresh.seq = this.session.state.seq + 1;
    this.session.state = fresh;
    this.session.pendingShot = null;
    this.save();

    if (this.session.roomCode) {
      this.broadcast({
        type: 'NEW_GAME',
        msgId: generateId(),
        senderId: this.clientId,
        state: fresh,
      });
    }
    return fresh;
  }

  private sendHello(): void {
    if (!this.session.roomCode) return;
    this.broadcast({
      type: 'HELLO',
      msgId: generateId(),
      senderId: this.clientId,
      knownSeq: this.session.state.seq,
      state: this.session.state,
      hostClientId: this.session.hostClientId,
      guestClientId: this.session.guestClientId,
    });
  }

  private broadcast(pkt: NetPacket): void {
    this.seenMsgIds.add(pkt.msgId);
    if (this.seenMsgIds.size > 1000) {
      const first = this.seenMsgIds.values().next().value;
      if (first) this.seenMsgIds.delete(first);
    }

    if (this.bc) {
      try {
        this.bc.postMessage(pkt);
      } catch {
        // Ignore
      }
    }

    if (this.trysteroSend) {
      this.trysteroSend(pkt);
    }

    if (this.session.roomCode) {
      const topic = `antigravity-pool8-v1/room/${this.session.roomCode}`;
      const json = JSON.stringify(pkt);
      for (const client of this.mqttClients) {
        if (client.connected) {
          client.publish(topic, json, { qos: 0 });
        }
      }
    }
  }

  private handlePacket(pkt: NetPacket): void {
    if (!pkt || !pkt.msgId || pkt.senderId === this.clientId) return;
    if (this.seenMsgIds.has(pkt.msgId)) return;
    this.seenMsgIds.add(pkt.msgId);

    this.peerLastSeenAt = Date.now();

    switch (pkt.type) {
      case 'HELLO': {
        // Resolve host/guest seats
        if (!this.session.hostClientId && pkt.hostClientId) {
          this.session.hostClientId = pkt.hostClientId;
        }
        if (this.session.hostClientId === this.clientId) {
          this.session.mySeat = 0;
          if (!this.session.guestClientId || this.session.guestClientId === pkt.senderId) {
            this.session.guestClientId = pkt.senderId;
          }
        } else if (pkt.hostClientId && pkt.hostClientId !== this.clientId) {
          this.session.hostClientId = pkt.hostClientId;
          this.session.guestClientId = this.clientId;
          this.session.mySeat = 1;
        } else if (!this.session.hostClientId && !pkt.hostClientId) {
          // Tie-breaker by lexicographical clientId
          if (this.clientId < pkt.senderId) {
            this.session.hostClientId = this.clientId;
            this.session.guestClientId = pkt.senderId;
            this.session.mySeat = 0;
          } else {
            this.session.hostClientId = pkt.senderId;
            this.session.guestClientId = this.clientId;
            this.session.mySeat = 1;
          }
        }

        // State reconciliation: higher seq wins; on tie, host state wins
        if (
          pkt.state.seq > this.session.state.seq ||
          (pkt.state.seq === this.session.state.seq &&
            this.session.mySeat === 1 &&
            pkt.state.rackSeed !== this.session.state.rackSeed)
        ) {
          this.session.state = pkt.state;
          this.session.pendingShot = null;
          this.save();
          this.callbacks.onStateUpdated(this.session.state, 'reconnect');
        } else if (this.session.hostClientId) {
          // Reply with our authoritative state
          this.broadcast({
            type: 'SYNC_STATE',
            msgId: generateId(),
            senderId: this.clientId,
            hostClientId: this.session.hostClientId,
            guestClientId: this.session.guestClientId,
            state: this.session.state,
          });
        }

        this.save();
        this.notifyConnection();
        break;
      }

      case 'SYNC_STATE': {
        this.session.hostClientId = pkt.hostClientId;
        if (pkt.guestClientId) {
          this.session.guestClientId = pkt.guestClientId;
        }
        if (this.session.hostClientId === this.clientId) {
          this.session.mySeat = 0;
        } else if (
          this.session.guestClientId === this.clientId ||
          this.session.mySeat === null
        ) {
          this.session.guestClientId = this.clientId;
          this.session.mySeat = 1;
        }

        if (
          pkt.state.seq > this.session.state.seq ||
          (pkt.state.seq === this.session.state.seq &&
            pkt.state.rackSeed !== this.session.state.rackSeed)
        ) {
          this.session.state = pkt.state;
          this.session.pendingShot = null;
          this.save();
          this.callbacks.onStateUpdated(this.session.state, 'remote');
        }
        this.save();
        this.notifyConnection();
        break;
      }

      case 'AIM_UPDATE': {
        this.callbacks.onRemoteAim({
          angle: pkt.angle,
          power: pkt.power,
          spinX: pkt.spinX,
          spinY: pkt.spinY,
          cueX: pkt.cueX,
          cueY: pkt.cueY,
        });
        break;
      }

      case 'SHOT_FIRED': {
        this.callbacks.onRemoteShot({
          cueX: pkt.cueX,
          cueY: pkt.cueY,
          strike: pkt.strike,
          settledState: pkt.settledState,
        });
        break;
      }

      case 'NEW_GAME': {
        if (pkt.state.seq >= this.session.state.seq) {
          this.session.state = pkt.state;
          this.session.pendingShot = null;
          this.save();
          this.callbacks.onStateUpdated(this.session.state, 'remote');
        }
        break;
      }
    }
  }

  private save(): void {
    savePersistedSession(this.session);
  }

  private notifyConnection(): void {
    this.callbacks.onConnectionChanged({
      roomCode: this.session.roomCode,
      mySeat: this.session.mySeat,
      peerConnected: this.isPeerConnected(),
    });
  }

  private updateUrlRoomParam(code: string | null): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (code) {
      url.searchParams.set('room', code);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  }

  private disconnectTransports(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.bc) {
      try {
        this.bc.close();
      } catch {
        // Ignore
      }
      this.bc = null;
    }
    if (this.trysteroRoom) {
      try {
        this.trysteroRoom.leave();
      } catch {
        // Ignore
      }
      this.trysteroRoom = null;
      this.trysteroSend = null;
    }
    for (const c of this.mqttClients) {
      try {
        c.end(true);
      } catch {
        // Ignore
      }
    }
    this.mqttClients = [];
    this.peerLastSeenAt = 0;
  }
}
