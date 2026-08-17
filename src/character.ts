import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Scene } from "@babylonjs/core/scene";
import {
  clearTable,
  clipStartFraction,
  contactFraction,
  CHARACTER_SCALE,
  COURT,
  FOOT_FACTOR,
  RECEPTION_ZONE,
  type BodyPart,
  type CharacterDef,
  type Foot,
} from "./config";
import { brightenKit, fixMetallicMaterials } from "./scene";
import { importModel } from "./protected";

/**
 * The clips locomotion blends between.
 *
 * The sideways ones are the InPlace variants: movement is integrated from
 * velocity, so a clip that travels as well would move the character twice and
 * drift the rig off where the game thinks it is. See Animation.txt.
 */
const LOCO_CLIPS = [
  "Idle",
  "JogForward",
  "jogBackward",
  "WalkStrafeLeftInPlace",
  "WalkStrafeRightInPlace",
  "JogStrafeLeftInPlace",
  "JogStrafeRightInPlace",
] as const;
/** Ground speed the jog clips look natural at; playback scales around it. */
const LOCO_SPEED = 4.5 * CHARACTER_SCALE;

/**
 * How much ground a sideways cycle covers next to a forward one, as a fraction.
 *
 * A strafe is a shuffle: the feet cross less distance per cycle than a run
 * does. Driving both off the same reference speed therefore under-cranks the
 * strafe clips — the body slides out from under feet that are still shuffling.
 * The walk is slower again, which is the whole reason it exists as its own
 * clip. Both are calibrated by eye against a real browser: lower them if
 * sideways movement still skates, raise them if the feet run on the spot.
 */
const STRAFE_STRIDE_RATIO = 0.62;
const WALK_STRIDE_RATIO = 0.3;

/**
 * The speed band the sideways movement changes gait over.
 *
 * Below the first it is a walking adjustment — the half-step you take for a
 * ball that is nearly on you. Above the second it is a proper sideways run for
 * one that is not. In between both clips carry weight, so the change of gait
 * is something the legs do rather than something that snaps.
 */
const STRAFE_WALK_SPEED = 1.1;
const STRAFE_JOG_SPEED = 2.6;

/** Below this the character is standing; above JOG_SPEED the jog carries full weight. */
const IDLE_SPEED = 0.4;
const JOG_SPEED = 1.35;

/**
 * Playback rate bounds for the jog clips. The floor exists so a crawl does not
 * turn into slow motion, but it is deliberately below 1: anything higher makes
 * the feet cycle faster than the body travels, which is its own kind of slide.
 */
const STRIDE_MIN = 0.55;
const STRIDE_MAX = 1.6;

export type LocoClip = (typeof LOCO_CLIPS)[number];
export type LocoWeights = Record<LocoClip, number>;

/** A callback fired once the clip reaches a given fraction of its length. */
interface FracCallback {
  frac: number;
  fn: () => void;
}

/**
 * Goal weights for the locomotion clips, from a run velocity already expressed
 * in the character's own frame (`fwd` along its facing, `lat` to its right).
 *
 * Pure and exported for the same reason `approachVelocity` is: this is the
 * whole read of how a player moves, and it deserves to be testable without a
 * scene behind it.
 *
 * Every jog clip can carry weight at once. Choosing a single winner is what
 * made a diagonal run — by far the commonest way anyone moves here, since you
 * are always cutting across to meet the ball — play a pure forward cycle while
 * the body travelled sideways. Feet pushing one way while the body goes
 * another is exactly what reads as sliding.
 */
export function locoBlend(fwd: number, lat: number, speed: number): LocoWeights {
  const w: LocoWeights = {
    Idle: 0,
    JogForward: 0,
    jogBackward: 0,
    WalkStrafeLeftInPlace: 0,
    WalkStrafeRightInPlace: 0,
    JogStrafeLeftInPlace: 0,
    JogStrafeRightInPlace: 0,
  };
  // Cross-fade out of standing across a band rather than switching at a single
  // threshold: a small adjusting step used to snap a full-weight jog on and
  // straight back off, which is the pop this band removes.
  const moving = Math.min(1, Math.max(0, (speed - IDLE_SPEED) / (JOG_SPEED - IDLE_SPEED)));
  const ax = Math.abs(fwd);
  const az = Math.abs(lat);
  const sum = ax + az;
  if (moving <= 0 || sum <= 1e-6) {
    w.Idle = 1;
    return w;
  }
  w.Idle = 1 - moving;
  // Split on the L1 norm, not the Euclidean one, so the jog weights always add
  // up to `moving`. Splitting by length would give a 45° run about 1.41x the
  // total animation weight of a straight one, and it would visibly bloom.
  const f = (ax / sum) * moving;
  const s = (az / sum) * moving;
  if (fwd >= 0) w.JogForward = f;
  else w.jogBackward = f;
  // Sideways splits again by gait. A ball nearly on you is a walking half-step
  // sideways; one you have to cover ground for is a run. Speed is what tells
  // them apart, and blending across the band means the legs change gait rather
  // than the clip switching under them.
  const jogShare = Math.min(
    1,
    Math.max(0, (speed - STRAFE_WALK_SPEED) / (STRAFE_JOG_SPEED - STRAFE_WALK_SPEED))
  );
  if (lat >= 0) {
    w.JogStrafeRightInPlace = s * jogShare;
    w.WalkStrafeRightInPlace = s * (1 - jogShare);
  } else {
    w.JogStrafeLeftInPlace = s * jogShare;
    w.WalkStrafeLeftInPlace = s * (1 - jogShare);
  }
  return w;
}

