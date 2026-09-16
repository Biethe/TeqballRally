/**
 * A rally, played without a renderer.
 *
 * Shared by every test that needs a real `MatchController` running real rules
 * over real physics. It lived inside `possession.test.ts` until the serve and
 * the backflip needed it too; nothing about it is specific to possession.
 */
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Ball } from "../src/ball";
import { MatchController, type MatchEvent, type MatchUI } from "../src/match";
import { AIController, DIFFICULTIES, type AIDifficulty } from "../src/ai";
import { bodyPartOf, type Character } from "../src/character";
import { CLIPS, SIM_DT, CHARACTERS, type BodyPart, type CharacterDef } from "../src/config";
import type { InputState } from "../src/input";
import { InteractionVolumeDef, type WorldVolume } from "../src/interaction";
import type { InteractionShape } from "../src/config";

/**
 * A rally, played without a renderer.
 *
 * `MatchController` only ever asks a character for a handful of things: where
 * it is, how tall it is, whether it is busy, where a clip's striking limb will
 * be, and to play a clip that fires callbacks at given fractions. A stand-in
 * that answers those honestly runs whole points through the real rules, the
 * real physics, the real clip selection and the real contact grading — which is
 * the only way to check the things that only exist *between* those parts: that
 * a possession alternates body parts, that a rally survives, and that the same
 * inputs replay to the same rally.
 *
 * The one liberty it takes is the limb: a real clip's contact point is measured
 * off the loaded rig, and here it is derived from the part of the body the clip
 * uses. The fractions are the range a real match measured (0.31 to 0.88 of body
 * height — a kicking foot is not on the floor), which is the relationship these
 * tests read from it.
 */
export const LIMB_HEIGHT: Record<BodyPart, number> = { foot: 0.31, knee: 0.5, chest: 0.62, head: 0.92 };

/** Clips whose contact is nowhere near the body part the rules file them under. */
const CLIP_LIMB_HEIGHT: Record<string, number> = {
  BackflipRightFoot: 1.18,
  BackflipLeftFoot: 1.18,
};

export class FakeCharacter {
  root = { position: new Vector3(), rotation: new Vector3() };
  groups = new Map<string, { from: number; to: number }>();
  velocity = new Vector3();
  faceDir: 1 | -1 = 1;
  effort = 1;
  reserve = 1;
  /** Every clip this possession played, in order, for the assertions below. */
  played: string[] = [];
  /** The start fraction each playAction was given, parallel to `played`. */
  startFracs: number[] = [];
  private action: { name: string; left: number; total: number; callbacks: { frac: number; fn: () => void }[]; onEnd?: () => void } | null = null;
  private lunge: { from: Vector3; to: Vector3; dur: number; t: number } | null = null;
  readonly interactionVolumes = new Map<string, InteractionVolumeDef>();

  constructor(public height: number, public def: CharacterDef) {
    for (const name of Object.keys(CLIPS)) this.groups.set(name, { from: 0, to: CLIPS[name].frames });
    for (const name of ["Idle", "JogForward", "Celebration1", "Defeat"]) {
      this.groups.set(name, { from: 0, to: 60 });
    }
    // Build interaction volumes for test characters
    this.buildInteractionVolumes();
  }

  private buildInteractionVolumes(): void {
    for (const [clip, info] of Object.entries(CLIPS)) {
      if (info.contact < 0) continue;
      const part = bodyPartOf(clip);
      if (!part) continue;
      const dims = { shape: "sphere" as InteractionShape, r: 0.1 };
      this.interactionVolumes.set(clip, {
        clip,
        part,
        shape: "sphere",
        center: [0, this.height * 0.5, 0],
        measuredCenter: [0, this.height * 0.5, 0],
        quat: [0, 0, 0, 1],
        dims,
      });
    }
  }

