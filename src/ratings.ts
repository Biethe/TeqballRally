import { type CharacterDef } from "./config";

/**
 * Character traits as numbers a player can compare.
 *
 * The balance values in `config.ts` are physics — metres per second, a
 * multiplier on a spread radius — and mean nothing to anyone reading a card.
 * These are the same values on a familiar 0–100 scale, so two characters can
 * be held up against each other and a level can be seen to have done
 * something.
 *
 * The span each trait is measured against is **fixed** rather than read off
 * the roster. Deriving it meant every number on every card moved whenever a
 * character was added or retuned — a player who had trained BRAZIL to 71
 * CONTROL would open the game after an update to find it said 64, having lost
 * nothing. Fixed bounds also leave room above the best character in the game,
 * which is what makes the ladder legible: SPAIN is near the top of the bar
 * because SPAIN is near the top of the roster, not because SPAIN defines it.
 */

export type RatingKey =
  | "reactivity"
  | "power"
  | "control"
  | "stamina"
  | "serve"
  | "agility"
  | "volley";

export const RATING_KEYS: RatingKey[] = [
  "reactivity",
  "power",
  "control",
  "agility",
  "volley",
  "serve",
  "stamina",
];

const READ: Record<RatingKey, (def: CharacterDef) => number> = {
  reactivity: (d) => d.speed,
  power: (d) => d.power,
  control: (d) => d.precision,
  stamina: (d) => d.stamina,
  serve: (d) => d.serve,
  agility: (d) => d.agility,
  volley: (d) => d.volley,
};

/**
 * What each trait's bar runs between, in the units `config.ts` uses.
 *
 * Chosen to sit outside the roster on both ends: below the starter so a
 * beginner does not read as a flat wall of minimums, and above what any
 * character starts at, so the top of the bar is somewhere to get to.
 *
 * Exported because it is also where training stops (`withCareer` in
 * `src/progress.ts`). A trait that kept growing after its bar had filled would
 * be power the card had stopped reporting.
 */
export const SPAN: Record<RatingKey, { min: number; max: number }> = {
  reactivity: { min: 3.8, max: 6.6 },
  power: { min: 0.7, max: 1.8 },
  control: { min: 0.7, max: 1.9 },
  stamina: { min: 0.65, max: 1.8 },
  serve: { min: 0.7, max: 1.6 },
  agility: { min: 0.65, max: 1.8 },
  volley: { min: 0.7, max: 1.85 },
};

/** Nobody is bad at everything, so no bar reads zero. */
export const RATING_FLOOR = 40;
/**
 * And nobody is quite perfect.
 *
 * The bar is marked out of 100 and stops at 99. It used to stop at 95 on the
 * reasoning that a reachable top stops saying anything the moment somebody
 * gets there — but the top was not merely hard to reach, it was unreachable:
 * across four characters and seven abilities exactly one combination ever
 * touched it, because levelling did not move `power` or `serve` at all and the
 * rest gained too little to cross their spans. A ceiling nobody can approach
 * is not tension, it is a bar that stops moving while the player keeps
 * playing.
 *
 * So 99 is now genuinely reachable, in every ability, on any character — it
 * just costs a long career (`MAX_LEVEL` in `src/progress.ts`), and costs the
 * weaker characters more of one. The last point stays unsold, because a 100
 * would invite the question of what comes after it.
 */
export const RATING_CAP = 99;

/** One trait, `RATING_FLOOR`–`RATING_CAP`, on a bar marked out of 100. */
export function rating(def: CharacterDef, key: RatingKey): number {
  const { min, max } = SPAN[key];
  const value = READ[key](def);
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return Math.round(RATING_FLOOR + t * (RATING_CAP - RATING_FLOOR));
}

/** The three traits added up: one number to compare two players by. */
export function totalPower(def: CharacterDef): number {
  return RATING_KEYS.reduce((sum, key) => sum + rating(def, key), 0);
}