/**
 * One playback rate for every blended clip, so their cycles stay in step with
 * each other — per-clip rates put the feet of two half-weight clips visibly out
 * of phase. The reference speed is weighted by the same forward/sideways split
 * as the blend, which is what stops a strafe being driven as though it covered
 * a full running stride.
 */
export function locoStride(weights: LocoWeights, speed: number): number {
  // Each gait covers a different amount of ground per cycle. Averaging their
  // authored speeds by the weights actually in play gives the speed this blend
  // was drawn for, and the rate is how far off it the body really is.
  const run = weights.JogForward + weights.jogBackward;
  const jogSide = weights.JogStrafeLeftInPlace + weights.JogStrafeRightInPlace;
  const walkSide = weights.WalkStrafeLeftInPlace + weights.WalkStrafeRightInPlace;
  const total = run + jogSide + walkSide;
  if (total <= 1e-6) return 1;
  const reference =
    (LOCO_SPEED * (run + jogSide * STRAFE_STRIDE_RATIO + walkSide * WALK_STRIDE_RATIO)) / total;
  return Math.min(STRIDE_MAX, Math.max(STRIDE_MIN, speed / reference));
}

/**
 * Time constant for the run's acceleration and braking, in seconds. Roughly
 * 95% of the requested speed inside 0.15 s: enough weight to see, short enough
 * that a shift still starts on the frame it was asked for.
 */
export const MOVE_TAU = 0.055;

/**
 * One step of a run's velocity toward the speed being asked for.
 *
 * Pure, and exported, because this is the whole feel of moving a player: it is
 * gameplay, not presentation, and the same function has to run identically on
 * both peers of a networked match.
 */
export function approachVelocity(
  current: number,
  desired: number,
  dt: number,
  tau: number = MOVE_TAU
): number {
  return current + (desired - current) * Math.min(1, dt / Math.max(1e-4, tau));
}

/**
 * Reshape a requested run so it cannot leave the ball behind.
 *
 * `toAnchorX/Z` is the offset from the player to the point where their next
 * contact is due; `mx/mz` is the direction they asked to run in. Inside
 * `RECEPTION_ZONE.radius` the answer is exactly what was asked for — the player
 * owns their feet, and the couple of metres around the contact point is where
 * every decision worth making about a touch is made. Outside it, only the
 * component heading *away* from the ball is damped, fading across the soft band
 * rather than stopping dead at its edge, and past the band a slow leash is
 * added toward the ball.
 *
 * Sideways movement is never touched. Circling the contact point to change
 * which side of the ball you meet it on is the adjustment the zone exists to
 * protect, not the one it exists to stop.
 *
 * Pure and exported for the same reason `approachVelocity` is: this decides how
 * a player is allowed to move, it has to behave identically on both peers of a
 * networked match, and it deserves to be held to that without a scene.
 */
export function nearAnchorPush(
  toAnchorX: number,
  toAnchorZ: number,
  mx: number,
  mz: number,
  speed: number
): [number, number] {
  const d = Math.hypot(toAnchorX, toAnchorZ);
  if (d <= RECEPTION_ZONE.radius || d < 1e-4) return [mx, mz];
  const ux = toAnchorX / d;
  const uz = toAnchorZ / d;
  const past = Math.min(1, (d - RECEPTION_ZONE.radius) / RECEPTION_ZONE.soft);
  // How hard the player is asking for something, measured before the damping
  // below — the damped push is the answer, not the question, and reading the
  // leash off it would let the zone lean on its own output and pull a player
  // back through a full-stick push.
  const asked = Math.min(1, Math.hypot(mx, mz));
  const par = mx * ux + mz * uz;
  if (par < 0) {
    const keep = 1 + (RECEPTION_ZONE.minPush - 1) * past;
    mx += ux * par * (keep - 1);
    mz += uz * par * (keep - 1);
  }
  // And a walk back, into the room the player is not using: it grows with how
  // far outside the zone they have drifted and fades out with how hard they
  // are pushing, whichever way they are pushing.
  //
  // Both halves matter. It can never out-pull the controls — a leash a player
  // cannot push against is a movement lock with extra steps, and at full stick
  // this one is not there at all — and it is what closes the gap between the
  // zone and the arm's length a reception is actually taken from: a player who
  // drifted out and let go ends up back in the play rather than watching it
  // land two paces away.
  const pull = (RECEPTION_ZONE.leash / Math.max(0.5, speed)) * past * (1 - asked);
  mx += ux * pull;
  mz += uz * pull;
  return [mx, mz];
}

/**
 * The least of their legs a player can be left with.
 *
 * Low enough that running out is a real state and not a nuisance: at the floor
 * a player is down to about a third of their pace and takes an age to reach
 * it, which is somebody who has emptied the tank rather than somebody mildly
 * inconvenienced. Not zero, because a character who cannot move at all is a
 * character standing still watching a ball go past, and that is a worse thing
 * to watch than a slow one chasing it.
 */
export const MIN_EFFORT = 0.16;

/**
 * The least of the *reserve* a match can grind a player down to.
 *
 * The reserve is the ceiling recovery works up to, and it only ever falls. A
 * player who has run a hard first set does not get a fresh pair of legs for
 * the second — they get whatever is left of the ones they started with, which
 * is the whole reason fitness, and everything sold for it, is worth having.
 */
export const MIN_RESERVE = 0.45;

/**
 * A loaded, rigged character: kinematic movement plus a two-layer animation
 * controller (cross-faded locomotion + one-shot actions with frame callbacks,
 * so serves can fire toss/contact events at the frames listed in Animation.txt).
 */
export class Character {
  root: TransformNode;
  groups = new Map<string, AnimationGroup>();
  meshes: AbstractMesh[] = [];
  /** +1: stands at x>0 facing -x (AI). -1: stands at x<0 facing +x (player). */
  faceDir: 1 | -1 = 1;
  height: number;
  /** The player's traits (strong foot, speed, power, precision, backflips). */
  def: CharacterDef;

