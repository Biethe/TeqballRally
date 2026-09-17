import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SIM_DT } from "../src/config";
import type { HostNetEvent, MatchController } from "../src/match";
import type { NetConnection } from "../src/net/connection";
import type { NetHandlers } from "../src/net/connection";
import {
  ABSENT_AFTER_SECONDS,
  DISCONNECT_GRACE_SECONDS,
  OnlineSession,
  PAUSE_REQUEST_TIMEOUT_SECONDS,
  REMATCH_REQUEST_TIMEOUT_SECONDS,
  type PauseState,
  type SessionHandlers,
} from "../src/net/session";
import { MAX_CATCHUP_TICKS } from "../src/net/protocol";
import type { GameMessage, SnapshotMessage } from "../src/net/protocol";

/** A connection that records what was sent and lets a test drive its handlers. */
function fakeConn() {
  const sent: GameMessage[] = [];
  let handlers: NetHandlers = {};
  const newMatch = vi.fn();
  const conn = {
    tick: 0,
    send: (m: GameMessage) => sent.push(m),
    setHandlers: (next: Partial<NetHandlers>) => (handlers = { ...handlers, ...next }),
    // How stale an arriving frame is, and whether our own socket is the thing
    // that is missing. The session reads both.
    latencyTicks: 0,
    isReconnecting: false,
    newMatch,
  };
  return {
    conn: conn as unknown as NetConnection,
    sent,
    newMatch,
    deliver: (m: GameMessage) => handlers.onMessage?.(m),
    setPeer: (present: boolean) => handlers.onPeer?.(present),
    setLatency: (ticks: number) => (conn.latencyTicks = ticks),
    setReconnecting: (on: boolean) => (conn.isReconnecting = on),
  };
}

/**
 * A stand-in match. `applySnapshot` is a spy rather than a reimplementation:
 * the session's job is to translate the wire into that one call, and asserting
 * its arguments tests that without a fake pretending to be the controller.
 */
