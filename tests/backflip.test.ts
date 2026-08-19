import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { STRIKE_BANDS, STRIKE_CEILING } from "../src/character";
import { CHARACTERS, GROUND_Y, SIM_DT, TABLE, tableSurfaceY } from "../src/config";
import { rig, type Rig } from "./rig";

/**
 * The flip, and how high a ball has to be for one.
 *
 * It used to fire from 0.6 of body height — below the header band — and since
 * `chooseStrike` offers it first it took nearly every set-up ball above knee
 * height. A flip met at chest height is a flat one, because the angle a ball
 * comes down at is decided by how high it was struck from, so the shot that is
 * supposed to be unanswerable was mostly just another kick.
 *
 * Raising the band is only half of it: `touchWait` held *every* touch back
 * until the ball had fallen to shoulder height, which for a shot struck above
 * the head means waiting for it to be gone. So the ceiling is now per-touch,
 * and these check that the higher one reaches the flip and nothing else.
 */

/** Reach the private queue the strike planner parks a too-early touch in. */
const queued = (r: Rig): boolean =>
  (r.match as unknown as { pendingTouch: unknown }).pendingTouch !== null;

/** Stand the player up with a ball `rel` body-heights above the ground. */
function setUp(r: Rig, rel: number, opts: { touched?: boolean } = {}): void {
  const c = r.match.chars.player;
  c.position.set(-1.6, GROUND_Y, -0.4); // inside the smash range, strong-foot side
  r.match.state = "rally";
  r.match.strikeableSide = "player";
  r.match.touchCount = opts.touched === false ? 0 : 1;
  r.match.ball.held = false;
  r.match.ball.state.pos.set(c.position.x + 0.2, GROUND_Y + rel * c.height, c.position.z);
  // Rising slightly, and that matters. Gravity is quick: a ball dropped from
  // rest crosses the gap between the two ceilings in under the contact window,
  // so a ball that is already falling reaches *either* of them soon enough to
  // be played now and the two are indistinguishable. A touch of lift puts the
  // ordinary ceiling out past the window while the flip's is still inside it,
  // which is the whole difference these tests are about.
  r.match.ball.state.vel.set(0, 1.5, 0);
}

describe("how high a ball has to be to flip", () => {
  it("takes a ball above the head rather than waiting for it to drop", () => {
    const r = rig();
    setUp(r, 1.05);

    const took = r.match.tryStrike("player", { target: new Vector3(1.2, 0, 0), power: 0.9 });

    expect(took).toBe(true);
    expect(queued(r)).toBe(false);
  });

  it("makes the same ball wait when this player cannot flip", () => {
    // ENGLAND has `backflips: "none"`, so the shot is not on the menu and the
    // ball has to come down to something that is. Same height, same everything
    // else — only the character differs.
    const noFlip = CHARACTERS.find((c) => c.backflips === "none")!;
    const r = rig({ def: noFlip });
    setUp(r, 1.05);

    r.match.tryStrike("player", { target: new Vector3(1.2, 0, 0), power: 0.9 });

    expect(queued(r)).toBe(true);
  });

  it("makes it wait when the last touch was already a foot", () => {
    // The no-repeat rule would drop the flip from the candidate list anyway, so the
    // raised ceiling must not be granted for a shot that will not be played.
    const r = rig();
    setUp(r, 1.05);
    (r.match as unknown as { lastPart: Record<string, string> }).lastPart.player = "foot";

    r.match.tryStrike("player", { target: new Vector3(1.2, 0, 0), power: 0.9 });

    expect(queued(r)).toBe(true);
  });

  it("makes it wait on the first touch, when a finish is not allowed at all", () => {
    const r = rig();
    setUp(r, 1.05, { touched: false });

    r.match.tryStrike("player", { target: new Vector3(1.2, 0, 0), power: 0.9 });

    expect(queued(r)).toBe(true);
  });

  it("never plans a control touch above the ordinary ceiling", () => {
    // The ceiling is shared with receptions, and raising it globally would let
    // a chest or inner-foot touch wind up under a ball above the player's head.
    const r = rig();
    setUp(r, 1.05);

    r.match.tryControlTouch("player", 0, 0);

    expect(queued(r)).toBe(true);
  });

  it("keeps the two ceilings the right way round", () => {
    expect(STRIKE_CEILING.flip).toBeGreaterThan(STRIKE_CEILING.normal);
    // A flip has to be reachable from inside its own band, or the band is dead.
    expect(STRIKE_CEILING.flip).toBeGreaterThan(STRIKE_BANDS.backflip);
  });
});

describe("what a flip does to the ball", () => {
  it("sends it over the net and down onto the far half, fast", () => {
    // Geometry, not a knob. The opponent has no way to decline a ball — see
    // `tests/ai.test.ts` — so a shot is only unanswerable because of where it
    // is struck from and how quickly it arrives. This asserts the ball itself,
    // with the AI nowhere in it.
    const r = rig();
    setUp(r, 1.05);
    r.match.tryStrike("player", {
      target: new Vector3(1.2, tableSurfaceY(1.2), 0),
      power: 0.95,
    });

    // Caught on pace, not on any movement: the set-up ball is already drifting,
    // and the contact steering nudges it again just before the strike. Nothing
    // but a struck ball travels at eight metres a second.
    let launched: { pos: Vector3; vel: Vector3 } | null = null;
    for (let i = 0; i < 240 && !launched; i++) {
      r.step(SIM_DT);
      const v = r.match.ball.state.vel;
      if (v.length() > 8) launched = { pos: r.match.ball.state.pos.clone(), vel: v.clone() };
    }

    expect(launched).not.toBeNull();
    const { pos, vel } = launched!;
    // Struck high: this is the whole reason the shot comes down steeply.
    expect(pos.y).toBeGreaterThan(GROUND_Y + 1.4);
    // Heading for the other side, and getting there quickly.
    expect(vel.x).toBeGreaterThan(0);
    const flight = integrate(pos, vel);
    expect(flight).not.toBeNull();
    expect(flight!.landed.x).toBeGreaterThan(0);
    expect(flight!.landed.x).toBeLessThanOrEqual(TABLE.halfLen + 1e-6);
    // Arriving before anybody can cross the court to it: this, and not the
    // angle, is what makes a well-set-up flip unanswerable.
    expect(flight!.seconds).toBeLessThan(0.3);
    // And coming down onto the table rather than floating across it.
    expect(flight!.descent).toBeGreaterThan(0.3);
  });
});

/** Run a launch out to where it first meets the table, without the rules. */
function integrate(
  pos: Vector3,
  vel: Vector3
): { landed: Vector3; seconds: number; descent: number } | null {
  const p = pos.clone();
  const v = vel.clone();
  const h = 1 / 480;
  for (let i = 1; i <= 480 * 3; i++) {
    v.y -= 9.81 * h;
    p.addInPlace(v.scale(h));
    if (p.x > 0 && p.y <= tableSurfaceY(p.x) + 0.02 && v.y < 0) {
      // How steep it arrives: downward speed against forward speed.
      return { landed: p.clone(), seconds: i * h, descent: Math.abs(v.y) / Math.max(1e-6, Math.abs(v.x)) };
    }
    if (p.y < -2) return null;
  }
  return null;
}

describe("the ladder the shots sit on", () => {
  it("puts the flip above the header, and the header above the foot", () => {
    expect(STRIKE_BANDS.backflip).toBeGreaterThan(STRIKE_BANDS.header);
    expect(STRIKE_BANDS.header).toBeGreaterThan(STRIKE_BANDS.foot);
  });
});
