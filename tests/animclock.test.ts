import { describe, expect, it } from "vitest";
import { advanceLoop, clipFractionAt, clipFrameAt, rebaseClip, type ClockedClip } from "../src/animclock";

const kick: ClockedClip = { startTick: 100, startFrame: 20, speed: 1.3, from: 0, to: 120, loop: false };

describe("a clip placed on the simulation clock", () => {
  it("is a start, a frame and a rate: the frame at any tick is arithmetic", () => {
    expect(clipFrameAt(kick, 100)).toEqual({ frame: 20, ended: false });
    expect(clipFrameAt(kick, 110).frame).toBeCloseTo(33, 9);
    // Asked before its start it is simply earlier in the clip — but never
    // before the clip's own first frame.
    expect(clipFrameAt(kick, 90).frame).toBeCloseTo(20 - 13, 9);
    expect(clipFrameAt({ ...kick, startFrame: 0 }, 90).frame).toBe(0);
  });

  it("ends when it reaches its last frame, and stays there", () => {
    const end = 100 + (120 - 20) / 1.3;
    expect(clipFrameAt(kick, end - 0.01).ended).toBe(false);
    expect(clipFrameAt(kick, end)).toEqual({ frame: 120, ended: true });
    expect(clipFrameAt(kick, end + 50)).toEqual({ frame: 120, ended: true });
    expect(clipFractionAt(kick, end + 50)).toBe(1);
  });

  it("is the same frame whenever it is asked, which is what lets two screens agree", () => {
    // A guest that starts the clip late asks for a later tick and gets the
    // host's frame for that tick: there is nothing to hurry or skip.
    const late = clipFrameAt(kick, 107.5).frame;
    expect(late).toBeCloseTo(20 + 7.5 * 1.3, 9);
  });

  it("wraps a loop into its range, in both directions", () => {
    const jog: ClockedClip = { startTick: 0, startFrame: 10, speed: 1, from: 10, to: 40, loop: true };
    expect(clipFrameAt(jog, 35).frame).toBeCloseTo(15, 9);
    expect(clipFrameAt(jog, -5).frame).toBeCloseTo(35, 9);
    expect(clipFrameAt(jog, 1000).ended).toBe(false);
  });

  it("changes rate without jumping the pose", () => {
    const at = 110;
    const faster = rebaseClip(kick, at, 2);
    expect(clipFrameAt(faster, at).frame).toBeCloseTo(clipFrameAt(kick, at).frame, 9);
    expect(clipFrameAt(faster, at + 5).frame).toBeCloseTo(clipFrameAt(kick, at).frame + 10, 9);
  });

  it("advances locomotion by game time, wrapped", () => {
    // Half a second at rate 1 is thirty frames, and a thirty-frame loop is back
    // where it began.
    expect(advanceLoop(12, 10, 40, 0.5, 1)).toBeCloseTo(12, 9);
    expect(advanceLoop(12, 10, 40, 0.25, 1)).toBeCloseTo(27, 9);
    expect(advanceLoop(12, 10, 40, 0.25, 2)).toBeCloseTo(12, 9);
  });
});
