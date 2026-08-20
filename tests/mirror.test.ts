import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { GROUND_Y, SIM_DT, TABLE } from "../src/config";
import { solveLaunchClearingNet, stepBall, type BallState } from "../src/ball";
import {
  canonicalSide,
  makeStrike,
  mirror,
  reframe,
  type FxMessage,
  type MoveMessage,
  type SnapshotMessage,
} from "../src/net/protocol";

const move = (x: number, z: number): MoveMessage => ({
  t: "move",
  tick: 1,
  pos: { x, y: GROUND_Y, z },
  yaw: 0,
  moveX: 0,
  moveZ: 0,
});

describe("mirror", () => {
  it("reflects through the net, preserving height", () => {
    expect(mirror({ x: 2, y: 1.3, z: 0.5 })).toEqual({ x: -2, y: 1.3, z: -0.5 });
  });

  it("is its own inverse", () => {
    const v = { x: 1.25, y: 0.9, z: -3.5 };
    expect(mirror(mirror(v))).toEqual(v);
  });

  it("is a rotation, not a reflection — handedness is preserved", () => {
    // Negating x alone would flip the court, turning every player's left into
    // their right. A 180-degree turn about the vertical axis must not.
    const forward = { x: 1, y: 0, z: 0 };
    const left = { x: 0, y: 0, z: 1 };
    const mf = mirror(forward);
    const ml = mirror(left);
    // Cross product's y component keeps its sign under a proper rotation.
    const crossY = (a: typeof forward, b: typeof forward) => a.z * b.x - a.x * b.z;
    expect(Math.sign(crossY(mf, ml))).toBe(Math.sign(crossY(forward, left)));
  });

  it("maps each half of the table onto the other", () => {
    expect(mirror({ x: -1.4, y: 1, z: 0 }).x).toBeGreaterThan(0);
    expect(mirror({ x: 1.4, y: 1, z: 0 }).x).toBeLessThan(0);
    // A ball on the net stays on the net.
    expect(mirror({ x: 0, y: 1, z: 0 }).x).toBe(-0);
  });
});

describe("canonicalSide", () => {
  it("puts the host on the near side of the shared frame", () => {
    expect(canonicalSide("host")).toBe("player");
    expect(canonicalSide("guest")).toBe("ai");
  });
});

