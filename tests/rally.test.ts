import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { SIM_DT } from "../src/config";
import { NetConnection } from "../src/net/connection";
import { makeRoomCode, reframe, type GameMessage, type SnapshotMessage } from "../src/net/protocol";

/**
 * The check the earlier design never had, and which would have caught it: two
 * peers connected through a real relay must agree about the match, not merely
 * be connected. The previous version passed every unit test and every pairing
 * check while the two screens played unrelated games.
 */

const PORT = 8100 + Math.floor(Math.random() * 150);
const URL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;
const open: NetConnection[] = [];

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

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

/** A connected host/guest pair, each recording what it receives. */
async function pair() {
  const room = makeRoomCode();
  const hostInbox: GameMessage[] = [];
  const guestInbox: GameMessage[] = [];
  const host = new NetConnection(URL, { onMessage: (m) => hostInbox.push(m) });
  const guest = new NetConnection(URL, { onMessage: (m) => guestInbox.push(m) });
  open.push(host, guest);
  await host.join(room);
  await guest.join(room);
  await settle(200);
  return { host, guest, hostInbox, guestInbox };
}

describe("a match across two peers", () => {
  it("sends the host's frames to the guest and the guest's controls to the host", async () => {
    const { host, guest, hostInbox, guestInbox } = await pair();

    // The host publishes a frame mid-rally.
    host.tick = 100;
    host.send({
      t: "snap",
      tick: 100,
      ballPos: { x: 0.5, y: 1.4, z: 0.2 },
      ballVel: { x: 6, y: 2, z: -1 },
      ballHeld: false,
      hostPos: { x: -3, y: 0.4, z: 0.5 },
      guestPos: { x: 3, y: 0.4, z: -0.5 },
      score: [4, 2],
      sets: [1, 0],
      serveOwner: "player",
      phase: "rally",
    });

    // The guest presses strike.
    guest.tick = 100;
    guest.send({ t: "input", tick: 100, moveX: 1, moveZ: 0, strike: true, pop: false, confirm: false });

    await settle(400);

    expect(guestInbox.filter((m) => m.t === "snap")).toHaveLength(1);
    expect(hostInbox.filter((m) => m.t === "input")).toHaveLength(1);
    // Neither peer hears its own traffic back.
    expect(hostInbox.some((m) => m.t === "snap")).toBe(false);
    expect(guestInbox.some((m) => m.t === "input")).toBe(false);

    host.close();
    guest.close();
  });

  it("leaves both peers agreeing about the score, from their own side", async () => {
    const { host, guest, guestInbox } = await pair();

    // Host is 7-3 up in its own frame.
    host.send({
      t: "snap",
      tick: 1,
      ballPos: { x: 0, y: 1, z: 0 },
      ballVel: { x: 0, y: 0, z: 0 },
      ballHeld: true,
      hostPos: { x: -3, y: 0.4, z: 0 },
      guestPos: { x: 3, y: 0.4, z: 0 },
      score: [7, 3],
      sets: [0, 0],
      serveOwner: "player",
      phase: "serve_ready",
    });
    await settle(400);

    const raw = guestInbox.find((m) => m.t === "snap");
    expect(raw).toBeDefined();
    const seen = reframe(raw as SnapshotMessage, "guest");

    // Same match, opposite point of view: the guest is 3-7 down, and the
    // serve that belonged to the host is now the opponent's.
    expect(seen.score).toEqual([3, 7]);
    expect(seen.serveOwner).toBe("ai");
    // The two accounts must add up to one scoreline, not two.
    expect(seen.score[0] + seen.score[1]).toBe(10);

    host.close();
    guest.close();
  });

  it("puts each player on their own side of their own table", async () => {
    const { host, guest, guestInbox } = await pair();

    host.send({
      t: "snap",
      tick: 1,
      ballPos: { x: -1, y: 1, z: 0 },
      ballVel: { x: 5, y: 1, z: 0 },
      ballHeld: false,
      hostPos: { x: -3.2, y: 0.4, z: 1 },
      guestPos: { x: 2.8, y: 0.4, z: -1 },
      score: [0, 0],
      sets: [0, 0],
      serveOwner: "player",
      phase: "rally",
    });
    await settle(400);

    const seen = reframe(guestInbox.find((m) => m.t === "snap") as SnapshotMessage, "guest");

    // Whoever you are, you are at negative x and your opponent is at positive.
    expect(seen.hostPos.x).toBeLessThan(0); // the guest itself
    expect(seen.guestPos.x).toBeGreaterThan(0); // its opponent
    // The ball was on the host's half heading away; for the guest it is on the
    // far half heading toward them.
    expect(seen.ballPos.x).toBeGreaterThan(0);
    expect(seen.ballVel.x).toBeLessThan(0);

    host.close();
    guest.close();
  });

  it("carries a whole rally's worth of frames without reordering the score", async () => {
    const { host, guest, guestInbox } = await pair();

    // Ten seconds of play at the real snapshot rate, with the score climbing.
    for (let i = 0; i < 40; i++) {
      host.tick = i * 3;
      host.send({
        t: "snap",
        tick: i * 3,
        ballPos: { x: Math.sin(i) * 2, y: 1.2, z: 0 },
        ballVel: { x: 4, y: 0, z: 0 },
        ballHeld: false,
        hostPos: { x: -3, y: 0.4, z: 0 },
        guestPos: { x: 3, y: 0.4, z: 0 },
        score: [Math.floor(i / 4), 0],
        sets: [0, 0],
        serveOwner: "player",
        phase: "rally",
      });
      await settle(SIM_DT * 1000 * 3);
    }
    await settle(500);

    const snaps = guestInbox.filter((m) => m.t === "snap");
    expect(snaps.length).toBe(40);
    // Ticks arrive in order, and a score never goes backwards.
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i].tick).toBeGreaterThan(snaps[i - 1].tick);
      expect(snaps[i].score[0]).toBeGreaterThanOrEqual(snaps[i - 1].score[0]);
    }

    host.close();
    guest.close();
  });
});
