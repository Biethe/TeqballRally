import { describe, expect, it } from "vitest";
import { INTRO_SECONDS, introPose, type Pose } from "../src/intro";
import { GROUND_Y } from "../src/config";
import { VENUE_IDS, venueFor } from "../src/venue";

/** Roughly the play camera on the default venue: behind the near player, high. */
const PLAY: Pose = { x: -12.5, y: GROUND_Y + 6.3, z: 0, tx: 0, ty: GROUND_Y + 0.3, tz: 0 };

const distanceTo = (p: Pose, q: { x: number; y: number; z: number }): number =>
  Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

describe("the establishing shot", () => {
  it("ends exactly on the play camera", () => {
    const end = introPose(1, PLAY);
    expect(end).toEqual(PLAY);
  });

  // The handover is the moment a mistake would be visible, so the last frames
  // have to already be the real shot rather than merely near it.
  it("arrives smoothly rather than snapping at the end", () => {
    const almost = introPose(0.97, PLAY);
    expect(distanceTo(almost, PLAY)).toBeLessThan(0.25);
  });

  it("starts well back from the play camera", () => {
    const start = introPose(0, PLAY);
    expect(distanceTo(start, PLAY)).toBeGreaterThan(8);
    expect(start.y).toBeGreaterThan(PLAY.y);
  });

  it("never puts the camera under the floor", () => {
    for (let u = 0; u <= 1; u += 0.02) {
      expect(introPose(u, PLAY).y).toBeGreaterThan(GROUND_Y);
    }
  });

  // Swinging around the court is the point: a straight line from the start
  // pose would pass through the table and the far player.
  it("keeps its distance from the table all the way in", () => {
    for (let u = 0; u <= 1; u += 0.02) {
      const p = introPose(u, PLAY);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(3);
    }
  });

  it("moves in one direction, without doubling back", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let u = 0; u <= 1; u += 0.02) {
      const radius = Math.hypot(introPose(u, PLAY).x, introPose(u, PLAY).z);
      expect(radius).toBeLessThanOrEqual(previous + 1e-9);
      previous = radius;
    }
  });

  // The indoor hall has a roof. Its sweep has to stay under it, and the way
  // that goes wrong is silent: the shot simply opens outside the building.
  it("keeps a roofed venue's sweep under its roof", () => {
    const indoor = { radius: 5.5, height: 2.2, swing: 1.15 };
    for (let u = 0; u <= 1; u += 0.02) {
      const p = introPose(u, PLAY, indoor);
      expect(p.y).toBeLessThan(PLAY.y + indoor.height + 0.001);
      expect(Math.hypot(p.x, p.z)).toBeLessThan(Math.hypot(PLAY.x, PLAY.z) + indoor.radius + 0.001);
    }
  });

  it("holds a bounded sweep inside its bounds", () => {
    const bounded = { radius: 2.5, height: 2.4, swing: 1.5, boundX: 13, boundZ: 5.6 };
    for (let u = 0; u < 1; u += 0.02) {
      const p = introPose(u, PLAY, bounded);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(13 + 1e-9);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(5.6 + 1e-9);
    }
  });

  // A bound tighter than the play camera would hold the shot inside it and
  // then jump out at the handover, which is the one thing the whole approach
  // exists to avoid.
  it("uses bounds that already contain the play camera", () => {
    for (const id of VENUE_IDS) {
      const { sweep } = venueFor(id);
      if (!sweep) continue;
      if (sweep.boundX !== undefined) expect(sweep.boundX).toBeGreaterThanOrEqual(Math.abs(PLAY.x));
      if (sweep.boundZ !== undefined) expect(sweep.boundZ).toBeGreaterThanOrEqual(Math.abs(PLAY.z));
    }
  });

  it("clamps a time outside the shot to its endpoints", () => {
    expect(introPose(-1, PLAY)).toEqual(introPose(0, PLAY));
    expect(introPose(4, PLAY)).toEqual(PLAY);
  });

  // It plays before the first serve of every offline match, so it has to be
  // short enough not to be in the way of a rematch.
  it("is over in a few seconds", () => {
    expect(INTRO_SECONDS).toBeGreaterThan(1.5);
    expect(INTRO_SECONDS).toBeLessThan(6);
  });

  // The play camera tracks the ball, so the pose it has to arrive at moves
  // between frames. Following a moving target must not make the path jump.
  it("follows a play camera that is itself moving", () => {
    const drifted: Pose = { ...PLAY, x: PLAY.x + 0.4, z: PLAY.z + 0.3 };
    const a = introPose(0.8, PLAY);
    const b = introPose(0.8, drifted);
    expect(distanceTo(a, b)).toBeLessThan(1);
  });
});
