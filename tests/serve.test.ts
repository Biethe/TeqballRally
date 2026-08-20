import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { heightAtNet } from "../src/ball";
import { serveTarget } from "../src/aim";
import { BALL_RADIUS, GROUND_Y, SERVE_CLEARANCE, TABLE, tableSurfaceY } from "../src/config";

/** The tape, plus the ball's own radius: under this it does not get over. */
const NET_TOP = GROUND_Y + TABLE.netTop + BALL_RADIUS;
import { KICK_INPUT } from "../src/kickinput";
import { SIM_DT } from "../src/config";
import { idle, rig, type Rig } from "./rig";

/**
 * The serve, which had no test at all.
 *
 * Its speed was a per-clip constant and its arc a single global, so there was
 * nothing to vary and — apparently — nothing to check. Making both of them
 * things a player asks for turns the serve into a shot with a range, and a
 * range is exactly the thing that needs holding: every combination has to stay
 * legal, and the one nobody asked to change has to come out unchanged.
 */

/**
 * Walk to the line, serve, and catch the ball the instant it leaves.
 *
 * Caught on the frame the rally opens, not some fixed time later: the toss is a
 * real ballistic arc and the strike lands on the clip's own contact frame, so
 * "a bit after the press" is a moving target — and a ball sampled too late has
 * already bounced, which reads as a serve that lost most of its pace.
 */
function serve(r: Rig, press: Partial<typeof idle> = {}): { pos: Vector3; vel: Vector3 } {
  r.step(3);
  r.step(0.05, { strikePressed: true, ...press });
  for (let i = 0; i < 600; i++) {
    r.step(SIM_DT);
    if (r.match.state === "rally") {
      return { pos: r.match.ball.state.pos.clone(), vel: r.match.ball.state.vel.clone() };
    }
  }
  throw new Error("the serve never left");
}

describe("a serve nobody shaped", () => {
  it("leaves exactly as it always did", () => {
    // The whole safety argument for making the serve controllable: neutral is
    // 0.5 power and 1 loft, `0.78 + 0.44 * 0.5` is exactly 1, and the clearance
    // multiplies by 1 — so the CPU's serve, and every number ever tuned behind
    // it, is untouched by any of this. If this drifts, the game's opening ball
    // changed and nobody meant it to. A centre aim drifts zero by construction,
    // so nothing needs mocking any more.
    const plain = serve(rig()).vel;
    const tiered = serve(rig(), { strikeTaps: undefined, strikeLoft: undefined }).vel;

    expect(tiered.x).toBeCloseTo(plain.x, 12);
    expect(tiered.y).toBeCloseTo(plain.y, 12);
    expect(tiered.z).toBeCloseTo(plain.z, 12);
  });
});

describe("where an aimed serve drifts", () => {
  // The serve aim is live until contact, so the direction has to be held the
  // whole way — through the walk, the toss and the strike — exactly as a
  // player holds the stick.
  const aimedServe = (r: Rig, aim: Partial<typeof idle>) => {
    for (let i = 0; i < Math.round(3 / SIM_DT); i++) r.step(SIM_DT, aim);
    r.step(SIM_DT, { strikePressed: true, ...aim });
    for (let i = 0; i < 600; i++) {
      r.step(SIM_DT, aim);
      if (r.match.state === "rally") {
        return { pos: r.match.ball.state.pos.clone(), vel: r.match.ball.state.vel.clone() };
      }
    }
    throw new Error("the serve never left");
  };

  it("lands the same aimed serve the same way, every time", () => {
    const first = aimedServe(rig(), { strikeTaps: 2, moveZ: 1 }).vel;
    const again = aimedServe(rig(), { strikeTaps: 2, moveZ: 1 }).vel;

    expect(again.asArray()).toEqual(first.asArray());
  });

  it("curls toward the sideline it was aimed at", () => {
    const c = aimedServe(rig(), { strikeTaps: 2, moveZ: 0 });
    const w = aimedServe(rig(), { strikeTaps: 2, moveZ: 1 });
    const o = aimedServe(rig(), { strikeTaps: 2, moveZ: -1 });
    const centre = landing(c.pos, c.vel);
    const wide = landing(w.pos, w.vel);
    const wideOther = landing(o.pos, o.vel);

    expect(centre).not.toBeNull();
    expect(wide).not.toBeNull();
    expect(wideOther).not.toBeNull();
    expect(wide!.z).toBeGreaterThan(centre!.z);
    expect(wideOther!.z).toBeLessThan(centre!.z);
  });

  it("drifts a centre serve not at all", () => {
    // Aim dead centre: the drift term is zero, so the landing sits on the
    // middle line (within the solver's own tolerance) — the neutral invariant.
    const s = aimedServe(rig(), { strikeTaps: 2, moveZ: 0 });
    const landed = landing(s.pos, s.vel);
    expect(landed).not.toBeNull();
    expect(Math.abs(landed!.z)).toBeLessThan(0.02);
  });
});

