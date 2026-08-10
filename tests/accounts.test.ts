import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The server is plain ESM — it ships as-is into an image carrying `ws` and the
// Firestore client and nothing else, so it is never compiled. Importing it
// here, against the hand-written declarations beside it, is what stops it
// being the corner of the project nobody checks.
import { JsonStore, type PlayerRecord } from "../server/store.mjs";
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
  recover,
  regenerateRecovery,
  register,
  rename,
  upgrade,
  validateResult,
} from "../server/accounts.mjs";
import { looksLikeRecovery, tidyRecovery } from "../server/secrets.mjs";
import { handleApi } from "../server/api.mjs";
import { CHARACTERS, SETS_TO_WIN, WIN_SCORE } from "../src/config";
import { dailyChallenges } from "../src/challenges";
import { upgradeCost } from "../src/progress";

/* The fake request/response and the JSON bodies coming back out of the API are
   deliberately untyped: this suite checks what the wire actually carries, and
   typing the responses would assert against the declarations rather than
   against the server. */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */

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

/** Register and hand back just the record, for the tests that only need one. */
async function player(name: string, now?: Date): Promise<PlayerRecord> {
  return (await register(store, name, now)).player;
}

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

  it("will not take a name that is already somebody's", async () => {
    await player("Champion");
    await expect(register(store, "champion")).rejects.toThrow(/taken/);
  });

  it("lets a player keep their own name while renaming", async () => {
    const p = await player("Champion");
    await expect(rename(store, p, "Champion")).resolves.toBeTruthy();
    await rename(store, p, "Challenger");
    // …and frees the old one for somebody else.
    await expect(register(store, "Champion")).resolves.toBeTruthy();
  });
});

describe("accounts", () => {
  it("mints a readable id and issues both secrets exactly once", async () => {
    const issued = await register(store, "Ana");

    expect(issued.player.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(issued.token).toHaveLength(48);
    expect(looksLikeRecovery(issued.recoveryCode)).toBe(true);
    expect(issued.player.career.trophies).toBe(0);
  });

  it("gives every player a different id", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add((await player(`Player${i}`)).id);
    expect(ids.size).toBe(200);
  });

  it("keeps neither secret in a form the store could give back", async () => {
    // A leaked database should not hand anybody every account in the game.
    const issued = await register(store, "Ana");
    const stored = JSON.stringify(issued.player);

    expect(stored).not.toContain(issued.token);
    expect(stored).not.toContain(issued.recoveryCode);
    expect(JSON.stringify(publicProfile(issued.player))).not.toContain(issued.token);
    expect(JSON.stringify(await privateProfile(store, issued.player))).not.toContain(issued.token);
  });

  it("authenticates a real token and nothing else", async () => {
    const issued = await register(store, "Ana");

    expect((await authenticate(store, issued.token))?.id).toBe(issued.player.id);
    expect(await authenticate(store, "")).toBeNull();
    expect(await authenticate(store, "f".repeat(48))).toBeNull();
    expect(await authenticate(store, issued.token.slice(0, 47))).toBeNull();
  });
});

