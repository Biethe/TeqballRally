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
  PRODUCT_CATEGORY,
  Purchases,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
  type PurchasesStoreProduct,
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
 * Direct real-dollar ($) in-app purchases catalog for quick unlocks.
 *
 * Maps internal asset identifiers (character ids, ball ids, venue ids)
 * to RevenueCat product identifiers and their default dollar prices.
 */
export const ASSET_PRODUCTS: Record<
  string,
  { productId: string; defaultPrice: string; label: string }
> = {
  // Venues
  basketball: { productId: "venue_the_cage", defaultPrice: "$2.99", label: "The Cage" },
  gym: { productId: ARENA_PRODUCT, defaultPrice: "$4.99", label: "The Coliseum" },
  // Characters
  EnglishPlayer: { productId: "char_england", defaultPrice: "$0.99", label: "England" },
  FrenchPlayer: { productId: "char_france", defaultPrice: "$1.99", label: "France" },
  SpanishPlayer: { productId: "char_spain", defaultPrice: "$2.99", label: "Spain" },
  bundle_champions: { productId: "bundle_champions", defaultPrice: "$4.99", label: "All Champions Pack" },
  // Balls
  BlueBall: { productId: "ball_surgeon", defaultPrice: "$0.99", label: "The Surgeon" },
  BlueAndRoseBall: { productId: "ball_feather", defaultPrice: "$0.99", label: "The Feather" },
  OrangeAndBlackBall: { productId: "ball_hammer", defaultPrice: "$0.99", label: "The Hammer" },
  bundle_balls: { productId: "bundle_balls", defaultPrice: "$1.99", label: "Pro Balls Pack" },
};

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

/**
 * Whether the key compiled into this build is a Test Store one.
 *
 * `test_` is RevenueCat's own prefix for it. Fine in a browser, where there is
 * no store to talk to anyway and fake purchases are the point — and wrong the
 * moment the app is on a phone, where it means every purchase is pretend and
 * the SDK says so in a message a tester reads as the app being broken.
 *
 * It shipped that way because the real key lived in a gitignored `.env` and
 * nothing in the build asked for it, so the fallback won silently every time
 * the app was built anywhere but the machine it was written on. The build now
 * refuses it; this is the second line, for a build made some other way.
 */
const TEST_STORE_KEY = API_KEY.startsWith("test_");

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
 * Bind the player profile identity to RevenueCat so purchases belong to
 * this user ID and can be restored or synced across devices.
 */
export async function bindUserToPurchases(userId: string, userName?: string): Promise<void> {
  if (!purchasesAvailable()) return;
  try {
    await Purchases.logIn({ appUserID: userId });
    if (userName) {
      await Purchases.setDisplayName({ displayName: userName });
    }
    await refreshArena();
  } catch (err) {
    console.warn("[purchases] could not bind user ID:", err);
  }
}

/**
 * Return formatted price for an asset, falling back to default USD price.
 */
