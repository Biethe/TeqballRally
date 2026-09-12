import { randomUUID } from "node:crypto";

/**
 * Online matches in progress, and what happened to them.
 *
 * The relay writes this and the API reads it, the same arrangement as
 * presence and for the same reason.
 *
 * It exists because of one question: when a player reports "they left, so I
 * won", who says so? Not the player — that is the claim, and a claim anybody
 * can make is a free win. The relay is the one part of the system that
 * actually watched the socket close, so the relay is what the API asks.
 *
 * Both sides report their own result. The server pays out when the two agree,
 * which is the ordinary case, and when the relay itself saw somebody leave,
 * which is the other one. A single unexplained report pays nobody.
 */

/** How long a finished match stays around waiting for the second report. */
const MATCH_TTL_MS = 10 * 60_000;

/**
 * @type {Map<string, {
 *   id: string, players: [string|null, string|null], startedAt: number,
 *   left: string|null, leftAt: number,
 *   reports: Map<string, { won: boolean, points: number, sets: number, rallies: number,
 *                          championId: string, setsPlayed: number, settled: boolean,
 *                          outcome?: object }>,
 * }>}
 */
const live = new Map();

/** Open a match between two seats. Either may be a guest with no account. */
export function begin(playerA, playerB) {
  const id = randomUUID();
  live.set(id, {
    id,
    players: [playerA ?? null, playerB ?? null],
    startedAt: Date.now(),
    left: null,
    leftAt: 0,
    reports: new Map(),
  });
  return id;
}

export function get(id) {
  return typeof id === "string" ? (live.get(id) ?? null) : null;
}

/** Record that a player's socket went away while the match was live. */
export function departed(id, playerId) {
  const match = live.get(id);
  if (!match || !playerId || match.left) return;
  match.left = playerId;
  match.leftAt = Date.now();
}

/** Who is on the other side of this match from `playerId`. */
export function opponentOf(match, playerId) {
  return match.players.find((p) => p && p !== playerId) ?? null;
}

export function isPlayerIn(match, playerId) {
  return match.players.includes(playerId);
}

/** Drop matches nobody is going to report on. Called from the relay's sweep. */
export function sweepMatches(now = Date.now()) {
  for (const [id, match] of live) {
    if (now - match.startedAt > MATCH_TTL_MS) live.delete(id);
  }
}

/** Forget everything. Only for tests. */
export function reset() {
  live.clear();
}

export const TTL_MS = MATCH_TTL_MS;
