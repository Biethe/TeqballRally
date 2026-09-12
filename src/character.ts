import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { Scene } from "@babylonjs/core/scene";
import {
  clearTable,
  clipStartFraction,
  contactFraction,
  CHARACTER_SCALE,
  COURT,
  FOOT_FACTOR,
  INTERACTION_VOLUME_DEFAULTS,
  INTERACTION_VOLUME_OVERRIDES,
  REACH_ASSIST,
  RECEPTION_ZONE,
  type BodyPart,
  type CharacterDef,
  type Foot,
} from "./config";
import { brightenKit, fixMetallicMaterials } from "./scene";
import { importModel } from "./protected";
import { volumeToWorld, type InteractionVolumeDef, type WorldVolume } from "./interaction";

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
 */
const STRAFE_STRIDE_RATIO = 0.62;

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

  if (lat >= 0) {
    w.JogStrafeRightInPlace = s;
  } else {
    w.JogStrafeLeftInPlace = s;
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
  const run = weights.JogForward + weights.jogBackward;
  const strafe = weights.JogStrafeLeftInPlace + weights.JogStrafeRightInPlace;
  const total = run + strafe;
  if (total <= 1e-6) return 1;
  const reference = (LOCO_SPEED * (run + strafe * STRAFE_STRIDE_RATIO)) / total;
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
 * Hold a player inside a hard circle around their own set-up.
 *
 * Free inside, blocked at the edge. Only the component of the push heading
 * *out* of the circle is removed; anything sideways is untouched, so a player
 * at the boundary can still circle the drop to pick which foot takes the ball
 * — which is the one adjustment the room exists for.
 *
 * Unlike `nearAnchorPush` this is a wall, and deliberately so. That one damps a
 * push and lets a player who means to leave leave, which is right for a ball
 * arriving from the other side. This is for a ball you set up yourself, where
 * there is nothing left to decide.
 *
 * Nothing here moves anybody. It reshapes the direction that was asked for and
 * returns it no longer than it arrived, so the caller's own easing, footing and
 * court clamp all still apply.
 */
export function leashPush(
  toAnchorX: number,
  toAnchorZ: number,
  mx: number,
  mz: number,
  radius: number
): [number, number] {
  const d = Math.hypot(toAnchorX, toAnchorZ);
  if (d < radius || d < 1e-4) return [mx, mz];
  const ux = toAnchorX / d;
  const uz = toAnchorZ / d;
  // Positive points back toward the anchor, so a negative one is the part
  // trying to leave — and that is the only part taken away.
  const par = mx * ux + mz * uz;
  if (par >= 0) return [mx, mz];
  return [mx - ux * par, mz - uz * par];
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
 * added toward the ball — as much of it as `assist` has earned.
 *
 * Sideways movement is never touched, by the damping or by the leash.
 * Circling the contact point to change which side of the ball you meet it on
 * is the adjustment the zone exists to protect, not the one it exists to stop
 * — and on this game's stick it is also how the coming touch is aimed.
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
  speed: number,
  assist = 1
): [number, number] {
  const d = Math.hypot(toAnchorX, toAnchorZ);
  if (d <= RECEPTION_ZONE.radius || d < 1e-4) return [mx, mz];
  const ux = toAnchorX / d;
  const uz = toAnchorZ / d;
  const past = Math.min(1, (d - RECEPTION_ZONE.radius) / RECEPTION_ZONE.soft);
  // How hard the player is pushing *away*, measured before the damping below —
  // the damped push is the answer, not the question, and reading the leash off
  // it would let the zone lean on its own output and pull a player back
  // through a full-stick push.
  //
  // Only the outward half counts. On this game's stick a held direction is
  // also how a set-up is aimed, so fading the leash on any push at all meant
  // that crafting a touch quietly cancelled the help needed to reach the ball
  // and play it. Pushing across the flight, or toward it, now keeps every bit
  // of the leash — which is the same rule the damping below already follows.
  const par = mx * ux + mz * uz;
  const leaving = Math.min(1, Math.max(0, -par));
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
  // cannot push against is a movement lock with extra steps, and at a full
  // push away this one is not there at all — and it is what closes the gap
  // between the
  // zone and the arm's length a reception is actually taken from: a player who
  // drifted out and let go ends up back in the play rather than watching it
  // land two paces away.
  //
  // `assist` is how much of it the time in hand has earned (`assistStrength`).
  // The damping above is unconditional — walking off a reception you started
  // is a mistake whatever the clock says — but *closing* on a ball that is
  // going to beat the player anyway is help they have not earned, and giving
  // it would be the automatic control this is deliberately not.
  const pull = (RECEPTION_ZONE.leash / Math.max(0.5, speed)) * past * (1 - leaving) * assist;
  mx += ux * pull;
  mz += uz * pull;
  return [mx, mz];
}

/**
 * Spare time in hand: how long the ball takes to arrive, less how long a full
 * run would take to cover the ground to meet it.
 *
 * Negative means the ball wins — the player cannot get there however hard they
 * run — and nothing downstream should make that up for them. A fast shot and a
 * well-placed one have to be able to win the point, which is the whole reason
 * this is a time and not a radius: a ball three metres away with a second of
 * hang is reachable, and the same ball driven flat is not.
 */
export function reachSlack(dist: number, eta: number, speed: number): number {
  return eta - dist / Math.max(0.1, speed);
}

/**
 * How much of the assist this much spare time has earned, from 0 to 1.
 *
 * Nothing at all while the ball is winning, then ramping in across
 * `REACH_ASSIST.slackFull` seconds so the help arrives as the player gets on
 * terms with the flight rather than switching on at a line. What it scales is
 * the *shaping* of a run — the bend and the closing pull — never the decision
 * to run, which stays the player's: at full strength a standing player is
 * still standing.
 */
export function assistStrength(slack: number): number {
  if (slack <= 0) return 0;
  return Math.min(1, slack / REACH_ASSIST.slackFull);
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
export const MIN_EFFORT = 0.05;

/**
 * The least of the *reserve* a match can grind a player down to.
 *
 * The reserve is the ceiling recovery works up to, and it only ever falls. A
 * player who has run a hard first set does not get a fresh pair of legs for
 * the second — they get whatever is left of the ones they started with, which
 * is the whole reason fitness, and everything sold for it, is worth having.
 */
export const MIN_RESERVE = 0.30;

/**
 * A loaded, rigged character: kinematic movement plus a two-layer animation
 * controller (cross-faded locomotion + one-shot actions with frame callbacks,
 * so serves can fire toss/contact events at the frames listed in Animation.txt).
 */
export class Character {
  root: TransformNode;
  groups = new Map<string, AnimationGroup>();
  meshes: AbstractMesh[] = [];
  /** Held only so `dispose` can take them down; nothing else reads them. */
  private skeletons: Skeleton[] = [];
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
  /**
   * Minimum distance from the net (|x| coordinate boundary).
   * Defaults to COURT.minX (0), but can be set to SERVE_X during serve preparation
   * to prevent receiving players from crossing the service line forward.
   */
  minCourtX: number = COURT.minX;

  /**
   * Interaction volumes measured from each clip's contact pose, keyed by clip.
   *
   * Built once at load from the same pose pass that records contact offsets:
   * centre and orientation are the striking limb's own, sizes come from
   * `INTERACTION_VOLUME_DEFAULTS`/`_OVERRIDES`. Pure data — all runtime
   * placement goes through `contactVolumeTransform`.
   */
  readonly interactionVolumes = new Map<string, InteractionVolumeDef>();
  /** Limb orientation at the contact frame, root-local (measured with it). */
  private contactOrientations = new Map<string, Quaternion>();

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
    // Normalise model height to the character's real-world height and center horizontally.
    const { min, max } = wrapper.getHierarchyBoundingVectors(true);
    const rawH = max.y - min.y;
    const s = rawH > 0.01 ? h / rawH : 1;
    inner.scaling.setAll(s);
    inner.position.x = -((min.x + max.x) * 0.5) * s;
    inner.position.y = -min.y * s;
    inner.position.z = -((min.z + max.z) * 0.5) * s;

    const char = new Character(wrapper, h, def);
    char.meshes = res.meshes;
    char.skeletons = res.skeletons;
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

  /**
   * How far through the playing action clip the animation actually is, from 0
   * to 1, or null when nothing is playing.
   *
   * Read off the animatable rather than counted in simulation steps, because
   * those are two different clocks. Babylon advances an animation group on the
   * render loop's own delta; the fixed step caps its delta at `MAX_FRAME_DT`
   * and drops whatever is left over. So on a device that is dropping frames
   * the animation runs ahead of the simulation, and a clip window predicted
   * from the step count stops describing where the clip is.
   *
   * An online guest reads that window, and a window that has stopped
   * describing its clip is a clip the guest silently skips or holds back until
   * its own clock drifts into range — which is what a joined player saw as
   * touches that played no animation, followed by one appearing from nowhere
   * at the next serve.
   */
  /**
   * Put the playing action clip at this fraction of itself.
   *
   * For an online guest, whose animation is presentation rather than
   * simulation. The host says where the clip is on every frame, and the clip
   * belongs to that clock, not to this device's render loop — left to
   * free-run it drifts away exactly as the host's does, and a drifted clip is
   * a kick that swings while the ball is still on its way. Pinning it each
   * step makes the pose a function of the playback tick, the same way the
   * ball already is.
   */
  seekAction(frac: number): void {
    const g = this.action;
    if (!g) return;
    const f = Math.min(1, Math.max(0, frac));
    g.goToFrame(g.from + f * (g.to - g.from));
  }

  get actionFraction(): number | null {
    const g = this.action;
    if (!g) return null;
    const anim = g.animatables[0];
    if (!anim) return null;
    const span = g.to - g.from;
    if (!(span > 0)) return null;
    return Math.min(1, Math.max(0, (anim.masterFrame - g.from) / span));
  }

  private nodeCache = new Map<string, TransformNode | null>();
  /** Striking-limb position at each clip's contact frame, in unrotated character space. */
  private contactOffsets = new Map<string, Vector3>();

  /**
   * Pose each contact clip at its contact frame (once, at load, while the rig
   * sits unrotated at the origin) and record the striking bone's position —
   * and, for the interaction volumes, its orientation too. Both are read from
   * the same pose so a contact point and its volume can never disagree.
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
      this.contactOrientations.set(clip, node.absoluteRotationQuaternion.clone());
      g.stop();
    }
    this.buildInteractionVolumes();
  }

  /**
   * Turn the measured contact poses into interaction volume definitions.
   *
   * Centre and orientation come from the pose itself; size comes from the
   * per-part defaults, and a per-clip override (`INTERACTION_VOLUME_OVERRIDES`)
   * can shift the centre by a delta — a delta, because every rig measures its
   * own centre and one absolute number cannot fit every body — and replace
   * size fields. Head clips get the forehead push baked into their centre so
   * the volume sits on the face rather than inside the skull, matching what
   * `HEAD_CONTACT_PUSH` does for the bare contact point at serve time.
   */
  private buildInteractionVolumes(): void {
    for (const [clip, off] of this.contactOffsets) {
      const part = bodyPartOf(clip);
      if (!part) continue;
      const override = INTERACTION_VOLUME_OVERRIDES[clip];
      const dims = { ...INTERACTION_VOLUME_DEFAULTS[part], ...(override?.dims ?? {}) };
      const cx = off.x;
      const cy = off.y;
      const cz = off.z + (part === "head" ? HEAD_CONTACT_PUSH : 0);
      const q = this.contactOrientations.get(clip) ?? Quaternion.Identity();
      const d = override?.d ?? [0, 0, 0];
      this.interactionVolumes.set(clip, {
        clip,
        part,
        shape: dims.shape ?? "sphere",
        center: [cx + d[0], cy + d[1], cz + d[2]],
        measuredCenter: [cx, cy, cz],
        quat: [q.x, q.y, q.z, q.w],
        dims,
      });
    }
  }

  /**
   * The clip's interaction volume placed in the world for the character's
   * current position and yaw, or null if the clip has no contact geometry.
   *
   * The yaw handling is exactly `clipContactPoint`'s — root yaw minus the
   * action offset plus the clip's own — so the volume and the legacy point it
   * grew around always agree about where "here" is, mid-action included.
   */
  contactVolumeTransform(clip: string): WorldVolume | null {
    const def = this.interactionVolumes.get(clip);
    if (!def) return null;
    const yaw = this.root.rotation.y - this.actionYawOffset + clipYawOffset(clip);
    return volumeToWorld(def, this.root.position, yaw);
  }

  /**
   * A world point expressed in the clip's root-local volume space — the exact
   * inverse of `contactVolumeTransform`'s placement, so a dragged volume can
   * be written back as the same local numbers the config stores.
   */
  worldToClipLocal(clip: string, world: Vector3): Vector3 | null {
    if (!this.interactionVolumes.has(clip)) return null;
    const yaw = this.root.rotation.y - this.actionYawOffset + clipYawOffset(clip);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const dx = world.x - this.root.position.x;
    const dz = world.z - this.root.position.z;
    return new Vector3(dx * cos - dz * sin, world.y - this.root.position.y, dx * sin + dz * cos);
  }

  /**
   * World-space point where `clip` will make contact, for the current
   * position and yaw.
   *
   * The clip's own yaw offset is applied here rather than asked for, and the
   * offset currently on the root is taken back off first, so the answer is the
   * same whether the clip has not started, is running, or has already ended.
   * That last case is why: the caller used to have to pass the offset before
   * the turn and omit it during, which is correct only while the clip is
   * actually playing. A clip that ends early — or a point that ends under it —
   * restores the root's yaw, and every later question about the contact point
   * then came back mirrored onto the wrong side of the player. Harmless while
   * every offset was zero; a 2.8 m error on a backflip as soon as one was not.
   */
  clipContactPoint(clip: string): Vector3 | null {
    const off = this.contactOffsets.get(clip);
    if (!off) return null;
    const yaw = this.root.rotation.y - this.actionYawOffset + clipYawOffset(clip);
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
    const minX = Math.max(COURT.minX, this.minCourtX ?? COURT.minX);
    p.x = sideSign * Math.min(COURT.maxX, Math.max(minX, sideSign * p.x));
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
    } = {}
  ): boolean {
    const g = this.groups.get(name);
    if (!g) return false;
    this.stopAction();
    // The clip decides its own facing, so every caller gets it — including the
    // online guest, which mirrors the host's clip by name and passes no options
    // at all. Asking callers to opt in meant the host flipped and the guest did
    // not, on the one screen where both are watching the same point.
    const yawOffset = clipYawOffset(name);
    if (yawOffset) {
      this.actionYawOffset = yawOffset;
      this.root.rotation.y += yawOffset;
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
      this.actionCallbacks = [];
      this.actionOnEnd = null;
    }
    // Outside the guard: a clip that already ended on its own has no group
    // left to stop, and the name still has to go.
    this.actionClip = null;
    this.lungeState = null;
    this.restoreActionYaw();
  }

  /**
   * Abandon the current action and land back on the locomotion blend, without
   * firing any of its frame callbacks.
   *
   * `finishAction` is what a playing clip calls when it truly ends — but it
   * flushes pending callbacks, which is the last thing an abandoned one should
   * do: a debug tool pausing a strike mid-wind-up must not launch the ball on
   * close. This is the quiet exit: stop, un-turn, restore weights, resume
   * walking.
   *
   * The restoring is the point, and it is what `stopAction` leaves out.
   * `playAction` zeroes every locomotion weight on the way in, so a clip that
   * is stopped rather than finished leaves the skeleton with nothing driving
   * it and the character frozen on whatever frame it was cut at. Offline that
   * is rare, because clips almost always run to their own end. On an online
   * guest it is the *only* way a clip ever ends — the host's window says when,
   * and the clip is pinned to that clock rather than allowed to finish — which
   * is why a joined player kept being walked back to the service line still
   * holding the pose of a kick.
   */
  cancelActionToLoco(): void {
    if (this.action) {
      this.action.stop();
      this.action = null;
      this.actionCallbacks = [];
      this.actionOnEnd = null;
    }
    this.actionClip = null;
    this.lungeState = null;
    this.restoreActionYaw();
    this.setLocoWeight(this.currentLoco, 1);
    const g = this.groups.get(this.currentLoco);
    if (g && !g.isPlaying) g.start(true, 1.0);
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
    // Cleared here too, and not only where a clip is cut short.
    //
    // This is the exit a clip takes when it simply ends, which is almost every
    // clip — and leaving the name behind meant `currentActionClip` went on
    // naming a finished animation until something else started one. An online
    // host publishes that name in every snapshot, so its guest was told a
    // character was mid-touch long after it had stopped: a clip it could not
    // play and could not let go of, and a body it would not predict for
    // because the name said it was busy.
    this.actionClip = null;
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
        const was = this.position.clone();
        this.position.copyFrom(Vector3.Lerp(l.from, l.to, e));
        // Report the dart as motion, because it is. The match zeroes a busy
        // character's velocity and the lunge then moved the body without
        // saying so, which left an online guest carrying that character on a
        // velocity of nothing between frames — the one moment it most needs
        // carrying, since this is the half-metre that puts the limb on the
        // ball. Written after the zeroing rather than instead of it: outside
        // a lunge a busy character really is still.
        if (dt > 0) this.velocity.copyFrom(this.position.subtract(was).scale(1 / dt));
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
    // Skeletons are not owned by the meshes that use them, so disposing the
    // hierarchy leaves them behind — invisible, since a skeleton with nothing
    // skinned to it draws nothing, and therefore easy to accumulate for the
    // life of the page one loaded character at a time.
    for (const s of this.skeletons) s.dispose();
    this.skeletons = [];
    this.root.dispose(false, true);
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
  /**
   * Above the head, where a bicycle kick is the only thing that reaches.
   *
   * This sat at 0.6 — *below* the header — and since `chooseStrike` offers the
   * flip first, it won nearly every set-up ball above knee height and the
   * header almost never happened. A flip met at chest height is also a flat
   * one: the shot only comes down steeply if the ball was up there to begin
   * with, because the contact height is what decides the angle.
   *
   * So the ladder now reads in the order the shots actually happen: kick it
   * below head height, head it at head height, flip it above. `bandShift`
   * still lowers this by up to `BAND_OVERLAP` for a ball out to the side, so
   * the effective band in play is 0.85–0.92 — a flip is for a ball you got
   * *under*, and reaching for one sideways should be the harder ask.
   */
  backflip: 0.85,
  /** Under this nothing can be struck at all and the ball is only controlled. */
  foot: 0.12,
};

/**
 * The highest contact, in body-height fractions, each kind of touch is planned at.
 *
 * A ball has to come down to the body part playing it, and `touchWait` holds a
 * touch back until it has. The flip is the exception — it is struck above the
 * head, so waiting for the ball to fall to shoulder height is waiting for the
 * shot to be gone.
 *
 * `flip` is a ceiling, not a preference. `canTouch` measures from the chest at
 * 0.55 of height against `PLAYER_REACH`; at 1.15 the ball is ~1.08 m above the
 * chest and only ~1 m of horizontal reach is left. Past about 1.2 the reach
 * sphere closes completely and raising this further does nothing at all.
 */
export const STRIKE_CEILING = {
  /** Anything played off the body: the ball has to have come down to it. */
  normal: 0.9,
  /** A flip is struck above the head, so the ball must still be up there. */
  flip: 1.15,
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
  /**
   * Take the ball on whichever side of the body it actually is, skipping the
   * strong-foot preference inside the centre zone. Used when the feet were
   * owned by the automatic run: the player never chose where to stand relative
   * to the ball, so the side they take it on is not theirs to lose either —
   * the nearest limb is the honest answer.
   */
  forceNearest?: boolean;
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
    candidates.push({ clip: `${side}KneeReception`, part: "knee" });
    candidates.push({ clip: "ChestKick", part: "chest" });
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
  const side = pickSide(lateral, opts.forceNearest ? "both" : strongFoot);
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
 * The yaw a clip is played at, relative to the way the character is facing.
 *
 * Only backflips are turned, and they are turned all the way round. Every clip
 * was captured with the performer facing the camera and kicking away from it,
 * so a rig that faces the table plays them correctly — except this one. A
 * bicycle kick is performed with the **back** to the table: the ball is met
 * above and beyond the head and sent back over it, so the strike travels
 * opposite to the performer's facing and, played unturned, throws the ball away
 * from the table.
 *
 * The measurement that argues against this is real and has been made twice: the
 * turn moves the contact from 1.28 m in front of the player to 1.28 m behind.
 * That is the correct side. A flip that met the ball on the table side would be
 * a volley. If it ever looks wrong again the answer is to re-author the clip —
 * do not flip this constant a third time.
 */
export function clipYawOffset(clip: string): number {
  return clip.startsWith("Backflip") ? Math.PI : 0;
}

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
