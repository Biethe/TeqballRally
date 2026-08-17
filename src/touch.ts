/**
 * How good a touch was, and what that is worth.
 *
 * The game already decided *whether* a player may play the ball — they are in
 * possession, the ball is in reach, an animation is free. This module answers
 * the question after it: how well did they meet it, and what does the ball do
 * as a result.
 *
 * Three things make a contact good, and all three are things the player did
 * before the ball arrived:
 *
 *   - **height** — the ball is at the height the chosen limb actually strikes
 *     at, rather than half a body above or below it,
 *   - **reach** — it is in front of them rather than at full stretch,
 *   - **timing** — the contact falls in the middle of the window the touch was
 *     asked for in, rather than at either end of it.
 *
 * There is no clock to hit and no bar to watch. Every input is geometry the
 * player produced by standing somewhere and asking for the touch when they
 * did, which is what makes this felt rather than read — and, because none of
 * it is drawn from a random source, learnable: the same approach played the
 * same way grades the same, every time.
 *
 * Pure on purpose. This is gameplay, it decides what the ball does next, and
 * it has to be testable without a scene, a renderer or a phone behind it.
 */

import { PART_SETUP, type BodyPart } from "./config";

/** Everything a graded contact is judged from, in metres and seconds. */
export interface ContactErrors {
  /** Ball height at the planned contact vs the height the limb strikes at. */
  heightError: number;
  /** How far the player still has to travel to put the limb on the ball. */
  reach: number;
  /** How far the planned contact sits from the middle of the touch window. */
  timing: number;
  /** The player's own height: what the height error is judged against. */
  height: number;
  /** The furthest this player can stretch for the contact (agility included). */
  lunge: number;
  /** Half-width of the window the contact may be planned in, in seconds. */
  window: number;
}

/**
 * Weights of the three errors, and the scales they are measured against.
 *
 * Height leads because it is the one the player has most control over — where
 * you stand decides what the ball is level with when you meet it. Timing is
 * last because a game that graded timing hardest would be a rhythm game with a
 * teqball table drawn on it.
 */
export const QUALITY = {
  weight: { height: 0.45, reach: 0.3, timing: 0.25 },
  /** Height error, as a fraction of body height, that costs the whole term. */
  heightSpan: 0.4,
  /**
   * The floor a graded touch cannot go below.
   *
   * A poor touch is a bad ball to play next, never a touch that did not
   * happen: a beginner standing roughly right must always come away with
   * something to hit. Whether the ball is reachable at all is decided long
   * before this, by where they are standing.
   */
  floor: 0.12,
};

/** Bands a graded touch falls into. Named for the report they produce. */
export type TouchBand = "perfect" | "good" | "poor" | "scrappy";

export const BANDS = { perfect: 0.82, good: 0.55, poor: 0.3 };

/**
 * Grade one contact, 0..1.
 *
 * Deterministic in every argument: two identical approaches to two identical
 * balls grade identically, which is the property the whole skill curve rests
 * on.
 */
export function gradeContact(e: ContactErrors): number {
  const height = Math.max(0.1, e.height);
  const heightTerm = clamp01(Math.abs(e.heightError) / (height * QUALITY.heightSpan));
  const reachTerm = clamp01(Math.abs(e.reach) / Math.max(0.05, e.lunge));
  const timingTerm = clamp01(Math.abs(e.timing) / Math.max(0.02, e.window));
  const penalty =
    QUALITY.weight.height * heightTerm +
    QUALITY.weight.reach * reachTerm +
    QUALITY.weight.timing * timingTerm;
  return Math.max(QUALITY.floor, Math.min(1, 1 - penalty));
}

export function touchBand(quality: number): TouchBand {
  if (quality >= BANDS.perfect) return "perfect";
  if (quality >= BANDS.good) return "good";
  if (quality >= BANDS.poor) return "poor";
  return "scrappy";
}

/**
 * Whether the contact was taken too early or too late, from the same timing
 * error the grade is built on. Only used to shape *which way* a scrappy ball
 * squirts: a touch met too early is still climbing and goes long, one met too
 * late has dropped and goes short.
 */
export function timingSense(timing: number, window: number): -1 | 0 | 1 {
  const slack = Math.max(0.02, window) * 0.35;
  if (timing > slack) return 1; // contact planned late in the window: met early
  if (timing < -slack) return -1;
  return 0;
}

/** What a set-up touch does with the ball, given the part that played it. */
export interface SetupShape {
  /** Multiplier on how high the ball is popped. */
  rise: number;
  /** Multiplier on how far it is placed from the player. */
  carry: number;
  /**
   * How much of the asked-for placement survives, 0..1. Below 1 the ball lands
   * short of where it was aimed and drifts, which is what makes a poor first
   * touch an awkward second one rather than a lost point.
   */
  accuracy: number;
  /**
   * Sideways drift as a fraction of the carry, signed by the contact: an early
   * contact pushes the ball on, a late one leaves it behind.
   */
  drift: number;
}

/**
 * How a set-up touch comes off the body.
 *
 * The part decides the character of the ball; the quality decides how much of
 * what was asked for actually happens. A perfect chest touch sits the ball up
 * exactly where the player wanted it; a scrappy foot touch sends it somewhere
 * near, lower, and travelling.
 */
export function setupShape(part: BodyPart, quality: number, sense: -1 | 0 | 1): SetupShape {
  const q = clamp01(quality);
  const p = PART_SETUP[part];
  // What is lost is scaled by the part's own control: the same bad contact
  // costs a chest almost nothing and a foot a great deal.
  const loss = (1 - q) / Math.max(0.3, p.control);
  return {
    // A bad touch dies off the body — the ball sits up less, so there is less
    // time before the next one.
    rise: p.rise * (1 - 0.4 * loss),
    carry: p.carry * (1 - 0.35 * loss),
    accuracy: clamp01(1 - 0.55 * loss),
    drift: sense * 0.45 * loss,
  };
}

/**
 * What a graded contact does to a kick: a little pace, and a lot of accuracy.
 *
 * Pace is barely touched on purpose — a mishit that also flew slowly would
 * take the danger out of exactly the shot a player is punished for rushing.
 * The spread is where the cost lands, so a scrappy attack is a fast ball the
 * striker no longer controls.
 */
export function strikeShape(quality: number): { power: number; spread: number } {
  const q = clamp01(quality);
  return { power: 0.85 + 0.15 * q, spread: 1 + 1.35 * (1 - q) };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
