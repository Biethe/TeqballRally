import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ball, solveLaunchClearingNet } from "../src/ball";
import { MatchController, type MatchEvent, type MatchUI } from "../src/match";
import { AIController, DIFFICULTIES, type AIDifficulty } from "../src/ai";
import { bodyPartOf, type Character } from "../src/character";
import {
  CLIPS,
  GROUND_Y,
  MAX_TOUCHES,
  SIM_DT,
  SPAWN,
  CHARACTERS,
  PLAYER_REACH,
  tableSurfaceY,
  type BodyPart,
  type CharacterDef,
} from "../src/config";
import type { InputState } from "../src/input";

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
const LIMB_HEIGHT: Record<BodyPart, number> = { foot: 0.31, knee: 0.5, chest: 0.62, head: 0.92 };

class FakeCharacter {
  root = { position: new Vector3(), rotation: new Vector3() };
  groups = new Map<string, { from: number; to: number }>();
  velocity = new Vector3();
  faceDir: 1 | -1 = 1;
  effort = 1;
  reserve = 1;
  /** Every clip this possession played, in order, for the assertions below. */
  played: string[] = [];
  private action: { name: string; left: number; total: number; callbacks: { frac: number; fn: () => void }[]; onEnd?: () => void } | null = null;
  private lunge: { from: Vector3; to: Vector3; dur: number; t: number } | null = null;

