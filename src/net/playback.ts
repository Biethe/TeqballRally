/**
 * The guest's single playback timeline.
 *
 * An online guest renders nothing directly from arriving snapshots. Every
 * arriving frame joins this buffer, and everything on screen — the ball and
 * both characters — is read off one clock. Showing all three at the same
 * instant is what keeps them agreeing with each other; a ball drawn half a
 * trip in the past under a player drawn now is exactly the glitch this
 * replaces.
 *
 * That clock runs at the instant the host is playing, not behind it. It used
 * to sit a fixed interval in the past, which drew a beautifully smooth ball
 * and made the game unplayable for the joined player: their own character is
 * predicted live, so the ball they were timing a touch against was somewhere
 * the host had left a sixth of a second earlier, and every press after the
 * automatic first touch arrived too late to be anything. The lead is set from
 * outside, off the measured round trip.
 *
 * The price of leading is that a frame can contradict what was on screen — the
 * host struck the ball and the guest could not have known. Between frames the
 * ball is carried forward with the same pure `stepBall` both peers share, and
 * a contradiction is eased out over a few frames rather than snapped, the same
 * way `reconcile` treats a predicted character.
 *
 * Pure like `sync` and `reconcile`: plain records in, plain records out, no
 * scene in the room, so the timing behaviour is testable exactly.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { stepBall, type BallState, type BodyCollider } from "../ball";
import { CLIPS, contactFraction, SIM_DT } from "../config";
import { MAX_CATCHUP_TICKS } from "./protocol";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface ClipSample {
  clip: string | null;
  from?: number;
  to?: number;
  /** Which playing of the clip this is; identity, now that the window moves. */
  seq?: number;
}

export interface PlaybackSample {
  tick: number;
  ball: Vec3;
  ballVel: Vec3;
  ballHeld: boolean;
  self: Vec2;
  opponent: Vec2;
  /**
   * The velocity the host reported for each character. This is what carries
   * them between frames — see `charView`; a difference of two 30 Hz positions
   * is the fallback for a peer that sends none.
   */
  selfVel?: Vec2;
  opponentVel?: Vec2;
  selfClip?: ClipSample | null;
  opponentClip?: ClipSample | null;
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
  selfClip?: ClipSample | null;
  opponentClip?: ClipSample | null;
  mode: "buffered" | "extrapolated" | "frozen";
  /** Host ticks per local step the clock is running at. */
  rate: number;
}

/**
 * Lead used until the round trip has been measured, in ticks.
 *
 * Two ticks is one snapshot interval: the newest frame describes a moment the
 * host has already moved on from even on a perfect link.
 */
export const PLAYBACK_DEFAULT_LEAD_TICKS = 2;
/** Buffer depth. Enough history to derive velocity and bridge a short gap. */
export const PLAYBACK_MAX_ENTRIES = 8;
/** Steps without an arrival before the feed counts as starving. */
export const PLAYBACK_STALE_STEPS = 18;
/** Extrapolation budget once starving, in ticks, before the view freezes. */
export const PLAYBACK_MAX_EXTRAPOLATE_TICKS = 30;
/**
 * Furthest forward a free ball is re-simulated from the newest sample. The
 * same half-second bound every other catch-up in the protocol uses.
 */
const MAX_BALL_STEPS = MAX_CATCHUP_TICKS;
/**
 * The longest a flight will wait at a contact it cannot resolve yet.
 *
 * Eight ticks is about 130 ms: longer than the delay the pin exists to cover,
 * and short enough that nobody reads the pause as the ball having stopped.
 * Without a bound the wait is however long the next snapshot takes, which on a
 * phone is sometimes a quarter of a second.
 */
const MAX_PIN_TICKS = 8;
/**
 * A contradiction further than this is taken outright rather than eased: a new
 * point, a serve, a reconnect. Sized like the character's `FOLLOWER_SNAP` —
 * further than anything a correction could plausibly be.
 */
