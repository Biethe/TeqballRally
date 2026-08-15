import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { GROUND_Y, SIM_DT, TABLE } from "../src/config";
import { solveLaunchClearingNet, stepBall, type BallState } from "../src/ball";
import {
  PROTOCOL_VERSION,
  applyStrike,
  decode,
  encode,
  makeRoomCode,
  makeStrike,
  type NetMessage,
} from "../src/net/protocol";

const PORT = 8900 + Math.floor(Math.random() * 500);
const URL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;

/** A WebSocket that buffers everything it receives so tests can await a match. */
class TestPeer {
  private socket: WebSocket;
  private inbox: NetMessage[] = [];
  private waiters: { match: (m: NetMessage) => boolean; resolve: (m: NetMessage) => void }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (ev) => {
      const msg = decode(String(ev.data));
      if (!msg) return;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
  }

  static async open(): Promise<TestPeer> {
    const socket = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    });
    return new TestPeer(socket);
  }

  send(msg: unknown): void {
    this.socket.send(typeof msg === "string" ? msg : encode(msg as NetMessage));
  }

  join(room: string): void {
    this.send({ t: "join", v: PROTOCOL_VERSION, room });
  }

  /** Resolve with the first buffered or future message matching `match`. */
  waitFor(match: (m: NetMessage) => boolean, timeoutMs = 4000): Promise<NetMessage> {
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitForType(t: string, timeoutMs?: number): Promise<NetMessage> {
    return this.waitFor((m) => m.t === t, timeoutMs);
  }

  close(): void {
    this.socket.close();
  }
}

