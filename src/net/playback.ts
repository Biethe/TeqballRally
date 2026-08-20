/**
 * The guest's single playback timeline.
 *
 * An online guest renders nothing directly from arriving snapshots. Every
 * arriving frame joins this buffer, and everything on screen — the ball and
 * both characters — is read off one clock that runs a fixed interval behind
 * the newest frame. Showing all three at the same instant is what keeps them
 * agreeing with each other; a ball drawn half a trip in the past under a
 * player drawn now is exactly the glitch this replaces.
 *
 * Between reported frames the ball is carried forward with the same pure
 * `stepBall` both peers share, and characters are linearly interpolated, with
 * velocity derived from the position delta so a locomotion blend reading
 * velocity describes the motion actually on screen.
 *
 * Pure like `sync` and `reconcile`: plain records in, plain records out, no
 * scene in the room, so the timing behaviour is testable exactly.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { stepBall, type BallState } from "../ball";
import { SIM_DT } from "../config";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface PlaybackSample {
  tick: number;
  ball: Vec3;
  ballVel: Vec3;
  ballHeld: boolean;
  self: Vec2;
  opponent: Vec2;
  /** Wire velocities: only used to warm up before a second sample exists. */
  selfVel?: Vec2;
  opponentVel?: Vec2;
}

export interface CharView {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface PlaybackView {
  renderTick: number;
  ball: Vec3;
  ballVel: Vec3;
  ballHeld: boolean;
  self: CharView;
  opponent: CharView;
  mode: "buffered" | "extrapolated" | "frozen";
}

/** How far behind the newest frame the timeline is shown, in ticks (100 ms). */
export const PLAYBACK_DELAY_TICKS = 6;
/** Buffer depth. Delay plus jitter margin; arrivals land every two ticks. */
export const PLAYBACK_MAX_ENTRIES = 8;
/** Steps without an arrival before the feed counts as starving. */
export const PLAYBACK_STALE_STEPS = 18;
/** Extrapolation budget once starving, in ticks, before the view freezes. */
export const PLAYBACK_MAX_EXTRAPOLATE_TICKS = 30;
/** Furthest forward a free ball is re-simulated between bracketing samples. */
const MAX_BALL_STEPS = 12;

/** A clip's fraction of its window at `tick`, clamped to [0, 1]. */
export function clipFractionAt(from: number, to: number, tick: number): number {
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0) return tick >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (tick - from) / span));
}

const lerp2 = (a: Vec2, b: Vec2, f: number): Vec2 => ({
  x: a.x + (b.x - a.x) * f,
  z: a.z + (b.z - a.z) * f,
});

const lerp3 = (a: Vec3, b: Vec3, f: number): Vec3 => ({
  x: a.x + (b.x - a.x) * f,
  y: a.y + (b.y - a.y) * f,
  z: a.z + (b.z - a.z) * f,
});

export class PlaybackBuffer {
  private entries: PlaybackSample[] = [];
  private newestTick = -1;
  private localStep = 0;
  private lastArrivalStep = -1;
  private engaged = false;
  /** Starvation followed engagement; arms the re-engage signal. */
  private recovering = false;
  /** Buffered entries predate a starvation; the next push discards them. */
  private staleEntries = false;
  private pendingReengage = false;
  private extrapSteps = 0;
  private lastView: PlaybackView | null = null;

  /** Feed one authoritative frame. Out-of-order frames are dropped. */
  push(s: PlaybackSample): void {
    if (this.entries.length > 0 && s.tick <= this.newestTick) return;
    // A gap large enough to starve the feed broke continuity: the old entries
    // describe a moment that is over, and interpolating across the gap would
    // replay it. Start the timeline fresh once; the match blends the screen
    // onto it when the re-engage signal fires.
    if (this.staleEntries) {
      this.entries = [];
      this.staleEntries = false;
    }
    this.entries.push(s);
    if (this.entries.length > PLAYBACK_MAX_ENTRIES) this.entries.shift();
    this.newestTick = s.tick;
    this.lastArrivalStep = this.localStep;
    if (this.entries.length >= 2) {
      if (!this.engaged && this.recovering && this.lastView) this.pendingReengage = true;
      this.engaged = true;
      this.extrapSteps = 0;
    }
  }

  /** Advance one local 60 Hz step and read the timeline. Null before any sample. */
  advance(): PlaybackView | null {
    this.localStep += 1;
    if (this.entries.length === 0) return null;

    const stepsSince = this.localStep - this.lastArrivalStep;
    if (this.engaged && stepsSince > PLAYBACK_STALE_STEPS) {
      this.engaged = false;
      this.recovering = true;
      this.staleEntries = this.entries.length > 0;
      this.extrapSteps = 0;
    }

    const view = this.engaged
      ? this.bufferedView(stepsSince)
      : this.extrapolatedView(stepsSince);
    if (view) this.lastView = view;
    return view ?? this.lastView;
  }

  /** Whether fresh data just ended a starvation. Fires once per recovery. */
  consumeReengaged(): boolean {
    if (this.pendingReengage && this.engaged) {
      this.pendingReengage = false;
      this.recovering = false;
      return true;
    }
    return false;
  }

  reset(): void {
    this.entries = [];
    this.newestTick = -1;
    this.localStep = 0;
    this.lastArrivalStep = -1;
    this.engaged = false;
    this.recovering = false;
    this.staleEntries = false;
    this.pendingReengage = false;
    this.extrapSteps = 0;
    this.lastView = null;
  }