  private currentLoco: LocoClip = "Idle";
  private locoWeights = new Map<LocoClip, number>();
  private action: AnimationGroup | null = null;
  private actionCallbacks: FracCallback[] = [];
  private actionOnEnd: (() => void) | null = null;
  /** Temporary yaw applied for the current action (e.g. backflips face away). */
  private actionYawOffset = 0;
  velocity = new Vector3();
  private animationsFrozen = false;

  /** Active contact lunge: glides the root while an action clip plays. */
  private lungeState: { from: Vector3; to: Vector3; dur: number; t: number } | null = null;

  /**
   * What is left in the legs right now, from 1 (fresh) down to `MIN_EFFORT`.
   *
   * Owned by the match, which drains and restores it — a character on the
   * selection carousel has no rally behind it and is always fresh.
   */
  effort = 1;

  /**
   * The most `effort` can recover to, from 1 down to `MIN_RESERVE`.
   *
   * A one-way ratchet: every metre run takes a little off it and nothing puts
   * it back inside a match. Standing still buys back some of what the last
   * rally cost, but never all of it, and never past this — so a match is a
   * slow slide rather than a sawtooth that resets between every point.
   */
  reserve = 1;

  private constructor(root: TransformNode, height: number, def: CharacterDef) {
    this.root = root;
    this.height = height;
    this.def = def;
  }

  static async load(scene: Scene, def: CharacterDef): Promise<Character> {
    const file = def.id;
    const h = def.height * CHARACTER_SCALE;
    const res = await importModel(scene, "/models/characters/", `${file}.glb`);
    // Two-level rig: the wrapper origin is the character's foot point (what the
    // game moves around), the inner node carries the scale + grounding offset.
    // Baking the offset into an inner node means position.set(...) on the
    // wrapper can never undo the grounding (feet used to sink because of this).
    const wrapper = new TransformNode(`${file}-wrapper`, scene);
    const inner = new TransformNode(`${file}-inner`, scene);
    inner.parent = wrapper;
    for (const m of res.meshes) {
      if (!m.parent) m.parent = inner;
    }
    // Normalise model height to the character's real-world height.
    const { min, max } = wrapper.getHierarchyBoundingVectors(true);
    const rawH = max.y - min.y;
    const s = rawH > 0.01 ? h / rawH : 1;
    inner.scaling.setAll(s);
    inner.position.y = -min.y * s;

    const char = new Character(wrapper, h, def);
    char.meshes = res.meshes;
    // Same exporter quirk as the balls: defaulted metallic renders the skin
    // textures nearly black without an environment map.
    fixMetallicMaterials(res.meshes);
    brightenKit(res.meshes);
    for (const g of res.animationGroups) {
      g.stop();
      char.groups.set(g.name.trim(), g);
    }
    // Sample each clip once at its contact frame to learn where the striking
    // limb will be — the ball is flown to exactly that point during a wind-up.
    char.measureContactOffsets();
    const idle = char.groups.get("Idle");
    if (idle) trimIdleTail(idle);
    // Locomotion clips all loop with blended weights.
    for (const name of LOCO_CLIPS) {
      const g = char.groups.get(name);
      if (g) {
        g.start(true, 1.0);
        g.setWeightForAllAnimatables(name === "Idle" ? 1 : 0);
      }
      char.locoWeights.set(name, name === "Idle" ? 1 : 0);
    }
    return char;
  }

  get position(): Vector3 {
    return this.root.position;
  }

  setSide(faceDir: 1 | -1): void {
    this.faceDir = faceDir;
    // Model forward is +Z at yaw 0; rotate to face the net along the x axis.
    this.root.rotation = new Vector3(0, faceDir === -1 ? Math.PI / 2 : -Math.PI / 2, 0);
  }

  /** World direction the character faces (toward the net). */
  get forward(): Vector3 {
    return new Vector3(this.faceDir === -1 ? 1 : -1, 0, 0);
  }

  get busy(): boolean {
    return this.action !== null;
  }

  private actionClip: string | null = null;

  /**
   * Name of the action clip playing right now, or null while idle.
   *
   * An online guest runs no rules, so it never calls playAction itself. The
   * host reports this in each snapshot and the guest mirrors it, which is what
   * makes a kick look like a kick rather than the ball changing direction on
   * its own.
   */
  get currentActionClip(): string | null {
    return this.actionClip;
  }

  /** Progress of the current action clip in [0, 1], or null when idle. */
  actionFraction(): number | null {
    const g = this.action;
    if (!g) return null;
    const anim = g.animatables[0];
    if (!anim) return null;
    return (anim.masterFrame - g.from) / (g.to - g.from || 1);
  }

  private nodeCache = new Map<string, TransformNode | null>();
  /** Striking-limb position at each clip's contact frame, in unrotated character space. */
  private contactOffsets = new Map<string, Vector3>();

  /**
   * Pose each contact clip at its contact frame (once, at load, while the rig
   * sits unrotated at the origin) and record the striking bone's position.
   */
  private measureContactOffsets(): void {
    for (const [clip, bone] of Object.entries(CLIP_CONTACT_BONE)) {
      const g = this.groups.get(clip);
      const node = this.findNode(bone);
      const cf = contactFraction(clip);
      if (!g || !node || cf <= 0) continue;
      g.start(false, 1, g.from, g.to);
      g.pause();
      g.goToFrame(g.from + cf * (g.to - g.from));
      node.computeWorldMatrix(true);
      this.contactOffsets.set(clip, node.getAbsolutePosition().clone());
      g.stop();
    }
  }

