import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  CLIP_CONTACT_BONE,
  HEAD_CONTACT_PUSH,
  MOVE_TAU,
  SERVE_CLIPS,
  SERVE_TOSS_HAND,
  approachVelocity,
  MIN_EFFORT,
  backflipAllowed,
  backflipFoot,
  clipFoot,
  footFactor,
  locoBlend,
  locoStride,
  type LocoWeights,
  pickReceptionClip,
  chooseStrike,
  STRIKE_BANDS,
  strikeBackflipFoot,
  onWeakSide,
  serveClipForAim,
  serveContactOffset,
} from "../src/character";
import { MAX_LEVEL, withCareer } from "../src/progress";
import { CHARACTERS, CLIPS, FOOT_FACTOR, type CharacterDef, type Foot } from "../src/config";

/** Replace Math.random with a fixed sequence so clip choices are deterministic. */
function stubRandom(...values: number[]) {
  let i = 0;
  return vi.spyOn(Math, "random").mockImplementation(() => values[Math.min(i++, values.length - 1)]);
}

const player = (over: Partial<CharacterDef> = {}): CharacterDef => ({
  id: "TestPlayer",
  label: "TEST",
  height: 1.8,
  strongFoot: "right",
  weakFoot: 70,
  speed: 4.5,
  power: 1,
  precision: 1,
  backflips: "both",
  stamina: 1,
  serve: 1,
  agility: 1,
  volley: 1,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clipFoot", () => {
  it("reads the foot out of foot-clip names", () => {
    expect(clipFoot("RightFootKick")).toBe("right");
    expect(clipFoot("LeftFootKick")).toBe("left");
    expect(clipFoot("BackflipRightFoot")).toBe("right");
    expect(clipFoot("BackflipLeftFoot")).toBe("left");
    expect(clipFoot("InnerRightFootReception")).toBe("right");
    expect(clipFoot("InnerLeftFootReception")).toBe("left");
    expect(clipFoot("ServeRightFoot")).toBe("right");
    expect(clipFoot("ServeLeftFoot")).toBe("left");
  });

  it("is null for head, chest and knee clips", () => {
    // A "Right"/"Left" in the name is not enough — the limb has to be a foot.
    for (const clip of [
      "CenterHeadKick",
      "RightHeadKick",
      "LeftHeadKick",
      "ChestKick",
      "ChestReception",
      "ChestPrepLeft",
      "RightKneeReception",
      "LeftKneeReception",
      "HeadServeLeft",
      "HeadServeRight",
      "Idle",
    ]) {
      expect(clipFoot(clip), clip).toBeNull();
    }
  });
});

describe("footFactor", () => {
  it("rewards the strong foot and penalises the weak one", () => {
    const righty = player({ strongFoot: "right" });

    expect(footFactor(righty, "RightFootKick")).toEqual(FOOT_FACTOR.strong);
    expect(footFactor(righty, "LeftFootKick")).toEqual(FOOT_FACTOR.weak);
  });

  it("is neutral for two-footed players", () => {
    const both = player({ strongFoot: "both" });

    expect(footFactor(both, "RightFootKick")).toEqual({ power: 1, spray: 1 });
    expect(footFactor(both, "LeftFootKick")).toEqual({ power: 1, spray: 1 });
  });

  it("is neutral for clips that use no foot", () => {
    const righty = player({ strongFoot: "right" });

    expect(footFactor(righty, "CenterHeadKick")).toEqual({ power: 1, spray: 1 });
    expect(footFactor(righty, "ChestKick")).toEqual({ power: 1, spray: 1 });
  });

  it("makes the strong foot stronger and tighter than the weak foot", () => {
    expect(FOOT_FACTOR.strong.power).toBeGreaterThan(FOOT_FACTOR.weak.power);
    expect(FOOT_FACTOR.strong.spray).toBeLessThan(FOOT_FACTOR.weak.spray);
  });

  it("applies to every foot clip in the game", () => {
    const lefty = player({ strongFoot: "left" });
    const footClips = Object.keys(CLIPS).filter((c) => clipFoot(c) !== null);

    expect(footClips.length).toBeGreaterThan(0);
    for (const clip of footClips) {
      const expected = clipFoot(clip) === "left" ? FOOT_FACTOR.strong : FOOT_FACTOR.weak;
      expect(footFactor(lefty, clip), clip).toEqual(expected);
    }
  });
});

