import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { COURT, PLAY_BOX, TABLE, TABLE_SCALE } from "./config";

/**
 * What a kick is trying to do: land the ball on a point, at a chosen power.
 *
 * The point is anywhere on the court, not a spot on the table the game picked
 * on the player's behalf. That is the whole change: a kick can now be aimed
 * badly, or aimed well and struck too hard to keep, and the ball goes where it
 * was actually sent rather than being quietly steered back in bounds.
 */
export interface StrikeAim {
  /** Where the kick is meant to land, in world x/z. Its y is ignored. */
  target: Vector3;
  /** 0 = a soft floater, 1 = everything the striker has. */
  power: number;
  /**
   * Multiplier on the arc the kick is played with; 1 leaves the shot to the
   * power and the contact, as a charged landscape kick does. Portrait's swipe
   * sets it directly, which is how one gesture asks for pace and shape at once.
   */
  loft?: number;
}

/**
 * The three shots a swipe can ask for.
 *
 * Not a menu — a direction. The finger is already saying where the ball should
 * go sideways, and how steeply it was drawn says what kind of ball it is:
 *
 *   - **up** (toward the far end): a drive. Fast, flat, deep, and the shot that
 *     wins a point or misses the table trying.
 *   - **down** (back toward the player): a lob. Slow and high, dropping short —
 *     what you play to buy a second when the rally has got away from you.
 *   - **across**: the rally ball. Medium pace, medium arc, medium depth.
 *
 * Up = aggressive, down = safe, across = neutral, and nothing else to learn.
 */
export type SwipeCategory = "drive" | "balanced" | "lob";

export interface SwipeShot {
  category: SwipeCategory;
  /** 0..1, as any other kick's power. */
  power: number;
  /** Arc multiplier: below 1 drills the ball, above 1 floats it. */
  loft: number;
  /** Multiplier on how far up the court the shot is aimed. */
  depth: number;
}

/**
 * How steep a swipe has to be before it stops being a sideways one.
 *
 * A thumb on a phone does not draw a clean 45°, and a scheme that demanded one
 * would be a scheme nobody could hit twice. The categories therefore start
 * turning at `from` and are only fully themselves at `full`, with everything
 * between the two a blend — so a swipe near a boundary produces a shot near
 * the boundary rather than one of two very different ones at random.
 *
 * `from` is deliberately low: a third of the way up from horizontal is already
 * unmistakably "upward" to the person drawing it.
 */
export const SWIPE_BAND = { from: 0.3, full: 0.62 };

/** The end points the bands blend between. */
const SWIPE_SHOTS: Record<SwipeCategory, Omit<SwipeShot, "category">> = {
  // Everything the swipe's pace has, thrown flat and deep.
  drive: { power: 0.72, loft: 0.58, depth: 1.16 },
  // The ball a rally is made of.
  balanced: { power: 0.42, loft: 1.0, depth: 1.0 },
  // Pace deliberately capped: a lob is a decision to give up speed for height.
  lob: { power: 0.24, loft: 1.85, depth: 0.72 },
};

/** Share of a swipe's own pace each category adds on top of its floor. */
const SWIPE_PACE: Record<SwipeCategory, number> = { drive: 0.28, balanced: 0.33, lob: 0.24 };

/**
 * Read a swipe as a shot.
 *
 * `forward` and `lateral` are the gesture's direction in court space — forward
 * meaning toward the opponent's end — and `pace` is how fast it was drawn,
 * 0..1. Deterministic: the same drawing is the same shot, which is what lets a
 * player build the habit at all.
 */
export function swipeShot(forward: number, lateral: number, pace: number): SwipeShot {
  const len = Math.hypot(forward, lateral);
  // A swipe with no length left in it (a flick straight at the screen, a stale
  // aim) is the neutral ball rather than nothing.
  const tilt = len > 1e-4 ? forward / len : 0;
  const p = Math.min(1, Math.max(0, pace));
  const toward: SwipeCategory = tilt >= 0 ? "drive" : "lob";
  const blend = ramp(Math.abs(tilt), SWIPE_BAND.from, SWIPE_BAND.full);
  const mix = (key: "power" | "loft" | "depth"): number =>
    SWIPE_SHOTS.balanced[key] + (SWIPE_SHOTS[toward][key] - SWIPE_SHOTS.balanced[key]) * blend;
  const paceShare = SWIPE_PACE.balanced + (SWIPE_PACE[toward] - SWIPE_PACE.balanced) * blend;
  return {
    // The name follows the half the swipe is actually in, so what a player is
    // told (and what a test asserts) matches what they drew.
    category: blend >= 0.5 ? toward : "balanced",
    power: Math.min(1, mix("power") + paceShare * p),
    loft: mix("loft"),
    depth: mix("depth"),
  };
}

