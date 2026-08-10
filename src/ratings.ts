import { CHARACTERS, type CharacterDef } from "./config";
import { MAX_LEVEL, withCareer } from "./progress";

/**
 * Character traits as numbers a player can compare.
 *
 * The balance values in `config.ts` are physics — metres per second, a
 * multiplier on a spread radius — and mean nothing to anyone reading a card.
 * These are the same values on a familiar 0–100 scale, so two characters can
 * be held up against each other and a level can be seen to have done
 * something.
 *
 * The scale runs from the weakest any character starts at to the strongest any
 * character can ever be trained to, which is why a fresh roster does not have
 * anybody sitting at 100: the top of the bar is a place to get to.
 */

export type RatingKey = "reactivity" | "power" | "control";

export const RATING_KEYS: RatingKey[] = ["reactivity", "power", "control"];

const READ: Record<RatingKey, (def: CharacterDef) => number> = {
  reactivity: (d) => d.speed,
  power: (d) => d.power,
  control: (d) => d.precision,
};

/** The weakest start and the strongest finish, per trait, across the roster. */
const SPAN: Record<RatingKey, { min: number; max: number }> = Object.fromEntries(
  RATING_KEYS.map((key) => {
    const read = READ[key];
    const starts = CHARACTERS.map(read);
    const ceilings = CHARACTERS.map((c) => read(withCareer(c, MAX_LEVEL)));
    return [key, { min: Math.min(...starts), max: Math.max(...ceilings) }];
  })
) as Record<RatingKey, { min: number; max: number }>;

/**
 * One trait, 40–100.
 *
 * The floor is 40 rather than 0 because none of these characters is bad at
 * anything — they are differently good, and a bar reading zero says the
 * opposite of what the roster means.
 */
export function rating(def: CharacterDef, key: RatingKey): number {
  const { min, max } = SPAN[key];
  const value = READ[key](def);
  if (max === min) return 100;
  return Math.round(40 + Math.min(1, Math.max(0, (value - min) / (max - min))) * 60);
}

/** The three traits added up: one number to compare two players by. */
export function totalPower(def: CharacterDef): number {
  return RATING_KEYS.reduce((sum, key) => sum + rating(def, key), 0);
}
