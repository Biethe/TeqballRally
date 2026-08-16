import { describe, expect, it } from "vitest";
import {
  ALL_CHALLENGES,
  DAILY_COUNT,
  creditFor,
  dailyChallenges,
  dayKey,
  isComplete,
  secondsUntilRollover,
  type MatchTally,
} from "../src/challenges";
import {
  TIERS,
  coinsFor,
  nextTier,
  rankChange,
  tierFor,
  tierProgress,
  trophyDelta,
} from "../src/league";
import {
  MAX_LEVEL,
  MAX_TITLES,
  UNLOCK_AT,
  applySeason,
  XP_PER_LEVEL,
  buyUpgrade,
  claimChallenge,
  freshCareer,
  isUnlocked,
  levelOf,
  rollOver,
  settleMatch,
  upgradeCost,
  withCareer,
  type Career,
} from "../src/progress";
import { seasonKey, seasonReward, seasonTier, seasonTierId, softReset } from "../src/season";
import { CHARACTERS, SETS_TO_WIN, WIN_SCORE } from "../src/config";
import { RATING_KEYS, rating, totalPower } from "../src/ratings";
import { ALL_TIP_KEYS, randomTip, tipPool } from "../src/tips";
import { t } from "../src/i18n";

const DAY = "2026-08-10";
/**
 * A moment on `DAY`.
 *
 * `settleMatch` defaults to the real clock, and a career dated `DAY` rolls
 * over to whatever today happens to be — which quietly swapped the challenges
 * out from under a test that had looked up `DAY`'s. Anything that cares which
 * day it is says so.
 */
const ON_DAY = new Date(2026, 7, 10, 12, 0, 0);
const tally = (over: Partial<MatchTally> = {}): MatchTally => ({
  won: true,
  points: 12,
  sets: 2,
  rallies: 12,
  ...over,
});

describe("the trophy ladder", () => {
  it("climbs, and every rung is above the last", () => {
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i].floor, TIERS[i].id).toBeGreaterThan(TIERS[i - 1].floor);
      expect(TIERS[i].bonus, TIERS[i].id).toBeGreaterThan(TIERS[i - 1].bonus);
    }
  });

  it("gives everyone a rank, including a player who has never won", () => {
    expect(tierFor(0).id).toBe(TIERS[0].id);
    expect(tierFor(-5).id).toBe(TIERS[0].id);
  });

  it("reads the rank off the trophies at every boundary", () => {
    for (const tier of TIERS) {
      expect(tierFor(tier.floor).id, tier.id).toBe(tier.id);
      if (tier.floor > 0) expect(tierFor(tier.floor - 1).id).not.toBe(tier.id);
    }
  });

  it("runs out of rungs at the top rather than inventing one", () => {
    const top = TIERS[TIERS.length - 1];
    expect(nextTier(top.floor)).toBeNull();
    expect(tierProgress(top.floor + 500)).toBe(1);
  });

  it("fills the bar across a tier", () => {
    expect(tierProgress(TIERS[1].floor)).toBe(0);
    expect(tierProgress(TIERS[1].floor + (TIERS[2].floor - TIERS[1].floor) / 2)).toBeCloseTo(0.5, 6);
  });

  it("pays more for a win than a loss takes, at every difficulty", () => {
    for (const d of ["easy", "normal", "hard", "online"] as const) {
      expect(trophyDelta(true, d, 500), d).toBeGreaterThan(-trophyDelta(false, d, 500));
    }
  });

  it("makes beating a person worth more than beating the machine", () => {
    // The opponent was also trying, and it is the one difficulty a player
    // cannot choose to make easier.
    expect(trophyDelta(true, "online", 500)).toBeGreaterThan(trophyDelta(true, "hard", 500));
    expect(coinsFor(true, "online", 500)).toBeGreaterThan(coinsFor(true, "hard", 500));
    // …and costs more to lose, or the ladder would be farmed by playing up.
    expect(trophyDelta(false, "online", 500)).toBeLessThan(trophyDelta(false, "hard", 500));
  });

  it("never puts a player into trophy debt", () => {
    expect(trophyDelta(false, "hard", 0)).toBe(0);
    expect(trophyDelta(false, "hard", 5)).toBe(-5);
  });

  it("pays something for a match that was lost", () => {
    // Twenty minutes were spent either way. A game that pays nothing for them
    // is teaching the player to quit as soon as they fall behind.
    expect(coinsFor(false, "normal", 0)).toBeGreaterThan(0);
    expect(coinsFor(true, "normal", 0)).toBeGreaterThan(coinsFor(false, "normal", 0));
  });

  it("pays a higher rank more for the same result", () => {
    const top = TIERS[TIERS.length - 1].floor;
    expect(coinsFor(true, "normal", top)).toBeGreaterThan(coinsFor(true, "normal", 0));
  });

  it("reports crossing a rung, in both directions", () => {
    const rookie = TIERS[1].floor;
    expect(rankChange(rookie - 1, rookie)).toBe("promoted");
    expect(rankChange(rookie, rookie - 1)).toBe("relegated");
    expect(rankChange(rookie, rookie + 1)).toBeNull();
  });
});

