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
 * protected is a trophy count.
 *
 * A phone still gets lost, though, so there is a recovery code — sixteen
 * characters, shown once, written down — which takes the account over onto a
 * new device and revokes the old one. Neither secret is stored as it was
 * issued; see `secrets.mjs` for why.
 *
 * The server settles matches itself, from the same rules the client runs
 * (`server/rules.mjs`). A leaderboard built from totals the client posts is a
 * ranking of whoever edited their save file best; one built from results the
 * server scores is at least a ranking of people who played.
 */

import { randomBytes } from "node:crypto";
import { NameTakenError } from "./store.mjs";
import { isOnline } from "./presence.mjs";
import { get as getMatch, isPlayerIn, opponentOf } from "./matches.mjs";
import {
  TOKEN_LENGTH,
  digestsMatch,
  looksLikeRecovery,
  mintRecovery,
  mintToken,
  recoveryHash,
  tidyRecovery,
  tokenHash,
} from "./secrets.mjs";
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

/**
 * Most friends one player may hold.
 *
 * Generous, and a limit rather than none: the list is fetched whole and drawn
 * as a screen, and a list nobody can scroll is a list nobody uses.
 */
export const MAX_FRIENDS = 100;

const VALID_DIFFICULTY = new Set(["easy", "normal", "hard", "online"]);
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

async function mintId(store) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const bytes = randomBytes(ID_LENGTH);
    let id = "";
    for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    if (!(await store.get(id))) return id;
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

/** What anyone may see about a player. Never a secret. */
export function publicProfile(player, rank = null) {
  return {
    id: player.id,
    name: player.name,
    trophies: player.career.trophies,
    best: player.career.best,
    tier: tierFor(player.career.trophies).label,
    matches: player.matches,
    rank,
    online: isOnline(player.id),
    lastSeen: player.lastSeen,
  };
}

/**
 * Add a friend by the code on their card.
 *
 * Mutual immediately, with no request to accept. There is nothing to protect
 * against: a player code is not published anywhere, so somebody adding you
 * already had it from you. A request-and-accept flow would be two more screens
 * and a notification system in exchange for a permission that was already
 * given when the code was shared.
 */
export async function addFriend(store, player, rawCode) {
  const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (code === player.id) throw new ValidationError("that is your own code");
  const friend = await store.get(code);
  if (!friend) throw new ValidationError("no player with that code", 404);
  if ((player.friends ?? []).includes(friend.id)) return friend;
  if ((player.friends ?? []).length >= MAX_FRIENDS) {
    throw new ValidationError(`a friends list holds ${MAX_FRIENDS} players`, 409);
  }
  if ((friend.friends ?? []).length >= MAX_FRIENDS) {
    throw new ValidationError("their friends list is full", 409);
  }
  player.friends = [...(player.friends ?? []), friend.id];
  friend.friends = [...(friend.friends ?? []), player.id];
  await store.save(player);
  await store.save(friend);
  return friend;
}

/** Remove a friend, from both lists. A friendship one side cannot see is a bug. */
export async function removeFriend(store, player, rawId) {
  const id = typeof rawId === "string" ? rawId.trim().toUpperCase() : "";
  player.friends = (player.friends ?? []).filter((f) => f !== id);
  await store.save(player);
  const friend = await store.get(id);
  if (friend) {
    friend.friends = (friend.friends ?? []).filter((f) => f !== player.id);
    await store.save(friend);
  }
}

/**
 * Everyone on a player's list, online first and then by trophies.
 *
 * Ordered here rather than in the screen because "who can I play right now"
 * is the question the list exists to answer, and the answer should be at the
 * top of it.
 */
export async function friendsOf(store, player) {
  const ids = player.friends ?? [];
  const found = await Promise.all(ids.map((id) => store.get(id)));
  return found
    .filter((f) => f !== null)
    .map((f) => publicProfile(f))
    .sort(
      (a, b) => Number(b.online) - Number(a.online) || b.trophies - a.trophies
    );
}

/** What the owner of the account may see, which is everything but the secrets. */
export async function privateProfile(store, player) {
  return { ...publicProfile(player, await store.rankOf(player.id)), career: player.career };
}

/**
 * Create an account.
 *
 * Returns the record together with the two secrets that can never be read back
 * out of the store: the token, which the device keeps, and the recovery code,
 * which the player has to write down. Only their digests are kept.
 */
