/**
 * Purchases, and the one place that knows what being a paying player means.
 *
 * RevenueCat's Capacitor plugin wraps the native Android SDK
 * (`com.revenuecat.purchases:purchases`, pulled in through
 * `purchases-hybrid-common` by the plugin's own build.gradle). Going through it
 * rather than writing Kotlin directly is what lets the *game* ask the question:
 * every gate worth putting behind a purchase — an arena, a piece of gear, a
 * coin multiplier — lives in TypeScript, and an entitlement the WebView cannot
 * read is an entitlement nothing can act on.
 *
 * Two rules this module exists to enforce:
 *
 * 1. The browser is not a store. Every harness in scripts/, the dev server and
 *    the hosted build all run without a native layer, and none of them may fail
 *    because a purchase API is missing. Off-device the module answers "not pro,
 *    and nothing to sell", which is exactly true.
 * 2. Nothing else imports the SDK. One module owns configuration, the customer
 *    info listener and the entitlement check, so there is one answer to "is
 *    this player pro" rather than one per call site.
 */
import { Capacitor } from "@capacitor/core";
import {
  LOG_LEVEL,
  Purchases,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor";
import { PAYWALL_RESULT, RevenueCatUI } from "@revenuecat/purchases-capacitor-ui";

/**
 * The entitlement the arena hangs off.
 *
 * **There are no subscriptions.** Real money buys exactly two things in this
 * game: the arena, once and for all, and coins. Everything else — characters,
 * balls, supplies, levels — is bought with coins and trophies, which are
 * earned by playing. A game that rents out its content has to keep being paid
 * to stay the same game, and that is not the deal this one makes.
 *
 * The identifier is still the string RevenueCat's dashboard was configured
 * with, deliberately: renaming it would strip the arena from everybody who has
 * already bought it. What changed is the offer behind it — a single
 * non-consumable — not the key the app checks.
 */
export const ARENA_ENTITLEMENT = "Teqie Pro";

/** The one-time product behind that entitlement, as configured in RevenueCat. */
export const ARENA_PRODUCT = "lifetime";

/**
 * The public SDK key.
 *
 * Public keys are meant to ship inside the app, so this is not a secret being
 * committed — but it is overridable because the key is per-store and per-project.
 *
 * The default is a **Test Store** key: right for developing against fake
 * purchases, wrong for a Play release, which needs the `goog_…` Android key from
 * the RevenueCat dashboard. Set VITE_REVENUECAT_KEY before a release build.
 */
const API_KEY = import.meta.env.VITE_REVENUECAT_KEY ?? "test_rZiGyRrwNBacPnBmcSMZaaOkcyh";

export interface ArenaStatus {
  /**
   * Whether RevenueCat has answered yet.
   *
   * Distinct from `owned` being false: before the first answer the honest
   * state is "unknown", and an offer shown to somebody who already paid
   * because their status had not loaded is the worst version of this feature.
   */
  ready: boolean;
  /** Whether this player owns the arena. */
  owned: boolean;
  /** Which product carried it, when RevenueCat says. */
  productId: string | null;
}

const UNKNOWN: ArenaStatus = { ready: false, owned: false, productId: null };

/**
 * Read the entitlement out of a customer info payload.
 *
 * Pure and exported so the mapping can be tested without a store behind it —
 * `entitlements.active` is keyed by entitlement identifier, and getting that
 * lookup wrong fails in the one direction nobody notices: silently, for paying
 * players only.
 *
 * An expiry date is deliberately not read. Nothing sold here expires; if a
 * legacy subscription from before the change is still carrying somebody's
 * entitlement, RevenueCat drops it out of `active` when it lapses and this
 * answers false the same way it would for anybody else.
 */
export function readArenaStatus(info: CustomerInfo | null | undefined): ArenaStatus {
  const entitlement = info?.entitlements?.active?.[ARENA_ENTITLEMENT];
  if (!entitlement) return { ...UNKNOWN, ready: info != null };
  return { ready: true, owned: true, productId: entitlement.productIdentifier ?? null };
}

let status: ArenaStatus = { ...UNKNOWN };
const listeners = new Set<(s: ArenaStatus) => void>();

function publish(next: ArenaStatus): void {
  status = next;
  for (const listener of listeners) listener(status);
}

/** The last known entitlement state. Synchronous, for gating a screen as it draws. */
export function arenaStatus(): ArenaStatus {
  return status;
}

/** Shorthand for the common question. */
export function ownsArena(): boolean {
  return status.owned;
}

/**
 * Watch the entitlement.
 *
 * Fires immediately with the current value, so a caller never has to handle
 * "already owned before the first update" as a separate case. Returns an
 * unsubscribe, matching MatchController.subscribe.
 */
export function subscribeToArena(listener: (s: ArenaStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

/** Whether a store exists at all. False in a browser, and on every harness. */
export function purchasesAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

let configured: Promise<boolean> | null = null;

/**
 * Configure the SDK once, and keep the entitlement current afterwards.
 *
 * Safe to call more than once and safe to call off-device. Never throws: a
 * store that cannot be reached must degrade to "no purchases", not take the
 * game down with it — someone on a plane still gets to play.
 */
export function initPurchases(): Promise<boolean> {
  if (configured) return configured;
  configured = (async () => {
    if (!purchasesAvailable()) {
      // Off-device the answer is known and final, so report ready rather than
      // leaving every gate waiting for something that will never arrive.
      publish({ ...UNKNOWN, ready: true });
      return false;
    }
    try {
      await Purchases.setLogLevel({ level: import.meta.env.DEV ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN });
      await Purchases.configure({ apiKey: API_KEY });
      // The listener is what keeps a refund, or a purchase made on another
      // device, honest without the game polling for it.
      await Purchases.addCustomerInfoUpdateListener((info) => publish(readArenaStatus(info)));
      await refreshArena();
      return true;
    } catch (error) {
      console.warn("[purchases] unavailable:", describe(error));
      publish({ ...UNKNOWN, ready: true });
      return false;
    }
  })();
  return configured;
}

/** Ask the store where things stand. Cheap: RevenueCat caches and dedupes. */
export async function refreshArena(): Promise<ArenaStatus> {
  if (!purchasesAvailable()) return status;
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    publish(readArenaStatus(customerInfo));
  } catch (error) {
    console.warn("[purchases] could not read customer info:", describe(error));
  }
  return status;
}

export type PurchaseOutcome =
  | { ok: true; owned: boolean }
  /** The player closed the sheet. Not a failure, and must not be shown as one. */
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

/**
 * Buy a package.
 *
 * Cancellation is separated from failure because they need opposite treatment:
 * an error message after someone deliberately backed out of a purchase reads as
 * the app arguing with them.
 */
async function purchasePackage(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  if (!purchasesAvailable()) {
    return { ok: false, cancelled: false, message: "Purchases are only available in the app." };
  }
  try {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
    publish(readArenaStatus(customerInfo));
    return { ok: true, owned: status.owned };
  } catch (error) {
    if (wasCancelled(error)) return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, message: describe(error) };
  }
}

/**
 * Restore purchases.
 *
 * Not optional politeness: a player who reinstalls, or signs in on a second
 * device, has no other way back to what they paid for, and both stores require
 * the path to exist.
 */
export async function restorePurchases(): Promise<PurchaseOutcome> {
  if (!purchasesAvailable()) {
    return { ok: false, cancelled: false, message: "Purchases are only available in the app." };
  }
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    publish(readArenaStatus(customerInfo));
    return { ok: true, owned: status.owned };
  } catch (error) {
    return { ok: false, cancelled: false, message: describe(error) };
  }
}

