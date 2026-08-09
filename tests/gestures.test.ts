import { describe, expect, it } from "vitest";
import { DEFAULT_GESTURE_TUNING, GestureScheme, type Gesture } from "../src/gestures";

/** A 400 x 800 phone held upright: the short side is 400. */
const scheme = (): GestureScheme => {
  const s = new GestureScheme();
  s.setViewport(400, 800);
  return s;
};

const { tapMax: TAP_MAX } = DEFAULT_GESTURE_TUNING;

/** Press and release in one place, without moving. */
const press = (s: GestureScheme, id: number, x: number, y: number, at: number, held = 0.05) => {
  s.begin(id, x, y, at);
  s.end(id, at + held);
};

describe("portrait gestures", () => {
  it("reports a tap as soon as the finger lifts", () => {
    const s = scheme();
    press(s, 1, 120, 500, 0);

    // No waiting: there is no second tap to wait for any more.
    expect(s.take()).toEqual<Gesture[]>([{ kind: "tap", x: 0.3, y: 0.625 }]);
  });

  it("reports two quick taps as two taps", () => {
    const s = scheme();
    press(s, 1, 200, 400, 0);
    press(s, 2, 206, 404, 0.14);

    expect(s.take().map((g) => g.kind)).toEqual(["tap", "tap"]);
  });

  it("reads a directional drag as a swipe, with its direction", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.move(1, 200, 480, 0.05); // 120 px up = 0.3 of the short side
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
    s.move(1, 260, 600, 0.05); // 60 px = 0.15 of the short side, half of swipeFull
    s.end(1, 0.1);

    const [g] = s.take();
    if (g.kind !== "swipe") throw new Error("not a swipe");
    expect(g.strength).toBeCloseTo(0.5, 5);
    expect(g.dx).toBeCloseTo(1, 5);
  });

  it("still swipes when the finger rested before setting off", () => {
    // A thumb that lands, waits, then flicks is one gesture, not a dead press.
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.move(1, 200, 470, 0.05);
    s.end(1, 1.2);

    expect(s.take().map((g) => g.kind)).toEqual(["swipe"]);
  });

  it("does nothing for a resting finger or a smudge", () => {
    const rest = scheme();
    press(rest, 1, 200, 600, 0, TAP_MAX + 0.1);
    expect(rest.take()).toEqual([]);

    const smudge = scheme();
    smudge.begin(1, 200, 600, 0);
    smudge.move(1, 224, 600, 0.05); // 24 px: past the slop, short of a swipe
    smudge.end(1, 0.1);
    expect(smudge.take()).toEqual([]);
  });

  it("judges distance against the short side, whichever way the screen turns", () => {
    const tall = new GestureScheme();
    tall.setViewport(400, 800);
    const wide = new GestureScheme();
    wide.setViewport(800, 400);
    for (const s of [tall, wide]) {
      s.begin(1, 100, 100, 0);
      s.move(1, 160, 100, 0.05); // 60 px: 0.15 of 400 in both
      s.end(1, 0.1);
    }

    const t = tall.take()[0];
    const w = wide.take()[0];
    if (t.kind !== "swipe" || w.kind !== "swipe") throw new Error("both should swipe");
    expect(t.strength).toBeCloseTo(w.strength, 5);
  });

  it("forgets everything on clear, so a rotation cannot fire a stale gesture", () => {
    const s = scheme();
    s.begin(1, 200, 600, 0);
    s.clear();
    s.end(1, 0.05);

    expect(s.take()).toEqual([]);
  });
});
