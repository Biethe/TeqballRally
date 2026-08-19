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
  MIN_RESERVE,
  backflipAllowed,
  backflipFoot,
  clipFoot,
  footFactor,
  locoBlend,
  locoStride,
  type LocoWeights,
  bodyPartOf,
  clipYawOffset,
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

    // BRAZIL flips off the strong foot only — the starter is allowed the
    // trick, not the mastery of it.
    expect(backflipAllowed(byLabel.BRAZIL, "right")).toBe(true);
    expect(backflipAllowed(byLabel.BRAZIL, "left")).toBe(false);
    expect(backflipAllowed(byLabel.ENGLAND, "right")).toBe(false);
    expect(backflipAllowed(byLabel.FRANCE, "left")).toBe(true);
    expect(backflipAllowed(byLabel.FRANCE, "right")).toBe(false);
    // SPAIN is two-footed, so either foot qualifies as the strong one.
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
    expect(serveClipForAim(0)).toBe("HeadServeRight");
    expect(serveClipForAim(0.25)).toBe("HeadServeRight");
    expect(serveClipForAim(-0.25)).toBe("HeadServeRight");
  });

  it("heads the central serve off the strong side, every time", () => {
    // It used to be a coin toss, which made the one serve a player can aim
    // straight down the middle the one serve they could not learn.
    expect(serveClipForAim(0, "left")).toBe("HeadServeLeft");
    expect(serveClipForAim(0, "right")).toBe("HeadServeRight");
    for (let i = 0; i < 50; i++) expect(serveClipForAim(0.1, "left")).toBe("HeadServeLeft");
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
    expect(pickReceptionClip(height * 0.8, 0.5, height, "both", { bandShift: 0 })).toBe(
      "ChestPrepRight"
    );
    // Square-on rather than off to the side: the chest is taken without the
    // step across that the prep clips are.
    expect(pickReceptionClip(height * 0.8, 0.05, height, "both", { bandShift: 0 })).toBe(
      "ChestReception"
    );
    expect(pickReceptionClip(height * 0.5, 0.5, height, "both", { bandShift: 0 })).toBe(
      "RightKneeReception"
    );
    expect(pickReceptionClip(height * 0.2, 0.5, height, "both", { bandShift: 0 })).toBe(
      "InnerRightFootReception"
    );
  });

  it("plays the same ball the same way, every time", () => {
    // The property the whole skill curve rests on: what a player learns about
    // where to stand has to hold the next time they stand there.
    for (const rel of [0.2, 0.35, 0.5, 0.7, 0.9]) {
      const first = pickReceptionClip(height * rel, 0.24, height, "right");
      for (let i = 0; i < 50; i++) {
        expect(pickReceptionClip(height * rel, 0.24, height, "right")).toBe(first);
      }
    }
  });

  it("takes a wide ball lower on the body than one met in front", () => {
    // Reaching for a ball is what the leg does; a ball in front is met with
    // whatever is already there. This is the whole of "position picks the
    // body part", and it is why the variety no longer needs a die.
    const high = height * 0.64;

    expect(pickReceptionClip(high, 0, height, "both")).toBe("ChestReception");
    expect(pickReceptionClip(high, 0.9, height, "both")).toBe("RightKneeReception");
  });

  it("picks the side from the lateral offset", () => {
    stubRandom(0);
    expect(pickReceptionClip(height * 0.2, -0.5, height, "both", { bandShift: 0 })).toBe("InnerLeftFootReception");
    expect(pickReceptionClip(height * 0.5, -0.5, height, "both", { bandShift: 0 })).toBe("LeftKneeReception");
  });

  it("takes the nearest side when the run chose the standing", () => {
    // Inside the central zone the strong foot normally asks for the ball. A
    // reception played under the locked run never chose where to stand, so the
    // side is not theirs to lose either: whichever limb the ball is on plays
    // it, strong foot or not.
    expect(pickReceptionClip(height * 0.2, 0.1, height, "left", { bandShift: 0 })).toBe(
      "InnerLeftFootReception"
    );
    expect(
      pickReceptionClip(height * 0.2, 0.1, height, "left", { bandShift: 0, forceNearest: true })
    ).toBe("InnerRightFootReception");
    expect(
      pickReceptionClip(height * 0.2, -0.1, height, "right", { bandShift: 0, forceNearest: true })
    ).toBe("InnerLeftFootReception");
  });

  it("uses more than one clip across the balls a rally actually produces", () => {
    // The complaint this exists for: a rally played the same three animations
    // over and over. Contact heights measured over a real match run 0.31 to
    // 0.88 of body height with a median of 0.75, so a hard-edged band meant one
    // clip owned nearly every touch at a given height.
    //
    // The spread used to be bought with a coin toss, which fixed the picture at
    // the cost of the game: two identical balls could be played two different
    // ways. It now comes from where the ball is, so a match still sees every
    // clip — and each one for a reason the player can see.
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const rel = 0.31 + (0.57 * i) / 400;
      const lateral = ((i % 9) / 8) * 1.2 - 0.6;
      seen.add(pickReceptionClip(height * rel, lateral, height));
    }

    expect(seen.size).toBeGreaterThan(4);
  });

  it("never plays the same part of the body twice in a row", () => {
    // The teqball rule, enforced where the limb is chosen rather than as a
    // foul afterwards: the game picks the limb, so it has to pick a legal one.
    for (const rel of [0.15, 0.3, 0.5, 0.66, 0.85]) {
      for (const avoid of ["chest", "knee", "foot"] as const) {
        const clip = pickReceptionClip(height * rel, 0.3, height, "both", { avoid });
        expect(bodyPartOf(clip), `${rel} after ${avoid}`).not.toBe(avoid);
      }
    }
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

  it("leaves an emptied player labouring rather than frozen", () => {
    // Running out is meant to be a state a player can see happening to them,
    // so the floor is low — but never zero. A character who cannot move at all
    // is one standing still watching the ball go past, which is worse to watch
    // than a slow one chasing it.
    expect(MIN_EFFORT).toBeGreaterThan(0);
    expect(MIN_EFFORT).toBeLessThan(0.3);
    const spent = approachVelocity(0, 5, 1 / 60, MOVE_TAU / MIN_EFFORT);
    expect(spent).toBeGreaterThan(0);
  });

  it("never grinds the reserve below the floor", () => {
    // The ceiling only falls, so without a floor a long match would end with
    // two players unable to cross their own half.
    expect(MIN_RESERVE).toBeGreaterThan(MIN_EFFORT);
    expect(MIN_RESERVE).toBeLessThan(1);
  });

  it("trains effort without erasing the character that was picked", () => {
    const brazil = CHARACTERS.find((c) => c.label === "BRAZIL")!;
    const england = CHARACTERS.find((c) => c.label === "ENGLAND")!;
    const trainedBrazil = withCareer(brazil, MAX_LEVEL);
    const trainedEngland = withCareer(england, MAX_LEVEL);

    // Levelling lifts them…
    expect(trainedBrazil.agility).toBeGreaterThan(brazil.agility);
    expect(trainedBrazil.stamina).toBeGreaterThan(brazil.stamina);
    // …and training does not reorder the roster: ENGLAND is a rung above
    // BRAZIL on the ladder and stays there with both trained to the cap.
    expect(trainedEngland.agility).toBeLessThan(trainedBrazil.agility);
    expect(trainedEngland.stamina).toBeGreaterThan(trainedBrazil.stamina);
  });

  it("leaves power and the serve to the character when levelling", () => {
    // A level has to be felt, so it lifts most of what a player notices —
    // precision, agility, stamina, and a little speed and reach with it. Pace
    // and the serve are what make ENGLAND ENGLAND, and training out of them
    // would turn four characters into one.
    const def = CHARACTERS[0];
    const trained = withCareer(def, MAX_LEVEL);

    expect(trained.power).toBe(def.power);
    expect(trained.serve).toBe(def.serve);
    expect(trained.precision).toBeGreaterThan(def.precision);
    expect(trained.speed).toBeGreaterThan(def.speed);
    expect(trained.volley).toBeGreaterThan(def.volley);
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
    const clip = chooseStrike(at(0.95), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 });

    expect(clip).toBe("BackflipRightFoot");
  });

  it("kicks a mid ball rather than heading it", () => {
    const clip = chooseStrike(at(0.4), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 });

    expect(clip).toBe("RightFootKick");
  });

  it("only takes a touch when the ball is too low for any of it", () => {
    const clip = chooseStrike(at(0.05), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 });

    expect(clip).toBe("InnerRightFootReception");
  });

  describe("the weak foot decides the header", () => {
    // The ball has to be arriving on the weak side and be high enough; then it
    // is the weak foot's own score that says how often the head is used.
    const weakSide = LEFT; // a right-footed player's weak side
    const high = at(0.95);

    it("heads a ball too far onto the weak side for that foot", () => {
      // 0.85 m across the body is past what a 70 weak foot is trusted with.
      const clip = chooseStrike(high, -0.85, STRONG_SIDE, righty, true, { bandShift: 0 });

      expect(clip).toBe("LeftHeadKick");
    });

    it("uses the foot for a weak-side ball still inside its range", () => {
      const clip = chooseStrike(high, weakSide, STRONG_SIDE, righty, true, { bandShift: 0 });

      expect(clip).not.toContain("HeadKick");
    });

    it("is the same answer every time, so the line can be learned", () => {
      for (let i = 0; i < 50; i++) {
        expect(chooseStrike(high, -0.85, STRONG_SIDE, righty, true)).toBe("LeftHeadKick");
        expect(chooseStrike(high, -0.3, STRONG_SIDE, righty, true)).not.toContain("HeadKick");
      }
    });

    it("heads a weak-side ball more often the worse that foot is", () => {
      const poor = player({ strongFoot: "right", weakFoot: 20, backflips: "none" });
      const good = player({ strongFoot: "right", weakFoot: 95, backflips: "none" });
      // Swept across the weak side rather than repeated: the header is now a
      // question of how far across the body the ball is, so the count is how
      // much of that side the foot is trusted with.
      const headers = (def: typeof poor) => {
        let n = 0;
        for (let i = 0; i < 400; i++) {
          const lateral = -(i / 400);
          if (chooseStrike(high, lateral, STRONG_SIDE, def, true).includes("HeadKick")) n++;
        }
        return n;
      };

      expect(headers(poor)).toBeGreaterThan(headers(good));
    });

    it("never forces a header on a two-footed player", () => {
      // They have no weak side, so nothing about the ball's side matters.
      const ambi = player({ strongFoot: "both", weakFoot: 100, backflips: "none" });
      for (let i = 0; i < 200; i++) {
        expect(chooseStrike(high, weakSide, STRONG_SIDE, ambi, true)).not.toContain("HeadKick");
      }
    });

    it("does not head a ball that is too low to head", () => {
      // Weak side, but at knee height there is no header to play.
      const clip = chooseStrike(at(0.4), weakSide, STRONG_SIDE, righty, true, { bandShift: 0 });

      expect(clip).not.toContain("HeadKick");
    });
  });

  describe("backflips stay on one side of the court", () => {
    it("flips off the strong foot when standing on that side", () => {
      expect(chooseStrike(at(0.9), RIGHT, 1, righty, true, { bandShift: 0 })).toBe(
        "BackflipRightFoot"
      );
    });

    it("will not flip from the weak side", () => {
      // The leg that comes over is the outside one, so the far side of the
      // court has no flip in it — that is what "only one side" means.
      const clip = chooseStrike(at(0.9), RIGHT, -1, righty, true, { bandShift: 0 });

      expect(clip).not.toContain("Backflip");
    });

    it("gives a two-footed player a flip from either side", () => {
      const ambi = player({ strongFoot: "both", weakFoot: 100, backflips: "strong" });

      expect(chooseStrike(at(0.9), RIGHT, 1, ambi, true, { bandShift: 0 })).toBe("BackflipRightFoot");
      expect(chooseStrike(at(0.9), LEFT, -1, ambi, true, { bandShift: 0 })).toBe("BackflipLeftFoot");
    });

    it("gives nothing to a player who does not flip at all", () => {
      const grounded = player({ strongFoot: "right", weakFoot: 100, backflips: "none" });
      const clip = chooseStrike(at(0.9), RIGHT, 1, grounded, true, { bandShift: 0 });

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
        def,
        i % 2 === 0
      );
      expect(CLIPS[clip], clip).toBeDefined();
      expect(CLIPS[clip].contact, clip).toBeGreaterThan(0);
    }
  });

  it("keeps the bands in the order the shots happen in", () => {
    // Flip above the head, head at head height, foot below: the ladder reads
    // upward in the order the shots become possible. The flip used to sit
    // *under* the header, and since it is offered first it won nearly every
    // set-up ball above knee height — a flat bicycle kick from chest height,
    // and a header almost nobody ever saw.
    expect(STRIKE_BANDS.backflip).toBeGreaterThan(STRIKE_BANDS.header);
    expect(STRIKE_BANDS.header).toBeGreaterThan(STRIKE_BANDS.foot);
  });

  it("kicks a ball at head height rather than flipping it", () => {
    // The behaviour change, pinned: 0.7 used to be a flip and is now a kick.
    // Nothing covered this band at all, which is how the flip came to own it.
    expect(chooseStrike(at(0.7), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 })).toBe(
      "RightFootKick"
    );
  });

  it("still flips a ball above the head", () => {
    expect(chooseStrike(at(1.0), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 })).toBe(
      "BackflipRightFoot"
    );
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

describe("finishes need a reception first", () => {
  const height = 1.8;
  const at = (rel: number) => rel * height;
  const righty = player({ strongFoot: "right", weakFoot: 100, backflips: "strong" });
  const STRONG_SIDE = 1;
  const RIGHT = 0.5;

  it("does not volley a ball off the first touch", () => {
    // A foot volley is a finish: it is played on a ball you set up for
    // yourself, not on one arriving from the other end of the table.
    const first = chooseStrike(at(0.4), RIGHT, STRONG_SIDE, righty, false, { bandShift: 0 });

    expect(first).not.toContain("FootKick");
  });

  it("does not backflip off the first touch either", () => {
    const first = chooseStrike(at(0.9), RIGHT, STRONG_SIDE, righty, false, { bandShift: 0 });

    expect(first).not.toContain("Backflip");
  });

  it("controls the ball instead", () => {
    for (const rel of [0.2, 0.5, 0.7, 0.95]) {
      const clip = chooseStrike(at(rel), RIGHT, STRONG_SIDE, righty, false, { bandShift: 0 });
      expect(["ChestKick", "RightKneeReception", "InnerRightFootReception"], `rel ${rel}`).toContain(
        clip
      );
    }
  });

  it("offers both once the ball has been set up", () => {
    expect(chooseStrike(at(0.9), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 })).toContain(
      "Backflip"
    );
    expect(chooseStrike(at(0.4), RIGHT, STRONG_SIDE, righty, true, { bandShift: 0 })).toContain(
      "FootKick"
    );
  });
});

