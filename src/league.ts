/**
 * The trophy ladder.
 *
 * A match has to be worth something beyond the next match, and a number that
 * only goes up is not worth much either — a rank you can lose is the one that
 * makes a match matter. Trophies move both ways; the tier is read off the total
 * rather than stored, so there is no separate ladder state that can drift out
 * of agreement with the trophies themselves.
 *
 * Everything here is pure and local. It needs no server, no account and no
 * clock, which is the point: the ladder has to work on a phone in a tunnel.
 */

export interface Tier {
  id: string;
  /** Untranslated: tier names are the same word in every language, like a rank. */
  label: string;
  /** Trophies at which this tier begins. */
  floor: number;
  /** What the tier is worth, as a fraction of extra coins per match. */
  bonus: number;
}

/**
 * The ladder, floor-ascending. The early rungs are close together because the
 * first hour is when a player most needs to see themselves moving; they open
 * out afterwards, when a rung has to be earned to mean anything.
 */
export const TIERS: Tier[] = [
  { id: "beginner", label: "BEGINNER", floor: 0, bonus: 0 },
  { id: "rookie1", label: "ROOKIE I", floor: 60, bonus: 0.1 },
  { id: "rookie2", label: "ROOKIE II", floor: 160, bonus: 0.2 },
  { id: "rookie3", label: "ROOKIE III", floor: 300, bonus: 0.3 },
  { id: "junior1", label: "JUNIOR I", floor: 500, bonus: 0.4 },
  { id: "junior2", label: "JUNIOR II", floor: 760, bonus: 0.5 },
  { id: "pro1", label: "PRO I", floor: 1100, bonus: 0.65 },
  { id: "pro2", label: "PRO II", floor: 1550, bonus: 0.8 },
  { id: "elite", label: "ELITE", floor: 2100, bonus: 1 },
];

/** The tier a trophy count sits in. Never null: everyone has a rank. */
export function tierFor(trophies: number): Tier {
  let found = TIERS[0];
  for (const tier of TIERS) {
    if (trophies >= tier.floor) found = tier;
  }
  return found;
}

/** The rung above, or null at the top of the ladder. */
export function nextTier(trophies: number): Tier | null {
  return TIERS.find((tier) => tier.floor > trophies) ?? null;
}

/** How far through the current tier a trophy count is, 0–1. */
export function tierProgress(trophies: number): number {
  const here = tierFor(trophies);
  const next = nextTier(trophies);
  if (!next) return 1;
  return Math.min(1, Math.max(0, (trophies - here.floor) / (next.floor - here.floor)));
}

export type Difficulty = "easy" | "normal" | "hard";

/** Trophies staked on a match, before the result decides the sign. */
const STAKE: Record<Difficulty, { win: number; loss: number }> = {
  easy: { win: 12, loss: 10 },
  normal: { win: 20, loss: 12 },
  hard: { win: 30, loss: 14 },
};

/**
 * What a result is worth.
 *
 * A loss costs less than a win pays, at every difficulty: a ladder that takes
 * back as much as it gives leaves a player exactly where they started after an
 * evening of play, which is the fastest way to make them stop. It still costs
 * something, or the rank means nothing.
 *
 * Trophies never go below zero. Being stuck at the bottom is a bad enough
 * place to be without also being in debt.
 */
export function trophyDelta(won: boolean, difficulty: Difficulty, trophies: number): number {
  const stake = STAKE[difficulty];
  if (won) return stake.win;
  // The early return is not just a shortcut: negating a zero gives -0, and a
  // results screen would faithfully print that as "-0".
  if (trophies <= 0) return 0;
  return -Math.min(stake.loss, trophies);
}

/** Coins a result pays, before the tier bonus. */
const PURSE: Record<Difficulty, { win: number; loss: number }> = {
  easy: { win: 40, loss: 12 },
  normal: { win: 70, loss: 20 },
  hard: { win: 110, loss: 30 },
};

/**
 * Coins a result pays. A loss still pays: the twenty minutes were spent either
 * way, and a game that pays nothing for them teaches the player to quit early
 * rather than play the match out.
 */
export function coinsFor(won: boolean, difficulty: Difficulty, trophies: number): number {
  const purse = PURSE[difficulty];
  const base = won ? purse.win : purse.loss;
  return Math.round(base * (1 + tierFor(trophies).bonus));
}

/** Whether a trophy change crossed a rung, and which way. */
export function rankChange(before: number, after: number): "promoted" | "relegated" | null {
  const from = tierFor(before);
  const to = tierFor(after);
  if (from.id === to.id) return null;
  return to.floor > from.floor ? "promoted" : "relegated";
}
