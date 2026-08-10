/**
 * Player accounts, and the careers behind them.
 *
 * The point of the account is the id: a short, shareable code that is the same
 * next week and on the next phone. Everything a community feature will want to
 * hang off — a friend list, a club, a rivalry, a shared replay — hangs off
 * that. The name is a label on top of it, changeable, because people change
 * their minds about names and never about wanting to keep their trophies.
 *
 * Authentication is a bearer token minted at registration and stored on the
 * device. No password, no email, no reset flow: those are three screens and a
 * mail provider standing between a player and a game, and the thing being
 * protected is a trophy count. The trade is stated rather than hidden — lose
 * the device, lose the account — and it is the right trade until there is
 * something worth more than trophies behind it.
 *
 * The server settles matches itself, from the same rules the client runs
 * (`server/rules.mjs`). A leaderboard built from totals the client posts is a
 * ranking of whoever edited their save file best; one built from results the
 * server scores is at least a ranking of people who played.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  SETS_TO_WIN,
  WIN_SCORE,
  CHARACTERS,
  buyUpgrade,
  claimChallenge,
  dayKey,
  freshCareer,
  rollOver,
  settleMatch,
  tierFor,
} from "./rules.mjs";

/** Crockford base32 — no I, L, O or U, so a code can be read down a phone. */
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 8;

export const NAME_MIN = 3;
export const NAME_MAX = 16;
/**
 * Letters, digits, and single interior spaces, hyphens or underscores.
 *
 * Deliberately narrow. A name is going to be drawn on a card next to somebody
 * else's, read out of a leaderboard row and squeezed into a match HUD, and
 * every exotic character class that gets allowed here is a rendering bug or a
 * homoglyph impersonation later.
 */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,14}[\p{L}\p{N}]$/u;

/** Shortest gap between two results from the same player. */
export const MATCH_COOLDOWN_MS = 20_000;

const VALID_DIFFICULTY = new Set(["easy", "normal", "hard"]);
const CHARACTER_IDS = new Set(CHARACTERS.map((c) => c.id));

/** The most one match can possibly produce, used to reject impossible results. */
export const MAX_TALLY = {
  // A full-length match: every set played out, including the ones lost.
  points: WIN_SCORE * (SETS_TO_WIN * 2 - 1),
  sets: SETS_TO_WIN,
  // Every point of a full match, and then some room for the ones that took a
  // while. A cap that a real match can hit is a cap that punishes good play.
  rallies: WIN_SCORE * (SETS_TO_WIN * 2 - 1) * 2,
};

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function mintId(store) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const bytes = randomBytes(ID_LENGTH);
    let id = "";
    for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    if (!store.get(id)) return id;
  }
  throw new ValidationError("could not allocate a player id, try again", 503);
}

/** Trim, collapse runs of whitespace, and check it is something a card can show. */
export function normaliseName(raw) {
  if (typeof raw !== "string") throw new ValidationError("name is required");
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throw new ValidationError(`name must be ${NAME_MIN}-${NAME_MAX} characters`);
  }
  if (!NAME_RE.test(name)) {
    throw new ValidationError("name may use letters, digits, spaces, - and _");
  }
  return name;
}

/** What anyone may see about a player. Never the token. */
export function publicProfile(player, rank = null) {
  return {
    id: player.id,
    name: player.name,
    trophies: player.career.trophies,
    best: player.career.best,
    tier: tierFor(player.career.trophies).label,
    matches: player.matches,
    rank,
  };
}

/** What the owner of the account may see, which is everything but the token. */
export function privateProfile(store, player) {
  return { ...publicProfile(player, store.rankOf(player.id)), career: player.career };
}

export function register(store, rawName, now = new Date()) {
  const name = normaliseName(rawName);
  if (store.nameTaken(name)) throw new ValidationError("that name is taken", 409);
  const player = {
    id: mintId(store),
    name,
    token: randomBytes(24).toString("hex"),
    created: now.getTime(),
    lastSeen: now.getTime(),
    lastMatchAt: 0,
    matches: 0,
    career: freshCareer(dayKey(now)),
  };
  store.add(player);
  return player;
}

