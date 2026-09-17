/**
 * Where an animation is, as a function of the simulation's clock.
 *
 * A match used to run on two clocks. The ball, the positions and the contact
 * countdowns stepped in simulation ticks; Babylon advanced every animation on
 * the render loop's own delta. They agree only while a device keeps up, and
 * none of the phones this game ships to always does: a frame the simulation
 * capped or dropped was a frame the animations still played, so a foot swung
 * through a ball that had not arrived yet. Online it was worse, because the
 * guest's clips ran on a third clock — its own renderer — against a ball timed
 * in the host's ticks. Every "steer the clip back toward the window" and
 * "hurry the wind-up" in the history of this netcode was a correction for that.
 *
 * So a match character's clips are not played; they are *placed*. A clip is a
 * start tick, a start frame and a rate, and its frame at any tick is
 * arithmetic. The ball and the clip then share one clock by construction, on
 * every device and on both ends of a connection: the guest places the host's
 * clip against the host's ticks, and the frame on its screen is the frame on
 * the host's.
 *
 * Clips are authored at 60 frames a second and the simulation steps 60 ticks a
 * second of game time, so at rate 1 a clip moves one frame per tick.
 *
 * Pure: numbers in, numbers out.
 */

export interface ClockedClip {
  /** The clock tick at which the clip stood at `startFrame`. */
  startTick: number;
  startFrame: number;
  /** Frames per tick. */
  speed: number;
  /** The clip's own range. */
  from: number;
  to: number;
  loop: boolean;
}

/** The clip's frame at `tick`, and whether a one-shot clip has run out. */
export function clipFrameAt(c: ClockedClip, tick: number): { frame: number; ended: boolean } {
  const raw = c.startFrame + (tick - c.startTick) * c.speed;
  const span = c.to - c.from;
  if (c.loop) {
    if (!(span > 0)) return { frame: c.from, ended: false };
    const into = (((raw - c.from) % span) + span) % span;
    return { frame: c.from + into, ended: false };
  }
  // A millionth of a frame short is the end: a start frame and a rate chosen to
  // land exactly on the last frame come back a hair under it in floating point.
  if (raw >= c.to - 1e-6) return { frame: c.to, ended: true };
  return { frame: Math.max(c.from, raw), ended: false };
}

/** Progress through the whole clip, 0 to 1, at `tick`. */
export function clipFractionAt(c: ClockedClip, tick: number): number {
  const span = c.to - c.from;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (clipFrameAt(c, tick).frame - c.from) / span));
}

/**
 * The same clip at a new rate, continuing from where it is at `tick` — so a
 * change of speed never jumps the pose.
 */
export function rebaseClip(c: ClockedClip, tick: number, speed: number): ClockedClip {
  return { ...c, startTick: tick, startFrame: clipFrameAt(c, tick).frame, speed };
}

/**
 * A looping clip's phase, advanced by game time rather than placed by tick.
 *
 * Locomotion is not a decision anyone else has to agree with — nobody times a
 * ball against the stride of a jog — and its rate changes with every step of a
 * run, so it is integrated: `seconds` of game time at `rate`, wrapped into the
 * clip's range.
 */
export function advanceLoop(frame: number, from: number, to: number, seconds: number, rate: number): number {
  const span = to - from;
  if (!(span > 0)) return from;
  const into = (((frame - from + seconds * 60 * rate) % span) + span) % span;
  return from + into;
}