/**
 * Offer the arena to somebody who does not own it.
 *
 * A single call that does nothing for a player who already bought it, so no
 * caller needs an `ownsArena()` check of its own to avoid selling the same
 * thing twice. The screen itself is RevenueCat's, configured in the dashboard,
 * so the price and the copy can change without shipping a build.
 */
export async function offerArena(): Promise<boolean> {
  if (!purchasesAvailable()) return false;
  try {
    const { result } = await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: ARENA_ENTITLEMENT,
    });
    await refreshArena();
    return result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
  } catch (error) {
    console.warn("[purchases] paywall failed to present:", describe(error));
    return false;
  }
}

/**
 * Whether an error means "the player changed their mind".
 *
 * The hybrid SDKs report this as a flag on the error and as error code 1; both
 * are checked because the shape has moved between versions and a cancellation
 * misread as a failure is a visible bug.
 */
function wasCancelled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { userCancelled?: boolean; code?: string | number; message?: string };
  if (e.userCancelled === true) return true;
  if (String(e.code) === "1") return true;
  return /cancell?ed/i.test(e.message ?? "");
}

/** A message worth showing a player, from whatever the SDK threw. */
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { message?: string; underlyingErrorMessage?: string };
    return e.underlyingErrorMessage || e.message || "Something went wrong with the store.";
  }
  return String(error);
}

/**
 * Coin packs.
 *
 * Deliberately coins rather than the items themselves. Everything on the
 * supplies shelf is earnable by playing, and selling the *advantage* directly
 * would mean the shop had two prices for the same thing and one of them was
 * money. Selling the currency keeps one shelf, one set of prices, and leaves
 * paying as a shortcut through the grind rather than a different game.
 *
 * These are consumables: RevenueCat does not keep a balance for them, so the
 * credit is applied here and stored with the career. The product identifiers
 * have to exist in Play and be attached to an offering named `coins`.
 */
export const COIN_PACKS: Record<string, number> = {
  coins_handful: 1200,
  coins_pocket: 3500,
  coins_bag: 9000,
};

/** How many coins a bought package is worth, or 0 if it is not a coin pack. */
export function coinsForProduct(productId: string): number {
  return COIN_PACKS[productId] ?? 0;
}

/**
 * The coin packs on sale, cheapest first.
 *
 * Empty off-device and empty when the dashboard has no `coins` offering, which
 * the caller shows as "not available" rather than an error: a shop with
 * nothing in it is a fact about the account, not a fault.
 */
export async function coinPackages(): Promise<PurchasesPackage[]> {
  if (!purchasesAvailable()) return [];
  try {
    const offerings = (await Purchases.getOfferings()) as {
      all?: Record<string, PurchasesOffering | undefined>;
    };
    const coins = offerings.all?.coins;
    return [...(coins?.availablePackages ?? [])].sort(
      (a, b) => (a.product.price ?? 0) - (b.product.price ?? 0)
    );
  } catch (error) {
    console.warn("[purchases] no coin offering:", describe(error));
    return [];
  }
}

/**
 * Buy a coin pack, and say how many coins it is worth.
 *
 * The count comes from `COIN_PACKS` rather than from anything the store says,
 * so a product that is mispriced or renamed in the dashboard credits nothing
 * instead of guessing — being wrong in the player's favour is still being
 * wrong, and being wrong the other way takes their money.
 */
export async function purchaseCoins(
  pkg: PurchasesPackage
): Promise<PurchaseOutcome & { coins?: number }> {
  const outcome = await purchasePackage(pkg);
  if (!outcome.ok) return outcome;
  return { ...outcome, coins: coinsForProduct(pkg.product.identifier) };
}
