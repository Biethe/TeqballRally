// Dimensions from the FITEQ rulebook (metres). The playing surface is curved:
// 0.76 m high at the net, 0.565 m at the table ends, modelled as y = hCenter - k*x^2.
// Everything here is the rulebook's geometry scaled up by a tenth. The court
// is played on a phone held at arm's length: at true scale the table, the ball
// and the players all read as miniatures in the middle of a large arena, and
// the sport is more legible slightly oversized than it is exactly right.
// Scale the ball and the characters with it — the three only look right in
// proportion to each other.
export const TABLE_SCALE = 1.25;
export const TABLE = {
  length: 3.0 * TABLE_SCALE,
  width: 1.5 * TABLE_SCALE,
  halfLen: 1.5 * TABLE_SCALE,
  halfWid: 0.75 * TABLE_SCALE,
  hCenter: 0.76 * TABLE_SCALE,
  hEnd: 0.565 * TABLE_SCALE,
  curveK: (0.76 - 0.565) / (1.5 * 1.5 * TABLE_SCALE),
  netTop: 0.9 * TABLE_SCALE,
  netHalfWidth: 0.85 * TABLE_SCALE,
};

/**
 * The rectangle a kick can reach, and never leave.
 *
 * A kick has to be able to miss, but a miss is a ball that lands just past the
 * line — not one that ends up in the crowd. Every aim and every landing is
 * clamped to this box, so the spread costs the point without the ball leaving
 * the picture.
 *
 * The margin is deliberately narrow: a hand's width of grass around the table,
 * not a run-off area. A ball that lands there has clearly missed and just as
 * clearly nearly went in, which is the only kind of miss worth watching.
 */
export const PLAY_BOX = {
  halfLen: TABLE.halfLen + 0.3,
  halfWid: TABLE.halfWid + 0.32,
};

export const BALL_RADIUS = 0.08095 * TABLE_SCALE; // size 5 football, oversized with the table
export const GRAVITY = 9.81;

// How far the players may travel. These are gameplay, not decoration: they are
// identical in every venue, so two peers looking at different backdrops still
// run the same simulation. What the court *looks* like — its size, shape,
// colours and boards — is a venue preset in `venue.ts`.
// The far limits are the arena's floor, which is a fixed model and does not
// scale with the table; the near limit is the table end and must.
export const COURT = {
  // Players may come right up to the middle line. They used to be held behind
  // the table *end*, nearly two metres off the net, which made the whole front
  // of the court unreachable and the hardest shots — the ones taken close in —
  // impossible to play. What they cannot do is stand on the table; that is
  // `clearTable` below, and it is a hole in the middle of the half rather than
  // a wall across it.
  minX: 0.06,
  maxX: 6.8,
  maxZ: 4.6,
};

/**
 * How much room a standing player keeps around the table.
 *
 * Roughly half a shoulder width. It is what stops a player's root ending up
 * inside the table model while they walk past it, and it is deliberately small
 * — being able to play from right beside the table is the point of opening the
 * half up at all.
 */
export const TABLE_CLEARANCE = 0.28;

/**
 * Where the portrait camera should sit laterally to keep the player in shot.
 *
 * Pure, and the whole of the follow: it answers "how far sideways does the
 * camera have to be" and nothing else, so it can be reasoned about without a
 * scene. Zero means centred, which is where it stays while the player is
 * comfortably inside the frame.
 *
 * The shot is a triangle from the camera, so how much room a player has
 * depends on how far down the court they are: deep in their own half they are
 * close to the lens and only about a metre from either edge. That is why a
 * fixed camera loses them there and nowhere else.
 */