describe("recovery", () => {
  it("takes the account over onto a new device", async () => {
    const issued = await register(store, "Ana");
    await recordMatch(store, issued.player, WIN, later(new Date(0)));

    const back = await recover(store, issued.player.id, issued.recoveryCode);

    expect(back.player.id).toBe(issued.player.id);
    expect(back.player.career.trophies).toBe(issued.player.career.trophies);
    expect((await authenticate(store, back.token))?.id).toBe(issued.player.id);
  });

  it("stops the old device", async () => {
    // Recovery is what somebody does when a phone is gone. An account that
    // keeps answering to that phone has not been recovered.
    const issued = await register(store, "Ana");
    await recover(store, issued.player.id, issued.recoveryCode);

    expect(await authenticate(store, issued.token)).toBeNull();
  });

  it("spends the code it was given", async () => {
    // A slip of paper somebody else photographed must not keep working.
    const issued = await register(store, "Ana");
    const first = await recover(store, issued.player.id, issued.recoveryCode);

    await expect(recover(store, issued.player.id, issued.recoveryCode)).rejects.toThrow(
      ValidationError
    );
    await expect(recover(store, issued.player.id, first.recoveryCode)).resolves.toBeTruthy();
  });

  it("forgives how a person types it", async () => {
    const issued = await register(store, "Ana");
    const sloppy = issued.recoveryCode.toLowerCase().replace(/-/g, " ");

    await expect(recover(store, issued.player.id.toLowerCase(), sloppy)).resolves.toBeTruthy();
  });

  it("folds the three characters Crockford folds, and no others", () => {
    // Somebody reading a code aloud says "oh" for zero and "eye" for one.
    expect(tidyRecovery("otyz-1234-abcd-efgh")).toBe("0TYZ-1234-ABCD-EFGH");
    expect(tidyRecovery("il 1234 abcd efgh")).toBe("1112-34AB-CDEF-GH");
    // Q is in the alphabet. Folding it to zero would make every code
    // containing one impossible to type back in.
    expect(tidyRecovery("QQQQ-1234-ABCD-EFGH")).toBe("QQQQ-1234-ABCD-EFGH");
  });

  it("round-trips any code it can mint", async () => {
    // The fold above is applied to codes that were never typed wrong at all,
    // so it has to be the identity on every character the minter can produce.
    for (let i = 0; i < 200; i++) {
      const issued = await register(store, `RoundTrip${i}`);
      expect(tidyRecovery(issued.recoveryCode), issued.recoveryCode).toBe(issued.recoveryCode);
    }
  });

  it("says the same thing however it fails", async () => {
    // Otherwise this is a way to find out which player codes exist.
    const issued = await register(store, "Ana");
    const messages = new Set<string>();
    for (const [id, code] of [
      ["ZZZZZZZZ", issued.recoveryCode],
      [issued.player.id, "AAAA-BBBB-CCCC-DDDD"],
      [issued.player.id, "nonsense"],
      ["", ""],
    ]) {
      await recover(store, id, code).catch((err: ValidationError) => {
        messages.add(err.message);
        expect(err.status).toBe(403);
      });
    }
    expect(messages.size).toBe(1);
  });

  it("can be replaced from a device that is already signed in", async () => {
    const issued = await register(store, "Ana");
    const fresh = await regenerateRecovery(store, issued.player);

    expect(fresh).not.toBe(issued.recoveryCode);
    await expect(recover(store, issued.player.id, issued.recoveryCode)).rejects.toThrow();
    await expect(recover(store, issued.player.id, fresh)).resolves.toBeTruthy();
  });
});

describe("recording a match", () => {
  it("settles it and pays out", async () => {
    const p = await player("Ana");
    const { outcome } = await recordMatch(store, p, WIN, later(new Date(0)));

    expect(outcome.trophies).toBeGreaterThan(0);
    expect(p.career.trophies).toBe(outcome.trophies);
    expect(p.matches).toBe(1);
  });

  it("refuses a result no match could have produced", async () => {
    const p = await player("Ana");
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
    expect(p.career.trophies).toBe(0);
  });

  it("makes a scripted climb take as long as playing would", async () => {
    const p = await player("Ana");
    const start = later(new Date(0));
    await recordMatch(store, p, WIN, start);

    await expect(recordMatch(store, p, WIN, new Date(start.getTime() + 1000))).rejects.toThrow(
      /too soon/
    );
    await expect(recordMatch(store, p, WIN, later(start))).resolves.toBeTruthy();
  });

  it("accepts a full-length match, sets and all", async () => {
    // The cap has to admit the longest real match, or it punishes the players
    // who had the best games.
    const p = await player("Ana");
    await expect(
      recordMatch(
        store,
        p,
        { ...WIN, points: MAX_TALLY.points, sets: MAX_TALLY.sets, rallies: MAX_TALLY.rallies },
        later(new Date(0))
      )
    ).resolves.toBeTruthy();
  });
});

describe("challenges and upgrades on the server", () => {
  it("pays a finished challenge once", async () => {
    const p = await player("Ana");
    const challenge = dailyChallenges(p.career.day)[0];
    p.career = { ...p.career, progress: { [challenge.id]: challenge.goal } };

    const career = await claim(store, p, challenge.id);
    expect(career.coins).toBe(challenge.reward);
    await expect(claim(store, p, challenge.id)).rejects.toThrow(ValidationError);
  });

  it("refuses a challenge that is not finished", async () => {
    const p = await player("Ana");
    const challenge = dailyChallenges(p.career.day)[0];
    await expect(claim(store, p, challenge.id)).rejects.toThrow(ValidationError);
  });

  it("sells a level, and refuses one that cannot be paid for", async () => {
    const p = await player("Ana");
    const id = CHARACTERS[0].id;
    await expect(upgrade(store, p, id)).rejects.toThrow(ValidationError);

    p.career = { ...p.career, coins: upgradeCost(1) };
    const career = await upgrade(store, p, id);
    expect(career.champions[id].level).toBe(2);
    expect(career.coins).toBe(0);
  });

  it("refuses an upgrade for a character that is still locked", async () => {
    const p = await player("Ana");
    p.career = { ...p.career, coins: 999_999 };
    await expect(upgrade(store, p, CHARACTERS[3].id)).rejects.toThrow(ValidationError);
  });
});

