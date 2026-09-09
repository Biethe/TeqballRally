import { describe, expect, it } from "vitest";
import { assistStrength, leashPush, nearAnchorPush, reachSlack } from "../src/character";
import {
  ANCHOR_STEP_BACK,
  AUTO_RECEPTION_REACH,
  AUTO_RUN,
  LUNGE_MAX,
  PLAYER_REACH,
  REACH_ASSIST,
  RECEPTION_ZONE,
} from "../src/config";

/** A player's top speed, in m/s, for the leash term. */
const SPEED = 4.5;

/** How much of a requested push survives, as a fraction of what was asked for. */
const kept = (dist: number, mx: number, mz: number): number => {
  const [ox, oz] = nearAnchorPush(dist, 0, mx, mz, SPEED);
  return Math.hypot(ox, oz) / Math.hypot(mx, mz);
};

describe("the room a player has around the ball", () => {
  it("does not touch the controls inside the zone", () => {
    // The metre and a half around the contact point is where every decision
    // worth making about a touch is made — which side of the ball to stand,
    // how square to be, how far to let it drop. Nothing may interfere with it.
    for (const d of [0, 0.5, 1, RECEPTION_ZONE.radius]) {
      expect(nearAnchorPush(d, 0, -1, 0, SPEED), `${d}`).toEqual([-1, 0]);
      expect(nearAnchorPush(d, 0, 0.4, -0.9, SPEED), `${d}`).toEqual([0.4, -0.9]);
    }
  });

  it("damps a push away from the ball once outside it, more the further out", () => {
    const edge = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 0.25;
    const mid = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 0.6;
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft;

    // Pushing away from an anchor that lies at +x means pushing toward -x.
    expect(kept(edge, -1, 0)).toBeLessThan(1);
    expect(kept(mid, -1, 0)).toBeLessThan(kept(edge, -1, 0));
    expect(kept(far, -1, 0)).toBeLessThan(kept(mid, -1, 0));
  });

  it("never blocks the way back to the ball", () => {
    for (const d of [2, 3, 6, 12]) {
      const [ox] = nearAnchorPush(d, 0, 1, 0, SPEED);
      expect(ox, `${d}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves sideways adjustment completely alone", () => {
    // Circling the contact point to change which foot takes the ball is the
    // adjustment the zone exists to protect, not the one it exists to stop —
    // and on this game's stick it is also how the coming touch is aimed, so
    // not one bit of it may be taken away.
    const [ox, oz] = nearAnchorPush(RECEPTION_ZONE.radius + RECEPTION_ZONE.soft, 0, 0, 1, SPEED);

    expect(oz).toBe(1);
    // Going sideways is not going away, so the leash is untouched by it: the
    // player still closes on the ball while they choose their side of it.
    expect(ox).toBeGreaterThan(0);
  });

  it("is a soft boundary, not a wall", () => {
    // A player who means to leave still leaves. What they can no longer do is
    // drift out of a reception they had already started.
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 2;
    const [ox] = nearAnchorPush(far, 0, -1, 0, SPEED);

    expect(ox).toBeLessThan(0);
  });

  it("walks an idle player back, further out the harder", () => {
    // Standing still inside the zone is standing still. Outside it, a player
    // who has let go of the controls drifts back toward the ball instead of
    // watching it land two paces away.
    const near = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 0.3;
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 1.5;

    expect(nearAnchorPush(RECEPTION_ZONE.radius, 0, 0, 0, SPEED)).toEqual([0, 0]);
    expect(nearAnchorPush(near, 0, 0, 0, SPEED)[0]).toBeGreaterThan(0);
    expect(nearAnchorPush(far, 0, 0, 0, SPEED)[0]).toBeGreaterThan(
      nearAnchorPush(near, 0, 0, 0, SPEED)[0]
    );
  });

  it("fades the leash out as the player pushes away", () => {
    // A leash a player cannot push against is a movement lock with extra
    // steps. At a full push away it is not there at all, so leaving is always
    // a decision they can make — it is only ever using the room they are not.
    //
    // Measured against a push *away* rather than any push at all: the stick
    // also aims the coming touch, and a leash that faded on a sideways hold
    // would quietly cancel the help needed to reach the ball and play it.
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 2;
    // The leash on its own: the same push with the assist switched off keeps
    // the damping and drops the pull, so the difference is the pull alone.
    const leash = (mx: number): number =>
      nearAnchorPush(far, 0, mx, 0, SPEED)[0] - nearAnchorPush(far, 0, mx, 0, SPEED, 0)[0];
    const idle = leash(0);
    const half = leash(-0.5);
    const full = leash(-1);

    expect(idle).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(0);
    expect(full).toBe(0);
    // And it can never out-run the player it is helping: the assist closes a
    // gap, it does not carry anybody faster than their own legs would.
    expect(RECEPTION_ZONE.leash).toBeLessThan(SPEED);
  });

  it("keeps the free zone inside what a player can actually reach from", () => {
    // The property that makes the zone a promise rather than a decoration: a
    // ball dropping at the anchor is playable from anywhere inside it, so
    // moving freely can never cost a reception that was there to be made.
    expect(RECEPTION_ZONE.radius).toBeLessThan(PLAYER_REACH + LUNGE_MAX);
    // And the promise made literal. The anchor stands `ANCHOR_STEP_BACK`
    // behind the drop, so the ball is always that much further away than the
    // anchor is: a free radius wider than the reach less that step would open
    // a band where the player is told their feet are their own and then cannot
    // reach the ball from where they stood, which is exactly how an idle
    // player was left watching a reception that was theirs to make.
    expect(RECEPTION_ZONE.radius + ANCHOR_STEP_BACK).toBeLessThanOrEqual(AUTO_RECEPTION_REACH);
  });

  it("releases the locked run inside playing reach of the drop", () => {
    // The run to the ball releases at `AUTO_RUN.arrive`; if a ball at the
    // anchor were playable only from further away, the release would strand
    // the player outside their own reception.
    expect(AUTO_RUN.arrive).toBeLessThan(PLAYER_REACH);
    // And the re-engage distance is a true hysteresis: the anchor has to move
    // further than the arrival covers before the run picks back up.
    expect(AUTO_RUN.reengage).toBeGreaterThan(AUTO_RUN.arrive);
    // The re-engage band is still inside reach, so a run that picks back up
    // was never a run the player could have stood still through.
    expect(AUTO_RUN.reengage).toBeLessThan(PLAYER_REACH);
  });

  it("shapes the run rather than moving the player", () => {
    // Everything here is a direction handed back to the same eased `move` the
    // player's own controls use, so the run keeps its weight and the
    // locomotion blend keeps its footing. A magnitude above 1 would be a
    // sprint nobody asked for.
    for (let d = 0; d < 8; d += 0.25) {
      for (const [mx, mz] of [[-1, 0], [0, 0], [0.3, -0.6], [-0.7, 0.7]]) {
        const [ox, oz] = nearAnchorPush(d, 0, mx, mz, SPEED);
        expect(Math.hypot(ox, oz), `${d}`).toBeLessThanOrEqual(
          Math.hypot(mx, mz) + RECEPTION_ZONE.leash / SPEED + 1e-9
        );
      }
    }
  });
});

describe("how much help the clock has earned", () => {
  const SPEED_ = 4.5;

  it("gives nothing away once the ball is winning the race", () => {
    // Three metres to cover in a tenth of a second is not a reception the
    // player missed, it is a shot that beat them — and a well-placed shot has
    // to be able to win the point.
    expect(reachSlack(3, 0.1, SPEED_)).toBeLessThan(0);
    expect(assistStrength(reachSlack(3, 0.1, SPEED_))).toBe(0);
  });

  it("counts the ground and the clock together, not either alone", () => {
    // The same distance is reachable off a lofted ball and hopeless off a
    // driven one. That distinction is the whole reason this is a time.
    expect(assistStrength(reachSlack(2, 1.2, SPEED_))).toBeGreaterThan(0);
    expect(assistStrength(reachSlack(2, 0.3, SPEED_))).toBe(0);
    // And the same clock is generous up close and hopeless far away.
    expect(assistStrength(reachSlack(0.5, 0.5, SPEED_))).toBeGreaterThan(0);
    expect(assistStrength(reachSlack(6, 0.5, SPEED_))).toBe(0);
  });

  it("fades in rather than switching on at a line", () => {
    // A cliff would be felt as the assist grabbing the player. Spare time has
    // to buy help smoothly or the boundary becomes the thing they learn.
    let prev = 0;
    for (let slack = 0; slack <= REACH_ASSIST.slackFull; slack += 0.05) {
      const now = assistStrength(slack);
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
    expect(assistStrength(REACH_ASSIST.slackFull)).toBe(1);
  });

  it("never exceeds full help however long the ball hangs", () => {
    // A ball floating for three seconds must not buy a stronger pull than one
    // floating for one: past `slackFull` the player has all the time they
    // need, and more of it is not more assistance.
    for (const slack of [0.5, 1, 3, 30]) {
      expect(assistStrength(slack), `${slack}`).toBe(1);
    }
  });

  it("is what the leash is scaled by, and can switch it off entirely", () => {
    // The gate has to reach the one term that actually closes distance, or it
    // is a decoration on top of an assist that helps regardless.
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft;

    expect(nearAnchorPush(far, 0, 0, 0, SPEED, 1)[0]).toBeGreaterThan(0);
    expect(nearAnchorPush(far, 0, 0, 0, SPEED, 0)).toEqual([0, 0]);
    expect(nearAnchorPush(far, 0, 0, 0, SPEED, 0.5)[0]).toBeLessThan(
      nearAnchorPush(far, 0, 0, 0, SPEED, 1)[0]
    );
  });

  it("still damps a player walking off a reception when it has earned nothing", () => {
    // Losing the race is a reason not to be *helped* to the ball. It is not a
    // reason to be allowed to wander out of a touch already under way, so the
    // outward damping is deliberately not on the gate.
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft;
    const [ox] = nearAnchorPush(far, 0, -1, 0, SPEED, 0);

    expect(ox).toBeGreaterThan(-1);
    expect(ox).toBeLessThan(0);
  });
});

/**
 * The hard cap around your own set-up.
 *
 * A separate function from `nearAnchorPush` because it answers a different
 * question: that one governs a ball coming at you, where leaving is still a
 * decision, and this one governs a ball you put up yourself, where it is not.
 * Keeping them apart is what lets the soft zone above stay exactly as it was.
 */
describe("staying with a set-up you made yourself", () => {
  const CAP = RECEPTION_ZONE.hardCap;

  it("does not touch the controls inside the circle", () => {
    for (const d of [0, 0.2, CAP * 0.5, CAP - 1e-6]) {
      expect(leashPush(d, 0, -1, 0, CAP)).toEqual([-1, 0]);
      expect(leashPush(0, d, 0.6, -0.8, CAP)).toEqual([0.6, -0.8]);
    }
  });

  it("blocks the way out at the edge", () => {
    // Anchor is 1 m ahead in +x; the player asks to run directly away from it.
    const [mx, mz] = leashPush(1, 0, -1, 0, CAP);

    expect(mx).toBeCloseTo(0, 12);
    expect(mz).toBeCloseTo(0, 12);
  });

  it("still lets them circle the ball to choose a foot", () => {
    // Straight across the circle is untouched: picking which side of the body
    // takes the ball is the whole reason there is any room at all.
    const [mx, mz] = leashPush(1, 0, 0, 1, CAP);

    expect(mx).toBeCloseTo(0, 12);
    expect(mz).toBeCloseTo(1, 12);
  });

  it("keeps every step inward, whole", () => {
    const [mx, mz] = leashPush(1, 0, 1, 0, CAP);

    expect(mx).toBeCloseTo(1, 12);
    expect(mz).toBeCloseTo(0, 12);
  });

  it("never returns a longer push than it was given", () => {
    // It removes a component and never adds one, so nobody is ever moved
    // faster — let alone somewhere — by being leashed.
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      for (const d of [CAP, CAP + 0.4, CAP + 2]) {
        const [mx, mz] = leashPush(d, 0, Math.cos(a), Math.sin(a), CAP);

        expect(Math.hypot(mx, mz)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("keeps the ball reachable from anywhere in the circle", () => {
    // A ball landing on the anchor has to be playable from the edge, or the
    // cap would be a way to lose the point rather than a way to stay with it.
    expect(CAP).toBeLessThan(PLAYER_REACH);
  });

  it("is tighter than the zone for a ball still on its way", () => {
    // The two exist to answer different phases; if this ever inverted, a
    // set-up would give a player *more* room than an incoming ball.
    expect(CAP).toBeLessThan(RECEPTION_ZONE.radius);
  });
});
