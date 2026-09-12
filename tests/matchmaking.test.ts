import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { NetConnection } from "../src/net/connection";

const PORT = 8300 + Math.floor(Math.random() * 200);
const URL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;
const open: NetConnection[] = [];

function track(c: NetConnection): NetConnection {
  open.push(c);
  return c;
}

async function health(): Promise<{ rooms: number; waiting: number }> {
  return (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as {
    rooms: number;
    waiting: number;
  };
}

function settle(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    await settle(100);
  }
}, 20_000);

afterAll(() => {
  for (const c of open) c.close();
  relay?.kill("SIGTERM");
});

describe("quick match", () => {
  it("pairs two strangers into a room neither had to know about", async () => {
    const a = track(new NetConnection(URL));
    const b = track(new NetConnection(URL));

    // The first player waits; the promise must not settle yet.
    let aSettled = false;
    const aSeat = a.quickMatch().then((v) => {
      aSettled = true;
      return v;
    });
    for (let i = 0; i < 50 && a.status !== "waiting"; i++) {
      await settle(50);
    }
    expect(aSettled).toBe(false);
    expect(a.status).toBe("waiting");

    const bSeat = await b.quickMatch();
    const seatA = await aSeat;

    expect(seatA).toEqual({ role: "host", ready: true });
    expect(bSeat).toEqual({ role: "guest", ready: true });
    // Both landed in the same minted room.
    expect(a.room).toBe(b.room);
    expect(a.room).toMatch(/^[0-9A-Z]{5}$/);

    a.close();
    b.close();
  }, 15_000);

  it("makes the longest waiting player the host", async () => {
    const first = track(new NetConnection(URL));
    const second = track(new NetConnection(URL));
    const seat = first.quickMatch();
    for (let i = 0; i < 50 && first.status !== "waiting"; i++) {
      await settle(50);
    }
    await second.quickMatch();

    expect((await seat).role).toBe("host");

    first.close();
    second.close();
  }, 15_000);

  it("reports queue position while waiting", async () => {
    const positions: number[] = [];
    const waiting = track(new NetConnection(URL, { onQueued: (n) => positions.push(n) }));
    void waiting.quickMatch().catch(() => {});
    for (let i = 0; i < 50 && positions.length === 0; i++) {
      await settle(50);
    }

    expect(positions).toEqual([0]);
    expect((await health()).waiting).toBe(1);

    waiting.close();
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 0) break;
      await settle(50);
    }
  }, 15_000);

  it("pairs four players into two separate rooms", async () => {
    const players = [0, 1, 2, 3].map(() => track(new NetConnection(URL)));
    const seats = await Promise.all(
      players.map(async (p, i) => {
        // Stagger so the queue order is deterministic.
        await settle(100 * i);
        return p.quickMatch();
      })
    );

    const rooms = new Set(players.map((p) => p.room));
    expect(rooms.size).toBe(2);
    expect(seats.filter((s) => s.role === "host")).toHaveLength(2);
    expect(seats.filter((s) => s.role === "guest")).toHaveLength(2);

    for (const p of players) p.close();
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 0) break;
      await settle(50);
    }
  }, 15_000);

  it("frees the queue when a waiting player gives up", async () => {
    const quitter = track(new NetConnection(URL));
    void quitter.quickMatch().catch(() => {});
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 1) break;
      await settle(50);
    }
    expect((await health()).waiting).toBe(1);

    quitter.close();
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 0) break;
      await settle(50);
    }
    expect((await health()).waiting).toBe(0);
  }, 15_000);

  it("does not pair a newcomer with someone who already left", async () => {
    // The stale socket must be skipped, not handed a dead opponent.
    const ghost = track(new NetConnection(URL));
    void ghost.quickMatch().catch(() => {});
    for (let i = 0; i < 50 && ghost.status !== "waiting"; i++) {
      await settle(50);
    }
    ghost.close();
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 0) break;
      await settle(50);
    }

    const arriving = track(new NetConnection(URL));
    let settled = false;
    void arriving.quickMatch().then(() => (settled = true));
    for (let i = 0; i < 50 && arriving.status !== "waiting"; i++) {
      await settle(50);
    }

    // Nobody real is waiting, so this player waits too rather than being
    // paired into a room with a closed socket.
    expect(settled).toBe(false);
    expect(arriving.status).toBe("waiting");

    arriving.close();
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 0) break;
      await settle(50);
    }
  }, 15_000);

  it("refuses to queue a player already seated in a private room", async () => {
    const c = track(new NetConnection(URL));
    await c.join("ABCDE");
    await expect(c.quickMatch()).rejects.toThrow(/already connected/);
    c.close();
  }, 15_000);

  it("rejects a stale client by protocol version", async () => {
    const c = track(new NetConnection(URL));
    // Reach past the typed API to forge an old client's opening frame.
    await expect(
      (c as unknown as { handshake: (m: unknown, t?: number) => Promise<unknown> }).handshake(
        { t: "queue", v: 999 },
        3000
      )
    ).rejects.toThrow(/version/);
    c.close();
  }, 15_000);
});

describe("private rooms alongside the queue", () => {
  it("keeps an invited pair out of the matchmaking queue", async () => {
    const host = track(new NetConnection(URL));
    const guest = track(new NetConnection(URL));
    await host.join("QQQQQ");

    const waiting = track(new NetConnection(URL));
    void waiting.quickMatch().catch(() => {});
    for (let i = 0; i < 50 && waiting.status !== "waiting"; i++) {
      await settle(50);
    }

    // The private guest must reach its friend, not the stranger in the queue.
    const seat = await guest.join("QQQQQ");
    expect(seat.role).toBe("guest");
    expect(guest.room).toBe("QQQQQ");
    expect((await health()).waiting).toBe(1);

    host.close();
    guest.close();
    waiting.close();
    for (let i = 0; i < 50; i++) {
      if ((await health()).waiting === 0) break;
      await settle(50);
    }
  }, 15_000);
});
