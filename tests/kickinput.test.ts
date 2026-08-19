import { describe, expect, it } from "vitest";
import {
  KICK_INPUT,
  kickDown,
  kickHeldFor,
  kickLoft,
  kickPower,
  kickTick,
  kickUp,
  type KickCommit,
  type KickSequence,
} from "../src/kickinput";
import { SWIPE_LOFT } from "../src/aim";

/**
 * Time is always injected, never read.
 *
 * The whole module exists to survive a phone that delivers two presses 140 ms
 * apart to handlers half a second apart, so a test that used the wall clock
 * would be testing the machine it is meant to be independent of.
 */
const TAP = 0.05;
const HOLD = KICK_INPUT.hold + 0.01;

/** Drive a whole press sequence and return whatever it committed. */
function play(presses: { at: number; forSec: number }[], until?: number): KickCommit | null {
  let seq: KickSequence | null = null;
  let commit: KickCommit | null = null;
  for (const p of presses) {
    seq = kickDown(seq, p.at);
    const up = kickUp(seq, p.at + p.forSec);
    seq = up.seq;
    if (up.commit) commit = up.commit;
  }
  const last = presses[presses.length - 1];
  const t = until ?? last.at + last.forSec + KICK_INPUT.tapWindow + 1e-6;
  const tick = kickTick(seq, t);
  if (tick.commit) commit = tick.commit;
  return commit;
}

describe("counting taps", () => {
  it("reads one, two and three taps as three different speeds", () => {
    const one = play([{ at: 0, forSec: TAP }]);
    const two = play([
      { at: 0, forSec: TAP },
      { at: 0.1, forSec: TAP },
    ]);
    const three = play([
      { at: 0, forSec: TAP },
      { at: 0.1, forSec: TAP },
      { at: 0.2, forSec: TAP },
    ]);

    expect([one?.taps, two?.taps, three?.taps]).toEqual([1, 2, 3]);
    expect(one!.power).toBeLessThan(two!.power);
    expect(two!.power).toBeLessThan(three!.power);
  });

  it("starts a new shot when the presses are too far apart", () => {
    // Two deliberate kicks, not a double tap. Without this every press in a
    // rally would keep climbing tiers.
    const gap = KICK_INPUT.tapWindow + 0.05;
    const late = play([
      { at: 0, forSec: TAP },
      { at: TAP + gap, forSec: TAP },
    ]);

    expect(late?.taps).toBe(1);
  });

  it("cannot be pushed past the top tier", () => {
    // The third tap has already committed by the time a fourth arrives, so a
    // fourth press is a new kick rather than a fourth tier — there is nowhere
    // for an extra tap to go.
    let seq: KickSequence | null = null;
    const commits: KickCommit[] = [];
    for (const at of [0, 0.08, 0.16, 0.24]) {
      seq = kickDown(seq, at);
      const up = kickUp(seq, at + TAP);
      seq = up.seq;
      if (up.commit) commits.push(up.commit);
    }

    expect(commits.map((c) => c.taps)).toEqual([KICK_INPUT.maxTaps]);
    expect(commits[0].power).toBe(kickPower(KICK_INPUT.maxTaps));
    expect(seq?.taps).toBe(1);
  });
});

describe("when the kick commits", () => {
  it("fires the instant a held press is released", () => {
    // No window at all: the player has already said when.
    const seq = kickDown(null, 0);
    const up = kickUp(seq, HOLD);

    expect(up.commit).not.toBeNull();
    expect(up.seq).toBeNull();
  });

  it("fires the instant the third tap is released", () => {
    // The hard flat shot is the one whose timing matters most, so it is the
    // one that never waits.
    let seq: KickSequence | null = null;
    seq = kickDown(seq, 0);
    seq = kickUp(seq, TAP).seq;
    seq = kickDown(seq, 0.1);
    seq = kickUp(seq, 0.1 + TAP).seq;
    seq = kickDown(seq, 0.2);
    const up = kickUp(seq, 0.2 + TAP);

    expect(up.commit?.taps).toBe(3);
    expect(up.seq).toBeNull();
  });

  it("makes a single tap wait, but only for the window", () => {
    const seq = kickUp(kickDown(null, 0), TAP).seq;

    expect(kickTick(seq, TAP + KICK_INPUT.tapWindow - 0.01).commit).toBeNull();
    expect(kickTick(seq, TAP + KICK_INPUT.tapWindow + 0.01).commit?.taps).toBe(1);
  });

  it("does not commit twice", () => {
    const up = kickUp(kickDown(null, 0), HOLD);

    expect(kickTick(up.seq, 10).commit).toBeNull();
  });

  it("drops a sequence that is thrown away mid-press", () => {
    // What a blur or an orientation change does: the machine is handed null and
    // nothing is kicked. A half-finished press must never become a shot.
    const seq = kickDown(null, 0);

    expect(seq.taps).toBe(1);
    expect(kickTick(null, 100).commit).toBeNull();
  });
});

describe("the arc a hold asks for", () => {
  it("leaves a tapped kick exactly neutral", () => {
    // The property that makes this landable: 1 is what the landscape path has
    // always passed, so every existing tapped shot comes out unchanged.
    for (const taps of [1, 2, 3]) {
      const presses = Array.from({ length: taps }, (_, i) => ({ at: i * 0.08, forSec: TAP }));

      expect(play(presses)?.loft).toBe(1);
    }
  });

  it("climbs with the length of the last hold", () => {
    const brief = kickLoft(KICK_INPUT.hold + 0.05);
    const long = kickLoft(KICK_INPUT.hold + KICK_INPUT.loftRamp);

    expect(brief).toBeGreaterThan(1);
    expect(long).toBeGreaterThan(brief);
  });

  it("is read off the last press, not the first", () => {
    // Holding press #1 is how a player aims; only the final press shapes the
    // ball. Two taps then a hold is a lofted medium ball.
    const lofted = play([
      { at: 0, forSec: 0.6 },
      { at: 0.7, forSec: TAP },
      { at: 0.78, forSec: HOLD },
    ]);

    expect(lofted?.taps).toBe(2);
    expect(lofted?.loft).toBeGreaterThan(1);
  });

  it("eases across the threshold rather than stepping", () => {
    // A jump here would be felt as the arc snapping mid-press.
    expect(kickLoft(KICK_INPUT.hold)).toBe(1);
    expect(kickLoft(KICK_INPUT.hold + 1e-4)).toBeCloseTo(1, 5);
  });

  it("never asks for more than a swipe can", () => {
    // Both schemes have to reach the same lob, or one of them is playing a
    // different game.
    expect(kickLoft(10)).toBeCloseTo(SWIPE_LOFT.high, 9);
  });

  it("tops out and stays there", () => {
    expect(kickLoft(100)).toBe(kickLoft(KICK_INPUT.hold + KICK_INPUT.loftRamp));
  });
});

describe("kickHeldFor", () => {
  it("reports nothing when no press is down", () => {
    expect(kickHeldFor(null, 5)).toBe(0);
    expect(kickHeldFor(kickUp(kickDown(null, 0), TAP).seq, 5)).toBe(0);
  });

  it("grows while a press is held, for the marker to read", () => {
    const seq = kickDown(null, 1);

    expect(kickHeldFor(seq, 1.25)).toBeCloseTo(0.25, 9);
  });
});
