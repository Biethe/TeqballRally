/**
 * Pulling a predicted position back onto the authoritative one.
 *
 * An online guest moves its own character the instant its controls say so,
 * rather than waiting a round trip for the host to agree — that delay is the
 * one a player feels directly. The two then disagree slightly, because the
 * host applies a reach assist the guest cannot know about and because packets
 * take time. This closes that gap.
 *
 * Kept separate from the match because it is the part that can be wrong in a
 * way nobody notices until it feels bad: too abrupt and the player is tugged
 * off their line, too gentle and they drift somewhere the host disagrees with.
 * Here it can be tested exactly, which a browser at three frames a second
 * cannot do.
 */

export interface Point2 {
  x: number;
  z: number;
}

export interface ReconcileOptions {
  /** Beyond this the prediction is abandoned and the target taken outright. */
  snap: number;
  /** Below this the target is taken exactly, so corrections actually finish. */
  arrive: number;
  /** Seconds over which a correction is bled off. */
  time: number;
}

export const RECONCILE_DEFAULTS: ReconcileOptions = {
  // Further than a player could have run since the last frame: a missed input,
  // or the host moved this character itself.
  snap: 3.0,
  arrive: 0.01,
  // Long enough that a correction reads as the player's own momentum rather
  // than a tug, short enough that the two never drift far apart.
  time: 0.25,
};

/**
 * Return where a predicted position should be after `dt`, given what the host
 * says. Pure, so the caller decides whether to write it back.
 */
export function reconcile(
  current: Point2,
  target: Point2,
  dt: number,
  opts: ReconcileOptions = RECONCILE_DEFAULTS
): Point2 {
  const ex = target.x - current.x;
  const ez = target.z - current.z;
  const err = Math.hypot(ex, ez);

  if (err > opts.snap) return { x: target.x, z: target.z };
  if (err <= opts.arrive) return { x: target.x, z: target.z };

  // Fraction of the remaining error to remove this step. Clamped so a long
  // frame corrects fully rather than overshooting past the target.
  const k = Math.min(1, dt / opts.time);
  return { x: current.x + ex * k, z: current.z + ez * k };
}
