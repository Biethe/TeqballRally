import { describe, expect, it } from "vitest";
import {
  AFFINITY_BONUS,
  BALLS,
  BALL_AFFINITY,
  CHARACTERS,
  ballFor,
  withBall,
} from "../src/config";

/**
 * Balls, and what holding one does to a player.
 *
 * Two things here are easy to get wrong and invisible when they are: a ball
 * that is better at everything makes the choice a formality, and an affinity
 * that also amplifies a ball's downside quietly punishes the player it was
 * meant to reward.
 */

const brazil = CHARACTERS.find((c) => c.id === "BrazilianPlayer")!;
const england = CHARACTERS.find((c) => c.id === "EnglishPlayer")!;

describe("the ball roster", () => {
  it("gives one away for free", () => {
    // A locked default is a game that cannot be started.
    expect(BALLS.filter((b) => b.unlockAt === 0).length).toBeGreaterThan(0);
    expect(BALLS[0].unlockAt).toBe(0);
  });

  it("makes every ball a trade rather than an upgrade", () => {
    // The failure mode of every equipment system: one item that is simply best,
    // after which the other three are decoration.
    for (const ball of BALLS) {
      const values = Object.values(ball.mods);
      if (values.length === 0) continue; // the plain one is allowed to be plain
      expect(values.some((m) => m > 1), `${ball.id} gives nothing`).toBe(true);
      expect(values.some((m) => m < 1), `${ball.id} costs nothing`).toBe(true);
    }
  });

  it("points every character at a ball that exists", () => {
    for (const [id, ballId] of Object.entries(BALL_AFFINITY)) {
      expect(CHARACTERS.map((c) => c.id), `${id} is not on the roster`).toContain(id);
      expect(BALLS.map((b) => b.id), `${ballId} is not a ball`).toContain(ballId);
    }
  });

  it("falls back to the free ball for an unknown id", () => {
    // Saved state outlives a roster change, and a stored ball that no longer
    // exists must not take the match down with it.
    expect(ballFor("SomeBallWeDeleted").id).toBe(BALLS[0].id);
  });
});

describe("holding a ball", () => {
  it("leaves the plain ball's owner exactly as they were", () => {
    const plain = ballFor("RedBall");
    const held = withBall(england, plain);

    expect(held.power).toBe(england.power);
    expect(held.precision).toBe(england.precision);
  });

  it("applies the ball's trade to anyone", () => {
    const hammer = ballFor("OrangeAndBlackBall");
    const held = withBall(brazil, hammer);

    expect(held.power).toBeGreaterThan(brazil.power);
    expect(held.precision).toBeLessThan(brazil.precision);
  });

  it("gives more to the player the ball suits", () => {
    const hammer = ballFor("OrangeAndBlackBall");
    // England is the one this ball is for.
    expect(BALL_AFFINITY.EnglishPlayer).toBe("OrangeAndBlackBall");

    const theirGain = withBall(england, hammer).power / england.power;
    const otherGain = withBall(brazil, hammer).power / brazil.power;

    expect(theirGain).toBeGreaterThan(otherGain);
    expect(theirGain - 1).toBeCloseTo((otherGain - 1) * AFFINITY_BONUS, 6);
  });

  it("does not deepen the trade for the player it suits", () => {
    // Affinity is a reward. Amplifying the downside too would make a ball
    // somebody suits something they have to think twice about.
    const hammer = ballFor("OrangeAndBlackBall");

    const theirLoss = withBall(england, hammer).precision / england.precision;
    const otherLoss = withBall(brazil, hammer).precision / brazil.precision;

    expect(theirLoss).toBeCloseTo(otherLoss, 6);
  });

  it("never touches a trait the ball says nothing about", () => {
    const control = ballFor("BlueBall");
    const held = withBall(brazil, control);

    expect(held.speed).toBe(brazil.speed);
    expect(held.volley).toBe(brazil.volley);
    expect(held.serve).toBe(brazil.serve);
  });

  it("keeps the identity of the player holding it", () => {
    // Downstream code looks players up by id and draws them by label.
    const held = withBall(brazil, ballFor("OrangeAndBlackBall"));

    expect(held.id).toBe(brazil.id);
    expect(held.label).toBe(brazil.label);
    expect(held.strongFoot).toBe(brazil.strongFoot);
  });
});
