import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  MAX_SPEED,
  type BallEvent,
  type BallState,
  type BodyCollider,
  capLaunchApex,
  heightAtNet,
  predict,
  sampleFlight,
  solveLaunch,
  solveLaunchClearingNet,
  stepBall,
} from "../src/ball";
import {
  BALL_PACE,
  BALL_RADIUS,
  GRAVITY,
  GROUND_Y,
  TABLE,
  tableSurfaceY,
} from "../src/config";

/** Closed-form ballistic position, ignoring collisions. */
function ballisticAt(from: Vector3, v: Vector3, t: number): Vector3 {
  return new Vector3(
    from.x + v.x * t,
    from.y + v.y * t - 0.5 * GRAVITY * t * t,
    from.z + v.z * t
  );
}

/** Run the ball forward in `dt` slices, collecting every event it emits. */
function simulate(state: BallState, seconds: number, dt = 1 / 120, colliders?: BodyCollider[]) {
  const events: BallEvent[] = [];
  for (let t = 0; t < seconds; t += dt) {
    stepBall(state, dt, (e) => events.push(e), colliders);
  }
  return events;
}

describe("solveLaunch", () => {
  it("lands exactly on the target at the requested flight time", () => {
    const from = new Vector3(-3, 1.2, 0.4);
    const target = new Vector3(1.1, 1.05, -0.6);
    const t = 0.8;

    const landed = ballisticAt(from, solveLaunch(from, target, t), t);

    expect(landed.x).toBeCloseTo(target.x, 10);
    expect(landed.y).toBeCloseTo(target.y, 10);
    expect(landed.z).toBeCloseTo(target.z, 10);
  });

  it("needs less loft as the flight time shortens", () => {
    const from = new Vector3(-3, 1.2, 0);
    const target = new Vector3(1.2, 1.0, 0);

    const slow = solveLaunch(from, target, 1.2);
    const fast = solveLaunch(from, target, 0.5);

    expect(fast.y).toBeLessThan(slow.y);
    expect(Math.abs(fast.x)).toBeGreaterThan(Math.abs(slow.x));
  });
});

describe("heightAtNet", () => {
  it("matches the ballistic height at the moment x reaches 0", () => {
    const from = new Vector3(-2.5, 1.3, 0);
    const v = new Vector3(5, 3, 0);
    const t = -from.x / v.x;

    expect(heightAtNet(from, v)).toBeCloseTo(ballisticAt(from, v, t).y, 10);
  });

  it("is NaN when the ball never crosses the net plane", () => {
    const from = new Vector3(-2.5, 1.3, 0);

    // Moving away from the net: the crossing time is negative.
    expect(heightAtNet(from, new Vector3(-4, 3, 0))).toBeNaN();
    // Purely vertical: no crossing at all.
    expect(heightAtNet(from, new Vector3(0, 5, 0))).toBeNaN();
  });
});