describe("backflipFoot", () => {
  /**
   * The foot follows the *stance*, not the ball. A backflip is a whole-body
   * rotation already committed to, and the leg that comes over is the one on
   * the outside of the court — which is what a player watching it expects and
   * what the old ball-relative choice got wrong.
   */
  const both = player({ backflips: "both", strongFoot: "both" });

  it("flips off the right foot on the right of the court, and the left on the left", () => {
    expect(backflipFoot(1.2, both)).toBe("right");
    expect(backflipFoot(-1.2, both)).toBe("left");
  });

  it("is signed in the player's own frame, so both ends agree", () => {
    // `stance` is positive to the player's right, exactly like the `lateral`
    // handed to pickStrikeClip. The AI faces the other way and its stance is
    // mirrored before it gets here, so the same sign means the same side.
    expect(backflipFoot(0.4, both)).toBe("right");
    expect(backflipFoot(-0.4, both)).toBe("left");
  });

  it("lets a one-footed flipper use their foot from the middle", () => {
    const righty = player({ backflips: "strong", strongFoot: "right" });

    // Standing on their left, where the natural foot would be the left one.
    expect(backflipFoot(-0.2, righty)).toBe("right");
  });

  it("will not contort them from the far side of the court", () => {
    const righty = player({ backflips: "strong", strongFoot: "right" });

    expect(backflipFoot(-1.5, righty)).toBeNull();
  });

  it("gives nothing to a player who does not flip", () => {
    const grounded = player({ backflips: "none", strongFoot: "right" });

    expect(backflipFoot(1, grounded)).toBeNull();
    expect(backflipFoot(-1, grounded)).toBeNull();
  });
});

describe("backflipAllowed", () => {
  const feet: Foot[] = ["left", "right"];

  it('refuses both feet when backflips are "none"', () => {
    const def = player({ backflips: "none", strongFoot: "right" });

    for (const foot of feet) expect(backflipAllowed(def, foot), foot).toBe(false);
  });

  it('allows both feet when backflips are "both"', () => {
    const def = player({ backflips: "both", strongFoot: "right" });

    for (const foot of feet) expect(backflipAllowed(def, foot), foot).toBe(true);
  });

  it('allows only the strong foot when backflips are "strong"', () => {
    const def = player({ backflips: "strong", strongFoot: "left" });

    expect(backflipAllowed(def, "left")).toBe(true);
    expect(backflipAllowed(def, "right")).toBe(false);
  });

  it('lets a two-footed "strong" player flip off either foot', () => {
    const def = player({ backflips: "strong", strongFoot: "both" });

    for (const foot of feet) expect(backflipAllowed(def, foot), foot).toBe(true);
  });

  it("matches the roster's documented flip abilities", () => {
    const byLabel = Object.fromEntries(CHARACTERS.map((c) => [c.label, c]));

    expect(backflipAllowed(byLabel.BRAZIL, "left")).toBe(true);
    expect(backflipAllowed(byLabel.BRAZIL, "right")).toBe(true);
    expect(backflipAllowed(byLabel.ENGLAND, "right")).toBe(false);
    expect(backflipAllowed(byLabel.FRANCE, "left")).toBe(true);
    expect(backflipAllowed(byLabel.FRANCE, "right")).toBe(false);
    expect(backflipAllowed(byLabel.SPAIN, "left")).toBe(true);
    expect(backflipAllowed(byLabel.SPAIN, "right")).toBe(true);
  });
});

describe("serveClipForAim", () => {
  it("serves cross-body: aim left with the right foot, aim right with the left", () => {
    expect(serveClipForAim(0.9)).toBe("ServeRightFoot");
    expect(serveClipForAim(0.26)).toBe("ServeRightFoot");
    expect(serveClipForAim(-0.9)).toBe("ServeLeftFoot");
    expect(serveClipForAim(-0.26)).toBe("ServeLeftFoot");
  });

  it("uses a head serve inside the central dead band", () => {
    stubRandom(0.1);
    expect(serveClipForAim(0)).toBe("HeadServeRight");
    expect(serveClipForAim(0.25)).toBe("HeadServeRight");
    expect(serveClipForAim(-0.25)).toBe("HeadServeRight");

    vi.restoreAllMocks();
    stubRandom(0.9);
    expect(serveClipForAim(0)).toBe("HeadServeLeft");
  });

  it("only ever returns a known serve clip", () => {
    for (let i = 0; i < 400; i++) {
      const clip = serveClipForAim((i / 400) * 2 - 1);
      expect(SERVE_CLIPS as readonly string[]).toContain(clip);
    }
  });
});