/**
 * Clip orientation.
 *
 * Backflips are the one clip family played facing away from the table, and
 * nothing covered that until this: the constant had been applied, reverted and
 * applied again on reasoning alone, with no test to say which way round it was
 * meant to be. These pin the two properties the rest of the strike path relies
 * on — that exactly the backflips are turned, and that a turn puts the contact
 * behind the player rather than in front.
 */
describe("clipYawOffset", () => {
  it("turns the backflips and nothing else", () => {
    for (const clip of Object.keys(CLIPS)) {
      expect([clip, clipYawOffset(clip)]).toEqual([clip, clip.startsWith("Backflip") ? Math.PI : 0]);
    }
  });

  it("turns both backflip feet", () => {
    expect(clipYawOffset("BackflipRightFoot")).toBe(Math.PI);
    expect(clipYawOffset("BackflipLeftFoot")).toBe(Math.PI);
  });

  it("is a half turn, so the contact lands behind the player", () => {
    // The rotation clipContactPoint performs, reduced to the one axis that
    // matters: a contact 1.28 m in front of an unturned player is 1.28 m behind
    // a turned one. Both are "1.28 m away"; only the sign says which side of
    // the body the ball is met on, and for a bicycle kick it is the far side.
    const reach = 1.28;
    const contactZ = (yaw: number) => reach * Math.cos(yaw);
    expect(contactZ(clipYawOffset("RightFootKick"))).toBeCloseTo(reach, 6);
    expect(contactZ(clipYawOffset("BackflipRightFoot"))).toBeCloseTo(-reach, 6);
  });
});
