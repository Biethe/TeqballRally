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
}

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
  return Math.min(1.6, loftFor(1) + past * 0.55);
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
