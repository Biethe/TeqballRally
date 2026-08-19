import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SIM_DT, GROUND_Y, TABLE } from "../src/config";
import { solveLaunchClearingNet, stepBall, type BallState } from "../src/ball";
import {
  MAX_CATCHUP_TICKS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  applyStrike,
  catchupTicks,
  decode,
  isValidInput,
  readLoft,
  readTaps,
  encode,
  isValidMove,
  isValidRematch,
  isValidStrike,
  makeRoomCode,
  makeStrike,
  normalizeRoomCode,
  isValidRoomCode,
  secondsToTicks,
  ticksToSeconds,
} from "../src/net/protocol";

/** A realistic struck ball: from the player's side, over the net, onto the far half. */
function struckBall(): BallState {
  const from = new Vector3(-2.6, 1.3, 0.2);
  const target = new Vector3(1.1, GROUND_Y + TABLE.hCenter, -0.3);
  return { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };
}

function advance(state: BallState, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepBall(state, SIM_DT);
}

describe("authority handoff reproduces the striker's flight", () => {
  // This is the assumption the whole design rests on: because stepBall is pure
  // and every random roll happens at the strike, sending the launch state is
  // enough for the receiver to compute the identical trajectory.
  it("lands both peers on the same position after the same total ticks", () => {
    const TOTAL = 60; // one second of flight
    for (const latencyTicks of [0, 1, 3, 6, 12]) {
      const striker = struckBall();
      const msg = makeStrike(0, striker, "RightFootKick");

      // The striker keeps simulating from the moment it launched.
      advance(striker, TOTAL);

      // The receiver hears about it `latencyTicks` late, catches up, then runs
      // the remaining ticks itself.
      const receiver: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
      applyStrike(receiver, msg, latencyTicks);
      advance(receiver, TOTAL - latencyTicks);

      expect(receiver.pos.x, `x @ ${latencyTicks} ticks`).toBeCloseTo(striker.pos.x, 9);
      expect(receiver.pos.y, `y @ ${latencyTicks} ticks`).toBeCloseTo(striker.pos.y, 9);
      expect(receiver.pos.z, `z @ ${latencyTicks} ticks`).toBeCloseTo(striker.pos.z, 9);
    }
  });

  it("agrees through a table bounce, not just clean flight", () => {
    const TOTAL = 90; // long enough to bounce on the far half
    const striker = struckBall();
    const msg = makeStrike(0, striker, "RightFootKick");
    advance(striker, TOTAL);

    const receiver: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
    applyStrike(receiver, msg, 8);
    advance(receiver, TOTAL - 8);

    // Confirm the trajectory really did include a bounce, so the agreement
    // above is not just two parabolas matching.
    const witness = struckBall();
    let bounced = false;
    for (let i = 0; i < TOTAL; i++) {
      stepBall(witness, SIM_DT, (e) => {
        if (e.type === "table") bounced = true;
      });
    }
    expect(bounced).toBe(true);
    expect(receiver.pos.x).toBeCloseTo(striker.pos.x, 9);
    expect(receiver.pos.y).toBeCloseTo(striker.pos.y, 9);
  });

  it("copies the launch state exactly when there is no latency", () => {
    const striker = struckBall();
    const msg = makeStrike(42, striker, "LeftFootKick", 1.5);
    const receiver: BallState = { pos: new Vector3(9, 9, 9), vel: new Vector3(9, 9, 9) };

    applyStrike(receiver, msg, 42);

    expect(receiver.pos.asArray()).toEqual(striker.pos.asArray());
    expect(receiver.vel.asArray()).toEqual(striker.vel.asArray());
  });

  it("carries the clip and spin so the receiver shows the same move", () => {
    const msg = makeStrike(7, struckBall(), "BackflipLeftFoot", 2);
    expect(msg.clip).toBe("BackflipLeftFoot");
    expect(msg.spin).toBe(2);
  });
});

describe("catchupTicks", () => {
  it("is the plain tick difference in the normal case", () => {
    expect(catchupTicks(100, 106)).toBe(6);
  });

  it("never winds the simulation backwards", () => {
    // A peer momentarily ahead of us, or a reordered packet.
    expect(catchupTicks(110, 100)).toBe(0);
    expect(catchupTicks(100, 100)).toBe(0);
  });

  it("clamps a long stall instead of teleporting the ball", () => {
    expect(catchupTicks(0, 100_000)).toBe(MAX_CATCHUP_TICKS);
    expect(ticksToSeconds(MAX_CATCHUP_TICKS)).toBeCloseTo(0.5, 10);
  });

  it("round-trips against the tick helpers", () => {
    expect(secondsToTicks(1)).toBe(60);
    expect(ticksToSeconds(60)).toBeCloseTo(1, 10);
    expect(secondsToTicks(ticksToSeconds(37))).toBe(37);
  });
});

describe("strike validation", () => {
  it("accepts a well-formed strike", () => {
    expect(isValidStrike(makeStrike(1, struckBall(), "ChestKick"))).toBe(true);
  });

  it("rejects NaN and Infinity before they poison the ball state", () => {
    const base = makeStrike(1, struckBall(), "ChestKick");
    expect(isValidStrike({ ...base, pos: { x: NaN, y: 0, z: 0 } })).toBe(false);
    expect(isValidStrike({ ...base, vel: { x: 0, y: Infinity, z: 0 } })).toBe(false);
    expect(isValidStrike({ ...base, tick: NaN })).toBe(false);
    expect(isValidStrike({ ...base, spin: NaN })).toBe(false);
  });

  it("rejects missing fields and wrong shapes", () => {
    const base = makeStrike(1, struckBall(), "ChestKick");
    expect(isValidStrike({ ...base, pos: undefined })).toBe(false);
    expect(isValidStrike({ ...base, clip: 42 })).toBe(false);
    expect(isValidStrike({ ...base, t: "move" })).toBe(false);
    expect(isValidStrike(null)).toBe(false);
    expect(isValidStrike("strike")).toBe(false);
  });

  it("validates moves the same way", () => {
    const move = { t: "move", tick: 3, pos: { x: 1, y: 2, z: 3 }, yaw: 0.5, moveX: 0, moveZ: 1 };
    expect(isValidMove(move)).toBe(true);
    expect(isValidMove({ ...move, yaw: NaN })).toBe(false);
    expect(isValidMove({ ...move, t: "strike" })).toBe(false);
  });
});