export function rename(store, player, rawName) {
  const name = normaliseName(rawName);
  if (name === player.name) return player;
  if (store.nameTaken(name, player.id)) throw new ValidationError("that name is taken", 409);
  store.rename(player, name);
  return player;
}

/**
 * Authenticate a bearer token.
 *
 * Compared in constant time. The token is a lookup key rather than a secret
 * being verified against a stored hash, so this is belt and braces — but a map
 * lookup leaking through timing is exactly the kind of thing nobody notices
 * until it is a headline, and the cost here is one comparison.
 */
export function authenticate(store, token) {
  if (typeof token !== "string" || token.length !== 48) return null;
  const player = store.byTokenValue(token);
  if (!player) return null;
  const a = Buffer.from(player.token);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return player;
}

/** Check a posted result is something a match could actually have produced. */
export function validateResult(body) {
  if (!body || typeof body !== "object") throw new ValidationError("a result is required");
  const { championId, difficulty, won, points, sets, rallies } = body;
  if (!CHARACTER_IDS.has(championId)) throw new ValidationError("unknown character");
  if (!VALID_DIFFICULTY.has(difficulty)) throw new ValidationError("unknown difficulty");
  if (typeof won !== "boolean") throw new ValidationError("won must be true or false");
  const whole = (v, name, max) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
      throw new ValidationError(`${name} must be a whole number from 0 to ${max}`);
    }
    return v;
  };
  const tally = {
    won,
    points: whole(points, "points", MAX_TALLY.points),
    sets: whole(sets, "sets", MAX_TALLY.sets),
    rallies: whole(rallies, "rallies", MAX_TALLY.rallies),
  };
  // A win means winning the sets. Without this the cheapest cheat is to post a
  // win with everything else zeroed, forever.
  if (won && tally.sets < SETS_TO_WIN) {
    throw new ValidationError("a win must have won the sets");
  }
  if (!won && tally.sets >= SETS_TO_WIN) {
    throw new ValidationError("a loss cannot have won the sets");
  }
  if (tally.points < tally.sets * WIN_SCORE) {
    throw new ValidationError("points cannot be fewer than the sets won require");
  }
  return { championId, difficulty, tally };
}

/**
 * Record a finished match against a player's career.
 *
 * Rate-limited per player. It does not make cheating impossible — nothing
 * short of running the simulation server-side does, and that is a different
 * project — but it does mean a scripted climb takes as long as playing would,
 * which is enough to keep a leaderboard worth looking at.
 */
export function recordMatch(store, player, body, now = new Date()) {
  const { championId, difficulty, tally } = validateResult(body);
  const since = now.getTime() - player.lastMatchAt;
  if (since < MATCH_COOLDOWN_MS) {
    throw new ValidationError(
      `too soon — wait ${Math.ceil((MATCH_COOLDOWN_MS - since) / 1000)}s`,
      429
    );
  }
  const { career, outcome } = settleMatch(player.career, championId, difficulty, tally, now);
  player.career = career;
  player.lastMatchAt = now.getTime();
  player.lastSeen = now.getTime();
  player.matches++;
  store.touch();
  return { career, outcome };
}

export function claim(store, player, challengeId, now = new Date()) {
  player.career = rollOver(player.career, dayKey(now));
  const before = player.career.coins;
  player.career = claimChallenge(player.career, challengeId);
  if (player.career.coins === before) {
    throw new ValidationError("that challenge is not ready, or is already collected");
  }
  store.touch();
  return player.career;
}

export function upgrade(store, player, championId) {
  if (!CHARACTER_IDS.has(championId)) throw new ValidationError("unknown character");
  const before = player.career.coins;
  player.career = buyUpgrade(player.career, championId);
  if (player.career.coins === before) {
    throw new ValidationError("cannot upgrade — locked, maxed out, or not enough coins");
  }
  store.touch();
  return player.career;
}

export function leaderboard(store, limit) {
  const rows = store.leaderboard(Math.max(1, Math.min(100, limit || 25)));
  return rows.map((player, i) => publicProfile(player, i + 1));
}
