import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { COURT, TABLE } from "./config";

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
  return 1.5 - 0.95 * p;
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
  return 2.2 + 6.6 * p;
}

/** Keep an aim point inside the court, where a marker can still be seen. */
export function clampToCourt(point: Vector3): Vector3 {
  return new Vector3(
    Math.max(-COURT.maxX, Math.min(COURT.maxX, point.x)),
    point.y,
    Math.max(-COURT.maxZ, Math.min(COURT.maxZ, point.z))
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
  const depth = Math.min(1.45, Math.max(0.3, 0.85 + fwd * 0.5));
  const lateral = Math.max(-0.68, Math.min(0.68, lat * 0.62));
  return new Vector3(attackingSign * depth, 0, lateral);
}