export async function register(store, rawName, now = new Date()) {
  const name = normaliseName(rawName);
  const token = mintToken();
  const recovery = mintRecovery();
  const player = {
    id: await mintId(store),
    name,
    tokenHash: tokenHash(token),
    recoverySalt: recovery.salt,
    recoveryHash: recovery.hash,
    created: now.getTime(),
    lastSeen: now.getTime(),
    lastMatchAt: 0,
    matches: 0,
    friends: [],
    career: freshCareer(dayKey(now)),
  };
  try {
    await store.create(player);
  } catch (err) {
    if (err instanceof NameTakenError) throw new ValidationError(err.message, 409);
    throw err;
  }
  return { player, token, recoveryCode: recovery.code };
}

export async function rename(store, player, rawName) {
  const name = normaliseName(rawName);
  if (name === player.name) return player;
  try {
    await store.rename(player, name);
  } catch (err) {
    if (err instanceof NameTakenError) throw new ValidationError(err.message, 409);
    throw err;
  }
  return player;
}

/**
 * Take an account over onto this device with its recovery code.
 *
 * The old token stops working, deliberately: recovery is what somebody does
 * when a phone is gone, and an account that keeps answering to the phone it
 * was recovered away from has not been recovered.
 */
export async function recover(store, rawId, rawCode) {
  const id = typeof rawId === "string" ? rawId.trim().toUpperCase() : "";
  const code = tidyRecovery(rawCode);
  // One message for every kind of failure, so this cannot be used to discover
  // which player codes exist.
  const refuse = () => new ValidationError("that code and player do not match", 403);
  if (!looksLikeRecovery(code)) throw refuse();
  const player = await store.get(id);
  if (!player?.recoveryHash) throw refuse();
  if (!digestsMatch(player.recoveryHash, recoveryHash(code, player.recoverySalt))) throw refuse();

  const previous = player.tokenHash;
  const token = mintToken();
  player.tokenHash = tokenHash(token);
  // A used recovery code is spent, and the new device is handed a fresh one.
  // Otherwise a slip of paper somebody else photographed keeps working.
  const next = mintRecovery();
  player.recoverySalt = next.salt;
  player.recoveryHash = next.hash;
  await store.save(player);
  await store.revokeToken?.(previous);
  return { player, token, recoveryCode: next.code };
}

/** Replace the recovery code, from a device that is already signed in. */
export async function regenerateRecovery(store, player) {
  const next = mintRecovery();
  player.recoverySalt = next.salt;
  player.recoveryHash = next.hash;
  await store.save(player);
  return next.code;
}

/**
 * Authenticate a bearer token.
 *
 * The digest is the lookup key, so a wrong token finds nothing rather than
 * finding a record and then failing a comparison against a secret held beside
 * it. There is no stored secret to leak through the timing of that comparison
 * because there is no such comparison.
 */
export async function authenticate(store, token) {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH) return null;
  return store.byToken(tokenHash(token));
}

