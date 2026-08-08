import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * What the crowd does, shared by the offline bake and the runtime that plays
 * it back.
 *
 * Both sides have to agree on the frame count and rate exactly — the texture's
 * height is the frame count, and the playback rate is what turns a row of it
 * into a moment in time. Keeping the numbers in one file is what stops a
 * re-bake and the game disagreeing about how long a loop is.
 */

/** Baked at 30 fps; one loop is CROWD_FRAMES long. */
export const CROWD_FPS = 30;

/** 48 frames is 1.6 s — long enough not to read as a loop, small in texture. */
export const CROWD_FRAMES = 48;

/** Two standing figures then two seated, in that order. */
export const CROWD_FILES = ["f1.glb", "f2.glb", "f3.glb", "f4.glb"];

/**
 * Bone rotation axes, measured rather than assumed.
 *
 * Bone local axes differ per rig, so scripts/rigtest.ts rotated each bone about
 * all three and reported where the hand ended up. On this rig it is local Y
 * that swings an arm through the vertical and local Z that leans the spine.
 */
const ARM = new Vector3(0, 1, 0);
const SPINE = new Vector3(0, 0, 1);

export interface Clip {
  /** Bone name suffix, as the pack names them after `_skeleton_`. */
  bone: string;
  axis: Vector3;
  /** Radians at the extremes of the swing. */
  amplitude: number;
  /** Cycles per loop; two per 1.6 s reads as applause. */
  cycles: number;
  /** Fraction of a cycle this bone lags behind the beat. */
  phase: number;
}

/**
 * Arms pumping overhead with the torso rocking under them.
 *
 * No vertical bounce: crowd.ts already lifts whole figures by rewriting their
 * instance matrices, and doing it in both places would double the travel.
 *
 * The arms and forearms are deliberately out of phase with each other and
 * left/right out of phase again, so a stand full of spectators reads as a
 * crowd rather than a chorus line.
 */
export const CHEER: Clip[] = [
  { bone: "LeftArm", axis: ARM, amplitude: 0.4, cycles: 2, phase: 0 },
  { bone: "RightArm", axis: ARM, amplitude: 0.4, cycles: 2, phase: 0.5 },
  { bone: "LeftForeArm", axis: ARM, amplitude: 0.22, cycles: 2, phase: 0.12 },
  { bone: "RightForeArm", axis: ARM, amplitude: 0.22, cycles: 2, phase: 0.62 },
  { bone: "Spine1", axis: SPINE, amplitude: 0.08, cycles: 1, phase: 0 },
  { bone: "Spine3", axis: SPINE, amplitude: 0.06, cycles: 1, phase: 0.25 },
  { bone: "Neck", axis: SPINE, amplitude: 0.07, cycles: 2, phase: 0.3 },
];
