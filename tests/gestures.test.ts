import { describe, expect, it } from "vitest";
import { DEFAULT_GESTURE_TUNING, GestureScheme, type Gesture } from "../src/gestures";

/** A 400 x 800 phone held upright: the short side is 400. */
const scheme = (): GestureScheme => {
  const s = new GestureScheme();
  s.setViewport(400, 800);
  return s;
};

const HOLD = DEFAULT_GESTURE_TUNING.holdDelay;

describe("portrait gestures", () => {
  it("reads a quick press in one place as a placement tap", () => {
    const s = scheme();
    s.begin(1, 120, 500, 0);
    s.tick(0.05);
    s.end(1, 0.08);

    expect(s.take()).toEqual<Gesture[]>([{ kind: "tap", x: 0.3, y: 0.625 }]);
  });

  it("reads a press held in place as a reception, while the finger is still down", () => {
    const s = scheme();
    s.begin(1, 320, 400, 0);

    s.tick(HOLD - 0.01);
    expect(s.take()).toEqual([]); // too early: this could still become a tap

    s.tick(HOLD + 0.01);
    expect(s.take()).toEqual<Gesture[]>([{ kind: "hold", x: 0.8, y: 0.5 }]);

    // Lifting off must not fire a second gesture on the way out.
    s.end(1, 0.6);
    expect(s.take()).toEqual([]);
  });

  it("aims a reception by the side of the screen it happens on", () => {
    const left = scheme();
    left.begin(1, 40, 400, 0);
    left.tick(HOLD + 0.01);
    const right = scheme();
    right.begin(1, 360, 400, 0);
    right.tick(HOLD + 0.01);

    const l = left.take()[0];
    const r = right.take()[0];
    expect(l.x).toBeLessThan(0.5);
    expect(r.x).toBeGreaterThan(0.5);
  });

  it("reads a directional drag as a swipe, with its direction", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.move(1, 200, 480); // 120 px up = 0.3 of the short side
    s.end(1, 0.14);

    const [g] = s.take();
    expect(g.kind).toBe("swipe");
    if (g.kind !== "swipe") throw new Error("not a swipe");
    expect(g.dy).toBeCloseTo(-1, 5);
    expect(g.dx).toBeCloseTo(0, 5);
    expect(g.strength).toBeCloseTo(1, 5);
  });

  it("scales strength with how far the finger travelled", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.move(1, 260, 600); // 60 px = 0.15 of the short side, half of swipeFull
    s.end(1, 0.1);

    const [g] = s.take();
    if (g.kind !== "swipe") throw new Error("not a swipe");
    expect(g.strength).toBeCloseTo(0.5, 5);
    expect(g.dx).toBeCloseTo(1, 5);
  });

  it("never turns a moving finger into a tap or a reception", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.move(1, 224, 600); // 24 px: past the slop, short of a swipe
    s.tick(1); // held far longer than the hold delay
    s.end(1, 1.2);

    // A smudge is not a decision: better nothing than the wrong touch.
    expect(s.take()).toEqual([]);
  });

  it("still reports a lingering press when no frame ran to tick it", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.end(1, HOLD + 0.5);

    expect(s.take()).toEqual<Gesture[]>([{ kind: "hold", x: 0.5, y: 0.75 }]);
  });

  it("tracks two fingers independently", () => {
    const s = scheme();
    s.begin(1, 100, 200, 0);
    s.begin(2, 300, 700, 0);
    s.move(2, 300, 580);
    s.end(2, 0.1); // second finger swipes
    s.end(1, 0.12); // first finger taps

    const kinds = s.take().map((g) => g.kind);
    expect(kinds).toEqual(["swipe", "tap"]);
  });

  it("forgets everything on clear, so a rotation cannot fire a stale gesture", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.clear();
    s.tick(1);
    s.end(1, 1.1);

    expect(s.take()).toEqual([]);
  });

  it("judges distance against the short side, whichever way the screen turns", () => {
    const tall = new GestureScheme();
    tall.setViewport(400, 800);
    const wide = new GestureScheme();
    wide.setViewport(800, 400);
    for (const s of [tall, wide]) {
      s.begin(1, 100, 100, 0);
      s.move(1, 160, 100); // 60 px: 0.15 of 400 in both
      s.end(1, 0.1);
    }

    const t = tall.take()[0];
    const w = wide.take()[0];
    if (t.kind !== "swipe" || w.kind !== "swipe") throw new Error("both should swipe");
    expect(t.strength).toBeCloseTo(w.strength, 5);
  });
});
