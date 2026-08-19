/**
 * Reading a landscape kick: how hard, and how high.
 *
 * One button, two answers. **How many times you tapped it** picks one of three
 * speeds, and **how long you held the last press** picks the arc. They are
 * independent on purpose: the old scheme charged a single scalar and derived
 * the arc from it, so asking for a slow ball meant asking for a floaty one and
 * a hard drive could never be lobbed. Now a triple-tap is a flat missile and a
 * single long hold is the gentle lob over the top, and everything between is
 * reachable.
 *
 * ### When the kick actually happens
 *
 * A tap count cannot be known until no more taps are coming, and this game has
 * been here before: portrait play once had a double tap, and it was taken out
 * precisely because *every* tap then sat through the wait (see `gestures.ts`).
 * So the rule is hybrid, and the wait is the exception rather than the rule:
 *
 *   - a press held past `hold` commits **the moment it is released** — the
 *     player has already said "now", and no later tap could change the arc
 *     they just asked for;
 *   - the third tap commits **immediately** too, because the tier is capped and
 *     a fourth press could not mean anything;
 *   - only a one- or two-tap sequence waits, and only for `tapWindow`.
 *
 * The shot that most needs to be on time — the hard flat one — is exactly the
 * shot that never waits.
 *
 * ### Kept pure
 *
 * Timing edge cases are the whole of this module, and `Input` cannot be built
 * without a DOM, so none of this touches one. Every entry point takes the time
 * as an argument and the caller passes the *event's* timestamp, never the
 * handler's clock: on a struggling phone two presses 140 ms apart can reach
 * their listeners half a second apart, which would read as two separate kicks.
 */

export const KICK_INPUT = {
  /** A press down at least this long is a hold rather than a tap (s). */
  hold: 0.2,
  /** After a release, how long a tap sequence waits for another tap (s). */
  tapWindow: 0.18,
  /** Taps past this cannot say anything new, so the sequence commits there. */
  maxTaps: 3,
  /** Holding this much longer than `hold` asks for the fullest arc (s). */
  loftRamp: 0.3,
  /** What each tap count asks for, 0..1. */
  tiers: [0.34, 0.62, 0.95],
  /**
   * The arc a full hold asks for.
   *
   * Matched to `SWIPE_LOFT.high` so a held kick in landscape and a slow upward
   * swipe in portrait reach the same lob — the two schemes should be two ways
   * of asking, not two different games.
   */
  loftMax: 2.0,
} as const;

/** A press sequence in progress. */
export interface KickSequence {
  /** Presses so far, 1..maxTaps. */
  taps: number;
  /** When the press currently down began, or null between taps. */
  downAt: number | null;
  /** When the last press ended, or null while one is down. */
  upAt: number | null;
}

/** What a finished sequence asked for. */
export interface KickCommit {
  taps: number;
  power: number;
  loft: number;
}

/** The speed a tap count asks for. */
export function kickPower(taps: number): number {
  const i = Math.min(KICK_INPUT.maxTaps, Math.max(1, Math.round(taps))) - 1;
  return KICK_INPUT.tiers[i];
}

/**
 * The arc a press of this length asks for.
 *
 * A tap is exactly 1 — the neutral value the landscape path has always passed,
 * which is what makes every existing tapped shot come out of this scheme
 * unchanged. Only holding past the threshold bends it, and it eases in rather
 * than stepping, so the boundary cannot be felt as a jump.
 */
export function kickLoft(hold: number): number {
  if (hold <= KICK_INPUT.hold) return 1;
  const t = Math.min(1, (hold - KICK_INPUT.hold) / KICK_INPUT.loftRamp);
  return 1 + (KICK_INPUT.loftMax - 1) * t * t * (3 - 2 * t);
}

/** How long the press currently down has lasted; 0 when none is. */
export function kickHeldFor(seq: KickSequence | null, now: number): number {
  return seq?.downAt == null ? 0 : Math.max(0, now - seq.downAt);
}

/** A press went down. */
export function kickDown(seq: KickSequence | null, t: number): KickSequence {
  // A press that arrives after the window is a new shot, not a late tap on the
  // last one. Without this, a kick every few seconds would keep climbing tiers.
  const continues = seq !== null && seq.upAt !== null && t - seq.upAt <= KICK_INPUT.tapWindow;
  return {
    taps: continues ? Math.min(KICK_INPUT.maxTaps, seq.taps + 1) : 1,
    downAt: t,
    upAt: null,
  };
}

/** A press was released. Commits if it was a hold, or if the tiers are spent. */
export function kickUp(
  seq: KickSequence | null,
  t: number
): { seq: KickSequence | null; commit: KickCommit | null } {
  if (!seq || seq.downAt === null) return { seq, commit: null };
  const held = Math.max(0, t - seq.downAt);
  const done = held >= KICK_INPUT.hold || seq.taps >= KICK_INPUT.maxTaps;
  if (done) {
    return { seq: null, commit: { taps: seq.taps, power: kickPower(seq.taps), loft: kickLoft(held) } };
  }
  return { seq: { taps: seq.taps, downAt: null, upAt: t }, commit: null };
}

/**
 * Time passing. Commits a tap sequence once nothing more can be coming.
 *
 * Called once a frame. A sequence whose window expired between frames commits
 * on the next one rather than being lost.
 */
export function kickTick(
  seq: KickSequence | null,
  t: number
): { seq: KickSequence | null; commit: KickCommit | null } {
  if (!seq || seq.downAt !== null || seq.upAt === null) return { seq, commit: null };
  if (t - seq.upAt < KICK_INPUT.tapWindow) return { seq, commit: null };
  // Only taps can reach here — a hold committed on release — so the arc is
  // neutral by construction.
  return { seq: null, commit: { taps: seq.taps, power: kickPower(seq.taps), loft: 1 } };
}