describe("solveLaunchClearingNet", () => {
  const netTapeY = GROUND_Y + TABLE.netTop;

  it("lofts the arc until the ball's underside clears the tape", () => {
    const from = new Vector3(-2.6, 0.75, 0);
    const target = new Vector3(1.2, GROUND_Y + TABLE.hCenter, 0);
    const clearance = 0.18;

    // A flat 0.35 s line drive from below the tape cannot clear it...
    const flat = solveLaunch(from, target, 0.35);
    expect(heightAtNet(from, flat) - BALL_RADIUS).toBeLessThan(netTapeY + clearance);

    // ...so the solver must return something higher over the net.
    const v = solveLaunchClearingNet(from, target, 0.35, clearance);
    expect(heightAtNet(from, v) - BALL_RADIUS).toBeGreaterThan(netTapeY + clearance);
  });

  it("keeps a flat smash flat when a small clearance is requested", () => {
    const from = new Vector3(-1.9, 1.9, 0);
    const target = new Vector3(1.2, GROUND_Y + TABLE.hCenter, 0);

    const tight = solveLaunchClearingNet(from, target, 0.32, 0.02);
    const lofted = solveLaunchClearingNet(from, target, 0.32, 0.6);

    expect(heightAtNet(from, tight)).toBeLessThan(heightAtNet(from, lofted));
    expect(heightAtNet(from, tight) - BALL_RADIUS).toBeGreaterThan(netTapeY + 0.02);
  });

  it("returns the plain solution when the shot stays on one side of the net", () => {
    const from = new Vector3(-3, 1.2, 0);
    const target = new Vector3(-1.2, 1.4, 0.5); // same side: no net between them

    const v = solveLaunchClearingNet(from, target, 0.5);

    expect(v.x).toBeCloseTo(solveLaunch(from, target, 0.5).x, 10);
    expect(v.y).toBeCloseTo(solveLaunch(from, target, 0.5).y, 10);
  });

  it("still lands on the target after lofting", () => {
    const from = new Vector3(-2.6, 0.75, 0.3);
    const target = new Vector3(1.2, GROUND_Y + TABLE.hCenter, -0.4);

    const v = solveLaunchClearingNet(from, target, 0.35);
    // Recover the flight time the solver settled on from the horizontal leg.
    const t = (target.x - from.x) / v.x;
    const landed = ballisticAt(from, v, t);

    expect(landed.y).toBeCloseTo(target.y, 8);
    expect(landed.z).toBeCloseTo(target.z, 8);
  });
});