describe("daily challenges", () => {
  it("offers three, and the same three all day", () => {
    const today = dailyChallenges(DAY);

    expect(today).toHaveLength(DAILY_COUNT);
    expect(dailyChallenges(DAY).map((c) => c.id)).toEqual(today.map((c) => c.id));
  });

  it("never repeats a kind, so three challenges are three things to do", () => {
    // A day offering "play 3", "play 5" and "win 3" is one challenge wearing
    // three hats, and finishing one all but finishes the rest.
    for (let d = 1; d <= 60; d++) {
      const day = `2026-01-${`${d}`.padStart(2, "0")}`;
      const kinds = dailyChallenges(day).map((c) => c.kind);
      expect(new Set(kinds).size, day).toBe(kinds.length);
    }
  });

  it("always finds a full set, whatever the day hashes to", () => {
    for (let d = 1; d <= 366; d++) {
      const day = `2027-${`${(d % 12) + 1}`.padStart(2, "0")}-${`${(d % 28) + 1}`.padStart(2, "0")}`;
      expect(dailyChallenges(day), day).toHaveLength(DAILY_COUNT);
    }
  });

  // The goals are sized against what one match can produce, and the scoring
  // has already been changed once. Without this, shortening a set again would
  // quietly turn a daily challenge into a weekly one and nothing would fail.
  it("keeps every goal reachable in a handful of matches", () => {
    const bestCase: MatchTally = {
      won: true,
      // A winning match: SETS_TO_WIN sets at WIN_SCORE, plus a lost set.
      points: WIN_SCORE * (SETS_TO_WIN + 1),
      sets: SETS_TO_WIN,
      rallies: WIN_SCORE * (SETS_TO_WIN + 1) * 2,
    };
    for (const challenge of ALL_CHALLENGES) {
      const perMatch = creditFor(challenge.kind, bestCase);
      expect(perMatch, challenge.id).toBeGreaterThan(0);
      // Six matches is a long session; anything needing more is not daily.
      expect(Math.ceil(challenge.goal / perMatch), challenge.id).toBeLessThanOrEqual(6);
    }
  });

  it("counts a match the way each kind asks for", () => {
    const t = tally({ won: false, points: 7, sets: 1, rallies: 9 });

    expect(creditFor("matches", t)).toBe(1);
    expect(creditFor("wins", t)).toBe(0);
    expect(creditFor("points", t)).toBe(7);
    expect(creditFor("sets", t)).toBe(1);
    expect(creditFor("rallies", t)).toBe(9);
  });

  it("counts overshooting a goal as finished", () => {
    expect(isComplete({ id: "x", kind: "wins", goal: 3, reward: 1 }, 5)).toBe(true);
    expect(isComplete({ id: "x", kind: "wins", goal: 3, reward: 1 }, 2)).toBe(false);
  });

  it("names the day in local time, not UTC", () => {
    // The day has to turn over while the player is asleep, and whose midnight
    // that is depends on where they are.
    const nearMidnight = new Date(2026, 7, 10, 23, 30);
    expect(dayKey(nearMidnight)).toBe("2026-08-10");
    expect(secondsUntilRollover(nearMidnight)).toBe(30 * 60);
  });
});

