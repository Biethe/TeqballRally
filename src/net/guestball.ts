/**
 * The guest's own ball.
 *
 * The guest used to be *shown* the ball: every snapshot re-placed it, and
 * between snapshots it was carried forward from the newest one and eased onto
 * whatever the next one said. That is thirty re-placements a second of a
 * thing whose whole flight both peers can compute exactly, and every one of
 * them was an opportunity for the drawn ball to jump, stall at a contact it
 * could not resolve yet, or ease along a path that was neither the old flight
 * nor the new one. On a phone it read as a ball with unsteady physics.
 *
 * A ball is only ever changed by a handful of decisions — a limb meets it, a
 * body deflects it, a server tosses it — and between those it is nothing but
 * `stepBall`, which both peers run. So the guest runs the flight itself, and
 * the host sends the decisions: the state the ball takes and the host tick it
 * takes it on (`LaunchEvent`). A kick is decided before the limb arrives — the
 * wind-up is longer than the trip between phones — so the decision is usually
 * here before its tick, and the guest's flight turns at the same tick as the
 * host's. One that arrives after its tick is applied where it belonged and the
 * flight re-run from there; the difference to what was drawn fades out rather
 * than jumping.
 *
 * Snapshots still carry the ball, and are used for the one thing a stream of
 * decisions cannot promise: that nothing was missed. A snapshot that disagrees
 * with this flight at its own tick re-anchors the flight on it.
 *
 * Pure like the rest of `src/net/`: records in, records out, no scene.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { stepBall, type BallState, type BodyCollider } from "../ball";
import { SIM_DT } from "../config";
import { MAX_CATCHUP_TICKS } from "./protocol";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The ball takes this state at the *start* of host tick `tick` — before that
 * tick's physics step — exactly as the host's `update` applies a launch before
 * it steps the ball. A snapshot's ball is the state at the *end* of its tick,
 * which is the same as the start of the next one.
 */
export interface LaunchEvent {
  tick: number;
  pos: Vec3;
  vel: Vec3;
  spin: number;
  /** A limb struck it, so there is a kick to hear. */
  kick?: boolean;
  /**
   * This state is where the ball *ended* the tick before, not only where the
   * next one starts: something moved it during that tick (a body in the way).
   * Applied at the end of that tick too, so a frame drawn between the two
   * ticks is not drawn from a flight that was never there.
   */
  settled?: boolean;
}

export interface GuestBallView {
  pos: Vec3;
  vel: Vec3;
  spin: number;
  /** Kicks whose tick this advance crossed, to be heard once each. */
  kicks: number;
}

/** How far back a late decision can be replayed from, in ticks. */
export const GUEST_BALL_HISTORY_TICKS = 90;
/**
 * A snapshot this far from the flight at its own tick means a decision was
 * missed. Well clear of anything float drift over one flight could produce,
 * which is micrometres, and well inside the size of any real change of path.
 */
export const GUEST_BALL_DIVERGENCE = 0.2;
/** Seconds over which a late decision's difference to the drawn ball fades. */
export const GUEST_BALL_FADE_SECONDS = 0.1;
/** A difference too large to fade — a new point, a reconnect — is taken outright. */
export const GUEST_BALL_SNAP = 3.0;
/**
 * A kick heard this many ticks after it happened is a sound out of its moment.
 * A little over the one-way delay a playable link has; later than that it is
 * dropped rather than played against a ball that has already gone.
 */
export const GUEST_BALL_LATE_KICK_TICKS = 12;

