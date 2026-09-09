import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  distanceToVolume,
  solveBounceArrival,
  sphereOverlaps,
  trajectoryVsVolume,
  volumeAxes,
  volumeToWorld,
  type InteractionVolumeDef,
} from "../src/interaction";
import { stepBall, type BallEvent, type FlightSample } from "../src/ball";
import { GROUND_Y } from "../src/config";

const ORIGIN = new Vector3(0, 0, 0);

function boxDef(center: [number, number, number], quat = [0, 0, 0, 1]): InteractionVolumeDef {
  return {
    clip: "TestClip",
    part: "foot",
    shape: "box",
    center,
    measuredCenter: center,
    quat: quat as [number, number, number, number],
    dims: { shape: "box", hx: 0.5, hy: 0.2, hz: 0.3 },
  };
}

function sphereDef(center: [number, number, number], r = 0.5): InteractionVolumeDef {
  return {
    clip: "TestClip",
    part: "knee",
    shape: "sphere",
    center,
    measuredCenter: center,
    quat: [0, 0, 0, 1],
    dims: { shape: "sphere", r },
  };
}

function flight(points: [number, number, number][], groundedFrom = Infinity): FlightSample[] {
  return points.map(([x, y, z], i) => ({
    t: (i + 1) / 10,
    pos: new Vector3(x, y, z),
    grounded: i >= groundedFrom,
  }));
}

describe("volumeToWorld", () => {
  it("translates the measured centre by the root position at yaw 0", () => {
    const def = boxDef([0.3, 1.1, 0.4]);
    const vol = volumeToWorld(def, new Vector3(2, 0, -1), 0);
    expect(vol.center.x).toBeCloseTo(2.3);
    expect(vol.center.y).toBeCloseTo(1.1);
    expect(vol.center.z).toBeCloseTo(-0.6);
  });

  it("rotates the centre with the character yaw", () => {
    const def = boxDef([1, 0, 0]);
    // Same convention clipContactPoint uses: +yaw maps +X onto -Z.
    const vol = volumeToWorld(def, ORIGIN, Math.PI / 2);
    expect(vol.center.x).toBeCloseTo(0);
    expect(vol.center.z).toBeCloseTo(-1);
  });

  it("composes the measured local orientation over the yaw", () => {
    // 180° about local Z: flips both X and Y of the volume frame.
    const halfPi = Math.PI / 2;
    const flipZ: [number, number, number, number] = [0, 0, 1, 0];
    const vol = volumeToWorld(boxDef([0, 0, 0], flipZ), ORIGIN, halfPi);
    const [ax] = volumeAxes(vol);
    // Yaw alone sends +X to -Z; the flip then negates it again -> +Z.
    expect(ax.x).toBeCloseTo(0, 5);
    expect(ax.z).toBeCloseTo(1, 5);
  });
});

describe("distanceToVolume", () => {
  it("is zero strictly inside a box", () => {
    const vol = volumeToWorld(boxDef([0, 0, 0]), ORIGIN, 0);
    expect(distanceToVolume(vol, new Vector3(0.2, 0.1, 0.1))).toBe(0);
  });

  it("measures across the nearest face of a box", () => {
    const vol = volumeToWorld(boxDef([0, 0, 0]), ORIGIN, 0);
    expect(distanceToVolume(vol, new Vector3(0.8, 0, 0))).toBeCloseTo(0.3);
    // Diagonally out: corner distance, not face distance.
    expect(distanceToVolume(vol, new Vector3(0.8, 0.5, 0))).toBeCloseTo(
      Math.hypot(0.3, 0.3)
    );
  });

  it("respects the volume's own orientation", () => {
    // A long slab rotated 45° in the XY plane (quaternion half-angle: π/8);
    // a point along the rotated axis sits inside the length, the same reach
    // along world X falls off the side.
    const eighth = Math.PI / 8;
    const tiltZ: [number, number, number, number] = [
      0,
      0,
      Math.sin(eighth),
      Math.cos(eighth),
    ];
    const longDef: InteractionVolumeDef = {
      ...boxDef([0, 0, 0], tiltZ),
      dims: { shape: "box", hx: 2.5, hy: 0.2, hz: 0.3 },
    };
    const vol = volumeToWorld(longDef, ORIGIN, 0);
    const along = new Vector3(2 * Math.SQRT1_2, 2 * Math.SQRT1_2, 0);
    expect(distanceToVolume(vol, along)).toBe(0);
    const flat = new Vector3(2, 0, 0);
    expect(distanceToVolume(vol, flat)).toBeCloseTo(Math.SQRT2 - 0.2, 5);
  });

  it("returns negative depth for a sphere's interior", () => {
    const vol = volumeToWorld(sphereDef([0, 0, 0], 0.5), ORIGIN, 0);
    expect(distanceToVolume(vol, ORIGIN)).toBeCloseTo(-0.5);
    expect(distanceToVolume(vol, new Vector3(0.75, 0, 0))).toBeCloseTo(0.25);
  });

  it("capsules measure to the segment, including past the caps", () => {
    const cap: InteractionVolumeDef = {
      clip: "TestClip",
      part: "chest",
      shape: "capsule",
      center: [0, 0, 0],
      measuredCenter: [0, 0, 0],
      quat: [0, 0, 0, 1],
      dims: { shape: "capsule", r: 0.1, length: 1 },
    };
    const vol = volumeToWorld(cap, ORIGIN, 0);
    // Beside the cylinder.
    expect(distanceToVolume(vol, new Vector3(0.3, 0, 0))).toBeCloseTo(0.2);
    // Beyond the top cap: spherical falloff from the pole at y = 0.5.
    expect(distanceToVolume(vol, new Vector3(0, 0.8, 0))).toBeCloseTo(0.2);
  });
});

