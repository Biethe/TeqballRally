import { CHARACTERS, type CharacterDef } from "./config";
import { creditFor, dailyChallenges, dayKey, isComplete, type MatchTally } from "./challenges";
import { coinsFor, rankChange, trophyDelta, type Difficulty } from "./league";

/**
 * The career: what a player keeps between matches.
 *
 * Deliberately small and deliberately local. There is no account, no server
 * and nothing to sync — the whole progression is a few numbers in
 * `localStorage`, which is what lets it work on a plane and what stops it
 * becoming a login wall in front of a game about kicking a ball.
 *
 * Reading is total: a missing, corrupt or hand-edited store returns a fresh
 * career rather than throwing. A save file is never worth failing a boot over.
 */

export interface ChampionState {
  /** 1 and up. Raises the character's precision — see `withCareer`. */
  level: number;
  /** Matches played with this character since the last level. */
  xp: number;
}

export interface Career {
  coins: number;
  trophies: number;
  /** The highest trophy count ever reached, which relegation cannot take away. */
  best: number;
  champions: Record<string, ChampionState>;
  /** The day the current challenges belong to (`YYYY-MM-DD`). */
  day: string;
  /** Challenge id → progress so far today. */
  progress: Record<string, number>;
  /** Challenge ids whose reward has been collected today. */
  claimed: string[];
}

export const STARTING_CHAMPION = CHARACTERS[0].id;

export function freshCareer(day: string): Career {
  return {
    coins: 0,
    trophies: 0,
    best: 0,
    // Everyone starts with one player. The rest are the reason to keep playing.
    champions: { [STARTING_CHAMPION]: { level: 1, xp: 0 } },
    day,
    progress: {},
    claimed: [],
  };
}

const KEY = "teqopen.career";

/** Trophies at which each character beyond the first unlocks. */
export const UNLOCK_AT: Record<string, number> = {
  [CHARACTERS[0].id]: 0,
  [CHARACTERS[1].id]: 60,
  [CHARACTERS[2].id]: 160,
  [CHARACTERS[3].id]: 300,
};

/** Matches with a character needed to take it to the next level. */
export const XP_PER_LEVEL = 3;
/** Coins the next level costs, growing with the level already reached. */
export function upgradeCost(level: number): number {
  return 150 + (level - 1) * 120;
}
/** A character stops improving here, so a long career is not an unbeatable one. */
export const MAX_LEVEL = 6;

/**
 * The character as this career has made it.
 *
 * Levels buy precision, which is the trait the spread divides by (`src/aim.ts`)
 * — so an improved player is one whose hard kicks stay in, not one who kicks
 * harder. That was the point of making the spread the cost of pace: it leaves
 * something worth improving that does not simply make the ball faster.
 */
export function withCareer(def: CharacterDef, level: number): CharacterDef {
  const steps = Math.max(0, Math.min(MAX_LEVEL, level) - 1);
  return { ...def, precision: def.precision * (1 + 0.09 * steps) };
}

/** The level a career has this character at, or 1 if it has never been used. */
export function levelOf(career: Career, id: string): number {
  return career.champions[id]?.level ?? 1;
}

/** True once this character is available to pick. */
export function isUnlocked(career: Career, id: string): boolean {
  if (career.champions[id]) return true;
  return career.best >= (UNLOCK_AT[id] ?? Infinity);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function readChampions(v: unknown): Record<string, ChampionState> {
  if (!isRecord(v)) return {};
  const out: Record<string, ChampionState> = {};
  for (const def of CHARACTERS) {
    const entry = v[def.id];
    if (!isRecord(entry)) continue;
    out[def.id] = {
      level: Math.max(1, Math.min(MAX_LEVEL, Math.round(num(entry.level, 1)))),
      xp: Math.max(0, Math.round(num(entry.xp, 0))),
    };
  }
  return out;
}

/** Everything remembered, with a fresh career for anything absent or unreadable. */
export function readCareer(now: Date = new Date()): Career {
  const today = dayKey(now);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshCareer(today);
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)) return freshCareer(today);
    const champions = readChampions(stored.champions);
    const career: Career = {
      coins: Math.max(0, Math.round(num(stored.coins, 0))),
      trophies: Math.max(0, Math.round(num(stored.trophies, 0))),
      best: Math.max(0, Math.round(num(stored.best, 0))),
      champions: Object.keys(champions).length ? champions : freshCareer(today).champions,
      day: typeof stored.day === "string" ? stored.day : today,
      progress: isRecord(stored.progress)
        ? Object.fromEntries(
            Object.entries(stored.progress).map(([k, v]) => [k, Math.max(0, num(v, 0))])
          )
        : {},
      claimed: Array.isArray(stored.claimed)
        ? stored.claimed.filter((c): c is string => typeof c === "string")
        : [],
    };
    career.best = Math.max(career.best, career.trophies);
    return rollOver(career, today);
  } catch {
    return freshCareer(today);
  }
}