  contactVolumeTransform(clip: string): WorldVolume | null {
    const def = this.interactionVolumes.get(clip);
    if (!def) return null;
    const cp = this.clipContactPoint(clip);
    const center = cp ? cp.clone() : this.position.add(new Vector3(0, this.height * 0.5, 0));
    return {
      def,
      center,
      rotation: new Quaternion(def.quat[0], def.quat[1], def.quat[2], def.quat[3]),
    };
  }

  get position(): Vector3 {
    return this.root.position;
  }
  get forward(): Vector3 {
    return new Vector3(this.faceDir === -1 ? 1 : -1, 0, 0);
  }
  get busy(): boolean {
    return this.action !== null;
  }
  get currentActionClip(): string | null {
    return this.action?.name ?? null;
  }
  setSide(faceDir: 1 | -1): void {
    this.faceDir = faceDir;
  }
  findNode(): null {
    return null;
  }
  setAnimationsFrozen(): void {}

  clipContactPoint(clip: string): Vector3 | null {
    const part = bodyPartOf(clip);
    if (!part) return null;
    // A flip counts as a foot touch under the rules, and a foot is near the
    // floor — but a bicycle kick meets the ball *above the head*, which is the
    // entire reason the shot exists. Deriving its limb from the body part would
    // plan every flip at ankle height and make any test of one meaningless.
    const rel = CLIP_LIMB_HEIGHT[clip] ?? LIMB_HEIGHT[part];
    return this.position.add(this.forward.scale(0.42)).add(new Vector3(0, this.height * rel, 0));
  }

  playAction(
    name: string,
    opts: { startFrac?: number; speed?: number; callbacks?: { frac: number; fn: () => void }[]; onEnd?: () => void; loop?: boolean } = {}
  ): boolean {
    const info = CLIPS[name];
    if (!this.groups.has(name)) return false;
    if (opts.loop) return true; // idle/locomotion loops need no simulation here
    this.played.push(name);
    this.startFracs.push(opts.startFrac ?? 0);
    const frames = info?.frames ?? 60;
    const start = opts.startFrac ?? 0;
    const total = Math.max(0.05, ((1 - start) * frames) / 60 / (opts.speed ?? 1));
    this.action = {
      name,
      left: total,
      total,
      callbacks: [...(opts.callbacks ?? [])]
        .filter((c) => c.frac >= start)
        .sort((a, b) => a.frac - b.frac)
        .map((c) => ({ frac: (c.frac - start) / Math.max(1e-6, 1 - start), fn: c.fn })),
      onEnd: opts.onEnd,
    };
    return true;
  }

  /** Mirrors `Character.actionFraction`: progress through the whole clip. */
  get actionFraction(): number | null {
    const a = this.action;
    if (!a) return null;
    const start = this.startFracs[this.startFracs.length - 1] ?? 0;
    const through = (a.total - a.left) / Math.max(1e-6, a.total);
    return Math.min(1, Math.max(0, start + through * (1 - start)));
  }

  /** Mirrors `Character.seekAction`: pin the clip to a fraction of itself. */
  seekAction(frac: number): void {
    const a = this.action;
    if (!a) return;
    const start = this.startFracs[this.startFracs.length - 1] ?? 0;
    const through = Math.min(1, Math.max(0, (frac - start) / Math.max(1e-6, 1 - start)));
    a.left = a.total * (1 - through);
  }

  stopAction(): void {
    this.action = null;
    this.lunge = null;
  }

  /**
   * The clip reached its own end, with the tick clock still short of the
   * window that describes it.
   *
   * Not a shortcut: it is the case the real game hits constantly. Babylon
   * advances a clip off the render loop in wall time and the simulation caps
   * its frame delta and drops the remainder, so on anything that stutters the
   * animation finishes first. There is no way to reach that state by stepping
   * this fake, because this fake's clip is driven by the same clock as
   * everything else in it.
   */
  finishActionEarly(): void {
    this.action = null;
  }

  /** Mirrors `Character.cancelActionToLoco`: stop, and land back on the feet. */
  cancelActionToLoco(): void {
    this.stopAction();
  }