describe("pickReceptionClip", () => {
  const height = 1.8;

  it("chests a high ball, knees a mid one and uses the inner foot low", () => {
    stubRandom(0.99);
    expect(pickReceptionClip(height * 0.8, 0.5, height, "both", 0)).toBe("ChestPrepRight");
    vi.restoreAllMocks();
    stubRandom(0);
    expect(pickReceptionClip(height * 0.8, 0.5, height, "both", 0)).toBe("ChestReception");
    expect(pickReceptionClip(height * 0.5, 0.5, height, "both", 0)).toBe("RightKneeReception");
    expect(pickReceptionClip(height * 0.2, 0.5, height, "both", 0)).toBe("InnerRightFootReception");
  });

  it("picks the side from the lateral offset", () => {
    stubRandom(0);
    expect(pickReceptionClip(height * 0.2, -0.5, height, "both", 0)).toBe("InnerLeftFootReception");
    expect(pickReceptionClip(height * 0.5, -0.5, height, "both", 0)).toBe("LeftKneeReception");
  });

  it("uses more than one clip for the same ball", () => {
    // The complaint this exists for: a rally played the same three animations
    // over and over. Contact heights measured over a real match run 0.31 to
    // 0.88 of body height with a median of 0.75, so a hard-edged band meant one
    // clip owned nearly every touch at a given height. Handing the same ball
    // to the picker repeatedly must now produce a spread.
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(pickReceptionClip(height * 0.47, 0.02, height));

    expect(seen.size).toBeGreaterThan(2);
  });

  it("only ever returns a real clip with a contact frame", () => {
    for (let i = 0; i < 2000; i++) {
      const ballY = Math.random() * height * 1.2;
      const lateral = Math.random() * 1.6 - 0.8;
      const clip = pickReceptionClip(ballY, lateral, height, "left");
      expect(CLIPS[clip], clip).toBeDefined();
      expect(CLIPS[clip].contact, clip).toBeGreaterThan(0);
    }
  });

  it("never returns a hard strike clip", () => {
    const strikes = ["RightFootKick", "LeftFootKick", "CenterHeadKick", "ChestKick"];
    for (let i = 0; i < 2000; i++) {
      const clip = pickReceptionClip(Math.random() * height * 1.2, Math.random() * 1.6 - 0.8, height);
      expect(strikes, clip).not.toContain(clip);
    }
  });
});

describe("serveContactOffset", () => {
  const forward = new Vector3(1, 0, 0);

  it("puts a head serve at head height, close to the body", () => {
    const o = serveContactOffset("HeadServeRight", forward, 1.8);

    expect(o.y).toBeCloseTo(1.8 * 0.93, 10);
    expect(o.x).toBeCloseTo(0.32, 10);
  });

  it("puts a foot serve low and further out in front", () => {
    const o = serveContactOffset("ServeRightFoot", forward, 1.8);

    expect(o.y).toBeCloseTo(1.8 * 0.3, 10);
    expect(o.x).toBeCloseTo(0.55, 10);
  });

  it("is always in front of the server and above their feet", () => {
    for (const clip of SERVE_CLIPS) {
      const o = serveContactOffset(clip, forward, 1.8);
      expect(o.x, clip).toBeGreaterThan(0);
      expect(o.y, clip).toBeGreaterThan(0);
      expect(o.y, clip).toBeLessThan(1.8);
    }
  });

  it("follows the facing direction", () => {
    const o = serveContactOffset("ServeLeftFoot", new Vector3(0, 0, -1), 1.8);

    expect(o.x).toBeCloseTo(0, 10);
    expect(o.z).toBeCloseTo(-0.55, 10);
  });

  it("scales the contact height with the character", () => {
    const tall = serveContactOffset("HeadServeLeft", forward, 2.0);
    const shortPlayer = serveContactOffset("HeadServeLeft", forward, 1.6);

    expect(tall.y).toBeGreaterThan(shortPlayer.y);
  });
});

