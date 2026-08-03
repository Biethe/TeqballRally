// Dimensions from the FITEQ rulebook (metres). The playing surface is curved:
// 0.76 m high at the net, 0.565 m at the table ends, modelled as y = hCenter - k*x^2.
export const TABLE = {
  length: 3.0,
  width: 1.5,
  halfLen: 1.5,
  halfWid: 0.75,
  hCenter: 0.76,
  hEnd: 0.565,
  curveK: (0.76 - 0.565) / (1.5 * 1.5),
  netTop: 0.9,
  netHalfWidth: 0.85,
};

export const BALL_RADIUS = 0.08095; // size 5 football, ~67.5 cm circumference
export const GRAVITY = 9.81;

export const COURT = {
  minX: 1.55, // players stay behind the table end
  maxX: 6.8,
  maxZ: 4.6,
  floorHalfLen: 9,
  floorHalfWid: 6.7,
  // Draw the procedural floor/lines/boards. Turn off to play directly on the
  // arena's own court (it sits at GROUND_Y, so physics still matches).
  visible: true,
  // "oval" fits gymnasium-style arenas: the floor becomes an ellipse with
  // radii floorHalfLen x floorHalfWid and the boards follow its rim — grow the
  // radii until the floor meets the arena's own side band. "rect" is the
  // classic rectangular court with four straight boards.
  shape: "oval" as "oval" | "rect",
  // Low perimeter boards around the floor. Turn off if the arena's own band
  // already borders the play space.
  boards: true,
};

// ---------------- world layout tuning (hand-editable) ----------------
// Distances in metres. Gameplay space: table centre at the origin, ground at
// y = GROUND_Y, x = table length axis (player side x < 0), z = lateral.
// The controlled player faces +x, so "player's left" is +z.

// Height of the gameplay ground plane. EVERYTHING stands on this: the physics
// ground the ball bounces off, the table (physics + model), the net, player
// feet/spawns, the procedural floor and the camera. Match it to the arena's
// court floor so physics and visuals stay in sync — never lift the floor or
// table visuals separately.
export const GROUND_Y = 0.4;

// Where the characters spawn/idle, per side (mirrored for the AI).
export const SPAWN = {
  x: 2.9, // distance from the net along the table axis
  z: 0, // lateral offset (+z = controlled player's left)
  lift: 0, // extra y lift if a model's feet still sink into the floor
};

export const ARENA = {
  span: 55, // arena size: its longest horizontal side is scaled to this
  offsetX: -0.45, // shift arena along the table axis (+x = toward the AI side)
  offsetY: -0.05, // raise/lower the whole arena (lower it if its court floor swallows feet)
  offsetZ: -1.2, // shift arena laterally (+z = to the controlled player's left)
  rotationY: 0, // radians, in case the arena court markings need re-aligning
};

// Visual-only fine-tuning of the table model. The *physical* table (what the
// ball bounces off and players aim at) is TABLE above; change TABLE.length /
// TABLE.width to resize both physics and visuals coherently. Use this scale
// only for small cosmetic corrections — it desyncs the model from the physics.
export const TABLE_VISUAL = {
  scale: 0.8,
  offsetX: 0,
  offsetY: 0, // relative to GROUND_Y — the model is grounded there automatically
  offsetZ: 0,
};

// Global multiplier on every character's height (individual heights are in
// CHARACTERS below). Scales the model and gameplay proportions together.
export const CHARACTER_SCALE = 0.8;

// Soft magnetism toward the incoming ball: when the ball is dropping onto the
// player's side and the stick pushes roughly toward its interception point,
// the run direction is bent onto that point so the player arrives in reach.
// Pushing away (or not pushing) is never overridden.
export const REACH_ASSIST = {
  radius: 2.0, // assist only engages within this distance of the intercept (m)
  strength: 0.5, // 0 = off, 1 = full auto-run when pushing straight at the ball
};

export type CameraMode = "court" | "side" | "top";

// Rally camera framing (hand-editable). Cameras are fully static: they never
// follow the player or ball. The arena is intentionally asymmetric, so P2's
// court view uses its own interior position instead of mirroring P1's.
export const CAMERA = {
  back: 9.6, // distance behind the serve spot along the table axis (m)
  height: 6.3, // height above the ground (m)
  // Height above the ground the camera looks at (table centre). Lower = the
  // camera tilts further down; the old follow-camera aimed at ~0.9.
  lookY: 0.3,
  // P2 cannot use the mirrored P1 position: it lands outside the imported
  // gym. This keeps the view inside, matches P1's player scale, and gives it
  // a slightly steeper tilt.
  p2Court: {
    x: 8.5,
    height: 7.0,
    lookY: 0.3,
    fov: 1.1,
  },
  // Side-on and overhead presets. Side cameras use the clear, opposite
  // sideline of the imported arena; the old wider placement intersected a
  // concourse prop in the frame.
  side: {
    distance: 5.0,
    height: 7.6,
    lookY: 0.3,
    fov: 1.0,
    minZ: 0.1,
  },
  // A true 90° side orbit, pitched down by ~75° (7.20 m up over 1.93 m
  // sideways). It brings the players about 11% closer than the first top
  // camera while the slightly wider lens still frames the full 18 m × 13.4 m
  // court in a half-width viewport. The larger near plane cleanly clips the
  // arena roof trusses which otherwise cross the wide top-view lens.
  top: {
    offsetX: 0,
    offsetZ: -1.93,
    height: 7.45,
    lookY: 0.25,
    // Split-screen needs the wider lens to keep both court ends visible. Solo
    // play has the full viewport, so tighten it for a more readable player size.
    fov: 1.9,
    soloFov: 1.74,
    minZ: 2.0,
  },
};

