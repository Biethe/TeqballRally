/**
 * Render quality tiers.
 *
 * The game targets low-end phones, where the dominant costs are fill rate
 * (every pixel shaded, multiplied by the device pixel ratio), MSAA, the
 * per-frame shadow map, and the memory the gym backdrop's meshes and textures
 * occupy. Each tier turns those four knobs together.
 *
 * A tier is picked automatically on first launch and can be overridden from the
 * settings screen; the override is remembered. `?q=low|medium|high` forces one
 * for a session, and the older `?light=1` dev flag still maps to "low".
 */

export type QualityTier = "low" | "medium" | "high";

export const QUALITY_TIERS: QualityTier[] = ["low", "medium", "high"];

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
}

const SETTINGS: Record<QualityTier, Omit<QualitySettings, "tier">> = {
  // Entry-level phones: native resolution, no MSAA, no gym. Shadows stay on
  // because the ball's shadow is a depth cue the game is played on, and the
  // only casters are the table, the ball and two characters — never the arena.
  low: { maxPixelRatio: 1.0, antialias: false, shadowMapSize: 512, arena: false },
  medium: { maxPixelRatio: 1.5, antialias: false, shadowMapSize: 1024, arena: true },
  high: { maxPixelRatio: 2.0, antialias: true, shadowMapSize: 1024, arena: true },
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
  if (s.deviceMemory !== undefined && s.deviceMemory <= 2) return "low";
  if (s.hardwareConcurrency !== undefined && s.hardwareConcurrency <= 4) return "low";
  if (!s.touch) return "high";
  if (s.deviceMemory !== undefined && s.deviceMemory <= 4) return "medium";
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
  if (params.has("light")) return "low"; // the original dev flag
  return null;
}

export function storedTier(): QualityTier | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTier(v) ? v : null;
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
  low: { label: "LOW", sub: "Best framerate. No gym backdrop, native resolution." },
  medium: { label: "MEDIUM", sub: "Balanced. The gym, sharper picture, no anti-aliasing." },
  high: { label: "HIGH", sub: "Full detail and anti-aliasing. For newer phones." },
};