/** Smoothstep from 0 at `a` to 1 at `b`. */
function ramp(v: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Where a swiped kick is aimed, given who is striking and what they drew.
 *
 * The shot always goes up the court — a swipe is never an instruction to kick
 * the ball backwards, which is what the old direction-as-aim mapping made a
 * downward one mean. Depth comes from the category and the power; the swipe's
 * sideways component is what aims it left or right.
 */
export function swipeTarget(
  from: Vector3,
  attackingSign: number,
  lateral: number,
  shot: SwipeShot
): Vector3 {
  const reach = rangeFor(shot.power);
  const lat = Math.max(-1, Math.min(1, lateral));
  return clampToPlay(
    new Vector3(
      from.x + attackingSign * reach * shot.depth,
      0,
      from.z + lat * reach * SWIPE_LATERAL
    )
  );
}

/** How much of a kick's carry a fully sideways swipe spends going sideways. */
const SWIPE_LATERAL = 0.55;

/**
 * How wide the landing scatter is, in metres.
 *
 * Power is the honest trade in this game: a hard kick is harder to keep on a
 * 1.5 m table half, so pace has to cost accuracy or there would be no reason
 * ever to play a soft one. Precision is the counterweight, and the number a
 * player will later be able to improve — it divides the spread, so a precise
 * striker can hit hard and still keep it in.
 */
export const SPREAD = {
  /** Radius at half power, for an unremarkable striker with an easy contact. */
  base: 0.34,
  /** Share of the radius that power alone accounts for. */
  power: 0.85,
  /** Extra radius for a contact taken at full stretch rather than in front. */
  stretch: 0.75,
  /** Nothing is ever a certainty, and nothing is ever hopeless. */
  min: 0.05,
  max: 1.6,
};

export interface SpreadInputs {
  /** The kick's power, 0..1. */
  power: number;
  /** Striker's precision trait: >1 tightens, <1 widens. */
  precision: number;
  /** Weak-foot and clip-specific wobble (1 = neutral). */
  footSpray: number;
  /** How far the striker had to reach, 0 = in front of them, 1 = full stretch. */
  stretch: number;
}

/** Radius of the disc a kick may actually land in, around where it was aimed. */
export function spreadRadius({ power, precision, footSpray, stretch }: SpreadInputs): number {
  const p = Math.min(1, Math.max(0, power));
  const reach = Math.min(1.4, Math.max(0, stretch));
  const radius =
    (SPREAD.base * (1 - SPREAD.power + SPREAD.power * 2 * p) * footSpray * (1 + SPREAD.stretch * reach)) /
    Math.max(0.3, precision);
  return Math.min(SPREAD.max, Math.max(SPREAD.min, radius));
}

/**
 * Displace a target inside its spread disc. `rand` returns 0..1 — the caller
 * passes Math.random in the game and a fixed sequence in a test.
 */
export function scatter(target: Vector3, radius: number, rand: () => number): Vector3 {
  const angle = rand() * Math.PI * 2;
  // sqrt keeps the samples uniform over the disc rather than crowding the
  // middle, so the edge of the spread is as likely as it looks.
  const r = Math.sqrt(rand()) * radius;
  return new Vector3(target.x + Math.cos(angle) * r, target.y, target.z + Math.sin(angle) * r);
}

/**
 * Flight-time multiplier for a kick's power: a soft one floats, a hard one is
 * drilled flat. Multiplies the arc the contact height and the clip already
 * imply, so a lob off the shins is still a lob.
 */
export function loftFor(power: number): number {
  const p = Math.min(1, Math.max(0, power));
  // A wide spread on purpose: in portrait the swipe's speed is the only thing
  // the gesture says about the shot, so the difference between a flicked ball
  // and a driven one has to be visible in the arc, not just in the numbers.
  return 1.7 - 1.25 * p;
}

/**
 * How close to the middle line a player has to be for the flat, hard shots.
 *
 * Level with the end of the table. Standing there is a decision — the ball is
 * normally received well behind it — and that is the point: attacking means
 * coming forward, and coming forward means less time to get back.
 */
export const SMASH_RANGE = TABLE.halfLen;

/**
 * The least loft a kick from this far out is allowed, as a multiplier.
 *
 * A hard limit rather than a nudge. From deep there is no angle through which
 * a flat ball clears the net and still comes down on the table, so a player
 * who swipes as fast as they can from the back gets a fast *lob*, not a
 * missile. Zero inside the smash range: there the shot is unconstrained and
 * the swipe decides everything.
 *
 * Ramped rather than switched, so stepping forward makes the ball flatten
 * continuously and a player can feel where the line is without being told.
 */
export function loftFloor(fromMiddle: number): number {
  const past = Math.max(0, Math.abs(fromMiddle) - SMASH_RANGE);
  if (past <= 0) return 0;
  // The ramp starts exactly where the flattest kick already is, so crossing
  // the line changes nothing and walking back from it changes the shot
  // smoothly. Writing the start as `loftFor(1)` rather than as its value is
  // what keeps that true when the swipe curve is retuned — a literal here
  // would silently become a step the day loftFor changed.
  // Halved. The old ramp threw a ball struck from the back of the half almost
  // straight up — a shot nobody aimed and nobody enjoyed watching come down.
  return Math.min(0.8, loftFor(1) + past * 0.28);
}

/** Whether the hard clips — foot volleys and backflips — are on from here. */
export function canSmashFrom(x: number): boolean {
  return Math.abs(x) <= SMASH_RANGE;
}

/**
 * How far from the striker a kick of this power carries, in metres.
 *
 * Portrait aims by direction rather than by point — a swipe says "that way,
 * this hard" — so the distance has to come from somewhere, and power is the
 * only thing the gesture said. Soft kicks drop just over the net, hard ones
 * reach the back of the opponent's half and beyond it if overdone.
 */
export function rangeFor(power: number): number {
  const p = Math.min(1, Math.max(0, power));
  return (2.2 + 6.6 * p) * TABLE_SCALE;
}

/** Keep a point a player is walking to inside the court they may stand on. */
export function clampToCourt(point: Vector3): Vector3 {
  return new Vector3(
    Math.max(-COURT.maxX, Math.min(COURT.maxX, point.x)),
    point.y,
    Math.max(-COURT.maxZ, Math.min(COURT.maxZ, point.z))
  );
}

/**
 * Keep an aim, and the landing it scatters to, inside the playable rectangle.
 *
 * A kick has to be able to miss; it does not have to be able to end up in the
 * stands. Clamping both ends of the shot to the same box means a bad one lands
 * just past the line, still on screen, and still obviously a miss.
 */
export function clampToPlay(point: Vector3): Vector3 {
  return new Vector3(
    Math.max(-PLAY_BOX.halfLen, Math.min(PLAY_BOX.halfLen, point.x)),
    point.y,
    Math.max(-PLAY_BOX.halfWid, Math.min(PLAY_BOX.halfWid, point.z))
  );
}

/** True if a landing point is on the table half belonging to `sign` (+1 or -1). */
export function onTableHalf(point: Vector3, halfSign: number): boolean {
  return (
    Math.sign(point.x) === Math.sign(halfSign) &&
    Math.abs(point.x) <= TABLE.halfLen &&
    Math.abs(point.z) <= TABLE.halfWid
  );
}

/**
 * A normalised aim (fwd/lat in -1..1) as a point on the opponent's table half.
 * The CPU still aims this way, and so does the serve preview: both want a spot
 * on the table rather than a free point on the court.
 */
export function tableTarget(attackingSign: number, fwd: number, lat: number): Vector3 {
  // Fractions of the half rather than metres, so the aim keeps its shape if
  // the table is ever resized again.
  const depth = TABLE.halfLen * Math.min(0.97, Math.max(0.2, 0.57 + fwd * 0.33));
  const lateral = TABLE.halfWid * Math.max(-0.9, Math.min(0.9, lat * 0.83));
  return new Vector3(attackingSign * depth, 0, lateral);
}
