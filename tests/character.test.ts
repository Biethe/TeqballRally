import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  CLIP_CONTACT_BONE,
  HEAD_CONTACT_PUSH,
  MOVE_TAU,
  SERVE_CLIPS,
  SERVE_TOSS_HAND,
  approachVelocity,
  backflipAllowed,
  backflipFoot,
  clipFoot,
  footFactor,
  pickReceptionClip,
  pickStrikeClip,
  serveClipForAim,
  serveContactOffset,
} from "../src/character";
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
  speed: 4.5,
  power: 1,
  precision: 1,
  backflips: "both",
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

describe("pickStrikeClip", () => {
  const height = 1.8;

  it("heads a high ball and volleys a low one", () => {
    stubRandom(0);
    expect(pickStrikeClip(height * 0.9, 0.5, height, "both", 1)).toBe("RightHeadKick");
    expect(pickStrikeClip(height * 0.7, 0.5, height, "both", 1)).toBe("RightHeadKick");
    expect(pickStrikeClip(height * 0.5, 0.5, height, "both", 1)).toBe("ChestKick");
    expect(pickStrikeClip(height * 0.2, 0.5, height, "both", 1)).toBe("RightFootKick");
  });

  it("plays the floated clip in each band when the kick is a soft one", () => {
    // The animation has to agree with the ball that comes off it: a lofted
    // kick is played with the inner foot or the knee, never drilled.
    stubRandom(0);
    expect(pickStrikeClip(height * 0.7, 0.5, height, "both", 0.1)).toBe("ChestKick");
    expect(pickStrikeClip(height * 0.5, 0.5, height, "both", 0.1)).toBe("RightKneeReception");
    expect(pickStrikeClip(height * 0.2, 0.5, height, "both", 0.1)).toBe("InnerRightFootReception");
  });

  it("picks the side from the lateral offset", () => {
    stubRandom(0);
    expect(pickStrikeClip(height * 0.9, 0.5, height, "both", 1)).toBe("RightHeadKick");
    expect(pickStrikeClip(height * 0.9, -0.5, height, "both", 1)).toBe("LeftHeadKick");
  });

  it("always heads a wide high ball rather than centring it", () => {
    stubRandom(0);
    expect(pickStrikeClip(height * 0.95, 0.5, height, "both", 1)).toBe("RightHeadKick");
    // Dead centre a driven ball is headed straight through.
    expect(pickStrikeClip(height * 0.95, 0.1, height, "both", 1)).toBe("CenterHeadKick");
  });

  it("favours the strong foot on a dead-centre ball", () => {
    // |lateral| < 0.06 makes pickSide consume the first random: 0.5 < 0.75
    // keeps the preferred side, then 0 takes the first option in the band.
    stubRandom(0.5, 0);
    expect(pickStrikeClip(height * 0.2, 0, height, "left", 1)).toBe("LeftFootKick");

    vi.restoreAllMocks();
    stubRandom(0.5, 0);
    expect(pickStrikeClip(height * 0.2, 0, height, "right")).toBe("RightFootKick");

    // A roll past 0.75 crosses to the other foot.
    vi.restoreAllMocks();
    stubRandom(0.8, 0);
    expect(pickStrikeClip(height * 0.2, 0, height, "left")).toBe("RightFootKick");
  });

  it("only ever returns a real clip with a contact frame", () => {
    for (let i = 0; i < 2000; i++) {
      const ballY = Math.random() * height * 1.2;
      const lateral = Math.random() * 1.6 - 0.8;
      const clip = pickStrikeClip(ballY, lateral, height, "right");
      expect(CLIPS[clip], clip).toBeDefined();
      expect(CLIPS[clip].contact, clip).toBeGreaterThan(0);
    }
  });

  it("scales with the character's height, not absolute metres", () => {
    stubRandom(0);
    const tall = pickStrikeClip(1.7, 0.5, 2.0); // rel 0.85 -> head
    vi.restoreAllMocks();
    stubRandom(0);
    const shortPlayer = pickStrikeClip(1.7, 0.5, 1.6); // rel > 1 -> also head

    expect(tall).toBe("RightHeadKick");
    expect(shortPlayer).toBe("RightHeadKick");

    vi.restoreAllMocks();
    stubRandom(0);
    // The same ball height is a knee ball for a 2 m player...
    expect(pickStrikeClip(1.0, 0.5, 2.0, "both", 0.1)).toBe("RightKneeReception");
    vi.restoreAllMocks();
    stubRandom(0);
    // ...and a chest ball for a 1.5 m one.
    expect(pickStrikeClip(1.0, 0.5, 1.5, "both", 0.1)).toBe("ChestKick");
  });
});

describe("pickReceptionClip", () => {
  const height = 1.8;

  it("chests a high ball, knees a mid one and uses the inner foot low", () => {
    stubRandom(0.99);
    expect(pickReceptionClip(height * 0.8, 0.5, height)).toBe("ChestPrepRight");
    vi.restoreAllMocks();
    stubRandom(0);
    expect(pickReceptionClip(height * 0.8, 0.5, height)).toBe("ChestReception");
    expect(pickReceptionClip(height * 0.5, 0.5, height)).toBe("RightKneeReception");
    expect(pickReceptionClip(height * 0.2, 0.5, height)).toBe("InnerRightFootReception");
  });

  it("picks the side from the lateral offset", () => {
    stubRandom(0);
    expect(pickReceptionClip(height * 0.2, -0.5, height)).toBe("InnerLeftFootReception");
    expect(pickReceptionClip(height * 0.5, -0.5, height)).toBe("LeftKneeReception");
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
