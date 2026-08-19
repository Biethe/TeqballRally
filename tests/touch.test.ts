import { describe, expect, it } from "vitest";
import {
  BANDS,
  PACE,
  QUALITY,
  gradeContact,
  receptionPaceFactor,
  setupShape,
  strikeShape,
  timingSense,
  touchBand,
  volleyPaceFactor,
  type ContactErrors,
} from "../src/touch";
import { PART_SETUP, type BodyPart } from "../src/config";

/** A contact met perfectly: right height, in front, in the middle of the window. */
const clean: ContactErrors = {
  heightError: 0,
  reach: 0,
  timing: 0,
  height: 1.8,
  lunge: 1.25,
  window: 0.15,
};

const with_ = (over: Partial<ContactErrors>): ContactErrors => ({ ...clean, ...over });

describe("grading a contact", () => {
  it("gives a clean contact full marks", () => {
    expect(gradeContact(clean)).toBe(1);
  });

  it("costs a contact met at the wrong height", () => {
    // Half a metre off on a 1.8 m player is most of the height term.
    expect(gradeContact(with_({ heightError: 0.5 }))).toBeLessThan(BANDS.good + 0.2);
    expect(gradeContact(with_({ heightError: 0.5 }))).toBeLessThan(gradeContact(with_({ heightError: 0.2 })));
  });

  it("costs a contact taken at full stretch", () => {
    expect(gradeContact(with_({ reach: 1.25 }))).toBeLessThan(gradeContact(with_({ reach: 0.3 })));
  });

  it("costs a contact at either end of the window equally", () => {
    // EARLY - GOOD - PERFECT - GOOD - LATE: the curve is symmetric, because
    // hurrying a touch and waiting too long are the same mistake mirrored.
    expect(gradeContact(with_({ timing: 0.12 }))).toBeCloseTo(
      gradeContact(with_({ timing: -0.12 })),
      10
    );
    expect(gradeContact(with_({ timing: 0.12 }))).toBeLessThan(gradeContact(clean));
  });

  it("weighs where you stood above when you pressed", () => {
    // Skill here is positioning first. A game that graded timing hardest would
    // be a rhythm game with a table drawn on it.
    const mistimed = gradeContact(with_({ timing: 1 }));
    const misplaced = gradeContact(with_({ heightError: 1.8 }));

    expect(misplaced).toBeLessThan(mistimed);
  });

  it("never grades a touch out of existence", () => {
    // A poor touch is a bad ball to play next, never a touch that did not
    // happen — whether the ball was reachable at all was decided long before.
    const hopeless = gradeContact(with_({ heightError: 9, reach: 9, timing: 9 }));

    expect(hopeless).toBe(QUALITY.floor);
    expect(hopeless).toBeGreaterThan(0);
  });

  it("is the same grade for the same contact, every time", () => {
    const e = with_({ heightError: 0.21, reach: 0.4, timing: -0.06 });
    const first = gradeContact(e);
    for (let i = 0; i < 100; i++) expect(gradeContact(e)).toBe(first);
  });

  it("bands the grade the way the HUD reads it", () => {
    expect(touchBand(1)).toBe("perfect");
    expect(touchBand(BANDS.perfect)).toBe("perfect");
    expect(touchBand(BANDS.good)).toBe("good");
    expect(touchBand(BANDS.poor)).toBe("poor");
    expect(touchBand(0)).toBe("scrappy");
  });
});

describe("which way a mistimed touch squirts", () => {
  it("reads a contact late in the window as met early, and the reverse", () => {
    expect(timingSense(0.2, 0.15)).toBe(1);
    expect(timingSense(-0.2, 0.15)).toBe(-1);
  });

  it("calls anything near the middle neither", () => {
    expect(timingSense(0.02, 0.15)).toBe(0);
  });
});

