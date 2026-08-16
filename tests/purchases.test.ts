import { describe, expect, it } from "vitest";
import type { CustomerInfo } from "@revenuecat/purchases-capacitor";
import { ARENA_ENTITLEMENT, ARENA_PRODUCT, readArenaStatus } from "../src/purchases";

/**
 * A customer info payload with whatever entitlements are named active.
 *
 * Only the shape `readArenaStatus` reads is filled in: the real payload
 * carries dozens of fields, and a fixture that mirrored all of them would be
 * testing the SDK's type rather than our lookup.
 */
function customer(
  active: Record<
    string,
    Partial<{ productIdentifier: string; willRenew: boolean; expirationDate: string | null }>
  >
): CustomerInfo {
  return { entitlements: { active, all: active } } as unknown as CustomerInfo;
}

describe("reading the arena entitlement", () => {
  it("is not ready before the store has answered", () => {
    // "Unknown" and "does not own it" have to stay distinct: offering the
    // arena to somebody who already bought it, because their status had not
    // loaded yet, is the worst version of this feature.
    const status = readArenaStatus(null);

    expect(status.ready).toBe(false);
    expect(status.owned).toBe(false);
  });

  it("is ready and unowned once the store answers with nothing", () => {
    const status = readArenaStatus(customer({}));

    expect(status.ready).toBe(true);
    expect(status.owned).toBe(false);
    expect(status.productId).toBeNull();
  });

  it("reads the one-time purchase as owned", () => {
    const status = readArenaStatus(
      customer({ [ARENA_ENTITLEMENT]: { productIdentifier: ARENA_PRODUCT, expirationDate: null } })
    );

    expect(status.owned).toBe(true);
    expect(status.productId).toBe(ARENA_PRODUCT);
  });

  it("still honours a legacy subscription while the store calls it active", () => {
    // Nothing sold today renews, but somebody who subscribed before the change
    // must not lose the arena mid-term. RevenueCat drops a lapsed entitlement
    // out of `active` by itself, which is the whole expiry handling needed.
    const status = readArenaStatus(
      customer({
        [ARENA_ENTITLEMENT]: {
          productIdentifier: "monthly",
          willRenew: false,
          expirationDate: "2026-09-13T00:00:00Z",
        },
      })
    );

    expect(status.owned).toBe(true);
    expect(status.productId).toBe("monthly");
  });

  it("ignores an entitlement that is not the arena's", () => {
    // Entitlements are keyed by identifier, and getting that lookup wrong fails
    // silently and only for paying customers.
    const status = readArenaStatus(customer({ "Some Other Tier": { productIdentifier: "yearly" } }));

    expect(status.owned).toBe(false);
    expect(status.ready).toBe(true);
  });

  it("survives a payload with no entitlements block at all", () => {
    const status = readArenaStatus({} as CustomerInfo);

    expect(status.owned).toBe(false);
    expect(status.ready).toBe(true);
  });
});