export function storeCareer(career: Career): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(career));
  } catch {
    // Private browsing, a full quota: the career runs in memory for this
    // session rather than the game refusing to be played.
  }
}

/**
 * Move a career on to today's challenges if the day has turned.
 *
 * Unclaimed rewards are lost with the day. That is the deal a daily challenge
 * makes, and quietly carrying yesterday's over would make the countdown a lie.
 */
export function rollOver(career: Career, today: string): Career {
  if (career.day === today) return career;
  return { ...career, day: today, progress: {}, claimed: [] };
}

/** What a finished match did to a career, for the screen that reports it. */
export interface MatchOutcome {
  trophies: number;
  coins: number;
  rank: "promoted" | "relegated" | null;
  /** Character ids that levelled up on this result. */
  levelled: string[];
  /** Challenge ids that reached their goal on this result. */
  completed: string[];
}

/**
 * Settle a finished match: trophies, coins, the character's experience and
 * every daily challenge it moved. Returns the new career and what changed,
 * because the screen that follows has to show the change, not the total.
 *
 * Pure — it neither reads nor writes storage. The caller decides when a result
 * counts, which is what keeps a practice session or an abandoned match from
 * quietly paying out.
 */
export function settleMatch(
  career: Career,
  championId: string,
  difficulty: Difficulty,
  tally: MatchTally,
  now: Date = new Date()
): { career: Career; outcome: MatchOutcome } {
  const rolled = rollOver(career, dayKey(now));
  const trophies = trophyDelta(tally.won, difficulty, rolled.trophies);
  const coins = coinsFor(tally.won, difficulty, rolled.trophies);
  const after = Math.max(0, rolled.trophies + trophies);

  const champions = { ...rolled.champions };
  const current = champions[championId] ?? { level: 1, xp: 0 };
  const levelled: string[] = [];
  // Playing with a character is what teaches it. Winning is already paid for
  // in trophies and coins; making experience conditional on it too would push
  // a player onto the easiest opponent rather than onto the one they enjoy.
  const xp = current.xp + 1;
  if (xp >= XP_PER_LEVEL && current.level < MAX_LEVEL) {
    champions[championId] = { level: current.level + 1, xp: 0 };
    levelled.push(championId);
  } else {
    champions[championId] = { ...current, xp };
  }

  const progress = { ...rolled.progress };
  const completed: string[] = [];
  for (const challenge of dailyChallenges(rolled.day)) {
    const before = progress[challenge.id] ?? 0;
    if (isComplete(challenge, before)) continue;
    const next = before + creditFor(challenge.kind, tally);
    progress[challenge.id] = next;
    if (isComplete(challenge, next)) completed.push(challenge.id);
  }

  return {
    career: {
      ...rolled,
      coins: rolled.coins + coins,
      trophies: after,
      best: Math.max(rolled.best, after),
      champions,
      progress,
    },
    outcome: { trophies, coins, rank: rankChange(rolled.trophies, after), levelled, completed },
  };
}

/** Collect a finished challenge's reward. A no-op if it is not finished, or already taken. */
export function claimChallenge(career: Career, id: string): Career {
  if (career.claimed.includes(id)) return career;
  const challenge = dailyChallenges(career.day).find((c) => c.id === id);
  if (!challenge) return career;
  if (!isComplete(challenge, career.progress[id] ?? 0)) return career;
  return { ...career, coins: career.coins + challenge.reward, claimed: [...career.claimed, id] };
}

/** Spend coins to take a character up a level. A no-op if it cannot be afforded. */
export function buyUpgrade(career: Career, id: string): Career {
  const level = levelOf(career, id);
  if (level >= MAX_LEVEL) return career;
  if (!isUnlocked(career, id)) return career;
  const cost = upgradeCost(level);
  if (career.coins < cost) return career;
  return {
    ...career,
    coins: career.coins - cost,
    champions: { ...career.champions, [id]: { level: level + 1, xp: career.champions[id]?.xp ?? 0 } },
  };
}