export const BALL_SNAP = 3.0;
/** Seconds over which a correction is bled off. */
export const BALL_CORRECT_SECONDS = 0.1;
/**
 * How the playback clock is steered onto the instant it should be showing.
 *
 * The clock used to *be* that instant, recomputed every step from the newest
 * frame: `newestTick + lead + steps since it arrived`. That is only a clock
 * while frames arrive on a perfect grid. On a phone they do not — one lands a
 * step late, the next a step early — and every arrival re-anchored the sum, so
 * the instant on screen stalled, skipped two ticks, or went backwards. Measured
 * under ordinary jitter it went backwards on one step in fourteen and jumped by
 * as much as nine ticks. The ball is carried forward from that instant and the
 * clips are timed against it, so all of that jumping was drawn: the unsteady
 * ball and the stuttering swing were the clock, not the physics.
 *
 * So the clock advances one tick per step, as a clock should, and is steered
 * toward a target only when it has genuinely drifted from it.
 *
 * The target is read off the *least-delayed* recent arrival
 * (`CLOCK_WINDOW_ARRIVALS`), not the newest. A late frame says nothing about
 * where the host is — only that the route was slow — and a target that moved
 * with every late one made the clock lean a few per cent fast or slow almost
 * all the time. That was invisible as speed and very visible as timing: the
 * ball runs on this clock and the animations run on the renderer's, so a
 * wind-up that lasted seventy ticks on one and sixty-five on the other met a
 * ball that had already gone. Inside `CLOCK_DEADBAND_TICKS` the clock does not
 * lean at all, and beyond it only gently. A gap too large to lean out of (a
 * reconnect, a stall) is taken outright.
 */
export const CLOCK_GAIN = 0.02;
export const CLOCK_MAX_SLEW = 0.04;
export const CLOCK_DEADBAND_TICKS = 1.5;
export const CLOCK_SNAP_TICKS = 10;
/** Arrivals the target is read from — about a second and a half of frames. */
export const CLOCK_WINDOW_ARRIVALS = 45;
/**
 * Arrivals the host's tick *rate* is fitted over — about five seconds. Longer
 * than the target's window because a rate is a slope, and a slope read off a
 * second and a half of jittery arrivals wobbles more than the difference it is
 * there to find.
 */
export const CLOCK_RATE_ARRIVALS = 150;
/** A fitted rate this close to one is one: two healthy devices are equal. */
export const CLOCK_RATE_DEADZONE = 0.02;
/** The rates a host can plausibly run at relative to this device. */
export const CLOCK_RATE_MIN = 0.5;
export const CLOCK_RATE_MAX = 1.2;
/**
 * How far behind the newest well-routed frame a buffered guest draws, in
 * ticks: one snapshot interval, the jitter most frames arrive within, and a
 * tick of margin — bounded, and eased so it never jumps.
 */
export const PLAYBACK_BUFFER_MIN = 3;
export const PLAYBACK_BUFFER_MAX = 12;
/**
 * How far *ahead* of the target the clock may be before it is taken back
 * outright. Much further than forward, deliberately.
 *
 * A clock ahead of its target is nearly always one that kept counting through
 * a stall, while the frames were stuck behind a slow one on the socket. When
 * they all land at once the newest of them is still old, and "newest plus the
 * usual lead" says the host is well behind where it really is. The clock that
 * kept counting was right; snapping back to the stale sum rewound the whole
 * screen a quarter of a second after every hiccup. So it leans back instead,
 * and only a gap no stall explains — a reconnect — is taken whole.
 */
export const CLOCK_REWIND_TICKS = 60;

/**
 * The rate the host played a clip at, read back out of its window.
 *
 * The host raises the rate on a touch — a strike runs at 1.3, a set-up at 1.25
 * — and `drainNet` encodes that by shortening the window: `to - from` is the
 * clip's frames divided by its speed. So the speed is already on the wire and
 * needs no field of its own; it only needs dividing back out.
 *
 * Getting this wrong is not cosmetic. A guest playing a 1.3 clip at 1.0 reaches
 * the contact frame an eighth of a second after the ball has left, which is the
 * whole of "the animation does not match the physics" — and then has the clip
 * cut off at 77% when the window ends, popping the player back to idle
 * mid-follow-through.
 *
 * An unknown clip, or one reported with no window (an older host), falls back
 * to 1: the clip plays at its authored rate, which is what it did before.
 */
