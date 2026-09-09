import { describe, expect, it } from "vitest";
import type { InputState } from "../src/input";
import type { MatchEvent } from "../src/match";
import { PracticeCoach, type DrillStep } from "../src/practice";

/**
 * The coached lesson, driven the way a player drives it.
 *
 * Worth testing as a whole rather than step by step: every step here advances
 * on a different signal — a serve, a touch, standing somewhere, holding a
 * direction — and the failure that matters is not a wrong condition but a
 * *missing* one. A step nobody can leave looks perfectly fine in isolation and
 * traps every new player on their first launch, which is exactly what `watch`
 * did.
 */

/** Just the parts of the controller the coach reads. */
function fakeMatch(): {
  controller: ConstructorParameters<typeof PracticeCoach>[0];
  emit: (event: MatchEvent) => void;
  setX: (x: number) => void;
  frozen: () => boolean;
} {
  const listeners = new Set<(e: MatchEvent) => void>();
  let frozen = false;
  const player = { position: { x: 0 } };
  const controller = {
    state: "rally",
    chars: { player, ai: player },
    subscribe: (fn: (e: MatchEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setTutorialFrozen: (value: boolean) => {
      frozen = value;
    },
  };
  return {
    controller: controller as unknown as ConstructorParameters<typeof PracticeCoach>[0],
    emit: (event) => listeners.forEach((fn) => fn(event)),
    setX: (x) => {
      player.position.x = x;
    },
    frozen: () => frozen,
  };
}

function fakeUi() {
  return {
    practicePanel: () => {},
    showTrainingPause: () => {},
    hideTrainingPause: () => {},
  };
}

const CONFIRM: InputState = { moveX: 0, moveZ: 0, confirmPressed: true } as InputState;

/** Get past the pause the coach opens whenever the ball becomes ours. */
function resume(coach: PracticeCoach): void {
  // The resume guard eats the first frames so a continue press cannot become a
  // kick; the player simply presses again, which is what this does.
  for (let i = 0; i < 4 && coach.isPaused; i++) coach.updatePaused(CONFIRM);
}

function stepOf(coach: PracticeCoach): DrillStep {
  return (coach as unknown as { step: DrillStep }).step;
}

describe("the coached lesson", () => {
  it("can be finished in three streamlined steps", () => {
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();

    // 1. SERVE — aim and serve.
    match.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    expect(stepOf(coach)).toBe("serve");
    match.emit({ type: "serve-committed", side: "player" });
    expect(stepOf(coach)).toBe("defend");

    // 2. DEFEND — receive/pop the ball.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "pop" });
    expect(stepOf(coach)).toBe("attack");

    // 3. ATTACK — step in and smash.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "strike" });

    // Completed -> free play
    expect(stepOf(coach)).toBe("free");
    expect(coach.isFinished).toBe(true);
  });

  it("can be skipped immediately at any time", () => {
    const match = fakeMatch();
    let skipped = false;
    const coach = new PracticeCoach(
      match.controller,
      fakeUi(),
      () => false,
      () => false,
      () => false,
      () => {
        skipped = true;
      }
    );
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    expect(coach.isPaused).toBe(true);

    coach.skip();

    expect(coach.isFinished).toBe(true);
    expect(coach.isPaused).toBe(false);
    expect(skipped).toBe(true);
    expect(match.frozen()).toBe(false);
  });

  it("ignores the opponent's touches", () => {
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    match.emit({ type: "serve-committed", side: "player" });
    expect(stepOf(coach)).toBe("defend");

    match.emit({ type: "touch-committed", side: "ai", action: "strike" });

    expect(stepOf(coach)).toBe("defend");
  });

  it("unfreezes the world when the lesson is torn down", () => {
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    expect(match.frozen()).toBe(true);

    coach.dispose();

    expect(match.frozen()).toBe(false);
  });
});
