import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { COURT, PLAY_BOX, TABLE } from "./config";

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
 * The shape of ball a swipe asks for — and *only* the shape.
 *
 * Three things a swipe can say, three things a shot is, and nothing riding
 * along with anything else:
 *
 *   - **across** aims it, left or right;
 *   - **up and down** shapes it, from a lob to a drive;
 *   - **how fast it was drawn** is how hard it is struck.
 *
 * Up lifts and down drills, which is the way round a thumb expects: you push
 * the ball up to float it. Depth is deliberately absent from that list. Given
 * where the ball is struck, the arc and the pace already decide where it comes
 * down — high and slow lands short, flat and fast lands deep — so a fourth dial
 * would be asking the player to specify something physics has already answered.
 *
 * This replaces a scheme where steepness set the arc, the pace *and* the depth
 * together. That bundling made two real shots impossible: the fast high ball
 * played over somebody standing in, and the slow flat one dropped just over the
 * net. Both exist now, and the fast lob is punished by carrying too far rather
 * than by a rule forbidding it.
 */
export type SwipeCategory = "drive" | "balanced" | "lob";

export interface SwipeShot {
  category: SwipeCategory;
  /** 0..1, as any other kick's power. Read from the swipe's pace alone. */
  power: number;
  /** Arc multiplier: below 1 drills the ball, above 1 floats it. */
  loft: number;
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
export const SWIPE_BAND = { from: 0.22, full: 0.62 };

/**
 * How hard the slowest and fastest swipes strike.
 *
 * The whole range, and the shape of the swipe does not touch it. A steep swipe
 * used to carry a power floor with it — a lob was capped slower than a lazy
 * drive, on the theory that height is bought with pace. It is a real trade, but
 * legislating it cost the driven lob, and physics enforces it anyway: ask for
 * height *and* pace and the ball simply carries past the table.
 */
const SWIPE_PACE = { min: 0.26, max: 1 };

/**
 * The arc a fully steep swipe asks for, either way, around the neutral ball.
 *
 * Deliberately wider than the old drive/lob pair: the axis used to feel dead
 * because its ends were close enough together that the launch corrections
 * (net clearance, height-of-contact) swallowed most of the difference. The
 * spread is safe because every launch is policed by the apex cap at twice the
 * striker's height — the thumb can ask for more than the ball may do, and the
 * cap, not the axis, is the ceiling.
 */
export const SWIPE_LOFT = { flat: 0.52, neutral: 1, high: 2.0 };

/**
 * Where on the opponent's half a swipe lands, as a fraction of their half.
 *
 * `base` is the middle of it. Arc and pace move it from there: a flatter ball
 * runs deeper, a higher one drops shorter, and a harder one goes further than a
 * soft one of the same shape. Both terms are needed — arc leads, because that
 * is what the thumb is shaping, and pace follows, because a ball struck harder
 * genuinely does travel further before it comes down.
 *
 * **The target is on the table, not a distance from the striker.** That is the
 * fix for the thing that made portrait unplayable: the carry used to be thrown
 * a fixed distance from wherever the player was standing — up to eleven metres,
 * in a court less than six metres deep — so from a normal receiving position
 * every drive and every rally ball overshot the table, and a downward lob was
 * the only swipe that could score at all. Aiming at the half, the way the CPU
 * already does through `tableTarget`, means a shot lands where it was sent from
 * anywhere on the court, and over-hitting is paid for in accuracy (the spread
 * grows with power) rather than in an arbitrary length.
 */
const SWIPE_DEPTH = { base: 0.55, fromLoft: 0.22, fromPace: 0.3, min: 0.25, max: 0.95 };

/**
 * Read a swipe as a shot.
 *
 * `forward` is the gesture's vertical reach in court space — toward the
 * opponent's end, positive for a swipe up the screen — and `pace` is how fast
 * it was drawn, 0..1. Both are read **raw** rather than normalised to a
 * direction, which is the whole reason the axes are independent: a long swipe
 * to the left with a little lift is a wide ball with a little lift, and the
 * sideways reach does not eat into the arc the way normalising made it.
 *
 * `groundLoft` is the flattest arc the striker is actually allowed from where
 * they stand — `loftFloor(x)`, which is zero anywhere inside the smash range
 * and rises the further back they are. Passing it in is what keeps the control
 * honest when it binds: the axis is remapped into the range that is legal
 * there, so a full-down swipe from deep still gives the flattest ball available
 * rather than being silently overridden downstream and feeling dead. It cannot
 * be used to *buy* a flat drive from deep — the floor is still applied to the
 * final arc in `tryStrike`; this only stops the thumb lying about its range.
 *
 * Deterministic: the same drawing is the same shot, which is what lets a player
 * build the habit at all.
 */
export function swipeShot(forward: number, pace: number, groundLoft = 0): SwipeShot {
  const p = Math.min(1, Math.max(0, pace));
  const power = SWIPE_PACE.min + (SWIPE_PACE.max - SWIPE_PACE.min) * p;
  // How steeply it was drawn, in its own right. A swipe with nothing vertical
  // left in it (a flat sideways flick, a stale aim) is the neutral ball.
  const steep = Math.min(1, Math.abs(forward));
  const lift = ramp(steep, SWIPE_BAND.from, SWIPE_BAND.full);
  const up = forward >= 0;
  // The floor arrives as an absolute arc and the axis works in multipliers, so
  // it is converted through the same power term the arc is built on.
  const lowest = groundLoft > 0 ? groundLoft / Math.max(0.05, loftFor(power)) : 0;
  // The *whole* axis lifts with the floor, not just its bottom end. Raising the
  // flat end alone would leave a downward swipe asking for more arc than a
  // sideways one — the axis inverted under the player's thumb exactly where it
  // was already hardest to use. Standing far enough back the two ends meet,
  // which is the honest answer: from there the shot is a lob whatever you draw.
  const base = Math.max(SWIPE_LOFT.neutral, lowest);
  const end = up ? Math.max(SWIPE_LOFT.high, base) : Math.max(SWIPE_LOFT.flat, lowest);
  return {
    // The name follows the half the swipe is actually in, so what a player is
    // told (and what a test asserts) matches what they drew.
    category: lift >= 0.5 ? (up ? "lob" : "drive") : "balanced",
    power,
    loft: base + (end - base) * lift,
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
 * downward one mean. The sideways component aims it left or right; **how far it
 * carries is derived, not chosen.**
 *
 * Carry falls as the arc rises, which is the one place the physics is stated
 * rather than simulated: a ball thrown higher for the same effort does not go
 * as far. That is what makes the fast lob self-punishing — ask for height and
 * pace together and the carry runs past the table, `clampToPlay` pins it a
 * hand's width beyond the line, and the point is lost to a shot that was never
 * on. No rule had to forbid it.
 */
export function swipeTarget(
  from: Vector3,
  attackingSign: number,
  lateral: number,
  shot: SwipeShot
): Vector3 {
  const depth = Math.min(
    SWIPE_DEPTH.max,
    Math.max(
      SWIPE_DEPTH.min,
      SWIPE_DEPTH.base +
        (SWIPE_LOFT.neutral - shot.loft) * SWIPE_DEPTH.fromLoft +
        (shot.power - 0.5) * SWIPE_DEPTH.fromPace
    )
  );
  const lat = Math.max(-1, Math.min(1, lateral));
  // `from` is deliberately unused for the landing spot: a kick is aimed at the
  // table, not thrown a length from the player. It stays in the signature
  // because the caller is the only thing that knows which way this striker
  // attacks, and because a future rule may want the striking position back.
  void from;
  return clampToPlay(
    new Vector3(
      attackingSign * TABLE.halfLen * depth,
      0,
      lat * TABLE.halfWid * SWIPE_LATERAL
    )
  );
}

/** How far across the half a fully sideways swipe aims, as a fraction of it. */
const SWIPE_LATERAL = 0.9;

/**
 * How large the landing deviation is, in metres.
 *
 * Power is the honest trade in this game: a hard kick is harder to keep on a
 * 1.5 m table half, so pace has to cost accuracy or there would be no reason
 * ever to play a soft one. Precision is the counterweight, and the number a
 * player will later be able to improve — it divides the spread, so a precise
 * striker can hit hard and still keep it in. The deviation this sizes is
 * shaped by the contact itself (`landingDeviation`), never rolled.
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
 * How the spread of a kick is shaped between its two directions: along the
 * line of the shot (over- and under-carry) and across it (the squirt of a
 * ball reached away from the body).
 */
export const DEVIATION = {
  /** Share of the radius spent along the shot line. */
  along: 0.6,
  /** Weight of the contact's timing sense on the over/under-carry. */
  senseWeight: 0.6,
  /** Weight of power on the carry, centred on a middling strike. */
  powerWeight: 0.8,
  powerCentre: 0.55,
  /** The stretch at which the across-squirt is fully grown. */
  stretchFull: 0.6,
};

/** What the contact itself says about where the ball will actually land. */
export interface DeviationInputs {
  /** The kick's power, 0..1. */
  power: number;
  /** Contact timing: +1 met early (ball still climbing), −1 met late. */
  sense: -1 | 0 | 1;
  /** The ball's side at contact, in the striker's own frame (+ = their right). */
  lateral: number;
  /** How far the striker had to reach, 0 = in front of them, 1+ = full stretch. */
  stretch: number;
}

/**
 * Where a kick actually lands, given where it was aimed and the geometry of
 * the contact that struck it.
 *
 * The radius is the spread the contact earned — power, precision, foot,
 * stretch and quality, as ever — but its direction is the contact's own, so
 * the same shot lands the same way twice and a miss is a lesson rather than
 * a draw: met early the ball carries long, met late it dies short, full
 * power flattens it past the aim, and a ball reached at arm's length squirts
 * toward the side it was reached on. A ball met square in front squirts not
 * at all — squaring up is the skill the across term is teaching.
 */
export function landingDeviation(
  target: Vector3,
  ballPos: Vector3,
  radius: number,
  inputs: DeviationInputs
): Vector3 {
  if (radius <= 0) return target.clone();
  const dx = target.x - ballPos.x;
  const dz = target.z - ballPos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return target.clone();
  const fx = dx / len;
  const fz = dz / len;
  // Along: over- and under-carry, signed by the contact and the power.
  const sLong = clamp11(
    DEVIATION.senseWeight * inputs.sense + DEVIATION.powerWeight * (inputs.power - DEVIATION.powerCentre)
  );
  const long = radius * DEVIATION.along * sLong;
  // Across: the ball squirts toward the side it was reached on, grown by how
  // far the striker had to stretch for it. `perp` is the striker's left when
  // they aim down-court, whichever end they strike from, so the same relative
  // contact mirrors into the same relative miss on both halves.
  const stretch = Math.min(1, Math.max(0, inputs.stretch) / DEVIATION.stretchFull);
  const across = -radius * (1 - DEVIATION.along) * Math.sign(inputs.lateral) * stretch;
  return new Vector3(
    target.x + long * fx + across * -fz,
    target.y,
    target.z + long * fz + across * fx
  );
}

function clamp11(v: number): number {
  return Math.max(-1, Math.min(1, v));
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
 * Where a serve aimed with `fwd` and `lat` is sent, in world space.
 *
 * Shared by the launch and by the preview ring, which used to work this out
 * separately and disagree — the ring sat up to 42 cm deeper and 16 cm wider
 * than the serve could actually reach, so it promised a corner the ball was
 * never going to find.
 *
 * Deliberately not `tableTarget`. A serve is struck from behind the service
 * line with the whole table in front of it, and giving it a rally kick's reach
 * would quietly deepen every serve in the game. These are the numbers the
 * serve already used; only the duplication is gone.
 */
export function serveTarget(attackingSign: number, fwd: number, lat: number): Vector3 {
  const depth = Math.min(1.4, Math.max(0.35, 0.85 + fwd * 0.5));
  return new Vector3(attackingSign * depth, 0, Math.max(-0.62, Math.min(0.62, lat * 0.62)));
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
