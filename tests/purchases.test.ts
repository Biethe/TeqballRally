import { describe, expect, it } from "vitest";
import type { CustomerInfo } from "@revenuecat/purchases-capacitor";
import { PRO_ENTITLEMENT, PRO_PRODUCTS, readProStatus } from "../src/purchases";

/**
 * A customer info payload with whatever entitlements are named active.
 *
 * Only the shape `readProStatus` reads is filled in: the real payload carries
 * dozens of fields, and a fixture that mirrored all of them would be testing
 * the SDK's type rather than our lookup.
 */
function customer(active: Record<string, Partial<{ productIdentifier: string; willRenew: boolean; expirationDate: string | null }>>): CustomerInfo {
  return { entitlements: { active, all: active } } as unknown as CustomerInfo;
}

describe("reading the Teqie Pro entitlement", () => {
  it("is not ready before the store has answered", () => {
    // "Unknown" and "not a subscriber" have to stay distinct: showing a paywall
    // to somebody who already paid, because their status had not loaded yet, is
    // the worst version of this feature.
    const status = readProStatus(null);

    expect(status.ready).toBe(false);
    expect(status.pro).toBe(false);
  });

  it("is ready and unpaid once the store answers with nothing", () => {
    const status = readProStatus(customer({}));

    expect(status.ready).toBe(true);
    expect(status.pro).toBe(false);
    expect(status.productId).toBeNull();
  });

  it("reads a monthly subscriber", () => {
    const status = readProStatus(
      customer({
        [PRO_ENTITLEMENT]: {
          productIdentifier: PRO_PRODUCTS.monthly,
          willRenew: true,
          expirationDate: "2026-09-13T00:00:00Z",
        },
      })
    );

    expect(status.pro).toBe(true);
    expect(status.productId).toBe("monthly");
    expect(status.willRenew).toBe(true);
    expect(status.expires).toBe("2026-09-13T00:00:00Z");
  });

  it("reads a lifetime purchase as pro that never expires", () => {
    const status = readProStatus(
      customer({
        [PRO_ENTITLEMENT]: { productIdentifier: PRO_PRODUCTS.lifetime, expirationDate: null },
      })
    );

    expect(status.pro).toBe(true);
    expect(status.productId).toBe("lifetime");
    expect(status.expires).toBeNull();
  });

  it("flags a subscription that is not going to renew", () => {
    // The one state worth acting on: still pro, but leaving.
    const status = readProStatus(
      customer({
        [PRO_ENTITLEMENT]: { productIdentifier: PRO_PRODUCTS.yearly, willRenew: false },
      })
    );

    expect(status.pro).toBe(true);
    expect(status.willRenew).toBe(false);
  });

  it("ignores an entitlement that is not Teqie Pro", () => {
    // Entitlements are keyed by identifier, and getting that lookup wrong fails
    // silently and only for paying customers.
    const status = readProStatus(customer({ "Some Other Tier": { productIdentifier: "yearly" } }));

    expect(status.pro).toBe(false);
    expect(status.ready).toBe(true);
  });

  it("survives a payload with no entitlements block at all", () => {
    const status = readProStatus({} as CustomerInfo);

    expect(status.pro).toBe(false);
    expect(status.ready).toBe(true);
  });
});
