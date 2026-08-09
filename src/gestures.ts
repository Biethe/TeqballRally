/**
 * Portrait play is touch only: the screen *is* the controller.
 *
 *   - a quick tap places the player on the court,
 *   - a directional swipe kicks, its direction aiming the shot,
 *   - a press held in place is a reception, aimed by the side of the screen it
 *     happens on.
 *
 * Three gestures on one surface have to be told apart from partial evidence —
 * a finger that has been down for 80 ms and moved 4 px could still become any
 * of them. The rules below resolve that with one decision each: distance
 * separates a swipe from the other two, and time separates a tap from a hold.
 *
 * Pointer plumbing deliberately lives in input.ts instead, so the whole scheme
 * can be exercised without a browser: feed it begin/move/end/tick and drain
 * what it recognised.
 */

/** Screen positions are normalised to 0..1 of the viewport, origin top-left. */
export type Gesture =
  | { kind: "tap"; x: number; y: number }
  | {
      kind: "swipe";
      x: number;
      y: number;
      /** Unit direction in screen space: +x right, +y down. */
      dx: number;
      dy: number;
      /** 0..1, how far the finger travelled relative to a full-strength swipe. */
      strength: number;
    }
  | { kind: "hold"; x: number; y: number };

export interface GestureTuning {
  /** Travel past this (fraction of the short screen side) is no longer a tap. */
  slop: number;
  /** A swipe has to travel at least this far to count as aimed. */
  swipeMin: number;
  /** Travel that reads as a full-strength swipe; beyond it, strength saturates. */
  swipeFull: number;
  /** A press still in place after this many seconds is a reception. */
  holdDelay: number;
}

/**
 * Tuned for a thumb on a phone held one-handed. `holdDelay` is the one number
 * a player feels: too short and a deliberate placement tap turns into a
 * reception and burns a touch, too long and a reception arrives after the ball
 * has gone. A quick tap is under 120 ms and a hold is meant to be held, so it
 * sits well clear of the first without making the second feel sticky.
 */
export const DEFAULT_GESTURE_TUNING: GestureTuning = {
  slop: 0.035,
  swipeMin: 0.08,
  swipeFull: 0.3,
  holdDelay: 0.22,
};

interface Track {
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
  /** Travelled past the slop, so it can only ever become a swipe. */
  moved: boolean;
  /** Already reported as a reception; its release means nothing. */
  held: boolean;
}

export class GestureScheme {
  private width = 1;
  private height = 1;
  private tracks = new Map<number, Track>();
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
    this.tracks.set(id, { x0: px, y0: py, x: px, y: py, t0: t, moved: false, held: false });
  }

  move(id: number, px: number, py: number): void {
    const track = this.tracks.get(id);
    if (!track) return;
    track.x = px;
    track.y = py;
    if (Math.hypot(px - track.x0, py - track.y0) > this.tuning.slop * this.unit) track.moved = true;
  }

  /**
   * Fire receptions whose hold has matured. Called once a frame: a hold is the
   * one gesture that has to be reported while the finger is still down, or the
   * player would have to lift off before the game reacted.
   */
  tick(t: number): void {
    for (const track of this.tracks.values()) {
      if (track.moved || track.held || t - track.t0 < this.tuning.holdDelay) continue;
      track.held = true;
      this.out.push({ kind: "hold", x: track.x / this.width, y: track.y / this.height });
    }
  }

  end(id: number, t: number): void {
    const track = this.tracks.get(id);
    if (!track) return;
    this.tracks.delete(id);
    if (track.held) return; // its reception already went out

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
    // A finger that stayed put: quick is a placement, lingering is a
    // reception. The second case only arises when tick() never ran (a stalled
    // frame), and dropping it there would silently eat the touch.
    if (track.moved) return; // a smudge too short to aim: no gesture at all
    if (t - track.t0 < this.tuning.holdDelay) this.out.push({ kind: "tap", x, y });
    else this.out.push({ kind: "hold", x, y });
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
    this.out.length = 0;
  }
}
