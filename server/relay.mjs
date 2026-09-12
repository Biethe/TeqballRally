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
import { handleApi, sweepRateLimits } from "./api.mjs";
import { authenticate, publicProfile } from "./accounts.mjs";
import { arrived, left, onlineCount } from "./presence.mjs";
import { begin, departed, sweepMatches } from "./matches.mjs";
import { openStore } from "./store.mjs";

/**
 * Accounts live beside the relay rather than in a service of their own: two
 * deployments and two URLs to keep alive, in exchange for separating a
 * websocket forwarder from a few hundred bytes of JSON, is not a trade worth
 * making yet. The client already talks to one base URL, so moving it later
 * costs a config change.
 */
const store = await openStore();
console.log(`[relay] store ready (${await store.size()} players)`);

const PORT = Number(process.env.PORT ?? 8787);
const PROTOCOL_VERSION = 3;
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
  openMatch(host, guest);
  for (const [socket, peer, role] of [
    [host, guest, "host"],
    [guest, host, "guest"],
  ]) {
    send(socket, { t: "joined", room: code, role, ready: true });
    send(socket, { t: "peer", joined: true, who: peer.identity ?? null, match: socket.matchId });
  }
  console.log(`[relay] paired two players into ${code} (${rooms.size} rooms)`);
}

/**
 * Attach the account behind a socket, if it presented a token.
 *
 * Verified here rather than taken from whatever the client says it is called:
 * a name a peer can choose for itself is a name that can be somebody else's,
 * and the whole point of the account is that the person across the net is who
 * the card says they are. Anonymous play still works — the identity is simply
 * absent, and the other side is shown a guest.
 */
async function identify(socket, msg) {
  if (socket.identity !== undefined) return;
  // Claimed immediately so two frames arriving together cannot both start a
  // lookup and race to overwrite each other's answer.
  socket.identity = null;
  const player = await authenticate(store, msg?.token);
  if (!player) return;
  socket.identity = publicProfile(player, await store.rankOf(player.id));
  // A socket that closed while the lookup was in flight must not be counted
  // as present, and its close handler has already run by then.
  if (socket.readyState === socket.OPEN) {
    socket.presenceId = player.id;
    arrived(player.id);
  }
}

async function handleQueue(socket, msg) {
  if (socket.teq) return send(socket, { t: "error", reason: "already in a room" });
  if (msg.v !== PROTOCOL_VERSION) {
    return send(socket, { t: "error", reason: "version mismatch — update the app" });
  }
  await identify(socket, msg);
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

/**
 * Two seats are now a match.
 *
 * Its id goes to both sides so both can report the result against it, and the
 * relay keeps it so that a claim of "they left" can be checked against what
 * actually happened to the socket rather than taken on trust.
 */
function openMatch(a, b) {
  const id = begin(a.presenceId ?? null, b.presenceId ?? null);
  a.matchId = id;
  b.matchId = id;
}

/**
 * How often one room may mint a fresh match id.
 *
 * A rematch needs one — a result settles once per id — but ids are store
 * entries, so a stuck button must not be able to spam them.
 */
const REMATCH_MINT_COOLDOWN_MS = 10_000;

/**
 * A rematch was agreed: give the same room a fresh match id.
 *
 * The host drives, one mint per agreement, and both seats are told the new id
 * so each reports this match's result against it rather than against the one
 * already settled. The old id keeps its own life until it expires.
 */
function handleNewMatch(socket) {
  const state = socket.teq;
  if (!state || state.role !== "host") return;
  const peer = peerOf(state.room, socket);
  if (!peer || peer.readyState !== peer.OPEN) return;
  const now = Date.now();
  if (state.room.lastMint && now - state.room.lastMint < REMATCH_MINT_COOLDOWN_MS) return;
  state.room.lastMint = now;
  openMatch(socket, peer);
  send(socket, { t: "newmatch", match: socket.matchId });
  send(peer, { t: "newmatch", match: peer.matchId });
}

function releaseSeat(socket) {
  // Before the presence release, so the match still knows who this was.
  if (socket.matchId) {
    departed(socket.matchId, socket.presenceId ?? null);
    socket.matchId = null;
  }
  if (socket.presenceId) {
    left(socket.presenceId);
    socket.presenceId = null;
  }
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

async function handleJoin(socket, msg) {
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

  await identify(socket, msg);
  room.seats[seat] = socket;
  socket.teq = { room, code, role: seat === 0 ? "host" : "guest" };
  socket.isAlive = true;

  const peer = peerOf(room, socket);
  send(socket, { t: "joined", room: code, role: socket.teq.role, ready: Boolean(peer) });
  if (peer) {
    openMatch(socket, peer);
    // Tell the peer someone arrived, and re-confirm its own seat is now live.
    send(peer, { t: "peer", joined: true, who: socket.identity ?? null, match: peer.matchId });
    send(socket, { t: "peer", joined: true, who: peer.identity ?? null, match: socket.matchId });
  }
  console.log(`[relay] ${socket.teq.role} joined ${code} (${rooms.size} rooms)`);
}

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    // The player count is a store read now, so this answers asynchronously —
    // and answers `ok` even when the store is unreachable, because a health
    // check that fails on a slow query takes the whole service out.
    void store
      .size()
      .catch(() => null)
      .then((players) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            rooms: rooms.size,
            waiting: queue.length,
            online: onlineCount(),
            players,
          })
        );
      });
    return;
  }
  handleApi(store, req, res).then(
    (handled) => {
      if (!handled) res.writeHead(404).end();
    },
    (err) => {
      console.error("[api] unhandled", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  );
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

    // Only signalling is ever interpreted — seating and the rematch's fresh
    // match id. Everything else is opaque payload that belongs to the two
    // clients, so it is forwarded without being parsed.
    let type;
    try {
      type = JSON.parse(text)?.t;
    } catch {
      return;
    }
    socket.isAlive = true;

    if (type === "newmatch") {
      handleNewMatch(socket);
      return;
    }

    if (type === "join" || type === "queue" || type === "cancel") {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (type === "cancel") {
        dequeue(socket);
        return;
      }
      // The identity lookup behind these is a store read, so both are async.
      // A socket that closed while one was in flight is handled downstream:
      // `send` only writes to an open socket, and a closed one has already
      // been released from its seat.
      const seating = type === "join" ? handleJoin(socket, msg) : handleQueue(socket, msg);
      void seating.catch((err) => console.error("[relay] seating failed", err));
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
  sweepRateLimits(now);
  sweepMatches(now);
}, IDLE_TIMEOUT_MS / 3);
sweep.unref?.();

httpServer.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));

const shutdown = () => {
  clearInterval(sweep);
  for (const socket of wss.clients) socket.close(1001, "server shutting down");
  // The last few minutes of play are worth the two milliseconds this costs.
  void store.flush();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
