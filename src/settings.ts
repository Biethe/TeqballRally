import type { CameraMode } from "./config";

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
  music: boolean;
  sound: boolean;
  /** Which view a match opens in. The HUD button still cycles from there. */
  camera: CameraMode;
  /** Whether standing near an incoming ball takes the first touch for you. */
  autoReception: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  music: true,
  sound: true,
  camera: "court",
  autoReception: true,
};

const KEY = "teqopen.prefs";

const isCameraMode = (v: unknown): v is CameraMode => v === "court" || v === "side" || v === "top";

/** Everything remembered, with defaults for anything absent or unreadable. */
export function readPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const stored = JSON.parse(raw) as Partial<Record<keyof Preferences, unknown>>;
    return {
      music: typeof stored.music === "boolean" ? stored.music : DEFAULT_PREFERENCES.music,
      sound: typeof stored.sound === "boolean" ? stored.sound : DEFAULT_PREFERENCES.sound,
      camera: isCameraMode(stored.camera) ? stored.camera : DEFAULT_PREFERENCES.camera,
      autoReception:
        typeof stored.autoReception === "boolean"
          ? stored.autoReception
          : DEFAULT_PREFERENCES.autoReception,
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
