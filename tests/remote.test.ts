import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SIM_DT, GROUND_Y, TABLE } from "../src/config";
import { solveLaunchClearingNet, stepBall, type BallState } from "../src/ball";
import { makeStrike } from "../src/net/protocol";
import {
  CONVERGE_TIME,
  MAX_CORRECTION_SPEED,
  RemotePlayer,
  SNAP_DISTANCE,
  type RemoteAvatar,
} from "../src/net/remote";

function avatar(x = 0, z = 0, busy = false): RemoteAvatar {
  return { position: new Vector3(x, GROUND_Y, z), velocity: new Vector3(0, 0, 0), busy };
}

const move = (x: number, z: number, tick = 0) => ({
  t: "move" as const,
  tick,
  pos: { x, y: GROUND_Y, z },
  yaw: 0,
  moveX: 0,
  moveZ: 0,
});

/** Run `seconds` of simulation steps. */
function run(p: RemotePlayer, a: RemoteAvatar, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) p.update(SIM_DT, a);
}

describe("pose smoothing", () => {
  it("does nothing before the first message", () => {
    const p = new RemotePlayer();
    const a = avatar(1, 1);

    run(p, a, 0.5);

    expect(p.hasPose()).toBe(false);
    expect(a.position.x).toBe(1);
    expect(a.position.z).toBe(1);
  });

  it("closes a normal gap without teleporting", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(1, 0));

    // One step must not cover the whole distance.
    p.update(SIM_DT, a);
    expect(a.position.x).toBeGreaterThan(0);
    expect(a.position.x).toBeLessThan(1);

    // Most of the gap is gone within a couple of time constants...
    run(p, a, CONVERGE_TIME * 2);
    expect(a.position.x).toBeGreaterThan(0.8);

    // ...and it arrives exactly, rather than approaching forever.
    run(p, a, 1);
    expect(a.position.x).toBe(1);
    expect(a.velocity.length()).toBe(0);
  });

  it("never overshoots the target", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(0.5, 0));

    for (let i = 0; i < 200; i++) {
      p.update(SIM_DT, a);
      expect(a.position.x).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("caps correction speed so it cannot outrun a sprint", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    // Just inside the snap threshold: the largest gap that is still run to.
    p.onMove(move(SNAP_DISTANCE - 0.01, 0));

    p.update(SIM_DT, a);

    expect(a.velocity.length()).toBeLessThanOrEqual(MAX_CORRECTION_SPEED + 1e-9);
    expect(a.position.x).toBeLessThanOrEqual(MAX_CORRECTION_SPEED * SIM_DT + 1e-9);
  });

  it("snaps rather than sprinting when the peer jumps a long way", () => {
    // A reconnect, or a stall long enough that running there would look absurd.
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(SNAP_DISTANCE + 2, 1));

    p.update(SIM_DT, a);

    expect(a.position.x).toBe(SNAP_DISTANCE + 2);
    expect(a.position.z).toBe(1);
    expect(a.velocity.length()).toBe(0);
  });

  it("leaves the pose alone while an action clip is playing", () => {
    // A strike animation lunges the character onto the ball; correcting
    // underneath it would drag the contact off the limb.
    const p = new RemotePlayer();
    const a = avatar(0, 0, true);
    p.onMove(move(2, 2));

    run(p, a, 0.5);

    expect(a.position.x).toBe(0);
    expect(a.position.z).toBe(0);
    expect(a.velocity.length()).toBe(0);
  });

  it("drives velocity so the opponent jogs instead of sliding", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(0, 1.5));

    p.update(SIM_DT, a);

    // The locomotion blend reads velocity; a lateral gap must read as lateral.
    expect(a.velocity.z).toBeGreaterThan(0);
    expect(Math.abs(a.velocity.x)).toBeLessThan(1e-9);
  });

  it("settles to rest once it has arrived", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(0.4, 0));
    run(p, a, 1);

    // Exactly on target with no residual velocity: the blend can reach idle.
    expect(a.position.x).toBe(0.4);
    expect(a.velocity.length()).toBe(0);
  });

  it("arrives from any starting gap inside the snap threshold", () => {
    for (const gap of [0.02, 0.2, 1.0, SNAP_DISTANCE - 0.01]) {
      const p = new RemotePlayer();
      const a = avatar(0, 0);
      p.onMove(move(gap, 0));
      run(p, a, 3);
      expect(a.position.x, `gap ${gap}`).toBe(gap);
      expect(a.velocity.length(), `gap ${gap}`).toBe(0);
    }
  });

  it("follows the newest pose when several arrive", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(1, 0));
    p.onMove(move(-1, 0)); // the peer changed direction before we stepped

    p.update(SIM_DT, a);

    expect(a.position.x).toBeLessThan(0);
  });
});

describe("staleness", () => {
  it("reports how long the peer has been quiet", () => {
    const p = new RemotePlayer();
    const a = avatar(0, 0);
    p.onMove(move(0, 0));

    run(p, a, 0.5);
    expect(p.silentFor()).toBeCloseTo(0.5, 2);

    p.onMove(move(0, 0));
    expect(p.silentFor()).toBe(0);
  });

  it("counts silence even before any pose has arrived", () => {
    const p = new RemotePlayer();
    run(p, avatar(), 0.25);
    expect(p.silentFor()).toBeCloseTo(0.25, 2);
  });
});

describe("applying a remote launch", () => {
  it("reproduces the striker's trajectory on the ball", () => {
    const from = new Vector3(2.6, 1.3, 0.2);
    const target = new Vector3(-1.1, GROUND_Y + TABLE.hCenter, -0.3);
    const striker: BallState = { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };
    const msg = makeStrike(0, striker, "LeftFootKick", 1.1);

    const TOTAL = 45;
    for (let i = 0; i < TOTAL; i++) stepBall(striker, SIM_DT);

    const p = new RemotePlayer();
    const mine: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
    p.onStrike(msg, mine, 6); // arrived 6 ticks late
    for (let i = 0; i < TOTAL - 6; i++) stepBall(mine, SIM_DT);

    expect(mine.pos.x).toBeCloseTo(striker.pos.x, 9);
    expect(mine.pos.y).toBeCloseTo(striker.pos.y, 9);
    expect(mine.pos.z).toBeCloseTo(striker.pos.z, 9);
  });

  it("counts as contact, clearing the silence timer", () => {
    const p = new RemotePlayer();
    const a = avatar();
    run(p, a, 0.3);
    expect(p.silentFor()).toBeGreaterThan(0);

    const ball: BallState = { pos: new Vector3(0, 1, 0), vel: new Vector3(0, 0, 0) };
    p.onStrike(makeStrike(0, ball, "ChestKick"), ball, 0);

    expect(p.silentFor()).toBe(0);
  });
});
