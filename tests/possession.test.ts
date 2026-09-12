import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { bodyPartOf } from "../src/character";
import { solveLaunchClearingNet } from "../src/ball";
import {
  AUTO_RECEPTION_REACH,
  AUTO_RUN,
  COURT,
  GROUND_Y,
  MAX_TOUCHES,
  PLAYER_REACH,
  SIM_DT,
  SPAWN,
  TABLE,
  tableSurfaceY,
  type BodyPart,
} from "../src/config";
import type { InputState } from "../src/input";
import { idle, playBuiltPoint, playPoint, rig, silentUI, type Rig } from "./rig";

describe("a possession, played through the real rules", () => {
  it("gets the ball over the net and into a rally", () => {
    const r = rig();
    playPoint(r, 6);

    const launched = r.events.filter((e) => e.type === "ball-launched");
    expect(launched.length).toBeGreaterThan(1);
    expect(launched[0]).toMatchObject({ action: "serve" });
  });

  it("never plays the same part of the body twice in a row", () => {
    // The teqball rule, checked where it actually has to hold: across the clips
    // real possessions chose, in real rallies, rather than across a picker
    // called by hand. Read off the launch events, which name the clip that sent
    // the ball, so this sees exactly what the player saw.
    const r = rig();
    const possession: Record<string, BodyPart[]> = { player: [], ai: [] };
    const pairs: [BodyPart, BodyPart][] = [];
    r.match.subscribe((e) => {
      if (e.type === "possession-start") possession[e.side] = [];
      if (e.type === "ball-launched" && e.action !== "serve") {
        const part = bodyPartOf(e.clip);
        if (!part) return;
        const seq = possession[e.side];
        if (seq.length > 0) pairs.push([seq[seq.length - 1], part]);
        seq.push(part);
      }
    });
    for (let point = 0; point < 8; point++) playBuiltPoint(r, 7);

    // The rallies have to have actually produced multi-touch possessions, or
    // there is nothing here to have checked.
    expect(pairs.length).toBeGreaterThan(2);
    for (const [before, after] of pairs) expect(after, `${before} -> ${after}`).not.toBe(before);
  });

  it("keeps a possession inside the touch allowance", () => {
    const r = rig();
    for (let point = 0; point < 5; point++) playPoint(r, 7);

    expect(r.match.touchCount).toBeLessThanOrEqual(MAX_TOUCHES);
  });

  it("plays the same touches on every run of the same inputs", () => {
    // Determinism where it counts. There are no dice left in the rally path —
    // the landing deviation, the AI's read and the AI's choices are all
    // functions of the simulation — so what must never vary is everything:
    // which limb plays the ball, and therefore what the player can do next.
    const played = (): string[] => {
      const r = rig();
      r.step(3);
      r.step(0.2, { strikePressed: true, moveX: 0.4, moveZ: -0.2 });
      r.step(1.4);
      return r.player.played;
    };

    expect(played()).toEqual(played());
  });

  it("replays a rally exactly, ball for ball", () => {
    // Two runs of the same inputs have to agree to the last decimal —
    // anything else would be a source of variation somewhere in the
    // simulation, and a variation one of the two peers cannot see.
    const run = (): number[] => {
      const r = rig();
      r.step(3);
      r.step(0.2, { strikePressed: true, moveX: 0.4, moveZ: -0.2 });
      r.step(2.2);
      const b = r.match.ball.state;
      return [b.pos.x, b.pos.y, b.pos.z, r.player.position.x, r.player.position.z];
    };

    expect(run()).toEqual(run());
  });
});

/**
 * The spot a side's next touch is due at, read off the controller.
 *
 * Private, and deliberately so — but where the assist puts a player is the
 * thing these tests are about, and asserting on it beats asserting on a
 * hand-computed guess at the same number.
 */
function readAnchor(r: Rig): { pos: Vector3; eta: number } | null {
  return (
    r.match as unknown as { anchor: Record<string, { pos: Vector3; eta: number } | null> }
  ).anchor.player;
}

