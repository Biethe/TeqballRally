import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { GROUND_Y, SIM_DT, TABLE } from "../src/config";
import { solveLaunchClearingNet, stepBall, type BallState } from "../src/ball";
import { NetConnection, type NetState } from "../src/net/connection";
import { applyStrike, makeRoomCode, makeStrike, type GameMessage } from "../src/net/protocol";

const PORT = 8600 + Math.floor(Math.random() * 300);
const URL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;
const open: NetConnection[] = [];

/** Track a connection so a failing test cannot leak a socket into the next one. */
function track(c: NetConnection): NetConnection {
  open.push(c);
  return c;
}

function waitFor<T>(get: () => T | null, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const v = get();
      if (v !== null) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

beforeAll(async () => {
  relay = spawn("node", ["server/relay.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("relay did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}, 20_000);

afterAll(() => {
  for (const c of open) c.close();
  relay?.kill("SIGTERM");
});

describe("joining", () => {
  it("seats the first peer as host, still waiting for an opponent", async () => {
    const host = track(new NetConnection(URL));
    const seat = await host.join(makeRoomCode());

    expect(seat).toEqual({ role: "host", ready: false });
    expect(host.status).toBe("waiting");
    host.close();
  });

  it("flips both peers to ready once the second arrives", async () => {
    const room = makeRoomCode();
    const states: NetState[] = [];
    const host = track(new NetConnection(URL, { onStateChange: (s) => states.push(s) }));
    await host.join(room);
    expect(host.status).toBe("waiting");

    const guest = track(new NetConnection(URL));
    const seat = await guest.join(room);

    expect(seat).toEqual({ role: "guest", ready: true });
    await waitFor(() => (host.status === "ready" ? true : null));
    expect(states).toContain("connecting");
    expect(states).toContain("waiting");
    expect(states).toContain("ready");

    host.close();
    guest.close();
  });

  it("reports the peer leaving and drops back to waiting", async () => {
    const room = makeRoomCode();
    const peerEvents: boolean[] = [];
    const host = track(new NetConnection(URL, { onPeer: (p) => peerEvents.push(p) }));
    await host.join(room);
    const guest = track(new NetConnection(URL));
    await guest.join(room);
    await waitFor(() => (host.status === "ready" ? true : null));

    guest.close();

    await waitFor(() => (host.status === "waiting" ? true : null));
    expect(peerEvents).toEqual([true, false]);
    host.close();
  });

  it("rejects a full room with a usable reason", async () => {
    const room = makeRoomCode();
    const a = track(new NetConnection(URL));
    const b = track(new NetConnection(URL));
    await a.join(room);
    await b.join(room);

    let reported: string | null = null;
    const c = track(new NetConnection(URL, { onError: (r) => (reported = r) }));
    await expect(c.join(room)).rejects.toThrow(/full/);
    expect(reported).toMatch(/full/);
    expect(c.status).toBe("closed");

    a.close();
    b.close();
  });

  it("fails cleanly when the server is not there", async () => {
    const dead = track(new NetConnection("ws://127.0.0.1:1"));
    await expect(dead.join(makeRoomCode())).rejects.toThrow();
    expect(dead.status).toBe("closed");
  });

  it("refuses a second join on the same connection", async () => {
    const c = track(new NetConnection(URL));
    await c.join(makeRoomCode());
    await expect(c.join(makeRoomCode())).rejects.toThrow(/already connected/);
    c.close();
  });
});

describe("getting back in after a drop", () => {
  /**
   * The failure this exists for is a phone, not a server.
   *
   * A handover from Wi-Fi to cellular, a lift, a tunnel: a mobile socket dies
   * for a few seconds constantly, and before this it cost the match. The relay
   * needs no part in it — a closed socket frees its seat while the room lives
   * on for the opponent, so rejoining by the same code lands back in the same
   * room against the same person.
   */
  it("reclaims its seat and keeps the opponent", async () => {
    const room = makeRoomCode();
    let backIn = false;
    const host = track(
      new NetConnection(URL, { onReconnected: () => (backIn = true) })
    );
    const guest = track(new NetConnection(URL));
    await host.join(room);
    await guest.join(room);
    await waitFor(() => (host.status === "ready" ? true : null));

    // Kill the socket the way a network does: without telling anybody.
    (host as unknown as { socket: WebSocket | null }).socket?.close();

    await waitFor(() => (backIn ? true : null), 8000);
    expect(host.status).toBe("ready");
    expect(host.room).toBe(room);

    // And the room is the same one: a message still reaches the opponent.
    const heard: GameMessage[] = [];
    guest.setHandlers({ onMessage: (m) => heard.push(m) });
    const ball = { pos: new Vector3(0, 1, 0), vel: new Vector3(1, 2, 0), spin: 1 };
    host.send(makeStrike(0, ball, "RightFootKick"));
    await waitFor(() => (heard.length ? heard : null));
    expect(heard[0].t).toBe("strike");
  }, 20_000);

  it("does not chase a room the player deliberately left", async () => {
    const room = makeRoomCode();
    let tried = false;
    const conn = track(new NetConnection(URL, { onReconnecting: () => (tried = true) }));
    await conn.join(room);
    conn.close();
    await new Promise((r) => setTimeout(r, 1200));

    expect(tried).toBe(false);
    expect(conn.status).toBe("closed");
  }, 10_000);
});

describe("messaging", () => {
  async function pair(): Promise<[NetConnection, NetConnection, GameMessage[], GameMessage[]]> {
    const room = makeRoomCode();
    const hostInbox: GameMessage[] = [];
    const guestInbox: GameMessage[] = [];
    const host = track(new NetConnection(URL, { onMessage: (m) => hostInbox.push(m) }));
    await host.join(room);
    const guest = track(new NetConnection(URL, { onMessage: (m) => guestInbox.push(m) }));
    await guest.join(room);
    await waitFor(() => (host.status === "ready" ? true : null));
    return [host, guest, hostInbox, guestInbox];
  }

  it("stamps outgoing messages with the current tick", async () => {
    const [host, guest, , guestInbox] = await pair();

    host.tick = 123;
    host.send({ t: "move", pos: { x: 1, y: 2, z: 3 }, yaw: 0.5, moveX: 0, moveZ: 1 });

    const got = await waitFor(() => guestInbox.find((m) => m.t === "move") ?? null);
    expect(got).toMatchObject({ tick: 123, yaw: 0.5 });

    host.close();
    guest.close();
  });

  it("does not deliver signalling frames as game messages", async () => {
    const [host, guest, hostInbox, guestInbox] = await pair();

    // Both peers have exchanged joined/peer frames by now. The handler's type
    // already claims signalling cannot reach it; this checks the claim holds at
    // runtime, since `receive` casts on the way out.
    const signalling = (inbox: GameMessage[]) =>
      inbox.some((m) => (m.t as string) === "joined" || (m.t as string) === "peer");
    expect(signalling(hostInbox)).toBe(false);
    expect(signalling(guestInbox)).toBe(false);

    host.close();
    guest.close();
  });

  it("answers a ping so the sender can measure its round trip", async () => {
    const [host, guest] = await pair();

    // The ping loop runs on a timer; drive one directly for determinism.
    host.tick = 7;
    (host as unknown as { rawSend: (m: unknown) => void }).rawSend({
      t: "ping",
      sent: Date.now(),
      tick: 7,
    });

    await waitFor(() => (host.rttMs !== null ? true : null));
    expect(host.rttMs).toBeGreaterThanOrEqual(0);
    expect(host.rttMs).toBeLessThan(2000);

    host.close();
    guest.close();
  });

  it("converts round trip into a one-way tick estimate", () => {
    const c = track(new NetConnection(URL));
    expect(c.latencyTicks).toBe(0); // no measurement yet

    (c as unknown as { rttMs: number }).rttMs = 100; // 100 ms round trip
    expect(c.latencyTicks).toBe(3); // ≈50 ms one way, 3 ticks at 60 Hz
  });

  it("drops sends before the room is ready rather than throwing", async () => {
    const host = track(new NetConnection(URL));
    await host.join(makeRoomCode());
    expect(host.status).toBe("waiting");

    expect(() => host.send({ t: "move", pos: { x: 0, y: 0, z: 0 }, yaw: 0, moveX: 0, moveZ: 0 })).not.toThrow();
    host.close();
  });
});

describe("a struck ball over the real connection", () => {
  it("arrives and reproduces the striker's trajectory", async () => {
    const room = makeRoomCode();
    const inbox: GameMessage[] = [];
    const host = track(new NetConnection(URL));
    await host.join(room);
    const guest = track(new NetConnection(URL, { onMessage: (m) => inbox.push(m) }));
    await guest.join(room);
    await waitFor(() => (host.status === "ready" ? true : null));

    const from = new Vector3(-2.6, 1.3, 0.2);
    const target = new Vector3(1.1, GROUND_Y + TABLE.hCenter, -0.3);
    const hostBall: BallState = { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };

    host.tick = 0;
    host.send(makeStrike(0, hostBall, "RightFootKick", 1.2));

    const TOTAL = 60;
    for (let i = 0; i < TOTAL; i++) stepBall(hostBall, SIM_DT);

    const msg = await waitFor(() => inbox.find((m) => m.t === "strike") ?? null);
    const guestBall: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
    applyStrike(guestBall, msg, 4);
    for (let i = 0; i < TOTAL - 4; i++) stepBall(guestBall, SIM_DT);

    expect(guestBall.pos.x).toBeCloseTo(hostBall.pos.x, 9);
    expect(guestBall.pos.y).toBeCloseTo(hostBall.pos.y, 9);
    expect(guestBall.pos.z).toBeCloseTo(hostBall.pos.z, 9);

    host.close();
    guest.close();
  });
});