describe("the leaderboard", () => {
  it("ranks by trophies, and settles ties by who got there first", async () => {
    const at = later(new Date(0));
    const ana = await player("Ana", at);
    const bobby = await player("Bobby", new Date(at.getTime() + 1));
    await recordMatch(store, bobby, WIN, later(at));

    const rows = await leaderboard(store, 10);
    expect(rows.map((r) => r.name)).toEqual(["Bobby", "Ana"]);
    expect(rows[0].rank).toBe(1);
    expect(await store.rankOf(ana.id)).toBe(2);
  });

  it("shows a tier beside every name", async () => {
    await player("Ana");
    expect((await leaderboard(store, 10))[0].tier).toBeTruthy();
  });

  it("never leaks a secret", async () => {
    const issued = await register(store, "Ana");
    const board = JSON.stringify(await leaderboard(store, 10));

    expect(board).not.toContain(issued.token);
    expect(board).not.toContain("Hash");
  });
});

describe("the store", () => {
  it("survives a restart", async () => {
    const issued = await register(store, "Ana");
    await recordMatch(store, issued.player, WIN, later(new Date(0)));
    await store.flush();

    const reopened = await new JsonStore(join(dir, "players.json")).load();
    const found = (await reopened.get(issued.player.id))!;
    expect(found.name).toBe("Ana");
    expect(found.career.trophies).toBe(issued.player.career.trophies);
    // And the indexes are rebuilt, not just the records.
    expect((await authenticate(reopened, issued.token))?.id).toBe(issued.player.id);
    expect(await reopened.nameOwner("ana")).toBe(issued.player.id);
  });

  it("drops the old token from its index after a recovery", async () => {
    const issued = await register(store, "Ana");
    await recover(store, issued.player.id, issued.recoveryCode);
    await store.flush();

    const reopened = await new JsonStore(join(dir, "players.json")).load();
    expect(await authenticate(reopened, issued.token)).toBeNull();
  });

  it("writes through a temp file so a crash cannot leave half a store", async () => {
    await player("Ana");
    await store.flush();
    const written = await readFile(join(dir, "players.json"), "utf8");
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it("starts empty rather than failing when there is nothing to read", async () => {
    const fresh = await new JsonStore(join(dir, "nothing-here.json")).load();
    expect(await fresh.size()).toBe(0);
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
  it("registers, and hands back both secrets exactly once", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });

    expect(created.status).toBe(201);
    expect(created.body.token).toHaveLength(48);
    expect(looksLikeRecovery(created.body.recoveryCode)).toBe(true);

    const me = await call("GET", "/api/players/me", { token: created.body.token });
    expect(me.status).toBe(200);
    expect(me.body.name).toBe("Ana");
    expect(me.body.token).toBeUndefined();
    expect(me.body.recoveryCode).toBeUndefined();
  });

  it("recovers an account onto a new device", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const back = await call("POST", "/api/players/recover", {
      body: { id: created.body.id, code: created.body.recoveryCode },
    });

    expect(back.status).toBe(200);
    expect(back.body.id).toBe(created.body.id);
    expect(back.body.token).not.toBe(created.body.token);

    const old = await call("GET", "/api/players/me", { token: created.body.token });
    expect(old.status).toBe(401);
  });

  it("refuses a recovery that does not match, without saying which part", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const wrong = await call("POST", "/api/players/recover", {
      body: { id: created.body.id, code: "AAAA-BBBB-CCCC-DDDD" },
    });
    const nobody = await call("POST", "/api/players/recover", {
      body: { id: "ZZZZZZZZ", code: "AAAA-BBBB-CCCC-DDDD" },
    });

    expect(wrong.status).toBe(403);
    expect(nobody.status).toBe(403);
    expect(wrong.body.error).toBe(nobody.body.error);
  });

  it("issues a new recovery code to a signed-in device", async () => {
    const created = await call("POST", "/api/players", { body: { name: "Ana" } });
    const fresh = await call("POST", "/api/players/me/recovery", { token: created.body.token });

    expect(fresh.status).toBe(200);
    expect(looksLikeRecovery(fresh.body.recoveryCode)).toBe(true);
    expect(fresh.body.recoveryCode).not.toBe(created.body.recoveryCode);
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
      ["POST", "/api/players/me/recovery"],
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
