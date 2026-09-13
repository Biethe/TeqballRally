import { CHARACTERS, type CharacterDef } from "./config";
import type { AIDifficulty } from "./ai";
import type { PersonalKit } from "./kit";

/**
 * The players a quick match finds when nobody else is looking for one.
 *
 * A new game's online mode is empty almost all of the time, and an empty
 * online mode is not a quiet online mode — it is a dead end. A player taps
 * QUICK MATCH, waits, and learns that this part of the game does not work.
 * They only need to learn that once.
 *
 * So the queue has a floor. If nobody real is waiting, one of these plays
 * instead: a name, a shirt with something written on it, a character from the
 * roster, and a way of playing that is theirs. None of that is decoration.
 * What makes an opponent read as a person is that they are *consistent* —
 * that the one who hit everything flat last week hits everything flat again —
 * and consistency is the thing a difficulty slider alone cannot give.
 *
 * Two rules about where this is allowed to reach.
 *
 * **Only when there is a connection.** A player with no signal knows they are
 * offline, so an opponent found there would be transparently invented. Online
 * play is refused outright without a network rather than quietly substituted.
 *
 * **Never in place of somebody real.** The queue is searched first and these
 * are the fallback, so a rival never takes a match a person was waiting for.
 */

export interface Rival {
  /** Stable id, so the same rival is the same rival every time. */
  id: string;
  name: string;
  /** Which of the roster they play as. */
  character: string;
  /** What is written on their shirt. */
  kit: PersonalKit;
  /** Trophies, for the card shown before the match. */
  trophies: number;
  /** How they play. Layered over the character's own abilities. */
  style: AIDifficulty;
}

/**
 * The four ways of playing, before a name is put to one.
 *
 * Built out of the same knobs the CPU difficulties use, because those already
 * describe everything that distinguishes one opponent from another: how fast
 * they cover the court, how well they read a ball, how accurate they are, and
 * how much they build a point rather than returning it. What is new here is
 * the *combinations* — a difficulty ladder moves every knob together, and a
 * person does not. Somebody quick who cannot aim is a different opponent from
 * somebody slow who never misses, even when the two win as often as each other.
 */
export const STYLES: Record<string, AIDifficulty> = {
  /** Gets to everything, does little with it. Beats you by not missing. */
  retriever: {
    speed: 0.92,
    aimError: 0.5,
    reactionTime: 0.16,
    misjudge: 0.3,
    popChance: 0.35,
    maxPopTouches: 1,
    tactics: 0.35,
  },
  /** Builds every point and finishes hard. Slower to the ball for it. */
  builder: {
    speed: 0.68,
    aimError: 0.28,
    reactionTime: 0.26,
    misjudge: 0.45,
    popChance: 0.95,
    maxPopTouches: 2,
    tactics: 0.85,
  },
  /** Hits first and asks later. Fast, flat, and wrong often enough to beat. */
  hitter: {
    speed: 0.8,
    aimError: 0.55,
    reactionTime: 0.18,
    misjudge: 0.5,
    popChance: 0.12,
    maxPopTouches: 1,
    tactics: 0.3,
  },
  /** Reads the court and puts it where you are not. The hard one. */
  technician: {
    speed: 0.85,
    aimError: 0.2,
    reactionTime: 0.13,
    misjudge: 0.22,
    popChance: 0.75,
    maxPopTouches: 2,
    tactics: 0.95,
  },
};

export type StyleId = keyof typeof STYLES;

/**
 * Scale a style by how good this rival is supposed to be.
 *
 * One number from 0 (a beginner) to 1 (the best in the game), applied so that
 * a weak technician is still recognisably a technician: the shape of how they
 * play is the style, and the level only decides how well they execute it.
 * Moving both together is what makes every low-level opponent feel like the
 * same opponent.
 */