describe("contact bone tables", () => {
  it("names a bone for every clip that touches the ball", () => {
    const contactClips = Object.entries(CLIPS)
      .filter(([, info]) => info.contact >= 0)
      .map(([name]) => name);

    expect(Object.keys(CLIP_CONTACT_BONE).sort()).toEqual(contactClips.sort());
  });

  it("names no bone for clips that never touch the ball", () => {
    for (const clip of ["Idle", "JogForward", "Celebration1", "Defeat"]) {
      expect(CLIP_CONTACT_BONE[clip], clip).toBeUndefined();
    }
  });

  it("puts the contact bone on the foot the clip name announces", () => {
    for (const [clip, bone] of Object.entries(CLIP_CONTACT_BONE)) {
      const foot = clipFoot(clip);
      if (!foot) continue;
      expect(bone, clip).toBe(foot === "left" ? "LeftFoot" : "RightFoot");
    }
  });

  it("gives every serve a tossing hand", () => {
    expect(Object.keys(SERVE_TOSS_HAND).sort()).toEqual([...SERVE_CLIPS].sort());
    for (const clip of SERVE_CLIPS) {
      expect(SERVE_TOSS_HAND[clip], clip).toMatch(/^(Left|Right)Hand$/);
    }
  });

  it("pushes head contacts clear of the skull", () => {
    expect(HEAD_CONTACT_PUSH).toBeGreaterThan(0);
    for (const [clip, bone] of Object.entries(CLIP_CONTACT_BONE)) {
      if (bone !== "Head") continue;
      expect(clip, clip).toMatch(/Head/);
    }
  });
});

describe("approachVelocity", () => {
  const dt = 1 / 60;

  it("gets a standing player almost up to speed inside a sixth of a second", () => {
    let v = 0;
    for (let i = 0; i < 9; i++) v = approachVelocity(v, 5, dt);

    // Nine 60 Hz frames is 0.15 s: the run has to be all but there by then, or
    // a shift asked for on the far side of the court arrives late.
    expect(v).toBeGreaterThan(5 * 0.93);
    expect(v).toBeLessThan(5);
  });

  it("answers on the very first frame", () => {
    // Weight, not input lag: something has to happen the frame it is asked for.
    expect(approachVelocity(0, 5, dt)).toBeGreaterThan(5 * 0.2);
  });

  it("brakes rather than stopping dead", () => {
    const braked = approachVelocity(5, 0, dt);

    expect(braked).toBeLessThan(5);
    expect(braked).toBeGreaterThan(0);
  });

  it("turns around through zero instead of flipping", () => {
    // Reversing at full pace must cost the momentum first, so a player who
    // changes their mind leans out of the old direction.
    expect(approachVelocity(5, -5, dt)).toBeGreaterThan(0);
  });

  it("never overshoots what it was asked for", () => {
    let v = 0;
    for (let i = 0; i < 240; i++) {
      v = approachVelocity(v, 5, dt);
      expect(v).toBeLessThanOrEqual(5);
    }
    expect(v).toBeCloseTo(5, 6);
  });

  it("snaps when a frame is longer than the time constant", () => {
    // A stalled frame must not leave the velocity behind by an arbitrary amount.
    expect(approachVelocity(0, 5, MOVE_TAU * 4)).toBe(5);
  });
});

