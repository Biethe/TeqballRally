import { describe, expect, it } from "vitest";
import { consumeInput, latchInput, newLatch, type InputState } from "../src/input";

const sample = (over: Partial<InputState> = {}): InputState => ({
  moveX: 0,
  moveZ: 0,
  strikePressed: false,
  strikeHeld: false,
  strikePower: 0,
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