  /**
   * World-space point where `clip` will make contact, for the current
   * position and yaw.
   *
   * `extraYaw` is for asking about a clip that is *about* to be played with a
   * yaw offset of its own — a backflip is turned to face the table, and a plan
   * made before the turn would place the limb on the wrong side of the player.
   * Once the clip is running the offset is already in the root's rotation and
   * this takes no argument.
   */
  clipContactPoint(clip: string, extraYaw = 0): Vector3 | null {
    const off = this.contactOffsets.get(clip);
    if (!off) return null;
    const yaw = this.root.rotation.y + extraYaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return new Vector3(
      this.root.position.x + off.x * cos + off.z * sin,
      this.root.position.y + off.y,
      this.root.position.z - off.x * sin + off.z * cos
    );
  }

  /** Find a rig bone/node (e.g. "RightFoot") inside this character's hierarchy. */
  findNode(name: string): TransformNode | null {
    let node = this.nodeCache.get(name);
    if (node === undefined) {
      node =
        (this.root
          .getDescendants(false)
          .find((n) => n instanceof TransformNode && n.name.trim() === name) as TransformNode) ?? null;
      this.nodeCache.set(name, node);
    }
    return node;
  }

  /**
   * Glide the root to `target` over `duration` seconds while the current
   * action plays (eased, so it reads as a step/lunge into the strike). Used to
   * carry the striking limb onto the ball's natural flight path — the player
   * reaches for the ball, never the other way around.
   */
  lungeTo(target: Vector3, duration: number): void {
    if (duration < 0.03) return;
    this.lungeState = { from: this.position.clone(), to: target.clone(), dur: duration, t: 0 };
  }

