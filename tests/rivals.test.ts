import { describe, expect, it } from "vitest";
import { CHARACTERS } from "../src/config";
import { RIVALS, STYLES, atLevel, characterFor, rivalFor } from "../src/rivals";

/**
 * The opponents a quick match finds when the queue is empty.
 *
 * What is worth pinning is not who they are but the two properties that make
 * them read as people rather than as a difficulty setting: each plays the same
 * way every time, and whoever a player meets is plausible next to their own
 * standing.
 */
describe("who a quick match finds", () => {
  it("picks somebody near the player's own trophies", () => {
    // Real matchmaking puts like against like. A beginner drawn against the
    // best player in the game gives itself away in one rally.
    const beginner = rivalFor(0, () => 0);
    const veteran = rivalFor(2000, () => 0);

    expect(beginner.trophies).toBeLessThan(veteran.trophies);
  });

  it("does not offer the same person every time", () => {
    const seen = new Set<string>();
    for (const r of [0, 0.4, 0.9]) seen.add(rivalFor(500, () => r).id);

    expect(seen.size).toBeGreaterThan(1);
  });

  it("gives each one a character that is actually in the roster", () => {
    const ids = new Set(CHARACTERS.map((c) => c.id));
    for (const rival of RIVALS) {
      expect(ids.has(rival.character)).toBe(true);
      expect(characterFor(rival)).toBeTruthy();
    }
  });

  it("writes something on every shirt", () => {
    // A blank shirt is what a CPU opponent wears, and the point of these is
    // that they do not look like one.
    for (const rival of RIVALS) expect(rival.kit.name.trim().length).toBeGreaterThan(0);
  });
});

describe("how they play", () => {
  it("keeps the shape of a style while lowering the level", () => {
    // A weak technician is still a technician: the style says how they play,
    // the level only how well. Moving both together is what makes every
    // low-level opponent feel like the same opponent.
    const full = STYLES.technician;
    const weak = atLevel(full, 0);

    expect(weak.aimError).toBeGreaterThan(full.aimError);
    expect(weak.speed).toBeLessThan(full.speed);
    // Still the most accurate style at its own level, which is what it is for.
    expect(atLevel(STYLES.technician, 0.5).aimError).toBeLessThan(
      atLevel(STYLES.hitter, 0.5).aimError
    );
  });

  it("leaves a style untouched at full level", () => {
    for (const style of Object.values(STYLES)) {
      const top = atLevel(style, 1);
      expect(top.speed).toBeCloseTo(style.speed, 10);
      expect(top.aimError).toBeCloseTo(style.aimError, 10);
      expect(top.tactics).toBeCloseTo(style.tactics, 10);
    }
  });

  it("does not let a beginner build points", () => {
    expect(atLevel(STYLES.builder, 0).maxPopTouches).toBe(1);
    expect(atLevel(STYLES.builder, 1).maxPopTouches).toBe(2);
  });

  it("tells the four styles apart", () => {
    // If two styles produced the same numbers there would be no point having
    // both, and the opponents would all feel alike.
    const shapes = Object.values(STYLES).map((s) => JSON.stringify(s));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});