describe("what a contact is worth", () => {
  /**
   * Receive one fed ball, asking for the touch either the moment it comes
   * within reach — while it is still up on the body — or once it has fallen
   * below a given height.
   *
   * The grade comes back off the HUD flash, which is the game's own reading of
   * the contact rather than a number this test worked out for itself.
   */
  function receive(press: "in reach" | number): { quality: number; clip: string } | null {
    const graded: number[] = [];
    const ui = silentUI();
    ui.meterResult = (q) => graded.push(q);
    const r = rig({ ui });
    // The press is the point of this test, so the automatic first touch is off
    // — exactly as it is in practice mode.
    r.match.autoFirstReception = false;
    r.step(0.5);
    r.match.state = "rally";
    r.match.lastHitter = "ai";
    r.match.strikeableSide = null;
    r.match.touchCount = 0;
    let clip: string | null = null;
    r.match.subscribe((e) => {
      if (e.type === "ball-launched" && e.action === "pop" && e.side === "player") clip ??= e.clip;
    });
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    const target = new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(solveLaunchClearingNet(from, target, 1.35));
    // Both runs are played from the same place, under where the ball will come
    // down: this is about when the touch was asked for, not where anybody stood.
    r.step(0.35);
    const anchor = readAnchor(r);
    if (!anchor) return null;
    r.player.position.set(anchor.pos.x, GROUND_Y, anchor.pos.z);
    let pressed = false;
    let above = r.match.ball.state.pos.y;
    for (let i = 0; i < 60 * 4 && r.match.state === "rally" && clip === null; i++) {
      const ball = r.match.ball.state.pos;
      const dropping = ball.y < above;
      above = ball.y;
      const chest = r.player.position.add(new Vector3(0, r.player.height * 0.55, 0));
      const mine = r.match.strikeableSide === "player";
      const due =
        press === "in reach"
          ? mine && Vector3.Distance(chest, ball) <= PLAYER_REACH
          : mine && dropping && ball.y - GROUND_Y < press;
      const now = due && !pressed;
      if (now) pressed = true;
      r.match.update(SIM_DT, { ...idle, popPressed: now }, () => {});
    }
    if (clip === null || graded.length === 0) return null;
    return { quality: graded[0], clip };
  }

  it("grades a ball met properly above one left until the last moment", () => {
    // Test 3, at the seam where the grade meets the ball, and measured off the
    // game's own reading of the contact rather than a number this test worked
    // out for itself.
    //
    // Both are touches: a press is never swallowed, and a player who grabs at
    // the ball late still keeps the rally alive. What differs is what they get
    // for it — and it is worth reading the direction carefully. Meeting the
    // ball early, up on the body, is the *good* contact; leaving it until it is
    // nearly on the floor is the poor one. That is the sport, and it is why
    // timing here is a thing to feel rather than a bar to hit.
    const met = receive("in reach");
    const late = receive(0.35);

    expect(met).not.toBeNull();
    expect(late).not.toBeNull();
    expect(met!.quality).toBeGreaterThan(late!.quality + 0.2);
    // The floor under a grade is what keeps a beginner in the rally.
    expect(late!.quality).toBeGreaterThan(0.1);
  });

  it("plays the ball with a different part of the body for it", () => {
    // The other half of the same fact, and the reason this is not a rhythm
    // game: taking the ball early is a chest touch and letting it drop is a
    // foot touch, so *when* is also a choice about *what*.
    expect(receive("in reach")!.clip).not.toBe(receive(0.35)!.clip);
  });
});