describe("stepBall", () => {
  it("follows the closed-form trajectory while nothing is in the way", () => {
    const from = new Vector3(-3, 2.5, 0);
    const v = new Vector3(2, 1, 0.5);
    const s: BallState = { pos: from.clone(), vel: v.clone() };

    const events = simulate(s, 0.5);
    const expected = ballisticAt(from, v, 0.5);

    expect(events).toHaveLength(0);
    // The 1/240 s integrator drifts slightly from the analytic path.
    expect(s.pos.x).toBeCloseTo(expected.x, 3);
    expect(s.pos.y).toBeCloseTo(expected.y, 1);
    expect(s.pos.z).toBeCloseTo(expected.z, 3);
  });

  it("bounces off the table top and attributes the side by x sign", () => {
    const drop: BallState = { pos: new Vector3(-0.9, 2.2, 0.2), vel: Vector3.Zero() };
    const playerEvents = simulate(drop, 1.5).filter((e) => e.type === "table");
    expect(playerEvents.length).toBeGreaterThan(0);
    expect(playerEvents[0]).toMatchObject({ type: "table", side: "player" });

    const mirrored: BallState = { pos: new Vector3(0.9, 2.2, 0.2), vel: Vector3.Zero() };
    const aiEvents = simulate(mirrored, 1.5).filter((e) => e.type === "table");
    expect(aiEvents[0]).toMatchObject({ type: "table", side: "ai" });
  });

  it("bounces below the drop height and off the curved surface", () => {
    const dropY = 2.2;
    const s: BallState = { pos: new Vector3(-0.9, dropY, 0), vel: Vector3.Zero() };

    const first = simulate(s, 1.5).find((e) => e.type === "table");

    expect(first).toBeDefined();
    if (first?.type !== "table") throw new Error("expected a table event");
    // Contact happens a ball radius above the curved surface at that x.
    expect(first.pos.y).toBeCloseTo(tableSurfaceY(-0.9) + BALL_RADIUS, 2);
    // Restitution is below 1, so it never comes back to the drop height.
    expect(first.pos.y).toBeLessThan(dropY);
  });

  it("deflects the curved table bounce outward, away from the net", () => {
    // The table is a dome (y = hCenter - k x^2), so a vertical drop off-centre
    // must be pushed toward the near end, not back over the net.
    const s: BallState = { pos: new Vector3(-1.2, 2.2, 0), vel: Vector3.Zero() };

    simulate(s, 1.5);

    expect(s.vel.x).toBeLessThan(0);
  });

  it("rebounds off the net instead of passing through it", () => {
    const s: BallState = { pos: new Vector3(-0.4, GROUND_Y + 0.5, 0), vel: new Vector3(6, 0, 0) };

    const events = simulate(s, 0.4);

    expect(events.some((e) => e.type === "net")).toBe(true);
    expect(s.pos.x).toBeLessThan(0); // stayed on the side it came from
    expect(s.vel.x).toBeLessThan(0); // and is heading back
  });

  it("lets a ball above the tape cross the net untouched", () => {
    const tapeTop = GROUND_Y + TABLE.netTop;
    const s: BallState = { pos: new Vector3(-0.4, tapeTop + 0.6, 0), vel: new Vector3(6, 0.5, 0) };

    const events = simulate(s, 0.2);

    expect(events.some((e) => e.type === "net")).toBe(false);
    expect(s.pos.x).toBeGreaterThan(0);
  });

  it("lets a ball wide of the net posts through", () => {
    const outsideZ = TABLE.netHalfWidth + 0.3;
    const s: BallState = { pos: new Vector3(-0.4, GROUND_Y + 0.5, outsideZ), vel: new Vector3(6, 0, 0) };

    const events = simulate(s, 0.3);

    expect(events.some((e) => e.type === "net")).toBe(false);
    expect(s.pos.x).toBeGreaterThan(0);
  });

  it("bounces on the ground beyond the table and finally settles", () => {
    const s: BallState = { pos: new Vector3(-4, 2, 0), vel: Vector3.Zero() };

    const events = simulate(s, 12);

    expect(events.some((e) => e.type === "ground")).toBe(true);
    // Damped bounces stop emitting events and the ball comes to rest.
    expect(s.pos.y).toBeCloseTo(GROUND_Y + BALL_RADIUS, 5);
    expect(s.vel.length()).toBeCloseTo(0, 6);
  });

  it("never lets the ball sink through the floor", () => {
    const s: BallState = { pos: new Vector3(-4, 1.5, 0), vel: new Vector3(3, -8, 1) };
    let lowest = Infinity;

    for (let i = 0; i < 600; i++) {
      stepBall(s, 1 / 120);
      lowest = Math.min(lowest, s.pos.y);
    }

    expect(lowest).toBeGreaterThanOrEqual(GROUND_Y);
  });

  it("clamps free flight to the maximum ball speed", () => {
    const s: BallState = { pos: new Vector3(-5, 4, 0), vel: new Vector3(400, 0, 0) };

    stepBall(s, 1 / 60);

    expect(s.vel.length()).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
  });

  it("deflects off a character capsule and reports the side", () => {
    const collider: BodyCollider = {
      side: "ai",
      base: new Vector3(2.5, GROUND_Y, 0),
      height: 1.8,
      radius: 0.3,
    };
    const s: BallState = { pos: new Vector3(1.2, GROUND_Y + 1.0, 0), vel: new Vector3(8, 0, 0) };

    const events = simulate(s, 0.5, 1 / 120, [collider]);

    expect(events.some((e) => e.type === "body" && e.side === "ai")).toBe(true);
    expect(s.vel.x).toBeLessThan(0); // pushed back out, never through
    const dx = s.pos.x - collider.base.x;
    const dz = s.pos.z - collider.base.z;
    expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThanOrEqual(collider.radius);
  });

  it("ignores a capsule the ball is already moving away from", () => {
    const collider: BodyCollider = {
      side: "player",
      base: new Vector3(-2.5, GROUND_Y, 0),
      height: 1.8,
      radius: 0.3,
    };
    // Starts outside the capsule and separating.
    const s: BallState = { pos: new Vector3(-3.6, GROUND_Y + 1.0, 0), vel: new Vector3(-6, 0, 0) };

    const events = simulate(s, 0.3, 1 / 120, [collider]);

    expect(events.some((e) => e.type === "body")).toBe(false);
  });
});