/** Check a posted result is something a match could actually have produced. */
export function validateResult(body, opts = {}) {
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
  if (tally.points < tally.sets * WIN_SCORE) {
    throw new ValidationError("points cannot be fewer than the sets won require");
  }
  // A win means winning the sets. Without this the cheapest cheat is to post a
  // win with everything else zeroed, forever.
  //
  // A walkover is the one exception, and a real one: the surviving player has
  // won without having won the sets, which is the whole shape of a forfeit.
  // What authorises it is not this report but the relay having watched the
  // other socket close, so the check is relaxed rather than removed.
  if (opts.walkover !== true) {
    if (won && tally.sets < SETS_TO_WIN) {
      throw new ValidationError("a win must have won the sets");
    }
    if (!won && tally.sets >= SETS_TO_WIN) {
      throw new ValidationError("a loss cannot have won the sets");
    }
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
export async function recordMatch(store, player, body, now = new Date()) {
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
  await store.save(player);
  return { career, outcome };
}

export async function claim(store, player, challengeId, now = new Date()) {
  player.career = rollOver(player.career, dayKey(now));
  const before = player.career.coins;
  player.career = claimChallenge(player.career, challengeId);
  if (player.career.coins === before) {
    throw new ValidationError("that challenge is not ready, or is already collected");
  }
  await store.save(player);
  return player.career;
}

export async function upgrade(store, player, championId) {
  if (!CHARACTER_IDS.has(championId)) throw new ValidationError("unknown character");
  const before = player.career.coins;
  player.career = buyUpgrade(player.career, championId);
  if (player.career.coins === before) {
    throw new ValidationError("cannot upgrade — locked, maxed out, or not enough coins");
  }
  await store.save(player);
  return player.career;
}

/**
 * Sets that have to have been played before a disconnect counts as a loss.
 *
 * Quit in the opening set and the match is void for both: a train going into a
 * tunnel on the first point is not rage-quitting, and punishing it would make
 * the ladder a measure of signal strength. After that it is a forfeit.
 */
export const FORFEIT_AFTER_SETS = 1;

/** Whether two reports of the same match, from opposite ends, tell one story. */
function reportsAgree(mine, theirs) {
  if (mine.won === theirs.won) return false;
  const winner = mine.won ? mine : theirs;
  const loser = mine.won ? theirs : mine;
  if (winner.sets !== SETS_TO_WIN) return false;
  if (loser.sets >= SETS_TO_WIN) return false;
  return true;
}

/**
 * Settle an online match.
 *
 * Both sides report their own view of it and the pay-out happens when the two
 * agree — a leaderboard where one end of a connection decides the result is a
 * leaderboard for whoever is willing to edit their client.
 *
 * The other way it settles is a walkover, and the deciding fact there is not
 * the surviving player's word. The relay watched the socket close, so the
 * relay is what gets asked. Anything else is a free win for anyone who claims
 * one.
 */
export async function recordOnlineMatch(store, player, body, now = new Date()) {
  const match = getMatch(body?.matchId);
  if (!match) throw new ValidationError("that match is not one of ours", 404);
  if (!isPlayerIn(match, player.id)) throw new ValidationError("that was not your match", 403);
  if (match.reports.get(player.id)?.settled) throw new ValidationError("already settled", 409);

  // Whether this can be a walkover is decided here, from what the relay saw,
  // before the report is validated — a forfeit is a win that did not win the
  // sets, and only the relay's word makes that a legitimate thing to claim.
  const walkover = Boolean(match.left) && match.left !== player.id;
  const { championId, tally } = validateResult({ ...body, difficulty: "online" }, { walkover });
  const opponentSets = Number(body?.opponentSets ?? 0);
  const setsPlayed = tally.sets + (Number.isInteger(opponentSets) ? opponentSets : 0);
  match.reports.set(player.id, { ...tally, championId, setsPlayed, settled: false });

  const opponentId = opponentOf(match, player.id);
  const theirs = opponentId ? match.reports.get(opponentId) : null;

  // The ordinary case: both ends reported, and they tell the same story.
  if (theirs && !theirs.settled) {
    if (!reportsAgree(tally, theirs)) {
      throw new ValidationError("the two sides disagree about that match", 409);
    }
    const opponent = await store.get(opponentId);
    const mine = await payOut(store, player, championId, tally, now);
    match.reports.get(player.id).settled = true;
    if (opponent) {
      await payOut(store, opponent, theirs.championId, theirs, now, { skipCooldown: true });
      match.reports.get(opponentId).settled = true;
    }
    return mine;
  }

  // The other case: the relay saw the opponent's socket go, and enough of the
  // match had been played for that to be a forfeit rather than bad luck.
  if (match.left && match.left !== player.id) {
    if (setsPlayed < FORFEIT_AFTER_SETS) {
      throw new ValidationError("they left too early for it to count", 409);
    }
    if (!tally.won) throw new ValidationError("a walkover is a win, not a loss", 409);
    const mine = await payOut(store, player, championId, tally, now);
    match.reports.get(player.id).settled = true;
    const leaver = await store.get(match.left);
    if (leaver) {
      // The cooldown is skipped for the leaver: they are not making a request,
      // and a forfeit they did not report must not be lost to a rate limit.
      await payOut(
        store,
        leaver,
        theirs?.championId ?? CHARACTERS[0].id,
        { won: false, points: 0, sets: 0, rallies: 0 },
        now,
        { skipCooldown: true }
      );
    }
    return mine;
  }

  // Reported alone, with nothing to corroborate it. Held rather than paid: the
  // other side may still be about to report, and if they never do then nobody
  // gets anything, which is the right answer to an unexplained claim.
  return { pending: true };
}

/** Apply one settled result to one career. */
async function payOut(store, player, championId, tally, now, opts = {}) {
  if (!opts.skipCooldown) {
    const since = now.getTime() - player.lastMatchAt;
    if (since < MATCH_COOLDOWN_MS) {
      throw new ValidationError(
        `too soon — wait ${Math.ceil((MATCH_COOLDOWN_MS - since) / 1000)}s`,
        429
      );
    }
  }
  const { career, outcome } = settleMatch(player.career, championId, "online", tally, now);
  player.career = career;
  player.lastMatchAt = now.getTime();
  player.lastSeen = now.getTime();
  player.matches++;
  await store.save(player);
  return { career, outcome };
}

export async function leaderboard(store, limit) {
  const rows = await store.leaderboard(Math.max(1, Math.min(100, limit || 25)));
  return rows.map((player, i) => publicProfile(player, i + 1));
}
