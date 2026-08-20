import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { stepBall, type BallState } from "../src/ball";
import { SIM_DT } from "../src/config";
import {
  clipFractionAt,
  PLAYBACK_DELAY_TICKS,
  PLAYBACK_MAX_EXTRAPOLATE_TICKS,
  PLAYBACK_STALE_STEPS,
  PlaybackBuffer,
  type PlaybackSample,
} from "../src/net/playback";

/**
 * The guest shows everything from one clock, a fixed interval behind the
 * newest frame. These pin that contract down: same-instant rendering, the
 * shared physics between frames, starvation behaviour, and recovery.
 */

const WALK = 1.5; // m/s, a character's constant pace along x

function sample(tick: number, held = false): PlaybackSample {
  return {
    tick,
    // A free ballistic ball starting at a fixed state at tick 100.
    ball: { x: -2, y: 1.2, z: 0 },
    ballVel: { x: 3, y: 2, z: 0 },
    ballHeld: held,
    self: { x: tick * WALK * SIM_DT, z: 0.5 },
    opponent: { x: -(tick * WALK * SIM_DT), z: -0.5 },
    selfVel: { x: WALK, z: 0 },
    opponentVel: { x: -WALK, z: 0 },
  };
}

/** Feed samples every 2 ticks (30 Hz) while stepping the clock at 60 Hz. */
function feedEngaged(buf: PlaybackBuffer, from: number, pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    buf.push(sample(from + i * 2));
    buf.advance();
    buf.advance();
  }
}

/** The ball's true state `steps` ticks after the tick-100 launch state. */
function truthBall(steps: number): BallState {
  const s: BallState = {
    pos: new Vector3(-2, 1.2, 0),
    vel: new Vector3(3, 2, 0),
  };
  for (let i = 0; i < steps; i++) stepBall(s, SIM_DT);
  return s;
}

