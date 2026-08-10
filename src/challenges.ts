/**
 * Daily challenges.
 *
 * A reason to open the game today rather than eventually. Three of them, drawn
 * from a fixed pool by the date itself, so every device shows the same set on
 * the same day without anyone being asked and without a server being asked
 * either — the date is the seed, and the seed is the whole synchronisation
 * mechanism.
 *
 * Progress is counted from things the match already reports. Nothing here
 * observes the simulation; it is handed totals after the fact.
 */

export type ChallengeKind = "matches" | "wins" | "points" | "rallies" | "sets";

export interface Challenge {
  id: string;
  kind: ChallengeKind;
  /** How many of the thing. */
  goal: number;
  /** Coins for finishing it. */
  reward: number;
}

/**
 * The pool. Deliberately made of things a player does by playing rather than
 * by playing a particular way: a challenge that asks for a backflip finish
 * teaches them to farm backflips instead of to play the rally.
 *
 * Every goal is sized against what one match can actually produce. A set is
 * first to three and a match is best of three sets, so a winning match yields
 * six to eight points — a goal of forty would be a weekly challenge wearing a
 * daily one's clothes.
 */
const POOL: Challenge[] = [
  { id: "play3", kind: "matches", goal: 3, reward: 120 },
  { id: "play5", kind: "matches", goal: 5, reward: 200 },
  { id: "win1", kind: "wins", goal: 1, reward: 100 },
  { id: "win3", kind: "wins", goal: 3, reward: 250 },
  { id: "points10", kind: "points", goal: 10, reward: 130 },
  { id: "points20", kind: "points", goal: 20, reward: 220 },
  { id: "rally5", kind: "rallies", goal: 5, reward: 160 },
  { id: "rally10", kind: "rallies", goal: 10, reward: 260 },
  { id: "sets2", kind: "sets", goal: 2, reward: 140 },
  { id: "sets4", kind: "sets", goal: 4, reward: 240 },
];

/**
 * Every challenge that can ever be offered.
 *
 * Exported for the test that holds each goal to being reachable in a session:
 * the goals are sized against the scoring, and the scoring has moved before.
 */
export const ALL_CHALLENGES: readonly Challenge[] = POOL;

/** How many are offered at once. Three: enough to choose between, few enough to finish. */
export const DAILY_COUNT = 3;

/**
 * The day a moment belongs to, as a plain `YYYY-MM-DD` string in local time.
 *
 * Local, not UTC: the day has to turn over while the player is asleep, and
 * whose midnight that is depends on where they are, not where a server is.
 */
export function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A small, stable hash of a string. Same day, same number, on every device. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The three challenges for a given day. Deterministic, distinct, and never two
 * of the same kind — three variations on "play some matches" is one challenge
 * wearing three hats.
 */
export function dailyChallenges(day: string): Challenge[] {
  const picked: Challenge[] = [];
  const kinds = new Set<ChallengeKind>();
  // Walk the pool from a day-dependent starting point, taking the first
  // challenge of each new kind. Walking rather than sampling means the result
  // cannot repeat or come up short however the hash lands.
  const start = hash(day) % POOL.length;
  for (let i = 0; i < POOL.length && picked.length < DAILY_COUNT; i++) {
    const candidate = POOL[(start + i) % POOL.length];
    if (kinds.has(candidate.kind)) continue;
    kinds.add(candidate.kind);
    picked.push(candidate);
  }
  return picked;
}

/** What one finished match contributes, by challenge kind. */
export interface MatchTally {
  won: boolean;
  /** Points scored by the player across the match. */
  points: number;
  /** Sets won by the player. */
  sets: number;
  /** Points that went long enough to be a rally rather than a serve and a miss. */
  rallies: number;
}

/** The amount a match adds to a challenge of this kind. */
export function creditFor(kind: ChallengeKind, tally: MatchTally): number {
  switch (kind) {
    case "matches":
      return 1;
    case "wins":
      return tally.won ? 1 : 0;
    case "points":
      return tally.points;
    case "sets":
      return tally.sets;
    case "rallies":
      return tally.rallies;
  }
}

/** True once a challenge's progress has reached its goal. */
export function isComplete(challenge: Challenge, progress: number): boolean {
  return progress >= challenge.goal;
}

/** Seconds until the challenges roll over, for the countdown on the panel. */
export function secondsUntilRollover(now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(0, Math.round((midnight.getTime() - now.getTime()) / 1000));
}