beforeAll(async () => {
  relay = spawn("node", ["server/relay.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  // Poll the health endpoint rather than sleeping a fixed amount.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("relay did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}, 20_000);

afterAll(() => {
  relay?.kill("SIGTERM");
});

describe("relay seating", () => {
  it("gives the first peer host and the second guest", async () => {
    const room = makeRoomCode();
    const host = await TestPeer.open();
    host.join(room);
    const hostJoined = await host.waitForType("joined");
    expect(hostJoined).toMatchObject({ t: "joined", room, role: "host", ready: false });

    const guest = await TestPeer.open();
    guest.join(room);
    const guestJoined = await guest.waitForType("joined");
    expect(guestJoined).toMatchObject({ t: "joined", role: "guest", ready: true });

    // The host is told its opponent arrived.
    expect(await host.waitFor((m) => m.t === "peer")).toMatchObject({ joined: true });

    host.close();
    guest.close();
  });

  it("refuses a third peer instead of silently seating them", async () => {
    const room = makeRoomCode();
    const a = await TestPeer.open();
    const b = await TestPeer.open();
    a.join(room);
    b.join(room);
    await a.waitForType("joined");
    await b.waitForType("joined");

    const c = await TestPeer.open();
    c.join(room);
    expect(await c.waitForType("error")).toMatchObject({ reason: "room is full" });

    a.close();
    b.close();
    c.close();
  });

  it("frees the seat when a peer leaves, and tells the other", async () => {
    const room = makeRoomCode();
    const a = await TestPeer.open();
    const b = await TestPeer.open();
    // Seated one at a time on purpose. Sending both joins and only then
    // awaiting them leaves it to the relay which arrives first, so the host
    // seat goes to either peer — and this test then closes `b` expecting the
    // *guest* seat to be the one freed. When the race went the other way the
    // next peer came back as host and the assertion below failed in about
    // fifty milliseconds, which is what made it look like a flake.
    a.join(room);
    await a.waitForType("joined");
    b.join(room);
    await b.waitForType("joined");
    await a.waitFor((m) => m.t === "peer");

    b.close();
    expect(await a.waitFor((m) => m.t === "peer" && m.joined === false)).toBeTruthy();

    // The freed seat can be taken by a reconnecting player.
    const c = await TestPeer.open();
    c.join(room);
    expect(await c.waitForType("joined")).toMatchObject({ role: "guest" });

    a.close();
    c.close();
  });

  it("rejects a stale client by protocol version", async () => {
    const peer = await TestPeer.open();
    peer.send({ t: "join", v: PROTOCOL_VERSION + 1, room: makeRoomCode() });
    const err = await peer.waitForType("error");
    expect(err.t).toBe("error");
    expect((err as { reason: string }).reason).toMatch(/version/);
    peer.close();
  });

  it("rejects a malformed room code", async () => {
    const peer = await TestPeer.open();
    peer.send({ t: "join", v: PROTOCOL_VERSION, room: "no!" });
    expect(await peer.waitForType("error")).toMatchObject({ reason: "bad room code" });
    peer.close();
  });

  it("refuses to relay before a room is joined", async () => {
    const peer = await TestPeer.open();
    peer.send({ t: "ping", sent: 1, tick: 0 });
    expect(await peer.waitForType("error")).toMatchObject({ reason: "join a room first" });
    peer.close();
  });

  it("ignores frames that are not JSON without dropping the connection", async () => {
    const room = makeRoomCode();
    const a = await TestPeer.open();
    const b = await TestPeer.open();
    a.join(room);
    b.join(room);
    await a.waitForType("joined");
    await b.waitForType("joined");

    a.send("<not json>");
    // The socket must still work afterwards.
    a.send({ t: "ping", sent: 123, tick: 5 });
    expect(await b.waitForType("ping")).toMatchObject({ sent: 123 });

    a.close();
    b.close();
  });
});

describe("relay forwarding", () => {
  it("forwards in both directions and never echoes to the sender", async () => {
    const room = makeRoomCode();
    const host = await TestPeer.open();
    const guest = await TestPeer.open();
    host.join(room);
    guest.join(room);
    await host.waitForType("joined");
    await guest.waitForType("joined");

    host.send({ t: "ping", sent: 1, tick: 10 });
    expect(await guest.waitForType("ping")).toMatchObject({ sent: 1, tick: 10 });

    guest.send({ t: "pong", sent: 1, tick: 11 });
    expect(await host.waitForType("pong")).toMatchObject({ sent: 1, tick: 11 });

    // Nothing the host sent should have come back to it.
    await expect(host.waitForType("ping", 300)).rejects.toThrow(/timed out/);

    host.close();
    guest.close();
  });

  it("keeps rooms isolated from each other", async () => {
    const [roomA, roomB] = [makeRoomCode(), makeRoomCode()];
    const a1 = await TestPeer.open();
    const a2 = await TestPeer.open();
    const b1 = await TestPeer.open();
    a1.join(roomA);
    a2.join(roomA);
    b1.join(roomB);
    await Promise.all([a1.waitForType("joined"), a2.waitForType("joined"), b1.waitForType("joined")]);

    a1.send({ t: "ping", sent: 99, tick: 0 });
    expect(await a2.waitForType("ping")).toMatchObject({ sent: 99 });
    await expect(b1.waitForType("ping", 300)).rejects.toThrow(/timed out/);

    a1.close();
    a2.close();
    b1.close();
  });
});

describe("end-to-end authority handoff", () => {
  it("reproduces the striker's ball on the other peer, over a real socket", async () => {
    const room = makeRoomCode();
    const host = await TestPeer.open();
    const guest = await TestPeer.open();
    host.join(room);
    guest.join(room);
    await host.waitForType("joined");
    await guest.waitForType("joined");

    // The host strikes at tick 0 and keeps simulating one second of flight.
    const from = new Vector3(-2.6, 1.3, 0.2);
    const target = new Vector3(1.1, GROUND_Y + TABLE.hCenter, -0.3);
    const hostBall: BallState = { pos: from.clone(), vel: solveLaunchClearingNet(from, target, 0.5) };
    host.send(makeStrike(0, hostBall, "RightFootKick"));

    const TOTAL = 60;
    for (let i = 0; i < TOTAL; i++) stepBall(hostBall, SIM_DT);

    // The guest hears it at tick 5 (≈83 ms of transit), catches up and runs
    // the rest itself.
    const received = await guest.waitForType("strike");
    expect(received).toMatchObject({ t: "strike", clip: "RightFootKick" });

    const guestBall: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
    applyStrike(guestBall, received as ReturnType<typeof makeStrike>, 5);
    for (let i = 0; i < TOTAL - 5; i++) stepBall(guestBall, SIM_DT);

    // Same tick, same position — through JSON, a socket and the relay.
    expect(guestBall.pos.x).toBeCloseTo(hostBall.pos.x, 9);
    expect(guestBall.pos.y).toBeCloseTo(hostBall.pos.y, 9);
    expect(guestBall.pos.z).toBeCloseTo(hostBall.pos.z, 9);

    host.close();
    guest.close();
  });
});
