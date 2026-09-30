import { describe, expect, it } from "vitest";
import type { CameraMode } from "../src/config";
import { consumeInput, latchInput, newLatch, type InputState,
  looksLikeTouchDevice,
  moveForView,
} from "../src/input";

const sample = (over: Partial<InputState> = {}): InputState => ({
  moveX: 0,
  moveZ: 0,
  strikePressed: false,
  strikeHeld: false,
  strikePower: 0,
  strikeTaps: undefined,
  strikeLoft: undefined,
  strikeTapsSoFar: 0,
  strikeHoldSoFar: 0,
  popPressed: false,
  confirmPressed: false,
  ...over,
});

describe("input latching", () => {
  it("starts neutral", () => {
    expect(newLatch()).toEqual(sample());
  });

  it("tracks the newest axes rather than accumulating them", () => {
    const latch = newLatch();

    latchInput(latch, sample({ moveX: 1, moveZ: -1 }));
    latchInput(latch, sample({ moveX: 0.25, moveZ: 0 }));

    expect(latch.moveX).toBe(0.25);
    expect(latch.moveZ).toBe(0);
  });

  it("holds a press until a step consumes it", () => {
    const latch = newLatch();

    // Frame 1 sees the press but runs no simulation step.
    latchInput(latch, sample({ strikePressed: true }));
    // Frame 2 sees nothing new — the press must survive.
    latchInput(latch, sample());

    expect(consumeInput(latch).strikePressed).toBe(true);
  });

  it("delivers a press exactly once across several steps", () => {
    const latch = newLatch();
    latchInput(latch, sample({ strikePressed: true, popPressed: true, confirmPressed: true }));

    const first = consumeInput(latch);
    const second = consumeInput(latch);

    expect(first).toMatchObject({ strikePressed: true, popPressed: true, confirmPressed: true });
    expect(second).toMatchObject({ strikePressed: false, popPressed: false, confirmPressed: false });
  });

  it("keeps delivering axes on every step", () => {
    const latch = newLatch();
    latchInput(latch, sample({ moveX: 0.5, moveZ: -0.5, strikePressed: true }));

    const first = consumeInput(latch);
    const second = consumeInput(latch);

    // The stick is still held even though the press is spent.
    expect(second.moveX).toBe(first.moveX);
    expect(second.moveZ).toBe(first.moveZ);
    expect(second.strikePressed).toBe(false);
  });

  it("latches each control independently", () => {
    const latch = newLatch();

    latchInput(latch, sample({ strikePressed: true }));
    latchInput(latch, sample({ popPressed: true }));

    const step = consumeInput(latch);
    expect(step.strikePressed).toBe(true);
    expect(step.popPressed).toBe(true);
    expect(step.confirmPressed).toBe(false);
  });

  it("collapses a double press between steps into one", () => {
    // Two polls both reporting a strike, with no step between them, is a
    // player mashing faster than the simulation rate. One rally touch results.
    const latch = newLatch();
    latchInput(latch, sample({ strikePressed: true }));
    latchInput(latch, sample({ strikePressed: true }));

    expect(consumeInput(latch).strikePressed).toBe(true);
    expect(consumeInput(latch).strikePressed).toBe(false);
  });

  it("hands back a detached snapshot", () => {
    const latch = newLatch();
    latchInput(latch, sample({ moveX: 1, strikePressed: true }));

    const step = consumeInput(latch);
    latchInput(latch, sample({ moveX: -1 }));

    // A later poll must not retroactively change a step already simulated.
    expect(step.moveX).toBe(1);
    expect(step.strikePressed).toBe(true);
  });

  it("survives a full poll/step cycle at a mismatched rate", () => {
    // Three display frames per two simulation steps: every press still lands,
    // and none lands twice.
    const latch = newLatch();
    const delivered: boolean[] = [];

    latchInput(latch, sample({ strikePressed: true })); // frame 1, no step
    latchInput(latch, sample()); // frame 2
    delivered.push(consumeInput(latch).strikePressed); // step
    latchInput(latch, sample()); // frame 3
    delivered.push(consumeInput(latch).strikePressed); // step

    expect(delivered).toEqual([true, false]);
  });
});