describe("what each part of the body does with a set-up", () => {
  const parts: BodyPart[] = ["chest", "knee", "foot", "head"];

  it("keeps the parts distinguishable on a clean touch", () => {
    const shaped = Object.fromEntries(parts.map((p) => [p, setupShape(p, 1, 0)])) as Record<
      BodyPart,
      ReturnType<typeof setupShape>
    >;

    // The three sentences the whole three-touch game is built on: the chest
    // controls, the foot moves the ball, the head buys time.
    expect(shaped.chest.carry).toBeLessThan(shaped.foot.carry);
    expect(shaped.head.rise).toBeGreaterThan(shaped.foot.rise);
    expect(shaped.knee.carry).toBeGreaterThan(shaped.chest.carry);
    expect(shaped.knee.carry).toBeLessThan(shaped.foot.carry);
  });

  it("puts a clean touch exactly where it was asked for, whatever played it", () => {
    for (const part of parts) {
      const shape = setupShape(part, 1, 0);
      expect(shape.accuracy, part).toBe(1);
      expect(shape.drift, part).toBe(0);
      expect(shape.rise, part).toBeCloseTo(PART_SETUP[part].rise, 10);
    }
  });

  it("costs a scrappy touch its height, its carry and its accuracy", () => {
    const good = setupShape("knee", 1, 0);
    const bad = setupShape("knee", 0.15, 1);

    expect(bad.rise).toBeLessThan(good.rise);
    expect(bad.carry).toBeLessThan(good.carry);
    expect(bad.accuracy).toBeLessThan(good.accuracy);
    // Still playable: an awkward second touch, not a lost point.
    expect(bad.accuracy).toBeGreaterThan(0.3);
  });

  it("punishes the same bad contact hardest on the foot and least on the chest", () => {
    // Which is what makes the chest the touch you reach for when the rally has
    // got away from you, and the foot the one you play when it has not.
    const chest = setupShape("chest", 0.3, 0);
    const foot = setupShape("foot", 0.3, 0);

    expect(chest.accuracy).toBeGreaterThan(foot.accuracy);
  });

  it("squirts an early touch on and a late one back", () => {
    expect(setupShape("foot", 0.3, 1).drift).toBeGreaterThan(0);
    expect(setupShape("foot", 0.3, -1).drift).toBeLessThan(0);
    expect(setupShape("foot", 0.3, 0).drift).toBe(0);
  });
});

describe("what a graded contact does to a kick", () => {
  it("takes the line off a bad strike rather than the pace", () => {
    const clean = strikeShape(1);
    const scrappy = strikeShape(0.15);

    expect(clean.spread).toBe(1);
    expect(scrappy.spread).toBeGreaterThan(1.8);
    // A mishit that also flew slowly would take the danger out of exactly the
    // shot a player should be punished for rushing.
    expect(scrappy.power).toBeGreaterThan(0.8 * clean.power);
  });

  it("rewards a clean contact with everything the striker has", () => {
    expect(strikeShape(1).power).toBeGreaterThan(strikeShape(0.5).power);
  });
});

describe("what an incoming pace costs the next touch", () => {
  it("costs a slow ball nothing", () => {
    expect(receptionPaceFactor(0)).toBe(1);
    expect(receptionPaceFactor(PACE.receive.from)).toBe(1);
    expect(volleyPaceFactor(0, 0.88)).toBe(1);
  });

  it("ramps monotonically down to the floor, never below it", () => {
    let prev = receptionPaceFactor(PACE.receive.from);
    for (let pace = PACE.receive.from + 0.5; pace <= PACE.receive.full + 3; pace += 0.5) {
      const f = receptionPaceFactor(pace);
      expect(f).toBeLessThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(PACE.receive.floor);
      prev = f;
    }
    expect(receptionPaceFactor(PACE.receive.full)).toBeCloseTo(PACE.receive.floor);
  });

  it("never deletes the touch: the floor is where the cost stops", () => {
    expect(receptionPaceFactor(100)).toBe(PACE.receive.floor);
    expect(volleyPaceFactor(100, 0.5)).toBe(PACE.volley.floor);
    expect(volleyPaceFactor(100, 2)).toBe(PACE.volley.floor);
  });

  it("lets a better volley take a faster ball cleanly", () => {
    const weak = 0.88;
    const strong = 1.4;
    // A pace between the two allowances: the stronger character is still
    // clean, the weaker one is already paying.
    const contested = 12.5;
    expect(volleyPaceFactor(contested, strong)).toBe(1);
    expect(volleyPaceFactor(contested, weak)).toBeLessThan(1);
    // More trait, more allowance — monotone in the trait itself.
    expect(volleyPaceFactor(contested, 1.2)).toBeGreaterThan(volleyPaceFactor(contested, weak));
  });
});
