import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SIM_DT } from "../src/config";
import type { MatchController } from "../src/match";
import type { NetConnection } from "../src/net/connection";
import type { NetHandlers } from "../src/net/connection";
import {
  ABSENT_AFTER_SECONDS,
  DISCONNECT_GRACE_SECONDS,
  OnlineSession,
  PAUSE_REQUEST_TIMEOUT_SECONDS,
  type PauseState,
  type SessionHandlers,
} from "../src/net/session";
import type { GameMessage, SnapshotMessage } from "../src/net/protocol";

/** A connection that records what was sent and lets a test drive its handlers. */
function fakeConn() {
  const sent: GameMessage[] = [];
  let handlers: NetHandlers = {};
  const conn = {
    tick: 0,
    send: (m: GameMessage) => sent.push(m),
    setHandlers: (next: Partial<NetHandlers>) => (handlers = { ...handlers, ...next }),
  };
  return {
    conn: conn as unknown as NetConnection,
    sent,
    deliver: (m: GameMessage) => handlers.onMessage?.(m),
    setPeer: (present: boolean) => handlers.onPeer?.(present),
  };
}

/**
 * A stand-in match. `applySnapshot` is a spy rather than a reimplementation:
 * the session's job is to translate the wire into that one call, and asserting
 * its arguments tests that without a fake pretending to be the controller.
 */
function fakeMatch() {
  const applySnapshot = vi.fn();
  const match = {
    versus: false,
    netFollower: false,
    score: { player: 0, ai: 0 },
    sets: { player: 0, ai: 0 },
    serveOwner: "player",
    state: "rally",
    versusInput: { moveX: 0, moveZ: 0, strikePressed: false, popPressed: false, confirmPressed: false },
    ball: { state: { pos: new Vector3(0, 1, 0), vel: new Vector3(0, 0, 0) }, held: false },
    chars: {
      player: { position: new Vector3(-3, 0.4, 0), velocity: new Vector3(0, 0, 0) },
      ai: { position: new Vector3(3, 0.4, 0), velocity: new Vector3(0, 0, 0), busy: false },
    },
    applySnapshot,
  };
  return { match: match as unknown as MatchController, applySnapshot };
}

function session(handlers: SessionHandlers = {}, role: "host" | "guest" = "host") {
  const c = fakeConn();
  const m = fakeMatch();
  const s = new OnlineSession(c.conn, m.match, role, handlers);
  return { s, ...c, ...m };
}

/** Advance `seconds` of simulation steps. */
function run(s: OnlineSession, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) s.step(SIM_DT);
}

/** Keep the opponent alive by feeding traffic every step. */
function runPresent(s: OnlineSession, deliver: (m: GameMessage) => void, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    deliver({ t: "input", tick: i, moveX: 0, moveZ: 0, strike: false, pop: false, confirm: false });
    s.step(SIM_DT);
  }
}

/** A well-formed snapshot, with any field overridden. */
function snapshot(over: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    t: "snap",
    tick: 1,
    ballPos: { x: 0, y: 1, z: 0 },
    ballVel: { x: 0, y: 0, z: 0 },
    ballHeld: false,
    hostPos: { x: -3, y: 0.4, z: 0 },
    guestPos: { x: 3, y: 0.4, z: 0 },
    hostVel: { x: 0, y: 0, z: 0 },
    guestVel: { x: 0, y: 0, z: 0 },
    hostClip: null,
    guestClip: null,
    score: [0, 0],
    sets: [0, 0],
    serveOwner: "player",
    phase: "rally",
    ...over,
  };
}

describe("session setup", () => {
  it("puts the match into two-human mode", () => {
    // Online is a versus match whose second seat is a socket, so the host
    // drives the opponent through the same field split screen uses.
    const { match } = session();
    expect(match.versus).toBe(true);
  });

  it("stops sending once disposed", () => {
    const { s, sent } = session({}, "guest");
    s.dispose();
    s.step(SIM_DT);
    expect(sent).toHaveLength(0);
  });
});