  /**
   * Kinematic move, clamped to this character's half of the court.
   *
   * The velocity eases toward what was asked for rather than snapping to it.
   * A body has mass: it leans into a start and rides out a stop, and the
   * locomotion blend reads this same velocity, so easing it is also what stops
   * the jog animation popping in and out at full weight. MOVE_TAU is short
   * enough that the shift still answers the tap immediately — this is weight,
   * not input lag.
   */
  move(dirX: number, dirZ: number, speed: number, dt: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len > 1) {
      dirX /= len;
      dirZ /= len;
    }
    // Agility is how quickly the run reaches the speed it was asked for, and
    // fatigue is how much of that is left. Both are applied here rather than
    // to the top speed, so a tired or heavy-footed player is slow to start and
    // slow to turn — not incapable of covering ground. Taking reach away
    // instead would make one aggressive point cost a whole game, and the sharp
    // shots now need coming forward and getting back.
    const tau = MOVE_TAU / (this.def.agility * this.effort);
    // Tired legs are slower legs. Running out has to be something a player can
    // see happening to them rather than a number on a bar: at the floor this
    // is about a third of top speed, and with the acceleration term above it
    // on top, an empty player is visibly labouring — they can still reach a
    // ball played at them, and no longer one played away from them.
    const legs = 0.25 + 0.75 * this.effort;
    this.velocity.x = approachVelocity(this.velocity.x, dirX * speed * legs, dt, tau);
    this.velocity.z = approachVelocity(this.velocity.z, dirZ * speed * legs, dt, tau);
    this.velocity.y = 0;
    const p = this.position;
    p.x += this.velocity.x * dt;
    p.z += this.velocity.z * dt;
    this.clampToCourt();
  }

  /** Keep the root inside this character's half of the court, and off the table. */
  private clampToCourt(): void {
    const p = this.position;
    const sideSign = this.faceDir === -1 ? -1 : 1;
    p.x = sideSign * Math.min(COURT.maxX, Math.max(COURT.minX, sideSign * p.x));
    p.z = Math.max(-COURT.maxZ, Math.min(COURT.maxZ, p.z));
    // The half is open all the way to the middle line; the table is a hole in
    // it rather than a wall across it.
    const clear = clearTable(p.x, p.z);
    p.x = clear.x;
    p.z = clear.z;
  }

  /** Move toward a target point; returns remaining distance. */
  moveToward(target: Vector3, speed: number, dt: number): number {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      this.velocity.setAll(0);
      return 0;
    }
    this.move(dx / d, dz / d, Math.min(speed, d / dt), dt);
    // Momentum must not carry the run past the spot it was sent to: once the
    // remaining offset flips sign the run has arrived, whatever the distance
    // says. Without this the eased velocity oscillates around the target.
    const nx = target.x - this.position.x;
    const nz = target.z - this.position.z;
    if (nx * dx + nz * dz <= 0) {
      this.position.x = target.x;
      this.position.z = target.z;
      this.clampToCourt();
      this.velocity.setAll(0);
      return 0;
    }
    return Math.hypot(nx, nz);
  }

  playAction(
    name: string,
    opts: {
      startFrac?: number;
      speed?: number;
      callbacks?: FracCallback[];
      onEnd?: () => void;
      loop?: boolean;
      /** Rotate the character by this yaw for the clip's duration (restored after). */
      yawOffset?: number;
    } = {}
  ): boolean {
    const g = this.groups.get(name);
    if (!g) return false;
    this.stopAction();
    if (opts.yawOffset) {
      this.actionYawOffset = opts.yawOffset;
      this.root.rotation.y += opts.yawOffset;
    }
    for (const loco of LOCO_CLIPS) this.setLocoWeight(loco, 0);
    // A clip may have unusable frames at its head (CLIP_SKIP_FRAMES). Enforcing
    // the floor here rather than at each call site means no planner can ask for
    // a wind-up long enough to reach back into them.
    const startFrac = Math.max(opts.startFrac ?? 0, clipStartFraction(name));
    const from = g.from + startFrac * (g.to - g.from);
    g.start(opts.loop ?? false, opts.speed ?? 1, from, g.to);
    g.setWeightForAllAnimatables(1);
    this.action = g;
    this.actionClip = name;
    this.actionCallbacks = [...(opts.callbacks ?? [])].sort((a, b) => a.frac - b.frac);
    this.actionOnEnd = opts.onEnd ?? null;
    if (!(opts.loop ?? false)) {
      g.onAnimationGroupEndObservable.addOnce(() => {
        if (this.action === g) this.finishAction();
      });
    }
    return true;
  }

  stopAction(): void {
    if (this.action) {
      this.action.stop();
      this.action = null;
      this.actionClip = null;
      this.actionCallbacks = [];
      this.actionOnEnd = null;
    }
    this.lungeState = null;
    this.restoreActionYaw();
  }

  private restoreActionYaw(): void {
    if (this.actionYawOffset !== 0) {
      this.root.rotation.y -= this.actionYawOffset;
      this.actionYawOffset = 0;
    }
  }

  private finishAction(): void {
    // Fire any callbacks the end may have skipped past.
    const pending = this.actionCallbacks;
    this.actionCallbacks = [];
    for (const cb of pending) cb.fn();
    const onEnd = this.actionOnEnd;
    this.action?.stop();
    this.action = null;
    this.actionOnEnd = null;
    this.lungeState = null;
    this.restoreActionYaw();
    this.setLocoWeight(this.currentLoco, 1);
    const g = this.groups.get(this.currentLoco);
    if (g && !g.isPlaying) g.start(true, 1.0);
    onEnd?.();
  }

  private setLocoWeight(name: LocoClip, w: number): void {
    this.locoWeights.set(name, w);
    this.groups.get(name)?.setWeightForAllAnimatables(w);
  }

  update(dt: number): void {
    if (this.action) {
      // Advance the contact lunge before the contact callback can fire, so
      // the limb is in place when the ball is launched.
      const l = this.lungeState;
      if (l) {
        l.t = Math.min(l.dur, l.t + dt);
        const p = l.t / l.dur;
        const e = p * p * (3 - 2 * p); // smoothstep ease
        this.position.copyFrom(Vector3.Lerp(l.from, l.to, e));
        if (l.t >= l.dur) this.lungeState = null;
      }
      // Fire frame-fraction callbacks (serve toss / ball contact).
      const g = this.action;
      const anim = g.animatables[0];
      if (anim && this.actionCallbacks.length > 0) {
        const frac = (anim.masterFrame - g.from) / (g.to - g.from || 1);
        while (this.actionCallbacks.length > 0 && frac >= this.actionCallbacks[0].frac) {
          this.actionCallbacks.shift()!.fn();
        }
      }
      return;
    }

    // Locomotion blending from velocity expressed in the character's frame.
    // Facing +x (player), the character's right is -z; facing -x (AI), it is +z.
    const fwd = Vector3.Dot(this.velocity, this.forward);
    const lat = this.velocity.z * (this.faceDir === -1 ? -1 : 1); // + = to the character's right
    const speed = this.velocity.length();
    const goals = locoBlend(fwd, lat, speed);
    // `currentLoco` is what gets restored to full weight when an action ends,
    // so it has to be the clip the blend is actually leaning on.
    let target: LocoClip = "Idle";
    for (const name of LOCO_CLIPS) {
      if (goals[name] > goals[target]) target = name;
    }
    this.currentLoco = target;
    const stride = locoStride(goals, speed);
    const rate = dt / 0.12;
    for (const name of LOCO_CLIPS) {
      const cur = this.locoWeights.get(name) ?? 0;
      const goal = goals[name];
      const next = cur + Math.sign(goal - cur) * Math.min(rate, Math.abs(goal - cur));
      if (next !== cur) this.setLocoWeight(name, next);
      const g = this.groups.get(name);
      if (!g || next <= 0) continue;
      const playback = name === "Idle" ? 1 : stride;
      g.speedRatio = playback;
      if (!g.isPlaying) g.start(true, playback);
    }
  }

  /**
   * Hold every clip where it stands, or let them run again.
   *
   * Stopping the simulation is not enough to stop the character moving.
   * Babylon drives animation groups off the scene's own render loop, not off
   * our `update`, so a frozen world still had legs cycling in it: a player
   * caught mid-stride kept jogging on the spot for as long as the coach was
   * talking, which is what made a frozen lesson look broken.
   *
   * `restart()` on an animatable is a misnomer — it clears the paused flag and
   * nothing else. That is what makes this pair a freeze and a thaw rather than
   * a freeze and a rewind.
   */
  setAnimationsFrozen(frozen: boolean): void {
    if (frozen === this.animationsFrozen) return;
    this.animationsFrozen = frozen;
    for (const g of this.groups.values()) {
      if (!g.isStarted) continue;
      if (frozen) g.pause();
      else g.restart();
    }
  }

  dispose(): void {
    for (const g of this.groups.values()) g.dispose();
    this.root.dispose(false, true);
  }
}

/**
 * The last few frames of the Idle clip drift off to one side, which made the
 * loop snap back at the seam. Trim that tail from every targeted animation —
 * the runtime clamps any start() range to the remaining keys, so all Idle
 * call sites then loop cleanly over the shortened clip at normal speed.
 */
const IDLE_TRIM_FRAMES = 0;
export function trimIdleTail(group: AnimationGroup): void {
  const cutoff = group.to - IDLE_TRIM_FRAMES;
  for (const ta of group.targetedAnimations) {
    const keys = ta.animation.getKeys().filter((k) => k.frame <= cutoff);
    if (keys.length >= 2) ta.animation.setKeys(keys);
  }
}

