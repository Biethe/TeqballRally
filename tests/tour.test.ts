import { describe, expect, it } from "vitest";
import { TOUR, Tour, stepDone, type TourFacts } from "../src/tour";

/**
 * The guided tour of the app.
 *
 * What is worth pinning is not the copy but the rule underneath it: every step
 * is finished by the player doing the thing, and a step they have already
 * satisfied is never demanded of them. Both are properties of the step list
 * and the facts, which is why they live apart from the UI and can be checked
 * without a browser.
 */

const NOTHING: TourFacts = {
  kitName: "",
  kitNumber: "",
  kitCrest: "none",
  hasProfile: false,
  changedSetting: false,
  portrait: true,
};

describe("what finishes a step", () => {
  const step = (goal: string) => TOUR.find((s) => s.goal === goal)!;

  it("ends the kit step on a name being written, not on it being opened", () => {
    expect(stepDone(step("kit"), NOTHING, true)).toBe(false);
    expect(stepDone(step("kit"), { ...NOTHING, kitName: "  " }, true)).toBe(false);
    expect(stepDone(step("kit"), { ...NOTHING, kitName: "ANA" }, true)).toBe(true);
  });

  it("ends the profile step on there being an account", () => {
    expect(stepDone(step("profile"), NOTHING, true)).toBe(false);
    expect(stepDone(step("profile"), { ...NOTHING, hasProfile: true }, true)).toBe(true);
  });

  it("ends the marks step on a number or a crest, either one", () => {
    // Either. Demanding both would be the tour deciding how somebody's shirt
    // ought to look, which is not what this step is teaching.
    expect(stepDone(step("marks"), NOTHING, true)).toBe(false);
    expect(stepDone(step("marks"), { ...NOTHING, kitNumber: "9" }, true)).toBe(true);
    expect(stepDone(step("marks"), { ...NOTHING, kitCrest: "star" }, true)).toBe(true);
    expect(stepDone(step("marks"), { ...NOTHING, kitNumber: "  " }, true)).toBe(false);
  });

  it("ends the settings step on something actually changing", () => {
    expect(stepDone(step("settings"), NOTHING, true)).toBe(false);
    expect(stepDone(step("settings"), { ...NOTHING, changedSetting: true }, true)).toBe(true);
  });

  it("ends the tilt step on the phone being turned, whichever way it started", () => {
    // Not "be in landscape": a tour that insists on one orientation cannot be
    // finished by somebody whose phone is already there, and what is worth
    // learning is that turning it does something at all.
    expect(stepDone(step("tilt"), { ...NOTHING, portrait: true }, true)).toBe(false);
    expect(stepDone(step("tilt"), { ...NOTHING, portrait: false }, true)).toBe(true);
    expect(stepDone(step("tilt"), { ...NOTHING, portrait: false }, false)).toBe(false);
    expect(stepDone(step("tilt"), { ...NOTHING, portrait: true }, false)).toBe(true);
  });
});

describe("running the tour", () => {
  it("starts on the first thing the player has not done", () => {
    const tour = new Tour(true);
    expect(tour.current(NOTHING)?.goal).toBe("profile");
  });

  it("moves on the moment a step is satisfied", () => {
    const tour = new Tour(true);
    expect(tour.current(NOTHING)?.goal).toBe("profile");
    expect(tour.current({ ...NOTHING, hasProfile: true })?.goal).toBe("kit");
  });

  it("never asks for something already done", () => {
    // Somebody who made a profile and named their shirt before opening this
    // has learnt what those steps teach. Demanding them anyway is the tour
    // failing to notice the player.
    const tour = new Tour(true);
    const ahead = { ...NOTHING, hasProfile: true, kitName: "ANA", kitCrest: "star" };

    expect(tour.current(ahead)?.goal).toBe("settings");
  });

  it("ends after the last step rather than sticking on it", () => {
    const tour = new Tour(true);
    const doneButUpright: TourFacts = {
      ...NOTHING,
      kitName: "ANA",
      kitNumber: "9",
      hasProfile: true,
      changedSetting: true,
      portrait: true,
    };

    // Everything but the phone. The tilt step is where they are.
    expect(tour.current(doneButUpright)?.goal).toBe("tilt");

    // And then they turn it.
    expect(tour.current({ ...doneButUpright, portrait: false })).toBeNull();
    expect(tour.finished).toBe(true);
  });

  it("measures the tilt from where the phone was when that step began", () => {
    // Not from where it was when the tour opened. Somebody who turns their
    // phone while writing their name would otherwise arrive at the last step
    // with it already counted, and the tour would end without once asking them
    // to do the thing it exists to teach.
    const tour = new Tour(true);
    const turnedEarly: TourFacts = {
      ...NOTHING,
      kitName: "ANA",
      kitNumber: "9",
      hasProfile: true,
      changedSetting: true,
      portrait: false,
    };

    expect(tour.current(turnedEarly)?.goal).toBe("tilt");
    expect(tour.current(turnedEarly)?.goal).toBe("tilt");
    expect(tour.current({ ...turnedEarly, portrait: true })).toBeNull();
  });

  it("says it has arrived once per step, not once per look", () => {
    // The caller navigates on this, and it is polled several times a second.
    // Reporting arrival every time would reopen the screen under the player
    // for as long as the step lasted.
    const tour = new Tour(true);

    expect(tour.current(NOTHING)?.goal).toBe("profile");
    expect(tour.takeArrival()).toBe(true);
    expect(tour.takeArrival()).toBe(false);

    expect(tour.current({ ...NOTHING, hasProfile: true })?.goal).toBe("kit");
    expect(tour.takeArrival()).toBe(true);
    expect(tour.takeArrival()).toBe(false);
  });

  it("can be abandoned, and stays abandoned", () => {
    const tour = new Tour(true);
    tour.abandon();

    expect(tour.current(NOTHING)).toBeNull();
    expect(tour.finished).toBe(true);
  });

  it("counts its steps from one, and never past the end", () => {
    const tour = new Tour(true);
    expect(tour.progress()).toEqual({ step: 1, of: TOUR.length });
    tour.current({
      ...NOTHING,
      kitName: "A",
      kitNumber: "9",
      hasProfile: true,
      changedSetting: true,
      portrait: false,
    });
    expect(tour.progress().step).toBe(TOUR.length);
  });

  it("points every step at something, or at nothing on purpose", () => {
    // The tilt step has no element to ring — it is about the device itself,
    // and about the court it is held over.
    for (const step of TOUR) {
      if (step.goal === "tilt") {
        expect(step.target).toBe("");
        expect(step.screen).toBe("court");
      } else {
        expect(step.target.length).toBeGreaterThan(0);
      }
    }
  });

  it("finishes on the court, and gets there last", () => {
    // The controls change with the orientation, and that cannot be shown on a
    // menu. It is also the one step that interrupts, so it goes at the end.
    expect(TOUR[TOUR.length - 1].goal).toBe("tilt");
    expect(TOUR.filter((s) => s.screen === "court")).toHaveLength(1);
  });
});