describe("sphereOverlaps", () => {
  it("expands the volume by the ball radius", () => {
    const vol = volumeToWorld(sphereDef([0, 0, 0], 0.5), ORIGIN, 0);
    expect(sphereOverlaps(vol, new Vector3(0.62, 0, 0), 0.15)).toBe(true);
    expect(sphereOverlaps(vol, new Vector3(0.68, 0, 0), 0.15)).toBe(false);
  });
});

describe("trajectoryVsVolume", () => {
  const vol = volumeToWorld(boxDef([0, 1, 0]), ORIGIN, 0);
  const BALL_R = 0.101;

  it("hits at the first sample inside the volume", () => {
    const path = flight([
      [-2, 1, 0],
      [-1, 1, 0],
      [-0.3, 1, 0],
      [0.5, 1, 0],
      [1.5, 1, 0],
    ]);
    const hit = trajectoryVsVolume(vol, path, BALL_R);
    expect(hit.hit).toBe(true);
    expect(hit.t).toBeCloseTo(0.3);
    expect(hit.clearance).toBeLessThanOrEqual(0);
  });

  it("only selects a lofted ball where it actually passes through, not where it crosses a height", () => {
    // Same height (y = 1) early at x = -2 and late on the way down through the
    // volume. Height-band matching would have taken the first crossing.
    const path = flight([
      [-3, 0.7, 0],
      [-2, 1, 0],
      [-1, 1.5, 0],
      [-0.3, 1.4, 0],
      [0.05, 1.05, 0],
      [0.4, 1, 0],
      [1.2, 0.85, 0],
    ]);
    const hit = trajectoryVsVolume(vol, path, BALL_R);
    expect(hit.hit).toBe(true);
    expect(hit.t).toBeGreaterThanOrEqual(0.5);
  });

  it("reports the closest approach on a miss", () => {
    const path = flight([
      [-2, 1, 0],
      [-1, 1.35, 0],
      [0, 1.5, 0],
      [1, 1.35, 0],
      [2, 1, 0],
    ]);
    const hit = trajectoryVsVolume(vol, path, BALL_R);
    expect(hit.hit).toBe(false);
    expect(hit.t).toBeCloseTo(0.3);
    expect(hit.pos.y).toBeCloseTo(1.5);
    // Over the top face: centre height minus box top (1 + hy), minus the ball.
    expect(hit.clearance).toBeCloseTo(0.5 - 0.2 - BALL_R);
  });

  it("never schedules on a grounded ball", () => {
    const path = flight(
      [
        [-2, 1, 0],
        [-1, 0.5, 0],
        [-0.2, 1, 0],
        [0, 1, 0],
      ],
      1
    );
    const hit = trajectoryVsVolume(vol, path, BALL_R);
    expect(hit.hit).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const path = flight([
      [-1, 1.1, 0.2],
      [-0.2, 1, 0.1],
      [0.6, 0.95, 0],
    ]);
    const a = trajectoryVsVolume(vol, path, BALL_R);
    const b = trajectoryVsVolume(vol, path, BALL_R);
    expect(a.hit).toBe(b.hit);
    expect(a.t).toBe(b.t);
    expect(a.clearance).toBe(b.clearance);
    expect(a.pos.x).toBe(b.pos.x);
    expect(a.pos.y).toBe(b.pos.y);
    expect(a.pos.z).toBe(b.pos.z);
  });

  it("handles an empty flight without throwing", () => {
    const hit = trajectoryVsVolume(vol, [], BALL_R);
    expect(hit.hit).toBe(false);
  });
});

