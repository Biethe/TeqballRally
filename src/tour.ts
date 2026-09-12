import type { StringKey } from "./i18n";

/**
 * The guided tour of the app itself.
 *
 * Not the lesson. `practice.ts` teaches the sport — where to stand, when to
 * strike — and it does that inside a rally where the ball can show you what it
 * means. This teaches the parts of the app that no rally can explain, and that
 * nobody finds by accident: that the shirt is yours to write on, that a profile
 * is what carries your trophies to the next phone, that the game plays
 * differently depending on which way up you hold it.
 *
 * Two rules shape it.
 *
 * **Every step is finished by doing the thing, never by pressing Next.** A tour
 * that advances on acknowledgement teaches somebody to tap Next four times. The
 * kit step ends when there is a name on the shirt; the tilt step ends when the
 * phone has actually been turned. What the player is left with afterwards is a
 * shirt with their name on it and the memory of having done it, rather than a
 * screen they read.
 *
 * **It points at one thing at a time.** Each step names an element on the
 * screen and a single sentence saying what to do with it. Anything longer is a
 * manual, and a manual is what this exists instead of.
 *
 * Pure, and separate from the UI, so the order of the tour and the conditions
 * that end each step can be read and tested without a browser in the room.
 */

/** What the player has to do to finish a step. */
export type TourGoal =
  /** Put a name on the shirt. */
  | "kit"
  /** Have an account. */
  | "profile"
  /** Change any gameplay setting from what it was. */
  | "settings"
  /** Turn the device to the other orientation. */
  | "tilt";

export interface TourStep {
  goal: TourGoal;
  /**
   * CSS selector for the thing being pointed at.
   *
   * A selector rather than an element, because the screens are rebuilt from
   * their markup each time they are shown — the element a step points at does
   * not exist yet when the step is written, and may be replaced while it is
   * running.
   */
  target: string;
  /** The one sentence saying what to do. */
  says: StringKey;
  /**
   * Where the step lives, so the tour can send the player there rather than
   * pointing at something no screen is currently showing.
   */
  screen: "profile" | "settings" | "kit" | "anywhere";
}

/**
 * The tour, in the order it runs.
 *
 * Profile first, because it is the only step with a consequence the player
 * cannot undo by themselves — a career built on a phone with no account is a
 * career that ends with the phone. The kit second, because it is the one that
 * is purely fun, and a tour that opens with admin and closes with admin is a
 * tour people leave. Tilt last, because it is the only one that asks them to
 * put the phone down and pick it up differently, which is a poor thing to open
 * with and a memorable thing to end on.
 */
export const TOUR: readonly TourStep[] = [
  { goal: "profile", target: "#btn-set-profile", says: "tour.profile", screen: "anywhere" },
  { goal: "kit", target: "#btn-set-kit", says: "tour.kit", screen: "anywhere" },
  { goal: "settings", target: "#btn-set-gameplay", says: "tour.settings", screen: "anywhere" },
  { goal: "tilt", target: "", says: "tour.tilt", screen: "anywhere" },
];

/** What the tour can see about the player, to know whether a step is done. */
export interface TourFacts {
  /** A name written across the shoulders of the shirt. */
  kitName: string;
  /** Whether there is an account on this device. */
  hasProfile: boolean;
  /** Whether any gameplay setting has been changed during the tour. */
  changedSetting: boolean;
  /** True when the device is being held upright. */
  portrait: boolean;
}

/** Whether the facts satisfy this step, given how the tour started. */
export function stepDone(step: TourStep, facts: TourFacts, startedPortrait: boolean): boolean {
  switch (step.goal) {
    case "kit":
      return facts.kitName.trim().length > 0;
    case "profile":
      return facts.hasProfile;
    case "settings":
      return facts.changedSetting;
    case "tilt":
      // Turned, rather than held a particular way: a tour that insists on
      // landscape is a tour that cannot be finished by somebody whose phone is
      // already there, and the thing worth learning is that turning it does
      // something at all.
      return facts.portrait !== startedPortrait;
  }
}

/**
 * How far the tour has got.
 *
 * Steps the player had already satisfied before the tour started are skipped
 * rather than demanded again: somebody who made a profile before opening this
 * has learnt what the step teaches, and being told to do it anyway is the tour
 * failing to notice them.
 */
export class Tour {
  private at = 0;
  private readonly startedPortrait: boolean;
  private done = false;

  constructor(portrait: boolean) {
    this.startedPortrait = portrait;
  }

  /** The step being shown, or null once the tour is over. */
  current(facts: TourFacts): TourStep | null {
    this.advance(facts);
    return this.done ? null : TOUR[this.at];
  }

  get finished(): boolean {
    return this.done;
  }

  /** Give up on the rest of it. */
  abandon(): void {
    this.done = true;
  }

  /** Skip over everything the player has already satisfied. */
  private advance(facts: TourFacts): void {
    while (!this.done && stepDone(TOUR[this.at], facts, this.startedPortrait)) {
      this.at++;
      if (this.at >= TOUR.length) this.done = true;
    }
  }

  /** Which step of how many, for a progress line. Both 1-based and inclusive. */
  progress(): { step: number; of: number } {
    return { step: Math.min(this.at + 1, TOUR.length), of: TOUR.length };
  }
}