  constructor(public height: number, public def: CharacterDef) {
    for (const name of Object.keys(CLIPS)) this.groups.set(name, { from: 0, to: CLIPS[name].frames });
    for (const name of ["Idle", "JogForward", "Celebration1", "Defeat"]) {
      this.groups.set(name, { from: 0, to: 60 });
    }
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
  actionFraction(): number | null {
    if (!this.action) return null;
    return 1 - this.action.left / this.action.total;
  }

  clipContactPoint(clip: string): Vector3 | null {
    const part = bodyPartOf(clip);
    if (!part) return null;
    return this.position.add(this.forward.scale(0.42)).add(new Vector3(0, this.height * LIMB_HEIGHT[part], 0));
  }

  playAction(
    name: string,
    opts: { startFrac?: number; speed?: number; callbacks?: { frac: number; fn: () => void }[]; onEnd?: () => void; loop?: boolean } = {}
  ): boolean {
    const info = CLIPS[name];
    if (!this.groups.has(name)) return false;
    if (opts.loop) return true; // idle/locomotion loops need no simulation here
    this.played.push(name);
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

  stopAction(): void {
    this.action = null;
    this.lunge = null;
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

const silentUI = (): MatchUI => ({
  setScore: () => {},
  banner: () => {},
  hint: () => {},
  onMatchEnd: () => {},
  meter: () => {},
  stamina: () => {},
  meterResult: () => {},
});

const silentAudio = { playKick: () => {}, playApplause: () => {} };

const idle: InputState = {
  moveX: 0,
  moveZ: 0,
  strikePressed: false,
  strikeHeld: false,
  strikePower: 0,
  popPressed: false,
  confirmPressed: false,
};

interface Rig {
  match: MatchController;
  player: FakeCharacter;
  ai: FakeCharacter;
  events: MatchEvent[];
  step(seconds: number, input?: Partial<InputState>): void;
}

/** A match with both characters faked, and the real AI on the far side. */
function rig(opts: { def?: CharacterDef; difficulty?: AIDifficulty; ui?: MatchUI } = {}): Rig {
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
function playPoint(r: Rig, seconds = 8): void {
  r.step(3); // walk to the service line
  r.step(0.2, { strikePressed: true });
  r.step(seconds);
}

/**
 * The same, with the player asking for a set-up touch every so often — a
 * stand-in for someone actually building a possession rather than taking the
 * automatic first touch and stopping.
 */
function playBuiltPoint(r: Rig, seconds = 8): void {
  r.step(3);
  r.step(0.2, { strikePressed: true });
  for (let i = 0; i < Math.round(seconds / 0.4); i++) r.step(0.4, { popPressed: true });
}

describe("a possession, played through the real rules", () => {
  it("gets the ball over the net and into a rally", () => {
    const r = rig();
    playPoint(r, 6);

    const launched = r.events.filter((e) => e.type === "ball-launched");
    expect(launched.length).toBeGreaterThan(1);
    expect(launched[0]).toMatchObject({ action: "serve" });
  });

  it("never plays the same part of the body twice in a row", () => {
    // The teqball rule, checked where it actually has to hold: across the clips
    // real possessions chose, in real rallies, rather than across a picker
    // called by hand. Read off the launch events, which name the clip that sent
    // the ball, so this sees exactly what the player saw.
    const r = rig();
    const possession: Record<string, BodyPart[]> = { player: [], ai: [] };
    const pairs: [BodyPart, BodyPart][] = [];
    r.match.subscribe((e) => {
      if (e.type === "possession-start") possession[e.side] = [];
      if (e.type === "ball-launched" && e.action !== "serve") {
        const part = bodyPartOf(e.clip);
        if (!part) return;
        const seq = possession[e.side];
        if (seq.length > 0) pairs.push([seq[seq.length - 1], part]);
        seq.push(part);
      }
    });
    for (let point = 0; point < 8; point++) playBuiltPoint(r, 7);

    // The rallies have to have actually produced multi-touch possessions, or
    // there is nothing here to have checked.
    expect(pairs.length).toBeGreaterThan(2);
    for (const [before, after] of pairs) expect(after, `${before} -> ${after}`).not.toBe(before);
  });

  it("keeps a possession inside the touch allowance", () => {
    const r = rig();
    for (let point = 0; point < 5; point++) playPoint(r, 7);

    expect(r.match.touchCount).toBeLessThanOrEqual(MAX_TOUCHES);
  });

  it("chooses the same touches however the dice fall", () => {
    // Determinism where it counts. The landing spread is deliberately random
    // — pace has to cost accuracy — so two rallies never end up ball-for-ball
    // identical. What must never vary is the *decision*: which limb plays the
    // ball, and therefore what the player can do next. Running the same inputs
    // against two very different random streams pins exactly that.
    const played = (value: number): string[] => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(value);
      try {
        const r = rig();
        r.step(3);
        r.step(0.2, { strikePressed: true, moveX: 0.4, moveZ: -0.2 });
        r.step(1.4);
        return r.player.played;
      } finally {
        spy.mockRestore();
      }
    };

    expect(played(0.12)).toEqual(played(0.87));
  });

  it("replays a rally exactly when nothing is left to chance", () => {
    // With the declared spread held still, two runs of the same inputs have to
    // agree to the last decimal — anything else would be a second, undeclared
    // source of variation somewhere in the simulation.
    const run = (): number[] => {
      const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
      try {
        const r = rig();
        r.step(3);
        r.step(0.2, { strikePressed: true, moveX: 0.4, moveZ: -0.2 });
        r.step(2.2);
        const b = r.match.ball.state;
        return [b.pos.x, b.pos.y, b.pos.z, r.player.position.x, r.player.position.z];
      } finally {
        spy.mockRestore();
      }
    };

    expect(run()).toEqual(run());
  });
});

describe("what a contact is worth", () => {
  /**
   * Receive one fed ball, asking for the touch either the moment it comes
   * within reach — while it is still up on the body — or once it has fallen
   * below a given height.
   *
   * The grade comes back off the HUD flash, which is the game's own reading of
   * the contact rather than a number this test worked out for itself.
   */
  function receive(press: "in reach" | number): { quality: number; clip: string } | null {
    const graded: number[] = [];
    const ui = silentUI();
    ui.meterResult = (q) => graded.push(q);
    const r = rig({ ui });
    // The press is the point of this test, so the automatic first touch is off
    // — exactly as it is in practice mode.
    r.match.autoFirstReception = false;
    r.step(0.5);
    r.match.state = "rally";
    r.match.lastHitter = "ai";
    r.match.strikeableSide = null;
    r.match.touchCount = 0;
    let clip: string | null = null;
    r.match.subscribe((e) => {
      if (e.type === "ball-launched" && e.action === "pop" && e.side === "player") clip ??= e.clip;
    });
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    const target = new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(solveLaunchClearingNet(from, target, 1.35));
    // Both runs are played from the same place, under where the ball will come
    // down: this is about when the touch was asked for, not where anybody stood.
    r.step(0.35);
    const anchor = (r.match as unknown as { anchor: Record<string, Vector3 | null> }).anchor.player;
    if (!anchor) return null;
    r.player.position.set(anchor.x, GROUND_Y, anchor.z);
    let pressed = false;
    let above = r.match.ball.state.pos.y;
    for (let i = 0; i < 60 * 4 && r.match.state === "rally" && clip === null; i++) {
      const ball = r.match.ball.state.pos;
      const dropping = ball.y < above;
      above = ball.y;
      const chest = r.player.position.add(new Vector3(0, r.player.height * 0.55, 0));
      const mine = r.match.strikeableSide === "player";
      const due =
        press === "in reach"
          ? mine && Vector3.Distance(chest, ball) <= PLAYER_REACH
          : mine && dropping && ball.y - GROUND_Y < press;
      const now = due && !pressed;
      if (now) pressed = true;
      r.match.update(SIM_DT, { ...idle, popPressed: now }, () => {});
    }
    if (clip === null || graded.length === 0) return null;
    return { quality: graded[0], clip };
  }

  it("grades a ball met properly above one left until the last moment", () => {
    // Test 3, at the seam where the grade meets the ball, and measured off the
    // game's own reading of the contact rather than a number this test worked
    // out for itself.
    //
    // Both are touches: a press is never swallowed, and a player who grabs at
    // the ball late still keeps the rally alive. What differs is what they get
    // for it — and it is worth reading the direction carefully. Meeting the
    // ball early, up on the body, is the *good* contact; leaving it until it is
    // nearly on the floor is the poor one. That is the sport, and it is why
    // timing here is a thing to feel rather than a bar to hit.
    const met = receive("in reach");
    const late = receive(0.35);

    expect(met).not.toBeNull();
    expect(late).not.toBeNull();
    expect(met!.quality).toBeGreaterThan(late!.quality + 0.2);
    // The floor under a grade is what keeps a beginner in the rally.
    expect(late!.quality).toBeGreaterThan(0.1);
  });

  it("plays the ball with a different part of the body for it", () => {
    // The other half of the same fact, and the reason this is not a rhythm
    // game: taking the ball early is a chest touch and letting it drop is a
    // foot touch, so *when* is also a choice about *what*.
    expect(receive("in reach")!.clip).not.toBe(receive(0.35)!.clip);
  });
});

describe("staying with the ball", () => {
  /** Put a ball on its way to the player's half, as a return from the far side. */
  function feedPlayer(r: Rig): void {
    // Straight into a rally: no serve to finish, so nothing else is moving the
    // ball while the reception is being watched.
    r.step(0.5);
    r.match.state = "rally";
    r.match.lastHitter = "ai";
    r.match.strikeableSide = null;
    r.match.touchCount = 0;
    r.player.position.set(-SPAWN.x, GROUND_Y, 0);
    r.player.played.length = 0;
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    const target = new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(solveLaunchClearingNet(from, target, 1.35));
  }

  /**
   * Run the ball in, holding `input` for `holdFor` seconds and then letting go,
   * and report whether the player got a touch and how far they travelled.
   */
  function chase(input: Partial<InputState>, holdFor = 3): { touched: string[]; moved: number } {
    const r = rig();
    feedPlayer(r);
    const from = r.player.position.clone();
    for (let i = 0; i < 60 * 3 && r.match.state === "rally"; i++) {
      const held = i * SIM_DT < holdFor ? input : {};
      r.match.update(SIM_DT, { ...idle, ...held }, () => {});
    }
    return {
      touched: r.player.played.filter((c) => bodyPartOf(c) !== null),
      moved: Vector3.Distance(from, r.player.position),
    };
  }

  it("keeps a drifting player connected to the ball", () => {
    // Acceptance test 1, and the failure the zone exists for: a player who
    // pushes away from an incoming ball for a moment — finishing a run,
    // repositioning, or simply not looking — must not lose a reception that
    // was there to be made.
    const drifted = chase({ moveX: -1, moveZ: 0.8 }, 0.4);

    expect(drifted.touched.length).toBeGreaterThan(0);
    // They really did move: this is not a player who was pinned in place.
    expect(drifted.moved).toBeGreaterThan(0.8);
  });

  it("still lets a player who means to leave, leave", () => {
    // The other half of it. A soft boundary a player cannot push against is a
    // movement lock; holding the direction for the whole flight takes them out
    // of the play, and that is their decision to make.
    const gone = chase({ moveX: -1, moveZ: 0.8 }, 3);
    const drifted = chase({ moveX: -1, moveZ: 0.8 }, 0.4);

    expect(gone.moved).toBeGreaterThan(drifted.moved + 1);
  });

  it("leaves the choice of where to meet the ball to the player", () => {
    // Test 2: the same incoming ball, met from one side of it or the other, is
    // a different touch. This is the skill the zone is protecting room for —
    // and the reason it is a zone rather than a spot the game moves you to.
    const met = (offsetZ: number): string | undefined => {
      const r = rig();
      feedPlayer(r);
      r.player.position.z += offsetZ;
      for (let i = 0; i < 60 * 3 && r.match.state === "rally"; i++) {
        r.match.update(SIM_DT, idle, () => {});
      }
      return r.player.played.find((c) => bodyPartOf(c) !== null);
    };

    const left = met(0.7);
    const right = met(-0.7);

    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left).not.toBe(right);
  });
});