describe("staying with the ball", () => {
  /** Put a ball on its way to the player's half, as a return from the far side. */
  function feedPlayer(r: Rig): void {
    // Straight into a rally: no serve to finish, so nothing else is moving the
    // ball while the reception is being watched.
    r.step(0.5);
    r.match.state = "rally";
    r.match.lastHitter = "ai";
    r.match.strikeableSide = null;
    r.match.touchCount = 0;
    r.player.position.set(-SPAWN.x, GROUND_Y, 0);
    r.player.played.length = 0;
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    const target = new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(solveLaunchClearingNet(from, target, 1.35));
  }

  /**
   * Run the ball in, holding `input` for `holdFor` seconds and then letting go,
   * and report whether the player got a touch and how far they travelled.
   */
  function chase(input: Partial<InputState>, holdFor = 3): { touched: string[]; moved: number } {
    const r = rig();
    feedPlayer(r);
    const from = r.player.position.clone();
    for (let i = 0; i < 60 * 3 && r.match.state === "rally"; i++) {
      const held = i * SIM_DT < holdFor ? input : {};
      r.match.update(SIM_DT, { ...idle, ...held }, () => {});
    }
    return {
      touched: r.player.played.filter((c) => bodyPartOf(c) !== null),
      moved: Vector3.Distance(from, r.player.position),
    };
  }

  it("keeps a drifting player connected to the ball", () => {
    // Acceptance test 1, and the failure the zone exists for: a player who
    // pushes away from an incoming ball for a moment — finishing a run,
    // repositioning, or simply not looking — must not lose a reception that
    // was there to be made.
    const drifted = chase({ moveX: -1, moveZ: 0.8 }, 0.4);

    expect(drifted.touched.length).toBeGreaterThan(0);
    // They really did move: this is not a player who was pinned in place.
    expect(drifted.moved).toBeGreaterThan(0.8);
  });

  it("does not move the player toward the ball by itself before the ball bounces on the table", () => {
    const r = rig();
    feedPlayer(r);
    const initialPos = r.player.position.clone();

    // Step while the incoming ball is in flight before bouncing on the table
    for (let i = 0; i < 60 * 0.6 && r.match.strikeableSide === null; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }

    // Player must remain completely unmoved while idle before table bounce
    expect(r.match.strikeableSide).toBeNull();
    expect(Vector3.Distance(initialPos, r.player.position)).toBeLessThan(1e-4);
  });

  it("gives nothing to a player the ball is going to beat", () => {
    // What replaced the lateral band this used to check. A band answered "is
    // the ball roughly in front of me", which said no to a lofted ball two
    // paces to the side and yes to a drive that was already past. The question
    // now is the one that decides the point: could they still get there?
    //
    // Parked at the far corner with the ball dropping across the court, the
    // answer is no, and no amount of assist may invent a reception out of it —
    // a well-placed shot has to be able to win.
    const r = rig();
    feedPlayer(r);
    r.player.position.set(-COURT.maxX + 0.2, GROUND_Y, -COURT.maxZ + 0.2);
    const from = r.player.position.clone();
    for (let i = 0; i < 60 * 2 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }

    expect(Vector3.Distance(from, r.player.position)).toBeLessThan(1e-4);
    expect(r.player.played.filter((c) => bodyPartOf(c) !== null)).toEqual([]);
  });

  it("leaves the feet to the player while the ball is far off", () => {
    // The assist is semi-: the run takes over in the ball's vicinity, not the
    // moment it is hit. Standing further out than that, the stick is in charge
    // and walking anywhere is still the player's decision to make.
    const r = rig();
    feedPlayer(r);
    r.player.position.z = 2.5; // outside AUTO_RUN.vicinity of the drop spot
    const from = r.player.position.clone();
    for (let i = 0; i < 60 * 0.5 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, { ...idle, moveZ: 1 }, () => {});
    }

    expect(r.player.position.z - from.z).toBeGreaterThan(0.8);
  });

  it("lets a player who means to leave leave, and costs them the ball for it", () => {
    // The line between an assist and a takeover, and the one the old run was
    // on the wrong side of: it went to the drop whatever the stick said, so a
    // ball could never be abandoned and the approach was not really being
    // played. Held away for the whole flight, the push wins and the reception
    // is lost — which is what makes every other reception something the player
    // did rather than something the game did for them.
    //
    // The momentary version of this is the test above, and it still lands:
    // only a sustained push costs the ball, never a slip.
    const r = rig();
    feedPlayer(r);
    let drop: Vector3 | null = null;
    for (let i = 0; i < 60 * 3 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, { ...idle, moveX: -1, moveZ: 0.8 }, () => {});
      drop = readAnchor(r)?.pos.clone() ?? drop;
    }

    expect(r.player.played.filter((c) => bodyPartOf(c) !== null)).toEqual([]);
    expect(drop).not.toBeNull();
    expect(Vector3.Distance(r.player.position, drop!)).toBeGreaterThan(AUTO_RUN.reengage);
  });

  it("hears the stick again once the run has arrived", () => {
    // The second half of the rule: the lock is until the drop spot, not a
    // possession of the feet. From the arrival on, a push moves the player
    // again — that shift is how a side of the ball is chosen.
    const r = rig();
    feedPlayer(r);
    // Near the drop spot: the run arrives and pops.
    r.player.position.set(-3.2, GROUND_Y, 0.2);

    // Stick idle: the run alone has to bring the reception home.
    let touched = false;
    for (let i = 0; i < 60 * 4 && r.match.state === "rally" && !touched; i++) {
      r.match.update(SIM_DT, idle, () => {});
      touched = r.player.played.some((c) => bodyPartOf(c) !== null);
    }
    expect(touched).toBe(true);
    // Give the run time to land the player under their own pop.
    for (let i = 0; i < 60 * 0.5 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }
    expect(r.match.state).toBe("rally");

    // From the arrival on, the push is heard again.
    const zBefore = r.player.position.z;
    for (let i = 0; i < 60 * 0.35 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, { ...idle, moveZ: -1 }, () => {});
    }
    expect(r.player.position.z).toBeLessThan(zBefore - 0.25);
  });
});