describe("the guest playback timeline", () => {
  it("has nothing to show before any frame arrives", () => {
    const buf = new PlaybackBuffer();
    expect(buf.advance()).toBeNull();
    expect(buf.advance()).toBeNull();
  });

  it("shows the render point a fixed delay behind the newest frame", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6); // newest tick 110, clock 3 steps past the arrival
    const v = buf.advance();
    expect(v).not.toBeNull();
    expect(v!.renderTick).toBe(110 - PLAYBACK_DELAY_TICKS + 3);
    expect(v!.mode).toBe("buffered");
  });

  it("interpolates characters linearly between reported frames", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    // Advance until the render point sits exactly between two samples.
    let v = buf.advance()!;
    while (v.renderTick % 2 !== 1) v = buf.advance()!;
    const t = v.renderTick;
    expect(v.self.x).toBeCloseTo(t * WALK * SIM_DT, 10);
    expect(v.self.z).toBeCloseTo(0.5, 10);
    expect(v.opponent.x).toBeCloseTo(-(t * WALK * SIM_DT), 10);
  });

  it("derives character velocity from the position delta, not the wire", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    const v = buf.advance()!;
    expect(v.self.vx).toBeCloseTo(WALK, 6);
    expect(v.self.vz).toBeCloseTo(0, 6);
    expect(v.opponent.vx).toBeCloseTo(-WALK, 6);
  });

  it("carries a free ball along the shared physics between frames", () => {
    const buf = new PlaybackBuffer();
    // Every sample reports the launch state keyed to tick 100, so the buffer
    // re-simulates from the bracketing frame; compare against a truth run.
    const feed = (tick: number) => {
      const s = sample(tick);
      const ahead = truthBall(tick - 100);
      s.ball = { x: ahead.pos.x, y: ahead.pos.y, z: ahead.pos.z };
      s.ballVel = { x: ahead.vel.x, y: ahead.vel.y, z: ahead.vel.z };
      buf.push(s);
    };
    for (let i = 0; i < 6; i++) {
      feed(100 + i * 2);
      buf.advance();
      buf.advance();
    }
    const v = buf.advance()!;
    const truth = truthBall(v.renderTick - 100);
    expect(v.ball.x).toBeCloseTo(truth.pos.x, 6);
    expect(v.ball.y).toBeCloseTo(truth.pos.y, 6);
    expect(v.ballVel.x).toBeCloseTo(truth.vel.x, 6);
  });

  it("rides a held ball along the hand with no physics", () => {
    const buf = new PlaybackBuffer();
    buf.push({ ...sample(100, true), ball: { x: -1, y: 1, z: 0 } });
    buf.push({ ...sample(102, true), ball: { x: -1.2, y: 1.1, z: 0.1 } });
    for (let i = 0; i < 3; i++) buf.advance();
    const v = buf.advance()!;
    expect(v.ballHeld).toBe(true);
    expect(v.ballVel.x).toBe(0);
    expect(v.ball.x).toBeGreaterThanOrEqual(-1.2);
    expect(v.ball.x).toBeLessThanOrEqual(-1);
  });

  it("drops out-of-order frames", () => {
    const buf = new PlaybackBuffer();
    buf.push(sample(100));
    buf.push(sample(99));
    buf.advance();
    // One usable frame only: not enough for a buffered timeline.
    expect(buf.advance()!.mode).toBe("extrapolated");
  });

  it("extrapolates while starving, then freezes", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    // Starve the feed: keep stepping with no arrivals.
    let v = buf.advance()!;
    let extrap = 0;
    while (v.mode === "buffered") {
      v = buf.advance()!;
    }
    while (v.mode === "extrapolated") {
      extrap++;
      expect(Number.isFinite(v.self.x)).toBe(true);
      v = buf.advance()!;
      if (extrap > PLAYBACK_MAX_EXTRAPOLATE_TICKS + PLAYBACK_STALE_STEPS + 5) {
        throw new Error("never froze");
      }
    }
    expect(v.mode).toBe("frozen");
    // Frozen holds exactly: stepping again changes nothing.
    const frozen = buf.advance()!;
    expect(frozen.ball).toEqual(v.ball);
    expect(frozen.self).toEqual(v.self);
  });

  it("keeps characters moving during starvation along their velocity", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    let v = buf.advance()!;
    while (v.mode === "buffered") v = buf.advance()!;
    const x0 = v.self.x;
    const vx = v.self.vx;
    const v2 = buf.advance()!;
    expect(v2.self.x).toBeCloseTo(x0 + vx * SIM_DT, 10);
  });

  it("re-engages on fresh data after starvation, without replaying the gap", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    let v = buf.advance()!;
    while (v.mode === "buffered") v = buf.advance()!;
    expect(buf.consumeReengaged()).toBe(false);
    // A reconnect lands far ahead in host ticks.
    buf.push(sample(700));
    buf.advance();
    buf.push(sample(702));
    buf.advance();
    expect(buf.consumeReengaged()).toBe(true);
    // The render point sits on the fresh data, not interpolated across the
    // 590-tick gap.
    const after = buf.advance()!;
    expect(after.mode).toBe("buffered");
    expect(after.renderTick).toBeGreaterThanOrEqual(700);
    // The signal fires exactly once per recovery.
    expect(buf.consumeReengaged()).toBe(false);
  });

  it("does not signal a re-engage on the initial warm-up", () => {
    const buf = new PlaybackBuffer();
    buf.push(sample(100));
    buf.push(sample(102));
    buf.advance();
    expect(buf.advance()!.mode).toBe("buffered");
    expect(buf.consumeReengaged()).toBe(false);
  });

  it("starts over on reset", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    buf.reset();
    expect(buf.advance()).toBeNull();
    buf.push(sample(500));
    buf.push(sample(502));
    buf.advance();
    expect(buf.advance()!.mode).toBe("buffered");
  });
});

describe("clip windows", () => {
  it("reads the fraction of a clip's window at a tick", () => {
    expect(clipFractionAt(100, 200, 100)).toBe(0);
    expect(clipFractionAt(100, 200, 150)).toBeCloseTo(0.5, 10);
    expect(clipFractionAt(100, 200, 200)).toBe(1);
  });

  it("clamps outside the window", () => {
    expect(clipFractionAt(100, 200, 50)).toBe(0);
    expect(clipFractionAt(100, 200, 400)).toBe(1);
  });

  it("survives a degenerate window", () => {
    expect(clipFractionAt(100, 100, 99)).toBe(0);
    expect(clipFractionAt(100, 100, 100)).toBe(1);
  });
});