  lungeTo(target: Vector3, duration: number): void {
    if (duration < 0.03) return;
    this.lunge = { from: this.position.clone(), to: target.clone(), dur: duration, t: 0 };
  }

  move(dirX: number, dirZ: number, speed: number, dt: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len > 1) {
      dirX /= len;
      dirZ /= len;
    }
    this.velocity.set(dirX * speed, 0, dirZ * speed);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
  }

  moveToward(target: Vector3, speed: number, dt: number): number {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      this.velocity.setAll(0);
      return 0;
    }
    const step = Math.min(d, speed * dt);
    this.position.x += (dx / d) * step;
    this.position.z += (dz / d) * step;
    this.velocity.set((dx / d) * speed, 0, (dz / d) * speed);
    return d - step;
  }

  update(dt: number): void {
    const l = this.lunge;
    if (l) {
      l.t = Math.min(l.dur, l.t + dt);
      const p = l.t / l.dur;
      this.position.copyFrom(Vector3.Lerp(l.from, l.to, p * p * (3 - 2 * p)));
      if (l.t >= l.dur) this.lunge = null;
    }
    const a = this.action;
    if (!a) return;
    a.left -= dt;
    const frac = 1 - a.left / a.total;
    while (a.callbacks.length > 0 && frac >= a.callbacks[0].frac) a.callbacks.shift()!.fn();
    if (a.left <= 0) {
      const done = a.onEnd;
      for (const cb of a.callbacks) cb.fn();
      this.action = null;
      this.lunge = null;
      done?.();
    }
  }
}

export const silentUI = (): MatchUI => ({
  setScore: () => {},
  banner: () => {},
  hint: () => {},
  onMatchEnd: () => {},
  meter: () => {},
  stamina: () => {},
  meterResult: () => {},
});

export const silentAudio = { playKick: () => {}, playApplause: () => {} };

export const idle: InputState = {
  moveX: 0,
  moveZ: 0,
  strikePressed: false,
  strikeHeld: false,
  strikePower: 0,
  popPressed: false,
  confirmPressed: false,
};

export interface Rig {
  match: MatchController;
  player: FakeCharacter;
  ai: FakeCharacter;
  events: MatchEvent[];
  step(seconds: number, input?: Partial<InputState>): void;
}

/** A match with both characters faked, and the real AI on the far side. */
export function rig(opts: { def?: CharacterDef; difficulty?: AIDifficulty; ui?: MatchUI } = {}): Rig {
  const def = opts.def ?? CHARACTERS[0];
  const ball = new Ball();
  const player = new FakeCharacter(1.8, def);
  const ai = new FakeCharacter(1.8, def);
  const match = new MatchController(
    ball,
    player as unknown as Character,
    ai as unknown as Character,
    opts.ui ?? silentUI(),
    silentAudio as never
  );
  const cpu = new AIController(match, opts.difficulty ?? DIFFICULTIES.normal);
  const events: MatchEvent[] = [];
  match.subscribe((e) => events.push(e));
  return {
    match,
    player,
    ai,
    events,
    step(seconds, input = {}) {
      const steps = Math.round(seconds / SIM_DT);
      for (let i = 0; i < steps; i++) {
        // Edge flags belong to one step, exactly as the real latch delivers them.
        const frame: InputState = { ...idle, ...(i === 0 ? input : {}) };
        match.update(SIM_DT, frame, (dt) => cpu.update(dt));
      }
    },
  };
}

/** Serve, then let the rally run for a while. */
export function playPoint(r: Rig, seconds = 8): void {
  r.step(3); // walk to the service line
  r.step(0.2, { strikePressed: true });
  r.step(seconds);
}

/**
 * The same, with the player asking for a set-up touch every so often — a
 * stand-in for someone actually building a possession rather than taking the
 * automatic first touch and stopping.
 */
export function playBuiltPoint(r: Rig, seconds = 8): void {
  r.step(3);
  r.step(0.2, { strikePressed: true });
  for (let i = 0; i < Math.round(seconds / 0.4); i++) r.step(0.4, { popPressed: true });
}

