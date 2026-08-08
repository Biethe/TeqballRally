/**
 * Which spectator plays which clip, shared by the offline bake and the runtime
 * that plays it back.
 *
 * Both sides must agree on the frame count and rate exactly: the texture's
 * height is the frame count, and the rate is what turns a row of it into a
 * moment in time. Keeping the numbers in one file is what stops a re-bake and
 * the game disagreeing about how long a loop is.
 *
 * The motion itself is Mixamo mocap, retargeted onto the crowd rig by bone
 * name — see scripts/extract-mixamo-clips.mjs.
 */

/** Played back at 30 fps; one loop is CROWD_FRAMES long. */
export const CROWD_FPS = 30;

/**
 * 48 frames per loop.
 *
 * The clips vary from 1.2 s to 6.5 s, and each is resampled across these
 * frames rather than given its own length, so every figure's texture is the
 * same shape. A clap therefore plays a little slower than recorded and a
 * sitting clap a little faster, which at crowd distance reads as variety.
 */
export const CROWD_FRAMES = 48;

export interface CrowdFigure {
  /** Figure model, as installed under assets/models/Crowd. */
  file: string;
  /** Clip name, matching a folder produced by the Mixamo conversion. */
  clip: string;
  /** Standing figures ring the court; seated ones go on the benches. */
  posture: "standing" | "seated";
}

/**
 * Four figures, four different motions.
 *
 * Giving each figure its own clip is what stops the crowd looking like a
 * chorus line — the per-instance phase offset varies timing, but only
 * different motions vary the shape.
 */
export const CROWD_FIGURES: CrowdFigure[] = [
  { file: "f1.glb", clip: "Cheering", posture: "standing" },
  { file: "f2.glb", clip: "Fist_Pump", posture: "standing" },
  { file: "f3.glb", clip: "Sitting_Clap", posture: "seated" },
  { file: "f4.glb", clip: "Sitting_Clap_1", posture: "seated" },
];
