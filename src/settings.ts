import type { CameraMode } from "./config";
import { BLANK_KIT, readKit, type Kit } from "./kit";
import { isLanguage, type Language } from "./i18n";

/**
 * Player preferences that are not the graphics tier.
 *
 * The tier lives in quality.ts because the scene is built from it before
 * anything else exists; these are ordinary choices the game reads while it
 * runs, and every one of them is remembered. Reading is deliberately total:
 * a missing or corrupt value returns the default rather than throwing, because
 * a settings file is not worth failing a boot over.
 */
export interface Preferences {
  /** Interface language. Absent until the player picks one, which is the
   * difference between "they chose English" and "we guessed from the device". */
  language: Language | null;
  music: boolean;
  sound: boolean;
  /** Which view a match opens in. The HUD button still cycles from there. */
  camera: CameraMode;
  /** Whether standing near an incoming ball takes the first touch for you. */
  autoReception: boolean;
  /** Gameplay speed multiplier (e.g. 0.85, 1.0, 1.25, 1.5). */
  gameSpeed: number;
  /**
   * Whether the coached lesson has been played through once.
   *
   * The first launch goes straight into it and cannot be skipped: this game is
   * a sport most people have never played, with controls nobody can guess, and
   * a title screen offering four modes to somebody who does not know what a
   * teqball rally looks like is a title screen they leave. Once it is done the
   * lesson is a menu item like any other, replayable whenever they want it.
   */
  coached: boolean;
  /**
   * Whether the guided tour of the app has been run through once.
   *
   * Separate from `coached`, because the two teach different things: that one
   * is the sport, this one is the parts of the app nobody finds by accident —
   * the shirt, the profile, the settings, and that the game plays differently
   * depending on which way up the phone is held.
   */
  toured: boolean;
  /**
   * Whether a stranger looking for a game may ring this player.
   *
   * On by default and meant to stay on: it is the whole reason quick match
   * finds anybody at all in a game this size. The switch exists because being
   * reachable by strangers should always be refusable, not because refusing is
   * expected.
   */
  callouts: boolean;
  /** Whether the other player's messages are shown during a match. */
  emotes: boolean;
  /** Name, number and crest painted onto the player's shirt. */
  kit: Kit;
  /**
   * Show a live readout of frame rate, simulation speed and, online, the
   * connection's timing. A diagnostic: whether a match looks wrong because of
   * the link or because one of the two devices cannot keep up is otherwise
   * impossible to tell from either screen.
   */
  netStats: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: null,
  music: true,
  sound: true,
  camera: "court",
  autoReception: true,
  gameSpeed: 1.25,
  coached: false,
  toured: false,
  callouts: true,
  emotes: true,
  kit: { ...BLANK_KIT },
  netStats: false,
};

const KEY = "teqopen.prefs";

const isCameraMode = (v: unknown): v is CameraMode => v === "court" || v === "side";

/** Everything remembered, with defaults for anything absent or unreadable. */
export function readPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const stored = JSON.parse(raw) as Partial<Record<keyof Preferences, unknown>>;
    return {
      language: isLanguage(stored.language) ? stored.language : null,
      music: typeof stored.music === "boolean" ? stored.music : DEFAULT_PREFERENCES.music,
      sound: typeof stored.sound === "boolean" ? stored.sound : DEFAULT_PREFERENCES.sound,
      camera: isCameraMode(stored.camera) ? stored.camera : DEFAULT_PREFERENCES.camera,
      autoReception:
        typeof stored.autoReception === "boolean"
          ? stored.autoReception
          : DEFAULT_PREFERENCES.autoReception,
      callouts:
        typeof stored.callouts === "boolean" ? stored.callouts : DEFAULT_PREFERENCES.callouts,
      emotes: typeof stored.emotes === "boolean" ? stored.emotes : DEFAULT_PREFERENCES.emotes,
      gameSpeed: stored.gameSpeed === 1.45 ? 1.45 : 1.25,
      coached: stored.coached === true,
      toured: stored.toured === true,
      kit: readKit(stored.kit),
      netStats: stored.netStats === true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Remember one changed preference, leaving the rest as they are. */
export function storePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing, a full quota: the game plays on with the choice held
    // in memory for this session.
  }
}