export function portraitCameraShot(
  playerX: number,
  playerZ: number,
  baseCameraX: number,
  fov: number = CAMERA.portrait.fov,
  safe: number = CAMERA.portrait.safe
): { x: number; z: number } {
  const spread = Math.tan(fov / 2);
  const restDistance = Math.abs(playerX - baseCameraX);

  // The still shot, while it holds everything. A camera that reacts to every
  // step slides the world under a figure that never moves, which is both
  // harder to read and worse to look at.
  //
  // Both conditions matter, and the second is easy to forget: a player standing
  // dead centre can still be close enough to the lens that the *table* no
  // longer fits, because the frame narrows towards the near end.
  const restHalfWidth = restDistance * spread;
  if (
    Math.abs(playerZ) <= restHalfWidth * safe &&
    restHalfWidth >= TABLE.halfWid + CAMERA.portrait.margin
  ) {
    return { x: baseCameraX, z: 0 };
  }

  // Otherwise: frame the table and the player *together*, and take whatever
  // distance that needs. Panning alone cannot do it — deep in the half the
  // whole shot is barely three metres across, so sliding sideways to catch a
  // wide player pushes the court out the other edge. The only thing that makes
  // room for two objects is backing away from both.
  const lo = Math.min(-TABLE.halfWid, playerZ);
  const hi = Math.max(TABLE.halfWid, playerZ);
  const z = (lo + hi) / 2;
  const need = (hi - lo) / 2 + CAMERA.portrait.margin;
  const distance = Math.max(restDistance, need / (spread * safe));
  // The camera lives behind the player's own baseline, which is the negative
  // end of the axis, so further back is always further negative — and never
  // nearer than where it rests, or walking forward would shove the lens into
  // the court.
  return { x: Math.min(baseCameraX, playerX - distance), z };
}

/** True when a player standing here would be inside the table. */
export function onTableFootprint(x: number, z: number): boolean {
  return (
    Math.abs(x) < TABLE.halfLen + TABLE_CLEARANCE &&
    Math.abs(z) < TABLE.halfWid + TABLE_CLEARANCE
  );
}

/**
 * Push a standing position out of the table, by the shortest way out.
 *
 * Sideways when they are alongside it, backwards when they are at the end —
 * which is what walking into a table actually does to you, and which keeps a
 * player who is running down the side of the table running down the side of
 * it rather than being flung behind the baseline.
 */
