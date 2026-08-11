import { TIERS, tierFor } from "./league";

/**
 * Seasons.
 *
 * A ladder that never resets has one problem: the top of it belongs to
 * whoever got there first, and a player arriving in month six is looking at a
 * board they cannot reach. A ladder that resets to zero has the opposite
 * problem — it tells everybody their month meant nothing. So it is a soft
 * reset: you keep half.
 *
 * Halving is chosen over anything cleverer because it is the only rule a
 * player can check in their head, and because it preserves the order exactly —
 * everybody lands about two rungs down, in the same sequence they were in.
 *
 * **Rewards are by tier, not by rank.** That is a deliberate trade. Ranking
 * everyone at the instant a month turns needs a scheduled job that walks the
 * whole table, and a rank awarded lazily is not a rank at all: it depends on
 * who happened to open the game before you. The tier you reached depends on
 * nobody, can be settled the moment a player returns, and is the thing they
 * were actually playing for.
 *
 * Everything here is pure and needs no clock but the one it is handed, so the
 * client and the server compute the same rollover from the same career.
 */

/** The season a moment belongs to: `YYYY-MM`, in local time like the day is. */
export function seasonKey(now: Date): string {
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}`;
}

/** What a season leaves behind. Half, rounded, never below zero. */
export function softReset(trophies: number): number {
  return Math.max(0, Math.round(trophies / 2));
}

/**
 * Coins for finishing a season in a tier.
 *
 * Scaled by how far up the ladder the tier is, so the reward tracks the thing
 * that was hard about getting there. BEGINNER pays nothing: a season is over
 * when it is over, and paying for having played none of it makes the whole
 * thing noise.
 */
export function seasonReward(tierId: string): number {
  const index = TIERS.findIndex((t) => t.id === tierId);
  if (index <= 0) return 0;
  return index * 250;
}

/** A season a player finished, kept for as long as the career lasts. */
export interface Title {
  /** `YYYY-MM`. */
  season: string;
  /** The tier they reached, by label — what the badge says. */
  tier: string;
  /** The highest trophy count they held that season. */
  best: number;
}

/** What a rollover did, for the screen that reports it. */
export interface SeasonEnd {
  title: Title;
  coins: number;
  /** Trophies before and after the halving. */
  from: number;
  to: number;
}

/**
 * The tier a season is judged on.
 *
 * The *best* held during the season, not the total at the end. A player who
 * reached PRO II and then had a bad Sunday finished the season as a PRO II
 * player, and telling them otherwise punishes them for playing on.
 */
export function seasonTier(seasonBest: number): string {
  return tierFor(seasonBest).label;
}

export function seasonTierId(seasonBest: number): string {
  return tierFor(seasonBest).id;
}
