/**
 * Portrait play is touch only: the screen *is* the controller.
 *
 *   - a tap places the player on the court,
 *   - a double tap makes a controlled reception, aimed by where it lands,
 *   - a directional swipe kicks, its direction aiming the shot.
 *
 * Anything else — a finger resting, a smudge too short to aim — deliberately
 * does nothing. On a surface where every pixel is a control, the safest thing
 * an ambiguous gesture can do is nothing at all.
 *
 * Telling them apart has to be done from partial evidence: a finger that has
 * been down for 80 ms and moved 4 px could still become any of them. Two rules
 * resolve it. Distance separates a swipe from the taps. Time separates a tap
 * from a rest — and a tap is not reported until the double-tap window has
 * passed without a second one, or the first press of every double tap would
 * send the player running before the second arrived.
 *
 * Pointer plumbing deliberately lives in input.ts instead, so the whole scheme
 * can be exercised without a browser: feed it begin/move/end/tick and drain
 * what it recognised.
 */

/** Screen positions are normalised to 0..1 of the viewport, origin top-left. */
export type Gesture =
  | { kind: "tap"; x: number; y: number }
  | { kind: "doubletap"; x: number; y: number }
  | {
      kind: "swipe";
      x: number;
      y: number;
      /** Unit direction in screen space: +x right, +y down. */
      dx: number;
      dy: number;
      /** 0..1, how far the finger travelled relative to a full-strength swipe. */
      strength: number;
    };

export interface GestureTuning {
  /** Travel past this (fraction of the short screen side) is no longer a tap. */
  slop: number;
  /** A swipe has to travel at least this far to count as aimed. */
  swipeMin: number;
  /** Travel that reads as a full-strength swipe; beyond it, strength saturates. */
  swipeFull: number;
  /** A still press longer than this is a rest, not a tap. */
  tapMax: number;
  /** How long a tap waits for a second one before it is reported alone. */
  doubleWindow: number;
  /** How near the first tap the second has to land to pair with it. */
  doubleRadius: number;
}

/**
 * Tuned for a thumb on a phone held one-handed. `doubleWindow` is the number a
 * player feels: it is latency on every placement tap, and shortening it starts
 * dropping the second tap of a genuine pair.
 */
export const DEFAULT_GESTURE_TUNING: GestureTuning = {
  slop: 0.035,
  swipeMin: 0.08,
  swipeFull: 0.3,
  tapMax: 0.3,
  doubleWindow: 0.28,
  doubleRadius: 0.16,
};

interface Track {
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
  /** Travelled past the slop, so it can only ever become a swipe. */
  moved: boolean;
}

export class GestureScheme {
  private width = 1;
  private height = 1;
  private tracks = new Map<number, Track>();
  /**
   * A tap waiting to see whether a second one turns it into a double. Kept in
   * pixels as well as normalised units: how far apart two taps are is a
   * distance on the glass, and the two axes normalise by different numbers.
   */
  private pendingTap: { x: number; y: number; px: number; py: number; t: number } | null = null;
  private out: Gesture[] = [];

  constructor(private tuning: GestureTuning = DEFAULT_GESTURE_TUNING) {}

  /** Viewport size in pixels. Distances are judged against its short side. */
  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  private get unit(): number {
    return Math.min(this.width, this.height);
  }

  begin(id: number, px: number, py: number, t: number): void {
    this.tracks.set(id, { x0: px, y0: py, x: px, y: py, t0: t, moved: false });
  }

  move(id: number, px: number, py: number): void {
    const track = this.tracks.get(id);
    if (!track) return;
    track.x = px;
    track.y = py;
    if (Math.hypot(px - track.x0, py - track.y0) > this.tuning.slop * this.unit) track.moved = true;
  }

  /** Release a tap that has waited out its double-tap window. Call once a frame. */
  tick(t: number): void {
    const pending = this.pendingTap;
    if (!pending || t - pending.t < this.tuning.doubleWindow) return;
    this.pendingTap = null;
    this.out.push({ kind: "tap", x: pending.x, y: pending.y });
  }

  end(id: number, t: number): void {
    const track = this.tracks.get(id);
    if (!track) return;
    this.tracks.delete(id);

    const dx = track.x - track.x0;
    const dy = track.y - track.y0;
    const travel = Math.hypot(dx, dy) / this.unit;
    const x = track.x / this.width;
    const y = track.y / this.height;

    if (travel >= this.tuning.swipeMin) {
      const strength = Math.min(1, travel / this.tuning.swipeFull);
      const len = Math.hypot(dx, dy);
      this.out.push({ kind: "swipe", x, y, dx: dx / len, dy: dy / len, strength });
      return;
    }
    // A smudge too short to aim, or a finger that simply rested: neither is a
    // decision, and guessing at one would cost a touch.
    if (track.moved || t - track.t0 > this.tuning.tapMax) return;

    const first = this.pendingTap;
    const near =
      first !== null &&
      t - first.t < this.tuning.doubleWindow &&
      Math.hypot(track.x - first.px, track.y - first.py) <= this.tuning.doubleRadius * this.unit;
    if (near) {
      this.pendingTap = null;
      this.out.push({ kind: "doubletap", x, y });
      return;
    }
    // A tap that does not pair with the one waiting settles it: two taps too
    // far apart, or too far apart in time, are two placements, and dropping
    // the first would lose a deliberate instruction.
    if (first) this.out.push({ kind: "tap", x: first.x, y: first.y });
    // Held back until tick() decides no second tap is coming. Reporting it now
    // would send the player running on the first half of every double tap.
    this.pendingTap = { x, y, px: track.x, py: track.y, t };
  }

  cancel(id: number): void {
    this.tracks.delete(id);
  }

  /** Take everything recognised since the last call. */
  take(): Gesture[] {
    if (this.out.length === 0) return [];
    const out = this.out;
    this.out = [];
    return out;
  }

  /** Forget every finger and pending gesture (orientation change, blur, pause). */
  clear(): void {
    this.tracks.clear();
    this.pendingTap = null;
    this.out.length = 0;
  }
}