describe("aiming the shot that follows a set-up", () => {
  /** The aim marker's spot, read off the controller. */
  const readAim = (r: Rig): Vector3 =>
    (r.match as unknown as { aimSpot: Record<string, Vector3> }).aimSpot.player;

  /** Put a ball on its way to the player's half, as a return from the far side. */
  const feedPlayer = (r: Rig): void => {
    r.step(0.5);
    r.match.state = "rally";
    r.match.lastHitter = "ai";
    r.match.strikeableSide = null;
    r.match.touchCount = 0;
    r.player.position.set(-SPAWN.x, GROUND_Y, 0);
    r.player.played.length = 0;
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    const target = new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(solveLaunchClearingNet(from, target, 1.35));
  };

  /** Step until the automatic reception has popped the ball. */
  const afterSetUp = (r: Rig): boolean => {
    for (let i = 0; i < 60 * 4 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, idle, () => {});
      if (r.match.touchCount > 0) return true;
    }
    return false;
  };

  it("reinitializes the aim at the center of the opponent's side of the table on a new possession", () => {
    const r = rig();
    feedPlayer(r);

    // Nothing is aimable until the ball has bounced and become theirs.
    for (let i = 0; i < 60 * 3 && r.match.strikeableSide !== "player"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }
    expect(r.match.strikeableSide).toBe("player");

    // Aim wide, the way a player does: stick over, kick button down.
    for (let i = 0; i < 60 * 0.3 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, { ...idle, moveZ: 1, strikeHeld: true }, () => {});
    }
    const aimed = readAim(r).z;
    expect(aimed).toBeGreaterThan(TABLE.halfWid * 0.5);

    // Hand the ball over and take it back: a real table bounce on the
    // player's half, which resets the aim to the center of the opponent's side.
    r.match.strikeableSide = null;
    r.match.lastHitter = "ai";
    r.match.touchCount = 0;
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(
      solveLaunchClearingNet(from, new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2), 1.35)
    );
    for (let i = 0; i < 60 * 3 && r.match.strikeableSide !== "player"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }
    expect(r.match.strikeableSide).toBe("player");

    // Reinitialized to the center of the opponent's side of the table:
    expect(readAim(r).z).toBe(0);
    expect(readAim(r).x).toBeCloseTo(TABLE.halfLen * 0.55, 3);
  });

  it("never walks the aim back across the net onto the player's own half", () => {
    // What "the aimer is under the table" was. The marker is drawn on the
    // table when the aim is over it and on the floor when it is not, and the
    // stick's depth axis used to be bounded by the whole court rather than by
    // the half being attacked — so pushing back walked the aim through the net
    // and out the far side, leaving the ring on the ground by the player's own
    // feet, where no kick could ever have been asking to go.
    const r = rig();
    feedPlayer(r);
    for (let i = 0; i < 60 * 3 && r.match.strikeableSide !== "player"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }
    expect(r.match.strikeableSide).toBe("player");

    // Haul the aim backwards as hard and as long as the stick allows.
    for (let i = 0; i < 60 * 2 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, { ...idle, moveX: -1, strikeHeld: true }, () => {});
    }

    // The player defends the -x half, so every aim of theirs is on +x, and
    // far enough over the net to be a shot rather than a bounce off the tape.
    expect(readAim(r).x).toBeGreaterThan(0);
  });

  it("does not move the aim before a set-up has been played", () => {
    // Before the first touch the stick is the shape of that reception, not the
    // aim of a shot two touches away. The two windows must not overlap.
    const r = rig();
    feedPlayer(r);
    const from = readAim(r).clone();
    for (let i = 0; i < 60 * 0.5 && r.match.touchCount === 0; i++) {
      r.match.update(SIM_DT, { ...idle, moveZ: 1 }, () => {});
    }

    expect(readAim(r).z).toBeCloseTo(from.z, 6);
  });

  it("keeps the aim inside the court however long the stick is held", () => {
    const r = rig();
    feedPlayer(r);
    expect(afterSetUp(r)).toBe(true);
    for (let i = 0; i < 60 * 3 && r.match.state === "rally"; i++) {
      r.match.update(SIM_DT, { ...idle, moveZ: 1 }, () => {});
    }

    expect(Math.abs(readAim(r).z)).toBeLessThanOrEqual(TABLE.halfWid + 0.4);
  });

  it("moves the aim sensitively during a kick sequence", () => {
    const r = rig();
    feedPlayer(r);
    for (let i = 0; i < 60 * 3 && r.match.strikeableSide !== "player"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }
    expect(r.match.strikeableSide).toBe("player");

    // Even in a very brief tap (60ms), the aim should travel significantly across the table
    for (let i = 0; i < 60 * 0.06; i++) {
      r.match.update(SIM_DT, { ...idle, moveZ: 1, strikeHeld: true }, () => {});
    }
    expect(readAim(r).z).toBeGreaterThan(0.5);
  });

  it("positions the aim marker on top of the table surface rather than under the table", () => {
    const r = rig();
    const fakeMarker = {
      position: new Vector3(),
      scaling: new Vector3(),
      enabled: false,
      setEnabled(val: boolean) { this.enabled = val; },
    };
    r.match.aimMarker = fakeMarker as unknown as import("@babylonjs/core/Meshes/mesh").Mesh;
    feedPlayer(r);
    for (let i = 0; i < 60 * 3 && r.match.strikeableSide !== "player"; i++) {
      r.match.update(SIM_DT, idle, () => {});
    }
    expect(r.match.strikeableSide).toBe("player");

    // Update with strike held so the aim marker position updates
    r.match.update(SIM_DT, { ...idle, strikeHeld: true }, () => {});
    const aimX = readAim(r).x;
    expect(fakeMarker.position.y).toBeCloseTo(tableSurfaceY(aimX) + 0.03, 3);
    // Ensure marker Y is above table surface and well above ground plane (GROUND_Y = 0.4)
    expect(fakeMarker.position.y).toBeGreaterThan(GROUND_Y + 0.5);
  });
});

