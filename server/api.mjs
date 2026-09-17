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
  recordOnlineMatch,
  recover,
  regenerateRecovery,
  register,
  removeFriend,
  rename,
  applyPurchaseEvent,
  upgrade,
} from "./accounts.mjs";
import {
  clubOf,
  clubView,
  createClub,
  joinClub,
  leaveClub,
  removeMember,
  renameClub,
  rotateInvite,
} from "./clubs.mjs";
import { onlineCount } from "./presence.mjs";

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

/**
 * Who a request is from, for the rate limiter.
 *
 * `socket.remoteAddress` is the truthful answer only when nothing sits in
 * front of this process. In the deployment that matters it does: Cloud Run
 * hands every request to the container from Google's own frontend, so every
 * player in the world arrived from the same handful of internal addresses and
 * shared a single bucket — which made the limit both useless as protection
 * and capable of answering 429 to somebody who had made one request.
 *
 * The *last* entry of `x-forwarded-for`, not the first. Google's frontend
 * appends the address it actually saw to whatever the caller sent, so the
 * first entries are the caller's to invent and the last one is not. This holds
 * because the service is reached directly on `run.app`; put a load balancer in
 * front of it and the last entry becomes the balancer, one bucket again.
 */
function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const hops = forwarded.split(",");
    const nearest = hops[hops.length - 1].trim();
    if (nearest) return nearest;
  }
  return req.socket.remoteAddress ?? "unknown";
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
    // Everything here is JSON. Saying so stops a browser guessing otherwise
    // about a response that happens to begin with something else — a player's
    // own name is in most of these bodies, and a name is not this server's to
    // decide is harmless.
    "x-content-type-options": "nosniff",
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

  const from = clientAddress(req);
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
      const { player, token, recoveryCode } = await recover(store, body.code, body.id);
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

    // ---- clubs ----
    //
    // Every one of these answers with the same club view, so the screen never
    // has to assemble state from a reply plus what it remembered. A club that
    // has just been disbanded answers with `club: null`, which is the honest
    // reply and the one the screen already knows how to draw.

    if (path === "/api/clubs/me" && req.method === "GET") {
      const player = await requirePlayer(store, req);
      const club = await clubOf(store, player);
      sendJson(res, 200, { club: club ? await clubView(store, club, player.id) : null });
      return true;
    }

    if (path === "/api/clubs" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const club = await createClub(store, player, body.name, now);
      sendJson(res, 201, { club: await clubView(store, club, player.id) });
      return true;
    }

    if (path === "/api/clubs/join" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const club = await joinClub(store, player, body.code);
      sendJson(res, 200, { club: await clubView(store, club, player.id) });
      return true;
    }

    if (path === "/api/clubs/leave" && isPost) {
      const player = await requirePlayer(store, req);
      await leaveClub(store, player);
      sendJson(res, 200, { club: null });
      return true;
    }

    if (path === "/api/clubs/me/name" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const club = await renameClub(store, player, body.name);
      sendJson(res, 200, { club: await clubView(store, club, player.id) });
      return true;
    }

    if (path === "/api/clubs/me/invite" && isPost) {
      const player = await requirePlayer(store, req);
      const club = await rotateInvite(store, player);
      sendJson(res, 200, { club: await clubView(store, club, player.id) });
      return true;
    }

    if (path === "/api/clubs/me/remove" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const club = await removeMember(store, player, body.id);
      sendJson(res, 200, { club: club ? await clubView(store, club, player.id) : null });
      return true;
    }

    if (path === "/api/players/me/matches" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const { career, outcome } = await recordMatch(store, player, body, now);
      sendJson(res, 200, { career, outcome, rank: await store.rankOf(player.id) });
      return true;
    }

    if (path === "/api/players/me/online" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      const result = await recordOnlineMatch(store, player, body, now);
      // A lone report is held rather than paid; the client is told so plainly
      // so it can leave the local career alone and say nothing about a rank.
      if (result.pending) {
        sendJson(res, 202, { pending: true });
        return true;
      }
      sendJson(res, 200, { ...result, rank: await store.rankOf(player.id) });
      return true;
    }

    if (path === "/api/players/me/claim" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      sendJson(res, 200, { career: await claim(store, player, body.challengeId, now) });
      return true;
    }

    /**
     * RevenueCat telling us somebody has bought something.
     *
     * The only route by which coins or an unlock are ever granted. It is not
     * authenticated as a player, because the caller is not one: it is
     * RevenueCat, proved by a shared secret it sends in the Authorization
     * header and which is configured beside the webhook. Without the secret
     * set this route refuses everything rather than trusting whoever calls it.
     *
     * Always 200 on anything that cannot succeed but is not our fault — an
     * unknown player, an event type we do not grant on — because RevenueCat
     * retries a failure, and retrying something impossible forever helps
     * nobody.
     */
    if (path === "/api/revenuecat" && isPost) {
      const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[api] REVENUECAT_WEBHOOK_SECRET is not set — refusing the webhook");
        sendJson(res, 503, { error: "webhook not configured" });
        return true;
      }
      if (req.headers.authorization !== secret) {
        sendJson(res, 401, { error: "no" });
        return true;
      }
      const body = await readBody(req);
      const result = await applyPurchaseEvent(store, body?.event);
      sendJson(res, 200, result);
      return true;
    }

    if (path === "/api/players/me/upgrade" && isPost) {
      const player = await requirePlayer(store, req);
      const body = await readBody(req);
      sendJson(res, 200, { career: await upgrade(store, player, body.championId) });
      return true;
    }

    if (path === "/api/online" && req.method === "GET") {
      // How many people are actually reachable right now. Open, because it is
      // a count and not a list — it says whether there is anybody to play, and
      // nothing whatever about who.
      //
      // Quick match reads it to decide how long to keep looking. Waiting
      // twenty-five seconds to prove an empty game is empty helps nobody, and
      // giving up after nine when somebody is right there is worse.
      sendJson(res, 200, { count: onlineCount() });
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
