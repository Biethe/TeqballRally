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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
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

    if (type === "join") {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      handleJoin(socket, msg);
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