describe("rematch validation", () => {
  it("accepts the three negotiation actions", () => {
    for (const action of ["request", "accept", "decline"] as const) {
      expect(isValidRematch({ t: "rematch", tick: 1, action })).toBe(true);
    }
  });

  it("rejects anything a pause could do but a rematch cannot", () => {
    expect(isValidRematch({ t: "rematch", tick: 1, action: "resume" })).toBe(false);
    expect(isValidRematch({ t: "pause", tick: 1, action: "request" })).toBe(false);
    expect(isValidRematch({ t: "rematch", tick: 1 })).toBe(false);
    expect(isValidRematch(null)).toBe(false);
  });
});

describe("encode / decode", () => {
  it("round-trips a strike", () => {
    const msg = makeStrike(12, struckBall(), "RightHeadKick", 1.2);
    const back = decode(encode(msg));
    expect(back).toEqual(msg);
  });

  it("returns null for anything that is not a message", () => {
    expect(decode("not json")).toBeNull();
    expect(decode("null")).toBeNull();
    expect(decode("[1,2,3]")).toBeNull();
    expect(decode('{"no":"type"}')).toBeNull();
    expect(decode('{"t":5}')).toBeNull();
  });
});

describe("room codes", () => {
  it("uses Crockford base32 — no I, L, O or U", () => {
    for (const c of "ILOU") expect(ROOM_CODE_ALPHABET).not.toContain(c);
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
  });

  it("generates valid codes of the right length", () => {
    let rand = 0;
    const seq = () => ((rand = (rand * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode(seq);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it("stays inside the alphabet at both ends of the random range", () => {
    expect(isValidRoomCode(makeRoomCode(() => 0))).toBe(true);
    expect(isValidRoomCode(makeRoomCode(() => 0.999999))).toBe(true);
  });

  it("folds the look-alikes a player is likely to type", () => {
    // None of I, L, O or U can appear in a generated code, so each one typed
    // is a misread of the character it resembles.
    expect(normalizeRoomCode("ILOUV")).toBe("110VV");
    expect(normalizeRoomCode("O0I1L")).toBe("00111");
  });

  it("leaves every folded code inside the alphabet", () => {
    // Whatever a player types, normalising must not produce a character that
    // validation will then reject — that would be an unrecoverable dead end.
    const typed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (const c of typed) {
      const folded = normalizeRoomCode(c.repeat(ROOM_CODE_LENGTH));
      expect(isValidRoomCode(folded), `${c} -> ${folded}`).toBe(true);
    }
  });

  it("ignores case, spaces and punctuation", () => {
    expect(normalizeRoomCode("a b-c d/e")).toBe("ABCDE");
    expect(normalizeRoomCode("  hjk9m  ")).toBe("HJK9M");
  });

  it("truncates rather than accepting an over-long code", () => {
    expect(normalizeRoomCode("ABCDEFGHIJ")).toHaveLength(ROOM_CODE_LENGTH);
  });

  it("rejects codes of the wrong length or with excluded characters", () => {
    expect(isValidRoomCode("ABCD")).toBe(false);
    expect(isValidRoomCode("ABCDEF")).toBe(false);
    expect(isValidRoomCode("ABCDI")).toBe(false); // I is not in the alphabet
    expect(isValidRoomCode("abcde")).toBe(false); // normalise first
  });

  it("accepts what it generates, after a round trip through normalise", () => {
    for (let i = 0; i < 100; i++) {
      const code = makeRoomCode();
      expect(normalizeRoomCode(code)).toBe(code);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });
});

describe("protocol version", () => {
  it("is a positive integer both halves can compare", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe("the shape a kick was given", () => {
  const base = { t: "input", tick: 1, moveX: 0, moveZ: 0, strike: true, pop: false, confirm: false };

  it("accepts a frame that carries no shape at all", () => {
    // An older peer sends neither, and its kicks simply come out neutral.
    expect(isValidInput(base)).toBe(true);
    expect(readTaps(undefined)).toBeUndefined();
    expect(readLoft(undefined)).toBeUndefined();
  });

  it("takes a sensible shape at face value", () => {
    expect(readTaps(2)).toBe(2);
    expect(readLoft(1.4)).toBe(1.4);
  });

  it("makes nonsense safe instead of throwing the frame away", () => {
    // The movement rides on the same message. Rejecting it over a bad field
    // would stutter the other player's character, which is far worse than
    // flattening one kick — so these are clamped, never a reason to drop.
    expect(readTaps(99)).toBe(3);
    expect(readTaps(-4)).toBe(1);
    expect(readTaps(2.6)).toBe(3);
    expect(readLoft(1e9)).toBe(2);
    expect(readLoft(-1e9)).toBe(0.5);
  });

  it("ignores values that are not numbers", () => {
    for (const junk of [NaN, Infinity, "3", null, {}, []]) {
      expect(readTaps(junk)).toBeUndefined();
      expect(readLoft(junk)).toBeUndefined();
    }
  });

  it("still validates a frame that carries a shape", () => {
    expect(isValidInput({ ...base, taps: 3, loft: 1.85 })).toBe(true);
  });
});

