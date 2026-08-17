import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  SMASH_RANGE,
  canSmashFrom,
  clampToCourt,
  clampToPlay,
  loftFloor,
  loftFor,
  onTableHalf,
  rangeFor,
  scatter,
  spreadRadius,
  swipeShot,
  swipeTarget,
  tableTarget,
  SPREAD,
  SWIPE_BAND,
} from "../src/aim";
import { COURT, PLAY_BOX, TABLE, TABLE_SCALE } from "../src/config";

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
  it("keeps a walking destination on the court", () => {
    const out = clampToCourt(new Vector3(99, 0, -99));

    expect(out.x).toBe(COURT.maxX);
    expect(out.z).toBe(-COURT.maxZ);
  });

  it("keeps a kick inside the playable box, well short of the crowd", () => {
    const out = clampToPlay(new Vector3(99, 0, -99));

    expect(out.x).toBe(PLAY_BOX.halfLen);
    expect(out.z).toBe(-PLAY_BOX.halfWid);
    // Room to miss, but only just: the box is a margin around the table, not
    // the whole court, so a wild kick lands beside it rather than in the seats.
    expect(PLAY_BOX.halfLen).toBeGreaterThan(TABLE.halfLen);
    expect(PLAY_BOX.halfLen).toBeLessThan(COURT.maxX);
    // A hand's width of grass, not a run-off area. Every miss has to read as
    // one that nearly went in, so the margin stays a fraction of the table.
    expect(PLAY_BOX.halfLen - TABLE.halfLen).toBeLessThan(TABLE.halfLen * 0.3);
    expect(PLAY_BOX.halfWid - TABLE.halfWid).toBeLessThan(TABLE.halfWid * 0.5);
  });

  it("never lets the widest possible spread escape the box", () => {
    // The clamp is applied after the scatter, so even the worst kick from the
    // furthest legal aim stays inside it.
    const corner = clampToPlay(new Vector3(PLAY_BOX.halfLen, 0, PLAY_BOX.halfWid));
    const wild = clampToPlay(scatter(corner, SPREAD.max, () => 0.99));

    expect(Math.abs(wild.x)).toBeLessThanOrEqual(PLAY_BOX.halfLen);
    expect(Math.abs(wild.z)).toBeLessThanOrEqual(PLAY_BOX.halfWid);
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

describe("where you stand decides what you can hit", () => {
  /**
   * The rule: the flat, hard shots belong to the middle line.
   *
   * From the back of the court there is no angle through which a driven ball
   * clears the net and still comes down on the table, so swiping as fast as
   * possible from deep has to produce a fast *lob* rather than a missile.
   * Attacking therefore means coming forward, and coming forward costs the
   * time it takes to get back.
   */

  it("puts no floor under a kick taken up at the table", () => {
    expect(loftFloor(0)).toBe(0);
    expect(loftFloor(SMASH_RANGE)).toBe(0);
    expect(canSmashFrom(SMASH_RANGE)).toBe(true);
  });

  it("forces the ball up from behind it, more the further back you are", () => {
    const near = loftFloor(SMASH_RANGE + 0.5);
    const deep = loftFloor(SMASH_RANGE + 2);

    expect(near).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(near);
    expect(canSmashFrom(SMASH_RANGE + 0.5)).toBe(false);
  });

  it("ramps rather than switching, so the line can be felt", () => {
    // A cliff would make one step back change the shot completely, which reads
    // as a bug rather than as a rule. Measured on the loft a full-power swipe
    // actually gets, since that is what a player feels — the floor's own value
    // is allowed to jump from nothing to the point where it starts binding.
    const effective = (x: number) => Math.max(loftFor(1), loftFloor(x));
    let previous = effective(SMASH_RANGE - 0.5);
    for (let past = -0.5; past <= 2; past += 0.05) {
      const now = effective(SMASH_RANGE + past);
      expect(now - previous, `at ${past.toFixed(2)}m past the line`).toBeLessThan(0.06);
      previous = now;
    }
  });

  it("starts binding exactly where the flattest kick already was", () => {
    // So that crossing the line costs nothing and the cost grows from there.
    expect(loftFloor(SMASH_RANGE + 0.0001)).toBeCloseTo(loftFor(1), 3);
  });

  it("never forces so much loft that the ball goes straight up", () => {
    expect(loftFloor(100)).toBeLessThanOrEqual(1.6);
  });

  it("is symmetric, so it reads the same from either end", () => {
    expect(loftFloor(-(SMASH_RANGE + 1))).toBe(loftFloor(SMASH_RANGE + 1));
    expect(canSmashFrom(-SMASH_RANGE)).toBe(true);
  });

  it("beats a full-power swipe from the back", () => {
    // The floor has to actually bind: a hard kick from deep is the exact shot
    // this exists to prevent.
    expect(loftFloor(SMASH_RANGE + 1.4)).toBeGreaterThan(loftFor(1));
  });

  it("leaves a full-power swipe from the table alone", () => {
    expect(loftFloor(SMASH_RANGE)).toBeLessThanOrEqual(loftFor(1));
  });
});

describe("swipe speed and arc", () => {
  it("floats a slow swipe and drills a fast one", () => {
    expect(loftFor(0)).toBeGreaterThan(loftFor(0.5));
    expect(loftFor(0.5)).toBeGreaterThan(loftFor(1));
  });

  it("spreads the two far enough apart to see", () => {
    // In portrait the swipe's speed is the only thing the gesture says about
    // the shot, so the difference has to show up in the arc.
    expect(loftFor(0) / loftFor(1)).toBeGreaterThan(3);
  });

  it("clamps a swipe that overran the range", () => {
    expect(loftFor(-1)).toBe(loftFor(0));
    expect(loftFor(2)).toBe(loftFor(1));
  });
});

describe("reading a swipe as a shot", () => {
  /** A swipe drawn at `degrees` above the sideways axis, at half pace. */
  const at = (degrees: number, pace = 0.5) => {
    const r = (degrees * Math.PI) / 180;
    return swipeShot(Math.sin(r), Math.cos(r), pace);
  };

  it("drives a diagonal upward swipe: fast, flat and deep", () => {
    const up = at(45);

    expect(up.category).toBe("drive");
    expect(up.power).toBeGreaterThan(at(0).power);
    expect(up.loft).toBeLessThan(at(0).loft);
    expect(up.depth).toBeGreaterThan(at(0).depth);
  });

  it("lobs a diagonal downward swipe: slow, high and short", () => {
    const down = at(-45);

    expect(down.category).toBe("lob");
    expect(down.power).toBeLessThan(at(0).power);
    expect(down.loft).toBeGreaterThan(at(0).loft);
    expect(down.depth).toBeLessThan(at(0).depth);
  });

  it("plays a sideways swipe as the rally ball, between the two", () => {
    const across = at(0);

    expect(across.category).toBe("balanced");
    expect(across.loft).toBeLessThan(at(-45).loft);
    expect(across.loft).toBeGreaterThan(at(45).loft);
  });

  it("orders the three by pace and by arc, in opposite directions", () => {
    // The whole lesson the scheme has to teach: up is fast and flat, down is
    // slow and high, across is neither.
    expect(at(60).power).toBeGreaterThan(at(0).power);
    expect(at(0).power).toBeGreaterThan(at(-60).power);
    expect(at(60).loft).toBeLessThan(at(0).loft);
    expect(at(0).loft).toBeLessThan(at(-60).loft);
  });

  it("does not ask for a pixel-perfect diagonal", () => {
    // A thumb does not draw a clean 45 degrees. Anything clearly upward is the
    // drive, and it stays the drive all the way to straight up.
    for (const deg of [40, 55, 70, 90]) expect(at(deg).category, `${deg}`).toBe("drive");
    for (const deg of [-40, -55, -70, -90]) expect(at(deg).category, `${deg}`).toBe("lob");
  });

  it("blends across the boundary instead of switching at it", () => {
    // A swipe near the edge of a band produces a shot near the edge of the
    // band, so a gesture that lands one degree either side of it does not
    // produce two very different balls.
    const below = at(15);
    const above = at(20);

    expect(Math.abs(above.loft - below.loft)).toBeLessThan(0.25);
    expect(below.power).toBeLessThan(above.power);
  });

  it("is the same shot for the same swipe, every time", () => {
    for (let i = 0; i < 100; i++) {
      const shot = at(37, 0.62);
      expect(shot.power).toBe(at(37, 0.62).power);
      expect(shot.loft).toBe(at(37, 0.62).loft);
    }
  });

  it("lets the pace of the swipe decide how much of the shot it gets", () => {
    expect(at(45, 1).power).toBeGreaterThan(at(45, 0).power);
    expect(at(-45, 1).power).toBeGreaterThan(at(-45, 0).power);
    // A lob is a decision to give up pace: even flat out it is the slower ball.
    expect(at(-45, 1).power).toBeLessThan(at(45, 0).power);
  });

  it("keeps the bands where a thumb can find them", () => {
    expect(SWIPE_BAND.from).toBeLessThan(SWIPE_BAND.full);
    expect(SWIPE_BAND.from).toBeGreaterThan(0);
    expect(SWIPE_BAND.full).toBeLessThan(1);
  });

  it("never asks for more than the striker has", () => {
    for (let deg = -90; deg <= 90; deg += 5) {
      const shot = at(deg, 1);
      expect(shot.power, `${deg}`).toBeGreaterThan(0);
      expect(shot.power, `${deg}`).toBeLessThanOrEqual(1);
      expect(shot.loft, `${deg}`).toBeGreaterThan(0);
    }
  });
});

describe("where a swiped kick is aimed", () => {
  const from = new Vector3(-3 * TABLE_SCALE, 0, 0);

  it("always sends the ball up the court, whichever way the swipe went", () => {
    // A downward swipe used to aim at a point behind the player — the one
    // gesture in the scheme that could only ever lose the point.
    for (const deg of [90, 45, 0, -45, -90]) {
      const r = (deg * Math.PI) / 180;
      const shot = swipeShot(Math.sin(r), Math.cos(r), 0.6);
      const target = swipeTarget(from, 1, Math.cos(r), shot);

      expect(target.x, `${deg}`).toBeGreaterThan(from.x);
    }
  });

  it("aims the sideways half of the swipe sideways", () => {
    const shot = swipeShot(0.7, 0.7, 0.6);
    const left = swipeTarget(from, 1, 1, shot);
    const right = swipeTarget(from, 1, -1, shot);

    expect(left.z).toBeGreaterThan(from.z);
    expect(right.z).toBeLessThan(from.z);
    expect(swipeTarget(from, 1, 0, shot).z).toBeCloseTo(from.z, 10);
  });

  it("drives deeper than it lobs", () => {
    const drive = swipeShot(1, 0, 0.8);
    const lob = swipeShot(-1, 0, 0.8);

    expect(swipeTarget(from, 1, 0, drive).x).toBeGreaterThan(swipeTarget(from, 1, 0, lob).x);
  });

  it("keeps every swipe inside the playable box", () => {
    for (let deg = -90; deg <= 90; deg += 10) {
      const r = (deg * Math.PI) / 180;
      const shot = swipeShot(Math.sin(r), Math.cos(r), 1);
      for (const lat of [-1, 0, 1]) {
        const target = swipeTarget(from, 1, lat, shot);
        expect(Math.abs(target.x), `${deg}`).toBeLessThanOrEqual(PLAY_BOX.halfLen);
        expect(Math.abs(target.z), `${deg}`).toBeLessThanOrEqual(PLAY_BOX.halfWid);
      }
    }
  });

  it("mirrors for the far side of the net", () => {
    const shot = swipeShot(1, 0, 0.6);
    const other = new Vector3(3 * TABLE_SCALE, 0, 0);

    expect(swipeTarget(other, -1, 0, shot).x).toBeLessThan(other.x);
  });
});
