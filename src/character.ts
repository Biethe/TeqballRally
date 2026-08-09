import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import {
  contactFraction,
  CHARACTER_SCALE,
  COURT,
  FOOT_FACTOR,
  type CharacterDef,
  type Foot,
} from "./config";
import { fixMetallicMaterials } from "./scene";

const LOCO_CLIPS = ["Idle", "JogForward", "jogBackward", "JogStrafeLeft", "JogStrafeRight"] as const;
type LocoClip = (typeof LOCO_CLIPS)[number];

// The source kits are real shirt textures whose back panel contains a literal
// "NAME" placeholder. It is baked into the albedo map rather than being a
// standalone mesh, so hiding a node cannot remove it. The same atlas layout
// is used by every player: this is the small rear-name strip, deliberately
// ending above the jersey number.
const JERSEY_NAME_MASK = { x: 0.16, y: 0.224, width: 0.205, height: 0.058 };
const JERSEY_TEXTURE_SIZE = 1024;

interface GltfImageRef {
  bufferView?: number;
  mimeType?: string;
}

interface GltfDocument {
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  images?: GltfImageRef[];
  materials?: Array<{
    name?: string;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
  }>;
  textures?: Array<{ source?: number }>;
}

/** Shared, already-redacted shirt canvases, one inexpensive 1024px copy per kit. */
const maskedShirtCanvases = new Map<string, Promise<HTMLCanvasElement | null>>();

interface FracCallback {
  frac: number;
  fn: () => void;
}

/**
 * Remove the template name from a player kit without changing its rig or
 * geometry. Both the match scene and the selector import the same GLBs, so
 * keeping this beside Character makes the treatment identical in each place.
 */
export async function maskJerseyPlaceholder(meshes: AbstractMesh[], id: string): Promise<void> {
  const shirts = new Set<PBRMaterial>();
  for (const mesh of meshes) {
    const material = mesh.material;
    if (material instanceof PBRMaterial && /shirt/i.test(material.name)) shirts.add(material);
  }
  if (shirts.size === 0) return;

  const firstShirt = [...shirts].find((shirt) => shirt.albedoTexture !== null);
  if (!firstShirt?.albedoTexture) return;
  const canvas = await maskedShirtCanvas(id, firstShirt.albedoTexture);
  if (!canvas) return;

  for (const shirt of shirts) {
    const source = shirt.albedoTexture;
    if (!source) continue;
    const invertY = source instanceof Texture ? source.invertY : false;
    const redacted = new DynamicTexture(
      `${id}-shirt-without-template-name`,
      canvas,
      shirt.getScene(),
      !source.noMipmap,
      source.samplingMode,
      undefined,
      invertY
    );
    copyTextureSettings(redacted, source);
    redacted.update(invertY);
    shirt.albedoTexture = redacted;
  }
}

function copyTextureSettings(target: DynamicTexture, source: BaseTexture): void {
  target.hasAlpha = source.hasAlpha;
  target.getAlphaFromRGB = source.getAlphaFromRGB;
  target.level = source.level;
  target.coordinatesIndex = source.coordinatesIndex;
  target.coordinatesMode = source.coordinatesMode;
  target.wrapU = source.wrapU;
  target.wrapV = source.wrapV;
  target.wrapR = source.wrapR;
  target.gammaSpace = source.gammaSpace;
  target.isRGBD = source.isRGBD;
  target.anisotropicFilteringLevel = source.anisotropicFilteringLevel;
  target.optimizeUVAllocation = source.optimizeUVAllocation;
  if (!(source instanceof Texture)) return;
  target.uOffset = source.uOffset;
  target.vOffset = source.vOffset;
  target.uScale = source.uScale;
  target.vScale = source.vScale;
  target.uAng = source.uAng;
  target.vAng = source.vAng;
  target.wAng = source.wAng;
  target.uRotationCenter = source.uRotationCenter;
  target.vRotationCenter = source.vRotationCenter;
  target.wRotationCenter = source.wRotationCenter;
  target.homogeneousRotationInUVTransform = source.homogeneousRotationInUVTransform;
}

