/**
 * Render quality tiers.
 *
 * The game targets low-end phones, where the dominant costs are fill rate
 * (every pixel shaded, multiplied by the device pixel ratio), MSAA, the
 * per-frame shadow map, and the memory the gym backdrop's meshes and textures
 * occupy. Each tier turns those four knobs together.
 *
 * A tier is picked automatically on first launch and can be overridden from the
 * settings screen; the override is remembered. `?q=medium|high` forces one for
 * a session.
 *
 * There were three tiers. "Low" dropped the arena backdrop entirely, which
 * meant the venues a player picked did not appear — too high a price for the
 * framerate it bought, so the floor is now "medium". A stored or requested
 * "low" resolves to it.
 */

export type QualityTier = "medium" | "high";

export const QUALITY_TIERS: QualityTier[] = ["medium", "high"];

export interface QualitySettings {
  tier: QualityTier;
  /**
   * Ceiling on the device pixel ratio the scene renders at. A phone reporting
   * dpr 3 shading a 1080p screen is drawing ~4x the pixels of dpr 1.5, and on
   * an entry-level GPU that alone decides whether rallies hold 60fps.
   */
  maxPixelRatio: number;
  /** MSAA. Meaningful cost on tiled mobile GPUs; only the top tier pays it. */
  antialias: boolean;
  /** Shadow map resolution, or null for no shadows at all. */
  shadowMapSize: number | null;
  /**
   * Load the gym backdrop (4.8 MB, ~135 meshes). The procedural court is fully
   * playable without it — `ensureArena` already tolerates it never arriving —
   * so the lowest tier skips the download and the memory entirely.
   */
  arena: boolean;
  /**
   * Load the lighter copies of the players and balls that a build
   * carries (`scripts/lite-models.mjs`). The full players alone were a quarter
   * of a million triangles, drawn twice for the shadow map.
   */
  liteModels: boolean;
}

const SETTINGS: Record<QualityTier, Omit<QualitySettings, "tier">> = {
  // Entry-level phones: native resolution, no MSAA, but the venue still
  // arrives. Shadows stay on because the ball's shadow is a depth cue the game
  // is played on, and the only casters are the table, the ball and the two
  // characters — never the arena.
  medium: { maxPixelRatio: 1.0, antialias: false, shadowMapSize: 1024, arena: true, liteModels: true },
  high: { maxPixelRatio: 2.0, antialias: true, shadowMapSize: 1024, arena: true, liteModels: false },
};

export function settingsFor(tier: QualityTier): QualitySettings {
  return { tier, ...SETTINGS[tier] };
}

/** The device facts the auto-detection looks at. */
export interface DeviceSignals {
  /** navigator.deviceMemory in GB. Chrome/Android only — undefined elsewhere. */
  deviceMemory?: number;
  /** navigator.hardwareConcurrency (logical cores). */
  hardwareConcurrency?: number;
  devicePixelRatio: number;
  touch: boolean;
}

export function readSignals(): DeviceSignals {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio || 1,
    touch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
  };
}

/**
 * Pick a starting tier. The bias is deliberately pessimistic on phones: a
 * player who drops frames in their first rally never reaches the settings
 * screen, whereas one running smoothly may go looking for a prettier picture.
 * Neither signal is reliable on iOS (both are undefined in Safari/WKWebView),
 * so touch alone caps the guess at "medium".
 */
export function detectTier(s: DeviceSignals): QualityTier {
  // deviceMemory is the strongest signal where it exists, and it is reported
  // in coarse buckets (0.25/0.5/1/2/4/8).
  if (s.deviceMemory !== undefined && s.deviceMemory <= 2) return "medium";
  if (s.hardwareConcurrency !== undefined && s.hardwareConcurrency <= 4) return "medium";
  if (!s.touch) return "high";
  return "medium";
}

const STORAGE_KEY = "teqopen.quality";

function isTier(v: unknown): v is QualityTier {
  return typeof v === "string" && (QUALITY_TIERS as string[]).includes(v);
}

/** A `?q=` / `?light=1` override, or null when the URL asks for nothing. */
export function tierFromSearch(search: string): QualityTier | null {
  const params = new URLSearchParams(search);
  const q = params.get("q");
  if (isTier(q)) return q;
  // "low" is gone; the scripts and links that still ask for it, and the older
  // `?light=1` dev flag, get the new floor rather than nothing.
  if (q === "low" || params.has("light")) return "medium";
  return null;
}

export function storedTier(): QualityTier | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isTier(v)) return v;
    // Anyone who chose "low" before it was removed keeps a working setting.
    return v === "low" ? "medium" : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function storeTier(tier: QualityTier): void {
  try {
    localStorage.setItem(STORAGE_KEY, tier);
  } catch {
    // Not being able to remember the choice is not worth failing a match over.
  }
}

/**
 * Resolve the tier to boot with: an explicit URL override wins, then the
 * player's remembered choice, then auto-detection.
 */
export function resolveTier(search: string, signals: DeviceSignals): QualityTier {
  return tierFromSearch(search) ?? storedTier() ?? detectTier(signals);
}

export const TIER_LABELS: Record<QualityTier, { label: string; sub: string }> = {
  medium: { label: "MEDIUM", sub: "Best framerate. Native resolution, no anti-aliasing." },
  high: { label: "HIGH", sub: "Full detail and anti-aliasing. For newer phones." },
};
