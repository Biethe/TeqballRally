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
  safe: number = CAMERA.portrait.safe,
  pan: number = CAMERA.portrait.pan,
  height: number = CAMERA.portrait.height
): { x: number; z: number } {
  const spread = Math.tan(fov / 2);

  // The camera does not move along the court axis, ever. Its position was
  // solved for the worst case the court allows, so there is nothing left for a
  // dolly to fix — and everything behind this line is scenery, which is what
  // the old backwards travel kept finding.
  const x = baseCameraX;

  // A deadzone, not a lock. Inside this band the shot is still: a camera welded
  // to the player slides the world under a figure that never moves, which is
  // both harder to read and worse to look at. The band is a fraction of the
  // frame at the player's own depth, so it narrows as they come towards the
  // lens — which is where they need the camera to react soonest.
  //
  // Measured along the sight line rather than across the ground. The camera is
  // 6.6 m up; ignoring that would put the frame at a third of its real width
  // and pan for players who are comfortably inside it.
  const halfWidthAtPlayer = Math.hypot(playerX - baseCameraX, height) * spread;
  const inner = halfWidthAtPlayer * safe;
  const slide = Math.abs(playerZ) <= inner ? 0 : playerZ - Math.sign(playerZ) * inner;

  // Clamped to what the table can spare. Past this the court starts leaving the
  // frame on the opposite edge, which is the thing the whole solve exists to
  // prevent.
  return { x, z: Math.max(-pan, Math.min(pan, slide)) };
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

export type CameraMode = "court" | "side";

/**
 * Portrait framing, solved from the court rather than tuned by eye.
 *
 * The old portrait camera dollied backwards to fit a wide player and the table
 * into one shot. It worked, and it went a very long way to do it: a player at
 * the corner of their own half put the lens at x = -20.2, while the outdoor
 * venues are a 28.8 m site — ±14.4. The camera was outside the fence, filming
 * the court through it. That is the "objects behind the player" problem.
 *
 * Two things have to be true where the frame is narrowest, at the near
 * baseline:
 *
 *   the table stays in shot   →  pan + TABLE.halfWid <= halfWidth
 *   the player stays in shot  →  COURT.maxZ - pan    <= halfWidth
 *
 * Eliminating `pan` gives halfWidth >= (COURT.maxZ + TABLE.halfWid) / 2, plus
 * a margin for headroom. What is left over after the table is how far the
 * camera may pan.
 *
 * The trap is *how* that half-width is bought. Buying it with distance needs
 * 6.9 m behind the baseline, and no venue has it — the sports hall's stands
 * start well inside that, and a camera solved that way ends up filming the
 * underside of the roof. So it is bought with **height** instead: the frame's
 * width at a point on the ground is set by how far the lens is from it, and a
 * raised camera is further away than its ground distance suggests. Standing
 * 2.2 m back and 6.6 m up is 7.0 m from the near baseline — the same shot, from
 * inside the building, looking over the goals and backboards that a low camera
 * this far out would have been staring straight into.
 */
/** The side view's lens, and the shot solved for it. */
const SIDE_FOV = 1.0;
/** Half the court's length, plus room so the baselines are not flush. */
const SIDE_HALF_WIDTH = COURT.maxX + 0.6;
const SIDE_SLANT = SIDE_HALF_WIDTH / Math.tan(SIDE_FOV / 2);
/**
 * How far the side camera is tilted down, in radians.
 *
 * About 50 degrees: high, looking down the court. The first attempt was half
 * that, on the theory that a side view exists to show the ball's height above
 * the table — but from nearly level the two players overlap the table and each
 * other, and what the shot gains in height it loses in being able to tell
 * where anybody is. The lens distance is unchanged, so raising the pitch
 * raises the camera rather than pulling it back.
 */
const SIDE_PITCH = 0.87;

const PORTRAIT_FOV = 0.88;
/** Headroom beyond the bare "table and player both fit" solution. */
const PORTRAIT_MARGIN = 0.5;
const PORTRAIT_SPREAD = Math.tan(PORTRAIT_FOV / 2);
/** Half-width the frame must hold at the near baseline. */
const PORTRAIT_HALF_WIDTH = (COURT.maxZ + TABLE.halfWid) / 2 + PORTRAIT_MARGIN;
/**
 * How far behind the deepest a player may stand the lens sits.
 *
 * Small on purpose. This is the only part of the shot that eats into the
 * venue, and every venue puts something solid — stands, a goal, a hoop —
 * a few metres past the end of the play area.
 */
const PORTRAIT_STANDOFF = 2.2;
/** Lens-to-near-baseline distance the framing needs, along the sight line. */
const PORTRAIT_SLANT = PORTRAIT_HALF_WIDTH / PORTRAIT_SPREAD;
/** Whatever height is left to make up, once the standoff has been spent. */
const PORTRAIT_HEIGHT = Math.sqrt(
  Math.max(0, PORTRAIT_SLANT * PORTRAIT_SLANT - PORTRAIT_STANDOFF * PORTRAIT_STANDOFF)
);

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
    // Solved above, expressed the way this table expresses everything else —
    // as a distance behind the serve spot — so the one call site does not have
    // to know which baseline the solve was measured from.
    back: COURT.maxX + PORTRAIT_STANDOFF - SPAWN.x,
    height: PORTRAIT_HEIGHT,
    lookY: 0.95,
    fov: PORTRAIT_FOV,
    /** How far the camera may pan before the table leaves the frame. */
    pan: PORTRAIT_HALF_WIDTH - TABLE.halfWid,
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
    /** Headroom in the solved framing, beside the table. */
    margin: PORTRAIT_MARGIN,
  },
  /**
   * The shot held on whoever just won the game.
   *
   * A match ends with one player celebrating and the other playing Defeat, and
   * the locked-off court camera is too far away for either to read as anything
   * but a small figure. Coming in on the winner is what the moment is for.
   *
   * The camera sits in front of them — between them and the net, since that is
   * the side they are facing — and slightly off-axis, because a dead-centre
   * front-on shot of a rig is the one angle that looks like a character
   * selection screen rather than a celebration.
   */
  victory: {
    /** Metres in front of the winner, along the way they face. */
    distance: 3.4,
    /** Metres to their side, so the shot is not dead-on. */
    offset: 1.5,
    height: 1.9,
    /** Height on the winner the camera looks at: chest, not feet. */
    lookY: 1.25,
    fov: 0.95,
    /**
     * Seconds for the move in. Slow enough to read as a deliberate push rather
     * than a cut, short enough to arrive while the celebration is still going.
     */
    tau: 0.55,
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
  // Solved from the court, like the portrait shot, and for the same reason:
  // the old numbers put the lens 9.1 m from the middle of an 18 m court, so a
  // half-frame held 5.0 m of a half-court that is 6.8 m long and both ends
  // were simply outside the picture.
  //
  // Side-on, the court's *length* runs across the screen, which on a phone
  // held upright is its narrow dimension — so this view needs more distance
  // than the one behind the baseline, not less.
  side: {
    distance: SIDE_SLANT * Math.cos(SIDE_PITCH),
    height: SIDE_SLANT * Math.sin(SIDE_PITCH),
    lookY: 0.3,
    fov: SIDE_FOV,
    minZ: 0.1,
    /**
     * Near plane inside a closed venue, in metres.
     *
     * Far enough to clip the hall's near wall and the stands in front of it,
     * so a camera solved from the court can stand where the court needs it and
     * still see in. Comfortably short of the table.
     */
    indoorMinZ: 7.5,
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
  // See the note at the top of Animation.txt: locomotion uses the InPlace
  // strafes because movement is integrated from velocity, and a clip that
  // travels as well would move the character twice.
  JogStrafeLeftInPlace: { contact: -1, frames: 30 },
  JogStrafeRightInPlace: { contact: -1, frames: 34 },
  WalkStrafeLeftInPlace: { contact: -1, frames: 56 },
  WalkStrafeRightInPlace: { contact: -1, frames: 58 },
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
export const BALL_PACE = 1.26;

/**
 * How much the players' kit is lifted above the source models. See
 * `brightenKit` in `scene.ts` for what each one does.
 *
 * Small numbers on purpose: this is the difference between a kit that reads on
 * a phone in daylight and one that looks like safety wear.
 */
/**
 * The ripple that acknowledges a tap.
 *
 * Portrait is played entirely by tapping the ground, and a press that shows
 * nothing reads as a press that was missed — which is exactly why the same tap
 * gets made twice. Short-lived: this is a receipt, not decoration.
 */
export const TAP_PING = {
  /** Seconds from finger down to gone. */
  life: 0.42,
  from: 0.55,
  to: 1.5,
  alpha: 0.75,
};

export const KIT = {
  /** Albedo multiplier. Brightens without shifting hue. */
  lift: 1.16,
  /** Dim self-illumination from the kit's own texture, so shadow keeps colour. */
  glow: 0.11,
  /** Roughness taken off, for the sheen a real shirt has. */
  sheen: 0.12,
  minRoughness: 0.28,
};

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

/**
 * Frames at the head of a clip that must never play.
 *
 * ServeRightFoot's first 25 frames contain movement that reads as a twitch
 * before the serve begins. Skipping them is preferable to re-cutting the clip:
 * the toss (frame 44) and the contact (92) both sit well after the skip, so
 * every fraction derived from the full clip stays correct and the ball is
 * still launched on the frame the foot meets it.
 *
 * 20 left some of the twitch in view; 25 is where the clip settles.
 */
export const CLIP_SKIP_FRAMES: Record<string, number> = {
  ServeRightFoot: 25,
};

/** The earliest fraction of `name` that is safe to start playing from. */
export function clipStartFraction(name: string): number {
  const skip = CLIP_SKIP_FRAMES[name];
  const info = CLIPS[name];
  if (!skip || !info) return 0;
  return skip / info.frames;
}

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
   * How good the other foot is, 0-100.
   *
   * Decides what a player does with a ball arriving on their weaker side. At
   * 100 they simply kick it; at 0 they never trust it and head everything they
   * can reach. In between it is the odds: 70 means the foot is used seven
   * times in ten and the header is the other three.
   *
   * Two-footed players are 100 by definition, and it is set that way rather
   * than special-cased so nothing downstream has to ask which kind of player
   * this is.
   */
  weakFoot: number;
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
  /**
   * How long they keep their legs, 0.6–1.4.
   *
   * Long rallies drain a reserve; what it costs is *recovery*, not reach — a
   * tired player accelerates and turns more slowly, but never becomes unable
   * to get to a ball they were standing next to. That distinction matters more
   * since attacking means coming forward to the middle line and getting back
   * again: a stamina model that took away reach would turn one aggressive
   * point into a lost game.
   */
  stamina: number;
  /**
   * The serve, 0.6–1.4. Scales the pace of the opening ball and tightens how
   * near the line it can be aimed.
   */
  serve: number;
  /**
   * Acceleration and lunge, 0.6–1.4.
   *
   * Distinct from `speed`, which is a top speed. Agility is how fast that
   * speed arrives and how far a player can stretch for a ball at the edge of
   * reach — the trait that decides short, sharp exchanges rather than long
   * chases.
   */
  agility: number;
  /**
   * Taking the ball early, 0.6–1.4.
   *
   * Widens the window in which a ball can be struck before it drops, which is
   * what makes a player able to attack a high ball instead of waiting for it.
   */
  volley: number;
}

// Per-player identities:
// BRAZIL — the acrobat: quick, precise, flips off either foot (weak-foot flips hit softer).
// ENGLAND — the powerhouse: tall, slower, no flips, but a hammer of a right foot.
// FRANCE — the lefty all-rounder: flips off the strong (left) foot only.
// SPAIN — the technician: two-footed and the most precise, softest ball, strong-foot-rule
//         flips (two-footed, so either foot qualifies).
// Every character is above average at something and below at something else:
// the four new traits are what stop the roster being one axis of "better".
export const CHARACTERS: CharacterDef[] = [
  // The acrobat. Quick and springy, and runs out of legs first.
  { id: "BrazilianPlayer", label: "BRAZIL", height: 1.76, strongFoot: "right", speed: 5.4, power: 1.0, precision: 1.1, backflips: "both",
    stamina: 0.85, serve: 0.95, agility: 1.35, volley: 1.2, weakFoot: 82 },
  // The powerhouse. A hammer and a serve, slow to get going, lasts all day.
  // A hammer of a right foot and very little on the left, so the header is his
  // answer to anything arriving on that side.
  { id: "EnglishPlayer", label: "ENGLAND", height: 1.86, strongFoot: "right", speed: 4.5, power: 1.7, precision: 0.9, backflips: "none",
    stamina: 1.3, serve: 1.35, agility: 0.7, volley: 0.85, weakFoot: 45 },
  // The all-rounder. Nothing to hide behind and nothing that lets him down.
  { id: "FrenchPlayer", label: "FRANCE", height: 1.8, strongFoot: "left", speed: 5.0, power: 1.05, precision: 1.0, backflips: "strong",
    stamina: 1.05, serve: 1.05, agility: 1.0, volley: 1.0, weakFoot: 70 },
  // The technician. Takes everything early and precisely, hits it softest.
  // Two-footed: there is no weak side to exploit, so nothing forces a header.
  { id: "SpanishPlayer", label: "SPAIN", height: 1.72, strongFoot: "both", speed: 4.9, power: 0.95, precision: 1.2, backflips: "strong",
    stamina: 1.0, serve: 0.8, agility: 1.05, volley: 1.35, weakFoot: 100 },
];

// Strong/weak-foot modifiers, applied to any clip that uses a specific foot
// (foot kicks, inner-foot lobs, backflips, foot serves). Two-footed players
// and non-foot clips (head/chest/knee) use 1/1.
export const FOOT_FACTOR = {
  strong: { power: 1.12, spray: 0.6 },
  weak: { power: 0.85, spray: 1.7 },
};

/**
 * The balls, and why there are four rather than eight.
 *
 * Every ball model in this project came from the same Nike Pitch export, and
 * four of the eight carried the mark plainly enough to read on a phone: a
 * swoosh on WHITE, GREEN and ORANGE, and "TEAM" lettering on BLUE & BLACK.
 * Those are gone — from this list *and* from `assets/`, because `publicDir` is
 * the whole asset folder, so a model that is merely unreferenced still ships
 * inside the APK.
 *
 * The four that remain render without a visible mark. That is not the same as
 * being original artwork: their source is still that export, and the node names
 * in the files still say `Nike_Pitch_*`. Commissioning or generating clean
 * models is the only thing that actually settles it.
 */
export interface BallDef {
  id: string;
  label: string;
  /**
   * Multipliers on the player's own traits. 1, or absent, leaves one alone.
   *
   * Every ball that gives something takes something back. A ball that were
   * only better would make the choice a formality and the other three
   * decoration, which is the failure mode of every "equipment" system that
   * stops being interesting the day you own the best item.
   */
  mods: Partial<Record<"power" | "precision" | "speed" | "serve" | "volley", number>>;
  /** Best-ever trophies needed to play with it. 0 is owned from the start. */
  unlockAt: number;
}

export const BALLS: BallDef[] = [
  // The honest one: no help and no trade. Owned from the start, and the
  // reference every other ball is read against.
  { id: "RedBall", label: "THE CLASSIC", mods: {}, unlockAt: 0 },
  // Control at the cost of pace.
  { id: "BlueBall", label: "THE SURGEON", mods: { precision: 1.08, power: 0.96 }, unlockAt: 40 },
  // Light and lively: takes the ball early and serves well, less settled.
  {
    id: "BlueAndRoseBall",
    label: "THE FEATHER",
    mods: { volley: 1.1, serve: 1.06, precision: 0.96 },
    unlockAt: 120,
  },
  // The hammer. Everything a hard hitter wants and nothing a placer does.
  {
    id: "OrangeAndBlackBall",
    label: "THE HAMMER",
    mods: { power: 1.1, precision: 0.94 },
    unlockAt: 220,
  },
];

/**
 * Which ball each player gets more out of than anybody else does.
 *
 * The reason to own more than one: the same ball is not the best ball for
 * everybody, so a roster and a ball cupboard are worth more together than
 * either is alone.
 */
export const BALL_AFFINITY: Record<string, string> = {
  BrazilianPlayer: "BlueAndRoseBall",
  EnglishPlayer: "OrangeAndBlackBall",
  FrenchPlayer: "RedBall",
  SpanishPlayer: "BlueBall",
};

/** How much more a player gets from a ball that suits them. */
export const AFFINITY_BONUS = 1.5;

/**
 * The player, holding this ball.
 *
 * Shaped like `withCareer`: traits in, traits out, so everything downstream —
 * the physics, the ratings on the card, the AI — reads one already-modified
 * `CharacterDef` and never has to know a ball was involved.
 */
export function withBall(def: CharacterDef, ball: BallDef): CharacterDef {
  const suits = BALL_AFFINITY[def.id] === ball.id;
  // Only the upside is amplified. A ball somebody suits should not also punish
  // them harder for its trade-off — that would make affinity a mixed blessing
  // and the whole system something to be read twice rather than felt.
  const scale = (m: number | undefined): number =>
    m === undefined ? 1 : m > 1 && suits ? 1 + (m - 1) * AFFINITY_BONUS : m;
  return {
    ...def,
    power: def.power * scale(ball.mods.power),
    precision: def.precision * scale(ball.mods.precision),
    speed: def.speed * scale(ball.mods.speed),
    serve: def.serve * scale(ball.mods.serve),
    volley: def.volley * scale(ball.mods.volley),
  };
}

/** The ball with this id, or the free default when the id is unknown. */
export function ballFor(id: string): BallDef {
  return BALLS.find((b) => b.id === id) ?? BALLS[0];
}
