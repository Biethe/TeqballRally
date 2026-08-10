import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleRules } from "../scripts/build-rules.mjs";
import { CHARACTERS } from "../src/config";
import { settleMatch, freshCareer } from "../src/progress";
import { dayKey } from "../src/challenges";

const OUT = fileURLToPath(new URL("../server/rules.mjs", import.meta.url));

describe("the rules the server runs", () => {
  it("are the ones in src/, byte for byte", async () => {
    // The bundle is committed because the deploy image deliberately carries no
    // build tooling. That is only safe if drifting from the source fails here:
    // a server scoring matches by last month's rules is a leaderboard nobody
    // can explain.
    const committed = await readFile(OUT, "utf8");
    const fresh = await bundleRules();

    expect(
      committed === fresh,
      "server/rules.mjs is stale — run: node scripts/build-rules.mjs"
    ).toBe(true);
  });

  it("score a match the same way on both sides", async () => {
    const rules = await import("../server/rules.mjs");
    const day = dayKey(new Date(2026, 7, 10));
    const tally = { won: true, points: 6, sets: 2, rallies: 8 };

    const here = settleMatch(freshCareer(day), CHARACTERS[0].id, "normal", tally, new Date(2026, 7, 10));
    const there = rules.settleMatch(
      rules.freshCareer(day),
      CHARACTERS[0].id,
      "normal",
      tally,
      new Date(2026, 7, 10)
    );

    expect(there.outcome).toEqual(here.outcome);
    expect(there.career).toEqual(here.career);
  });

  it("carry nothing that needs a browser", async () => {
    // Anything reaching for localStorage or the DOM would throw the first time
    // the server touched it, which would be in production.
    const source = await readFile(OUT, "utf8");
    for (const forbidden of ["localStorage", "document.", "window."]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});
