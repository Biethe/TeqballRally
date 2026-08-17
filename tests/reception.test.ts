import { describe, expect, it } from "vitest";
import { nearAnchorPush } from "../src/character";
import { AUTO_RECEPTION_REACH, LUNGE_MAX, PLAYER_REACH, RECEPTION_ZONE } from "../src/config";

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
    // adjustment the zone exists to protect, not the one it exists to stop.
    const [ox, oz] = nearAnchorPush(RECEPTION_ZONE.radius + RECEPTION_ZONE.soft, 0, 0, 1, SPEED);

    expect(oz).toBe(1);
    expect(ox).toBe(0);
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

  it("fades the leash out as the player takes over", () => {
    // A leash a player cannot push against is a movement lock with extra
    // steps. At full stick it is not there at all; it is only ever using the
    // room the player is not.
    const far = RECEPTION_ZONE.radius + RECEPTION_ZONE.soft * 2;
    const idle = nearAnchorPush(far, 0, 0, 0, SPEED)[0];
    const half = nearAnchorPush(far, 0, 0, 0.5, SPEED)[0];
    const full = nearAnchorPush(far, 0, 0, 1, SPEED)[0];

    expect(idle).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(0);
    expect(full).toBe(0);
    expect(RECEPTION_ZONE.leash).toBeLessThan(SPEED * 0.5);
  });

  it("keeps the free zone inside what a player can actually reach from", () => {
    // The property that makes the zone a promise rather than a decoration: a
    // ball dropping at the anchor is playable from anywhere inside it, so
    // moving freely can never cost a reception that was there to be made.
    expect(RECEPTION_ZONE.radius).toBeLessThan(PLAYER_REACH + LUNGE_MAX);
    // And wide enough to be worth having: further than the vicinity an
    // automatic first reception is granted from.
    expect(RECEPTION_ZONE.radius).toBeGreaterThan(AUTO_RECEPTION_REACH);
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