export function clipWindowSpeed(clip: string, from: number, to: number): number {
  const frames = CLIPS[clip]?.frames;
  const span = to - from;
  if (!frames || !Number.isFinite(span) || span <= 0) return 1;
  return frames / span;
}

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

/**
 * Furthest a character is carried past the frame that last reported it.
 *
 * Extrapolating a body is a guess whose error grows with the square of how far
 * it runs, because a player accelerates and turns and the ball does neither. A
 * metre is about a fifth of a second at a top speed of five, which covers the
 * lead and a dropped frame — and stops a feed that has genuinely stalled from
 * sprinting somebody across the court on a heading they abandoned. The next
 * frame brings them back through the easing the match already applies.
 */
export const MAX_CHAR_CARRY_METRES = 1.0;

/** Carry a character `ahead` ticks along a velocity, capped. */
function carryChar(from: Vec2, vx: number, vz: number, ahead: number): Vec2 {
  let dx = vx * ahead * SIM_DT;
  let dz = vz * ahead * SIM_DT;
  const d = Math.hypot(dx, dz);
  if (d > MAX_CHAR_CARRY_METRES) {
    const k = MAX_CHAR_CARRY_METRES / d;
    dx *= k;
    dz *= k;
  }
  return { x: from.x + dx, z: from.z + dz };
}

export class PlaybackBuffer {
  private entries: PlaybackSample[] = [];
  private newestTick = -1;
  private localStep = 0;
  private lastArrivalStep = -1;
  private engaged = false;
  /** How far ahead of the newest frame the timeline is read, in ticks. */
  private lead = PLAYBACK_DEFAULT_LEAD_TICKS;
  /**
   * How far the drawn ball is from the true one, bled off a fixed fraction per
   * step.
   *
   * An offset that decays on its own, rather than a filter that chases the
   * true position: a filter over a moving target settles at a permanent lag
   * proportional to the ball's speed, which is the very delay the lead exists
   * to remove. This settles at zero.
   */
  private ballOffset: Vec3 = { x: 0, y: 0, z: 0 };
  /** Last step's true ball and the instant it was read at, to spot a change. */
  private lastBall: { pos: Vec3; vel: Vec3; held: boolean; tick: number } | null = null;
  /** Starvation followed engagement; arms the re-engage signal. */
  private recovering = false;
  /** Buffered entries predate a starvation; the next push discards them. */
  private staleEntries = false;
  private pendingReengage = false;
  private extrapSteps = 0;
  private lastView: PlaybackView | null = null;
  /** The instant being shown, in host ticks. Null until the first view. */
  private clock: number | null = null;
  /** Where the clock was aimed last step, for the connection stats. */
  private lastTarget: number | null = null;
  /** The timeline has been live at least once since the last reset. */
  private engagedOnce = false;
  /**
   * For each recent arrival, the host tick it carried less the local step it
   * landed on. The host's clock and this one both advance a tick a step, so on
   * a perfect route this is constant; delay only ever lowers it. The largest is
   * the best route seen, and the one the clock is aimed by.
   */
  private arrivals: { step: number; tick: number }[] = [];
  /** Host ticks per local step, fitted over `CLOCK_RATE_ARRIVALS`. */
  private rate = 1;
  /**
   * Whether the clock draws behind the frames it has (`bufferTicks`) rather
   * than `lead` ahead of them. See `usePlaybackBuffer`.
   */
  private buffered = false;
  private bufferTicks = PLAYBACK_BUFFER_MIN + 1;

