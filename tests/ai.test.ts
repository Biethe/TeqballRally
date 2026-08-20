import { describe, expect, it } from "vitest";
import {
  DIFFICULTIES,
  DIFFICULTY,
  READ,
  aiServePattern,
  readError,
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
   * The rule this suite exists for: the opponent always goes for the ball,
   * and every miss it makes is EARNED by the shot.
   *
   * The old model rolled its errors — so points arrived from dice the player
   * could neither cause nor learn. The read is now a deterministic function
   * of the incoming ball: pace strains it, the ball's own lateral travel
   * signs it, and the same shot misreads the same way twice. That is what
   * turns wide diagonals and deep-then-drop into patterns a player can learn.
   */

  it("is earned by the shot: pace strains the read", () => {
    const slow = readError(0.5, 5, 1);
    const fast = readError(0.5, 18, 1);

    expect(Math.abs(fast.dz)).toBeGreaterThan(Math.abs(slow.dz));
    // Along the table: a slow ball is read as it is; a fast one is under-read
    // and drops behind the stand.
    expect(slow.dx).toBe(0);
    expect(fast.dx).toBeLessThan(0);
  });

  it("signs the across-error by the ball's own lateral travel", () => {
    const left = readError(0.5, 12, -1);
    const right = readError(0.5, 12, 1);

    expect(left.dz).toBeLessThan(0);
    expect(right.dz).toBeGreaterThan(0);
    // A straight ball carries no across-error, however fast.
    expect(readError(0.5, 18, 0).dz).toBe(0);
  });

  it("reads the same shot the same way twice", () => {
    for (const pace of [4, 9, 12, 17]) {
      for (const sign of [-1, 0, 1]) {
        expect(readError(0.62, pace, sign)).toEqual(readError(0.62, pace, sign));
      }
    }
  });

  it("never misreads by more than the difficulty allows, at any pace", () => {
    for (const pace of [0, 9, 13, 16, 30]) {
      const r = readError(0.66, pace, 1);
      expect(Math.abs(r.dz)).toBeLessThanOrEqual(0.66 * READ.maxMul + 1e-9);
      expect(Math.abs(r.dx)).toBeLessThanOrEqual(0.66 * READ.maxMul + 1e-9);
    }
  });

  it("reads the ball perfectly when the difficulty says so", () => {
    // What practice uses: a partner that keeps the lesson moving — at any pace.
    for (const pace of [0, 12, 25]) {
      expect(readError(0, pace, 1)).toEqual({ dz: 0, dx: 0 });
    }
    expect(PRACTICE_DIFFICULTY.misjudge).toBe(0);
  });

  it("keeps the ladder: a harder preset reads the same missile better", () => {
    const easy = readError(DIFFICULTIES.easy.misjudge, 18, 1);
    const hard = readError(DIFFICULTIES.hard.misjudge, 18, 1);

    expect(Math.abs(hard.dz)).toBeLessThan(Math.abs(easy.dz));
  });

  it("has no way left to decline a ball", () => {
    // The veto is gone rather than set to zero: an opponent that can refuse to
    // play is one press away from doing it again.
    const knobs = Object.keys(DIFFICULTIES.easy);
    expect(knobs).not.toContain("whiffChance");
    expect(knobs).toContain("misjudge");
  });
});

describe("the AI's patterns", () => {
  it("serves a learnable pattern: side alternates, depth cycles", () => {
    for (let i = 0; i < 12; i++) {
      const p = aiServePattern(i);
      expect(p.lat).toBe(i % 2 === 0 ? 1 : -1);
      expect(p.fwd).toBe([-0.3, 0.2, 0.5][i % 3]);
    }
  });
});