export function atLevel(style: AIDifficulty, level: number): AIDifficulty {
  const t = Math.min(1, Math.max(0, level));
  // Errors shrink toward the style's own figure; a beginner makes about three
  // times as many. Speed and reading climb toward it from well below.
  const worse = 1 + (1 - t) * 2;
  return {
    ...style,
    speed: style.speed * (0.62 + 0.38 * t),
    aimError: style.aimError * worse,
    reactionTime: style.reactionTime * worse,
    misjudge: style.misjudge * worse,
    // A beginner does not build points, whatever their style says.
    popChance: style.popChance * (0.4 + 0.6 * t),
    maxPopTouches: t < 0.45 ? 1 : style.maxPopTouches,
    tactics: style.tactics * (0.3 + 0.7 * t),
  };
}

/** The roster ids, so a rival cannot name a character that is not in the game. */
const ROSTER = CHARACTERS.map((c) => c.id);

/**
 * The rivals themselves.
 *
 * Deliberately a written list rather than a generator. Generated opponents are
 * all subtly the same, and the whole point is that these are told apart — so
 * each one is a name somebody chose, a shirt somebody would wear, and a way of
 * playing that goes with both.
 *
 * Trophy counts are spread across the tiers so that whoever a player meets is
 * plausible next to their own, and the levels rise with them.
 */
const ROSTER_RIVALS: Omit<Rival, "style">[] = [
  { id: "rv-mika", name: "Mika", character: ROSTER[0], kit: { name: "MIKA", number: "7", crest: "disc" }, trophies: 40 },
  { id: "rv-tobi", name: "Tobi", character: ROSTER[1 % ROSTER.length], kit: { name: "TOBI", number: "9", crest: "none" }, trophies: 120 },
  { id: "rv-sari", name: "Sari", character: ROSTER[2 % ROSTER.length], kit: { name: "SARI", number: "4", crest: "star" }, trophies: 260 },
  { id: "rv-noor", name: "Noor", character: ROSTER[3 % ROSTER.length], kit: { name: "NOOR", number: "11", crest: "shield" }, trophies: 430 },
  { id: "rv-luca", name: "Luca", character: ROSTER[0], kit: { name: "LUCA", number: "3", crest: "none" }, trophies: 640 },
  { id: "rv-rey", name: "Rey", character: ROSTER[1 % ROSTER.length], kit: { name: "REY", number: "1", crest: "disc" }, trophies: 880 },
  { id: "rv-anka", name: "Anka", character: ROSTER[2 % ROSTER.length], kit: { name: "ANKA", number: "8", crest: "star" }, trophies: 1150 },
  { id: "rv-dee", name: "Dee", character: ROSTER[3 % ROSTER.length], kit: { name: "DEE", number: "5", crest: "shield" }, trophies: 1500 },
];

/** Which style each rival plays, cycling so no tier is all one kind. */
const STYLE_ORDER: StyleId[] = ["retriever", "hitter", "builder", "technician"];

/** Every rival, with their style and level worked out from where they sit. */
export const RIVALS: Rival[] = ROSTER_RIVALS.map((r, i) => {
  const style = STYLES[STYLE_ORDER[i % STYLE_ORDER.length]];
  // Level rises across the list, so the rival nearest a player's trophy count
  // is also about the right difficulty for them.
  const level = ROSTER_RIVALS.length > 1 ? i / (ROSTER_RIVALS.length - 1) : 1;
  return { ...r, style: atLevel(style, level) };
});

/**
 * Who a player of this standing would plausibly be matched with.
 *
 * Nearest by trophies, with a little spread so the same person is not met
 * twice running. Nearest rather than random because a queue that paired a
 * beginner with the best player in the game would give itself away in one
 * rally — real matchmaking puts like against like, and this has to look like
 * real matchmaking.
 */
export function rivalFor(trophies: number, rand: () => number = Math.random): Rival {
  const sorted = [...RIVALS].sort(
    (a, b) => Math.abs(a.trophies - trophies) - Math.abs(b.trophies - trophies)
  );
  // One of the three closest, so it is plausible without being predictable.
  const pool = sorted.slice(0, Math.min(3, sorted.length));
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/** The roster entry a rival plays as, falling back to the first character. */
export function characterFor(rival: Rival): CharacterDef {
  return CHARACTERS.find((c) => c.id === rival.character) ?? CHARACTERS[0];
}
