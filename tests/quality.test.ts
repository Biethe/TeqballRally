import { describe, expect, it } from "vitest";
import {
  QUALITY_TIERS,
  TIER_LABELS,
  type DeviceSignals,
  type QualityTier,
  detectTier,
  settingsFor,
  tierFromSearch,
} from "../src/quality";

const signals = (over: Partial<DeviceSignals> = {}): DeviceSignals => ({
  devicePixelRatio: 2,
  touch: true,
  ...over,
});

describe("settingsFor", () => {
  it("gets cheaper at every step down", () => {
    const [medium, high] = QUALITY_TIERS.map(settingsFor);

    expect(medium.maxPixelRatio).toBeLessThan(high.maxPixelRatio);
    // MSAA is the top tier's alone.
    expect(medium.antialias).toBe(false);
    expect(high.antialias).toBe(true);
  });

  // The venue is the thing a player picks; a tier that silently drops it is
  // not a graphics setting, it is a different game.
  it("keeps the venue backdrop on every tier", () => {
    for (const tier of QUALITY_TIERS) expect(settingsFor(tier).arena).toBe(true);
  });

  it("resolves a retired 'low' choice to the new floor", () => {
    expect(tierFromSearch("?q=low")).toBe("medium");
    expect(tierFromSearch("?light=1")).toBe("medium");
  });

  it("never raises the shadow map as the tier drops", () => {
    const sizes = QUALITY_TIERS.map((t) => settingsFor(t).shadowMapSize ?? 0);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  it("reports the tier it was asked for", () => {
    for (const tier of QUALITY_TIERS) {
      expect(settingsFor(tier).tier).toBe(tier);
    }
  });

  it("keeps every pixel-ratio cap in a sane range", () => {
    for (const tier of QUALITY_TIERS) {
      const s = settingsFor(tier);
      expect(s.maxPixelRatio).toBeGreaterThan(0);
      expect(s.maxPixelRatio).toBeLessThanOrEqual(3);
      if (s.shadowMapSize !== null) {
        // Powers of two, and never bigger than a phone should be asked for.
        expect(Math.log2(s.shadowMapSize) % 1).toBe(0);
        expect(s.shadowMapSize).toBeLessThanOrEqual(2048);
      }
    }
  });
});

describe("detectTier", () => {
  it("puts a 2 GB phone on the cheapest tier", () => {
    expect(detectTier(signals({ deviceMemory: 2 }))).toBe("medium");
    expect(detectTier(signals({ deviceMemory: 1 }))).toBe("medium");
    expect(detectTier(signals({ deviceMemory: 0.5 }))).toBe("medium");
  });

  it("puts a weak CPU on the cheapest tier even when memory looks fine", () => {
    expect(detectTier(signals({ deviceMemory: 8, hardwareConcurrency: 4 }))).toBe("medium");
  });

  it("puts a capable phone on medium, not high", () => {
    // Phones stay conservative: a player who drops frames in their first rally
    // never gets as far as the settings screen.
    expect(detectTier(signals({ deviceMemory: 8, hardwareConcurrency: 8 }))).toBe("medium");
    expect(detectTier(signals({ deviceMemory: 4, hardwareConcurrency: 8 }))).toBe("medium");
  });

  it("puts desktop on high", () => {
    expect(detectTier(signals({ touch: false, deviceMemory: 8, hardwareConcurrency: 8 }))).toBe("high");
  });

  it("falls back to medium on a phone that reports nothing", () => {
    // iOS Safari/WKWebView expose neither deviceMemory nor a useful core count.
    expect(detectTier({ devicePixelRatio: 3, touch: true })).toBe("medium");
  });

  it("still refuses high for an unknown touch device", () => {
    for (const dpr of [1, 2, 3, 4]) {
      expect(detectTier({ devicePixelRatio: dpr, touch: true })).not.toBe("high");
    }
  });

  it("always returns a real tier", () => {
    const cases: DeviceSignals[] = [
      { devicePixelRatio: 1, touch: false },
      { devicePixelRatio: 3, touch: true, deviceMemory: 0.25 },
      { devicePixelRatio: 2, touch: true, hardwareConcurrency: 1 },
      { devicePixelRatio: 2, touch: false, deviceMemory: 16, hardwareConcurrency: 32 },
    ];
    for (const c of cases) {
      expect(QUALITY_TIERS).toContain(detectTier(c));
    }
  });
});

describe("tierFromSearch", () => {
  it("reads an explicit ?q=", () => {
    expect(tierFromSearch("?q=medium")).toBe("medium");
    expect(tierFromSearch("?q=high")).toBe("high");
  });

  it("keeps the original ?light=1 dev flag working", () => {
    expect(tierFromSearch("?light=1")).toBe("medium");
    expect(tierFromSearch("?ts=8&light=1")).toBe("medium");
  });

  it("is null when the URL asks for nothing", () => {
    expect(tierFromSearch("")).toBeNull();
    expect(tierFromSearch("?ts=8")).toBeNull();
  });

  it("ignores a nonsense tier rather than trusting it", () => {
    expect(tierFromSearch("?q=ultra")).toBeNull();
    expect(tierFromSearch("?q=")).toBeNull();
  });

  it("lets ?q= win over ?light=1", () => {
    expect(tierFromSearch("?light=1&q=high")).toBe("high");
  });
});

describe("TIER_LABELS", () => {
  it("labels every tier", () => {
    expect(Object.keys(TIER_LABELS).sort()).toEqual([...QUALITY_TIERS].sort());
    for (const tier of QUALITY_TIERS) {
      expect(TIER_LABELS[tier].label.length).toBeGreaterThan(0);
      expect(TIER_LABELS[tier].sub.length).toBeGreaterThan(0);
    }
  });

  it("lists the tiers cheapest first", () => {
    const order: QualityTier[] = ["medium", "high"];
    expect(QUALITY_TIERS).toEqual(order);
  });
});