describe("volumeAxes", () => {
  it("gives the world basis at zero yaw and identity orientation", () => {
    const vol = volumeToWorld(boxDef([0, 0, 0]), ORIGIN, 0);
    const [ax, ay, az] = volumeAxes(vol);
    expect(ax.equalsWithEpsilon(new Vector3(1, 0, 0))).toBe(true);
    expect(ay.equalsWithEpsilon(new Vector3(0, 1, 0))).toBe(true);
    expect(az.equalsWithEpsilon(new Vector3(0, 0, 1))).toBe(true);
  });

  it("turns with the character", () => {
    const vol = volumeToWorld(boxDef([0, 0, 0]), ORIGIN, Math.PI / 2);
    const [ax] = volumeAxes(vol);
    expect(ax.x).toBeCloseTo(0, 5);
    expect(ax.z).toBeCloseTo(-1, 5);
  });
});

describe("solveBounceArrival", () => {
  // Flown with the real stepBall, so the dome's tilted normal, restitution and
  // tangential damping are the actual ones — the solver has to agree with them
  // or the ball will not arrive.
  function fly(from: Vector3, vel: Vector3, maxT: number) {
    const s = { pos: from.clone(), vel: vel.clone() };
    const events: BallEvent[] = [];
    const positions: Vector3[] = [];
    let t = 0;
    while (t < maxT) {
      stepBall(s, 1 / 240, (e) => events.push(e));
      t += 1 / 240;
      positions.push(s.pos.clone());
    }
    return {
      events,
      closest: (target: Vector3) =>
        positions.reduce((best, p) => Math.min(best, Vector3.Distance(p, target)), Infinity),
    };
  }

  it("clears the net, bounces once on the receiver's half, and arrives", () => {
    const from = new Vector3(6.4, GROUND_Y + 1.0, 0);
    const V = new Vector3(-3.2, 0.9, 1.1);
    const sol = solveBounceArrival(from, V);
    expect(sol).not.toBeNull();
    const { events, closest } = fly(sol!.pos, sol!.vel, sol!.maxT);
    const tables = events.filter((e) => e.type === "table");
    expect(tables.length).toBe(1);
    expect((tables[0].pos).x).toBeLessThan(0);
    expect(events.some((e) => e.type === "net")).toBe(false);
    expect(closest(V)).toBeLessThan(0.09);
  });

  it("mirrors onto the other half", () => {
    const from = new Vector3(-6.4, GROUND_Y + 1.0, 0);
    const V = new Vector3(3.0, 0.7, -0.8);
    const sol = solveBounceArrival(from, V);
    expect(sol).not.toBeNull();
    const { events, closest } = fly(sol!.pos, sol!.vel, sol!.maxT);
    const tables = events.filter((e) => e.type === "table");
    expect(tables.length).toBe(1);
    expect((tables[0].pos).x).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "net")).toBe(false);
    // A deep strike behind a tall net must arrive steeply, but this volume
    // wants a shallow incoming bounce — the exact-handover model's residual
    // is genuinely large here. The flight stays honest; the arrival approximate.
    expect(closest(V)).toBeLessThan(0.3);
  });

  it("also reaches a volume standing deep and wide, past the table's edge", () => {
    const from = new Vector3(6.4, GROUND_Y + 1.0, 0);
    const V = new Vector3(-4.6, 0.45, -1.4);
    const sol = solveBounceArrival(from, V);
    expect(sol).not.toBeNull();
    const { events, closest } = fly(sol!.pos, sol!.vel, sol!.maxT);
    const tables = events.filter((e) => e.type === "table");
    expect(tables.length).toBe(1);
    expect((tables[0].pos).x).toBeLessThan(0);
    // The volume sits outside the table's width, so the bounce point is
    // clamped onto the table and the handover carries a deliberate sideways
    // kink — the flight stays honest, the arrival approximate.
    expect(closest(V)).toBeLessThan(0.35);
  });

  it("refuses degenerate geometry instead of guessing", () => {
    const from = new Vector3(6.4, GROUND_Y + 1.0, 0);
    expect(solveBounceArrival(from, new Vector3(6.5, 1.0, 0))).toBeNull();
    expect(solveBounceArrival(from, new Vector3(6.3, 1.0, 0.01))).toBeNull();
  });
});