describe("opponent presence", () => {
  it("says nothing while the opponent keeps playing", () => {
    const onOpponentAbsent = vi.fn();
    const { s, deliver } = session({ onOpponentAbsent });

    runPresent(s, deliver, ABSENT_AFTER_SECONDS + 3);

    expect(onOpponentAbsent).not.toHaveBeenCalled();
  });

  it("starts a countdown once the opponent goes quiet", () => {
    const seen: number[] = [];
    const { s } = session({ onOpponentAbsent: (left) => seen.push(left) });

    run(s, ABSENT_AFTER_SECONDS + 1);

    expect(seen.length).toBeGreaterThan(0);
    // Counts down rather than up, and starts near the full grace.
    expect(seen[0]).toBeGreaterThan(DISCONNECT_GRACE_SECONDS - 1);
    expect(seen[seen.length - 1]).toBeLessThan(seen[0]);
  });

  it("awards the match after the grace period", () => {
    const onOpponentForfeit = vi.fn();
    const { s } = session({ onOpponentForfeit });

    run(s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS - 1);
    expect(onOpponentForfeit).not.toHaveBeenCalled();

    run(s, 2);
    expect(onOpponentForfeit).toHaveBeenCalledTimes(1);
  });

  it("awards the match only once, however long the wait continues", () => {
    const onOpponentForfeit = vi.fn();
    const { s } = session({ onOpponentForfeit });

    run(s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS + 30);

    expect(onOpponentForfeit).toHaveBeenCalledTimes(1);
  });

  it("cancels the countdown if the opponent comes back in time", () => {
    const onOpponentReturned = vi.fn();
    const onOpponentForfeit = vi.fn();
    const { s, deliver } = session({ onOpponentReturned, onOpponentForfeit });

    run(s, ABSENT_AFTER_SECONDS + 3); // gone, but not long enough
    runPresent(s, deliver, 1); // back

    expect(onOpponentReturned).toHaveBeenCalledTimes(1);
    expect(onOpponentForfeit).not.toHaveBeenCalled();
  });

  it("gives a returning opponent the full grace again", () => {
    const onOpponentForfeit = vi.fn();
    const { s, deliver } = session({ onOpponentForfeit });

    // Two long absences, each short of the grace, with a recovery between.
    run(s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS - 2);
    runPresent(s, deliver, 0.5);
    run(s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS - 2);

    expect(onOpponentForfeit).not.toHaveBeenCalled();
  });

  it("starts counting immediately on a clean disconnect", () => {
    // The relay said they left, so there is no need to wait out the silence.
    const onOpponentAbsent = vi.fn();
    const { s, deliver, setPeer } = session({ onOpponentAbsent });

    runPresent(s, deliver, 1);
    expect(onOpponentAbsent).not.toHaveBeenCalled();

    setPeer(false);
    s.step(SIM_DT);
    expect(onOpponentAbsent).toHaveBeenCalled();
  });

  it("stops tracking after dispose", () => {
    const onOpponentForfeit = vi.fn();
    const { s } = session({ onOpponentForfeit });
    s.dispose();

    run(s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS + 5);

    expect(onOpponentForfeit).not.toHaveBeenCalled();
  });
});

