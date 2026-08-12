import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import {
  clearTable,
  clipStartFraction,
  contactFraction,
  CHARACTER_SCALE,
  COURT,
  FOOT_FACTOR,
  type CharacterDef,
  type Foot,
} from "./config";
import { brightenKit, fixMetallicMaterials } from "./scene";

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
 * The least of their legs a player can be left with, as a multiplier on how
 * quickly they get moving.
 *
 * Not zero, and not close to it. Stamina is meant to make a long rally hurt,
 * not to strand somebody next to a ball they can see — and since attacking now
 * means running to the middle line and back, a punishing floor would turn one
 * brave point into a lost game.
 */
export const MIN_EFFORT = 0.62;

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

  /** Active contact lunge: glides the root while an action clip plays. */
  private lungeState: { from: Vector3; to: Vector3; dur: number; t: number } | null = null;

  /**
   * What is left in the legs, from 1 (fresh) down to `MIN_EFFORT`.
   *
   * Owned by the match, which drains and restores it — a character on the
   * selection carousel has no rally behind it and is always fresh.
   */
  effort = 1;

  private constructor(root: TransformNode, height: number, def: CharacterDef) {
    this.root = root;
    this.height = height;
    this.def = def;
  }

  static async load(scene: Scene, def: CharacterDef): Promise<Character> {
    const file = def.id;
    const h = def.height * CHARACTER_SCALE;
    const res = await SceneLoader.ImportMeshAsync("", "/models/characters/", `${file}.glb`, scene);
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

  /** World-space point where `clip` will make contact, for the current position/yaw. */
  clipContactPoint(clip: string): Vector3 | null {
    const off = this.contactOffsets.get(clip);
    if (!off) return null;
    const yaw = this.root.rotation.y;
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
    this.velocity.x = approachVelocity(this.velocity.x, dirX * speed, dt, tau);
    this.velocity.z = approachVelocity(this.velocity.z, dirZ * speed, dt, tau);
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
 * `pickStrikeClip`, and the two cannot drift apart.
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
 * Left/Right by lateral offset; when the ball is near dead-centre, footed
 * players favour their strong side.
 */
function pickSide(lateral: number, prefer: Foot | "both" = "both"): "Left" | "Right" {
  if (Math.abs(lateral) < 0.06) {
    if (prefer === "left") return Math.random() < 0.75 ? "Left" : "Right";
    if (prefer === "right") return Math.random() < 0.75 ? "Right" : "Left";
    return Math.random() < 0.5 ? "Left" : "Right";
  }
  return lateral >= 0 ? "Right" : "Left";
}

/**
 * Pick the strike clip from the ball's height and lateral offset at contact.
 * Bands overlap with weighted randomness so rallies show the whole move set
 * (in play the ball is almost always above half body height, so strict
 * anatomical bands would leave most clips unused).
 */
export function pickStrikeClip(
  ballY: number,
  lateral: number,
  height: number,
  strongFoot: Foot | "both" = "both",
  /**
   * How hard the kick is meant to be struck, 0..1. Where the ball is decides
   * what is reachable; this decides which of those the player is asking for.
   * Driven at the top of the range, floated at the bottom — the animation has
   * to agree with the ball that comes off it, or the shot reads as a bug.
   */
  power = 0.6,
  /**
   * Whether the player is close enough to the middle line for the hard shots.
   *
   * The foot volley is a smash, and a smash from the back of the court is not
   * a shot that exists — there is no angle through which it clears the net and
   * lands. From deep the same ball is played as an inner-foot lob instead, so
   * the animation still agrees with the flight that comes off it.
   */
  nearMiddle = true
): string {
  const rel = ballY / height; // normalised contact height
  const side = pickSide(lateral, strongFoot);
  const driven = power >= 0.5;
  if (rel > 0.8) {
    if (Math.abs(lateral) > 0.12) return `${side}HeadKick`;
    return driven ? "CenterHeadKick" : `${side}HeadKick`;
  }
  if (rel > 0.62) return driven ? `${side}HeadKick` : "ChestKick";
  if (rel > 0.45) return driven ? "ChestKick" : `${side}KneeReception`;
  // Low ball: a driven foot volley from up at the table, or an inner-foot
  // touch played as a slow lob from anywhere.
  return driven && nearMiddle ? `${side}FootKick` : `Inner${side}FootReception`;
}

/** Pick a control-touch (reception/prep) clip from the ball's height and lateral offset. */
export function pickReceptionClip(
  ballY: number,
  lateral: number,
  height: number,
  strongFoot: Foot | "both" = "both"
): string {
  const rel = ballY / height;
  const side = pickSide(lateral, strongFoot);
  if (rel > 0.62) {
    return Math.random() < 0.4 ? "ChestReception" : `ChestPrep${side}`;
  }
  if (rel > 0.45) return Math.random() < 0.6 ? `${side}KneeReception` : "ChestReception";
  return `Inner${side}FootReception`;
}

export const SERVE_CLIPS = ["ServeRightFoot", "ServeLeftFoot", "HeadServeRight", "HeadServeLeft"] as const;

/**
 * Serve clip for a lateral aim in the server's own frame (+ = the server's
 * left): aiming left serves cross-body with the right foot, aiming right with
 * the left foot, and a central aim uses a head serve (random side).
 */
export function serveClipForAim(ownLat: number): string {
  if (ownLat > 0.25) return "ServeRightFoot";
  if (ownLat < -0.25) return "ServeLeftFoot";
  return Math.random() < 0.5 ? "HeadServeRight" : "HeadServeLeft";
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
