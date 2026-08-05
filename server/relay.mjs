/**
 * Match relay for online 1v1.
 *
 * Deliberately dumb: it knows about rooms and seats, and forwards every other
 * frame verbatim to the one other peer. No game state lives here, so it cannot
 * disagree with the clients, cannot be cheated in an interesting way, and can
 * be restarted mid-match without corrupting anything.
 *
 * A WebSocket relay rather than WebRTC: a DataChannel would shave a hop, but it
 * needs signalling plus a TURN fallback for the connections NAT traversal
 * cannot make, and debugging that is not where a deadline should go. This runs
 * anywhere that speaks HTTP.
 *
 *   node server/relay.mjs            # PORT=8787 by default
 *
 * Health check on GET /healthz for whatever platform is watching it.
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const PROTOCOL_VERSION = 1;
/** A room with no sockets left is dropped after this, so codes get reused. */
const EMPTY_ROOM_TTL_MS = 60_000;
/** Frames larger than this are a bug or an attack; neither deserves relaying. */
const MAX_FRAME_BYTES = 8 * 1024;
/** A peer that has not pinged within this window is considered gone. */
const IDLE_TIMEOUT_MS = 45_000;

/** @type {Map<string, { seats: (import("ws").WebSocket|null)[], emptyAt: number|null }>} */
const rooms = new Map();

/**
 * Players waiting to be paired with anyone, longest wait first.
 *
 * Private rooms only connect people who already know each other, so without
 * this a new player with nobody to invite never gets a game.
 */
/** @type {import("ws").WebSocket[]} */
const queue = [];

/** Crockford base32, matching the client's alphabet (no I, L, O or U). */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function mintRoomCode() {
  // Retry rather than trusting randomness: a collision would drop a waiting
  // pair into somebody else's match.
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function dequeue(socket) {
  const i = queue.indexOf(socket);
  if (i >= 0) queue.splice(i, 1);
}

/** Seat two waiting players in a freshly minted room. */
function pair(host, guest) {
  const code = mintRoomCode();
  if (!code) {
    send(host, { t: "error", reason: "server busy, try again" });
    send(guest, { t: "error", reason: "server busy, try again" });
    return;
  }
  const room = roomFor(code);
  room.seats[0] = host;
  room.seats[1] = guest;
  host.teq = { room, code, role: "host" };
  guest.teq = { room, code, role: "guest" };
  for (const [socket, role] of [
    [host, "host"],
    [guest, "guest"],
  ]) {
    send(socket, { t: "joined", room: code, role, ready: true });
    send(socket, { t: "peer", joined: true });
  }
  console.log(`[relay] paired two players into ${code} (${rooms.size} rooms)`);
}

function handleQueue(socket, msg) {
  if (socket.teq) return send(socket, { t: "error", reason: "already in a room" });
  if (msg.v !== PROTOCOL_VERSION) {
    return send(socket, { t: "error", reason: "version mismatch — update the app" });
  }
  if (queue.includes(socket)) return send(socket, { t: "queued", ahead: queue.indexOf(socket) });

  // Take the longest-waiting player, skipping any that went away without the
  // close handler having run yet.
  while (queue.length > 0) {
    const peer = queue.shift();
    if (!peer || peer.readyState !== peer.OPEN || peer.teq) continue;
    pair(peer, socket);
    return;
  }
  queue.push(socket);
  socket.isAlive = true;
  send(socket, { t: "queued", ahead: 0 });
  console.log(`[relay] queued a player (${queue.length} waiting)`);
}

const send = (socket, msg) => {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
};

function roomFor(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { seats: [null, null], emptyAt: null };
    rooms.set(code, room);
  }
  room.emptyAt = null;
  return room;
}

function peerOf(room, socket) {
  return room.seats.find((s) => s && s !== socket) ?? null;
}

function releaseSeat(socket) {
  // A player who leaves while still waiting was never seated.
  dequeue(socket);
  const { room, code } = socket.teq ?? {};
  if (!room) return;
  const i = room.seats.indexOf(socket);
  if (i >= 0) room.seats[i] = null;
  send(peerOf(room, socket), { t: "peer", joined: false });
  if (room.seats.every((s) => s === null)) room.emptyAt = Date.now();
  socket.teq = undefined;
  console.log(`[relay] left ${code} (${rooms.size} rooms)`);
}

function handleJoin(socket, msg) {
  if (socket.teq) return send(socket, { t: "error", reason: "already in a room" });
  if (msg.v !== PROTOCOL_VERSION) {
    // Both halves ship together, so a mismatch means one side is a stale build.
    return send(socket, { t: "error", reason: "version mismatch — update the app" });
  }
  const code = typeof msg.room === "string" ? msg.room.toUpperCase() : "";
  if (!/^[0-9A-Z]{4,8}$/.test(code)) return send(socket, { t: "error", reason: "bad room code" });

  const room = roomFor(code);
  const seat = room.seats.indexOf(null);
  if (seat < 0) return send(socket, { t: "error", reason: "room is full" });

  room.seats[seat] = socket;
  socket.teq = { room, code, role: seat === 0 ? "host" : "guest" };
  socket.isAlive = true;

  const peer = peerOf(room, socket);
  send(socket, { t: "joined", room: code, role: socket.teq.role, ready: Boolean(peer) });
  if (peer) {
    // Tell the peer someone arrived, and re-confirm its own seat is now live.
    send(peer, { t: "peer", joined: true });
    send(socket, { t: "peer", joined: true });
  }
  console.log(`[relay] ${socket.teq.role} joined ${code} (${rooms.size} rooms)`);
}

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, waiting: queue.length }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES });

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString();
    if (text.length > MAX_FRAME_BYTES) return;

    // Only "join" is ever interpreted. Everything else is opaque payload that
    // belongs to the two clients, so it is forwarded without being parsed.
    let type;
    try {
      type = JSON.parse(text)?.t;
    } catch {
      return;
    }
    socket.isAlive = true;

    if (type === "join" || type === "queue" || type === "cancel") {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (type === "join") handleJoin(socket, msg);
      else if (type === "queue") handleQueue(socket, msg);
      else dequeue(socket);
      return;
    }

    const state = socket.teq;
    if (!state) return send(socket, { t: "error", reason: "join a room first" });
    const peer = peerOf(state.room, socket);
    if (peer && peer.readyState === peer.OPEN) peer.send(text);
  });

  socket.on("close", () => releaseSeat(socket));
  socket.on("error", () => releaseSeat(socket));
});

// Drop sockets that stopped answering, and rooms that stayed empty.
const sweep = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptyAt !== null && now - room.emptyAt > EMPTY_ROOM_TTL_MS) rooms.delete(code);
  }
}, IDLE_TIMEOUT_MS / 3);
sweep.unref?.();

httpServer.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));

const shutdown = () => {
  clearInterval(sweep);
  for (const socket of wss.clients) socket.close(1001, "server shutting down");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