describe("host and guest exchange", () => {
  it("has the guest send its controls, not its position", () => {
    const g = session({}, "guest");
    g.s.setLocalInput({ moveX: 1, moveZ: -0.5, strikePressed: true, popPressed: false, confirmPressed: false });
    g.s.step(SIM_DT);

    const inputs = g.sent.filter((m) => m.t === "input");
    expect(inputs).toHaveLength(1);
    // Reflected on the way out: the guest's world is the host's mirrored, so
    // pushing right in its own frame is pushing left in the host's.
    expect(inputs[0]).toMatchObject({ moveX: -1, moveZ: 0.5, strike: true });
    // A guest is authoritative for nothing, so it publishes no state.
    expect(g.sent.some((m) => m.t === "snap")).toBe(false);
  });

  it("sends a guest press once, not on every step until released", () => {
    const g = session({}, "guest");
    g.s.setLocalInput({ moveX: 0, moveZ: 0, strikePressed: true, popPressed: false, confirmPressed: false });
    g.s.step(SIM_DT);
    g.s.step(SIM_DT);

    const strikes = g.sent.filter((m) => m.t === "input" && m.strike);
    expect(strikes).toHaveLength(1);
  });

  it("keeps a press that arrived between sends", () => {
    // The render loop can hand over two frames before a step consumes them.
    const g = session({}, "guest");
    g.s.setLocalInput({ moveX: 0, moveZ: 0, strikePressed: true, popPressed: false, confirmPressed: false });
    g.s.setLocalInput({ moveX: 0, moveZ: 0, strikePressed: false, popPressed: false, confirmPressed: false });
    g.s.step(SIM_DT);

    expect(g.sent.filter((m) => m.t === "input" && m.strike)).toHaveLength(1);
  });

  it("has the host publish snapshots at a fraction of the simulation rate", () => {
    const h = session({}, "host");
    run(h.s, 1);

    const snaps = h.sent.filter((m) => m.t === "snap");
    expect(snaps.length).toBeGreaterThanOrEqual(18);
    expect(snaps.length).toBeLessThanOrEqual(22);
    // The host is authoritative, so it never sends its controls anywhere.
    expect(h.sent.some((m) => m.t === "input")).toBe(false);
  });

  it("carries everything a frame needs in one message", () => {
    // Split across messages, a ball could arrive belonging to a different tick
    // than the score it was won by, and the two screens would disagree.
    const h = session({}, "host");
    run(h.s, 0.1);
    const snap = h.sent.find((m) => m.t === "snap");

    expect(snap).toBeDefined();
    const frame = snap as SnapshotMessage;
    expect(typeof frame.ballHeld).toBe("boolean");
    expect(frame.score).toHaveLength(2);
    expect(frame.sets).toHaveLength(2);
    expect(["player", "ai"]).toContain(frame.serveOwner);
  });

  it("feeds the guest's controls into the match's second seat", () => {
    const h = session({}, "host");
    h.deliver({ t: "input", tick: 1, moveX: 0.5, moveZ: -1, strike: true, pop: false, confirm: false });

    expect(h.match.versusInput).toMatchObject({ moveX: 0.5, moveZ: -1, strikePressed: true });
  });

  it("ignores controls arriving at a guest, and snapshots arriving at a host", () => {
    const g = session({}, "guest");
    g.deliver({ t: "input", tick: 1, moveX: 1, moveZ: 1, strike: true, pop: false, confirm: false });
    expect(g.match.versusInput.moveX).toBe(0);

    const h = session({}, "host");
    const before = h.match.score.player;
    h.deliver(snapshot({ score: [7, 3] }));
    expect(h.match.score.player).toBe(before);
  });

  it("holds a guest press until a step consumes it", () => {
    // The guest's frame rate is not the host's; a press that arrives between
    // steps must survive to the next one rather than being overwritten.
    const h = session({}, "host");
    h.deliver({ t: "input", tick: 1, moveX: 0, moveZ: 0, strike: true, pop: false, confirm: false });
    h.deliver({ t: "input", tick: 2, moveX: 0, moveZ: 0, strike: false, pop: false, confirm: false });

    expect(h.match.versusInput.strikePressed).toBe(true);
  });
});

