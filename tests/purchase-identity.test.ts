import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Who the store thinks is paying.
 *
 * `app_user_id` on the purchase webhook is the only thread connecting a real
 * payment to a real account. The server grants from that id and nothing else,
 * so a build that leaves RevenueCat on its own anonymous id charges people and
 * gives them nothing, reporting "no such player" to a log nobody reads.
 *
 * Two orderings have to hold, and both were wrong before this file existed.
 */

/** Every SDK call made, in the order it was made. */
const calls: string[] = [];

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

/** Record the call and answer like the SDK would, without pretending to be async. */
const note = (name: string, reply: unknown = undefined) => {
  calls.push(name);
  return Promise.resolve(reply);
};

vi.mock("@revenuecat/purchases-capacitor", () => ({
  Purchases: {
    setLogLevel: () => note("setLogLevel"),
    configure: () => note("configure"),
    addCustomerInfoUpdateListener: () => note("addListener"),
    getCustomerInfo: () =>
      note("getCustomerInfo", { customerInfo: { entitlements: { active: {}, all: {} } } }),
    logIn: ({ appUserID }: { appUserID: string }) => note(`logIn:${appUserID}`),
    logOut: () => note("logOut"),
    setDisplayName: () => note("setDisplayName"),
  },
  LOG_LEVEL: { DEBUG: "DEBUG", WARN: "WARN" },
  PRODUCT_CATEGORY: { NON_SUBSCRIPTION: "NON_SUBSCRIPTION" },
}));

async function load() {
  // A real Play key, because a `test_` one makes `initPurchases` refuse to
  // configure at all — which is its own guard, pinned in purchases.test.ts.
  vi.stubEnv("VITE_REVENUECAT_KEY", "goog_pretendthisisreal");
  vi.resetModules();
  calls.length = 0;
  return import("../src/purchases");
}

afterEach(() => vi.unstubAllEnvs());

describe("binding the player to the store", () => {
  it("configures before it logs in, however early it is called", async () => {
    // The bug: `bindUserToPurchases` only checked that a store *could* exist,
    // then called `logIn` on an SDK that had never been configured. That
    // throws, the catch swallows it, and the player stays anonymous for the
    // life of the install.
    const { bindUserToPurchases } = await load();

    await bindUserToPurchases("ABCD-1234", "Bie");

    expect(calls.indexOf("configure")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("configure")).toBeLessThan(calls.indexOf("logIn:ABCD-1234"));
  });

  it("passes the player id through exactly as given", async () => {
    // The server looks the player up by this string. Any tidying here and the
    // webhook finds nobody.
    const { bindUserToPurchases } = await load();

    await bindUserToPurchases("ABCD-1234");

    expect(calls).toContain("logIn:ABCD-1234");
  });

  it("names the player when there is a name, and does not when there is not", async () => {
    const { bindUserToPurchases } = await load();

    await bindUserToPurchases("ABCD-1234");
    expect(calls).not.toContain("setDisplayName");

    await bindUserToPurchases("ABCD-1234", "Bie");
    expect(calls).toContain("setDisplayName");
  });

  it("releases the id when the account goes", async () => {
    // Otherwise a deleted account still owns the next purchase made on this
    // phone, which on a shared device is somebody else's money.
    const { unbindUserFromPurchases, initPurchases } = await load();
    await initPurchases();

    await unbindUserFromPurchases();

    expect(calls).toContain("logOut");
  });
});