describe("sampleFlight", () => {
  it("samples at a fixed 1/120 s cadence up to maxT", () => {
    const state: BallState = { pos: new Vector3(-3, 2, 0), vel: new Vector3(4, 3, 0) };

    const samples = sampleFlight(state, 1);

    expect(samples.length).toBe(120);
    expect(samples[0].t).toBeCloseTo(1 / 120, 10);
    expect(samples[samples.length - 1].t).toBeCloseTo(1, 6);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].t).toBeGreaterThan(samples[i - 1].t);
    }
  });

  it("does not mutate the state it was given", () => {
    const state: BallState = { pos: new Vector3(-3, 2, 0), vel: new Vector3(4, 3, 0) };

    sampleFlight(state, 1);

    expect(state.pos.asArray()).toEqual([-3, 2, 0]);
    expect(state.vel.asArray()).toEqual([4, 3, 0]);
  });

  it("flags every sample from the ground bounce onward", () => {
    const state: BallState = { pos: new Vector3(-4, 1.2, 0), vel: new Vector3(1, 0, 0) };

    const samples = sampleFlight(state, 2.5);
    const firstGrounded = samples.findIndex((s) => s.grounded);

    expect(firstGrounded).toBeGreaterThan(0);
    // `grounded` latches: it never flips back to false.
    expect(samples.slice(firstGrounded).every((s) => s.grounded)).toBe(true);
    expect(samples.slice(0, firstGrounded).every((s) => !s.grounded)).toBe(true);
  });

  it("never flags a rally ball that stays in the air", () => {
    const from = new Vector3(-2.6, 1.3, 0);
    const target = new Vector3(1.0, GROUND_Y + TABLE.hCenter, 0);
    const state: BallState = { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };

    const samples = sampleFlight(state, 0.5);

    expect(samples.some((s) => s.grounded)).toBe(false);
  });
});

describe("predict", () => {
  it("reports the first table bounce with its side and time", () => {
    const state: BallState = { pos: new Vector3(-0.9, 2.2, 0.2), vel: Vector3.Zero() };

    const p = predict(state);

    expect(p.tableBounce).not.toBeNull();
    expect(p.tableBounce?.side).toBe("player");
    expect(p.tableBounce?.t).toBeGreaterThan(0);
    // Free fall from 2.2 m onto a surface ~1.06 m up takes roughly 0.45 s.
    expect(p.tableBounce?.t).toBeCloseTo(0.45, 1);
  });

  it("only records the first bounce, not later ones", () => {
    const state: BallState = { pos: new Vector3(-0.9, 2.2, 0), vel: Vector3.Zero() };

    const p = predict(state, 3);
    const firstT = p.tableBounce?.t ?? 0;

    // Every post-bounce sample is later than the recorded bounce.
    expect(p.samples.length).toBeGreaterThan(0);
    expect(p.samples[0].t).toBeGreaterThan(firstT);
  });

  it("returns no bounce for a ball that misses the table entirely", () => {
    const state: BallState = { pos: new Vector3(-5, 1.2, 3), vel: Vector3.Zero() };

    const p = predict(state);

    expect(p.tableBounce).toBeNull();
    expect(p.samples).toHaveLength(0);
  });

  it("does not mutate the state it was given", () => {
    const state: BallState = { pos: new Vector3(-0.9, 2.2, 0), vel: Vector3.Zero() };

    predict(state);

    expect(state.pos.asArray()).toEqual([-0.9, 2.2, 0]);
    expect(state.vel.asArray()).toEqual([0, 0, 0]);
  });

  it("caps the sample buffer", () => {
    const state: BallState = { pos: new Vector3(-0.9, 2.2, 0), vel: Vector3.Zero() };

    const p = predict(state, 10);

    expect(p.samples.length).toBeLessThanOrEqual(360);
  });
});