describe("guest applies the authoritative frame", () => {
  it("hands the host's score, sets and serve to the match", () => {
    const g = session({}, "guest");
    g.deliver(snapshot({ score: [5, 2], sets: [1, 0], serveOwner: "ai" }));

    expect(g.applySnapshot).toHaveBeenCalledTimes(1);
    // Scores arrive as [host, guest] and are swapped into [me, them]; the
    // serving side flips with the seats for the same reason.
    expect(g.applySnapshot.mock.calls[0][0]).toMatchObject({
      score: [2, 5],
      sets: [0, 1],
      serveOwner: "player",
    });
  });

  it("hands over the ball, including whether it is being held", () => {
    const g = session({}, "guest");
    g.deliver(snapshot({ ballPos: { x: 1, y: 2, z: 3 }, ballVel: { x: 4, y: 5, z: 6 }, ballHeld: true }));

    // Position and velocity reflect through the net; height is untouched.
    expect(g.applySnapshot.mock.calls[0][0]).toMatchObject({
      ballPos: { x: -1, y: 2, z: -3 },
      ballVel: { x: -4, y: 5, z: -6 },
      ballHeld: true,
    });
  });

  it("names the seats from the receiver's point of view", () => {
    // reframe has already swapped them, so what the host called "host" is this
    // peer. Getting this backwards puts each player in the other's body.
    const g = session({}, "guest");
    g.deliver(snapshot({ hostPos: { x: -2, y: 0.4, z: 1 }, guestPos: { x: 2, y: 0.4, z: -1 } }));

    const arg = g.applySnapshot.mock.calls[0][0] as { selfPos: { x: number }; opponentPos: { x: number } };
    expect(arg.selfPos.x).toBe(-2);
    expect(arg.opponentPos.x).toBe(2);
  });

  it("drops a malformed snapshot rather than wrecking the whole display", () => {
    const g = session({}, "guest");
    g.deliver({ ...snapshot({}), ballPos: { x: NaN, y: 0, z: 0 } });

    expect(g.applySnapshot).not.toHaveBeenCalled();
  });
});

/** A session that may ask for a pause, plus a log of the states it passed through. */
function pausable(role: "host" | "guest" = "host") {
  const states: PauseState[] = [];
  const details: (string | undefined)[] = [];
  const ctx = session({ onPauseState: (st, d) => { states.push(st); details.push(d); } }, role);
  ctx.s.pauseAllowed = true;
  return { ...ctx, states, details };
}