export function clearTable(x: number, z: number): { x: number; z: number } {
  if (!onTableFootprint(x, z)) return { x, z };
  const outZ = TABLE.halfWid + TABLE_CLEARANCE;
  const outX = TABLE.halfLen + TABLE_CLEARANCE;
  const pushZ = outZ - Math.abs(z);
  const pushX = outX - Math.abs(x);
  // A player exactly on the centre line has no side to be pushed to, so the
  // tie goes backwards rather than picking one arbitrarily.
  if (pushZ < pushX && z !== 0) return { x, z: Math.sign(z) * outZ };
  return { x: (x === 0 ? 1 : Math.sign(x)) * outX, z };
}

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
  x: 2.64 * TABLE_SCALE, // distance from the net along the table axis
  z: 0, // lateral offset (+z = controlled player's left)
  lift: 0, // extra y lift if a model's feet still sink into the floor
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
export const CHARACTER_SCALE = 0.8 * TABLE_SCALE;

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
// The play cameras are deliberately tight. A wide shot of a teqball court is
// mostly empty floor and stands: the sport happens inside a six-metre box, and
// everything the player has to read — where the ball is, how high, whose touch
// it is — is carried by figures that have to be big enough to read them on a
// phone. Pull back and the game becomes two dots and a table.
export const CAMERA = {
  back: 7.4, // distance behind the serve spot along the table axis (m)
  height: 5.1, // height above the ground (m)
  // Height above the ground the camera looks at (table centre). Lower = the
  // camera tilts further down; the old follow-camera aimed at ~0.9.
  lookY: 0.55,
  /** Landscape lens, pinned vertically. Shared by the scene's default camera. */
  fov: 0.72,
  // Portrait is a tall, narrow window on the same court. The lens is pinned
  // horizontally there (see scene.ts), which makes the vertical angle very
  // wide — from the landscape distance the players end up specks in a frame
  // mostly full of roof. So portrait comes in closer and tilts up a little.
  // Portrait's lens cannot be tightened as far as landscape's looks like it
  // should allow. Pinned horizontally, the fov *is* the width of what can be
  // seen, and the narrowest part of the shot is right where the player stands:
  // squeeze it and a player chasing a wide ball walks out of their own frame.
  portrait: {
    back: 5.0,
    height: 3.9,
    lookY: 0.95,
    fov: 0.88,
    /**
     * How much of the visible half-width the player may use before the camera
     * starts to follow them.
     *
     * A deadzone, not a lock: inside this band the shot is still, and the
     * camera slides only as far as it must to bring them back inside it. A
     * camera welded to the player makes the world slide under a figure that
     * never moves, which is both harder to read and worse to look at.
     *
     * It has to exist at all because the shot narrows towards the near end.
     * The lens is pinned horizontally, so the visible width is proportional to
     * the distance from the camera — and a player at the back of their half is
     * only about a metre from either edge of frame. Now that the half runs all
     * the way to the middle line, they cover far more of it than they used to.
     */
    safe: 0.55,
    /** Seconds for the follow to catch up. Long enough to read as camera work. */
    tau: 0.22,
    /**
     * Room kept beside the table when the camera pulls back.
     *
     * The camera dollies out as the player comes towards it so the frame never
     * gets narrower than the court; this is how much more than the bare table
     * width it holds, so the sidelines are not flush against the edge.
     */
    margin: 0.7,
  },
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

/**
 * Fixed simulation rate. The match advances in whole SIM_DT slices regardless
 * of display refresh, so every device computes the same rally from the same
 * inputs — the precondition for two of them agreeing over a network. Ticks are
 * counted in these slices and are the shared unit of time between peers.
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export const SERVE_X = 3.64 * TABLE_SCALE; // service line, set back from the table end
export const MAX_TOUCHES = 3; // touches allowed per possession (reception, prep, kick)
// Reach scales with the players, who scale with the table.
export const PLAYER_REACH = 1.2 * TABLE_SCALE;
export const AI_REACH = 1.2 * TABLE_SCALE;
/**
 * Points to win a set, and sets to win the match.
 *
 * Short on purpose. A rally here is a handful of touches and a phone match has
 * to fit in the gap it is being played in — a queue, a train, an advert break.
 * First to three makes every point a point that matters, and best of three
 * sets keeps the shape of a real match around it: you can lose a set and still
 * win, which is the thing that makes the second one worth playing.
 */
export const WIN_SCORE = 3;
export const SETS_TO_WIN = 2;
/** Points between serve changes. */
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

/**
 * Global tempo of the ball. One knob, applied to every launch.
 *
 * Here rather than spread across the per-clip tables because "the game feels a
 * bit slow" is a judgement about the whole thing, and answering it by nudging
 * fifteen clip constants is how the clips stop agreeing with each other. Raise
 * it to quicken everything and keep their relative pace intact.
 */
export const BALL_PACE = 1.12;

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
  /**
   * Court movement speed in m/s. Above the original 4.1-4.9 spread — shifting
   * position was the heavy part of a rally, and it happens before every touch
   * — but backed off from the first attempt at it, which overshot into
   * skating. The spread between characters is kept: it is most of what makes
   * them feel different.
   */
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
  { id: "BrazilianPlayer", label: "BRAZIL", height: 1.76, strongFoot: "right", speed: 5.4, power: 1.0, precision: 1.1, backflips: "both" },
  { id: "EnglishPlayer", label: "ENGLAND", height: 1.86, strongFoot: "right", speed: 4.5, power: 1.7, precision: 0.9, backflips: "none" },
  { id: "FrenchPlayer", label: "FRANCE", height: 1.8, strongFoot: "left", speed: 5.0, power: 1.05, precision: 1.0, backflips: "strong" },
  { id: "SpanishPlayer", label: "SPAIN", height: 1.72, strongFoot: "both", speed: 4.9, power: 0.95, precision: 1.2, backflips: "strong" },
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