/** Which foot a clip kicks/serves with, from its name; null for head/chest/knee clips. */
export function clipFoot(clip: string): Foot | null {
  if (!clip.includes("Foot")) return null;
  if (clip.includes("Right")) return "right";
  if (clip.includes("Left")) return "left";
  return null;
}

/**
 * Strong/weak-foot modifiers for a clip: power multiplies the ball speed,
 * spray multiplies the random aim error. Non-foot clips and two-footed
 * players are neutral.
 */
export function footFactor(def: CharacterDef, clip: string): { power: number; spray: number } {
  const foot = clipFoot(clip);
  if (!foot || def.strongFoot === "both") return { power: 1, spray: 1 };
  return foot === def.strongFoot ? FOOT_FACTOR.strong : FOOT_FACTOR.weak;
}

/**
 * Which foot a backflip swings.
 *
 * From where the player is *standing*, not from where the ball is — which is
 * the one place this differs from every other clip choice. An ordinary kick
 * reaches for the ball, so the near foot is the one that gets there. A
 * backflip is a whole-body rotation the player has already committed to, and
 * the leg that comes over is the one on the outside of the court: standing on
 * your right, you flip off your right foot.
 *
 * `stance` is the player's lateral position in their own frame — positive to
 * their right — so it is signed the same way as the `lateral` passed to
 * `chooseStrike`, and the two cannot drift apart.
 *
 * Returns null when neither foot is allowed by the character's traits, which
 * is how a player who cannot flip at all falls back to an ordinary kick.
 */
export function backflipFoot(stance: number, def: CharacterDef): Foot | null {
  const natural: Foot = stance >= 0 ? "right" : "left";
  if (backflipAllowed(def, natural)) return natural;
  // A player barred from their natural side can still flip off the other foot
  // when they are near enough to the middle for it not to look wrong.
  const off: Foot = natural === "right" ? "left" : "right";
  if (backflipAllowed(def, off) && Math.abs(stance) < 0.45) return off;
  return null;
}

/** Whether this player may finish with a backflip off the given foot. */
export function backflipAllowed(def: CharacterDef, foot: Foot): boolean {
  switch (def.backflips) {
    case "none":
      return false;
    case "both":
      return true;
    case "strong":
      return def.strongFoot === "both" || foot === def.strongFoot;
  }
}

/**
 * How far the band edges move between a ball met in front and one met at full
 * stretch, as a fraction of body height.
 *
 * About 12 cm on a 1.8 m player: inside the range a real contact could
 * plausibly be taken at, so it buys variety without ever putting a head kick on
 * a knee-height ball.
 *
 * Hard edges are why a rally played the same three clips. Contact heights
 * measured over a real match run from 0.31 to 0.88 of body height with a median
 * of 0.75 — a narrow, top-heavy spread — so most of a match landed in one band
 * and stayed there while the other clips sat loaded and unused.
 *
 * This used to be a coin toss (`bandJitter`), which bought the variety at the
 * price of the thing the variety was for: two identical balls could be played
 * two different ways, so nothing a player learned about where to stand held.
 * The spread now comes from the ball's own lateral offset instead — see
 * `bandShift` — which varies just as much over a match and varies *because of
 * something the player did*.
 */
export const BAND_OVERLAP = 0.07;

/** A ball this far to the side counts as fully at stretch, in metres. */
export const WIDE_BALL = 0.55;

/**
 * How this contact moves the band edges, from where the ball is arriving.
 *
 * A ball dead in front is met high on the body — chest, head, the parts that
 * are already there. A ball out to the side is reached for, and what reaches is
 * the leg: the bands slide down, so the same height played wide is a knee where
 * played in front it was a chest.
 *
 * That is the whole of "position decides the body part", and it is continuous:
 * a step across changes the touch a little, not all at once, so the boundary
 * is something a player can feel out rather than memorise.
 */
export function bandShift(lateral: number): number {
  return -BAND_OVERLAP * Math.min(1, Math.abs(lateral) / WIDE_BALL);
}

/**
 * How far off centre a ball still counts as dead ahead.
 *
 * Widened from 0.06, which was so tight that the side was effectively decided
 * by the sign of `lateral` alone — and since play is not symmetric, one of each
 * left/right pair barely appeared. Over a measured match InnerLeftFootReception
 * ran to 237 samples against InnerRightFootReception's zero.
 */
const CENTRE_ZONE = 0.18;

/**
 * Left/Right by lateral offset; a ball inside the central zone is taken on the
 * player's strong side.
 *
 * Deterministic, where it used to be weighted dice. A player who wants the ball
 * on their left foot has a way to ask for it — stand slightly to its right —
 * and that only works if asking twice gives the same answer twice.
 */
function pickSide(lateral: number, prefer: Foot | "both" = "both"): "Left" | "Right" {
  if (Math.abs(lateral) < CENTRE_ZONE && prefer !== "both") {
    return prefer === "left" ? "Left" : "Right";
  }
  return lateral >= 0 ? "Right" : "Left";
}

/**
 * Which part of the body plays a clip.
 *
 * Read from the clip's own contact bone rather than from a second table, so a
 * new clip cannot arrive with a contact point and no body part — the rules that
 * count parts and the physics that places the ball are then talking about the
 * same limb by construction.
 */
export function bodyPartOf(clip: string): BodyPart | null {
  const bone = CLIP_CONTACT_BONE[clip];
  if (!bone) return null;
  if (bone === "Head") return "head";
  if (bone.endsWith("Foot")) return "foot";
  if (bone.endsWith("Leg")) return "knee";
  return "chest";
}

/**
 * How high the ball has to be, as a fraction of the player's own height, for
 * each way of striking it to be available.
 *
 * Fractions rather than metres because a 1.72 m player and a 1.86 m one do not
 * head the same ball, and a band in metres would quietly make one of them
 * better at everything.
 */
