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

/**
 * Tips that name the touch gestures, meaningless to somebody at a keyboard.
 *
 * "A slow swipe lifts the ball" shown over a WASD session is the kind of tip
 * that made players say the tips make no sense — the sentence was fine, it was
 * just addressed to a different device.
 */
const TOUCH_TIPS: ReadonlySet<StringKey> = new Set(["tip.power", "tip.setup"]);

/** Tips about the charge bar, which portrait's swipe play never shows. */
const CHARGE_TIPS: ReadonlySet<StringKey> = new Set(["tip.vary"]);

/** The tips that make sense on this kind of screen. */
export function tipPool(touch: boolean, portrait: boolean): StringKey[] {
  return TIP_KEYS.filter((key) => {
    if (!touch && TOUCH_TIPS.has(key)) return false;
    if (touch && portrait && CHARGE_TIPS.has(key)) return false;
    return true;
  });
}

const defaultPool = (): StringKey[] => {
  if (typeof window === "undefined") return tipPool(false, false);
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return tipPool(touch, window.innerHeight > window.innerWidth);
};

/** A tip, chosen at random from the device-appropriate pool. Translated. */
export function randomTip(
  rand: () => number = Math.random,
  pool: StringKey[] = defaultPool()
): string {
  return t(pool[Math.floor(rand() * pool.length)] ?? pool[0]);
}

/** Every tip key, so a test can hold the catalogue to having all of them. */
export const ALL_TIP_KEYS: readonly StringKey[] = TIP_KEYS;