export const SERVE_X = 4.0; // service line is 3.5 m from table centre
export const MAX_TOUCHES = 3; // touches allowed per possession (reception, prep, kick)
export const PLAYER_REACH = 1.2;
export const AI_REACH = 1.2;
export const WIN_SCORE = 12; // points to win a set
export const SETS_TO_WIN = 2; // sets to win the game (best of 3)
export const SERVE_EVERY = 2;

/** Absolute world height of the table's playing surface at x (includes GROUND_Y). */
export function tableSurfaceY(x: number): number {
  return GROUND_Y + TABLE.hCenter - TABLE.curveK * x * x;
}

// Animation metadata transcribed from Animation.txt (Blender frame numbers).
// `contact` is the ball-contact frame, `toss` the ball-leaves-hand frame (serves only).
export interface ClipInfo {
  contact: number;
  toss?: number;
  frames: number;
}

export const CLIPS: Record<string, ClipInfo> = {
  RightKneeReception: { contact: 40, frames: 76 },
  Celebration1: { contact: -1, frames: 102 },
  Celebration2: { contact: -1, frames: 113 },
  CenterHeadKick: { contact: 24, frames: 61 },
  ChestKick: { contact: 35, frames: 67 },
  ChestPrepLeft: { contact: 51, frames: 61 },
  ChestPrepRight: { contact: 50, frames: 61 },
  ChestReception: { contact: 51, frames: 74 },
  Defeat: { contact: -1, frames: 201 },
  Idle: { contact: -1, frames: 40 },
  InnerLeftFootReception: { contact: 19, frames: 40 },
  InnerRightFootReception: { contact: 48, frames: 72 },
  jogBackward: { contact: -1, frames: 53 },
  JogForward: { contact: -1, frames: 72 },
  JogStrafeLeft: { contact: -1, frames: 41 },
  JogStrafeRight: { contact: -1, frames: 40 },
  LeftFootKick: { contact: 40, frames: 85 },
  LeftHeadKick: { contact: 24, frames: 52 },
  LeftKneeReception: { contact: 53, frames: 69 },
  RightFootKick: { contact: 23, frames: 75 },
  RightHeadKick: { contact: 16, frames: 53 },
  BackflipRightFoot: { contact: 49, frames: 84 },
  BackflipLeftFoot: { contact: 56, frames: 102 },
  HeadServeLeft: { toss: 26, contact: 73, frames: 121 },
  HeadServeRight: { toss: 28, contact: 69, frames: 104 },
  ServeLeftFoot: { toss: 21, contact: 65, frames: 120 },
  ServeRightFoot: { toss: 44, contact: 92, frames: 120 },
};

// Serve speed multiplier per clip: >1 = faster, flatter serve. Foot serves
// are hit harder than head serves.
export const SERVE_POWER: Record<string, number> = {
  ServeRightFoot: 8.5,
  ServeLeftFoot: 8.5,
  HeadServeRight: 7.0,
  HeadServeLeft: 7.0,
};

// Metres above the net tape a serve clears — the direct knob for serve loft
// (bigger = higher, slower serve arc).
export const SERVE_NET_CLEARANCE = 0.22;

// Ball speed multiplier per kick clip: >1 = faster, flatter return; <1 = a
// softer ball. Clips not listed use 1. Backflips hit hardest (reward for the
// set-up they need), foot volleys are punchy, chest/knee/inner-foot are soft.
export const KICK_POWER: Record<string, number> = {
  BackflipRightFoot: 1.4,
  BackflipLeftFoot: 1.4,
  RightFootKick: 1.3,
  LeftFootKick: 1.3,
  CenterHeadKick: 1.1,
  LeftHeadKick: 1.1,
  RightHeadKick: 1.1,
  ChestKick: 0.55,
  RightKneeReception: 0.85,
  LeftKneeReception: 0.85,
  InnerRightFootReception: 0.7,
  InnerLeftFootReception: 0.7,
};

// Fastest ball each clip family can produce (m/s) — the flight-time floor is
// dist / cap. Foot volleys and backflips are true smashes; head kicks are
// quick but human; soft touches stay soft. Clips not listed use
// KICK_SPEED_CAP_DEFAULT. (The physics hard cap is MAX_SPEED in ball.ts.)
export const KICK_SPEED_CAP: Record<string, number> = {
  BackflipRightFoot: 18,
  BackflipLeftFoot: 18,
  RightFootKick: 17,
  LeftFootKick: 17,
  CenterHeadKick: 12,
  LeftHeadKick: 12,
  RightHeadKick: 12,
  ChestKick: 9,
  RightKneeReception: 10,
  LeftKneeReception: 10,
  InnerRightFootReception: 9,
  InnerLeftFootReception: 9,
};
export const KICK_SPEED_CAP_DEFAULT = 10;