export const STRIKE_BANDS = {
  /** Head height. Below this there is no header to play. */
  header: 0.78,
  /** A backflip reaches above the player, so it starts lower than a header. */
  backflip: 0.6,
  /** Under this nothing can be struck at all and the ball is only controlled. */
  foot: 0.12,
};

/**
 * Which foot a backflip comes over on, or null if this player cannot flip here.
 *
 * Only the strong foot flips. That is what confines backflips to one side of
 * the court: the leg that comes over is the outside one, so the player has to
 * be standing on their strong side to use it. A two-footed player has no weak
 * side and can flip from either.
 */
export function strikeBackflipFoot(stance: number, def: CharacterDef): Foot | null {
  if (def.backflips === "none") return null;
  const outside: Foot = stance >= 0 ? "right" : "left";
  if (def.strongFoot === "both") return outside;
  return outside === def.strongFoot ? outside : null;
}

/** Whether a ball arriving here is on the player's weaker side. */
export function onWeakSide(lateral: number, def: CharacterDef): boolean {
  if (def.strongFoot === "both") return false;
  return (lateral >= 0 ? "right" : "left") !== def.strongFoot;
}

/**
 * How far onto the weak side a ball has to arrive before that foot is not
 * trusted with it, in metres of lateral offset at full doubt.
 */
const WEAK_SIDE_FULL = 0.9;

/**
 * Whether this ball is too far onto the weak side for the foot to be used.
 *
 * The old rule rolled a die against the weak-foot score, which made the header
 * the one thing in a rally a player could neither predict nor cause. It is now
 * the same score read as a *reach*: how far across the body the foot is trusted
 * to go. At 20 it is trusted almost nowhere and nearly every high ball on that
 * side is headed; at 95 it goes right out to the touchline. Between them the
 * player decides which they get, by where they stand.
 */
export function weakSideDoubt(lateral: number, def: CharacterDef): boolean {
  if (!onWeakSide(lateral, def)) return false;
  const severity = Math.min(1, Math.abs(lateral) / WEAK_SIDE_FULL);
  return severity > def.weakFoot / 100;
}

/** A touch the game is considering: the clip, and the part of the body it uses. */
interface Candidate {
  clip: string;
  part: BodyPart;
}

/**
 * Options shared by both clip pickers.
 *
 * `avoid` is the teqball rule that makes a rally a sequence rather than three
 * separate touches: the same part of the body may not play the ball twice in a
 * row. It is enforced here, where the touch is chosen, rather than as a foul
 * after the fact — the game picks the limb, so it must pick a legal one.
 */
export interface TouchOptions {
  /** Body part used by this player's previous touch in the same possession. */
  avoid?: BodyPart | null;
  /** Override the band shift (tests). Defaults to the ball's own offset. */
  bandShift?: number;
}

/** First candidate that is not the part just used; the head of the list otherwise. */
function resolve(candidates: Candidate[], avoid: BodyPart | null | undefined): string {
  const legal = avoid ? candidates.find((c) => c.part !== avoid) : candidates[0];
  return (legal ?? candidates[0]).clip;
}

/**
 * What a player does with a ball they can attack.
 *
 * Feet first. A teqball player up at the table kicks or flips; heading is what
 * you do when the ball is coming to the side you do not trust, and even then
 * only if it is high enough to head at all. So the header is not a height band
 * — it is an admission, and how far the weak foot is trusted decides where on
 * the court it happens (`weakSideDoubt`).
 *
 * Below the table's own height none of that applies: there is no shot to play,
 * only a touch to take, and the reception clips are what that looks like.
 *
 * The return is a *list* in preference order, from which the first part not
 * used by the previous touch is played. That is what turns the no-repeats rule
 * into something to build with: a player who has just chested the ball knows
 * the next one is a knee or a foot, and can put the ball at the height that
 * picks the one they want.
 */
export function chooseStrike(
  ballY: number,
  lateral: number,
  stance: number,
  def: CharacterDef,
  /**
   * Whether this player has already taken a touch on the ball.
   *
   * A foot volley and a backflip are finishes: they are played on a ball you
   * have set up for yourself, not on one arriving from the other end. Off the
   * first touch the job is to control it.
   */
  received: boolean,
  opts: TouchOptions = {}
): string {
  const rel = ballY / def.height + (opts.bandShift ?? bandShift(lateral));
  const side = pickSide(lateral, def.strongFoot);
  const candidates: Candidate[] = [];
  const header: Candidate = {
    clip: Math.abs(lateral) > 0.12 ? `${side}HeadKick` : "CenterHeadKick",
    part: "head",
  };

  // The same ladder wherever the player is standing.
  //
  // It used to fall back to a header for anything played from outside smash
  // range, and smash range is 1.9 m from the net while players receive from
  // three to seven metres out — so nearly every touch in a rally took that
  // branch and the whole game was headers. How high a ball has to be sent from
  // deep is a question for the flight, not for the animation, and `loftFloor`
  // already answers it.

  // The weak side, high enough to head: the one case a header leads.
  const headable = rel >= STRIKE_BANDS.header;
  if (headable && weakSideDoubt(lateral, def)) candidates.push(header);

  if (received) {
    // Otherwise the feet have it, hardest first — but only on a ball this
    // player set up. Off the first touch there is nothing to finish yet.
    if (rel >= STRIKE_BANDS.backflip) {
      const foot = strikeBackflipFoot(stance, def);
      if (foot) {
        candidates.push({
          clip: foot === "right" ? "BackflipRightFoot" : "BackflipLeftFoot",
          part: "foot",
        });
      }
    }
    if (rel >= STRIKE_BANDS.foot) candidates.push({ clip: `${side}FootKick`, part: "foot" });
    // A high ball the feet have already claimed is still headable, and that is
    // the way out when the feet played the last touch.
    if (headable) candidates.push(header);
    if (rel > 0.45) candidates.push({ clip: `${side}KneeReception`, part: "knee" });
    candidates.push({ clip: `Inner${side}FootReception`, part: "foot" });
    return resolve(candidates, opts.avoid);
  }

  // First touch: bring it down.
  if (headable) candidates.push(header);
  if (rel > 0.62) candidates.push({ clip: "ChestKick", part: "chest" });
  if (rel > 0.45) candidates.push({ clip: `${side}KneeReception`, part: "knee" });
  candidates.push({ clip: `Inner${side}FootReception`, part: "foot" });
  // Every band has a chest and a knee behind it, so the no-repeats rule always
  // has somewhere legal to go — a ball at shin height after a foot touch is
  // dug out with the knee rather than illegally toed again.
  candidates.push({ clip: `${side}KneeReception`, part: "knee" });
  candidates.push({ clip: "ChestKick", part: "chest" });
  // A first touch is a control touch: the head is the last resort, never the
  // first answer, or the game goes back to being all headers.
  const first = candidates[0];
  if (first.part === "head" && !weakSideDoubt(lateral, def)) candidates.shift();
  return resolve(candidates, opts.avoid);
}