describe("reframe", () => {
  it("leaves the host untouched — its frame is the canonical one", () => {
    const m = move(-2.5, 1);
    expect(reframe(m, "host")).toEqual(m);
    const s = makeStrike(3, { pos: new Vector3(-2, 1, 0.5), vel: new Vector3(5, 3, -1) }, "ChestKick");
    expect(reframe(s, "host")).toEqual(s);
  });

  it("reflects the guest's geometry in both directions", () => {
    const m = move(-2.5, 1);
    const wire = reframe(m, "guest");
    expect(wire.pos).toEqual({ x: 2.5, y: GROUND_Y, z: -1 });
    // Applying it again returns the original: send and receive share a function.
    expect(reframe(wire, "guest")).toEqual(m);
  });

  it("reflects a strike's velocity as well as its position", () => {
    const s = makeStrike(0, { pos: new Vector3(-2, 1.2, 0.4), vel: new Vector3(6, 2, -1) }, "RightFootKick");
    const wire = reframe(s, "guest");

    expect(wire.pos).toEqual({ x: 2, y: 1.2, z: -0.4 });
    expect(wire.vel).toEqual({ x: -6, y: 2, z: 1 });
    // Height and vertical speed are unchanged by a turn about the vertical.
    expect(wire.pos.y).toBe(s.pos.y);
    expect(wire.vel.y).toBe(s.vel.y);
  });

  it("carries the clip and spin through untouched", () => {
    const s = makeStrike(0, { pos: new Vector3(-2, 1, 0), vel: new Vector3(1, 1, 1) }, "BackflipLeftFoot", 1.4);
    const wire = reframe(s, "guest");
    expect(wire.clip).toBe("BackflipLeftFoot");
    expect(wire.spin).toBe(1.4);
    expect(wire.tick).toBe(s.tick);
  });

  it("does not touch messages with no geometry", () => {
    const state = {
      t: "state" as const,
      tick: 5,
      scorePlayer: 3,
      scoreAi: 1,
      setsPlayer: 0,
      setsAi: 0,
      serveOwner: "player" as const,
      phase: "rally",
    };
    expect(reframe(state, "guest")).toEqual(state);

    const ping = { t: "ping" as const, sent: 1234, tick: 9 };
    expect(reframe(ping, "guest")).toEqual(ping);
  });

  it("swaps a snapshot's clip windows with the seats", () => {
    // The window belongs to its seat: sending the host's window to the guest's
    // clip would play each player's kick on the other's animation.
    const snap: SnapshotMessage = {
      t: "snap",
      tick: 3,
      ballPos: { x: 0, y: 1, z: 0 },
      ballVel: { x: 0, y: 0, z: 0 },
      ballHeld: false,
      hostPos: { x: -3, y: 0.4, z: 0 },
      guestPos: { x: 3, y: 0.4, z: 0 },
      hostVel: { x: 0, y: 0, z: 0 },
      guestVel: { x: 0, y: 0, z: 0 },
      hostClip: "ChestKick",
      guestClip: "RightKneeReception",
      hostClipFrom: 10,
      hostClipTo: 40,
      guestClipFrom: 70,
      guestClipTo: 120,
      score: [0, 0],
      sets: [0, 0],
      serveOwner: "player",
      phase: "rally",
    };
    const wire = reframe(snap, "guest");
    expect(wire.hostClip).toBe("RightKneeReception");
    expect(wire.hostClipFrom).toBe(70);
    expect(wire.hostClipTo).toBe(120);
    expect(wire.guestClip).toBe("ChestKick");
    expect(wire.guestClipFrom).toBe(10);
    expect(wire.guestClipTo).toBe(40);
  });

  it("mirrors an fx event's place but keeps its time and kind", () => {
    // The tick is host time on both ends; only the geometry reflects.
    const fx: FxMessage = { t: "fx", tick: 42, kind: "table", pos: { x: 1.2, y: 0.9, z: 0.3 } };
    const wire = reframe(fx, "guest");
    expect(wire.tick).toBe(42);
    expect(wire.kind).toBe("table");
    expect(wire.pos).toEqual({ x: -1.2, y: 0.9, z: -0.3 });

    const bare: FxMessage = { t: "fx", tick: 7, kind: "kick" };
    expect(reframe(bare, "guest")).toEqual(bare);
  });
});

describe("a guest's strike as the host sees it", () => {
  it("arrives on the host's far half, flying toward the host", () => {
    // The guest strikes from its own near side toward its opponent, exactly as
    // a host would: neither peer knows it is the mirrored one.
    const from = new Vector3(-2.6, 1.3, 0.2);
    const target = new Vector3(1.1, GROUND_Y + TABLE.hCenter, -0.3);
    const guestBall: BallState = { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };

    expect(guestBall.pos.x).toBeLessThan(0); // guest's own half
    expect(guestBall.vel.x).toBeGreaterThan(0); // heading away from the guest

    const wire = reframe(makeStrike(0, guestBall, "RightFootKick"), "guest");

    // In the host's frame the same ball is on the far half heading at the host.
    expect(wire.pos.x).toBeGreaterThan(0);
    expect(wire.vel.x).toBeLessThan(0);
  });

  it("produces mirrored but otherwise identical flights on both peers", () => {
    const from = new Vector3(-2.6, 1.3, 0.2);
    const target = new Vector3(1.1, GROUND_Y + TABLE.hCenter, -0.3);

    const guestBall: BallState = { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };
    const wire = reframe(makeStrike(0, guestBall, "RightFootKick"), "guest");

    // Host applies it in its own frame and simulates.
    const hostBall: BallState = {
      pos: new Vector3(wire.pos.x, wire.pos.y, wire.pos.z),
      vel: new Vector3(wire.vel.x, wire.vel.y, wire.vel.z),
    };

    const TOTAL = 50;
    for (let i = 0; i < TOTAL; i++) {
      stepBall(guestBall, SIM_DT);
      stepBall(hostBall, SIM_DT);
    }

    // The court is symmetric about the net, so the two simulations must stay
    // exact reflections — same height, opposite ground coordinates.
    expect(hostBall.pos.x).toBeCloseTo(-guestBall.pos.x, 9);
    expect(hostBall.pos.z).toBeCloseTo(-guestBall.pos.z, 9);
    expect(hostBall.pos.y).toBeCloseTo(guestBall.pos.y, 9);
  });
});
