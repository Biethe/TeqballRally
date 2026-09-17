import { describe, expect, it } from "vitest";
import { RateMeter } from "../src/netstats";

describe("the rate meter", () => {
  it("reads frames, simulation ticks and dropped time per second over its window", () => {
    const m = new RateMeter(3);
    // Twenty frames a second, each running four ticks and dropping 10 ms.
    for (let i = 0; i <= 60; i++) m.record(i / 20, 4, 0.01);
    expect(m.fps).toBeCloseTo(20, 6);
    expect(m.simTicksPerSecond).toBeCloseTo(80, 6);
    expect(m.droppedPerSecond).toBeCloseTo(0.2, 6);
  });

  it("forgets what is older than its window", () => {
    const m = new RateMeter(1);
    for (let i = 0; i <= 60; i++) m.record(i / 60, 1, 0);
    // A slow patch after the window has moved on is all it reports.
    for (let i = 1; i <= 20; i++) m.record(1 + i / 10, 1, 0);
    expect(m.fps).toBeCloseTo(10, 0);
  });

  it("splits a frame into game time and render time", () => {
    const m = new RateMeter(3);
    // Three steps a frame taking 6 ms between them, and a 20 ms render call.
    for (let i = 0; i <= 40; i++) m.record(i / 20, 3, 0, 6, 20);
    expect(m.simMsPerFrame).toBeCloseTo(6, 9);
    expect(m.renderMsPerFrame).toBeCloseTo(20, 9);
    expect(m.ticksPerFrame).toBeCloseTo(3, 9);
  });

  it("reads nothing until there is a span to read over", () => {
    const m = new RateMeter();
    expect(m.fps).toBe(0);
    m.record(1, 2, 0);
    expect(m.simTicksPerSecond).toBe(0);
  });
});
