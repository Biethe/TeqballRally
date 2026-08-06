/**
 * The establishing shot before the first serve.
 *
 * Every venue now has a ring of boards, a crowd and a ground built around it,
 * and from the play camera you see almost none of it — the shot is framed on
 * the table, which is the right frame to play in and the wrong one to arrive
 * in. So a match opens high and wide over the venue and swings down into the
 * play position over a few seconds.
 *
 * The camera path is plain numbers rather than Babylon vectors so it can be
 * checked in a unit test: the two properties that matter — that it ends
 * exactly on the play camera's pose, and that it never dips below the ground
 * or through the court — are the sort of thing that is invisible when it
 * breaks on one venue and obvious in an assertion.
 */

/** A camera pose: where it is, and what it looks at. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
}

/** How long the establishing shot runs, in seconds. */
export const INTRO_SECONDS = 3.6;

/**
 * How far back the sweep starts, relative to where it ends.
 *
 * Per venue, because a roof is a hard ceiling: the indoor hall needs a low,
 * tight arc that stays under it, while an outdoor ground can be seen from as
 * high as you like. The first version used one setting for all four and the
 * hall's shot opened on the outside of its own dome.
 */
export interface IntroSweep {
  /** Extra radius from the table at the start. */
  radius: number;
  /** Extra height at the start. */
  height: number;
  /** Radians of swing around the table across the shot. */
  swing: number;
  /**
   * A box the camera may not leave, as half-extents about the table.
   *
   * Indoor venues need this and outdoor ones do not. The hall's court is an
   * ellipse inside a seating bowl, so a circular orbit at the play camera's
   * own radius exits through the short axis and ends up inside a wall — which
   * is exactly what the first two indoor sweeps did, one through the roof and
   * one through the stand. Clamping flattens the arc against the bowl instead
   * of pushing through it.
   *
   * A bound must not be tighter than the play camera's own position, or the
   * shot is held inside it all the way and then jumps out at the handover.
   */
  boundX?: number;
  boundZ?: number;
}

/** Suits a venue with nothing overhead. */
export const OPEN_SWEEP: IntroSweep = { radius: 10, height: 6.5, swing: 1.45 };

/** Nothing here should ever put the camera under the floor. */
const MIN_HEIGHT = 1.2;

function smoother(t: number): number {
  // Smootherstep: zero first and second derivative at both ends, so the shot
  // neither jerks at the start nor arrives with a visible stop.
  const c = Math.min(1, Math.max(0, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/**
 * The camera pose `u` of the way through the shot, given where it has to end.
 *
 * `end` is the live play camera for this frame, not a constant: it moves with
 * the ball, so interpolating toward a snapshot taken at the start would leave
 * a jump at the handover.
 */
export function introPose(u: number, end: Pose, sweep: IntroSweep = OPEN_SWEEP): Pose {
  const k = smoother(u);
  if (k >= 1) return end;

  // Work in cylindrical coordinates about the table so the shot swings around
  // the court rather than sliding through it in a straight line.
  const dx = end.x - end.tx;
  const dz = end.z - end.tz;
  const endRadius = Math.hypot(dx, dz);
  const endAzimuth = Math.atan2(dz, dx);

  const radius = endRadius + sweep.radius * (1 - k);
  const azimuth = endAzimuth + sweep.swing * (1 - k);
  const height = end.y + sweep.height * (1 - k);

  const limit = (v: number, bound: number | undefined): number =>
    bound === undefined ? v : Math.min(bound, Math.max(-bound, v));

  return {
    x: limit(end.tx + Math.cos(azimuth) * radius, sweep.boundX),
    y: Math.max(MIN_HEIGHT, height),
    z: limit(end.tz + Math.sin(azimuth) * radius, sweep.boundZ),
    // The look-at target eases from the middle of the court to whatever the
    // play camera is tracking, so the last second is already the real shot.
    tx: end.tx * k,
    ty: end.ty * k + 1.1 * (1 - k),
    tz: end.tz * k,
  };
}