  /**
   * How far ahead of the newest frame to read, in ticks — the transport delay,
   * measured by the caller. Set every step; clamped to the same half-second
   * bound the rest of the protocol fast-forwards within.
   */
  setLead(ticks: number): void {
    if (!Number.isFinite(ticks)) return;
    this.lead = Math.max(0, Math.min(MAX_CATCHUP_TICKS, ticks));
  }

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
    // The step this frame is first read on.
    const arrival = { step: this.localStep + 1, tick: s.tick };
    // A frame arriving *better* routed than anything recent by more than a
    // snap means this device's steps stopped counting real time — a frame long
    // enough to drop simulation time, or no steps at all. Delay only ever makes
    // a frame look worse routed, so nothing on the network does this. The
    // history before it is measured against a step count that has since lost
    // time, and fitting the host's rate across the break read the break as a
    // fast host: one 700 ms stall on a 16 fps phone ran the clock twenty ticks
    // into the host's future and kept it there for fifteen seconds, replaying
    // every touch.
    // Compared with earlier steps only: the frames that piled up during the
    // stall all land on one step, each a little better routed than the last,
    // and no single one of them is the jump.
    const recent = this.arrivals.slice(-CLOCK_WINDOW_ARRIVALS).filter((a) => a.step < arrival.step);
    const offsetOf = (a: { step: number; tick: number }) => a.tick - this.rate * a.step;
    if (recent.length > 0 && offsetOf(arrival) - Math.max(...recent.map(offsetOf)) > CLOCK_SNAP_TICKS) {
      this.arrivals = [];
    }
    // One arrival per step, the newest: frames that land together describe one
    // moment of this device's time, and a column of them at one step is what
    // the least-squares rate reads as a steep slope.
    if (this.arrivals[this.arrivals.length - 1]?.step === arrival.step) this.arrivals.pop();
    this.arrivals.push(arrival);
    if (this.arrivals.length > CLOCK_RATE_ARRIVALS) this.arrivals.shift();
    this.newestTick = s.tick;
    this.lastArrivalStep = this.localStep;
    if (this.entries.length >= 2) {
      if (!this.engaged && this.recovering && this.lastView) this.pendingReengage = true;
      this.engaged = true;
      this.engagedOnce = true;
      this.extrapSteps = 0;
    }
  }

  /**
   * Advance one local 60 Hz step and read the timeline. Null before any sample.
   *
   * `colliders` are the two bodies the ball can bounce off. The host deflects
   * a ball that meets a character standing in its way, and an extrapolation
   * run without them carries that ball straight on — through the player, and
   * then back again when the truth arrives. Passed in rather than held,
   * because this stays a pure function of what it is given.
   */
  advance(colliders?: BodyCollider[]): PlaybackView | null {
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
      ? this.bufferedView(colliders)
      : this.extrapolatedView(stepsSince, colliders);
    if (view) this.lastView = view;
    // A cold start on a single frame is not an instant worth leaning from:
    // it sits a whole lead short, and leaning out of that took a second of
    // screen drawn behind. A starved feed carrying on is — it is still
    // counting the host's time — so the clock survives it.
    this.clock = this.engagedOnce && view ? view.renderTick : null;
    return view ?? this.lastView;
  }

  /** The clock, what it is aimed at, its rate and buffer, for the connection stats. */
  get stats(): { clock: number | null; target: number | null; lead: number; rate: number; buffer: number | null } {
    return {
      clock: this.clock,
      target: this.lastTarget,
      lead: this.lead,
      rate: this.rate,
      buffer: this.buffered ? this.bufferTicks : null,
    };
  }

  /**
   * Draw behind the frames rather than ahead of them.
   *
   * Ahead is a guess about what the host is doing now: every kick, turn and
   * bounce the frames have not reported yet is drawn wrong and corrected. A
   * guest that draws a short, measured interval behind its best-routed frame
   * shows what actually happened — both players interpolated between real
   * frames, every decision already in hand before its tick — and its own
   * player, predicted, stays instant. The host judges its presses against the
   * instant it was showing (`viewTick`), so drawing behind costs no reach.
   */
  usePlaybackBuffer(on = true): void {
    this.buffered = on;
  }

  /**
   * The host's tick rate against this device's steps, fitted by least squares
   * over the recent arrivals.
   *
   * Two devices are not always one speed. A host that cannot keep its
   * simulation on real time runs fewer ticks a second than this device steps,
   * and a clock that assumed one tick a step raced ahead of every frame and was
   * snapped back — measured, sixteen per cent was enough to make the screen
   * chaos. Following the host's real rate makes a slow host look slow, and
   * nothing worse.
   */
  private fitRate(): void {
    const n = this.arrivals.length;
    // A slope needs a few seconds of arrivals before it is worth believing: over
    // one second, ordinary jitter alone reads as a few per cent.
    if (n < 90) return;
    const first = this.arrivals[0].step;
    const span = this.arrivals[n - 1].step - first;
    if (span < 180) return;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const a of this.arrivals) {
      const x = a.step - first;
      sx += x;
      sy += a.tick;
      sxx += x * x;
      sxy += x * a.tick;
    }
    const denom = n * sxx - sx * sx;
    if (!(denom > 0)) return;
    const slope = (n * sxy - sx * sy) / denom;
    if (!Number.isFinite(slope)) return;
    const fitted = Math.max(CLOCK_RATE_MIN, Math.min(CLOCK_RATE_MAX, slope));
    const r = Math.abs(fitted - 1) < CLOCK_RATE_DEADZONE ? 1 : fitted;
    // Eased in, so a change of pace is a change of pace and not a lurch.
    this.rate += (r - this.rate) * 0.05;
    if (Math.abs(this.rate - r) < 1e-4) this.rate = r;
  }

  /** One step of the playback clock toward where it should be. See `CLOCK_GAIN`. */
  private stepClock(target: number): number {
    if (this.clock === null || !Number.isFinite(this.clock)) return target;
    // Where the clock is this step before leaning, which is what the target
    // has to be compared with. Comparing it with last step's reading counted
    // the step itself as error, and settled the clock a whole tick ahead.
    const ticked = this.clock + this.rate;
    const gap = target - ticked;
    if (gap > CLOCK_SNAP_TICKS || gap < -CLOCK_REWIND_TICKS) return target;
    const beyond = Math.abs(gap) - CLOCK_DEADBAND_TICKS;
    if (beyond <= 0) return ticked;
    return ticked + Math.sign(gap) * Math.min(CLOCK_MAX_SLEW, CLOCK_GAIN * beyond);
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
    this.clock = null;
    this.engagedOnce = false;
    this.arrivals = [];
    this.rate = 1;
    this.bufferTicks = PLAYBACK_BUFFER_MIN + 1;
    this.lastBall = null;
    this.ballOffset = { x: 0, y: 0, z: 0 };
  }

  /**
   * The next contact this frame can see coming, in host ticks, or null.
   *
   * A clip window spans fraction 0 to fraction 1 of the clip, and every
   * striking clip has its contact frame written down in `CLIPS`, so the instant
   * a limb meets the ball is arithmetic on numbers already on the wire. The
   * host commits a touch at least `MIN_WINDUP_FRAMES` before it lands, which is
   * longer than an ordinary one-way trip — so by the time the guest's clock
   * reaches the contact it has usually been holding the window for a while.
   *
   * Only contacts still ahead of the frame count. One already behind it is a
   * touch whose outcome this frame is reporting, not a surprise waiting to
   * happen.
   */
  private nextContactTick(a: PlaybackSample): number | null {
    let soonest: number | null = null;
    for (const c of [a.selfClip, a.opponentClip]) {
      if (!c?.clip || c.from === undefined || c.to === undefined) continue;
      if (!Number.isFinite(c.from) || !Number.isFinite(c.to) || c.to <= c.from) continue;
      // Zero means the clip has no contact frame at all — a celebration, a jog.
      const frac = contactFraction(c.clip);
      if (frac <= 0) continue;
      const at = c.from + frac * (c.to - c.from);
      if (at <= a.tick) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
    return soonest;
  }

  private bufferedView(colliders?: BodyCollider[]): PlaybackView {
    // The instant being shown: where the host is now, which is a frame plus
    // however long it took to get here plus the steps run since it was read.
    // The step a frame is first read on counts it as zero old, so `lead` means
    // exactly the transport delay rather than that minus a tick.
    //
    // That sum is where the clock should be, not where it is, and it is taken
    // from the best-routed recent frame rather than the newest: see
    // `CLOCK_GAIN`. On a perfect route the two are the same number.
    //
    // Clamped to the oldest buffered state so that after a gap the screen
    // glides onto the fresh timeline instead of sprinting through frames.
    this.fitRate();
    const recent = this.arrivals.slice(-CLOCK_WINDOW_ARRIVALS);
    const offsets = recent.map((a) => a.tick - this.rate * a.step);
    const best = Math.max(...offsets);
    if (this.buffered) {
      // How far behind the best route most frames arrive: the ninetieth
      // percentile of the shortfall, plus a snapshot interval and a tick.
      const short = offsets.map((o) => best - o).sort((x, y) => x - y);
      const p90 = short[Math.min(short.length - 1, Math.floor(short.length * 0.9))];
      const want = Math.max(PLAYBACK_BUFFER_MIN, Math.min(PLAYBACK_BUFFER_MAX, 2 + p90 + 1));
      this.bufferTicks += (want - this.bufferTicks) * 0.02;
    }
    const due = this.rate * this.localStep + best + (this.buffered ? -this.bufferTicks : this.lead);
    this.lastTarget = due;
    const renderTick = Math.max(this.stepClock(due), this.entries[0].tick);

    let a = this.entries[0];
    let b: PlaybackSample | null = null;
    for (const e of this.entries) {
      if (e.tick <= renderTick) a = e;
      else {
        b = e;
        break;
      }
    }

    // Characters ride the velocity the host reported for them, not a
    // difference of the positions it reported.
    //
    // The wire value is `Character.velocity`: eased by MOVE_TAU on the way up,
    // and exactly zero the step `moveToward` arrives at its target. A backward
    // difference of two 30 Hz positions lags that stop by two ticks and then
    // has the stale speed multiplied by the lead, which is why a guest sailed
    // past the end of every locked run to the drop spot and was yanked back —
    // on the one movement a reception is made of. It is also the same number
    // the host's own locomotion blend reads, so taking it here makes the jog
    // on this screen the jog on the other one.
    //
    // The difference stays as the fallback for a peer too old to send
    // velocities. The lerp is for a render point that lands between two real
    // frames, which only happens at zero lead.
    const charView = (key: "self" | "opponent"): CharView => {
      const wireOf = (s: PlaybackSample) => (key === "self" ? s.selfVel : s.opponentVel);
      if (b) {
        const span = b.tick - a.tick;
        const f = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 0;
        const pos = lerp2(a[key], b[key], f);
        const wa = wireOf(a);
        const wb = wireOf(b);
        const dt = span * SIM_DT;
        return {
          x: pos.x,
          z: pos.z,
          vx: wa && wb ? wa.x + (wb.x - wa.x) * f : (b[key].x - a[key].x) / dt,
          vz: wa && wb ? wa.z + (wb.z - wa.z) * f : (b[key].z - a[key].z) / dt,
        };
      }
      const wire = wireOf(a);
      let vx = 0;
      let vz = 0;
      if (wire) {
        vx = wire.x;
        vz = wire.z;
      } else {
        const prev = this.entries[this.entries.indexOf(a) - 1];
        if (prev) {
          const dt = Math.max(1, a.tick - prev.tick) * SIM_DT;
          vx = (a[key].x - prev[key].x) / dt;
          vz = (a[key].z - prev[key].z) / dt;
        }
      }
      const ahead = Math.max(0, renderTick - a.tick);
      return { ...carryChar(a[key], vx, vz, ahead), vx, vz };
    };

    // Ball: a held ball rides the hand — lerp, no physics. Free flight is the
    // shared pure physics stepped forward from the newest reported state: the
    // host's own trajectory, save the limb steering only the host applies.
    let target: Vec3;
    let ballVel: Vec3;
    let pinned = false;
    const held = a.ballHeld;
    if (held) {
      const span = b && b.tick > a.tick ? b.tick - a.tick : 1;
      const f = Math.max(0, Math.min(1, (renderTick - a.tick) / span));
      target = b ? lerp3(a.ball, b.ball, f) : { ...a.ball };
      ballVel = { x: 0, y: 0, z: 0 };
    } else {
      const state: BallState = {
        pos: new Vector3(a.ball.x, a.ball.y, a.ball.z),
        vel: new Vector3(a.ballVel.x, a.ballVel.y, a.ballVel.z),
      };
      // Pure physics is exact right up to the instant somebody touches the
      // ball, and a touch is the one thing in the lead the guest cannot
      // compute. It can see it coming, though — so the flight stops at the
      // contact instead of sailing through the foot and being dragged back.
      const contact = this.nextContactTick(a);
      /*
       * Waiting has to be bounded, and it was not.
       *
       * The pin holds the flight at the contact until the frame carrying its
       * outcome arrives. That is right for the transport delay it was written
       * for — a tick or two — and quietly wrong for anything longer, because
       * the wait is however long the *next snapshot* takes. Under the delivery
       * a phone actually gets, that is sometimes a quarter of a second, and a
       * ball that stops dead in mid-air for a quarter of a second does not
       * read as a prediction being careful. It reads as the game freezing.
       *
       * So: hold briefly, then fly on. Being a little past the foot and eased
       * back is what `easeBall` is for and is barely visible; stopping is
       * unmistakable.
       */
      const held = contact === null ? renderTick : Math.floor(contact);
      const until = Math.min(renderTick, Math.max(held, renderTick - MAX_PIN_TICKS));
      pinned = until < renderTick;
      const steps = Math.min(Math.max(0, until - a.tick), MAX_BALL_STEPS);
      for (let i = 0; i < steps; i++) stepBall(state, SIM_DT, undefined, colliders);
      target = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
      ballVel = { x: state.vel.x, y: state.vel.y, z: state.vel.z };
    }
    // Reading ahead of the newest frame means a frame can contradict what is
    // already drawn — the host struck the ball, and there was no way to know.
    // Ease that out rather than jumping, which is the whole cost of leading.
    // The velocity is taken from the truth even while the position is still
    // catching up, so the landing marker predicts the real flight.
    const ball = this.easeBall(target, ballVel, renderTick, held, pinned, colliders);

    // What the host says this character is doing, as of the newest frame it
    // sent — the same source everything else in the view comes from.
    //
    // This used to search back through the buffer for any window that happened
    // to contain the render point, and take the first one it found. A window
    // stays open until the clip would have finished, but the host stops a clip
    // the moment the touch is over, so an older frame's open window would beat
    // the newest frame's "nothing at all". That is a guest still playing a
    // touch the host had finished with, and a rally clip turning up at the next
    // serve, because the rally's windows had not closed yet.
    const clipView = (key: "selfClip" | "opponentClip"): ClipSample | null => a[key] ?? null;

    return {
      renderTick,
      ball,
      ballVel,
      ballHeld: held,
      self: charView("self"),
      opponent: charView("opponent"),
      selfClip: clipView("selfClip"),
      opponentClip: clipView("opponentClip"),
      mode: "buffered",
      rate: this.rate,
    };
  }

  /**
   * Where the ball is drawn, given where it truly is.
   *
   * The same law `reconcile` uses on a predicted character — a fixed fraction
   * of the remaining error per step, and the target taken outright once the
   * gap is too large to be a correction — in three dimensions, because a ball
   * has a height and a character does not.
   *
   * A held ball is never eased: it is pinned to a hand, and a ball lagging
   * behind the palm that is carrying it looks worse than any jump.
   */
  private easeBall(
    target: Vec3,
    vel: Vec3,
    tick: number,
    held: boolean,
    /** The flight is stopped at a contact whose outcome is not known yet. */
    pinned = false,
    colliders?: BodyCollider[]
  ): Vec3 {
    const prev = this.lastBall;
    const remember = (v: Vec3 = vel) => {
      this.lastBall = { pos: { ...target }, vel: { ...v }, held, tick };
    };
    const take = (): Vec3 => {
      this.ballOffset = { x: 0, y: 0, z: 0 };
      remember();
      return { ...target };
    };
    if (held || !prev || prev.held !== held) return take();

    if (pinned) {
      // Waiting at the contact point. Nothing new accrues — the target is not
      // moving — and any offset still left from the last correction keeps
      // bleeding off. Remembered as motionless, so the step that releases the
      // ball reads the whole of the launch as one change and eases it away
      // instead of taking it as a jump.
      const keep = Math.max(0, 1 - SIM_DT / BALL_CORRECT_SECONDS);
      const o = this.ballOffset;
      this.ballOffset = { x: o.x * keep, y: o.y * keep, z: o.z * keep };
      remember({ x: 0, y: 0, z: 0 });
      return {
        x: target.x + this.ballOffset.x,
        y: target.y + this.ballOffset.y,
        z: target.z + this.ballOffset.z,
      };
    }

    // Where the flight already on screen was going to be at this instant. Any
    // difference from where it actually is, is the host having changed the
    // ball's path — a kick, a bounce off a body — which this peer could not
    // have known about until the frame carrying it arrived.
    const ahead = Math.min(Math.max(0, tick - prev.tick), MAX_BALL_STEPS);
    const expected: BallState = {
      pos: new Vector3(prev.pos.x, prev.pos.y, prev.pos.z),
      vel: new Vector3(prev.vel.x, prev.vel.y, prev.vel.z),
    };
    for (let i = 0; i < ahead; i++) stepBall(expected, SIM_DT, undefined, colliders);
    const cx = expected.pos.x - target.x;
    const cy = expected.pos.y - target.y;
    const cz = expected.pos.z - target.z;

    // Carrying the change into the offset is what keeps the drawn ball
    // continuous across it; the decay below is what puts it back on the truth.
    let ox = this.ballOffset.x + cx;
    let oy = this.ballOffset.y + cy;
    let oz = this.ballOffset.z + cz;
    if (Math.sqrt(ox * ox + oy * oy + oz * oz) > BALL_SNAP) return take();
    const keep = Math.max(0, 1 - SIM_DT / BALL_CORRECT_SECONDS);
    ox *= keep;
    oy *= keep;
    oz *= keep;
    this.ballOffset = { x: ox, y: oy, z: oz };
    remember();
    return { x: target.x + ox, y: target.y + oy, z: target.z + oz };
  }

  /**
   * No live timeline this step — warming up before a second frame, or the
   * feed starved. Carry the last view forward: the ball along the same pure
   * physics, characters along their velocity. After the extrapolation budget
   * the view freezes rather than wandering ever further from the truth.
   */
  private extrapolatedView(stepsSince: number, colliders?: BodyCollider[]): PlaybackView | null {
    if (!this.lastView) {
      // Cold start with a single frame: place everything on it, wire
      // velocities carrying the characters if the render point is ahead.
      const a = this.entries[0];
      const ahead = Math.max(0, stepsSince - 1) + this.lead;
      const wire = (v?: Vec2) => ({ x: v?.x ?? 0, z: v?.z ?? 0 });
      const sv = wire(a.selfVel);
      const ov = wire(a.opponentVel);
      return {
        renderTick: a.tick,
        ball: { ...a.ball },
        ballVel: { ...a.ballVel },
        ballHeld: a.ballHeld,
        self: { ...carryChar(a.self, sv.x, sv.z, ahead), vx: sv.x, vz: sv.z },
        opponent: { ...carryChar(a.opponent, ov.x, ov.z, ahead), vx: ov.x, vz: ov.z },
        selfClip: a.selfClip ?? null,
        opponentClip: a.opponentClip ?? null,
        mode: "extrapolated",
        rate: this.rate,
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
      stepBall(state, SIM_DT, undefined, colliders);
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
      renderTick: last.renderTick + this.rate,
      ball,
      ballVel,
      ballHeld: last.ballHeld,
      self: carry(last.self),
      opponent: carry(last.opponent),
      selfClip: last.selfClip,
      opponentClip: last.opponentClip,
      mode: "extrapolated",
      rate: this.rate,
    };
  }
}