describe("a career", () => {
  it("starts with one player and nothing else", () => {
    const career = freshCareer(DAY);

    expect(career.coins).toBe(0);
    expect(career.trophies).toBe(0);
    expect(Object.keys(career.champions)).toEqual([CHARACTERS[0].id]);
  });

  it("pays out a win in trophies and coins", () => {
    const { career, outcome } = settleMatch(
      freshCareer(DAY),
      CHARACTERS[0].id,
      "normal",
      tally(),
      ON_DAY
    );

    expect(outcome.trophies).toBeGreaterThan(0);
    expect(outcome.coins).toBeGreaterThan(0);
    expect(career.trophies).toBe(outcome.trophies);
    expect(career.coins).toBe(outcome.coins);
  });

  it("remembers the best rank a relegation takes away", () => {
    // Unlocks are earned, not rented: dropping back down must not take a
    // character away from a player who already had it.
    let career = freshCareer(DAY);
    for (let i = 0; i < 8; i++) {
      career = settleMatch(career, CHARACTERS[0].id, "hard", tally(), ON_DAY).career;
    }
    const peak = career.trophies;
    for (let i = 0; i < 20; i++) {
      career = settleMatch(career, CHARACTERS[0].id, "hard", tally({ won: false }), ON_DAY).career;
    }

    expect(career.trophies).toBeLessThan(peak);
    expect(career.best).toBe(peak);
  });

  it("levels a character up for playing with it, win or lose", () => {
    let career = freshCareer(DAY);
    for (let i = 0; i < XP_PER_LEVEL; i++) {
      career = settleMatch(career, CHARACTERS[0].id, "normal", tally({ won: false }), ON_DAY).career;
    }

    expect(levelOf(career, CHARACTERS[0].id)).toBe(2);
  });

  it("stops levelling at the cap", () => {
    let career = freshCareer(DAY);
    for (let i = 0; i < XP_PER_LEVEL * (MAX_LEVEL + 4); i++) {
      career = settleMatch(career, CHARACTERS[0].id, "normal", tally(), ON_DAY).career;
    }

    expect(levelOf(career, CHARACTERS[0].id)).toBe(MAX_LEVEL);
  });

  it("spends the level on precision, which is what the spread divides by", () => {
    const base = CHARACTERS[0];

    expect(withCareer(base, 1).precision).toBe(base.precision);
    expect(withCareer(base, 3).precision).toBeGreaterThan(base.precision);
    // And nothing else moves: a levelled player keeps their ball in, they do
    // not kick it harder than the character they picked.
    expect(withCareer(base, MAX_LEVEL).power).toBe(base.power);
    expect(withCareer(base, MAX_LEVEL).speed).toBe(base.speed);
  });

  it("locks the roster behind trophies, and keeps it unlocked", () => {
    const career = freshCareer(DAY);
    const gated = CHARACTERS[3].id;

    expect(isUnlocked(career, CHARACTERS[0].id)).toBe(true);
    expect(isUnlocked(career, gated)).toBe(false);
    expect(isUnlocked({ ...career, best: UNLOCK_AT[gated] }, gated)).toBe(true);
    // Earned at the peak, kept after a slump.
    expect(isUnlocked({ ...career, best: UNLOCK_AT[gated], trophies: 0 }, gated)).toBe(true);
  });

  it("moves every unfinished challenge a match touches", () => {
    const career = freshCareer(DAY);
    const ids = dailyChallenges(DAY).map((c) => c.id);
    const { career: after } = settleMatch(career, CHARACTERS[0].id, "normal", tally(), ON_DAY);

    for (const id of ids) expect(after.progress[id], id).toBeGreaterThan(0);
  });

  it("pays a finished challenge once and only once", () => {
    const challenge = dailyChallenges(DAY)[0];
    const ready = {
      ...freshCareer(DAY),
      progress: { [challenge.id]: challenge.goal },
    };

    const paid = claimChallenge(ready, challenge.id);
    expect(paid.coins).toBe(challenge.reward);
    expect(claimChallenge(paid, challenge.id).coins).toBe(challenge.reward);
  });

  it("will not pay a challenge that is not finished", () => {
    const challenge = dailyChallenges(DAY)[0];
    const career = { ...freshCareer(DAY), progress: { [challenge.id]: challenge.goal - 1 } };

    expect(claimChallenge(career, challenge.id).coins).toBe(0);
  });

  it("clears the day's progress when the day turns", () => {
    const challenge = dailyChallenges(DAY)[0];
    const yesterday = {
      ...freshCareer(DAY),
      coins: 500,
      progress: { [challenge.id]: challenge.goal },
      claimed: [challenge.id],
    };

    const today = rollOver(yesterday, "2026-08-11");

    expect(today.progress).toEqual({});
    expect(today.claimed).toEqual([]);
    // The coins already collected are the player's; only the day resets.
    expect(today.coins).toBe(500);
  });

  it("sells a level for coins, and refuses when they are short", () => {
    const id = CHARACTERS[0].id;
    const cost = upgradeCost(1);
    const rich = { ...freshCareer(DAY), coins: cost };

    const bought = buyUpgrade(rich, id);
    expect(levelOf(bought, id)).toBe(2);
    expect(bought.coins).toBe(0);

    const broke = { ...freshCareer(DAY), coins: cost - 1 };
    expect(levelOf(buyUpgrade(broke, id), id)).toBe(1);
  });

  it("charges more for each level than the one before", () => {
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(upgradeCost(level + 1)).toBeGreaterThan(upgradeCost(level));
    }
  });

  it("will not sell a level for a character that is still locked", () => {
    const gated = CHARACTERS[3].id;
    const career = { ...freshCareer(DAY), coins: 99999 };

    expect(levelOf(buyUpgrade(career, gated), gated)).toBe(1);
  });
});

