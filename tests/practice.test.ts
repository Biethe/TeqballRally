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

const IDLE: InputState = { moveX: 0, moveZ: 0 } as InputState;
const RUNNING: InputState = { moveX: 1, moveZ: 0 } as InputState;
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
  it("can be finished", () => {
    // The whole point: a player who does what is asked reaches the end. This
    // is the test that fails on a dead-end step, whichever step it is.
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();

    // SERVE — aim and serve.
    match.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    match.emit({ type: "serve-committed", side: "player" });

    // READ THE BALL — get a touch on what comes back.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "strike" });

    // BE THERE FIRST — cover some ground.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    for (let i = 0; i < 30; i++) coach.update(1 / 60, RUNNING);

    // AIM YOUR TOUCH — hold a direction, then pop.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    coach.update(1 / 60, RUNNING);
    match.emit({ type: "touch-committed", side: "player", action: "pop" });

    // STEP IN — stand inside smash range.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.setX(0);
    coach.update(1 / 60, IDLE);

    // STRIKE — hit one from close.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "strike" });

    // EARLY — take one before it drops.
    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "strike" });

    expect(coach.isFinished).toBe(true);
  });

  it("leaves READ THE BALL when the player plays one", () => {
    // The regression. Every other step had a way out; this one had none, so
    // the lesson sat on DEFENDING 2/6 and re-announced itself forever.
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    match.emit({ type: "serve-committed", side: "player" });
    expect(stepOf(coach)).toBe("watch");

    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "strike" });

    expect(stepOf(coach)).toBe("chase");
  });

  it("accepts a pop as reading the ball", () => {
    // A step about anticipation must not also demand a clean strike: a player
    // who pops it up has still read where it was going.
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    match.emit({ type: "serve-committed", side: "player" });

    match.emit({ type: "possession-start", side: "player" });
    resume(coach);
    match.emit({ type: "touch-committed", side: "player", action: "pop" });

    expect(stepOf(coach)).toBe("chase");
  });

  /** Drive the coach to the AIM YOUR TOUCH step and hand it back. */
  function atCraft(portrait = false): { match: ReturnType<typeof fakeMatch>; coach: PracticeCoach } {
    const m = fakeMatch();
    const coach = new PracticeCoach(m.controller, fakeUi(), () => false, () => false, () => portrait);
    coach.start();
    m.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    m.emit({ type: "serve-committed", side: "player" }); // watch
    m.emit({ type: "possession-start", side: "player" });
    resume(coach);
    m.emit({ type: "touch-committed", side: "player", action: "pop" }); // chase
    m.emit({ type: "possession-start", side: "player" });
    resume(coach);
    for (let i = 0; i < 30 && stepOf(coach) === "chase"; i++) coach.update(1 / 60, RUNNING);
    expect(stepOf(coach)).toBe("craft");
    return { match: m, coach };
  }

  it("leaves AIM YOUR TOUCH when the pop was aimed", () => {
    const { match, coach } = atCraft();

    coach.update(1 / 60, RUNNING); // hold a direction
    match.emit({ type: "touch-committed", side: "player", action: "pop" });

    expect(stepOf(coach)).toBe("stepIn");
  });

  it("holds AIM YOUR TOUCH for a pop with no direction held", () => {
    // The lesson is the aiming, not the popping: a set-up played with an idle
    // stick proves nothing about it.
    const { match, coach } = atCraft();

    coach.update(1 / 60, IDLE);
    match.emit({ type: "touch-committed", side: "player", action: "pop" });

    expect(stepOf(coach)).toBe("craft");
  });

  it("in portrait any pop aims the touch, because the tap is the aim", () => {
    const { match, coach } = atCraft(true);

    match.emit({ type: "touch-committed", side: "player", action: "pop" });

    expect(stepOf(coach)).toBe("stepIn");
  });

  it("ignores the opponent's touches", () => {
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    resume(coach);
    match.emit({ type: "serve-committed", side: "player" });

    match.emit({ type: "touch-committed", side: "ai", action: "strike" });

    expect(stepOf(coach)).toBe("watch");
  });

  it("unfreezes the world when the lesson is torn down", () => {
    // A lesson left frozen is a game that never moves again.
    const match = fakeMatch();
    const coach = new PracticeCoach(match.controller, fakeUi(), () => false, () => false);
    coach.start();
    match.emit({ type: "serve-ready", side: "player" });
    expect(match.frozen()).toBe(true);

    coach.dispose();

    expect(match.frozen()).toBe(false);
  });
});
