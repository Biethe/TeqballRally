import { describe, expect, it } from "vitest";
import { Crowd } from "../src/crowd";

/** A thin-instance matrix buffer for `n` people standing in a row. */
function seats(n: number): Float32Array {
  const buffer = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) {
    // Identity, then the translation columns Babylon keeps at 12, 13, 14.
    buffer[i * 16] = 1;
    buffer[i * 16 + 5] = 1;
    buffer[i * 16 + 10] = 1;
    buffer[i * 16 + 15] = 1;
    buffer[i * 16 + 12] = i * 0.7;
    buffer[i * 16 + 13] = 0.4;
    buffer[i * 16 + 14] = 6.5;
  }
  return buffer;
}

const BASE = 0.4;

const heights = (b: Float32Array): number[] =>
  Array.from({ length: b.length / 16 }, (_, i) => b[i * 16 + 13]);

/** How far above their seat everyone is. Float32 cannot hold 0.4 exactly. */
const lifts = (b: Float32Array): number[] => heights(b).map((y) => y - BASE);

function run(crowd: Crowd, seconds: number, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) crowd.update(step);
}

describe("the crowd", () => {
  it("does nothing at all until somebody is placed", () => {
    const crowd = new Crowd();
    expect(crowd.ready).toBe(false);
    // Must not throw, and must not need a scene.
    crowd.update(0.016);
    crowd.celebrate();
  });

  it("leaves a resting crowd exactly where it was placed", () => {
    const buffer = seats(4);
    const crowd = new Crowd();
    crowd.add(buffer, () => {});
    run(crowd, 2);
    for (const lift of lifts(buffer)) expect(lift).toBeCloseTo(0, 5);
  });

  it("moves during a rally", () => {
    const buffer = seats(6);
    const crowd = new Crowd();
    crowd.add(buffer, () => {});
    crowd.setEngaged(true);
    run(crowd, 1.5);
    expect(lifts(buffer).some((lift) => lift > 0.001)).toBe(true);
  });

  // Everyone rocking in lockstep is the thing that makes a crowd read as one
  // object rather than a lot of people.
  it("does not move everyone in unison", () => {
    const buffer = seats(12);
    const crowd = new Crowd();
    crowd.add(buffer, () => {});
    crowd.setEngaged(true);
    run(crowd, 1);
    expect(new Set(heights(buffer).map((y) => y.toFixed(4))).size).toBeGreaterThan(3);
  });

  it("jumps higher for a point than it ever does for a rally", () => {
    const rally = seats(8);
    const idle = new Crowd();
    idle.add(rally, () => {});
    idle.setEngaged(true);
    let rallyPeak = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      idle.update(1 / 60);
      rallyPeak = Math.max(rallyPeak, ...lifts(rally));
    }

    const party = seats(8);
    const winning = new Crowd();
    winning.add(party, () => {});
    winning.celebrate();
    let peak = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
      winning.update(1 / 60);
      peak = Math.max(peak, ...lifts(party));
    }
    // Lift above the seat, not absolute height: both include the same base,
    // and comparing those would compare mostly the floor.
    expect(peak).toBeGreaterThan(rallyPeak * 3);
  });

  it("settles back down after celebrating", () => {
    const buffer = seats(5);
    const crowd = new Crowd();
    crowd.add(buffer, () => {});
    crowd.celebrate();
    run(crowd, 8);
    for (const lift of lifts(buffer)) expect(lift).toBeCloseTo(0, 3);
  });

  it("tells the mesh its buffer changed, but only while there is movement", () => {
    const buffer = seats(3);
    const crowd = new Crowd();
    let flushes = 0;
    crowd.add(buffer, () => flushes++);
    run(crowd, 0.5);
    expect(flushes).toBe(0);
    crowd.setEngaged(true);
    run(crowd, 0.5);
    expect(flushes).toBeGreaterThan(0);
  });

  // Nobody may drift: the animation is an offset from a fixed seat, and an
  // error that accumulates would walk the crowd off the venue over a long set.
  it("keeps everyone on their own spot however long it runs", () => {
    const buffer = seats(4);
    const crowd = new Crowd();
    crowd.add(buffer, () => {});
    crowd.setEngaged(true);
    run(crowd, 30);
    crowd.setEngaged(false);
    run(crowd, 6);
    for (const lift of lifts(buffer)) expect(lift).toBeCloseTo(0, 4);
    for (let i = 0; i < 4; i++) {
      expect(buffer[i * 16 + 12]).toBeCloseTo(i * 0.7, 6);
      expect(buffer[i * 16 + 14]).toBeCloseTo(6.5, 6);
    }
  });
});
