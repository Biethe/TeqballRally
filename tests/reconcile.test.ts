import { describe, expect, it } from "vitest";
import { SIM_DT } from "../src/config";
import { RECONCILE_DEFAULTS, reconcile, type Point2 } from "../src/net/reconcile";

const at = (x: number, z = 0): Point2 => ({ x, z });

/** Apply the correction repeatedly, as the game loop does. */
function settle(start: Point2, target: Point2, steps: number): Point2 {
  let p = start;
  for (let i = 0; i < steps; i++) p = reconcile(p, target, SIM_DT);
  return p;
}

describe("reconcile", () => {
  it("leaves most of a small error in place on any single step", () => {
    // The point of predicting is that the player keeps their own line; a
    // correction that lands in one step is a tug.
    const next = reconcile(at(0), at(0.5), SIM_DT);

    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(0.1);
  });

  it("removes about a frame's worth of the error each step", () => {
    const k = SIM_DT / RECONCILE_DEFAULTS.time;
    const next = reconcile(at(0), at(1), SIM_DT);

    expect(next.x).toBeCloseTo(k, 10);
  });

  it("converges, rather than approaching forever", () => {
    // Geometric decay never arrives, which would leave a permanent offset
    // between what the player sees and where the host thinks they are.
    const settled = settle(at(0), at(1), 120);

    expect(settled.x).toBe(1);
    expect(settled.z).toBe(0);
  });

  it("takes the target outright once inside the arrival window", () => {
    const next = reconcile(at(0), at(RECONCILE_DEFAULTS.arrive / 2), SIM_DT);
    expect(next.x).toBe(RECONCILE_DEFAULTS.arrive / 2);
  });

  it("abandons the prediction when the gap is too big to be drift", () => {
    // A missed input, or the host moving this character itself. Easing across
    // several metres would look like the player sprinting off on their own.
    const next = reconcile(at(0), at(RECONCILE_DEFAULTS.snap + 1), SIM_DT);
    expect(next.x).toBe(RECONCILE_DEFAULTS.snap + 1);
  });

  it("never overshoots, however long the frame", () => {
    // A stalled frame must not fling the character past where the host says.
    for (const dt of [SIM_DT, 0.1, 0.25, 1, 10]) {
      const next = reconcile(at(0), at(1), dt);
      expect(next.x, `dt ${dt}`).toBeGreaterThan(0);
      expect(next.x, `dt ${dt}`).toBeLessThanOrEqual(1);
    }
  });

  it("corrects both axes together", () => {
    const next = reconcile({ x: 0, z: 0 }, { x: 0.6, z: -0.8 }, SIM_DT);

    expect(next.x).toBeGreaterThan(0);
    expect(next.z).toBeLessThan(0);
    // The correction follows the error's direction rather than favouring an axis.
    expect(next.x / next.z).toBeCloseTo(0.6 / -0.8, 10);
  });

  it("does nothing when the prediction was already right", () => {
    const next = reconcile(at(1.5, -2), at(1.5, -2), SIM_DT);
    expect(next).toEqual({ x: 1.5, z: -2 });
  });

  it("is pure — the inputs are not modified", () => {
    const current = at(0);
    const target = at(1);
    reconcile(current, target, SIM_DT);

    expect(current).toEqual({ x: 0, z: 0 });
    expect(target).toEqual({ x: 1, z: 0 });
  });

  it("closes a typical latency gap within a few tenths of a second", () => {
    // 100 ms of round trip at a 4.5 m/s run is roughly half a metre of drift.
    // It should be gone soon enough not to accumulate, without being snatched
    // back inside one frame.
    const half = settle(at(0), at(0.45), Math.round(0.1 / SIM_DT));
    expect(half.x).toBeGreaterThan(0.1);
    expect(half.x).toBeLessThan(0.35);

    const done = settle(at(0), at(0.45), Math.round(1 / SIM_DT));
    expect(done.x).toBe(0.45);
  });
});
