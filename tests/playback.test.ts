import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { stepBall, type BallState, type BodyCollider } from "../src/ball";
import { CLIPS, contactFraction, GROUND_Y, SIM_DT } from "../src/config";
import { MAX_CATCHUP_TICKS } from "../src/net/protocol";
import {
  BALL_SNAP,
  clipFractionAt,
  clipWindowSpeed,
  MAX_CHAR_CARRY_METRES,
  PLAYBACK_DEFAULT_LEAD_TICKS,
  PLAYBACK_MAX_EXTRAPOLATE_TICKS,
  PLAYBACK_STALE_STEPS,
  PlaybackBuffer,
  type PlaybackSample,
} from "../src/net/playback";

/**
 * The guest shows everything from one clock, led forward to the instant the
 * host is playing. These pin that contract down: same-instant rendering, the
 * shared physics carrying the ball across the lead, eased corrections when a
 * frame contradicts the screen, starvation behaviour, and recovery.
 */

const WALK = 1.5; // m/s, a character's constant pace along x

/**
 * How long a flight will wait at a contact it cannot resolve.
 *
 * The guest can see a touch coming — the clip window says when the foot gets
 * there — but not what it does to the ball, so the flight is held at the
 * contact rather than sailing through the foot and being dragged back.
 *
 * The wait had no bound. It lasted until the next snapshot, and on the
 * delivery a phone actually gets that is sometimes a fifth of a second: long
 * enough that the ball does not read as being held carefully, it reads as the
 * game having frozen. Held briefly, then flying on, is the trade — being a
 * little past the foot is what the easing is for and is barely visible.
 */