describe("asking a serve to go faster", () => {
  it("orders the tiers by pace", () => {
    const speeds = [1, 2, 3].map((taps) => serve(rig(), { strikeTaps: taps }).vel.length());

    expect(speeds[0]).toBeLessThan(speeds[1]);
    expect(speeds[1]).toBeLessThan(speeds[2]);
  });
});

describe("asking a serve to float", () => {
  it("sends a held serve over the net higher than a tapped one", () => {
    // Asserted where it is actually felt — the height at the tape — rather than
    // on the velocity, which trades speed for angle and can mislead.
    const flatShot = serve(rig(), { strikeTaps: 1, strikeLoft: 1 });
    const floatedShot = serve(rig(), { strikeTaps: 1, strikeLoft: KICK_INPUT.loftMax });

    expect(heightAtNet(floatedShot.pos, floatedShot.vel)).toBeGreaterThan(
      heightAtNet(flatShot.pos, flatShot.vel)
    );
  });

  it("keeps the arc inside the range it is allowed", () => {
    expect(SERVE_CLEARANCE.min).toBeLessThan(SERVE_CLEARANCE.base);
    expect(SERVE_CLEARANCE.base).toBeLessThan(SERVE_CLEARANCE.max);
  });
});

describe("every serve a player can ask for", () => {
  it("clears the net and lands on the receiver's half", () => {
    // The sweep. A serve with two new axes has a lot of corners, and the one
    // that matters is that none of them is unservable: a floated ball must not
    // hang up and drop short, and a driven one must not be solved into the tape.
    const failures: string[] = [];

    for (const taps of [1, 2, 3]) {
      for (const loft of [1, 1.4, KICK_INPUT.loftMax]) {
        for (const moveX of [-1, 0, 1]) {
          for (const moveZ of [-1, 0, 1]) {
            const { pos, vel } = serve(rig(), {
              strikeTaps: taps,
              strikeLoft: loft,
              moveX,
              moveZ,
            });
            const at = heightAtNet(pos, vel);
            const label = `taps=${taps} loft=${loft} aim=(${moveX},${moveZ})`;

            if (!(at > NET_TOP)) failures.push(`${label}: net height ${at.toFixed(3)}`);
            // Run the flight out and see where it first touches down.
            const landed = landing(pos, vel);
            if (!landed) failures.push(`${label}: never came down`);
            else if (landed.x <= 0) failures.push(`${label}: landed on own side at x=${landed.x.toFixed(2)}`);
            else if (landed.x > TABLE.halfLen + 1e-6) {
              failures.push(`${label}: landed long at x=${landed.x.toFixed(2)}`);
            } else if (Math.abs(landed.z) > TABLE.halfWid + 1e-6) {
              failures.push(`${label}: landed wide at z=${landed.z.toFixed(2)}`);
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

/** Integrate a launch until it first reaches table height on the far side. */
function landing(pos: Vector3, vel: Vector3): Vector3 | null {
  const p = pos.clone();
  const v = vel.clone();
  const h = 1 / 480;
  for (let i = 0; i < 480 * 4; i++) {
    v.y -= 9.81 * h;
    p.addInPlace(v.scale(h));
    if (p.x > 0 && p.y <= tableSurfaceY(p.x) + 0.02 && v.y < 0) return p.clone();
    if (p.y < -2) return null;
  }
  return null;
}

describe("where a serve is aimed", () => {
  it("is the same question for the ball and for the ring that previews it", () => {
    // These were worked out twice and disagreed by up to 42 cm of depth, so the
    // preview promised a corner the serve could not reach. One function now.
    for (const fwd of [-1, -0.4, 0, 0.4, 1]) {
      for (const lat of [-1, 0, 1]) {
        const spot = serveTarget(1, fwd, lat);

        expect(spot.x).toBeGreaterThanOrEqual(0.35);
        expect(spot.x).toBeLessThanOrEqual(1.4);
        expect(Math.abs(spot.z)).toBeLessThanOrEqual(0.62);
      }
    }
  });

  it("sends the ball to the side that was asked for", () => {
    expect(serveTarget(1, 0, 1).z).toBeGreaterThan(0);
    expect(serveTarget(1, 0, -1).z).toBeLessThan(0);
    expect(serveTarget(-1, 0, 0).x).toBeLessThan(0);
  });

  it("goes deeper the further forward it is aimed", () => {
    expect(serveTarget(1, 1, 0).x).toBeGreaterThan(serveTarget(1, 0, 0).x);
    expect(serveTarget(1, 0, 0).x).toBeGreaterThan(serveTarget(1, -1, 0).x);
  });
});
