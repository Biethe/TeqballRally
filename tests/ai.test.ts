import { describe, expect, it } from "vitest";
import { DIFFICULTIES, DIFFICULTY, type AIDifficulty, type DifficultyLevel } from "../src/ai";
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
      // And less likely to hand over a free point.
      expect(harder.whiffChance, `${label} whiffChance`).toBeLessThan(easier.whiffChance);
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
      expect(d.whiffChance, `${name} whiffChance`).toBeGreaterThanOrEqual(0);
      expect(d.whiffChance, `${name} whiffChance`).toBeLessThanOrEqual(1);
      expect(d.popChance, `${name} popChance`).toBeGreaterThanOrEqual(0);
      expect(d.popChance, `${name} popChance`).toBeLessThanOrEqual(1);
      // Seconds and metres of error.
      expect(d.reactionTime, `${name} reactionTime`).toBeGreaterThanOrEqual(0);
      expect(d.aimError, `${name} aimError`).toBeGreaterThanOrEqual(0);
      // Control touches have to fit inside the touch allowance.
      expect(d.maxPopTouches, `${name} maxPopTouches`).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d.maxPopTouches), `${name} maxPopTouches`).toBe(true);
    }
  });
});
