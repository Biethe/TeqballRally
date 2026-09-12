import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VENUE,
  VENUES,
  VENUE_IDS,
  isPremiumVenue,
  permittedVenue,
  resolveVenue,
  storeVenue,
} from "../src/venue";

/**
 * What a player may play on, and what they have to buy.
 *
 * These are the rules the only purchase in the game rests on, and every one of
 * them fails quietly if it is wrong: a locked default shuts a new install out
 * of the game, and a gate that forgets a lapsed subscription gives away the
 * thing being sold. None of it is visible from a passing playtest.
 */
describe("which venues are for sale", () => {
  it("sells the indoor arena and the cage", () => {
    expect(isPremiumVenue("gym")).toBe(true);
    expect(isPremiumVenue("basketball")).toBe(true);
  });

  it("gives away football and tennis courts", () => {
    // The free game has to be a game, not a demo: two venues, not none.
    const free = VENUE_IDS.filter((id) => !isPremiumVenue(id));

    expect(free).toEqual(["football", "tennis"]);
  });

  it("answers the question for every venue that exists", () => {
    // `premium` is required on the interface so a venue added later cannot
    // slip in without the question being answered. This checks the data agrees.
    for (const id of VENUE_IDS) expect(typeof VENUES[id].premium).toBe("boolean");
  });
});

describe("the venue a player is permitted", () => {
  it("keeps a free venue whether or not they pay", () => {
    expect(permittedVenue("tennis", false)).toBe("tennis");
    expect(permittedVenue("tennis", true)).toBe("tennis");
    expect(permittedVenue("football", false)).toBe("football");
  });

  it("gives a member the venue they paid for", () => {
    expect(permittedVenue("gym", true)).toBe("gym");
    expect(permittedVenue("basketball", true)).toBe("basketball");
  });

  it("permits venue if unlocked in career", () => {
    expect(permittedVenue("basketball", false, { unlockedAssets: ["basketball"] })).toBe("basketball");
  });

  it("falls back when the entitlement is gone", () => {
    // The lapsed-subscription case. A venue chosen while paying is remembered
    // in localStorage and would otherwise stay unlocked for good.
    expect(permittedVenue("gym", false)).toBe(DEFAULT_VENUE);
  });

  it("never falls back to something that is itself locked", () => {
    // The fallback is the one place a locked venue would be inescapable.
    expect(isPremiumVenue(DEFAULT_VENUE)).toBe(false);
  });
});

/**
 * The suite runs on node, which has no storage. Only the four methods
 * `venue.ts` touches are provided — a fuller fake would be testing itself.
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe("resolving the venue at boot", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeStorage();
  });

  it("opens a new install on a free court", () => {
    expect(resolveVenue("")).toBe(DEFAULT_VENUE);
    expect(isPremiumVenue(resolveVenue(""))).toBe(false);
  });

  it("remembers the last choice", () => {
    storeVenue("football");

    expect(resolveVenue("")).toBe("football");
  });

  it("lets the URL override the remembered choice", () => {
    // `?venue=` is the harness hook the build verification and the venue
    // screenshots drive, so it has to win over whatever is in storage.
    storeVenue("football");

    expect(resolveVenue("?venue=tennis")).toBe("tennis");
  });

  it("ignores a venue id that does not exist", () => {
    expect(resolveVenue("?venue=carpark")).toBe(DEFAULT_VENUE);
  });
});
