import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetConnection } from "../src/net/connection";
import { CHARACTERS, SETS_TO_WIN, WIN_SCORE } from "../src/config";
import type { PeerIdentity } from "../src/net/protocol";

/* The API's replies are deliberately untyped here: this suite exists to check
   what the wire actually carries, so asserting against declarations would be
   asserting against the wrong thing. */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/**
 * The whole backend, over a real socket and real HTTP.
 *
 * `tests/accounts.test.ts` calls the handlers directly, which checks the
 * rules. This spawns the actual server and talks to it the way the game does,
 * which is what catches the wiring: a route not mounted, a header missing, an
 * account that authenticates over HTTP but not over the relay.
 */

const PORT = 8500 + Math.floor(Math.random() * 200);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;
let dataDir: string;
const open: NetConnection[] = [];

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function track(c: NetConnection): NetConnection {
  open.push(c);
  return c;
}

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${HTTP}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "teq-backend-"));
  relay = spawn("node", ["server/relay.mjs"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${HTTP}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await settle(100);
  }
}, 20_000);

afterAll(async () => {
  for (const c of open) c.close();
  relay?.kill();
  await settle(150);
  await rm(dataDir, { recursive: true, force: true });
});

describe("the server, end to end", () => {
  it("reports the player count on its health check", async () => {
    const res = await fetch(`${HTTP}/healthz`);
    const body = (await res.json()) as { ok: boolean; players: number | null };

    expect(body.ok).toBe(true);
    expect(typeof body.players).toBe("number");
  });

  it("registers a player and lets them come back with the token", async () => {
    const created = await api("POST", "/api/players", { body: { name: "Ana Silva" } });
    expect(created.status).toBe(201);

    const me = await api("GET", "/api/players/me", { token: created.body.token });
    expect(me.body.id).toBe(created.body.id);
    expect(me.body.name).toBe("Ana Silva");
  });

  it("scores a match itself and hands back its own career", async () => {
    const created = await api("POST", "/api/players", { body: { name: "Scorer" } });
    const res = await api("POST", "/api/players/me/matches", {
      token: created.body.token,
      body: {
        championId: CHARACTERS[0].id,
        difficulty: "normal",
        won: true,
        points: WIN_SCORE * SETS_TO_WIN,
        sets: SETS_TO_WIN,
        rallies: 5,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.career.trophies).toBeGreaterThan(0);
    expect(res.body.outcome.coins).toBeGreaterThan(0);
  });

  it("will not take a result that claims more than a match can hold", async () => {
    const created = await api("POST", "/api/players", { body: { name: "Cheater" } });
    const res = await api("POST", "/api/players/me/matches", {
      token: created.body.token,
      body: {
        championId: CHARACTERS[0].id,
        difficulty: "hard",
        won: true,
        points: 100_000,
        sets: SETS_TO_WIN,
        rallies: 0,
      },
    });

    expect(res.status).toBe(400);
    const me = await api("GET", "/api/players/me", { token: created.body.token });
    expect(me.body.trophies).toBe(0);
  });

  it("sends the CORS header the game needs from a webview", async () => {
    // A packaged Capacitor app has no host for an origin, and the hosted build
    // is never on the API's origin. Without this the game cannot read a reply.
    const res = await fetch(`${HTTP}/api/leaderboard`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps players across a restart", async () => {
    const created = await api("POST", "/api/players", { body: { name: "Persistent" } });
    // Give the debounced write time to land, then restart the process.
    await settle(900);
    relay.kill();
    await settle(300);
    relay = spawn("node", ["server/relay.mjs"], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
      stdio: "ignore",
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        if ((await fetch(`${HTTP}/healthz`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error("server did not restart");
      await settle(100);
    }

    const me = await api("GET", "/api/players/me", { token: created.body.token });
    expect(me.status).toBe(200);
    expect(me.body.name).toBe("Persistent");
  }, 25_000);
});

describe("identity on the wire", () => {
  it("tells each side who the other actually is", async () => {
    const [a, b] = await Promise.all([
      api("POST", "/api/players", { body: { name: "Home" } }),
      api("POST", "/api/players", { body: { name: "Away" } }),
    ]);

    const seenByHost: (PeerIdentity | null)[] = [];
    const seenByGuest: (PeerIdentity | null)[] = [];
    const host = track(
      new NetConnection(WS, { onPeer: (p, who) => p && seenByHost.push(who ?? null) }, a.body.token)
    );
    const guest = track(
      new NetConnection(WS, { onPeer: (p, who) => p && seenByGuest.push(who ?? null) }, b.body.token)
    );

    await host.join("NAMES");
    await guest.join("NAMES");
    await settle(250);

    expect(seenByHost.at(-1)?.name).toBe("Away");
    expect(seenByGuest.at(-1)?.name).toBe("Home");
    // The name comes with the rank behind it, so a card can say who it is.
    expect(seenByHost.at(-1)?.tier).toBeTruthy();
  });

  it("never lets a peer announce a name that is not theirs", async () => {
    // The name on the card is the one the relay looked up from a token. A
    // client that simply asserts a name gets nothing, which is the point.
    const seen: (PeerIdentity | null)[] = [];
    const liar = track(new NetConnection(WS, {}, "not-a-real-token-at-all"));
    const honest = track(new NetConnection(WS, { onPeer: (p, who) => p && seen.push(who ?? null) }));

    await liar.join("LIARS");
    await honest.join("LIARS");
    await settle(250);

    expect(seen.at(-1)).toBeNull();
  });

  it("names the match, so both sides can report the same one", async () => {
    // The id is what lets the server check two stories against each other
    // instead of believing whichever arrived first.
    const [a, b] = await Promise.all([
      api("POST", "/api/players", { body: { name: "Reporter" } }),
      api("POST", "/api/players", { body: { name: "Opponent" } }),
    ]);
    const seenA: (string | null)[] = [];
    const seenB: (string | null)[] = [];
    const host = track(
      new NetConnection(WS, { onPeer: (p, _w, id) => p && seenA.push(id ?? null) }, a.body.token)
    );
    const guest = track(
      new NetConnection(WS, { onPeer: (p, _w, id) => p && seenB.push(id ?? null) }, b.body.token)
    );

    await host.join("RANKED");
    await guest.join("RANKED");
    await settle(300);

    expect(seenA.at(-1)).toBeTruthy();
    expect(seenB.at(-1)).toBe(seenA.at(-1));

    // One report alone is held, not paid.
    const matchId = seenA.at(-1)!;
    const win = {
      matchId,
      championId: CHARACTERS[0].id,
      won: true,
      points: WIN_SCORE * SETS_TO_WIN,
      sets: SETS_TO_WIN,
      rallies: 6,
      opponentSets: 1,
    };
    const first = await api("POST", "/api/players/me/online", { token: a.body.token, body: win });
    expect(first.status).toBe(202);
    expect(first.body.pending).toBe(true);

    const second = await api("POST", "/api/players/me/online", {
      token: b.body.token,
      body: {
        ...win,
        won: false,
        points: WIN_SCORE + 1,
        sets: 1,
        opponentSets: SETS_TO_WIN,
      },
    });
    expect(second.status).toBe(200);
    expect(second.body.career.trophies).toBe(0); // the loser, floored at zero

    const winner = await api("GET", "/api/players/me", { token: a.body.token });
    expect(winner.body.trophies).toBeGreaterThan(0);
  });

  it("still seats two players who have no accounts at all", async () => {
    const a = track(new NetConnection(WS));
    const b = track(new NetConnection(WS));

    const seated = await a.join("GUEST");
    expect(seated.role).toBe("host");
    const joined = await b.join("GUEST");
    expect(joined.ready).toBe(true);
  });
});
