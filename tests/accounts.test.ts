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
  FORFEIT_AFTER_SETS,
  MAX_FRIENDS,
  MAX_TALLY,
  ValidationError,
  addFriend,
  authenticate,
  claim,
  leaderboard,
  normaliseName,
  privateProfile,
  publicProfile,
  recordMatch,
  freshen,
  friendsOf,
  recordOnlineMatch,
  recover,
  regenerateRecovery,
  register,
  removeFriend,
  applyPurchaseEvent,
  rename,
  upgrade,
  validateResult,
} from "../server/accounts.mjs";
import { looksLikeRecovery, recoveryLookup, tidyRecovery } from "../server/secrets.mjs";
import { arrived, reset as resetPresence } from "../server/presence.mjs";
import { begin, departed, reset as resetMatches } from "../server/matches.mjs";
import { handleApi } from "../server/api.mjs";
import { CHARACTERS, SETS_TO_WIN, WIN_SCORE } from "../src/config";
import { dailyChallenges } from "../src/challenges";
import { upgradeCost } from "../src/progress";
import { seasonKey } from "../src/season";

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
  resetPresence();
  resetMatches();
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

    const back = await recover(store, issued.recoveryCode);

    expect(back.player.id).toBe(issued.player.id);
    expect(back.player.career.trophies).toBe(issued.player.career.trophies);
    expect((await authenticate(store, back.token))?.id).toBe(issued.player.id);
  });

  it("stops the old device", async () => {
    // Recovery is what somebody does when a phone is gone. An account that
    // keeps answering to that phone has not been recovered.
    const issued = await register(store, "Ana");
    await recover(store, issued.recoveryCode);

    expect(await authenticate(store, issued.token)).toBeNull();
  });

  it("spends the code it was given", async () => {
    // A slip of paper somebody else photographed must not keep working.
    const issued = await register(store, "Ana");
    const first = await recover(store, issued.recoveryCode);

    await expect(recover(store, issued.recoveryCode)).rejects.toThrow(ValidationError);
    await expect(recover(store, first.recoveryCode)).resolves.toBeTruthy();
  });

  it("forgives how a person types it", async () => {
    const issued = await register(store, "Ana");
    const sloppy = issued.recoveryCode.toLowerCase().replace(/-/g, " ");

    await expect(recover(store, sloppy)).resolves.toBeTruthy();
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
    await register(store, "Ana");
    const messages = new Set<string>();
    for (const code of ["AAAA-BBBB-CCCC-DDDD", "nonsense", ""]) {
      await recover(store, code).catch((err: ValidationError) => {
        messages.add(err.message);
        expect(err.status).toBe(403);
      });
    }
    expect(messages.size).toBe(1);
  });

  it("finds the account from the code alone", async () => {
    // The code is unique to one profile, and the person typing it has just
    // lost the phone that knew anything else about it. Asking for a player id
    // beside it meant somebody holding the slip still could not get back in.
    await register(store, "Bea");
    const issued = await register(store, "Ana");
    await register(store, "Cal");

    const back = await recover(store, issued.recoveryCode);

    expect(back.player.id).toBe(issued.player.id);
    expect(back.player.name).toBe("Ana");
  });

  it("stops finding the account by a code that has been spent", async () => {
    const issued = await register(store, "Ana");
    const first = await recover(store, issued.recoveryCode);
    // The index has to let go of the old digest, not merely refuse the check.
    expect(await store.byRecovery(recoveryLookup(issued.recoveryCode))).toBeNull();
    expect((await store.byRecovery(recoveryLookup(first.recoveryCode)))?.id).toBe(
      issued.player.id
    );
  });

  it("still finds an account issued before the lookup index existed", async () => {
    // Those accounts cannot be indexed after the fact: the lookup is a digest
    // of the code, and the code was never kept. The code is offered to each
    // salted digest instead, and recovering mints a fresh one that *is*
    // indexed — so an account leaves the slow path the first time it is used.
    const issued = await register(store, "Ana");
    delete (issued.player as { recoveryLookup?: string }).recoveryLookup;
    store.recoveries.clear();
    await store.save(issued.player);

    const back = await recover(store, issued.recoveryCode);

    expect(back.player.id).toBe(issued.player.id);
    expect(back.player.recoveryLookup).toBeTruthy();
    // Healed: the fresh code is found by the index rather than by the scan.
    expect((await store.byRecovery(recoveryLookup(back.recoveryCode)))?.id).toBe(
      issued.player.id
    );
  });

  it("can be replaced from a device that is already signed in", async () => {
    const issued = await register(store, "Ana");
    const fresh = await regenerateRecovery(store, issued.player);

    expect(fresh).not.toBe(issued.recoveryCode);
    await expect(recover(store, issued.recoveryCode)).rejects.toThrow();
    await expect(recover(store, fresh)).resolves.toBeTruthy();
  });
});