describe("crafting the first touch", () => {
  /** Put a ball on its way to the player's half, as a return from the far side. */
  const feed = (r: Rig): void => {
    r.step(0.5);
    r.match.state = "rally";
    r.match.lastHitter = "ai";
    r.match.strikeableSide = null;
    r.match.touchCount = 0;
    r.player.position.set(-SPAWN.x, GROUND_Y, 0);
    r.player.played.length = 0;
    const from = new Vector3(2.4, GROUND_Y + 1.6, 0.3);
    const target = new Vector3(-1.1, tableSurfaceY(-1.1) + 0.02, 0.2);
    r.match.ball.state.pos.copyFrom(from);
    r.match.ball.launch(solveLaunchClearingNet(from, target, 1.35));
  };

  /**
   * Step until the automatic reception pops the ball; return the pop's launch
   * velocity.
   *
   * The stick is held only once the ball is nearly on the player, because that
   * is when it is read as the shape of the touch (`receptionSettling`). Held
   * from the moment the ball is struck it would mean the other thing the stick
   * means — run that way — and the player would walk out of the reception they
   * were trying to craft.
   */
  const popVel = (r: Rig, stick: Partial<InputState>): Vector3 | null => {
    let vel: Vector3 | null = null;
    r.match.subscribe((e) => {
      if (e.type === "ball-launched" && e.action === "pop" && e.side === "player" && !vel) {
        vel = e.vel.clone();
      }
    });
    for (let i = 0; i < 60 * 4 && r.match.state === "rally" && !vel; i++) {
      const chest = r.player.position.add(new Vector3(0, r.player.height * 0.55, 0));
      const onMe = Vector3.Distance(chest, r.match.ball.state.pos) <= AUTO_RECEPTION_REACH * 1.6;
      r.match.update(SIM_DT, { ...idle, ...(onMe ? stick : {}) }, () => {});
    }
    return vel;
  };

  it("pops the reception toward the held stick", () => {
    const r = rig();
    feed(r);

    const vel = popVel(r, { moveX: 0.2, moveZ: 1 });

    expect(vel).not.toBeNull();
    // The set-up goes where the stick was pointing — the +z side.
    expect(vel!.z).toBeGreaterThan(0);
  });

  it("still sets up forward when the stick is idle", () => {
    const r = rig();
    feed(r);

    const vel = popVel(r, {});

    // Near the table the set-up is clamped into the own half, so the honest
    // assertion is that the touch went where the receiver faced — not
    // sideways, which is what a stick would have added.
    expect(vel).not.toBeNull();
    expect(Math.abs(vel!.z)).toBeLessThan(0.1);
  });

  it("ignores a thumb resting inside the deadzone", () => {
    const resting = rig();
    feed(resting);
    const held = rig();
    feed(held);

    const restingVel = popVel(resting, { moveZ: 0.1 });
    const heldVel = popVel(held, { moveZ: 1 });

    expect(restingVel).not.toBeNull();
    expect(heldVel).not.toBeNull();
    // The resting thumb still walks the player a little, which nudges the
    // geometry — but it must not AIM the touch: far less sideways than the
    // same thumb held past the deadzone.
    expect(Math.abs(restingVel!.z)).toBeLessThan(Math.abs(heldVel!.z) - 0.2);
  });

  it("in portrait the tap outvotes everything — and the stick reads nothing", () => {
    // Both runs start standing at the drop: this test measures the touch's
    // aim, not the footwork that gets there. The game sets both portrait
    // flags together; movement keys off tapSteering, reception off
    // portraitControls.
    const standAt = (r: Rig) => {
      r.player.position.set(-1.6, GROUND_Y, 0.2);
      r.match.portraitControls = true;
      r.match.tapSteering = true;
    };

    // Portrait axes carry the last swipe's residue, so the portrait seat must
    // never aim a reception off them: with no tap, the held stick is ignored
    // and the touch sets up the way the receiver faced.
    const plain = rig();
    feed(plain);
    standAt(plain);
    const plainVel = popVel(plain, { moveZ: 1 });
    expect(plainVel).not.toBeNull();
    expect(Math.abs(plainVel!.z)).toBeLessThan(0.1);

    // And a tap is still the aim: it beats the residue on the axes.
    const tapped = rig();
    feed(tapped);
    standAt(tapped);
    let vel: Vector3 | null = null;
    let done = false;
    tapped.match.subscribe((e) => {
      if (e.type === "ball-launched" && e.action === "pop" && e.side === "player" && !vel) {
        vel = e.vel.clone();
      }
    });
    let placed = false;
    for (let i = 0; i < 60 * 4 && tapped.match.state === "rally" && !vel; i++) {
      const ball = tapped.match.ball.state.pos;
      const chest = tapped.player.position.add(new Vector3(0, tapped.player.height * 0.55, 0));
      if (
        !placed &&
        tapped.match.strikeableSide === "player" &&
        Vector3.Distance(chest, ball) <= AUTO_RECEPTION_REACH * 1.6
      ) {
        // Tap a spot wide on the -z side while the axes hold +z residue.
        tapped.match.tapAt(tapped.player.position.add(new Vector3(1.2, 0, -1.6)));
        placed = true;
      }
      tapped.match.update(SIM_DT, { ...idle, moveZ: 1 }, () => {});
      if (vel) done = true;
    }
    expect(placed).toBe(true);
    expect(done).toBe(true);
    expect(vel!.z).toBeLessThan(0);
  });
});