describe("clearing the net from low down", () => {
  it("lifts a ball struck below the tape over it", () => {
    // A wide serve is struck off the foot from under a metre, so it has to
    // climb most of the net's height on the way over. The solver's step budget
    // was sized for a rally kick met near chest height, ran out, and returned a
    // velocity that clipped the tape — which meant every serve aimed to the
    // side hit the net.
    const from = new Vector3(-3.93, GROUND_Y + 0.56, 0);
    const target = new Vector3(0.85, tableSurfaceY(0.85), 0.5);

    const v = solveLaunchClearingNet(from, target, 0.12, 0.18);

    expect(heightAtNet(from, v) - BALL_RADIUS).toBeGreaterThan(GROUND_Y + TABLE.netTop);
  });

  it("still leaves a launch that already clears exactly alone", () => {
    // The extra budget must only ever reach shots that were failing; anything
    // that clears returns on its own iteration and never sees it.
    const from = new Vector3(-2, GROUND_Y + 1.8, 0);
    const target = new Vector3(1.2, tableSurfaceY(1.2), 0);

    const v = solveLaunchClearingNet(from, target, 0.35, 0.05);

    expect(v).toEqual(solveLaunch(from, target, 0.35));
  });
});

describe("capLaunchApex", () => {
  const apexOf = (from: Vector3, v: Vector3): number =>
    from.y + (v.y * v.y) / (2 * GRAVITY);
  // The cap the match applies: twice the shortest character's height.
  const cap = GROUND_Y + 2 * 1.72;

  it("leaves a launch that fits under the cap alone", () => {
    const from = new Vector3(-2, GROUND_Y + 1, 0);
    const v = solveLaunch(from, new Vector3(1, GROUND_Y, 0), 0.8);

    expect(capLaunchApex(from, v, cap)).toBe(v);
  });

  it("never raises a ball that is not climbing", () => {
    const from = new Vector3(-2, GROUND_Y + 2, 0);
    const v = new Vector3(4, -2, 0.5);

    expect(capLaunchApex(from, v, GROUND_Y + 1)).toBe(v);
  });

  it("clamps the apex to the ceiling and keeps the horizontal pace", () => {
    const from = new Vector3(-2, GROUND_Y + 1, 0);
    const v = new Vector3(3, 9, 0.5);

    const capped = capLaunchApex(from, v, cap);

    expect(apexOf(from, capped)).toBeLessThanOrEqual(cap + 1e-9);
    expect(capped.x).toBe(v.x);
    expect(capped.z).toBe(v.z);
    expect(capped.y).toBeLessThan(v.y);
  });

  it("keeps ordinary rally launches under the cap and over the net", () => {
    // Sweep the launches a rally actually produces: the three power tiers, the
    // neutral and fullest arcs, and strikers from deep to at the table. The
    // cap must never bind these into the net — an ordinary shot stays an
    // ordinary shot.
    for (const power of [0.34, 0.62, 0.95]) {
      for (const loft of [1, 2.0]) {
        for (const x of [-3.2, -1.9, 1.9, 3.2]) {
          const from = new Vector3(x, GROUND_Y + 1.0, 0);
          const tx = -Math.sign(x) * 1.4;
          const target = new Vector3(tx, tableSurfaceY(tx), 0.2);
          const dist = Vector3.Distance(from, target);
          const flight = ((0.5 + dist * 0.055) * loft) / (0.9 * BALL_PACE * (0.72 + 0.5 * power));
          const solved = solveLaunchClearingNet(from, target, flight, 0.14);
          const v = capLaunchApex(from, solved, cap);

          expect(apexOf(from, v), `power ${power} loft ${loft} x ${x}`).toBeLessThanOrEqual(
            cap + 1e-9
          );
          // Neutral arcs never bind, so they keep their net clearance.
          if (loft === 1) {
            expect(heightAtNet(from, v) - BALL_RADIUS).toBeGreaterThan(GROUND_Y + TABLE.netTop);
          }
        }
      }
    }
  });
});