function fakeMatch() {
  const applySnapshot = vi.fn();
  const drainNet = vi.fn(() => [] as { kind: "kick" | "table" | "net" | "ground" | "side" | "body"; pos?: { x: number; y: number; z: number } }[]);
  const queueFx = vi.fn();
  const takeNetEvents = vi.fn(() => [] as HostNetEvent[]);
  const queueLaunch = vi.fn();
  const queueClip = vi.fn();
  const setPlaybackLead = vi.fn();
  const usePlaybackBuffer = vi.fn();
  const recordBallAt = vi.fn();
  const match = {
    versus: false,
    netFollower: false,
    netPublish: false,
    versusPortrait: false,
    versusViewTick: null as number | null,
    tapSteering: false,
    renderTick: null as number | null,
    anchorState: { player: null, ai: null } as Record<
      "player" | "ai",
      { pos: Vector3; eta: number } | null
    >,
    strikeableSide: null as "player" | "ai" | null,
    touchCount: 0,
    score: { player: 0, ai: 0 },
    sets: { player: 0, ai: 0 },
    tally: { points: { player: 0, ai: 0 }, longRallies: 0 },
    serveOwner: "player",
    state: "rally",
    versusInput: { moveX: 0, moveZ: 0, strikePressed: false, strikeHeld: false, strikePower: 0, popPressed: false, confirmPressed: false },
    lockedState: { player: false, ai: false },
    clipWindow: { player: null, ai: null } as Record<
      "player" | "ai",
      { clip: string; from: number; to: number } | null
    >,
    matchWinner: null,
    ball: { state: { pos: new Vector3(0, 1, 0), vel: new Vector3(0, 0, 0) }, held: false },
    chars: {
      player: { position: new Vector3(-3, 0.4, 0), velocity: new Vector3(0, 0, 0), currentActionClip: null as string | null },
      ai: { position: new Vector3(3, 0.4, 0), velocity: new Vector3(0, 0, 0), busy: false, currentActionClip: null as string | null },
    },
    applySnapshot,
    drainNet,
    queueFx,
    takeNetEvents,
    queueLaunch,
    queueClip,
    setPlaybackLead,
    usePlaybackBuffer,
    recordBallAt,
  };
  return {
    match: match as unknown as MatchController,
    applySnapshot,
    drainNet,
    queueFx,
    takeNetEvents,
    queueLaunch,
    queueClip,
    setPlaybackLead,
    recordBallAt,
    fake: match,
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

  it("never forfeits a match that already has a winner", () => {
    // Once the last set is decided the result is fixed on both screens; an
    // opponent leaving the result screen is not a walkout, and awarding one
    // would hand the loser a win they lost.
    const onOpponentAbsent = vi.fn();
    const onOpponentForfeit = vi.fn();
    const { s, match } = session({ onOpponentAbsent, onOpponentForfeit });
    (match as unknown as { matchWinner: string | null }).matchWinner = "player";

    run(s, ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS + 30);

    expect(onOpponentAbsent).not.toHaveBeenCalled();
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
    g.s.setLocalInput({
      moveX: 1,
      moveZ: -0.5,
      strikePressed: true,
      strikeHeld: false,
      strikePower: 0.8,
      popPressed: false,
      confirmPressed: false,
    });
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
    g.s.setLocalInput({ moveX: 0, moveZ: 0, strikePressed: true, strikeHeld: false, strikePower: 0, popPressed: false, confirmPressed: false });
    g.s.step(SIM_DT);
    g.s.step(SIM_DT);

    const strikes = g.sent.filter((m) => m.t === "input" && m.strike);
    expect(strikes).toHaveLength(1);
  });

  it("keeps a press that arrived between sends", () => {
    // The render loop can hand over two frames before a step consumes them.
    const g = session({}, "guest");
    g.s.setLocalInput({ moveX: 0, moveZ: 0, strikePressed: true, strikeHeld: false, strikePower: 0, popPressed: false, confirmPressed: false });
    g.s.setLocalInput({ moveX: 0, moveZ: 0, strikePressed: false, strikeHeld: false, strikePower: 0, popPressed: false, confirmPressed: false });
    g.s.step(SIM_DT);

    expect(g.sent.filter((m) => m.t === "input" && m.strike)).toHaveLength(1);
  });

  it("has the host publish snapshots at a fraction of the simulation rate", () => {
    const h = session({}, "host");
    run(h.s, 1);

    const snaps = h.sent.filter((m) => m.t === "snap");
    expect(snaps.length).toBeGreaterThanOrEqual(28);
    expect(snaps.length).toBeLessThanOrEqual(32);
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

  it("publishes which seats' feet the run to the ball owns", () => {
    // The guest cannot see the host's run lock any other way, and without it
    // its local prediction fights the authoritative run every reception.
    const h = session({}, "host");
    h.match.lockedState.ai = true;
    run(h.s, 0.1);
    const snap = h.sent.find((m) => m.t === "snap") as SnapshotMessage;

    expect(snap.guestLocked).toBe(true);
    expect(snap.hostLocked).toBe(false);
  });

  it("feeds the guest's controls into the match's second seat", () => {
    const h = session({}, "host");
    h.deliver({ t: "input", tick: 1, moveX: 0.5, moveZ: -1, strike: true, pop: false, confirm: false });

    expect(h.match.versusInput).toMatchObject({ moveX: 0.5, moveZ: -1, strikePressed: true });
  });

  it("tells the host which scheme the guest is playing with", () => {
    // The two schemes do not mean the same thing by the same axes: a portrait
    // swipe is a carry and a pace, a landscape stick is an offset onto the
    // table. Read as a stick, a guest's swipe aimed every kick somewhere
    // nobody asked for, and its serve went looking for a tap count that
    // scheme never sends.
    const h = session({}, "host");
    h.deliver({
      t: "input", tick: 1, moveX: 0, moveZ: 0, strike: false, pop: false, confirm: false,
      portrait: true,
    });
    expect(h.match.versusPortrait).toBe(true);

    // An older peer sends nothing, and is landscape as it always was.
    h.deliver({ t: "input", tick: 2, moveX: 0, moveZ: 0, strike: false, pop: false, confirm: false });
    expect(h.match.versusPortrait).toBe(false);
  });

  it("sends its own scheme with every frame, from how the phone is held now", () => {
    const g = session({}, "guest");
    g.fake.tapSteering = true;
    run(g.s, SIM_DT);
    const frame = g.sent.find((m) => m.t === "input") as { portrait?: boolean };
    expect(frame.portrait).toBe(true);
  });

  it("marks a frame whose axes are a tapped placement, not a stick", () => {
    const h = session({}, "host");
    h.deliver({
      t: "input", tick: 1, moveX: 0.4, moveZ: 0.2, strike: false, pop: true, confirm: false,
      portrait: true, tapAim: true,
    });
    expect(h.match.versusInput).toMatchObject({ popPressed: true, tapAim: true });
  });

  it("publishes possession, which is the only way a guest's tap can mean a touch", () => {
    // A follower runs no rules. Without these two facts its tap can only ever
    // be a walk, which is why a joined player could take the automatic first
    // touch and then nothing at all.
    const h = session({}, "host");
    h.fake.strikeableSide = "ai";
    h.fake.touchCount = 2;
    run(h.s, 0.1);
    const snap = h.sent.find((m) => m.t === "snap") as SnapshotMessage;

    expect(snap.strikeable).toBe("guest");
    expect(snap.touches).toBe(2);
  });

  it("hands the guest possession in its own seat names", () => {
    const g = session({}, "guest");
    g.deliver(snapshot({ strikeable: "guest", touches: 1 }));
    expect(g.applySnapshot.mock.calls[0][0]).toMatchObject({ strikeable: "host", touches: 1 });
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

  it("carries each seat's clip window with its snapshot", () => {
    // The guest plays a clip at the fraction its window gives the playback
    // clock; without the window the animation restarts from zero on arrival.
    const h = session({}, "host");
    h.fake.chars.player.currentActionClip = "CenterHeadKick";
    h.fake.clipWindow.player = { clip: "CenterHeadKick", from: 50, to: 110 };
    run(h.s, 0.1);
    const snap = h.sent.find((m) => m.t === "snap") as SnapshotMessage;

    expect(snap.hostClipFrom).toBe(50);
    expect(snap.hostClipTo).toBe(110);
  });

  it("does not send a stale window beside a different clip", () => {
    const h = session({}, "host");
    h.fake.chars.player.currentActionClip = "ChestKick";
    h.fake.clipWindow.player = { clip: "CenterHeadKick", from: 50, to: 110 };
    run(h.s, 0.1);
    const snap = h.sent.find((m) => m.t === "snap") as SnapshotMessage;

    expect(snap.hostClipFrom).toBeUndefined();
    expect(snap.hostClipTo).toBeUndefined();
  });

  it("publishes the match's contact events stamped with the sim tick", () => {
    const h = session({}, "host");
    h.drainNet.mockReturnValue([{ kind: "kick" }, { kind: "table", pos: { x: 1, y: 0.9, z: 0 } }]);
    h.s.step(SIM_DT);

    const fx = h.sent.filter((m) => m.t === "fx");
    expect(fx).toHaveLength(2);
    expect(fx[0]).toMatchObject({ kind: "kick", tick: 1 });
    expect(fx[1]).toMatchObject({ kind: "table", pos: { x: 1, y: 0.9, z: 0 } });
    // Drained once: the same events must not ride out again next step.
    h.drainNet.mockReturnValue([]);
    h.s.step(SIM_DT);
    expect(h.sent.filter((m) => m.t === "fx")).toHaveLength(2);
  });

  it("freezes the sim tick during a negotiated pause", () => {
    // Snapshots, clip windows and fx events are all stamped in one clock, so
    // the clock stands still with the match instead of running on without it.
    const h = pausable("host");
    h.deliver({ t: "pause", tick: 1, action: "request" });
    h.s.respondToPause(true);
    run(h.s, 0.1);
    const snaps = h.sent.filter((m) => m.t === "snap");

    expect(snaps.length).toBeGreaterThan(1); // traffic keeps flowing
    expect(new Set(snaps.map((s) => s.tick)).size).toBe(1); // one frozen tick
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

  it("tells the guest when the host owns its feet", () => {
    // The host locks the guest's seat to the run toward the drop spot; the
    // guest must stop predicting from a stick the host is no longer listening
    // to, or the two race every reception. The flag swaps with the seats.
    const g = session({}, "guest");
    g.deliver(snapshot({ guestLocked: true, hostLocked: false }));

    expect(g.applySnapshot.mock.calls[0][0]).toMatchObject({ selfLocked: true });
  });

  it("reads an older host's missing lock flags as unlocked", () => {
    const g = session({}, "guest");
    g.deliver(snapshot());

    expect(g.applySnapshot.mock.calls[0][0]).toMatchObject({ selfLocked: false });
  });

  it("hands over clip windows swapped with the seats", () => {
    const g = session({}, "guest");
    g.deliver(
      snapshot({
        guestClip: "ChestKick",
        guestClipFrom: 10,
        guestClipTo: 40,
        hostClip: "RightKneeReception",
        hostClipFrom: 70,
        hostClipTo: 120,
      })
    );

    // After reframe, the host's "guest" seat is this peer.
    expect(g.applySnapshot.mock.calls[0][0]).toMatchObject({
      selfClip: "ChestKick",
      selfClipFrom: 10,
      selfClipTo: 40,
      opponentClip: "RightKneeReception",
      opponentClipFrom: 70,
      opponentClipTo: 120,
    });
  });

  it("delivers valid contact events to the match, and drops the rest", () => {
    const g = session({}, "guest");
    g.deliver({ t: "fx", tick: 5, kind: "kick" });
    g.deliver({ t: "fx", tick: 6, kind: "table", pos: { x: 1, y: 0.9, z: 0 } });
    // Deliberately malformed: the validator must drop them, not crash on them.
    g.deliver({ t: "fx", tick: 7, kind: "bogus" } as unknown as GameMessage);
    g.deliver({ t: "fx", kind: "kick" } as unknown as GameMessage);

    expect(g.queueFx).toHaveBeenCalledTimes(2);
    expect(g.queueFx.mock.calls[0][0]).toEqual({ tick: 5, kind: "kick" });
    expect(g.queueFx.mock.calls[1][0]).toEqual({ tick: 6, kind: "table" });
  });

  it("ignores contact events arriving at a host", () => {
    const h = session({}, "host");
    h.deliver({ t: "fx", tick: 5, kind: "kick" });

    expect(h.queueFx).not.toHaveBeenCalled();
  });

  it("sends the match's decisions before the snapshot of the same step", () => {
    // Ordered so that by the time a snapshot lands every decision about the
    // ticks it describes is already there, and the guest's check against it
    // can only fire for something genuinely missed.
    const h = session({}, "host");
    h.takeNetEvents.mockReturnValueOnce([
      { type: "clip", tick: 2, side: "ai", clip: "RightFootKick", startFrac: 0.3, speed: 1.3, seq: 4, lungeTo: { x: 3, y: 0.4, z: 0.2 }, lungeSeconds: 0.2 },
      { type: "launch", tick: 14, pos: { x: 3, y: 1.2, z: 0 }, vel: { x: -7, y: 3, z: 0 }, spin: 0.9, kick: true },
    ]);
    h.s.step(SIM_DT);
    h.s.step(SIM_DT);

    const order = h.sent.map((m) => m.t).filter((t) => t === "clip" || t === "launch" || t === "snap");
    expect(order).toEqual(["clip", "launch", "snap"]);
    // In the host's own frame, with its seat names put on the wire.
    expect(h.sent.find((m) => m.t === "clip")).toMatchObject({ seat: "guest", clip: "RightFootKick", seq: 4 });
    expect(h.sent.find((m) => m.t === "launch")).toMatchObject({ tick: 14, vel: { x: -7, y: 3, z: 0 }, kick: true });
  });

  it("hands decisions to the guest's match in its own frame and seat names", () => {
    const g = session({}, "guest");
    g.deliver({ t: "launch", tick: 30, pos: { x: 1, y: 1, z: 0.5 }, vel: { x: 4, y: 2, z: -1 }, spin: 1 });
    g.deliver({ t: "clip", tick: 28, seat: "guest", clip: "ChestReception", startFrac: 0.2, speed: 1.25, seq: 3 });
    g.deliver({ t: "clip", tick: 29, seat: "host", clip: null });
    // Malformed: dropped, not crashed on.
    g.deliver({ t: "launch", tick: 31, pos: { x: NaN, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spin: 1 });

    expect(g.queueLaunch).toHaveBeenCalledTimes(1);
    expect(g.queueLaunch.mock.calls[0][0]).toMatchObject({ tick: 30, pos: { x: -1, y: 1, z: -0.5 }, vel: { x: -4, y: 2, z: 1 }, kick: false });
    // The host's "guest" seat is this peer's own side.
    expect(g.queueClip.mock.calls[0][0]).toMatchObject({ tick: 28, side: "player", clip: "ChestReception", speed: 1.25 });
    expect(g.queueClip.mock.calls[1][0]).toMatchObject({ tick: 29, side: "ai", clip: null });
  });

  it("ignores decisions arriving at a host", () => {
    const h = session({}, "host");
    h.deliver({ t: "launch", tick: 30, pos: { x: 1, y: 1, z: 0 }, vel: { x: 4, y: 2, z: 0 }, spin: 1 });
    h.deliver({ t: "clip", tick: 28, seat: "guest", clip: "ChestReception" });

    expect(h.queueLaunch).not.toHaveBeenCalled();
    expect(h.queueClip).not.toHaveBeenCalled();
  });

  it("publishes the host's game speed, and reports a change of it to the guest once", () => {
    const h = session({}, "host");
    h.s.timeScale = 1.45;
    run(h.s, 0.1);
    expect((h.sent.find((m) => m.t === "snap") as SnapshotMessage).ts).toBe(1.45);

    const onTimeScale = vi.fn();
    const g = session({ onTimeScale }, "guest");
    g.deliver(snapshot({ ts: 1.45 }));
    g.deliver(snapshot({ tick: 2, ts: 1.45 }));
    g.deliver(snapshot({ tick: 3, ts: 1.25 }));
    // An older host says nothing, and nothing changes.
    g.deliver(snapshot({ tick: 4 }));
    expect(onTimeScale.mock.calls).toEqual([[1.45], [1.25]]);
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

describe("agreeing a rematch from the end screen", () => {
  /** The stand-in match has to be finished before a rematch means anything. */
  const finish = (m: MatchController) => {
    (m as unknown as { matchWinner: string | null }).matchWinner = "player";
  };

  it("asks the opponent and starts when they accept", () => {
    const onRematchState = vi.fn();
    const onRematch = vi.fn();
    const h = session({ onRematchState, onRematch }, "host");
    finish(h.match);

    h.s.requestRematch();
    expect(h.sent.some((m) => m.t === "rematch" && m.action === "request")).toBe(true);
    expect(onRematchState).toHaveBeenLastCalledWith("asking", undefined);

    h.deliver({ t: "rematch", tick: 2, action: "accept" });
    expect(onRematch).toHaveBeenCalledTimes(1);
    expect(h.s.rematchState).toBe("none");
  });

  it("has the host, and only the host, ask the relay for the fresh id", () => {
    const host = session({}, "host");
    finish(host.match);
    host.s.requestRematch();
    host.deliver({ t: "rematch", tick: 2, action: "accept" });
    expect(host.newMatch).toHaveBeenCalledTimes(1);

    const guest = session({}, "guest");
    finish(guest.match);
    guest.s.requestRematch();
    guest.deliver({ t: "rematch", tick: 2, action: "accept" });
    expect(guest.newMatch).not.toHaveBeenCalled();
  });

  it("carries a decline and leaves both on the result screen", () => {
    const onRematchState = vi.fn();
    const onRematch = vi.fn();
    const h = session({ onRematchState, onRematch }, "host");
    finish(h.match);

    h.s.requestRematch();
    h.deliver({ t: "rematch", tick: 2, action: "decline" });

    expect(onRematch).not.toHaveBeenCalled();
    expect(onRematchState).toHaveBeenLastCalledWith("none", "Your opponent declined");
  });

  it("presents the request to the one it was asked of", () => {
    const onRematchState = vi.fn();
    const g = session({ onRematchState }, "guest");
    finish(g.match);

    g.deliver({ t: "rematch", tick: 1, action: "request" });

    expect(onRematchState).toHaveBeenLastCalledWith("asked", undefined);
    expect(g.s.rematchState).toBe("asked");
  });

  it("reads two crossed requests as an agreement", () => {
    const onRematch = vi.fn();
    const g = session({ onRematch }, "guest");
    finish(g.match);

    g.s.requestRematch();
    g.deliver({ t: "rematch", tick: 2, action: "request" });

    expect(onRematch).toHaveBeenCalledTimes(1);
    expect(g.sent.some((m) => m.t === "rematch" && m.action === "accept")).toBe(true);
  });

  it("accepts a pending request when REMATCH is pressed anyway", () => {
    const onRematch = vi.fn();
    const g = session({ onRematch }, "guest");
    finish(g.match);

    g.deliver({ t: "rematch", tick: 1, action: "request" });
    g.s.requestRematch();

    expect(onRematch).toHaveBeenCalledTimes(1);
  });

  it("gives up on an unanswered request and says so", () => {
    const onRematchState = vi.fn();
    const h = session({ onRematchState }, "host");
    finish(h.match);

    h.s.requestRematch();
    run(h.s, REMATCH_REQUEST_TIMEOUT_SECONDS + 1);

    expect(onRematchState).toHaveBeenLastCalledWith("none", "No answer from your opponent");
  });

  it("ignores the button while the match is still being played", () => {
    const onRematchState = vi.fn();
    const h = session({ onRematchState }, "host");

    h.s.requestRematch();

    expect(h.sent.some((m) => m.t === "rematch")).toBe(false);
    expect(onRematchState).not.toHaveBeenCalled();
  });

  it("closes a negotiation the opponent leaves", () => {
    const onRematchState = vi.fn();
    const onRematch = vi.fn();
    const h = session({ onRematchState, onRematch }, "host");
    finish(h.match);

    h.s.requestRematch();
    h.setPeer(false);

    expect(onRematchState).toHaveBeenLastCalledWith("none", "Your opponent left");
    // A late accept from a departed peer starts nothing.
    h.deliver({ t: "rematch", tick: 3, action: "accept" });
    expect(onRematch).not.toHaveBeenCalled();
  });

  it("spends presses queued on the end screen before the new match", () => {
    const h = session({}, "host");
    finish(h.match);
    h.deliver({ t: "input", tick: 1, moveX: 0, moveZ: 0, strike: true, pop: false, confirm: false });
    expect(h.match.versusInput.strikePressed).toBe(true);

    h.s.requestRematch();
    h.deliver({ t: "rematch", tick: 2, action: "accept" });

    expect(h.match.versusInput.strikePressed).toBe(false);
  });

  it("ignores a malformed rematch frame", () => {
    const onRematchState = vi.fn();
    const g = session({ onRematchState }, "guest");
    finish(g.match);

    g.deliver({ t: "rematch", tick: 1, action: "resume" } as unknown as GameMessage);

    expect(onRematchState).not.toHaveBeenCalled();
  });
});

describe("showing everything at the same moment", () => {
  /**
   * The bug this exists for looked like a graphics fault and was not one.
   *
   * A guest simulates its own character at 60 Hz from its own controls, live,
   * and used to be handed the ball twenty times a second at wherever it had
   * been half a round trip ago. The player moved smoothly and the ball
   * stuttered against them — on the better phone with the worse connection,
   * worse. The frame's age has to travel with it so everything can be drawn at
   * one instant.
   */
  it("leads by the route's own delay, which only the round trip can measure", () => {
    // The estimator reports age *above the best route it has seen*, so on a
    // steady link it reads near zero however far away the host is. The half
    // round trip has to be the base, or a distant guest reads a moment its
    // frames left long ago and times every touch against it.
    const net = fakeConn();
    const match = fakeMatch();
    const session = new OnlineSession(net.conn, match.match, "guest");
    net.setLatency(5);

    for (let i = 0; i < 10; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 6 }));

    expect(match.applySnapshot).toHaveBeenCalledTimes(1);
    // Half the trip, plus the snapshot grid the newest frame sits on.
    expect(match.applySnapshot.mock.calls[0][1]).toBe(6);
    // The frame's own tick reaches the match; the playback buffer is keyed by it.
    expect(match.applySnapshot.mock.calls[0][0]).toMatchObject({ tick: 6 });
  });

  it("measures a slower frame against the fastest one seen", () => {
    const net = fakeConn();
    const match = fakeMatch();
    const session = new OnlineSession(net.conn, match.match, "guest");

    for (let i = 0; i < 10; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 6 })); // baseline: four ticks in flight
    for (let i = 0; i < 2; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 6 })); // six ticks in flight

    // The two extra ticks of wobble are led by, on top of the one-tick
    // snapshot grid, less the sliver of floor the estimator releases per
    // sample to absorb clock drift.
    const lead = match.applySnapshot.mock.calls[1][1] as number;
    expect(lead).toBeGreaterThan(2.9);
    expect(lead).toBeLessThanOrEqual(3);
  });

  it("leads by only so much wobble, however jittery the link", () => {
    // Leading past the frames is a stall on screen; a wandering link is
    // answered by the correction, not by reading ever further ahead.
    const net = fakeConn();
    const match = fakeMatch();
    const session = new OnlineSession(net.conn, match.match, "guest");

    for (let i = 0; i < 10; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 6 }));
    for (let i = 0; i < 40; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 6 }));

    expect(match.applySnapshot.mock.calls[1][1]).toBeLessThanOrEqual(4);
  });

  it("sets the playback clock by the one-way trip in simulation ticks, without a frame's jitter", () => {
    // The clock reads the best-routed of many frames, so this frame's jitter
    // is already out of it; counting it again made the clock wobble with every
    // late arrival. And a trip is measured in sixtieths of a second, which at
    // the host's 1.25 are 1.25 ticks each.
    const net = fakeConn();
    const match = fakeMatch();
    const session = new OnlineSession(net.conn, match.match, "guest");
    net.setLatency(8);

    for (let i = 0; i < 10; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 6, ts: 1.25 }));
    // A late frame: the one carried by its own age sees that age, the clock
    // does not.
    for (let i = 0; i < 12; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 8, ts: 1.25 }));
    session.step(SIM_DT);

    expect(match.setPlaybackLead.mock.calls.at(-1)![0]).toBe(10);
    expect(match.applySnapshot.mock.calls[1][1]).toBeGreaterThan(9);
  });

  it("absorbs an opponent whose tick clock started anywhere", () => {
    // The two sessions start their counters independently; the offset
    // between them is a constant the estimator calibrates out, so a host
    // ten thousand ticks ahead produces the identical ages.
    const run = (offset: number): number[] => {
      const net = fakeConn();
      const match = fakeMatch();
      const session = new OnlineSession(net.conn, match.match, "guest");
      for (let i = 0; i < 10; i++) session.step(SIM_DT);
      net.deliver(snapshot({ tick: 6 + offset }));
      for (let i = 0; i < 5; i++) session.step(SIM_DT);
      net.deliver(snapshot({ tick: 6 + offset }));
      return [
        match.applySnapshot.mock.calls[0][1] as number,
        match.applySnapshot.mock.calls[1][1] as number,
      ];
    };

    const plain = run(0);
    const shifted = run(10_000);
    expect(shifted[0]).toBeCloseTo(plain[0], 6);
    expect(shifted[1]).toBeCloseTo(plain[1], 6);
  });

  it("never fast-forwards further than the catch-up cap, however late a frame is", () => {
    const net = fakeConn();
    const match = fakeMatch();
    const session = new OnlineSession(net.conn, match.match, "guest");

    for (let i = 0; i < 10; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 9 })); // calibrates
    for (let i = 0; i < 600; i++) session.step(SIM_DT);
    net.deliver(snapshot({ tick: 10 })); // absurdly stale

    expect(match.applySnapshot.mock.calls[1][1]).toBeLessThanOrEqual(MAX_CATCHUP_TICKS);
  });
});