  private bufferedView(stepsSince: number): PlaybackView {
    // The instant being shown. Clamped to the oldest buffered state: after a
    // gap the newest tick jumped far ahead, and chasing it would sprint the
    // screen through frames instead of gliding it onto the fresh timeline.
    const raw = this.newestTick - PLAYBACK_DELAY_TICKS + stepsSince;
    const renderTick = Math.max(raw, this.entries[0].tick);

    let a = this.entries[0];
    let b: PlaybackSample | null = null;
    for (const e of this.entries) {
      if (e.tick <= renderTick) a = e;
      else {
        b = e;
        break;
      }
    }

    // Characters: linear between the bracketing frames, velocity taken from
    // the position delta so the blend describes the visible motion. Past the
    // newest frame (a tick or two of arrival jitter) carry on along the last
    // derived velocity; with one frame only, fall back to the wire velocity.
    const charView = (key: "self" | "opponent"): CharView => {
      if (b) {
        const span = b.tick - a.tick;
        const f = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 0;
        const pos = lerp2(a[key], b[key], f);
        const dt = span * SIM_DT;
        return {
          x: pos.x,
          z: pos.z,
          vx: (b[key].x - a[key].x) / dt,
          vz: (b[key].z - a[key].z) / dt,
        };
      }
      const prev = this.entries[this.entries.indexOf(a) - 1];
      if (prev) {
        const span = a.tick - prev.tick;
        const dt = span * SIM_DT;
        const vx = (a[key].x - prev[key].x) / dt;
        const vz = (a[key].z - prev[key].z) / dt;
        const ahead = Math.max(0, renderTick - a.tick);
        return {
          x: a[key].x + vx * ahead * SIM_DT,
          z: a[key].z + vz * ahead * SIM_DT,
          vx,
          vz,
        };
      }
      const wire = key === "self" ? a.selfVel : a.opponentVel;
      const vx = wire?.x ?? 0;
      const vz = wire?.z ?? 0;
      const ahead = Math.max(0, renderTick - a.tick);
      return {
        x: a[key].x + vx * ahead * SIM_DT,
        z: a[key].z + vz * ahead * SIM_DT,
        vx,
        vz,
      };
    };

    // Ball: a held ball rides the hand — lerp, no physics. Free flight is the
    // shared pure physics stepped forward from the bracketing state: the
    // host's own trajectory, save the limb steering only the host applies.
    let ball: Vec3;
    let ballVel: Vec3;
    const held = a.ballHeld;
    if (held) {
      const span = b && b.tick > a.tick ? b.tick - a.tick : 1;
      const f = Math.max(0, Math.min(1, (renderTick - a.tick) / span));
      ball = b ? lerp3(a.ball, b.ball, f) : { ...a.ball };
      ballVel = { x: 0, y: 0, z: 0 };
    } else {
      const state: BallState = {
        pos: new Vector3(a.ball.x, a.ball.y, a.ball.z),
        vel: new Vector3(a.ballVel.x, a.ballVel.y, a.ballVel.z),
      };
      const steps = Math.min(Math.max(0, renderTick - a.tick), MAX_BALL_STEPS);
      for (let i = 0; i < steps; i++) stepBall(state, SIM_DT);
      ball = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
      ballVel = { x: state.vel.x, y: state.vel.y, z: state.vel.z };
    }

    return {
      renderTick,
      ball,
      ballVel,
      ballHeld: held,
      self: charView("self"),
      opponent: charView("opponent"),
      mode: "buffered",
    };
  }

  /**
   * No live timeline this step — warming up before a second frame, or the
   * feed starved. Carry the last view forward: the ball along the same pure
   * physics, characters along their velocity. After the extrapolation budget
   * the view freezes rather than wandering ever further from the truth.
   */
  private extrapolatedView(stepsSince: number): PlaybackView | null {
    if (!this.lastView) {
      // Cold start with a single frame: place everything on it, wire
      // velocities carrying the characters if the render point is ahead.
      const a = this.entries[0];
      const ahead = Math.max(0, stepsSince - PLAYBACK_DELAY_TICKS);
      const wire = (v?: Vec2) => ({ x: v?.x ?? 0, z: v?.z ?? 0 });
      const sv = wire(a.selfVel);
      const ov = wire(a.opponentVel);
      return {
        renderTick: a.tick,
        ball: { ...a.ball },
        ballVel: { ...a.ballVel },
        ballHeld: a.ballHeld,
        self: {
          x: a.self.x + sv.x * ahead * SIM_DT,
          z: a.self.z + sv.z * ahead * SIM_DT,
          vx: sv.x,
          vz: sv.z,
        },
        opponent: {
          x: a.opponent.x + ov.x * ahead * SIM_DT,
          z: a.opponent.z + ov.z * ahead * SIM_DT,
          vx: ov.x,
          vz: ov.z,
        },
        mode: "extrapolated",
      };
    }
    if (this.extrapSteps >= PLAYBACK_MAX_EXTRAPOLATE_TICKS) {
      return { ...this.lastView, mode: "frozen" };
    }
    this.extrapSteps += 1;
    const last = this.lastView;
    let ball = last.ball;
    let ballVel = last.ballVel;
    if (!last.ballHeld) {
      const state: BallState = {
        pos: new Vector3(last.ball.x, last.ball.y, last.ball.z),
        vel: new Vector3(last.ballVel.x, last.ballVel.y, last.ballVel.z),
      };
      stepBall(state, SIM_DT);
      ball = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
      ballVel = { x: state.vel.x, y: state.vel.y, z: state.vel.z };
    }
    const carry = (c: CharView): CharView => ({
      x: c.x + c.vx * SIM_DT,
      z: c.z + c.vz * SIM_DT,
      vx: c.vx,
      vz: c.vz,
    });
    return {
      renderTick: last.renderTick + 1,
      ball,
      ballVel,
      ballHeld: last.ballHeld,
      self: carry(last.self),
      opponent: carry(last.opponent),
      mode: "extrapolated",
    };
  }
}