describe("waiting at a contact", () => {
  /**
   * A frame whose clip contacts the ball just ahead of it.
   *
   * The pin engages while the contact sits between the newest frame and the
   * instant being drawn — so on a slow link, where the render point leads by a
   * lot, it engages on every frame and stays engaged.
   */
  const withContact = (tick: number, aheadTicks: number): PlaybackSample => {
    const clip = "ChestKick";
    const frac = contactFraction(clip);
    const span = 60;
    return {
      ...sample(tick),
      // Solve the window so the contact lands `aheadTicks` after this frame.
      selfClip: { clip, from: tick + aheadTicks - frac * span, to: tick + aheadTicks + (1 - frac) * span, seq: 1 },
    };
  };

  it("holds the flight at the touch, then lets it go on", () => {
    // A slow link: the screen is drawn twenty ticks ahead of the newest frame,
    // and every frame reports a contact five ticks after itself. The contact
    // is therefore always behind the render point and always ahead of the
    // frame, which is the pin's engaged condition, on every single frame.
    const buf = new PlaybackBuffer();
    buf.setLead(20);
    let tick = 100;
    buf.push(withContact(tick, 5));

    let held = 0;
    let longest = 0;
    let prev = buf.advance()!.ball;
    for (let i = 0; i < 40; i++) {
      // Frames keep arriving, so this is never starvation — it is the pin.
      if (i % 2 === 0) {
        tick += 2;
        buf.push(withContact(tick, 5));
      }
      const view = buf.advance();
      if (!view) break;
      const moved = Math.hypot(view.ball.x - prev.x, view.ball.y - prev.y, view.ball.z - prev.z);
      if (moved < 1e-6) {
        held += 1;
        longest = Math.max(longest, held);
      } else {
        held = 0;
      }
      prev = view.ball;
    }

    // Unbounded this never lets go at all: the ball hangs for the whole run,
    // and on a phone for as long as the link stays slow.
    expect(longest).toBeLessThan(12);
  });
});

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

  it("shows the render point ahead of the newest frame, by the lead", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6); // newest tick 110, clock 3 steps past the arrival
    const v = buf.advance();
    expect(v).not.toBeNull();
    expect(v!.renderTick).toBe(110 + PLAYBACK_DEFAULT_LEAD_TICKS + 2);
    expect(v!.mode).toBe("buffered");
  });

  it("reads further ahead as the measured round trip grows", () => {
    const buf = new PlaybackBuffer();
    buf.setLead(9);
    feedEngaged(buf, 100, 6);
    expect(buf.advance()!.renderTick).toBe(110 + 9 + 2);
  });

  // The render point leads the newest frame, so a character is always drawn
  // ahead of the last one that reported them. At a constant walk the carry
  // lands exactly where the walk would have.
  it("carries characters to the instant it is reading", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    let v = buf.advance()!;
    while (v.renderTick % 2 !== 1) v = buf.advance()!;
    const t = v.renderTick;
    expect(v.self.x).toBeCloseTo(t * WALK * SIM_DT, 10);
    expect(v.self.z).toBeCloseTo(0.5, 10);
    expect(v.opponent.x).toBeCloseTo(-(t * WALK * SIM_DT), 10);
  });

  it("carries characters on the reported velocity, not a difference of positions", () => {
    const buf = new PlaybackBuffer();
    feedEngaged(buf, 100, 6);
    const v = buf.advance()!;
    expect(v.self.vx).toBeCloseTo(WALK, 6);
    expect(v.self.vz).toBeCloseTo(0, 6);
    expect(v.opponent.vx).toBeCloseTo(-WALK, 6);
  });

  /**
   * The bug this replaced. A run to a drop spot ends with `moveToward` zeroing
   * the velocity in one step; a backward difference of two 30 Hz positions
   * still reads the old pace for two more ticks, and the lead multiplies it.
   * The joined player sailed past every reception and was yanked back.
   */
  it("stops a character dead when the host says their velocity is zero", () => {
    const buf = new PlaybackBuffer();
    buf.setLead(8);
    const STOP_X = 2;
    // Walking, then arrived: the positions still differ across the last pair,
    // but the reported velocity is already zero.
    for (let i = 0; i < 4; i++) {
      const s = sample(100 + i * 2);
      s.self = { x: i < 3 ? STOP_X - (3 - i) * WALK * 2 * SIM_DT : STOP_X, z: 0.5 };
      s.selfVel = i < 3 ? { x: WALK, z: 0 } : { x: 0, z: 0 };
      buf.push(s);
      buf.advance();
      buf.advance();
    }
    const v = buf.advance()!;
    expect(v.self.vx).toBe(0);
    expect(v.self.x).toBeCloseTo(STOP_X, 10);
  });

  it("caps how far a character is carried past the frame that reported them", () => {
    const buf = new PlaybackBuffer();
    buf.setLead(MAX_CATCHUP_TICKS);
    const s = sample(100);
    s.self = { x: 0, z: 0 };
    s.selfVel = { x: 20, z: 0 }; // 20 m/s over half a second is 10 m of guess
    buf.push(s);
    buf.push({ ...sample(102), self: { x: 0, z: 0 }, selfVel: { x: 20, z: 0 } });
    const v = buf.advance()!;
    expect(v.self.x).toBeLessThanOrEqual(MAX_CHAR_CARRY_METRES + 1e-9);
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

  /**
   * The lead is pure physics, which is exact until somebody touches the ball.
   * The touch is the one thing in that window the guest cannot compute — but
   * the clip window says when it lands, so the ball waits at the foot instead
   * of sailing through the player and being dragged backwards when the truth
   * arrives.
   */
  it("stops the ball at a contact it can see coming", () => {
    const buf = new PlaybackBuffer();
    buf.setLead(10);
    // A ChestKick whose contact frame falls on tick 112, played at the rate
    // the host uses for a strike.
    const span = CLIPS.ChestKick.frames / 1.3;
    const from = 112 - contactFraction("ChestKick") * span;
    const win = { clip: "ChestKick", from, to: from + span };
    for (const t of [100, 102]) {
      buf.push({ ...sample(t), opponentClip: win });
      buf.advance();
      buf.advance();
    }
    buf.push({ ...sample(104), opponentClip: win });
    // Render points 114, 115, 116 — all past the contact at 112.
    const at114 = buf.advance()!;
    expect(at114.renderTick).toBeGreaterThan(112);
    const held = { ...at114.ball };
    for (let i = 0; i < 3; i++) {
      const v = buf.advance()!;
      expect(v.renderTick).toBeGreaterThan(at114.renderTick);
      expect(v.ball.x).toBeCloseTo(held.x, 10);
      expect(v.ball.y).toBeCloseTo(held.y, 10);
    }
    // And it is the ball as it was at the contact, not wherever the clock is.
    const truth = truthBall(112 - 104);
    expect(held.x).toBeCloseTo(truth.pos.x, 6);
    expect(held.y).toBeCloseTo(truth.pos.y, 6);
  });

  it("flies on normally when the clip playing has no contact frame", () => {
    const buf = new PlaybackBuffer();
    buf.setLead(10);
    // Celebration1 has contact -1: nothing to wait for.
    const win = { clip: "Celebration1", from: 100, to: 200 };
    for (const t of [100, 102, 104]) {
      buf.push({ ...sample(t), opponentClip: win });
      buf.advance();
      buf.advance();
    }
    const a = buf.advance()!;
    const b = buf.advance()!;
    expect(b.ball.x).not.toBeCloseTo(a.ball.x, 6);
  });

  /**
   * The host deflects a ball that meets a character standing in its way. An
   * extrapolation run without those bodies carried it straight on — through
   * the player, and then back again when the truth arrived.
   */
  it("bounces the ball off a body the host would have deflected it off", () => {
    const flat = (tick: number): PlaybackSample => ({
      ...sample(tick),
      ball: { x: 0, y: 1, z: 0 },
      ballVel: { x: 6, y: 0, z: 0 },
    });
    const run = (colliders?: BodyCollider[]) => {
      const buf = new PlaybackBuffer();
      buf.setLead(12);
      for (const t of [100, 102]) {
        buf.push(flat(t));
        buf.advance(colliders);
        buf.advance(colliders);
      }
      buf.push(flat(104));
      return buf.advance(colliders)!.ball.x;
    };

    // Standing in the ball's path, a metre down the court.
    const body: BodyCollider = {
      side: "ai",
      base: new Vector3(1, GROUND_Y, 0),
      height: 1.8,
      radius: 0.27,
    };
    expect(run()).toBeGreaterThan(0.9);
    expect(run([body])).toBeLessThan(run());
  });

  it("eases a frame that contradicts the flight already on screen", () => {
    // Reading at the host's instant means a kick is news the guest does not
    // have until the frame carrying it lands. Taking that whole is the pop
    // this replaces; the ball turns onto the new flight at once and the
    // leftover distance melts away.
    const buf = new PlaybackBuffer();
    for (let i = 0; i < 4; i++) {
      buf.push(sample(100 + i * 2));
      buf.advance();
      buf.advance();
    }
    const before = buf.advance()!;
    // The host struck it: same place, opposite direction.
    const struck = sample(108);
    struck.ballVel = { x: -6, y: 4, z: 0 };
    buf.push(struck);
    const after = buf.advance()!;

    const jump = Math.hypot(after.ball.x - before.ball.x, after.ball.y - before.ball.y);
    expect(jump).toBeLessThan(0.2);
    // The velocity is the truth immediately, so a landing marker predicts the
    // real flight even while the position is still catching up.
    expect(after.ballVel.x).toBeLessThan(0);

    // And it converges: within a third of a second the offset is spent.
    let v = after;
    for (let i = 0; i < 20; i++) v = buf.advance()!;
    const truth: BallState = {
      pos: new Vector3(struck.ball.x, struck.ball.y, struck.ball.z),
      vel: new Vector3(struck.ballVel.x, struck.ballVel.y, struck.ballVel.z),
    };
    for (let i = 0; i < v.renderTick - struck.tick; i++) stepBall(truth, SIM_DT);
    expect(Math.hypot(v.ball.x - truth.pos.x, v.ball.y - truth.pos.y)).toBeLessThan(0.02);
  });

  it("takes a frame too far away to be a correction outright", () => {
    const buf = new PlaybackBuffer();
    for (let i = 0; i < 4; i++) {
      buf.push(sample(100 + i * 2));
      buf.advance();
      buf.advance();
    }
    buf.advance();
    // A new point, a serve, a reconnect: not a path that was ever going to
    // reach this one, and easing across it draws a curve nobody played.
    const elsewhere = sample(108);
    elsewhere.ball = { x: -2 + BALL_SNAP * 2, y: 1.2, z: 0 };
    buf.push(elsewhere);
    const v = buf.advance()!;
    const truth: BallState = {
      pos: new Vector3(elsewhere.ball.x, elsewhere.ball.y, elsewhere.ball.z),
      vel: new Vector3(elsewhere.ballVel.x, elsewhere.ballVel.y, elsewhere.ballVel.z),
    };
    for (let i = 0; i < v.renderTick - elsewhere.tick; i++) stepBall(truth, SIM_DT);
    expect(v.ball.x).toBeCloseTo(truth.pos.x, 6);
    expect(v.ball.y).toBeCloseTo(truth.pos.y, 6);
  });

  it("never leads further than the protocol's catch-up cap", () => {
    const buf = new PlaybackBuffer();
    buf.setLead(10_000);
    feedEngaged(buf, 100, 6);
    expect(buf.advance()!.renderTick).toBeLessThanOrEqual(110 + MAX_CATCHUP_TICKS + 2);
    // Nonsense is ignored rather than taken.
    buf.setLead(Number.NaN);
    expect(Number.isFinite(buf.advance()!.renderTick)).toBe(true);
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

  /**
   * The host raises the rate on a touch and encodes it by shortening the
   * window. A guest that played the clip at 1.0 regardless reached the contact
   * frame an eighth of a second after the ball had already left, and then had
   * the clip cut off three quarters of the way through.
   */
  it("reads back the rate the host played a clip at", () => {
    const frames = CLIPS.ChestKick.frames;
    expect(clipWindowSpeed("ChestKick", 0, frames / 1.3)).toBeCloseTo(1.3, 10);
    expect(clipWindowSpeed("ChestKick", 40, 40 + frames)).toBeCloseTo(1, 10);
  });

  it("falls back to the authored rate for an unknown clip or an open window", () => {
    expect(clipWindowSpeed("NotAClip", 0, 50)).toBe(1);
    expect(clipWindowSpeed("ChestKick", Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(1);
    expect(clipWindowSpeed("ChestKick", 100, 100)).toBe(1);
  });

  /**
   * A window stays open until the clip would have finished, but the host stops
   * a clip the moment the touch is over. Searching the buffer for any window
   * containing the render point let an older frame's open window beat the
   * newest frame's "nothing at all" — a guest still playing a touch the host
   * had finished with, and a rally clip arriving at the next serve.
   */
  it("stops reporting a clip the moment the host does, window still open or not", () => {
    const buf = new PlaybackBuffer();
    const win = { clip: "ChestKick", from: 100, to: 400, seq: 3 };
    for (const t of [100, 102]) {
      buf.push({ ...sample(t), selfClip: win });
      buf.advance();
      buf.advance();
    }
    expect(buf.advance()!.selfClip?.clip).toBe("ChestKick");
    // The touch is over. The window would not have closed for another five
    // seconds, and the older frames still carry it.
    buf.push({ ...sample(104), selfClip: null });
    expect(buf.advance()!.selfClip).toBeNull();
  });

  it("carries clip windows on the playback buffer timeline", () => {
    const buf = new PlaybackBuffer();
    const s1 = sample(100);
    s1.selfClip = { clip: "RightFootKick", from: 98, to: 108 };
    s1.opponentClip = { clip: "LeftHeadKick", from: 100, to: 110 };
    const s2 = sample(102);
    s2.selfClip = { clip: "RightFootKick", from: 98, to: 108 };
    s2.opponentClip = { clip: "LeftHeadKick", from: 100, to: 110 };

    buf.push(s1);
    buf.push(s2);
    buf.advance();
    const view = buf.advance();
    expect(view).not.toBeNull();
    expect(view!.selfClip?.clip).toBe("RightFootKick");
    expect(view!.opponentClip?.clip).toBe("LeftHeadKick");
  });
});
