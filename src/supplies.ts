/**
 * Energy drinks and supplements: the things a player buys for their legs.
 *
 * Stamina is the one trait a match takes away from you. It drains as you run,
 * it comes back between points, and when it is gone you are slow to start and
 * slow to turn — which is exactly the kind of problem somebody will pay to fix.
 * That is why it is the trait with a shop attached and none of the others are.
 *
 * Two kinds, and the difference is the whole design:
 *
 * - A **drink** is used up. It lifts stamina for one match and then it is gone,
 *   so it is a decision before a hard game rather than a number that quietly
 *   becomes the new normal.
 * - A **supplement** is taken once and kept. It is the long purchase, priced so
 *   that it is a season's worth of coins rather than an afternoon's.
 *
 * Both are earnable. Coins come out of matches and seasons, so nothing here is
 * only reachable with money — the real purchase buys the coins, not the
 * advantage, and a player who never spends anything can own all of it.
 */

export type SupplyKind = "drink" | "supplement";

export interface Supply {
  id: string;
  kind: SupplyKind;
  label: string;
  /** One line, shown under the name. */
  blurb: string;
  /** Coins for one. */
  coins: number;
  /**
   * Multiplier on the player's stamina trait.
   *
   * A multiplier rather than a flat number so it stays proportional to the
   * character: ENGLAND already lasts all day and BRAZIL runs out of legs first,
   * and a flat bonus would close that gap instead of widening the choice.
   */
  stamina: number;
}

export const SUPPLIES: Supply[] = [
  {
    id: "water",
    kind: "drink",
    label: "BOTTLED WATER",
    blurb: "A cold one at the changeover. Modest, and it always helps.",
    coins: 90,
    stamina: 1.1,
  },
  {
    id: "isotonic",
    kind: "drink",
    label: "ISOTONIC",
    blurb: "Salts back in. You will still be running in the third set.",
    coins: 240,
    stamina: 1.22,
  },
  {
    id: "espresso",
    kind: "drink",
    label: "DOUBLE ESPRESSO",
    blurb: "Not sensible. Very effective.",
    coins: 520,
    stamina: 1.38,
  },
  {
    id: "creatine",
    kind: "supplement",
    label: "CREATINE",
    blurb: "Taken once, kept for good. The legs come back quicker.",
    coins: 1200,
    stamina: 1.12,
  },
  {
    id: "protocol",
    kind: "supplement",
    label: "RECOVERY PROTOCOL",
    blurb: "Sleep, food and physio, on a schedule. Permanent.",
    coins: 3000,
    stamina: 1.2,
  },
];

export function supplyFor(id: string): Supply | null {
  return SUPPLIES.find((s) => s.id === id) ?? null;
}

/**
 * What the player's legs are worth, given what they have taken and drunk.
 *
 * Supplements stack with each other — they are separate purchases and owning
 * both should be worth more than owning one — and at most one drink applies,
 * because a drink is armed for a match rather than accumulated. The result is
 * capped: past a point the player is not tired at all, and a match nobody can
 * lose on fitness is one where the trait may as well not exist.
 */
export const STAMINA_CAP = 2.2;

export function staminaMultiplier(taken: readonly string[], drink: string | null): number {
  let multiplier = 1;
  for (const id of taken) {
    const supply = supplyFor(id);
    if (supply?.kind === "supplement") multiplier *= supply.stamina;
  }
  const armed = drink ? supplyFor(drink) : null;
  if (armed?.kind === "drink") multiplier *= armed.stamina;
  return Math.min(STAMINA_CAP, multiplier);
}

/** Whether this player can afford one, and has room for it. */
export function canBuy(supply: Supply, coins: number, taken: readonly string[]): boolean {
  // A supplement is a one-off: there is nothing to buy a second time.
  if (supply.kind === "supplement" && taken.includes(supply.id)) return false;
  return coins >= supply.coins;
}

/**
 * The bag and the wallet after a purchase.
 *
 * Pure, and it returns the whole state rather than mutating: buying is the one
 * place coins leave a player's account, and a half-applied purchase — coins
 * gone, nothing bought — is the bug that costs somebody something real. Refuses
 * rather than throws when it cannot be afforded, so a UI that has fallen out of
 * step with the wallet cannot spend money it does not have.
 */
export interface Wallet {
  coins: number;
  drinks: Record<string, number>;
  taken: string[];
}

export function buy(wallet: Wallet, id: string): Wallet {
  const supply = supplyFor(id);
  if (!supply || !canBuy(supply, wallet.coins, wallet.taken)) return wallet;
  if (supply.kind === "supplement") {
    return {
      coins: wallet.coins - supply.coins,
      drinks: { ...wallet.drinks },
      taken: [...wallet.taken, supply.id],
    };
  }
  return {
    coins: wallet.coins - supply.coins,
    drinks: { ...wallet.drinks, [supply.id]: (wallet.drinks[supply.id] ?? 0) + 1 },
    taken: [...wallet.taken],
  };
}

/**
 * Take the armed drink out of the bag, at the moment a match starts.
 *
 * At the *start*, not the end: a player who quits a match having drunk the
 * drink has still drunk it, and crediting it back would make a free retry out
 * of every hard game.
 */
export function consumeArmed(wallet: Wallet, armed: string | null): { wallet: Wallet; drank: string | null } {
  if (!armed) return { wallet, drank: null };
  const left = wallet.drinks[armed] ?? 0;
  if (left <= 0) return { wallet, drank: null };
  const drinks = { ...wallet.drinks };
  if (left === 1) delete drinks[armed];
  else drinks[armed] = left - 1;
  return { wallet: { ...wallet, drinks }, drank: armed };
}