const copy = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class GuestBall {
  /** Every decision still inside the replay reach, by the tick it takes effect. */
  private launches = new Map<number, LaunchEvent>();
  /** The end-of-tick state of each recent tick. */
  private history = new Map<number, { pos: Vec3; vel: Vec3; spin: number }>();
  /** The newest tick simulated; its end state is `state`. Null before any decision. */
  private tick: number | null = null;
  private state: BallState = { pos: new Vector3(), vel: new Vector3() };
  private spin = 1;
  /** Drawn minus true, fading. What keeps a late decision from being a jump. */
  private offset: Vec3 = { x: 0, y: 0, z: 0 };
  /** Kick ticks already heard, so a replay never plays one twice. */
  private heard = new Set<number>();
  private pendingKicks = 0;
  /** The instant last drawn, so a kick is judged late against the screen. */
  private drawnAt = Number.NEGATIVE_INFINITY;
  /**
   * Where the ball was on screen when a flight began after its own tick — the
   * hand, for a toss that arrived a trip late. The first draw fades from it.
   */
  private fadeFrom: Vec3 | null = null;
  /** Snapshots waiting for the flight to reach their tick before comparing. */
  private checks: { tick: number; pos: Vec3; vel: Vec3 }[] = [];
  /** Times a snapshot disagreed and the flight was re-anchored. Diagnostics. */
  reanchors = 0;
  /** Decisions that arrived after their tick and were replayed. Diagnostics. */
  replays = 0;

  /** Whether there is a flight to draw at all. */
  get active(): boolean {
    return this.tick !== null;
  }

  reset(): void {
    this.launches.clear();
    this.history.clear();
    this.tick = null;
    this.offset = { x: 0, y: 0, z: 0 };
    this.heard.clear();
    this.pendingKicks = 0;
    this.drawnAt = Number.NEGATIVE_INFINITY;
    this.fadeFrom = null;
    this.checks = [];
  }

  /**
   * The ball is in a hand as of a snapshot. Whatever flight was running is
   * over, and any decision still waiting is stale: on an ordered socket a toss
   * is sent after the last snapshot that shows the ball held, so nothing that
   * arrived before this one can be the next flight. A kick published ahead
   * whose point ended first is exactly such a leftover.
   */
  hold(): void {
    this.reset();
  }

  /**
   * A decision arrived. `colliders` for a replay, if it lands in the past.
   * `drawn` is where the ball is on screen now, when a flight starting here
   * should leave from there rather than appear where it already is.
   */
  queue(l: LaunchEvent, colliders?: BodyCollider[], drawn?: Vec3): void {
    if (!Number.isFinite(l.tick)) return;
    // The later word on a tick wins: the host decides a touch at commit, and
    // decides it again at contact if something knocked the ball off the path
    // the first decision was made for.
    this.launches.set(l.tick, { ...l, pos: copy(l.pos), vel: copy(l.vel) });
    if (this.tick === null) {
      // First decision of a flight. Stand the timeline just before it; the
      // launch itself replaces the state when its tick is stepped.
      this.tick = l.tick - 1;
      this.setState(l.pos, l.vel);
      this.spin = l.spin;
      this.history.set(this.tick, { pos: copy(l.pos), vel: copy(l.vel), spin: l.spin });
      this.fadeFrom = drawn ? copy(drawn) : null;
      return;
    }
    if (l.tick <= this.tick) {
      this.replays += 1;
      this.replayFrom(l.tick, colliders);
    }
  }

  /**
   * A snapshot's ball, the end state of its tick. Compared once the flight has
   * got that far; a disagreement means a decision never arrived, and the
   * snapshot becomes one.
   */
  check(tick: number, pos: Vec3, vel: Vec3): void {
    if (this.tick === null || !Number.isFinite(tick)) return;
    this.checks.push({ tick, pos: copy(pos), vel: copy(vel) });
    if (this.checks.length > 16) this.checks.shift();
  }

  /**
   * Run the flight to host instant `at` (fractional) and read it.
   *
   * Each whole tick is one `stepBall`, applying the decision due on it first —
   * the host's order. The drawn position is interpolated between the two
   * whole ticks around `at`, because the clock that asks leans a few per cent
   * fast or slow and a ball stepped only on whole ticks would hitch whenever
   * it did.
   */
  advance(at: number, colliders?: BodyCollider[]): GuestBallView | null {
    if (this.tick === null || !Number.isFinite(at)) return null;
    const base = Math.floor(at);
    const want = base + 1;
    if (want < this.tick) {
      // The clock stepped back past the flight — only a snap does that. Stand
      // on the history if it reaches; the flight forward is the same flight.
      const h = this.history.get(want);
      if (h) {
        this.tick = want;
        this.setState(h.pos, h.vel);
        this.spin = h.spin;
      }
    }
    if (want - this.tick > GUEST_BALL_HISTORY_TICKS) {
      // A gap longer than any replay: nothing on screen to keep continuous.
      this.tick = want - GUEST_BALL_HISTORY_TICKS;
    }
    while (this.tick < want) this.stepOne(colliders, at);
    this.runChecks(colliders);

    const b = this.state;
    const a = this.history.get(base);
    const f = at - base;
    const keep = Math.max(0, 1 - SIM_DT / GUEST_BALL_FADE_SECONDS);
    this.offset = { x: this.offset.x * keep, y: this.offset.y * keep, z: this.offset.z * keep };
    const lerp = (p: number, q: number) => p + (q - p) * f;
    const pos = a
      ? { x: lerp(a.pos.x, b.pos.x), y: lerp(a.pos.y, b.pos.y), z: lerp(a.pos.z, b.pos.z) }
      : { x: b.pos.x, y: b.pos.y, z: b.pos.z };
    if (this.fadeFrom) {
      const o = { x: this.fadeFrom.x - pos.x, y: this.fadeFrom.y - pos.y, z: this.fadeFrom.z - pos.z };
      if (Math.hypot(o.x, o.y, o.z) <= GUEST_BALL_SNAP) this.offset = o;
      this.fadeFrom = null;
    }
    const kicks = this.pendingKicks;
    this.pendingKicks = 0;
    this.drawnAt = at;
    return {
      pos: { x: pos.x + this.offset.x, y: pos.y + this.offset.y, z: pos.z + this.offset.z },
      vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z },
      spin: this.spin,
      kicks,
    };
  }

  private setState(pos: Vec3, vel: Vec3): void {
    this.state.pos.set(pos.x, pos.y, pos.z);
    this.state.vel.set(vel.x, vel.y, vel.z);
  }

  private stepOne(colliders: BodyCollider[] | undefined, drawnAt: number): void {
    const t = (this.tick as number) + 1;
    const l = this.launches.get(t);
    if (l) {
      this.setState(l.pos, l.vel);
      this.spin = l.spin;
      if (l.kick && !this.heard.has(t)) {
        this.heard.add(t);
        if (drawnAt - t <= GUEST_BALL_LATE_KICK_TICKS) this.pendingKicks += 1;
      }
    }
    stepBall(this.state, SIM_DT, undefined, colliders);
    const settled = this.launches.get(t + 1);
    if (settled?.settled) this.setState(settled.pos, settled.vel);
    this.tick = t;
    this.history.set(t, {
      pos: { x: this.state.pos.x, y: this.state.pos.y, z: this.state.pos.z },
      vel: { x: this.state.vel.x, y: this.state.vel.y, z: this.state.vel.z },
      spin: this.spin,
    });
    const old = t - GUEST_BALL_HISTORY_TICKS;
    this.history.delete(old);
    this.launches.delete(old - 1);
    for (const h of this.heard) if (h < old) this.heard.delete(h);
  }

  /**
   * A decision landed on a tick already simulated. Re-run the flight from it,
   * and carry the difference at the newest tick into the fading offset so the
   * ball on screen does not jump to the corrected path.
   */
  private replayFrom(from: number, colliders?: BodyCollider[]): void {
    const now = this.tick as number;
    const before = { x: this.state.pos.x, y: this.state.pos.y, z: this.state.pos.z };
    const start = this.history.get(from - 1);
    if (start) {
      this.setState(start.pos, start.vel);
      this.spin = start.spin;
    }
    // Without a start the decision itself is the start: it replaces the state
    // on its own tick, so whatever stands before it is never read.
    this.tick = from - 1;
    const steps = Math.min(now - this.tick, MAX_CATCHUP_TICKS * 3);
    for (let i = 0; i < steps; i++) this.stepOne(colliders, this.drawnAt);
    this.tick = Math.max(this.tick, now);
    const moved = {
      x: before.x - this.state.pos.x,
      y: before.y - this.state.pos.y,
      z: before.z - this.state.pos.z,
    };
    const o = { x: this.offset.x + moved.x, y: this.offset.y + moved.y, z: this.offset.z + moved.z };
    this.offset = Math.hypot(o.x, o.y, o.z) > GUEST_BALL_SNAP ? { x: 0, y: 0, z: 0 } : o;
  }

  private runChecks(colliders?: BodyCollider[]): void {
    if (this.checks.length === 0 || this.tick === null) return;
    const waiting: typeof this.checks = [];
    for (const c of this.checks) {
      if (c.tick > this.tick) {
        waiting.push(c);
        continue;
      }
      const h = this.history.get(c.tick);
      if (!h) continue;
      if (dist(h.pos, c.pos) > GUEST_BALL_DIVERGENCE) {
        this.reanchors += 1;
        this.queue({ tick: c.tick + 1, pos: c.pos, vel: c.vel, spin: this.spin }, colliders);
      }
    }
    this.checks = waiting;
  }
}