describe("friends", () => {
  it("is mutual the moment it is made", async () => {
    // A player code is not published anywhere, so somebody adding you already
    // had it from you. A request to accept would be two more screens for a
    // permission that was given when the code was shared.
    const ana = await player("Ana");
    const bobby = await player("Bobby");

    await addFriend(store, ana, bobby.id);

    expect(ana.friends).toContain(bobby.id);
    expect(bobby.friends).toContain(ana.id);
  });

  it("takes a code typed in any case", async () => {
    const ana = await player("Ana");
    const bobby = await player("Bobby");

    await addFriend(store, ana, ` ${bobby.id.toLowerCase()} `);
    expect(ana.friends).toContain(bobby.id);
  });

  it("adds nobody twice", async () => {
    const ana = await player("Ana");
    const bobby = await player("Bobby");

    await addFriend(store, ana, bobby.id);
    await addFriend(store, ana, bobby.id);

    expect(ana.friends).toHaveLength(1);
    expect(bobby.friends).toHaveLength(1);
  });

  it("refuses your own code, and one nobody holds", async () => {
    const ana = await player("Ana");

    await expect(addFriend(store, ana, ana.id)).rejects.toThrow(/your own/);
    await expect(addFriend(store, ana, "ZZZZZZZZ")).rejects.toThrow(ValidationError);
  });

  it("stops at a list a screen can still show", async () => {
    const ana = await player("Ana");
    ana.friends = Array.from({ length: MAX_FRIENDS }, (_, i) => `FILLER${i}`);
    const bobby = await player("Bobby");

    await expect(addFriend(store, ana, bobby.id)).rejects.toThrow(ValidationError);
  });

  it("will not push somebody over their own limit either", async () => {
    const ana = await player("Ana");
    const bobby = await player("Bobby");
    bobby.friends = Array.from({ length: MAX_FRIENDS }, (_, i) => `FILLER${i}`);

    await expect(addFriend(store, ana, bobby.id)).rejects.toThrow(/their/);
    expect(ana.friends).toHaveLength(0);
  });

  it("removes from both sides", async () => {
    // A friendship one side can see and the other cannot is a bug that shows
    // up as a message nobody receives.
    const ana = await player("Ana");
    const bobby = await player("Bobby");
    await addFriend(store, ana, bobby.id);

    await removeFriend(store, ana, bobby.id);

    expect(ana.friends).toHaveLength(0);
    expect(bobby.friends).toHaveLength(0);
  });

  it("puts whoever can be played right now at the top", async () => {
    const ana = await player("Ana");
    const quiet = await player("Quiet");
    const busy = await player("Busy");
    const away = await player("Away");
    await addFriend(store, ana, quiet.id);
    await addFriend(store, ana, busy.id);
    await addFriend(store, ana, away.id);
    quiet.career = { ...quiet.career, trophies: 900 };
    arrived(busy.id);

    const list = await friendsOf(store, ana);

    // "Who can I play right now" is the question the list exists to answer.
    expect(list[0].name).toBe("Busy");
    expect(list[0].online).toBe(true);
    expect(list[1].name).toBe("Quiet");
    expect(list[1].online).toBe(false);
  });

  it("quietly drops a friend who is no longer in the store", async () => {
    const ana = await player("Ana");
    ana.friends = ["GONE0000"];

    await expect(friendsOf(store, ana)).resolves.toEqual([]);
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

describe("ranked online", () => {
  const WON = { won: true, points: WIN_SCORE * SETS_TO_WIN, sets: SETS_TO_WIN, rallies: 6 };
  const LOST = { won: false, points: WIN_SCORE + 1, sets: 1, rallies: 6 };
  const at = new Date(MATCH_COOLDOWN_MS * 10);

  /** Two accounts and a match between them, as the relay would have opened it. */
  async function pair() {
    const home = await player("Home");
    const away = await player("Away");
    const matchId = begin(home.id, away.id);
    const report = (side: "home" | "away", over: Record<string, unknown> = {}) => ({
      matchId,
      championId: CHARACTERS[0].id,
      ...(side === "home" ? WON : LOST),
      opponentSets: side === "home" ? LOST.sets : WON.sets,
      ...over,
    });
    return { home, away, matchId, report };
  }

  it("holds a report that only one side has made", async () => {
    // A leaderboard where one end of a connection decides the result is a
    // leaderboard for whoever is willing to edit their client.
    const { home, report } = await pair();

    const res = await recordOnlineMatch(store, home, report("home"), at);

    expect(res).toEqual({ pending: true });
    expect(home.career.trophies).toBe(0);
  });

  it("pays both once the two ends agree", async () => {
    const { home, away, report } = await pair();

    await recordOnlineMatch(store, home, report("home"), at);
    const settled = await recordOnlineMatch(store, away, report("away"), at);

    expect("outcome" in settled).toBe(true);
    expect(home.career.trophies).toBeGreaterThan(0);
    expect(away.career.trophies).toBe(0); // lost, and cannot go below zero
    expect(away.matches).toBe(1);
    expect(home.matches).toBe(1);
  });

  it("pays nobody when the two ends disagree", async () => {
    const { home, away, report } = await pair();
    await recordOnlineMatch(store, home, report("home"), at);

    // Both claiming the win is the disagreement worth catching.
    await expect(recordOnlineMatch(store, away, report("away", WON), at)).rejects.toThrow(
      /disagree/
    );
    expect(home.career.trophies).toBe(0);
    expect(away.career.trophies).toBe(0);
  });

  it("pays a match once, however many times it is asked about", async () => {
    const { home, away, report } = await pair();
    await recordOnlineMatch(store, home, report("home"), at);
    await recordOnlineMatch(store, away, report("away"), at);
    const won = home.career.trophies;
    const coins = home.career.coins;

    await recordOnlineMatch(store, home, report("home"), at);
    await recordOnlineMatch(store, home, report("home"), at);

    expect(home.career.trophies).toBe(won);
    expect(home.career.coins).toBe(coins);
  });

  it("hands the first reporter their result when they come back for it", async () => {
    // Both sides report the instant the match ends, so one of them always
    // arrives before the other and is told to wait. Refusing them afterwards
    // is why a player watched their opponent get paid and got nothing.
    const { home, away, report } = await pair();

    const early = await recordOnlineMatch(store, home, report("home"), at);
    expect(early).toEqual({ pending: true });

    await recordOnlineMatch(store, away, report("away"), at);
    const collected = await recordOnlineMatch(store, home, report("home"), at);

    expect("outcome" in collected).toBe(true);
    if (!("outcome" in collected)) return;
    expect(collected.outcome.coins).toBeGreaterThan(0);
    expect(collected.career.coins).toBe(home.career.coins);
  });

  it("gives the win away when the relay saw them leave", async () => {
    const { home, away, matchId, report } = await pair();
    departed(matchId, away.id);

    const res = await recordOnlineMatch(store, home, report("home"), at);

    expect("outcome" in res).toBe(true);
    expect(home.career.trophies).toBeGreaterThan(0);
    expect(away.matches).toBe(1); // the forfeit counts against them
  });

  it("voids a match somebody left in the opening set", async () => {
    // A train going into a tunnel on the first point is not rage-quitting, and
    // punishing it makes the ladder a measure of signal strength.
    const { home, away, matchId, report } = await pair();
    departed(matchId, away.id);

    await expect(
      recordOnlineMatch(
        store,
        home,
        report("home", { sets: FORFEIT_AFTER_SETS - 1, points: 1, opponentSets: 0 }),
        at
      )
    ).rejects.toThrow(/too early/);
    expect(home.career.trophies).toBe(0);
  });

  it("will not let the leaver claim the walkover", async () => {
    const { away, matchId, report } = await pair();
    departed(matchId, away.id);

    // The one who left reporting a win of their own gets nothing: the relay
    // knows which socket went.
    const res = await recordOnlineMatch(store, away, report("away", WON), at);
    expect(res).toEqual({ pending: true });
    expect(away.career.trophies).toBe(0);
  });

  it("refuses a match that was never opened, or was somebody else's", async () => {
    const { home, report } = await pair();
    const stranger = await player("Stranger");

    await expect(
      recordOnlineMatch(store, home, { ...report("home"), matchId: "made-up" }, at)
    ).rejects.toThrow(/not one of ours/);
    await expect(recordOnlineMatch(store, stranger, report("home"), at)).rejects.toThrow(
      /not your match/
    );
  });

  it("still checks the result is one a match could produce", async () => {
    const { home, report } = await pair();

    await expect(
      recordOnlineMatch(store, home, report("home", { points: 9999 }), at)
    ).rejects.toThrow(ValidationError);
  });

  it("is worth more than any match against the machine", async () => {
    const { home, away, report } = await pair();
    const offline = await player("Offline");
    await recordMatch(store, offline, { ...WIN, difficulty: "hard" }, at);

    await recordOnlineMatch(store, home, report("home"), at);
    await recordOnlineMatch(store, away, report("away"), at);

    expect(home.career.trophies).toBeGreaterThan(offline.career.trophies);
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

describe("seasons on the server", () => {
  const AUG = new Date(2026, 7, 20);
  const SEP = new Date(2026, 8, 2);

  /** A player who finished August with some trophies to their name. */
  async function veteran(name: string, trophies: number): Promise<PlayerRecord> {
    const p = await player(name, AUG);
    p.career = { ...p.career, trophies, best: trophies, seasonBest: trophies };
    await store.save(p);
    return p;
  }

  it("rolls a career over the moment it is next touched", async () => {
    const ana = await veteran("Ana", 400);
    const ended = await freshen(store, ana, SEP);

    expect(ended?.from).toBe(400);
    expect(ana.career.trophies).toBe(200);
    // And written back, so the next boot does not pay for the season again.
    expect((await store.get(ana.id))!.career.trophies).toBe(200);
  });

  it("pays the season reward once, however often it is asked", async () => {
    const ana = await veteran("Ana", 400);
    await freshen(store, ana, SEP);
    const coins = ana.career.coins;
    await freshen(store, ana, SEP);
    await privateProfile(store, ana, SEP);

    expect(ana.career.coins).toBe(coins);
    expect(ana.career.titles).toHaveLength(1);
  });

  it("shows the profile this season's numbers, not last season's", async () => {
    const ana = await veteran("Ana", 400);
    const view = await privateProfile(store, ana, SEP);

    expect(view.trophies).toBe(200);
    expect(view.career.season).toBe(seasonKey(SEP));
  });

  it("settles a match against the reset total", async () => {
    const ana = await veteran("Ana", 400);
    const { career } = await recordMatch(store, ana, WIN, SEP);

    expect(career.trophies).toBeGreaterThan(200);
    expect(career.trophies).toBeLessThan(400);
  });

  it("resets the board itself rather than waiting for everyone to log in", async () => {
    // The point of a season. A board still showing August in September is not
    // a new season, it is the old one with a different name.
    await veteran("Ana", 400);
    await veteran("Bobby", 300);
    const rows = await leaderboard(store, 10, SEP);

    expect(rows.map((r) => r.trophies)).toEqual([200, 150]);
    expect(rows.map((r) => r.name)).toEqual(["Ana", "Bobby"]);
  });

  it("does not let a player who has not been back outrank one who has", async () => {
    // Absent players carry last season's inflated total in the store, so the
    // query returns them too high. Settling the page is what fixes the order.
    const away = await veteran("Away", 300);
    const back = await veteran("Back", 400);
    await freshen(store, back, SEP);

    expect(away.career.trophies).toBe(300);
    expect(back.career.trophies).toBe(200);
    const rows = await leaderboard(store, 10, SEP);
    expect(rows.map((r) => r.name)).toEqual(["Back", "Away"]);
    expect(rows.map((r) => r.trophies)).toEqual([200, 150]);
  });

  it("leaves everyone alone inside a season", async () => {
    const ana = await veteran("Ana", 400);
    const rows = await leaderboard(store, 10, AUG);

    expect(rows[0].trophies).toBe(400);
    expect(ana.career.titles).toHaveLength(0);
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
    await recover(store, issued.recoveryCode);
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
  opts: { body?: unknown; token?: string; forwardedFor?: string } = {}
): Promise<{ status: number; body: any }> {
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req: any = {
    method,
    url: path,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.forwardedFor ? { "x-forwarded-for": opts.forwardedFor } : {}),
    },
    // Random, because every request in this suite is a different caller as far
    // as the rate limiter is concerned. The proxied case is the exception and
    // says so: see "the rate limit follows the caller, not the proxy".
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
  it("rate limits the caller, not the proxy in front of it", async () => {
    // Behind Cloud Run every request reaches the process from Google's
    // frontend, so keying on the socket put the whole world in one bucket:
    // the limit protected nothing and could answer 429 to a player who had
    // made a single request. The last hop of x-forwarded-for is the address
    // the frontend actually saw, and the only one the caller cannot invent.
    const proxied = (client: string) =>
      call("GET", "/api/leaderboard", { forwardedFor: `203.0.113.9, ${client}` });

    let last = 0;
    for (let i = 0; i < 130; i++) last = (await proxied("198.51.100.7")).status;
    expect(last).toBe(429);

    // A different caller through the same proxy is unaffected — which is the
    // half that was broken, not the half that was missing.
    expect((await proxied("198.51.100.8")).status).toBe(200);
  });

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
      ["GET", "/api/players/me/friends"],
      ["POST", "/api/players/me/friends"],
      ["POST", "/api/players/me/friends/remove"],
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

  it("adds and removes a friend over HTTP", async () => {
    const ana = await call("POST", "/api/players", { body: { name: "Ana" } });
    const bobby = await call("POST", "/api/players", { body: { name: "Bobby" } });

    const added = await call("POST", "/api/players/me/friends", {
      token: ana.body.token,
      body: { code: bobby.body.id },
    });
    expect(added.status).toBe(200);
    expect(added.body.friends).toHaveLength(1);
    expect(added.body.friends[0].name).toBe("Bobby");

    // …and from the other side, without them having done anything.
    const theirs = await call("GET", "/api/players/me/friends", { token: bobby.body.token });
    expect(theirs.body.friends[0].name).toBe("Ana");

    const gone = await call("POST", "/api/players/me/friends/remove", {
      token: ana.body.token,
      body: { id: bobby.body.id },
    });
    expect(gone.body.friends).toHaveLength(0);
  });

  it("says so when a friend code is not a player", async () => {
    const ana = await call("POST", "/api/players", { body: { name: "Ana" } });
    const res = await call("POST", "/api/players/me/friends", {
      token: ana.body.token,
      body: { code: "ZZZZZZZZ" },
    });

    expect(res.status).toBe(404);
  });

  it("never puts a secret on a friend's card", async () => {
    const ana = await call("POST", "/api/players", { body: { name: "Ana" } });
    const bobby = await call("POST", "/api/players", { body: { name: "Bobby" } });
    await call("POST", "/api/players/me/friends", {
      token: ana.body.token,
      body: { code: bobby.body.id },
    });

    const list = await call("GET", "/api/players/me/friends", { token: ana.body.token });
    expect(JSON.stringify(list.body)).not.toContain(bobby.body.token);
    expect(JSON.stringify(list.body)).not.toContain("Hash");
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

/**
 * Things a player owns have to be owned by the *server*.
 *
 * The career is re-read from the server on every launch, so anything only the
 * device knew about disappeared the next time the app was opened — while the
 * store, which does remember a purchase, then refused to sell it again. The
 * player was left owning nothing and unable to buy it.
 */
describe("what a player keeps", () => {
  /** A webhook as RevenueCat sends one. */
  const event = (playerId: string, productId: string, id = `evt-${productId}`) => ({
    id,
    type: "NON_RENEWING_PURCHASE",
    app_user_id: playerId,
    product_id: productId,
  });

  it("grants what a product is worth, on RevenueCat's word and not the player's", async () => {
    const issued = await register(store, "Ana");

    await applyPurchaseEvent(store, event(issued.player.id, "coins_bag"));

    const saved = await store.get(issued.player.id);
    expect(saved?.career.coins).toBe(9000);
  });

  it("records an unlock against the account, not just the device", async () => {
    const issued = await register(store, "Ana");

    await applyPurchaseEvent(store, event(issued.player.id, "char_england"));

    const saved = await store.get(issued.player.id);
    expect(saved?.career.unlockedAssets).toContain("EnglishPlayer");
    // And a character gets a champion record, or the roster has an entry
    // nothing can level up.
    expect(saved?.career.champions.EnglishPlayer).toBeTruthy();
  });

  it("opens a bundle into everything it stands for", async () => {
    const issued = await register(store, "Ana");

    await applyPurchaseEvent(store, event(issued.player.id, "bundle_balls"));

    const owned = (await store.get(issued.player.id))?.career.unlockedAssets ?? [];
    expect(owned).toContain("BlueBall");
    expect(owned).toContain("BlueAndRoseBall");
    expect(owned).toContain("OrangeAndBlackBall");
  });

  it("credits a retried webhook exactly once", async () => {
    // RevenueCat retries anything it did not get an answer to, so the same
    // purchase arrives again. Coins credited twice are coins nobody paid for.
    const issued = await register(store, "Ana");
    const e = event(issued.player.id, "coins_handful", "evt-once");

    await applyPurchaseEvent(store, e);
    await applyPurchaseEvent(store, e);
    await applyPurchaseEvent(store, e);

    expect((await store.get(issued.player.id))?.career.coins).toBe(1200);
  });

  it("grants nothing on an event that is not a purchase", async () => {
    const issued = await register(store, "Ana");

    const out = await applyPurchaseEvent(store, {
      ...event(issued.player.id, "coins_bag"),
      type: "CANCELLATION",
    });

    expect(out.applied).toBe(false);
    expect((await store.get(issued.player.id))?.career.coins).toBe(0);
  });

  it("says no rather than failing for a player it cannot find", async () => {
    // Answering 200 stops RevenueCat retrying something that can never work.
    const out = await applyPurchaseEvent(store, event("ZZZZZZZZ", "coins_bag"));
    expect(out.applied).toBe(false);
  });

  it("refuses a product the game does not sell", async () => {
    // The catalogue and the store disagreeing is worth hearing about, not
    // worth silently succeeding on.
    const issued = await register(store, "Ana");
    await expect(
      applyPurchaseEvent(store, event(issued.player.id, "coins_infinite"))
    ).rejects.toThrow();
  });

  it("keeps a claimed challenge on the account", async () => {
    // The same failure wearing different clothes: claimed coins that only the
    // device knew about were gone by the next launch.
    const issued = await register(store, "Ana");
    const challenge = dailyChallenges(issued.player.career.day)[0];
    issued.player.career = {
      ...issued.player.career,
      progress: { ...issued.player.career.progress, [challenge.id]: challenge.goal },
    };
    await store.save(issued.player);

    const career = await claim(store, issued.player, challenge.id);

    expect(career.claimed).toContain(challenge.id);
    expect((await store.get(issued.player.id))?.career.claimed).toContain(challenge.id);
  });
});