describe("a socket that is our own problem", () => {
  it("holds the forfeit clock while we are the ones reconnecting", () => {
    // Silence on a socket we are still rebuilding says nothing about the
    // opponent. Claiming a walkover here hands the match to whoever left.
    const net = fakeConn();
    const match = fakeMatch();
    let forfeited = false;
    const session = new OnlineSession(net.conn, match.match, "host", {
      onOpponentForfeit: () => (forfeited = true),
    });
    net.setReconnecting(true);

    for (let i = 0; i < (ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS + 5) / SIM_DT; i++) {
      session.step(SIM_DT);
    }

    expect(forfeited).toBe(false);
  });

  it("resumes counting once our own socket is back", () => {
    const net = fakeConn();
    const match = fakeMatch();
    let forfeited = false;
    const session = new OnlineSession(net.conn, match.match, "host", {
      onOpponentForfeit: () => (forfeited = true),
    });
    net.setReconnecting(true);
    for (let i = 0; i < 60; i++) session.step(SIM_DT);
    net.setReconnecting(false);
    for (let i = 0; i < (ABSENT_AFTER_SECONDS + DISCONNECT_GRACE_SECONDS + 1) / SIM_DT; i++) {
      session.step(SIM_DT);
    }

    expect(forfeited).toBe(true);
  });
});
