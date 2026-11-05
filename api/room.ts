import { getCache } from '@vercel/functions';

interface StoredRoomPacket {
  type: 'SYNC_STATE';
  msgId: string;
  senderId: string;
  senderName?: string | null;
  hostClientId: string;
  guestClientId: string | null;
  hostName?: string | null;
  guestName?: string | null;
  state: {
    seq: number;
    rackSeed?: number;
    updatedAt?: number;
    [key: string]: unknown;
  };
}

// In-memory fallback for local dev or if regional cache is unavailable
const memoryFallback = new Map<string, StoredRoomPacket>();

const ROOM_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function normalizeCode(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

async function getRoomFromCache(code: string): Promise<StoredRoomPacket | null> {
  try {
    const cache = getCache({ namespace: 'pool8_rooms_v1' });
    const cached = (await cache.get(code)) as StoredRoomPacket | null;
    if (cached && cached.state && typeof cached.state.seq === 'number') {
      memoryFallback.set(code, cached);
      return cached;
    }
  } catch {
    // Fallback to memory map
  }
  return memoryFallback.get(code) ?? null;
}

async function setRoomInCache(code: string, pkt: StoredRoomPacket): Promise<void> {
  memoryFallback.set(code, pkt);
  try {
    const cache = getCache({ namespace: 'pool8_rooms_v1' });
    await cache.set(code, pkt, {
      ttl: ROOM_TTL_SECONDS,
      tags: ['pool8_rooms', `room:${code}`],
      name: `pool8-room-${code}`,
    });
  } catch {
    // Ignore runtime cache errors in non-Vercel environments
  }
}

async function deleteRoomFromCache(code: string): Promise<void> {
  memoryFallback.delete(code);
  try {
    const cache = getCache({ namespace: 'pool8_rooms_v1' });
    await cache.delete(code);
  } catch {
    // Ignore runtime cache errors
  }
}

function mergeRoomPackets(
  existing: StoredRoomPacket | null,
  incoming: StoredRoomPacket
): StoredRoomPacket {
  if (!existing) return incoming;

  const existingSeq = existing.state?.seq ?? 0;
  const incomingSeq = incoming.state?.seq ?? 0;
  const existingUpdated = existing.state?.updatedAt ?? 0;
  const incomingUpdated = incoming.state?.updatedAt ?? 0;

  const useIncomingState =
    incomingSeq > existingSeq ||
    (incomingSeq === existingSeq && incomingUpdated >= existingUpdated);

  const hostClientId = existing.hostClientId || incoming.hostClientId;
  let guestClientId = existing.guestClientId || incoming.guestClientId || null;
  if (guestClientId === hostClientId) {
    guestClientId =
      incoming.guestClientId && incoming.guestClientId !== hostClientId
        ? incoming.guestClientId
        : existing.guestClientId && existing.guestClientId !== hostClientId
        ? existing.guestClientId
        : null;
  }

  const hostName =
    (incoming.senderId === hostClientId && incoming.hostName) ||
    incoming.hostName ||
    existing.hostName ||
    null;
  const guestName =
    (guestClientId && incoming.senderId === guestClientId && incoming.guestName) ||
    incoming.guestName ||
    existing.guestName ||
    null;

  return {
    type: 'SYNC_STATE',
    msgId: incoming.msgId || existing.msgId,
    senderId: incoming.senderId || existing.senderId,
    senderName: incoming.senderName ?? existing.senderName ?? null,
    hostClientId,
    guestClientId,
    hostName,
    guestName,
    state: useIncomingState ? incoming.state : existing.state,
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    };

    if (request.method === 'GET') {
      const code = normalizeCode(url.searchParams.get('code'));
      if (!code) {
        return new Response(JSON.stringify({ packet: null }), { status: 400, headers });
      }
      const packet = await getRoomFromCache(code);
      return new Response(JSON.stringify({ packet }), { status: 200, headers });
    }

    if (request.method === 'POST') {
      try {
        const body = (await request.json()) as {
          roomCode?: string;
          packet?: StoredRoomPacket;
        } | null;
        const code = normalizeCode(body?.roomCode ?? url.searchParams.get('code'));
        const pkt = body?.packet;
        if (!code || !pkt || !pkt.state || typeof pkt.state.seq !== 'number' || !pkt.hostClientId) {
          return new Response(JSON.stringify({ error: 'Invalid room payload' }), {
            status: 400,
            headers,
          });
        }
        const existing = await getRoomFromCache(code);
        const merged = mergeRoomPackets(existing, pkt);
        await setRoomInCache(code, merged);
        return new Response(JSON.stringify({ packet: merged }), { status: 200, headers });
      } catch {
        return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400, headers });
      }
    }

    if (request.method === 'DELETE') {
      const code = normalizeCode(url.searchParams.get('code'));
      if (code) {
        await deleteRoomFromCache(code);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  },
};
