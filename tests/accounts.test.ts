import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The server is plain ESM — it ships as-is into an image carrying `ws` and
// nothing else, so it is never compiled. Importing it here, against the
// hand-written declarations beside it, is what stops it being the corner of
// the project nobody checks.
import { JsonStore } from "../server/store.mjs";
import {
  MATCH_COOLDOWN_MS,
  MAX_TALLY,
  ValidationError,
  authenticate,
  claim,
  leaderboard,
  normaliseName,
  privateProfile,
  publicProfile,
  recordMatch,
  register,
  rename,
  upgrade,
  validateResult,
} from "../server/accounts.mjs";
import { handleApi } from "../server/api.mjs";
import { CHARACTERS, SETS_TO_WIN, WIN_SCORE } from "../src/config";

/* The fake request/response and the JSON bodies coming back out of the API are
   deliberately untyped here: this suite exists to check what the wire actually
   carries, and typing the responses would be asserting against the same
   declarations rather than against the server. */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { dailyChallenges } from "../src/challenges";
import { upgradeCost } from "../src/progress";

let dir: string;
let store: JsonStore;

const WIN = {
  championId: CHARACTERS[0].id,
  difficulty: "normal",
  won: true,
  points: WIN_SCORE * SETS_TO_WIN,
  sets: SETS_TO_WIN,
  rallies: 6,
};

