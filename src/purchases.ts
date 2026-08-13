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
 * The entitlement everything paid hangs off.
 *
 * Deliberately the only one. Entitlements are what the app should check;
 * products are what the store sells, and which product granted access — a month,
 * a year, or once and for all — is RevenueCat's problem rather than the game's.
 */
export const PRO_ENTITLEMENT = "Teqie Pro";

/** The products behind that entitlement, as configured in RevenueCat. */
export const PRO_PRODUCTS = {
  lifetime: "lifetime",
  yearly: "yearly",
  monthly: "monthly",
} as const;

export type ProProductId = (typeof PRO_PRODUCTS)[keyof typeof PRO_PRODUCTS];

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

export interface ProStatus {
  /**
   * Whether RevenueCat has answered yet.
   *
   * Distinct from `pro` being false: before the first answer the honest state
   * is "unknown", and a paywall shown to a subscriber because their status had
   * not loaded is the worst version of this feature.
   */
  ready: boolean;
  /** Whether the Teqie Pro entitlement is active right now. */
  pro: boolean;
  /** Which product is carrying it, when RevenueCat says. */
  productId: string | null;
  /** False on a subscription heading for expiry — the prompt to win them back. */
  willRenew: boolean;
  /** ISO date the access lapses, or null for lifetime. */
  expires: string | null;
}

const UNKNOWN: ProStatus = {
  ready: false,
  pro: false,
  productId: null,
  willRenew: false,
  expires: null,
};

/**
 * Read the entitlement out of a customer info payload.
 *
 * Pure and exported so the mapping can be tested without a store behind it —
 * `entitlements.active` is keyed by entitlement identifier, and getting that
 * lookup wrong fails in the one direction nobody notices: silently, for paying
 * players only.
 */
export function readProStatus(info: CustomerInfo | null | undefined): ProStatus {
  const entitlement = info?.entitlements?.active?.[PRO_ENTITLEMENT];
  if (!entitlement) return { ...UNKNOWN, ready: info != null };
  return {
    ready: true,
    pro: true,
    productId: entitlement.productIdentifier ?? null,
    willRenew: entitlement.willRenew ?? false,
    expires: entitlement.expirationDate ?? null,
  };
}

let status: ProStatus = { ...UNKNOWN };
const listeners = new Set<(s: ProStatus) => void>();

function publish(next: ProStatus): void {
  status = next;
  for (const listener of listeners) listener(status);
}

/** The last known entitlement state. Synchronous, for gating a screen as it draws. */
export function proStatus(): ProStatus {
  return status;
}

/** Shorthand for the common question. */
export function isPro(): boolean {
  return status.pro;
}

/**
 * Watch the entitlement.
 *
 * Fires immediately with the current value, so a caller never has to handle
 * "subscribed before the first update" as a separate case. Returns an
 * unsubscribe, matching MatchController.subscribe.
 */
export function subscribeToPro(listener: (s: ProStatus) => void): () => void {
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
      // The listener is what keeps a renewal, a lapse or a purchase made on
      // another device honest without the game polling for it.
      await Purchases.addCustomerInfoUpdateListener((info) => publish(readProStatus(info)));
      await refreshPro();
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
export async function refreshPro(): Promise<ProStatus> {
  if (!purchasesAvailable()) return status;
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    publish(readProStatus(customerInfo));
  } catch (error) {
    console.warn("[purchases] could not read customer info:", describe(error));
  }
  return status;
}

/**
 * The current offering's packages, for a shop built in the game's own UI.
 *
 * Returns an empty list rather than throwing, so a shop screen can render its
 * "unavailable" state instead of failing to open.
 */
export async function proPackages(): Promise<PurchasesPackage[]> {
  if (!purchasesAvailable()) return [];
  try {
    const { current } = (await Purchases.getOfferings()) as { current: PurchasesOffering | null };
    return current?.availablePackages ?? [];
  } catch (error) {
    console.warn("[purchases] no offerings:", describe(error));
    return [];
  }
}

export type PurchaseOutcome =
  | { ok: true; pro: boolean }
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
export async function purchasePro(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  if (!purchasesAvailable()) {
    return { ok: false, cancelled: false, message: "Purchases are only available in the app." };
  }
  try {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
    publish(readProStatus(customerInfo));
    return { ok: true, pro: status.pro };
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
export async function restorePro(): Promise<PurchaseOutcome> {
  if (!purchasesAvailable()) {
    return { ok: false, cancelled: false, message: "Purchases are only available in the app." };
  }
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    publish(readProStatus(customerInfo));
    return { ok: true, pro: status.pro };
  } catch (error) {
    return { ok: false, cancelled: false, message: describe(error) };
  }
}

/**
 * Show RevenueCat's own paywall.
 *
 * Worth preferring over a hand-built screen: its contents, prices and copy are
 * configured in the dashboard, so changing the offer does not mean shipping a
 * build and waiting on review.
 */
export async function showPaywall(offering?: PurchasesOffering): Promise<boolean> {
  if (!purchasesAvailable()) return false;
  try {
    // Omitting the offering shows the current one, which is the whole point of
    // configuring it in the dashboard; passing one is for a targeted offer.
    const { result } = await RevenueCatUI.presentPaywall(offering ? { offering } : {});
    await refreshPro();
    return result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
  } catch (error) {
    console.warn("[purchases] paywall failed to present:", describe(error));
    return false;
  }
}

/**
 * Show the paywall only to players who do not already have the entitlement.
 *
 * The right call for a gate on a feature: it is a single call that does nothing
 * to a subscriber, so callers need no `isPro()` check of their own to avoid
 * selling something twice.
 */
export async function showPaywallIfNeeded(): Promise<boolean> {
  if (!purchasesAvailable()) return false;
  try {
    const { result } = await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: PRO_ENTITLEMENT,
    });
    await refreshPro();
    return result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
  } catch (error) {
    console.warn("[purchases] paywall failed to present:", describe(error));
    return false;
  }
}

/**
 * Show the Customer Center — manage, cancel, restore, request a refund.
 *
 * Handing subscription management to RevenueCat's own screen is what keeps the
 * game out of the business of explaining store policy, and it is where a
 * cancellation can be met with an offer rather than a shrug.
 */
export async function showCustomerCenter(): Promise<void> {
  if (!purchasesAvailable()) return;
  try {
    await RevenueCatUI.presentCustomerCenter();
    // Anything could have happened in there, including a cancellation.
    await refreshPro();
  } catch (error) {
    console.warn("[purchases] customer center failed to present:", describe(error));
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
