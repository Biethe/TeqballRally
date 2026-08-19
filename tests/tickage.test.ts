import { describe, expect, it } from "vitest";
import { AGE_BASE_RELEASE, TickAge } from "../src/net/sync";
import { MAX_CATCHUP_TICKS } from "../src/net/protocol";

/**
 * Two peers must agree about how old a frame is without sharing a clock. The
 * estimator's contract, tested where it lives: pure, and deterministic.
 */
describe("the age of an arriving snapshot", () => {
  it("shows no age for the first frame — the route has no history yet", () => {
    const age = new TickAge();
    expect(age.observe(123)).toBe(0);
  });

  it("reports delay as the excess over the fastest frame seen", () => {
    const age = new TickAge();
    age.observe(10);
    // An unchanged route reads (almost) zero, however long it stays that way.
    expect(age.observe(10)).toBeLessThanOrEqual(AGE_BASE_RELEASE);
    // Two samples past the baseline: the excess less two floor releases.
    expect(age.observe(13)).toBeCloseTo(3 - 2 * AGE_BASE_RELEASE, 10);
  });

  it("drops the floor the moment a faster frame arrives", () => {
    const age = new TickAge();
    age.observe(10);
    age.observe(14);
    expect(age.observe(8)).toBe(0); // a new minimum is a new floor
    // And slower frames now read against the new floor.
    expect(age.observe(11)).toBeCloseTo(3 - AGE_BASE_RELEASE, 10);
  });

  it("releases the floor slowly so a lagging clock is not latency forever", () => {
    // A device that drops its accumulator remainder falls behind wall time;
    // the samples then grow for reasons that are not transport. A floor that
    // never moved would read that drift as delay, forever.
    const age = new TickAge();
    age.observe(10);
    let sample = 10;
    for (let i = 0; i < 50; i++) {
      sample += AGE_BASE_RELEASE;
      expect(age.observe(sample)).toBeCloseTo(0, 6);
    }
  });

  it("never reports a negative age, however the clocks sit", () => {
    const age = new TickAge();
    age.observe(50);
    expect(age.observe(20)).toBe(0); // the floor moves down instead
    expect(age.observe(50)).toBeGreaterThanOrEqual(0);
  });

  it("caps the age at the catch-up budget, however late a frame is", () => {
    const age = new TickAge();
    age.observe(0);
    expect(age.observe(10_000)).toBe(MAX_CATCHUP_TICKS);
  });

  it("ignores samples that are not numbers, and calibrates nothing on them", () => {
    const age = new TickAge();
    expect(age.observe(NaN)).toBe(0);
    expect(age.observe(Infinity)).toBe(0);
    // A real first sample still starts clean.
    expect(age.observe(7)).toBe(0);
  });

  it("starts over on reset", () => {
    const age = new TickAge();
    age.observe(10);
    age.observe(16);
    age.reset();
    expect(age.observe(99)).toBe(0);
  });
});