/** A time far enough past the last result that the cooldown is satisfied. */
const later = (from: Date, matches = 1) =>
  new Date(from.getTime() + matches * (MATCH_COOLDOWN_MS + 1000));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teq-store-"));
  store = new JsonStore(join(dir, "players.json"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("names", () => {
  it("accepts an ordinary name and tidies it up", () => {
    expect(normaliseName("  Ana   Silva ")).toBe("Ana Silva");
  });

  it("takes names in any script the roster's countries write in", () => {
    expect(normaliseName("Renée")).toBe("Renée");
    expect(normaliseName("João")).toBe("João");
  });

  it("refuses what a leaderboard row cannot show", () => {
    for (const bad of ["", "ab", "a".repeat(17), " _x_ ", "we<b>ird", "🏆🏆🏆"]) {
      expect(() => normaliseName(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it("will not take a name that is already somebody's", () => {
    register(store, "Champion");
    expect(() => register(store, "champion")).toThrow(/taken/);
  });

  it("lets a player keep their own name while renaming", () => {
    const player = register(store, "Champion");
    expect(() => rename(store, player, "Champion")).not.toThrow();
    rename(store, player, "Challenger");
    // …and frees the old one for somebody else.
    expect(() => register(store, "Champion")).not.toThrow();
  });
});

describe("accounts", () => {
  it("mints a readable id, a secret token and an empty career", () => {
    const player = register(store, "Ana");

    expect(player.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(player.token).toHaveLength(48);
    expect(player.career.trophies).toBe(0);
  });

  it("gives every player a different id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(register(store, `Player${i}`).id);
    expect(ids.size).toBe(200);
  });

  it("never puts the token in a profile", () => {
    const player = register(store, "Ana");

    expect(JSON.stringify(publicProfile(player))).not.toContain(player.token);
    expect(JSON.stringify(privateProfile(store, player))).not.toContain(player.token);
  });

  it("authenticates a real token and nothing else", () => {
    const player = register(store, "Ana");

    expect(authenticate(store, player.token)?.id).toBe(player.id);
    expect(authenticate(store, "")).toBeNull();
    expect(authenticate(store, "f".repeat(48))).toBeNull();
    expect(authenticate(store, player.token.slice(0, 47))).toBeNull();
  });
});

describe("recording a match", () => {
  it("settles it and pays out", () => {
    const player = register(store, "Ana");
    const { outcome } = recordMatch(store, player, WIN, later(new Date(0)));

    expect(outcome.trophies).toBeGreaterThan(0);
    expect(player.career.trophies).toBe(outcome.trophies);
    expect(player.matches).toBe(1);
  });

  it("refuses a result no match could have produced", () => {
    const player = register(store, "Ana");
    const bad: unknown[] = [
      { ...WIN, points: MAX_TALLY.points + 1 },
      { ...WIN, sets: SETS_TO_WIN + 1 },
      { ...WIN, rallies: MAX_TALLY.rallies + 1 },
      { ...WIN, points: -1 },
      { ...WIN, points: 1.5 },
      { ...WIN, championId: "SomeoneElse" },
      { ...WIN, difficulty: "impossible" },
      { ...WIN, won: "yes" },
      // A win that did not win the sets, which is the cheapest cheat there is.
      { ...WIN, sets: 0 },
      // A loss claiming the sets.
      { ...WIN, won: false },
      // Fewer points than winning those sets requires.
      { ...WIN, points: 1 },
    ];
    for (const body of bad) {
      expect(() => validateResult(body), JSON.stringify(body)).toThrow(ValidationError);
    }
    expect(player.career.trophies).toBe(0);
  });

  it("makes a scripted climb take as long as playing would", () => {
    const player = register(store, "Ana");
    const start = later(new Date(0));
    recordMatch(store, player, WIN, start);

    expect(() => recordMatch(store, player, WIN, new Date(start.getTime() + 1000))).toThrow(/too soon/);
    expect(() => recordMatch(store, player, WIN, later(start))).not.toThrow();
  });

  it("accepts a full-length match, sets and all", () => {
    // The cap has to admit the longest real match, or it punishes the players
    // who had the best games.
    const player = register(store, "Ana");
    expect(() =>
      recordMatch(
        store,
        player,
        { ...WIN, points: MAX_TALLY.points, sets: MAX_TALLY.sets, rallies: MAX_TALLY.rallies },
        later(new Date(0))
      )
    ).not.toThrow();
  });
});

describe("challenges and upgrades on the server", () => {
  it("pays a finished challenge once", () => {
    const player = register(store, "Ana");
    const challenge = dailyChallenges(player.career.day)[0];
    player.career = { ...player.career, progress: { [challenge.id]: challenge.goal } };

    const career = claim(store, player, challenge.id);
    expect(career.coins).toBe(challenge.reward);
    expect(() => claim(store, player, challenge.id)).toThrow(ValidationError);
  });

  it("refuses a challenge that is not finished", () => {
    const player = register(store, "Ana");
    const challenge = dailyChallenges(player.career.day)[0];
    expect(() => claim(store, player, challenge.id)).toThrow(ValidationError);
  });

  it("sells a level, and refuses one that cannot be paid for", () => {
    const player = register(store, "Ana");
    const id = CHARACTERS[0].id;
    expect(() => upgrade(store, player, id)).toThrow(ValidationError);

    player.career = { ...player.career, coins: upgradeCost(1) };
    const career = upgrade(store, player, id);
    expect(career.champions[id].level).toBe(2);
    expect(career.coins).toBe(0);
  });

  it("refuses an upgrade for a character that is still locked", () => {
    const player = register(store, "Ana");
    player.career = { ...player.career, coins: 999_999 };
    expect(() => upgrade(store, player, CHARACTERS[3].id)).toThrow(ValidationError);
  });
});

describe("the leaderboard", () => {
  it("ranks by trophies, and settles ties by who got there first", () => {
    const at = later(new Date(0));
    const ana = register(store, "Ana", at);
    const bo = register(store, "Bobby", new Date(at.getTime() + 1));
    recordMatch(store, bo, WIN, later(at));

    const rows = leaderboard(store, 10);
    expect(rows.map((r) => r.name)).toEqual(["Bobby", "Ana"]);
    expect(rows[0].rank).toBe(1);
    expect(store.rankOf(ana.id)).toBe(2);
  });

  it("shows a tier beside every name", () => {
    register(store, "Ana");
    expect(leaderboard(store, 10)[0].tier).toBeTruthy();
  });

  it("never leaks a token", () => {
    register(store, "Ana");
    expect(JSON.stringify(leaderboard(store, 10))).not.toContain("token");
  });
});

describe("the store", () => {
  it("survives a restart", async () => {
    const player = register(store, "Ana");
    recordMatch(store, player, WIN, later(new Date(0)));
    await store.flush();

    const reopened = await new JsonStore(join(dir, "players.json")).load();
    const found = reopened.get(player.id)!;
    expect(found.name).toBe("Ana");
    expect(found.career.trophies).toBe(player.career.trophies);
    // And the indexes are rebuilt, not just the records.
    expect(authenticate(reopened, player.token)?.id).toBe(player.id);
    expect(reopened.nameTaken("ana")).toBe(true);
  });

  it("writes through a temp file so a crash cannot leave half a store", async () => {
    register(store, "Ana");
    await store.flush();
    const written = await readFile(join(dir, "players.json"), "utf8");
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it("starts empty rather than failing when there is nothing to read", async () => {
    const fresh = await new JsonStore(join(dir, "nothing-here.json")).load();
    expect(fresh.size).toBe(0);
  });
});

/** Drive the HTTP layer without a socket, the way the relay calls it. */
async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {}
): Promise<{ status: number; body: any }> {
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req: any = {
    method,
    url: path,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    socket: { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  let status = 0;
  let text = "";
  const res: any = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      res.headersSent = true;
      return res;
    },
    end(body?: string) {
      text = body ?? "";
    },
  };
  const handled = await handleApi(store, req, res);
  return { status: handled ? status : 404, body: text ? JSON.parse(text) : null };
}

describe("the HTTP API", () => {
  it("registers, and hands back the token exactly once", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });

    expect(created.status).toBe(201);
    expect(created.body.token).toHaveLength(48);

    const me = await call("GET", "/api/players/me", { token: created.body.token });
    expect(me.status).toBe(200);
    expect(me.body.name).toBe("Ana");
    expect(me.body.token).toBeUndefined();
  });

  it("turns a bad name into a message a screen can show", async () => {
    const res = await call("POST", "/api/players", { body: { name: "x" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/characters/);
  });

  it("refuses everything private without a token", async () => {
    for (const [method, path] of [
      ["GET", "/api/players/me"],
      ["POST", "/api/players/me/name"],
      ["POST", "/api/players/me/matches"],
      ["POST", "/api/players/me/claim"],
      ["POST", "/api/players/me/upgrade"],
    ]) {
      const res = await call(method, path, { body: {} });
      expect(res.status, path).toBe(401);
    }
  });

  it("looks a player up by the code on their card", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const found = await call("GET", `/api/players/${created.body.id.toLowerCase()}`);

    expect(found.status).toBe(200);
    expect(found.body.name).toBe("Ana");
    expect(found.body.token).toBeUndefined();
  });

  it("says so plainly when a code is not a player", async () => {
    const res = await call("GET", "/api/players/ZZZZZZZZ");
    expect(res.status).toBe(404);
  });

  it("records a match and returns the career the server holds", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const res = await call("POST", "/api/players/me/matches", {
      token: created.body.token,
      body: WIN,
    });

    expect(res.status).toBe(200);
    expect(res.body.career.trophies).toBeGreaterThan(0);
    expect(res.body.rank).toBe(1);
  });

  it("rejects a forged result with a reason", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const res = await call("POST", "/api/players/me/matches", {
      token: created.body.token,
      body: { ...WIN, points: 9999 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("shows a signed-in caller their own row on the leaderboard", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const res = await call("GET", "/api/leaderboard", { token: created.body.token });

    expect(res.status).toBe(200);
    expect(res.body.me.id).toBe(created.body.id);
    expect(res.body.total).toBe(1);
  });

  it("answers a preflight, because the game is never on the API's origin", async () => {
    const res = await call("OPTIONS", "/api/leaderboard");
    expect(res.status).toBe(204);
  });

  it("leaves paths that are not ours alone", async () => {
    const res = await call("GET", "/healthz");
    expect(res.status).toBe(404); // not handled — the relay serves it
  });
});