describe("trait ratings", () => {
  it("puts every character on the same scale, in the readable band", () => {
    for (const def of CHARACTERS) {
      for (const key of RATING_KEYS) {
        const score = rating(def, key);
        // None of these characters is bad at anything — they are differently
        // good — so nobody starts at the bottom of the bar.
        expect(score, `${def.label} ${key}`).toBeGreaterThanOrEqual(40);
        expect(score, `${def.label} ${key}`).toBeLessThanOrEqual(100);
      }
    }
  });

  it("leaves the top of the bar as somewhere to get to", () => {
    // A fresh roster with somebody already at 100 has nothing to show for an
    // upgrade, which is the one thing the bar exists to show.
    const fresh = Math.max(...CHARACTERS.map((c) => rating(c, "control")));
    const trained = rating(withCareer(CHARACTERS[0], MAX_LEVEL), "control");

    expect(fresh).toBeLessThan(100);
    expect(trained).toBeGreaterThan(rating(CHARACTERS[0], "control"));
  });

  it("keeps the roster's differences rather than flattening them", () => {
    const power = CHARACTERS.map((c) => rating(c, "power"));
    expect(new Set(power).size).toBeGreaterThan(1);
  });

  it("adds up to one number two players can be compared by", () => {
    const strong = withCareer(CHARACTERS[0], MAX_LEVEL);

    expect(totalPower(strong)).toBeGreaterThan(totalPower(CHARACTERS[0]));
    expect(totalPower(CHARACTERS[0])).toBe(
      RATING_KEYS.reduce((sum, k) => sum + rating(CHARACTERS[0], k), 0)
    );
  });
});

describe("loading tips", () => {
  it("has a translation for every tip it can show", () => {
    for (const key of ALL_TIP_KEYS) {
      expect(t(key), key).toBeTruthy();
      expect(t(key), key).not.toBe(key);
    }
  });

  it("can reach every tip across the device pools", () => {
    // No single device sees every tip — the gesture tips are meaningless at a
    // keyboard and the charge-bar tip never applies to portrait swipes — but
    // between the pools nothing in the catalogue is unreachable.
    const seen = new Set<string>();
    for (const pool of [tipPool(false, false), tipPool(true, false), tipPool(true, true)]) {
      for (let i = 0; i < pool.length; i++) seen.add(randomTip(() => i / pool.length, pool));
    }
    expect(seen.size).toBe(ALL_TIP_KEYS.length);
  });

  it("never hands a keyboard player a swipe", () => {
    for (const key of tipPool(false, false)) {
      expect(t(key).toLowerCase(), key).not.toContain("swipe");
    }
  });

  it("survives a random that returns exactly 1", () => {
    // Math.random() is documented as [0, 1), but a stubbed or unusual source
    // is not, and an out-of-range index here would show a blank loading line.
    expect(randomTip(() => 1)).toBeTruthy();
  });
});