describe("the traits that decide a rally", () => {
  /**
   * Four attributes that had to change how a match plays rather than only how
   * a card reads. Each is checked where it actually bites.
   */

  it("gives every character all of them", () => {
    for (const def of CHARACTERS) {
      for (const key of ["stamina", "serve", "agility", "volley"] as const) {
        expect(def[key], `${def.label} ${key}`).toBeGreaterThan(0.5);
        expect(def[key], `${def.label} ${key}`).toBeLessThan(1.5);
      }
    }
  });

  it("makes nobody best at everything", () => {
    // The roster's whole job: differently good, not better and worse. A
    // character that led every column would make the other three decorative.
    const keys = ["speed", "power", "precision", "stamina", "serve", "agility", "volley"] as const;
    for (const def of CHARACTERS) {
      const behind = keys.filter((k) => CHARACTERS.some((other) => other[k] > def[k]));
      expect(behind.length, `${def.label} leads everything`).toBeGreaterThan(0);
    }
  });

  it("starts a run faster for an agile player", () => {
    // Agility is acceleration, not top speed: the same request, reached sooner.
    const quick = approachVelocity(0, 5, 1 / 60, MOVE_TAU / 1.35);
    const heavy = approachVelocity(0, 5, 1 / 60, MOVE_TAU / 0.7);

    expect(quick).toBeGreaterThan(heavy);
  });

  it("never lets tiredness stop a player moving at all", () => {
    // The floor matters more than the drain. Attacking means running to the
    // middle line and back, so a punishing stamina model would make one brave
    // point cost the game.
    expect(MIN_EFFORT).toBeGreaterThan(0.5);
    const spent = approachVelocity(0, 5, 1 / 60, MOVE_TAU / MIN_EFFORT);
    expect(spent).toBeGreaterThan(0);
  });

  it("trains effort without erasing the character that was picked", () => {
    const brazil = CHARACTERS.find((c) => c.label === "BRAZIL")!;
    const england = CHARACTERS.find((c) => c.label === "ENGLAND")!;
    const trainedBrazil = withCareer(brazil, MAX_LEVEL);
    const trainedEngland = withCareer(england, MAX_LEVEL);

    // Levelling lifts them…
    expect(trainedBrazil.agility).toBeGreaterThan(brazil.agility);
    expect(trainedBrazil.stamina).toBeGreaterThan(brazil.stamina);
    // …and the acrobat is still quicker than the powerhouse, and the
    // powerhouse still lasts longer, after both have trained to the cap.
    expect(trainedBrazil.agility).toBeGreaterThan(trainedEngland.agility);
    expect(trainedEngland.stamina).toBeGreaterThan(trainedBrazil.stamina);
  });

  it("leaves the traits that are technique alone when levelling", () => {
    // Serve and volley are things you can do, not effort you can put in.
    const def = CHARACTERS[0];
    const trained = withCareer(def, MAX_LEVEL);

    expect(trained.serve).toBe(def.serve);
    expect(trained.volley).toBe(def.volley);
    expect(trained.power).toBe(def.power);
    expect(trained.speed).toBe(def.speed);
  });
});

describe("locomotion blending", () => {
  /** Sideways weight, whichever gait is carrying it. */
  const side = (w: LocoWeights) =>
    w.JogStrafeLeftInPlace + w.JogStrafeRightInPlace +
    w.WalkStrafeLeftInPlace + w.WalkStrafeRightInPlace;
  const total = (w: LocoWeights) => w.Idle + w.JogForward + w.jogBackward + side(w);

  it("stands still below the walking threshold", () => {
    const w = locoBlend(0, 0, 0);

    expect(w.Idle).toBe(1);
    expect(w.JogForward).toBe(0);
    expect(side(w)).toBe(0);
  });

  it("carries a sideways run on the strafe clips, not the forward one", () => {
    const right = locoBlend(0, 4, 4);
    const left = locoBlend(0, -4, 4);

    expect(side(right)).toBeCloseTo(1);
    expect(right.JogForward).toBe(0);
    expect(right.JogStrafeRightInPlace + right.WalkStrafeRightInPlace).toBeCloseTo(1);
    expect(left.JogStrafeLeftInPlace + left.WalkStrafeLeftInPlace).toBeCloseTo(1);
  });

  it("splits a diagonal run across both clips instead of picking a winner", () => {
    // The regression that made the player slide: running 45 degrees
    // forward-and-right used to play a pure forward cycle while the body
    // travelled sideways.
    const w = locoBlend(3, 3, Math.hypot(3, 3));

    expect(w.JogForward).toBeCloseTo(0.5);
    expect(side(w)).toBeCloseTo(0.5);
    expect(w.jogBackward).toBe(0);
    expect(w.JogStrafeLeftInPlace).toBe(0);
    expect(w.WalkStrafeLeftInPlace).toBe(0);
  });

  it("keeps the weights summing to one at every angle", () => {
    // An L2 split would bloom to ~1.41x on the diagonal, over-driving the rig.
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const w = locoBlend(Math.cos(rad) * 4, Math.sin(rad) * 4, 4);

      expect(total(w)).toBeCloseTo(1);
    }
  });

  it("fades out of standing across a band rather than snapping", () => {
    const creep = locoBlend(0.6, 0, 0.6);

    expect(creep.Idle).toBeGreaterThan(0);
    expect(creep.Idle).toBeLessThan(1);
    expect(creep.JogForward).toBeGreaterThan(0);
    expect(total(creep)).toBeCloseTo(1);
  });

  it("walks sideways for a ball that is nearly on you", () => {
    // A slow sideways adjustment is a half-step, not a run.
    const w = locoBlend(0, 0.9, 0.9);

    expect(w.WalkStrafeRightInPlace).toBeGreaterThan(0);
    expect(w.JogStrafeRightInPlace).toBe(0);
  });

  it("runs sideways for one you have to cover ground for", () => {
    const w = locoBlend(0, 4, 4);

    expect(w.JogStrafeRightInPlace).toBeCloseTo(1);
    expect(w.WalkStrafeRightInPlace).toBe(0);
  });

  it("changes gait across a band, so the legs never swap clip mid-stride", () => {
    const mid = locoBlend(0, 1.8, 1.8);

    expect(mid.WalkStrafeRightInPlace).toBeGreaterThan(0);
    expect(mid.JogStrafeRightInPlace).toBeGreaterThan(0);
    expect(total(mid)).toBeCloseTo(1);
  });

  it("drives a sideways cycle faster than a forward one at the same speed", () => {
    // A strafe covers less ground per cycle, so holding it to the forward
    // reference speed is what leaves the feet shuffling under a sliding body.
    const speed = 3;
    const forward = locoStride(locoBlend(speed, 0, speed), speed);
    const sideways = locoStride(locoBlend(0, speed, speed), speed);

    expect(sideways).toBeGreaterThan(forward);
  });

  it("never drives the legs slower than the floor or past the ceiling", () => {
    expect(locoStride(locoBlend(0.5, 0, 0.5), 0.5)).toBeGreaterThanOrEqual(0.55);
    expect(locoStride(locoBlend(99, 0, 99), 99)).toBeLessThanOrEqual(1.6);
  });
});

