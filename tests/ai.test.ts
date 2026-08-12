import { describe, expect, it } from "vitest";
import {
  DIFFICULTIES,
  DIFFICULTY,
  misreadOffset,
  type AIDifficulty,
  type DifficultyLevel,
} from "../src/ai";
import { PRACTICE_DIFFICULTY } from "../src/practice";

const LEVELS: DifficultyLevel[] = ["easy", "normal", "hard"];

describe("DIFFICULTIES", () => {
  it("offers exactly the three levels the menu shows", () => {
    expect(Object.keys(DIFFICULTIES).sort()).toEqual([...LEVELS].sort());
  });

  it("defaults to normal", () => {
    expect(DIFFICULTY).toBe(DIFFICULTIES.normal);
  });

  it("gets harder monotonically at every level", () => {
    for (let i = 1; i < LEVELS.length; i++) {
      const easier = DIFFICULTIES[LEVELS[i - 1]];
      const harder = DIFFICULTIES[LEVELS[i]];
      const label = `${LEVELS[i - 1]} -> ${LEVELS[i]}`;

      // Faster, sharper, quicker to react.
      expect(harder.speed, `${label} speed`).toBeGreaterThan(easier.speed);
      expect(harder.aimError, `${label} aimError`).toBeLessThan(easier.aimError);
      expect(harder.reactionTime, `${label} reactionTime`).toBeLessThan(easier.reactionTime);
      // And reads the ball better, which is the only thing that loses it one.
      expect(harder.misjudge, `${label} misjudge`).toBeLessThan(easier.misjudge);
      // Higher levels build the point up more often.
      expect(harder.popChance, `${label} popChance`).toBeGreaterThan(easier.popChance);
      expect(harder.maxPopTouches, `${label} maxPopTouches`).toBeGreaterThanOrEqual(easier.maxPopTouches);
    }
  });

  it("keeps every preset inside a sane range", () => {
    const presets: [string, AIDifficulty][] = [
      ...Object.entries(DIFFICULTIES),
      ["practice", PRACTICE_DIFFICULTY],
    ];
    for (const [name, d] of presets) {
      // `speed` is a fraction of the character's own court speed.
      expect(d.speed, `${name} speed`).toBeGreaterThan(0);
      expect(d.speed, `${name} speed`).toBeLessThanOrEqual(1);
      // Probabilities.
      expect(d.popChance, `${name} popChance`).toBeGreaterThanOrEqual(0);
      expect(d.popChance, `${name} popChance`).toBeLessThanOrEqual(1);
      // Seconds and metres of error.
      expect(d.reactionTime, `${name} reactionTime`).toBeGreaterThanOrEqual(0);
      expect(d.aimError, `${name} aimError`).toBeGreaterThanOrEqual(0);
      // Misjudgement is a distance, and a bounded one: an opponent that can be
      // metres wrong is back to looking like it is dodging the ball.
      expect(d.misjudge, `${name} misjudge`).toBeGreaterThanOrEqual(0);
      expect(d.misjudge, `${name} misjudge`).toBeLessThanOrEqual(1);
      // Control touches have to fit inside the touch allowance.
      expect(d.maxPopTouches, `${name} maxPopTouches`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d.maxPopTouches), `${name} maxPopTouches`).toBe(true);
    }
  });
});

describe("how the AI misses", () => {
  /**
   * The rule this suite exists for: the opponent always goes for the ball.
   *
   * The old difficulty model included a "whiff" — a fixed 1.15 m sidestep,
   * always the same way, plus a rule forbidding the AI to touch the ball that
   * possession. On easy it fired on nearly a quarter of incoming balls, so a
   * quarter of points opened with the opponent walking away from the serve.
   * These tests hold the replacement to being a misjudgement instead: an error
   * that is as often one way as the other, and that a well-placed shot has to
   * exploit rather than simply receive.
   */

  it("is as likely to read the ball short as long", () => {
    // A fixed sign is what made the old behaviour look like dodging.
    let low = 0;
    let high = 0;
    for (let i = 0; i < 4000; i++) {
      const off = misreadOffset(0.5);
      if (off < 0) low++;
      if (off > 0) high++;
    }

    expect(low).toBeGreaterThan(1500);
    expect(high).toBeGreaterThan(1500);
  });

  it("never misreads by more than the difficulty allows", () => {
    for (let i = 0; i < 2000; i++) {
      expect(Math.abs(misreadOffset(0.66))).toBeLessThanOrEqual(0.66);
    }
  });

  it("is usually nearly right, and occasionally badly wrong", () => {
    // Squared about zero: a uniform error would make every single reception
    // sloppy, which reads as an opponent who cannot play rather than one who
    // can be beaten by a good shot.
    const offsets = Array.from({ length: 4000 }, () => Math.abs(misreadOffset(1)));
    const small = offsets.filter((o) => o < 0.25).length;
    const large = offsets.filter((o) => o > 0.75).length;

    expect(small / offsets.length).toBeGreaterThan(0.45);
    expect(large / offsets.length).toBeLessThan(0.16);
  });

  it("reads the ball perfectly when the difficulty says so", () => {
    // What practice uses: a partner that keeps the lesson moving.
    for (let i = 0; i < 200; i++) expect(misreadOffset(0)).toBe(0);
    expect(PRACTICE_DIFFICULTY.misjudge).toBe(0);
  });

  it("has no way left to decline a ball", () => {
    // The veto is gone rather than set to zero: an opponent that can refuse to
    // play is one press away from doing it again.
    const knobs = Object.keys(DIFFICULTIES.easy);
    expect(knobs).not.toContain("whiffChance");
    expect(knobs).toContain("misjudge");
  });
});