describe("seasons", () => {
  const AUG = new Date(2026, 7, 20);
  const SEP = new Date(2026, 8, 2);
  const climbed = (trophies: number, over: Partial<Career> = {}): Career => ({
    ...freshCareer(DAY),
    trophies,
    best: trophies,
    seasonBest: trophies,
    ...over,
  });

  it("dates a season the way the day is dated, so the two never disagree", () => {
    // `freshCareer` derives the season from the day key. If those two ever
    // stopped lining up, every new career would start one season adrift.
    for (const when of [AUG, SEP, new Date(2027, 0, 1), new Date(2026, 11, 31)]) {
      expect(dayKey(when).slice(0, 7)).toBe(seasonKey(when));
      expect(freshCareer(dayKey(when)).season).toBe(seasonKey(when));
    }
  });

  it("leaves a career alone inside its own season", () => {
    const career = climbed(400);
    const { career: after, ended } = applySeason(career, AUG);

    expect(after).toBe(career);
    expect(ended).toBeNull();
  });

  it("halves the trophies when the month turns, and says so", () => {
    const { career, ended } = applySeason(climbed(401), SEP);

    expect(career.trophies).toBe(201);
    expect(career.season).toBe("2026-09");
    expect(ended?.from).toBe(401);
    expect(ended?.to).toBe(201);
    // The month that ended, not the one that started.
    expect(ended?.title.season).toBe("2026-08");
  });

  it("keeps the ladder in the same order it was in", () => {
    // The whole case for halving over any cleverer curve: everybody lands in
    // the same sequence, so nobody is overtaken by the reset itself.
    const before = [0, 5, 61, 62, 300, 301, 1200];
    const after = before.map(softReset);

    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1]);
    expect(after.every((n) => n >= 0)).toBe(true);
  });

  it("judges the season on the best held, not the total left at the end", () => {
    // Reached PRO territory, then had a bad week. The title is the peak.
    const { ended } = applySeason(climbed(40, { seasonBest: 600 }), SEP);

    expect(ended?.title.best).toBe(600);
    expect(ended?.title.tier).toBe(seasonTier(600));
    expect(ended?.coins).toBe(seasonReward(seasonTierId(600)));
    expect(ended?.coins).toBeGreaterThan(0);
  });

  it("starts the new season from what was carried into it", () => {
    const { career } = applySeason(climbed(500), SEP);

    expect(career.seasonBest).toBe(career.trophies);
  });

  it("closes a season nobody played without a title or a card", () => {
    const { career, ended } = applySeason(freshCareer(DAY), SEP);

    expect(ended).toBeNull();
    expect(career.season).toBe("2026-09");
    expect(career.titles).toHaveLength(0);
    expect(career.coins).toBe(0);
  });

  it("charges the halving once for an absence, not once a month", () => {
    // Away since April. A holiday must not cost more than a bad run.
    const away = climbed(800, { season: "2026-04" });
    const { career, ended } = applySeason(away, SEP);

    expect(career.trophies).toBe(400);
    expect(career.titles).toHaveLength(1);
    expect(ended?.title.season).toBe("2026-04");
  });

  it("keeps the shelf of finished seasons, newest last and bounded", () => {
    let career = climbed(300);
    for (let month = 0; month < MAX_TITLES + 5; month++) {
      const when = new Date(2026, 8 + month, 2);
      career = { ...applySeason(career, when).career, seasonBest: 300, trophies: 300 };
    }

    expect(career.titles).toHaveLength(MAX_TITLES);
    // Trimmed from the front: what falls off is the oldest.
    expect(career.titles[career.titles.length - 1].season > career.titles[0].season).toBe(true);
  });

  it("pays a season reward that grows with the tier reached", () => {
    expect(seasonReward(TIERS[0].id)).toBe(0);
    for (let i = 2; i < TIERS.length; i++) {
      expect(seasonReward(TIERS[i].id)).toBeGreaterThan(seasonReward(TIERS[i - 1].id));
    }
    // An id that is not a tier pays nothing rather than throwing.
    expect(seasonReward("not-a-tier")).toBe(0);
  });

  it("rolls the season over before it settles a match played in the new one", () => {
    const { career, outcome } = settleMatch(climbed(400), CHARACTERS[0].id, "normal", tally(), SEP);

    // The win is paid on top of the halved total, not the old one.
    expect(career.trophies).toBe(200 + outcome.trophies);
    expect(outcome.season?.from).toBe(400);
    expect(career.season).toBe("2026-09");
  });

  it("says nothing about a season on an ordinary match", () => {
    const { outcome } = settleMatch(climbed(400), CHARACTERS[0].id, "normal", tally(), AUG);

    expect(outcome.season).toBeNull();
  });

  it("tracks the season best as trophies are won", () => {
    let career = freshCareer(DAY);
    for (let i = 0; i < 4; i++) {
      career = settleMatch(career, CHARACTERS[0].id, "hard", tally(), AUG).career;
    }
    const peak = career.seasonBest;
    for (let i = 0; i < 6; i++) {
      career = settleMatch(career, CHARACTERS[0].id, "hard", tally({ won: false }), AUG).career;
    }

    expect(career.trophies).toBeLessThan(peak);
    expect(career.seasonBest).toBe(peak);
  });
});