/**
 * Pick a control-touch (reception/prep) clip from the ball's height and lateral
 * offset, avoiding the part that played the previous touch.
 *
 * Only three parts can take a set-up — there is no heading clip that leaves the
 * ball playable — so the ladder is chest, knee, foot, ordered by what the ball
 * is level with. Which one arrives is decided entirely by the ball's height and
 * how far to the side it is: the same approach always produces the same touch,
 * and a different approach reliably produces a different one.
 */
export function pickReceptionClip(
  ballY: number,
  lateral: number,
  height: number,
  strongFoot: Foot | "both" = "both",
  opts: TouchOptions = {}
): string {
  const rel = ballY / height + (opts.bandShift ?? bandShift(lateral));
  const side = pickSide(lateral, strongFoot);
  // A ball in front of the chest is taken on the chest square-on; one off to
  // the side needs the step across that the prep clips are.
  const chest: Candidate = {
    clip: Math.abs(lateral) > CENTRE_ZONE ? `ChestPrep${side}` : "ChestReception",
    part: "chest",
  };
  const knee: Candidate = { clip: `${side}KneeReception`, part: "knee" };
  const foot: Candidate = { clip: `Inner${side}FootReception`, part: "foot" };
  const ladder =
    rel > 0.62 ? [chest, knee, foot] : rel > 0.45 ? [knee, chest, foot] : [foot, knee, chest];
  return resolve(ladder, opts.avoid);
}

export const SERVE_CLIPS = ["ServeRightFoot", "ServeLeftFoot", "HeadServeRight", "HeadServeLeft"] as const;

/**
 * Serve clip for a lateral aim in the server's own frame (+ = the server's
 * left): aiming left serves cross-body with the right foot, aiming right with
 * the left foot, and a central aim uses a head serve (random side).
 */
export function serveClipForAim(ownLat: number, strongFoot: Foot | "both" = "both"): string {
  if (ownLat > 0.25) return "ServeRightFoot";
  if (ownLat < -0.25) return "ServeLeftFoot";
  // The head serve used to pick its side with a coin toss, which meant the one
  // serve a player can aim straight down the middle was also the one they could
  // not learn. It follows the strong side instead.
  return strongFoot === "left" ? "HeadServeLeft" : "HeadServeRight";
}

// Hand that carries/tosses the ball for each serve clip (edit if a serve's
// toss is animated on the other hand).
export const SERVE_TOSS_HAND: Record<string, string> = {
  ServeLeftFoot: "RightHand",
  ServeRightFoot: "RightHand",
  HeadServeLeft: "LeftHand",
  HeadServeRight: "LeftHand",
};

// Rig bone that strikes the ball in each clip (Mixamo naming; "Leg" = shin,
// whose origin is the knee joint). Used to glue the ball to the limb so the
// visual contact is exact.
export const CLIP_CONTACT_BONE: Record<string, string> = {
  RightFootKick: "RightFoot",
  LeftFootKick: "LeftFoot",
  BackflipRightFoot: "RightFoot",
  BackflipLeftFoot: "LeftFoot",
  InnerRightFootReception: "RightFoot",
  InnerLeftFootReception: "LeftFoot",
  RightKneeReception: "RightLeg",
  LeftKneeReception: "LeftLeg",
  CenterHeadKick: "Head",
  LeftHeadKick: "Head",
  RightHeadKick: "Head",
  ChestKick: "Spine2",
  ChestReception: "Spine2",
  ChestPrepLeft: "Spine2",
  ChestPrepRight: "Spine2",
  ServeLeftFoot: "LeftFoot",
  ServeRightFoot: "RightFoot",
  HeadServeLeft: "Head",
  HeadServeRight: "Head",
};

/**
 * The Head bone's origin is inside the skull, so a ball centred on it sinks
 * into the head mesh. Push the contact point this far along the facing
 * direction (~head half-depth + ball radius) so the ball rests on the forehead.
 */
export const HEAD_CONTACT_PUSH = 0.15;

/** Where the ball should be at the serve's contact frame, relative to the character. */
export function serveContactOffset(clip: string, forward: Vector3, height: number): Vector3 {
  const head = clip.startsWith("HeadServe");
  const f = head ? 0.32 : 0.55;
  const h = head ? height * 0.93 : height * 0.3;
  return forward.scale(f).add(new Vector3(0, h, 0));
}
