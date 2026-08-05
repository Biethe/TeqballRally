import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SIM_DT } from "../src/config";
import type { MatchController, MatchEvent } from "../src/match";
import type { NetConnection } from "../src/net/connection";
import type { NetHandlers } from "../src/net/connection";
import {
  ABSENT_AFTER_SECONDS,
  DISCONNECT_GRACE_SECONDS,
  OnlineSession,
  type SessionHandlers,
} from "../src/net/session";
import type { GameMessage } from "../src/net/protocol";

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

function fakeMatch() {
  const listeners = new Set<(e: MatchEvent) => void>();
  const match = {
    versus: false,
    remote: null,
    score: { player: 0, ai: 0 },
    sets: { player: 0, ai: 0 },
    serveOwner: "player",
    state: "rally",
    ball: { state: { pos: new Vector3(0, 1, 0), vel: new Vector3(0, 0, 0) } },
    chars: {
      player: { position: new Vector3(-3, 0.4, 0), velocity: new Vector3(0, 0, 0) },
      ai: { position: new Vector3(3, 0.4, 0), velocity: new Vector3(0, 0, 0), busy: false },
    },
    subscribe: (fn: (e: MatchEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    match: match as unknown as MatchController,
    emit: (e: MatchEvent) => listeners.forEach((l) => l(e)),
  };
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

/** Keep the opponent alive by feeding a pose every step. */
function runPresent(s: OnlineSession, deliver: (m: GameMessage) => void, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    deliver({ t: "move", tick: i, pos: { x: 3, y: 0.4, z: 0 }, yaw: 0, moveX: 0, moveZ: 0 });
    s.step(SIM_DT);
  }
}

describe("session setup", () => {
  it("puts the match into versus mode with a remote opponent", () => {
    const { s, match } = session();
    expect(match.versus).toBe(true);
    expect(match.remote).toBe(s.remote);
  });

  it("releases the match on dispose", () => {
    const { s, match } = session();
    s.dispose();
    expect(match.remote).toBeNull();
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

describe("outbound traffic", () => {
  it("sends a launch the moment it happens, not on the next pose tick", () => {
    const { s, sent, emit } = session();
    s.step(SIM_DT);
    sent.length = 0;

    emit({
      type: "ball-launched",
      side: "player",
      action: "strike",
      pos: new Vector3(-2, 1.2, 0.3),
      vel: new Vector3(6, 3, -1),
      clip: "RightFootKick",
      spin: 1.1,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "strike", clip: "RightFootKick", spin: 1.1 });
  });

  it("does not echo the opponent's own launches back to them", () => {
    const { s, sent, emit } = session();
    s.step(SIM_DT);
    sent.length = 0;

    emit({
      type: "ball-launched",
      side: "ai",
      action: "strike",
      pos: new Vector3(2, 1.2, 0),
      vel: new Vector3(-6, 3, 0),
      clip: "LeftFootKick",
      spin: 1,
    });

    expect(sent).toHaveLength(0);
  });

  it("sends poses at a fraction of the simulation rate", () => {
    const { s, sent } = session();
    run(s, 1);

    const moves = sent.filter((m) => m.t === "move");
    // 20 Hz, not 60 — smoothing on the far side covers the gap.
    expect(moves.length).toBeGreaterThanOrEqual(18);
    expect(moves.length).toBeLessThanOrEqual(22);
  });

  it("only lets the host announce points", () => {
    const point: MatchEvent = { type: "point-awarded", winner: "player", reason: "out" };

    const asHost = session({}, "host");
    asHost.s.step(SIM_DT);
    asHost.sent.length = 0;
    asHost.emit(point);
    expect(asHost.sent.filter((m) => m.t === "point")).toHaveLength(1);

    const asGuest = session({}, "guest");
    asGuest.s.step(SIM_DT);
    asGuest.sent.length = 0;
    asGuest.emit(point);
    expect(asGuest.sent.filter((m) => m.t === "point")).toHaveLength(0);
  });
});

describe("inbound score", () => {
  it("is applied by a guest and ignored by the host", () => {
    const state = {
      t: "state" as const,
      tick: 1,
      scorePlayer: 4,
      scoreAi: 2,
      setsPlayer: 1,
      setsAi: 0,
      serveOwner: "ai" as const,
      phase: "rally",
    };

    const onScore = vi.fn();
    const guest = session({ onScore }, "guest");
    guest.deliver(state);
    expect(onScore).toHaveBeenCalledTimes(1);

    const hostScore = vi.fn();
    const host = session({ onScore: hostScore }, "host");
    host.deliver(state);
    expect(hostScore).not.toHaveBeenCalled();
  });

  it("drops a malformed strike rather than poisoning the ball", () => {
    const { s, match } = session();
    const before = match.ball.state.pos.clone();

    s.step(SIM_DT);
    // NaN would propagate through every later physics step.
    (s as unknown as { onNetMessage: (m: unknown) => void }).onNetMessage({
      t: "strike",
      tick: 0,
      pos: { x: NaN, y: 1, z: 0 },
      vel: { x: 1, y: 1, z: 1 },
      clip: "ChestKick",
      spin: 1,
    });

    expect(match.ball.state.pos.x).toBe(before.x);
    expect(Number.isNaN(match.ball.state.pos.x)).toBe(false);
  });
});