function maskedShirtCanvas(id: string, source: BaseTexture): Promise<HTMLCanvasElement | null> {
  let canvas = maskedShirtCanvases.get(id);
  if (!canvas) {
    canvas = createMaskedShirtCanvas(id, source);
    maskedShirtCanvases.set(id, canvas);
  }
  return canvas;
}

async function createMaskedShirtCanvas(id: string, sourceTexture: BaseTexture): Promise<HTMLCanvasElement | null> {
  if (typeof document === "undefined" || typeof createImageBitmap === "undefined") return null;
  try {
    // glTF normally keeps each embedded image behind a blob URL. Reading that
    // small shirt image avoids downloading a second full character GLB.
    let shirtBlob: Blob | null = null;
    const textureUrl = sourceTexture instanceof Texture ? sourceTexture.url ?? "" : "";
    // Babylon represents embedded glTF images as `data:/model.glb#imageN`.
    // That is an internal identifier, not a fetchable data URI, so trying it
    // creates a browser warning before the GLB fallback can take over.
    const canReadTextureUrl = /^(blob:|https?:|\/|data:image\/)/i.test(textureUrl);
    if (canReadTextureUrl) {
      try {
        const response = await fetch(textureUrl);
        if (response.ok) shirtBlob = await response.blob();
      } catch {
        // Some loaders revoke their blob URL after upload; use the GLB fallback.
      }
    }
    if (!shirtBlob) {
      const response = await fetch(`/models/characters/${id}.glb`);
      if (!response.ok) return null;
      const source = shirtImageFromGlb(await response.arrayBuffer());
      if (!source) return null;
      shirtBlob = new Blob([source.bytes], { type: source.mimeType });
    }

    const bitmap = await createImageBitmap(shirtBlob);
    const canvas = document.createElement("canvas");
    canvas.width = JERSEY_TEXTURE_SIZE;
    canvas.height = JERSEY_TEXTURE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    eraseTemplateName(canvas, JERSEY_NAME_MASK);
    return canvas;
  } catch {
    // A failed cosmetic mask should never prevent a player model from loading.
    return null;
  }
}

function shirtImageFromGlb(buffer: ArrayBuffer): { bytes: ArrayBuffer; mimeType: string } | null {
  const view = new DataView(buffer);
  // GLB header: magic "glTF", version, complete byte length.
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return null;

  let json: GltfDocument | null = null;
  let binary: Uint8Array | null = null;
  let cursor = 12;
  while (cursor + 8 <= view.byteLength) {
    const length = view.getUint32(cursor, true);
    const type = view.getUint32(cursor + 4, true);
    const start = cursor + 8;
    const end = start + length;
    if (end > view.byteLength) return null;
    if (type === 0x4e4f534a) {
      const text = new TextDecoder().decode(new Uint8Array(buffer, start, length)).replace(/\0+$/g, "").trim();
      json = JSON.parse(text) as GltfDocument;
    } else if (type === 0x004e4942) {
      binary = new Uint8Array(buffer, start, length);
    }
    cursor = end;
  }
  if (!json || !binary) return null;

  const shirt = json.materials?.find((material) => /shirt/i.test(material.name ?? ""));
  const textureIndex = shirt?.pbrMetallicRoughness?.baseColorTexture?.index;
  const imageIndex = textureIndex === undefined ? undefined : json.textures?.[textureIndex]?.source;
  const image = imageIndex === undefined ? undefined : json.images?.[imageIndex];
  const imageView = image?.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];
  if (!image || !imageView) return null;

  const offset = imageView.byteOffset ?? 0;
  const end = offset + imageView.byteLength;
  if (offset < 0 || end > binary.byteLength) return null;
  // Copy to an owned ArrayBuffer: BlobPart intentionally rejects a view whose
  // buffer could be a SharedArrayBuffer, while GLB's binary chunk is ordinary
  // data we can safely isolate here.
  const bytes = new Uint8Array(new ArrayBuffer(imageView.byteLength));
  bytes.set(binary.subarray(offset, end));
  return { bytes: bytes.buffer, mimeType: image.mimeType ?? "image/jpeg" };
}