describe("which way the screen points in each view", () => {
  /**
   * Four signs, and getting one wrong is a control scheme nobody can play.
   *
   * The side view is why this exists: the mapping was hard-coded to the camera
   * behind the baseline, so playing from the sideline felt like the world had
   * been rotated ninety degrees under the thumb.
   */
  const UP = { sx: 0, sy: -1 };
  const RIGHT = { sx: 1, sy: 0 };
  /** Negating a zero axis yields -0, which toEqual treats as a different value. */
  const move = (sx: number, sy: number, view: CameraMode) => {
    const m = moveForView(sx, sy, view);
    return { moveX: m.moveX + 0, moveZ: m.moveZ + 0 };
  };

  it("sends screen-up toward the net in the court view", () => {
    expect(move(UP.sx, UP.sy, "court")).toEqual({ moveX: 1, moveZ: 0 });
  });

  it("sends screen-right across the court in the court view", () => {
    expect(move(RIGHT.sx, RIGHT.sy, "court")).toEqual({ moveX: 0, moveZ: -1 });
  });

  it("sends screen-right toward the net in the side view", () => {
    // The court's length runs across the screen when seen from the sideline.
    expect(move(RIGHT.sx, RIGHT.sy, "side")).toEqual({ moveX: 1, moveZ: 0 });
  });

  it("sends screen-up away from the camera in the side view", () => {
    expect(move(UP.sx, UP.sy, "side")).toEqual({ moveX: 0, moveZ: 1 });
  });

  it("turns the same stick a quarter turn between the two views", () => {
    // Whatever the signs are, the two views must not agree — that was the bug.
    for (const stick of [UP, RIGHT, { sx: 0.6, sy: 0.4 }]) {
      const court = move(stick.sx, stick.sy, "court");
      const side = move(stick.sx, stick.sy, "side");
      expect(side).not.toEqual(court);
      // A rotation preserves length: neither view may be stronger than the other.
      expect(Math.hypot(side.moveX, side.moveZ)).toBeCloseTo(
        Math.hypot(court.moveX, court.moveZ),
        6
      );
    }
  });
});

describe("looksLikeTouchDevice", () => {
  it("does not treat desktop Chrome as a phone", () => {
    // Chrome puts ontouchstart on window even with no touchscreen. That is
    // why the hosted build drew the Android stick over a USB pad. We ignore
    // ontouchstart; zero touch points and a fine pointer is a desktop.
    expect(
      looksLikeTouchDevice({ maxTouchPoints: 0, coarsePointer: false })
    ).toBe(false);
  });

  it("treats a phone as touch", () => {
    expect(
      looksLikeTouchDevice({ maxTouchPoints: 5, coarsePointer: true })
    ).toBe(true);
  });

  it("does not draw the overlay on a touchscreen laptop with a mouse", () => {
    // maxTouchPoints > 0 but the primary pointer is still a mouse: a keyboard
    // and pad machine, same as the desktop case the overlay was blocking.
    expect(
      looksLikeTouchDevice({ maxTouchPoints: 10, coarsePointer: false })
    ).toBe(false);
  });
});

describe("what a press carries", () => {
  it("keeps the tier and the arc only while a press is waiting", () => {
    // Same rule as the power beside them: these describe a particular kick, so
    // a frame with no press must not leave them lying around for the next one.
    const latch = newLatch();

    latchInput(latch, sample({ strikeTaps: 3, strikeLoft: 1.6 }));

    expect(latch.strikeTaps).toBeUndefined();
    expect(latch.strikeLoft).toBeUndefined();
  });

  it("carries them with the press they arrived on", () => {
    const latch = newLatch();

    latchInput(latch, sample({ strikePressed: true, strikeTaps: 2, strikeLoft: 1.4 }));

    expect(latch.strikeTaps).toBe(2);
    expect(latch.strikeLoft).toBe(1.4);
  });

  it("clears them when the step spends the press", () => {
    const latch = newLatch();
    latchInput(latch, sample({ strikePressed: true, strikeTaps: 2, strikeLoft: 1.4 }));

    const spent = consumeInput(latch);

    expect(spent.strikeTaps).toBe(2);
    expect(latch.strikeTaps).toBeUndefined();
    expect(latch.strikeLoft).toBeUndefined();
  });

  it("tracks the sequence in progress as a level, not a press", () => {
    // The HUD reads these every frame; they are what is being built, not what
    // was spent, so they follow the newest sample like the axes do.
    const latch = newLatch();

    latchInput(latch, sample({ strikeTapsSoFar: 2, strikeHoldSoFar: 0.3 }));
    expect(latch.strikeTapsSoFar).toBe(2);

    latchInput(latch, sample({ strikeTapsSoFar: 0, strikeHoldSoFar: 0 }));
    expect(latch.strikeTapsSoFar).toBe(0);
  });
});
