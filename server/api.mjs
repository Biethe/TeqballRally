/**
 * The HTTP API, mounted alongside the relay on the same port.
 *
 * Same process on purpose. Two services would mean two deployments, two URLs
 * to configure in the client and two things to keep alive, in exchange for
 * separating a websocket forwarder from a few hundred bytes of JSON. When the
 * accounts side outgrows this it can move, and the client already talks to it
 * through one base URL.
 *
 * Everything here is small and explicit rather than routed through a
 * framework: eight endpoints do not need Express, and a dependency-free image
 * is one fewer thing to patch.
 */

import {
  ValidationError,
  addFriend,
  authenticate,
  claim,
  friendsOf,
  leaderboard,
  privateProfile,
  publicProfile,
  recordMatch,
  recover,
  regenerateRecovery,
  register,
  removeFriend,
  rename,
  upgrade,
} from "./accounts.mjs";

/** Requests bigger than this are not a player finishing a match. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Requests one address may make per minute.
 *
 * Generous for a person and mean for a script. It exists mostly to keep
 * registration from being used to fill the store with names.
 */
const RATE_LIMIT = { windowMs: 60_000, max: 120 };

/** @type {Map<string, { count: number, resetAt: number }>} */
const hits = new Map();

function rateLimited(key, now) {
  const seen = hits.get(key);
  if (!seen || now > seen.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return false;
  }
  seen.count++;
  return seen.count > RATE_LIMIT.max;
}

/** Drop expired buckets; called from the relay's existing sweep. */
export function sweepRateLimits(now = Date.now()) {
  for (const [key, seen] of hits) {
    if (now > seen.resetAt) hits.delete(key);
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // The game is served from a different origin to the API in every
    // deployment worth having, and from a Capacitor webview on Android, whose
    // origin is not a host at all.
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError("request too large", 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("body must be JSON");
  }
}

const bearer = (req) => {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
};

async function requirePlayer(store, req) {
  const player = await authenticate(store, bearer(req));
  if (!player) throw new ValidationError("sign in first", 401);
  return player;
}

/**
 * Handle an /api request. Returns false when the path is not ours, so the
 * relay can fall through to its own routes.
 */
export async function handleApi(store, req, res, now = new Date()) {
  const url = new URL(req.url, "http://api.local");
  if (!url.pathname.startsWith("/api/")) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
      "access-control-max-age": "86400",
    });
    res.end();
    return true;
  }

  const from = req.socket.remoteAddress ?? "unknown";
  if (rateLimited(from, now.getTime())) {
    sendJson(res, 429, { error: "too many requests" });
    return true;
  }

  try {
    const path = url.pathname;
    const isPost = req.method === "POST";

    if (path === "/api/players" && isPost) {
      const body = await readBody(req);
      const { player, token, recoveryCode } = await register(store, body.name, now);
      // The only time either secret is ever sent. The device keeps the token;
      // the player has to keep the recovery code, and the screen says so.
      sendJson(res, 201, { ...(await privateProfile(store, player)), token, recoveryCode });
      return true;
    }

    if (path === "/api/players/recover" && isPost) {
      const body = await readBody(req);
      const { player, token, recoveryCode } = await recover(store, body.id, body.code);
      sendJson(res, 200, { ...(await privateProfile(store, player)), token, recoveryCode });
      return true;
    }

    if (path === "/api/players/me" && req.method === "GET") {
      const player = await requirePlayer(store, req);
      player.lastSeen = now.getTime();
      sendJson(res, 200, await privateProfile(store, player));
      return true;
    }

    if (path === "/api/players/me/name" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      await rename(store, player, body.name);
      sendJson(res, 200, await privateProfile(store, player));
      return true;
    }

    if (path === "/api/players/me/recovery" && isPost) {
      // A new code from a device that is already signed in, for a player who
      // lost the slip of paper — or thinks somebody else has seen it.
      const player = await requirePlayer(store, req);
      sendJson(res, 200, { recoveryCode: await regenerateRecovery(store, player) });
      return true;
    }

    if (path === "/api/players/me/friends" && req.method === "GET") {
      const player = await requirePlayer(store, req);
      sendJson(res, 200, { friends: await friendsOf(store, player) });
      return true;
    }

    if (path === "/api/players/me/friends" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const friend = await addFriend(store, player, body.code);
      sendJson(res, 200, { added: publicProfile(friend), friends: await friendsOf(store, player) });
      return true;
    }

    if (path === "/api/players/me/friends/remove" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      await removeFriend(store, player, body.id);
      sendJson(res, 200, { friends: await friendsOf(store, player) });
      return true;
    }

    if (path === "/api/players/me/matches" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const { career, outcome } = await recordMatch(store, player, body, now);
      sendJson(res, 200, { career, outcome, rank: await store.rankOf(player.id) });
      return true;
    }

    if (path === "/api/players/me/claim" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      sendJson(res, 200, { career: await claim(store, player, body.challengeId, now) });
      return true;
    }

    if (path === "/api/players/me/upgrade" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      sendJson(res, 200, { career: await upgrade(store, player, body.championId) });
      return true;
    }

    if (path === "/api/leaderboard" && req.method === "GET") {
      const rows = await leaderboard(store, Number(url.searchParams.get("limit")));
      // A caller who is signed in gets their own row too, however far down it
      // is: a leaderboard that cannot show you yourself is a poster.
      const me = await authenticate(store, bearer(req));
      sendJson(res, 200, {
        rows,
        total: await store.size(),
        me: me ? publicProfile(me, await store.rankOf(me.id)) : null,
      });
      return true;
    }

    const code = path.startsWith("/api/players/") ? path.slice("/api/players/".length) : null;
    if (code && req.method === "GET" && !code.includes("/")) {
      const found = await store.get(code.toUpperCase());
      if (!found) {
        sendJson(res, 404, { error: "no player with that code" });
        return true;
      }
      sendJson(res, 200, publicProfile(found, await store.rankOf(found.id)));
      return true;
    }

    sendJson(res, 404, { error: "no such endpoint" });
    return true;
  } catch (err) {
    if (err instanceof ValidationError) {
      sendJson(res, err.status, { error: err.message });
      return true;
    }
    console.error("[api]", err);
    sendJson(res, 500, { error: "something went wrong" });
    return true;
  }
}