describe("pausing an online match", () => {
  it("is refused outright in a quick match", () => {
    // The opponent is a stranger there, and a pause becomes a way to stall.
    const { s, sent } = session({}, "host");
    s.requestPause();

    expect(sent.filter((m) => m.t === "pause")).toHaveLength(0);
    expect(s.pauseState).toBe("none");
    expect(s.isPaused).toBe(false);
  });

  it("asks rather than pausing unilaterally", () => {
    const { s, sent, states } = pausable();
    s.requestPause();

    expect(sent.filter((m) => m.t === "pause")).toMatchObject([{ action: "request" }]);
    expect(states).toEqual(["asking"]);
    // Nothing is frozen until the opponent agrees.
    expect(s.isPaused).toBe(false);
  });

  it("pauses both peers once the opponent accepts", () => {
    const { s, deliver } = pausable();
    s.requestPause();
    deliver({ t: "pause", tick: 1, action: "accept" });

    expect(s.pauseState).toBe("paused");
    expect(s.isPaused).toBe(true);
  });

  it("carries on, with an explanation, when declined", () => {
    const { s, deliver, states, details } = pausable();
    s.requestPause();
    deliver({ t: "pause", tick: 1, action: "decline" });

    expect(s.isPaused).toBe(false);
    expect(states).toEqual(["asking", "none"]);
    expect(details[1]).toMatch(/declined/i);
  });

  it("offers the choice to whoever is asked", () => {
    const { s, deliver, states } = pausable();
    deliver({ t: "pause", tick: 1, action: "request" });

    expect(states).toEqual(["asked"]);
    expect(s.isPaused).toBe(false);
  });

  it("only the asked peer may answer", () => {
    // Answering your own request would pause a game the other player never
    // agreed to stop.
    const { s, sent } = pausable();
    s.requestPause();
    sent.length = 0;
    s.respondToPause(true);

    expect(sent).toHaveLength(0);
    expect(s.isPaused).toBe(false);
  });

  it("lets either player resume, so neither can hold the other hostage", () => {
    for (const answerer of [true, false]) {
      const { s, deliver, sent } = pausable();
      if (answerer) {
        s.requestPause();
        deliver({ t: "pause", tick: 1, action: "accept" });
      } else {
        deliver({ t: "pause", tick: 1, action: "request" });
        s.respondToPause(true);
      }
      expect(s.isPaused).toBe(true);

      sent.length = 0;
      s.resume();
      expect(s.isPaused).toBe(false);
      expect(sent.filter((m) => m.t === "pause")).toMatchObject([{ action: "resume" }]);
    }
  });

  it("resumes when told to by the opponent", () => {
    const { s, deliver } = pausable();
    deliver({ t: "pause", tick: 1, action: "request" });
    s.respondToPause(true);
    deliver({ t: "pause", tick: 2, action: "resume" });

    expect(s.isPaused).toBe(false);
  });

  it("gives up on a request nobody answers", () => {
    // An opponent who put the phone down should not leave the asker stuck in
    // a dialog for the rest of the match.
    const { s, states, details } = pausable();
    s.requestPause();

    run(s, PAUSE_REQUEST_TIMEOUT_SECONDS - 1);
    expect(s.pauseState).toBe("asking");

    run(s, 2);
    expect(s.pauseState).toBe("none");
    expect(details[details.length - 1]).toMatch(/no answer/i);
    expect(states).toEqual(["asking", "none"]);
  });

  it("agrees when both ask at once", () => {
    // Two requests crossing on the wire must not deadlock or double-pause.
    const { s, deliver, sent } = pausable();
    s.requestPause();
    deliver({ t: "pause", tick: 1, action: "request" });

    // Our own request stands; the crossing one does not overwrite it.
    expect(s.pauseState).toBe("asking");
    deliver({ t: "pause", tick: 2, action: "accept" });
    expect(s.isPaused).toBe(true);
    expect(sent.filter((m) => m.t === "pause")).toMatchObject([{ action: "request" }]);
  });

  it("accepts a request that arrives after it already paused", () => {
    const { s, deliver, sent } = pausable();
    deliver({ t: "pause", tick: 1, action: "request" });
    s.respondToPause(true);
    sent.length = 0;

    // The opponent asked again — a retry, or a message that overtook ours.
    deliver({ t: "pause", tick: 2, action: "request" });

    expect(s.isPaused).toBe(true);
    expect(sent.filter((m) => m.t === "pause")).toMatchObject([{ action: "accept" }]);
  });

  it("ignores a malformed pause frame", () => {
    const { s, deliver } = pausable();
    deliver({ t: "pause", tick: 1, action: "nap" } as unknown as GameMessage);
    expect(s.pauseState).toBe("none");
  });

  it("keeps talking while paused, so a pause is never read as a walkout", () => {
    // Freezing the traffic too would start the forfeit countdown and hand the
    // match away during the pause it was meant to allow.
    const onOpponentForfeit = vi.fn();
    const states: PauseState[] = [];
    const ctx = session({ onOpponentForfeit, onPauseState: (st) => states.push(st) }, "host");
    ctx.s.pauseAllowed = true;
    ctx.deliver({ t: "pause", tick: 1, action: "request" });
    ctx.s.respondToPause(true);

    for (let i = 0; i < Math.round((DISCONNECT_GRACE_SECONDS + 5) / SIM_DT); i++) {
      ctx.deliver({ t: "input", tick: i, moveX: 0, moveZ: 0, strike: false, pop: false, confirm: false });
      ctx.s.step(SIM_DT);
    }

    expect(ctx.s.isPaused).toBe(true);
    expect(onOpponentForfeit).not.toHaveBeenCalled();
  });

  it("still forfeits if the opponent vanishes during a pause", () => {
    const onOpponentForfeit = vi.fn();
    const ctx = session({ onOpponentForfeit }, "host");
    ctx.s.pauseAllowed = true;
    ctx.deliver({ t: "pause", tick: 1, action: "request" });
    ctx.s.respondToPause(true);

    run(ctx.s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS + 2);

    expect(onOpponentForfeit).toHaveBeenCalledTimes(1);
  });
});
