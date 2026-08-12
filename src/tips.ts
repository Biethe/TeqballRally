import { t, type StringKey } from "./i18n";

/**
 * The line under the loading bar.
 *
 * A loading screen is the one moment a player is looking at the game with
 * nothing to do, and it is the cheapest teaching surface there is. Every tip
 * here is about a decision the game actually asks for — where to stand, when
 * to hit it softly — rather than a fact about the rules they can read
 * elsewhere.
 */
const TIP_KEYS: StringKey[] = [
  // How the controls answer.
  "tip.power",
  "tip.setup",
  "tip.deep",
  "tip.reception",
  "tip.miss",
  "tip.serve",
  // How a match is won. These are the ones worth reading twice: they are
  // about the opponent rather than about the buttons, and none of them is
  // discoverable by pressing things.
  "tip.side",
  "tip.tire",
  "tip.weakness",
  "tip.close",
  "tip.retreat",
  "tip.early",
  "tip.vary",
  "tip.strength",
];

/** A tip, chosen at random. Translated, like everything else a player reads. */
export function randomTip(rand: () => number = Math.random): string {
  return t(TIP_KEYS[Math.floor(rand() * TIP_KEYS.length)] ?? TIP_KEYS[0]);
}

/** Every tip key, so a test can hold the catalogue to having all of them. */
export const ALL_TIP_KEYS: readonly StringKey[] = TIP_KEYS;
