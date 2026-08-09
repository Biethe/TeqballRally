import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  clampToCourt,
  loftFor,
  onTableHalf,
  rangeFor,
  scatter,
  spreadRadius,
  tableTarget,
  SPREAD,
} from "../src/aim";
import { COURT, TABLE } from "../src/config";

const easy = { power: 0.5, precision: 1, footSpray: 1, stretch: 0 };

describe("spread", () => {
  it("widens with power, so pace is paid for", () => {
    const soft = spreadRadius({ ...easy, power: 0 });
    const hard = spreadRadius({ ...easy, power: 1 });

    expect(hard).toBeGreaterThan(soft * 2);
  });

  it("narrows for a precise striker and widens for an imprecise one", () => {
    const sharp = spreadRadius({ ...easy, precision: 1.4 });
    const blunt = spreadRadius({ ...easy, precision: 0.7 });

    expect(sharp).toBeLessThan(spreadRadius(easy));
    expect(blunt).toBeGreaterThan(spreadRadius(easy));
    // The trait a player will be able to improve has to be able to buy back
    // what full power costs, or there would be no point improving it.
    expect(spreadRadius({ ...easy, power: 1, precision: 2 })).toBeLessThan(
      spreadRadius({ ...easy, power: 0.5, precision: 1 })
    );
  });

  it("punishes a contact taken at full stretch", () => {
    expect(spreadRadius({ ...easy, stretch: 1 })).toBeGreaterThan(spreadRadius(easy));
  });

  it("widens on the weak foot", () => {
    expect(spreadRadius({ ...easy, footSpray: 1.7 })).toBeGreaterThan(spreadRadius(easy));
  });

  it("is never a certainty and never hopeless", () => {
    expect(spreadRadius({ power: 0, precision: 99, footSpray: 0, stretch: 0 })).toBe(SPREAD.min);
    expect(spreadRadius({ power: 1, precision: 0.01, footSpray: 9, stretch: 9 })).toBe(SPREAD.max);
  });

  it("can carry a kick off the table, which is the whole point", () => {
    // Aimed at the back line of a 1.5 m half and struck flat out: the spread
    // has to be able to take it long, or "missing" is not a thing that exists.
    const radius = spreadRadius({ ...easy, power: 1 });
    expect(TABLE.halfLen + radius).toBeGreaterThan(TABLE.halfLen);
    expect(radius).toBeGreaterThan(0.3);
  });
});

describe("scatter", () => {
  it("stays inside the radius", () => {
    const target = new Vector3(1, 0, 0);
    let worst = 0;
    let seed = 0;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 2000; i++) {
      const p = scatter(target, 0.5, rand);
      worst = Math.max(worst, Math.hypot(p.x - target.x, p.z - target.z));
    }

    expect(worst).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(worst).toBeGreaterThan(0.45); // and actually reaches the edge
  });

  it("leaves the height alone and does not mutate its input", () => {
    const target = new Vector3(1, 0.8, 0.2);
    const out = scatter(target, 0.4, () => 0.5);

    expect(out.y).toBe(0.8);
    expect(target.asArray()).toEqual([1, 0.8, 0.2]);
  });

  it("puts the ball exactly where it was aimed when there is no spread", () => {
    const target = new Vector3(1, 0, -0.4);
    const out = scatter(target, 0, () => 0.7);

    expect(out.x).toBeCloseTo(target.x, 9);
    expect(out.z).toBeCloseTo(target.z, 9);
  });
});

describe("power shapes the ball", () => {
  it("flattens the arc as it rises", () => {
    expect(loftFor(0)).toBeGreaterThan(loftFor(0.5));
    expect(loftFor(0.5)).toBeGreaterThan(loftFor(1));
    // A hard kick is still an arc, not a straight line through the net.
    expect(loftFor(1)).toBeGreaterThan(0);
  });

  it("carries further the harder it is struck", () => {
    expect(rangeFor(1)).toBeGreaterThan(rangeFor(0.5));
    expect(rangeFor(0.5)).toBeGreaterThan(rangeFor(0));
    // The softest kick has to reach across the net from the service area, and
    // the hardest has to be able to overrun the far side of the table.
    expect(rangeFor(0)).toBeGreaterThan(TABLE.halfLen);
    expect(rangeFor(1)).toBeGreaterThan(TABLE.length + 2);
  });

  it("clamps its inputs rather than trusting them", () => {
    expect(loftFor(-3)).toBe(loftFor(0));
    expect(rangeFor(9)).toBe(rangeFor(1));
  });
});

describe("court geometry", () => {
  it("keeps an aim point on the court", () => {
    const out = clampToCourt(new Vector3(99, 0, -99));

    expect(out.x).toBe(COURT.maxX);
    expect(out.z).toBe(-COURT.maxZ);
  });

  it("knows which side of the table a point is on, and what is off it", () => {
    expect(onTableHalf(new Vector3(1, 0, 0), 1)).toBe(true);
    expect(onTableHalf(new Vector3(1, 0, 0), -1)).toBe(false);
    // Just past the end line and just past the sideline: both misses.
    expect(onTableHalf(new Vector3(TABLE.halfLen + 0.01, 0, 0), 1)).toBe(false);
    expect(onTableHalf(new Vector3(1, 0, TABLE.halfWid + 0.01), 1)).toBe(false);
  });

  it("maps a normalised aim onto the attacking half", () => {
    const deep = tableTarget(1, 1, 0);
    const short = tableTarget(1, -1, 0);
    const left = tableTarget(1, 0, 1);

    expect(deep.x).toBeGreaterThan(short.x);
    expect(left.z).toBeGreaterThan(0);
    for (const p of [deep, short, left, tableTarget(-1, 0.5, -0.5)]) {
      expect(onTableHalf(p, Math.sign(p.x))).toBe(true);
    }
  });
});
