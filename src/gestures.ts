/**
 * Portrait play is touch only: the screen *is* the controller.
 *
 *   - a tap says where to be, or which way to set the ball up,
 *   - a directional swipe kicks, its direction aiming the shot.
 *
 * Anything else — a finger resting, a smudge too short to aim — deliberately
 * does nothing. On a surface where every pixel is a control, the safest thing
 * an ambiguous gesture can do is nothing at all.
 *
 * Two rules tell them apart. Distance separates a swipe from a tap, and time
 * separates a tap from a rest. There was a double tap here as well; it is gone,
 * and with it the delay every tap used to sit through while the scheme waited
 * to see whether a second one was coming.
 *
 * Pointer plumbing deliberately lives in input.ts instead, so the whole scheme
 * can be exercised without a browser: feed it begin/move/end and drain what
 * it recognised.
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
      /**
       * 0..1, how fast it was drawn. This is the one a kick reads: a flick is
       * a low, fast strike and a slow drag is a floated one, and the two are
       * told apart by pace rather than by length.
       */
      speed: number;
    };

export interface GestureTuning {
  /** Travel past this (fraction of the short screen side) is no longer a tap. */
  slop: number;
  /** A swipe has to travel at least this far to count as aimed. */
  swipeMin: number;
  /** Travel that reads as a full-strength swipe; beyond it, strength saturates. */
  swipeFull: number;
  /** Pace, in short-screen-sides per second, that reads as a full-speed flick. */
  swipeFastest: number;
  /** A still press longer than this is a rest, not a tap. */
  tapMax: number;
}

/** Tuned for a thumb on a phone held one-handed. */
export const DEFAULT_GESTURE_TUNING: GestureTuning = {
  slop: 0.035,
  swipeMin: 0.08,
  swipeFull: 0.3,
  swipeFastest: 1.9,
  tapMax: 0.3,
};

interface Track {
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
  /** Travelled past the slop, so it can only ever become a swipe. */
  moved: boolean;
  /** When it first moved, which is when the swipe it may become began. */
  movedAt: number | null;
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
    this.tracks.set(id, { x0: px, y0: py, x: px, y: py, t0: t, moved: false, movedAt: null });
  }

  move(id: number, px: number, py: number, t: number): void {
    const track = this.tracks.get(id);
    if (!track) return;
    track.x = px;
    track.y = py;
    if (Math.hypot(px - track.x0, py - track.y0) > this.tuning.slop * this.unit) {
      track.moved = true;
      track.movedAt ??= t;
    }
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
      // Pace over the whole gesture. A finger that rested before setting off
      // would otherwise read as slow no matter how hard it was then flicked,
      // so the clock starts at the first movement, not at the press.
      const drawn = Math.max(1e-3, t - (track.movedAt ?? track.t0));
      const speed = Math.min(1, travel / drawn / this.tuning.swipeFastest);
      const len = Math.hypot(dx, dy);
      this.out.push({ kind: "swipe", x, y, dx: dx / len, dy: dy / len, strength, speed });
      return;
    }
    // A smudge too short to aim, or a finger that simply rested: neither is a
    // decision, and guessing at one would cost a touch.
    if (track.moved || t - track.t0 > this.tuning.tapMax) return;
    this.out.push({ kind: "tap", x, y });
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