export function formattedPriceFor(assetId: string): string {
  return ASSET_PRODUCTS[assetId]?.defaultPrice ?? "$0.99";
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

/** Whether a store exists at all. False in a browser, true on native Capacitor with an API key. */
export function purchasesAvailable(): boolean {
  return Capacitor.isNativePlatform() && Boolean(API_KEY && API_KEY.trim().length > 0);
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
    if (TEST_STORE_KEY) {
      // Configuring anyway would leave every purchase failing for a reason
      // nobody could see from the outside. Saying so once, here, is the only
      // way this is ever noticed before a tester finds it.
      console.error(
        "[purchases] built with a RevenueCat Test Store key — no real purchase can complete. " +
          "Set VITE_REVENUECAT_KEY to the goog_ Android key for a Play build."
      );
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
/**
 * The store's own product for an identifier, or null if it does not sell one.
 *
 * Asked for rather than made up. `purchaseStoreProduct` wants the object the
 * SDK handed out — it carries the product's category, its price and the Play
 * Billing details underneath — and an object with nothing in it but an
 * identifier is refused outright:
 *
 *   Missing productCategory parameter in {"identifier":"coins_handful"}
 *
 * which is the error a player saw when they tried to buy anything. The two
 * call sites that produced it both built `{ identifier }` by hand and cast it
 * through `unknown` to get past the type checker, which is exactly the check
 * that would have said so.
 *
 * `NON_SUBSCRIPTION`, and not by accident: everything sold here is bought once
 * or consumed, and `getProducts` looks for subscriptions unless told
 * otherwise — so the default would answer with nothing at all for a coin pack
 * and the failure would look like a missing product rather than a wrong
 * question.
 */
async function storeProduct(productId: string): Promise<PurchasesStoreProduct | null> {
  const { products } = await Purchases.getProducts({
    productIdentifiers: [productId],
    type: PRODUCT_CATEGORY.NON_SUBSCRIPTION,
  });
  return products.find((p) => p.identifier === productId) ?? products[0] ?? null;
}

/**
 * Buy a product the offerings did not have a package for.
 *
 * A fallback that should rarely run: a product configured in RevenueCat is
 * normally reachable through an offering, and one that is not usually means
 * the dashboard is missing it rather than that this path is needed.
 */
async function purchaseById(productId: string): Promise<PurchaseOutcome | PurchasesStoreProduct> {
  const product = await storeProduct(productId);
  if (product) return product;

  // Nothing came back, and the two reasons for that need completely different
  // things doing about them — so say which one it is rather than blaming the
  // product for both.
  //
  // Play matches the package name and signing certificate against the app it
  // has published. A sideloaded build is signed with the debug key and is not
  // that app, so Billing answers with no products at all, however correctly
  // they are configured in the console. Told it is the product's fault, the
  // next thing anybody does is go and re-check a console that was right.
  const reachable = await Purchases.canMakePayments()
    .then((r) => r.canMakePayments)
    .catch(() => false);
  return {
    ok: false,
    cancelled: false,
    message: reachable
      ? `The store is not offering ${productId} right now. It may not be live on this track yet.`
      : "Purchases need a copy installed from Google Play. A sideloaded build cannot see the store's products.",
  };
}

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
 * Purchase an individual character, ball, or venue directly via RevenueCat.
 */
export async function purchaseAsset(assetId: string): Promise<PurchaseOutcome> {
  if (assetId === "gym") {
    const success = await offerArena();
    return success ? { ok: true, owned: true } : { ok: false, cancelled: true };
  }
  if (!purchasesAvailable()) {
    if (import.meta.env.DEV) {
      console.log(`[purchases] (DEV) simulated purchase of ${assetId}`);
      return { ok: true, owned: true };
    }
    return { ok: false, cancelled: false, message: "Purchases are only available in the app." };
  }
  const productMeta = ASSET_PRODUCTS[assetId];
  if (!productMeta) {
    return { ok: false, cancelled: false, message: `Unknown asset: ${assetId}` };
  }
  try {
    const offerings = (await Purchases.getOfferings()) as {
      current?: PurchasesOffering | null;
      all?: Record<string, PurchasesOffering | undefined>;
    };
    let matchingPkg: PurchasesPackage | undefined;
    for (const offering of Object.values(offerings.all ?? {})) {
      if (!offering) continue;
      const found = offering.availablePackages?.find(
        (p) => p.product?.identifier === productMeta.productId
      );
      if (found) {
        matchingPkg = found;
        break;
      }
    }
    if (matchingPkg) {
      return purchasePackage(matchingPkg);
    }
    // No package for it, so buy the product itself — with the product the
    // store actually described, never one made up here.
    const found = await purchaseById(productMeta.productId);
    if ("ok" in found) return found;
    const { customerInfo } = await Purchases.purchaseStoreProduct({ product: found });
    publish(readArenaStatus(customerInfo));
    return { ok: true, owned: true };
  } catch (error) {
    if (wasCancelled(error)) return { ok: false, cancelled: true };
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

export const COIN_PACK_METADATA: Record<
  string,
  { coins: number; defaultPrice: string; label: string }
> = {
  coins_handful: { coins: 1200, defaultPrice: "$0.99", label: "Handful of Coins" },
  coins_pocket: { coins: 3500, defaultPrice: "$2.49", label: "Pocket of Coins" },
  coins_bag: { coins: 9000, defaultPrice: "$4.99", label: "Bag of Coins" },
};

export interface CoinPackInfo {
  productId: string;
  coins: number;
  priceString: string;
  pkg?: PurchasesPackage;
}

/** How many coins a bought package is worth, or 0 if it is not a coin pack. */
export function coinsForProduct(productId: string): number {
  return COIN_PACKS[productId] ?? 0;
}

/**
 * The coin packs on sale, cheapest first.
 *
 * Returns live store packages if RevenueCat offerings answer, or standard
 * fallback metadata with default USD prices off-device or when offerings are not configured.
 */
export async function coinPackages(): Promise<CoinPackInfo[]> {
  const defaults: CoinPackInfo[] = Object.entries(COIN_PACK_METADATA).map(([productId, meta]) => ({
    productId,
    coins: meta.coins,
    priceString: meta.defaultPrice,
  }));

  if (!purchasesAvailable()) return defaults;

  try {
    const offerings = (await Purchases.getOfferings()) as {
      current?: PurchasesOffering | null;
      all?: Record<string, PurchasesOffering | undefined>;
    };

    const foundPackages: PurchasesPackage[] = [];
    if (offerings.all?.coins?.availablePackages) {
      foundPackages.push(...offerings.all.coins.availablePackages);
    }
    for (const offering of Object.values(offerings.all ?? {})) {
      if (!offering || offering === offerings.all?.coins) continue;
      for (const p of offering.availablePackages ?? []) {
        if (p.product?.identifier in COIN_PACKS || p.product?.identifier?.startsWith("coins_")) {
          if (!foundPackages.some((f) => f.product?.identifier === p.product?.identifier)) {
            foundPackages.push(p);
          }
        }
      }
    }

    return defaults.map((def) => {
      const match = foundPackages.find((p) => p.product?.identifier === def.productId);
      if (match) {
        return {
          productId: def.productId,
          coins: def.coins,
          priceString: match.product.priceString || def.priceString,
          pkg: match,
        };
      }
      return def;
    });
  } catch (error) {
    console.warn("[purchases] could not read coin offerings:", describe(error));
    return defaults;
  }
}

/**
 * Buy a coin pack, and say how many coins it is worth.
 *
 * Supports purchasing via an active RevenueCat package or fallback direct
 * store product purchase.
 */
export async function purchaseCoins(
  pack: CoinPackInfo | PurchasesPackage | string
): Promise<PurchaseOutcome & { coins?: number }> {
  const productId =
    typeof pack === "string"
      ? pack
      : "productId" in pack
        ? pack.productId
        : pack.product.identifier;
  const pkg =
    typeof pack === "object" && pack !== null && "pkg" in pack
      ? pack.pkg
      : typeof pack === "object" && pack !== null && "product" in pack
        ? pack
        : undefined;

  if (pkg) {
    const outcome = await purchasePackage(pkg);
    if (!outcome.ok) return outcome;
    return { ...outcome, coins: coinsForProduct(productId) };
  }

  // Direct purchase fallback via store product
  if (!purchasesAvailable()) {
    return { ok: false, cancelled: false, message: "Purchases are only available in the app." };
  }
  try {
    const found = await purchaseById(productId);
    if ("ok" in found) return found;
    const { customerInfo } = await Purchases.purchaseStoreProduct({ product: found });
    publish(readArenaStatus(customerInfo));
    return { ok: true, owned: true, coins: coinsForProduct(productId) };
  } catch (error) {
    if (wasCancelled(error)) return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, message: describe(error) };
  }
}
