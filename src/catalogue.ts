/**
 * What each thing on sale actually gives you.
 *
 * Pure, and shared with the server through `src/rules.ts`, because this is the
 * one fact both ends have to agree on and neither may decide alone. The client
 * used to hold it privately and tell the server the answer — "I bought this,
 * give me nine thousand coins" — which is not a purchase record, it is a
 * request. The server reads the same table now, against a product id that
 * reached it from RevenueCat rather than from the device that benefits.
 *
 * Prices and labels are deliberately not here. Those are the store's to say
 * and the screen's to draw; what a product *grants* is a rule.
 */

/** What buying a product gives: coins to spend, or a thing kept for good. */
export type Grant = { kind: "coins"; coins: number } | { kind: "asset"; asset: string };

/**
 * Product id to grant, for everything the game sells.
 *
 * The ids are Google Play's and are permanent, so this table is append-only in
 * practice: a product that has ever been sold has to keep granting what it
 * granted, or somebody who paid loses what they paid for.
 */
export const CATALOGUE: Record<string, Grant> = {
  coins_handful: { kind: "coins", coins: 1200 },
  coins_pocket: { kind: "coins", coins: 3500 },
  coins_bag: { kind: "coins", coins: 9000 },

  lifetime: { kind: "asset", asset: "gym" },
  venue_the_cage: { kind: "asset", asset: "basketball" },

  char_england: { kind: "asset", asset: "EnglishPlayer" },
  char_france: { kind: "asset", asset: "FrenchPlayer" },
  char_spain: { kind: "asset", asset: "SpanishPlayer" },
  bundle_champions: { kind: "asset", asset: "bundle_champions" },

  ball_surgeon: { kind: "asset", asset: "BlueBall" },
  ball_feather: { kind: "asset", asset: "BlueAndRoseBall" },
  ball_hammer: { kind: "asset", asset: "OrangeAndBlackBall" },
  bundle_balls: { kind: "asset", asset: "bundle_balls" },
};

/**
 * The assets a bundle stands for.
 *
 * A bundle is sold as one product and owned as several, so the thing that is
 * granted is not the thing that was bought. Kept beside the catalogue because
 * the two are read together and a bundle that granted nothing would look, from
 * every screen, exactly like a bundle that had not been bought.
 */
export const BUNDLES: Record<string, string[]> = {
  bundle_champions: ["EnglishPlayer", "FrenchPlayer", "SpanishPlayer"],
  bundle_balls: ["BlueBall", "BlueAndRoseBall", "OrangeAndBlackBall"],
};

/**
 * Everything a product unlocks, bundles opened out. Empty for a coin pack.
 */
export function assetsFor(productId: string): string[] {
  const grant = CATALOGUE[productId];
  if (!grant || grant.kind !== "asset") return [];
  return BUNDLES[grant.asset] ?? [grant.asset];
}

/**
 * Coins a product is worth, or 0 if it is not a coin pack.
 *
 * Named for the purchase rather than the league, whose `coinsFor` answers a
 * different question entirely: what a match paid out.
 */
export function coinsForPurchase(productId: string): number {
  const grant = CATALOGUE[productId];
  return grant?.kind === "coins" ? grant.coins : 0;
}
