import { describe, expect, it } from "vitest";
import { crowdClockStep } from "../src/crowdrig";

describe("the crowd's clock", () => {
  it("does not move a crowd that has nothing to celebrate", () => {
    // The point of the change: between points the stand holds still. Every
    // spectator sits on a different frame of the loop, so a still crowd is
    // still a crowd of individuals rather than one pose repeated.
    const step = crowdClockStep(0, 1 / 60);

    expect(step.advance).toBe(0);
    expect(step.remaining).toBe(0);
  });

  it("runs at full speed while the celebration has time left on it", () => {
    const dt = 1 / 60;
    const step = crowdClockStep(4.5, dt);

    expect(step.advance).toBeCloseTo(dt);
    expect(step.remaining).toBeCloseTo(4.5 - dt);
  });

  it("slows to a halt instead of stopping dead on one frame", () => {
    // Two hundred people freezing on the same frame is more obviously
    // mechanical than the unbroken celebrating this replaces.
    const dt = 1 / 60;
    const early = crowdClockStep(4.5, dt).advance;
    const settling = crowdClockStep(0.6, dt).advance;
    const nearlyDone = crowdClockStep(0.15, dt).advance;

    expect(settling).toBeLessThan(early);
    expect(nearlyDone).toBeLessThan(settling);
    expect(nearlyDone).toBeGreaterThan(0);
  });

  it("comes to rest rather than drifting past zero", () => {
    let remaining = 4.5;
    // Run well past the cheer's length; it must settle, not go negative.
    for (let i = 0; i < 600; i++) remaining = crowdClockStep(remaining, 1 / 60).remaining;

    expect(remaining).toBe(0);
    expect(crowdClockStep(remaining, 1 / 60).advance).toBe(0);
  });

  it("never advances further than the frame it was given", () => {
    // The clock is scaled down to settle, never up: a spectator must not
    // outrun real time on the way to stopping.
    for (const remaining of [0.05, 0.5, 1.2, 3, 10]) {
      const dt = 1 / 30;

      expect(crowdClockStep(remaining, dt).advance).toBeLessThanOrEqual(dt);
    }
  });
});