describe("chooseStrike", () => {
  const height = 1.8;
  /** Ball height, as a fraction of the player's own, with no band jitter. */
  const at = (rel: number) => rel * height;
  const righty = player({ strongFoot: "right", weakFoot: 70, backflips: "strong" });
  /** Standing on their strong side, so a backflip is available. */
  const STRONG_SIDE = 1;
  const RIGHT = 0.5;
  const LEFT = -0.5;

  it("flips rather than heads a high ball on the strong side", () => {
    // Feet first is the whole point: up at the table a teqball player kicks or
    // flips, and the header used to win every high ball by default.
    const clip = chooseStrike(at(0.95), RIGHT, STRONG_SIDE, righty, () => 0.5, 0);

    expect(clip).toBe("BackflipRightFoot");
  });

  it("kicks a mid ball rather than heading it", () => {
    const clip = chooseStrike(at(0.4), RIGHT, STRONG_SIDE, righty, () => 0.5, 0);

    expect(clip).toBe("RightFootKick");
  });

  it("only takes a touch when the ball is too low for any of it", () => {
    const clip = chooseStrike(at(0.05), RIGHT, STRONG_SIDE, righty, () => 0.5, 0);

    expect(clip).toBe("InnerRightFootReception");
  });

  describe("the weak foot decides the header", () => {
    // The ball has to be arriving on the weak side and be high enough; then it
    // is the weak foot's own score that says how often the head is used.
    const weakSide = LEFT; // a right-footed player's weak side
    const high = at(0.95);

    it("heads it when the roll beats the weak foot's score", () => {
      // 0.9 > 0.70, so the foot is not trusted this time.
      const clip = chooseStrike(high, weakSide, STRONG_SIDE, righty, () => 0.9, 0);

      expect(clip).toBe("LeftHeadKick");
    });

    it("uses the foot when the roll is inside it", () => {
      const clip = chooseStrike(high, weakSide, STRONG_SIDE, righty, () => 0.5, 0);

      expect(clip).not.toContain("HeadKick");
    });

    it("heads a weak-side ball more often the worse that foot is", () => {
      const poor = player({ strongFoot: "right", weakFoot: 20, backflips: "none" });
      const good = player({ strongFoot: "right", weakFoot: 95, backflips: "none" });
      const headers = (def: typeof poor) => {
        let n = 0;
        for (let i = 0; i < 400; i++) {
          if (chooseStrike(high, weakSide, STRONG_SIDE, def).includes("HeadKick")) n++;
        }
        return n;
      };

      expect(headers(poor)).toBeGreaterThan(headers(good));
    });

    it("never forces a header on a two-footed player", () => {
      // They have no weak side, so nothing about the ball's side matters.
      const ambi = player({ strongFoot: "both", weakFoot: 100, backflips: "none" });
      for (let i = 0; i < 200; i++) {
        expect(chooseStrike(high, weakSide, STRONG_SIDE, ambi)).not.toContain("HeadKick");
      }
    });

    it("does not head a ball that is too low to head", () => {
      // Weak side, but at knee height there is no header to play.
      const clip = chooseStrike(at(0.4), weakSide, STRONG_SIDE, righty, () => 0.99, 0);

      expect(clip).not.toContain("HeadKick");
    });
  });

  describe("backflips stay on one side of the court", () => {
    it("flips off the strong foot when standing on that side", () => {
      expect(chooseStrike(at(0.9), RIGHT, 1, righty, () => 0.5, 0)).toBe(
        "BackflipRightFoot"
      );
    });

    it("will not flip from the weak side", () => {
      // The leg that comes over is the outside one, so the far side of the
      // court has no flip in it — that is what "only one side" means.
      const clip = chooseStrike(at(0.9), RIGHT, -1, righty, () => 0.5, 0);

      expect(clip).not.toContain("Backflip");
    });

    it("gives a two-footed player a flip from either side", () => {
      const ambi = player({ strongFoot: "both", weakFoot: 100, backflips: "strong" });

      expect(chooseStrike(at(0.9), RIGHT, 1, ambi, () => 0.5, 0)).toBe("BackflipRightFoot");
      expect(chooseStrike(at(0.9), LEFT, -1, ambi, () => 0.5, 0)).toBe("BackflipLeftFoot");
    });

    it("gives nothing to a player who does not flip at all", () => {
      const grounded = player({ strongFoot: "right", weakFoot: 100, backflips: "none" });
      const clip = chooseStrike(at(0.9), RIGHT, 1, grounded, () => 0.5, 0);

      expect(clip).toBe("RightFootKick");
    });
  });

  it("only ever returns a real clip with a contact frame", () => {
    for (let i = 0; i < 3000; i++) {
      const def = player({
        strongFoot: (["left", "right", "both"] as const)[i % 3],
        weakFoot: (i * 7) % 101,
        backflips: (["none", "strong", "both"] as const)[i % 3],
      });
      const clip = chooseStrike(
        Math.random() * height * 1.2,
        Math.random() * 1.6 - 0.8,
        Math.random() * 2 - 1,
        def
      );
      expect(CLIPS[clip], clip).toBeDefined();
      expect(CLIPS[clip].contact, clip).toBeGreaterThan(0);
    }
  });

  it("keeps the bands in the order the shots happen in", () => {
    expect(STRIKE_BANDS.header).toBeGreaterThan(STRIKE_BANDS.backflip);
    expect(STRIKE_BANDS.backflip).toBeGreaterThan(STRIKE_BANDS.foot);
  });
});

describe("onWeakSide", () => {
  it("is the side away from the strong foot", () => {
    const righty = player({ strongFoot: "right" });

    expect(onWeakSide(0.5, righty)).toBe(false);
    expect(onWeakSide(-0.5, righty)).toBe(true);
  });

  it("is never true for a two-footed player", () => {
    const ambi = player({ strongFoot: "both" });

    expect(onWeakSide(0.5, ambi)).toBe(false);
    expect(onWeakSide(-0.5, ambi)).toBe(false);
  });
});

describe("strikeBackflipFoot", () => {
  it("is the strong foot, and only from that side", () => {
    const lefty = player({ strongFoot: "left", backflips: "strong" });

    expect(strikeBackflipFoot(-1, lefty)).toBe("left");
    expect(strikeBackflipFoot(1, lefty)).toBeNull();
  });

  it("is null for a player who cannot flip", () => {
    const grounded = player({ strongFoot: "right", backflips: "none" });

    expect(strikeBackflipFoot(1, grounded)).toBeNull();
  });
});
