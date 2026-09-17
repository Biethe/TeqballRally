import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { stepBall, type BallState } from "../src/ball";
import { SIM_DT } from "../src/config";
import {
  GUEST_BALL_DIVERGENCE,
  GUEST_BALL_FADE_SECONDS,
  GUEST_BALL_LATE_KICK_TICKS,
  GuestBall,
  type LaunchEvent,
  type Vec3,
} from "../src/net/guestball";

/**
 * The guest flies its own ball from the host's decisions. These pin the
 * contract the host relies on: a decision takes effect at the start of its
 * tick, exactly as the host's `update` applies a launch before it steps the
 * ball, and between decisions the flight is `stepBall` and nothing else.
 */

const serve: LaunchEvent = { tick: 100, pos: { x: -3, y: 1.5, z: 0 }, vel: { x: 7, y: 3, z: 0.4 }, spin: 1 };
const kick: LaunchEvent = { tick: 130, pos: { x: 1, y: 1.2, z: 0.3 }, vel: { x: -8, y: 4, z: -1 }, spin: 0.9, kick: true };

/** The host's ball: the decision set at the start of its tick, then stepped. */
function host(decisions: LaunchEvent[], until: number): Map<number, Vec3> {
  const out = new Map<number, Vec3>();
  const s: BallState = { pos: new Vector3(), vel: new Vector3() };
  const first = Math.min(...decisions.map((d) => d.tick));
  for (let t = first; t <= until; t++) {
    const d = decisions.find((x) => x.tick === t);
    if (d) {
      s.pos.set(d.pos.x, d.pos.y, d.pos.z);
      s.vel.set(d.vel.x, d.vel.y, d.vel.z);
    }
    stepBall(s, SIM_DT);
    out.set(t, { x: s.pos.x, y: s.pos.y, z: s.pos.z });
  }
  return out;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe("the guest's own ball", () => {
  it("flies a decision exactly as the host does, tick for tick", () => {
    const b = new GuestBall();
    b.queue(serve);
    const truth = host([serve], 160);
    for (let t = 100; t <= 160; t++) {
      const v = b.advance(t)!;
      expect(dist(v.pos, truth.get(t)!)).toBeLessThan(1e-9);
    }
  });

  it("turns on a decision's own tick when it arrived in time", () => {
    // The whole point of sending a kick at commit: it is here before its tick,
    // and the flight turns on that tick with nothing to correct.
    const b = new GuestBall();
    b.queue(serve);
    b.advance(110);
    b.queue(kick);
    const truth = host([serve, kick], 160);
    for (let t = 111; t <= 160; t++) {
      expect(dist(b.advance(t)!.pos, truth.get(t)!)).toBeLessThan(1e-9);
    }
    expect(b.replays).toBe(0);
  });

  it("replays a late decision from its tick and fades the difference instead of jumping", () => {
    const b = new GuestBall();
    b.queue(serve);
    const before = b.advance(136)!.pos;
    b.queue(kick); // six ticks after it happened
    expect(b.replays).toBe(1);
    const after = b.advance(137)!.pos;
    // The screen moves on from where it was by about one step of flight, not
    // by the gap between the old path and the new one.
    expect(dist(after, before)).toBeLessThan(0.3);

    // The truth underneath is exact at once, and the drawn ball reaches it as
    // the offset fades — a step at a time, as the game calls it.
    const truth = host([serve, kick], 200);
    const fadeTicks = Math.ceil((GUEST_BALL_FADE_SECONDS / SIM_DT) * 5);
    let settled = after;
    for (let t = 138; t <= 137 + fadeTicks; t++) settled = b.advance(t)!.pos;
    expect(dist(settled, truth.get(137 + fadeTicks)!)).toBeLessThan(0.01);
  });

  it("draws between whole ticks, so a leaning clock does not make it hitch", () => {
    const b = new GuestBall();
    b.queue(serve);
    const truth = host([serve], 140);
    const mid = b.advance(120.5)!.pos;
    const a = truth.get(120)!;
    const c = truth.get(121)!;
    expect(mid.x).toBeCloseTo((a.x + c.x) / 2, 9);
    expect(mid.y).toBeCloseTo((a.y + c.y) / 2, 9);
  });

  it("re-anchors on a snapshot only when a decision was genuinely missed", () => {
    const truth = host([serve, kick], 200);
    const snapshotAt = (t: number) => {
      const p = truth.get(t)!;
      // The velocity is not compared, only carried; any plausible one will do.
      return { pos: p, vel: { x: -8, y: 0, z: -1 } };
    };

    // Agreeing snapshots change nothing.
    const agree = new GuestBall();
    agree.queue(serve);
    agree.queue(kick);
    for (let t = 100; t <= 150; t++) {
      if (t % 2 === 0) agree.check(t, snapshotAt(t).pos, snapshotAt(t).vel);
      agree.advance(t);
    }
    expect(agree.reanchors).toBe(0);

    // The kick never arrived: the first snapshot past it disagrees by far more
    // than float drift, and the flight takes the snapshot as a decision.
    const missed = new GuestBall();
    missed.queue(serve);
    for (let t = 100; t <= 150; t++) {
      if (t % 2 === 0) missed.check(t, snapshotAt(t).pos, snapshotAt(t).vel);
      missed.advance(t);
    }
    expect(missed.reanchors).toBeGreaterThan(0);
    expect(GUEST_BALL_DIVERGENCE).toBeGreaterThan(0.01);
  });

  it("ends a flight when the ball is back in a hand, and drops a kick that never came", () => {
    const b = new GuestBall();
    b.queue(serve);
    b.advance(120);
    b.hold();
    expect(b.active).toBe(false);

    // A kick published ahead whose point ended before its contact: the next
    // snapshot shows the ball in a hand, and the kick must not fly later.
    const abandoned = new GuestBall();
    abandoned.queue(serve);
    abandoned.queue({ ...kick, tick: 160 });
    abandoned.advance(140);
    abandoned.hold();
    expect(abandoned.active).toBe(false);
    expect(abandoned.advance(170)).toBeNull();
  });

  it("hears each kick once, on time, and never on a replay", () => {
    const b = new GuestBall();
    b.queue(serve);
    b.queue(kick);
    let heard = 0;
    for (let t = 100; t <= 140; t++) heard += b.advance(t)!.kicks;
    expect(heard).toBe(1);

    // A decision landing before the kick replays across it; the kick is not
    // heard a second time.
    b.queue({ ...serve, tick: 120, vel: { x: 7, y: 2.9, z: 0.4 } });
    for (let t = 141; t <= 150; t++) heard += b.advance(t)!.kicks;
    expect(heard).toBe(1);
  });

  it("drops a kick that arrives too late to belong to anything on screen", () => {
    const b = new GuestBall();
    b.queue(serve);
    b.advance(130 + GUEST_BALL_LATE_KICK_TICKS + 10);
    b.queue(kick);
    expect(b.advance(130 + GUEST_BALL_LATE_KICK_TICKS + 11)!.kicks).toBe(0);
  });

  it("leaves a hand from the hand, however late the toss arrived", () => {
    const hand = { x: -3, y: 1.4, z: 0 };
    const b = new GuestBall();
    b.queue(serve, undefined, hand);
    // Five ticks late: the flight underneath is already five ticks up, but the
    // first frame drawn is still where the ball was on screen.
    const first = b.advance(105)!.pos;
    expect(dist(first, hand)).toBeLessThan(1e-9);
    const end = 105 + Math.ceil((GUEST_BALL_FADE_SECONDS / SIM_DT) * 5);
    let later = first;
    for (let t = 106; t <= end; t++) later = b.advance(t)!.pos;
    const truth = host([serve], 140);
    expect(dist(later, truth.get(end)!)).toBeLessThan(0.01);
  });

  it("draws nothing before any decision, and starts clean after a reset", () => {
    const b = new GuestBall();
    expect(b.advance(10)).toBeNull();
    b.queue(serve);
    b.advance(120);
    b.reset();
    expect(b.active).toBe(false);
    expect(b.advance(121)).toBeNull();
  });
});
