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
 * Seven figures, seven different motions.
 *
 * Giving each figure its own clip is what stops the crowd looking like a
 * chorus line — the per-instance phase offset varies timing, but only
 * different motions vary the shape.
 *
 * Each of these carries its own animation, so `clip` names a group inside the
 * figure's own file rather than something to retarget onto it. That is the
 * difference between this crowd and the one before it: retargeting Mixamo
 * motion onto the old rigs tore them apart every way it was tried, and the
 * bake shipped a held pose because of it. Mesh, rig and motion from one source
 * have one set of conventions and need no transfer at all.
 */
export const CROWD_FIGURES: CrowdFigure[] = [
  { file: "Caleb.glb", clip: "CheeringWhileStanding", posture: "standing" },
  { file: "Judith.glb", clip: "ClappingWhileStanding", posture: "standing" },
  { file: "Lea.glb", clip: "StandingAndYelling", posture: "standing" },
  { file: "Leo.glb", clip: "StandingAndFistpump", posture: "standing" },
  // Quieter, so the stand is not uniformly ecstatic between points. Not one of
  // the StandingPose clips: those are poses, and bake to a spread of exactly
  // zero — a statue among people.
  { file: "Megan.glb", clip: "StandingStill", posture: "standing" },
  // The only seated clip in the set, and the benches need somebody on them.
  // Two figures share it: the meshes differ and the per-instance phase offset
  // does the rest.
  { file: "Simone.glb", clip: "FistPumpWhileSitting", posture: "seated" },
  { file: "Tebby.glb", clip: "FistPumpWhileSitting", posture: "seated" },
];