describe("a follower at the final whistle", () => {
  /** One authoritative frame, with the match just decided. */
  const finalFrame = (sets: [number, number]) => ({
    ballPos: { x: 0, y: 1, z: 0 },
    ballVel: { x: 0, y: 0, z: 0 },
    ballHeld: true,
    selfPos: { x: -3, z: 0 },
    opponentPos: { x: 3, z: 0 },
    selfVel: { x: 0, z: 0 },
    opponentVel: { x: 0, z: 0 },
    selfClip: null,
    opponentClip: null,
    tick: 100,
    score: [12, 9] as [number, number],
    sets,
    serveOwner: "player" as const,
    phase: "over",
  });

  it("shows the joined player the result the host decided", () => {
    // The guest runs no rules: left to itself it would never know the match
    // had ended, and what it saw next was a silence countdown awarding it a
    // win it had lost. The phase change in the snapshot is the final whistle.
    let ended: string | null = null;
    const ui = silentUI();
    ui.onMatchEnd = (winner) => {
      ended = winner;
    };
    const r = rig({ ui });
    r.match.netFollower = true;

    r.match.applySnapshot(finalFrame([2, 1]));

    expect(r.match.state).toBe("over");
    expect(r.match.matchWinner).toBe("player");
    expect(ended).toBe("player");
  });

  it("names the opponent the winner when the follower lost", () => {
    let ended: string | null = null;
    const ui = silentUI();
    ui.onMatchEnd = (winner) => {
      ended = winner;
    };
    const r = rig({ ui });
    r.match.netFollower = true;

    r.match.applySnapshot(finalFrame([1, 2]));

    expect(r.match.matchWinner).toBe("ai");
    expect(ended).toBe("ai");
  });

  it("blows the whistle once, however many frames follow", () => {
    const ended: string[] = [];
    const ui = silentUI();
    ui.onMatchEnd = (winner) => ended.push(winner);
    const r = rig({ ui });
    r.match.netFollower = true;

    r.match.applySnapshot(finalFrame([2, 0]));
    r.match.applySnapshot(finalFrame([2, 0]));

    expect(ended).toEqual(["player"]);
  });
});