/** Paint over NAME using the surrounding shirt pixels, leaving its number intact. */
function eraseTemplateName(canvas: HTMLCanvasElement, rect: typeof JERSEY_NAME_MASK): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = pixels;
  const left = Math.round(rect.x * width);
  const top = Math.round(rect.y * height);
  const right = Math.round((rect.x + rect.width) * width);
  const bottom = Math.round((rect.y + rect.height) * height);
  const sample = (x: number, y: number, channel: number): number => {
    let total = 0;
    let count = 0;
    for (let sy = Math.max(0, y - 2); sy <= Math.min(height - 1, y + 2); sy++) {
      for (let sx = Math.max(0, x - 10); sx <= Math.min(width - 1, x + 10); sx++) {
        total += data[(sy * width + sx) * 4 + channel];
        count++;
      }
    }
    return total / Math.max(1, count);
  };

  for (let y = top; y < bottom; y++) {
    const leftColour = [sample(left - 15, y, 0), sample(left - 15, y, 1), sample(left - 15, y, 2)];
    const rightColour = [sample(right + 15, y, 0), sample(right + 15, y, 1), sample(right + 15, y, 2)];
    for (let x = left; x < right; x++) {
      const t = (x - left) / Math.max(1, right - left - 1);
      // Feather the join very slightly, so the mask follows shirt shading
      // instead of reading as a rectangular label.
      const edge = Math.min(1, Math.min(x - left, right - 1 - x) / 3);
      const p = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const fill = leftColour[channel] * (1 - t) + rightColour[channel] * t;
        data[p + channel] = Math.round(data[p + channel] * (1 - edge) + fill * edge);
      }
    }
  }
  context.putImageData(pixels, 0, 0);
}

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
    await maskJerseyPlaceholder(res.meshes, file);
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

  /** Kinematic move, clamped to this character's half of the court. */
  move(dirX: number, dirZ: number, speed: number, dt: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len > 1) {
      dirX /= len;
      dirZ /= len;
    }
    this.velocity.set(dirX * speed, 0, dirZ * speed);
    const p = this.position;
    p.x += this.velocity.x * dt;
    p.z += this.velocity.z * dt;
    const sideSign = this.faceDir === -1 ? -1 : 1;
    p.x = sideSign * Math.min(COURT.maxX, Math.max(COURT.minX, sideSign * p.x));
    p.z = Math.max(-COURT.maxZ, Math.min(COURT.maxZ, p.z));
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
    return d;
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
    const from = g.from + (opts.startFrac ?? 0) * (g.to - g.from);
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
    let target: LocoClip = "Idle";
    if (speed > 0.4) {
      if (Math.abs(fwd) >= Math.abs(lat)) target = fwd > 0 ? "JogForward" : "jogBackward";
      else target = lat > 0 ? "JogStrafeRight" : "JogStrafeLeft";
    }
    this.currentLoco = target;
    const rate = dt / 0.12;
    for (const name of LOCO_CLIPS) {
      const cur = this.locoWeights.get(name) ?? 0;
      const goal = name === target ? 1 : 0;
      const next = cur + Math.sign(goal - cur) * Math.min(rate, Math.abs(goal - cur));
      if (next !== cur) this.setLocoWeight(name, next);
      const g = this.groups.get(name);
      if (g && next > 0 && !g.isPlaying) g.start(true, 1.0);
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
  strongFoot: Foot | "both" = "both"
): string {
  const rel = ballY / height; // normalised contact height
  const side = pickSide(lateral, strongFoot);
  if (rel > 0.8) {
    if (Math.abs(lateral) > 0.12) return `${side}HeadKick`;
    return Math.random() < 0.65 ? "CenterHeadKick" : `${side}HeadKick`;
  }
  if (rel > 0.62) return Math.random() < 0.7 ? "ChestKick" : `${side}HeadKick`;
  if (rel > 0.45) return Math.random() < 0.65 ? `${side}KneeReception` : "ChestKick";
  // Low ball: a driven foot volley, or an inner-foot touch played as a slow lob.
  return Math.random() < 0.65 ? `${side}FootKick` : `Inner${side}FootReception`;
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