// Per-clip arc multiplier on a kick's flight time: >1 floats a slow lob over
// the net, <1 drills the ball flat (flat kicks also skim the net closer).
// Combines with KICK_POWER: loft shapes the arc, power scales the speed.
// Clips not listed use 1.
export const KICK_LOFT: Record<string, number> = {
  RightFootKick: 0.85,
  LeftFootKick: 0.85,
  ChestKick: 1.25,
  RightKneeReception: 1.45,
  LeftKneeReception: 1.45,
  InnerRightFootReception: 1.55,
  InnerLeftFootReception: 1.55,
};

export function contactFraction(name: string): number {
  const c = CLIPS[name];
  if (!c || c.contact < 0) return 0;
  return c.contact / c.frames;
}

export function tossFraction(name: string): number {
  const c = CLIPS[name];
  if (!c || c.toss === undefined) return 0;
  return c.toss / c.frames;
}

/**
 * Start fraction so the clip's contact frame lands `leadSec` seconds after the
 * clip starts when played at `speed` (clips run at 60 fps). This makes the
 * visual contact happen a fixed, short time after the button press for every
 * clip, and the ball is launched at that same moment.
 */
export function windupStartFraction(name: string, speed: number, leadSec: number): number {
  const c = CLIPS[name];
  if (!c || c.contact < 0) return 0;
  const leadFrames = leadSec * 60 * speed;
  return Math.max(0, (c.contact - leadFrames) / c.frames);
}

/** Seconds from a clip start fraction to its contact frame at `speed`. */
export function contactDelaySeconds(name: string, speed: number, startFrac: number): number {
  const c = CLIPS[name];
  if (!c || c.contact < 0) return 0;
  return Math.max(0, ((c.contact / c.frames - startFrac) * c.frames) / (60 * speed));
}

export type Foot = "left" | "right";

export interface CharacterDef {
  id: string;
  label: string;
  height: number; // metres (before CHARACTER_SCALE)
  /** Dominant foot; "both" = two-footed (no weak-foot penalty, no strong-foot bonus). */
  strongFoot: Foot | "both";
  /** Court movement speed in m/s (4.5 was the old global for everyone). */
  speed: number;
  /** Multiplier on every kick/serve ball speed (stacks with KICK_POWER and the foot factor). */
  power: number;
  /** Aim precision: >1 tightens the random spray, <1 widens it. */
  precision: number;
  /** Backflip finishes: none, strong foot only, or both feet (weak-foot flips still hit softer). */
  backflips: "none" | "strong" | "both";
}

// Per-player identities:
// BRAZIL — the acrobat: quick, precise, flips off either foot (weak-foot flips hit softer).
// ENGLAND — the powerhouse: tall, slower, no flips, but a hammer of a right foot.
// FRANCE — the lefty all-rounder: flips off the strong (left) foot only.
// SPAIN — the technician: two-footed and the most precise, softest ball, strong-foot-rule
//         flips (two-footed, so either foot qualifies).
export const CHARACTERS: CharacterDef[] = [
  { id: "BrazilianPlayer", label: "BRAZIL", height: 1.76, strongFoot: "right", speed: 4.9, power: 1.0, precision: 1.1, backflips: "both" },
  { id: "EnglishPlayer", label: "ENGLAND", height: 1.86, strongFoot: "right", speed: 4.1, power: 1.7, precision: 0.9, backflips: "none" },
  { id: "FrenchPlayer", label: "FRANCE", height: 1.8, strongFoot: "left", speed: 4.5, power: 1.05, precision: 1.0, backflips: "strong" },
  { id: "SpanishPlayer", label: "SPAIN", height: 1.72, strongFoot: "both", speed: 4.4, power: 0.95, precision: 1.2, backflips: "strong" },
];

// Strong/weak-foot modifiers, applied to any clip that uses a specific foot
// (foot kicks, inner-foot lobs, backflips, foot serves). Two-footed players
// and non-foot clips (head/chest/knee) use 1/1.
export const FOOT_FACTOR = {
  strong: { power: 1.12, spray: 0.6 },
  weak: { power: 0.85, spray: 1.7 },
};

export const BALLS = [
  { id: "WhiteBall", label: "WHITE" },
  { id: "RedBall", label: "RED" },
  { id: "BlueBall", label: "BLUE" },
  { id: "GreenBall", label: "GREEN" },
  { id: "OrangeBall", label: "ORANGE" },
  { id: "BlueAndBlackBall", label: "BLUE & BLACK" },
  { id: "BlueAndRoseBall", label: "BLUE & ROSE" },
  { id: "OrangeAndBlackBall", label: "ORANGE & BLACK" },
];
