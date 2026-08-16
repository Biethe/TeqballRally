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

import type { CharacterDef } from "./config";

export type SupplyKind = "drink" | "supplement";

/**
 * What a supply does to the player who takes it.
 *
 * Multipliers rather than flat numbers so they stay proportional to the
 * character: ENGLAND already lasts all day and BRAZIL runs out of legs first,
 * and a flat bonus would close that gap instead of widening the choice.
 *
 * Deliberately not `power`. Pace belongs to the character and to the ball, and
 * a shelf that sells a harder ball is a shelf that decides matches on its own.
 * What is for sale is being *fitter and sharper* for one game.
 */
export interface SupplyBoost {
  stamina?: number;
  agility?: number;
  precision?: number;
}

export interface Supply {
  id: string;
  kind: SupplyKind;
  label: string;
  /** One line, shown under the name. */
  blurb: string;
  /** Coins for one. */
  coins: number;
  boost: SupplyBoost;
}

/**
 * Three, down from five.
 *
 * The old shelf had two drinks and two supplements that differed only by how
 * much stamina they bought, which is four prices for one decision. What is
 * left is one of each kind that a player can actually tell apart: the cheap
 * drink is fitness, the expensive drink is fitness *and* sharpness, and the
 * supplement is the permanent one you save up for.
 */
export const SUPPLIES: Supply[] = [
  {
    id: "isotonic",
    kind: "drink",
    label: "ISOTONIC",
    blurb: "Salts back in. You will still be running in the third set.",
    coins: 150,
    boost: { stamina: 1.25 },
  },
  {
    id: "espresso",
    kind: "drink",
    label: "DOUBLE ESPRESSO",
    blurb: "Not sensible. Very effective — fresher legs and a sharper first step.",
    coins: 420,
    boost: { stamina: 1.2, agility: 1.12 },
  },
  {
    id: "protocol",
    kind: "supplement",
    label: "RECOVERY PROTOCOL",
    blurb: "Sleep, food and physio, on a schedule. Taken once, kept for good.",
    coins: 2200,
    boost: { stamina: 1.18, agility: 1.06, precision: 1.05 },
  },
];

export function supplyFor(id: string): Supply | null {
  return SUPPLIES.find((s) => s.id === id) ?? null;
}

/**
 * What the player is worth, given what they have taken and drunk.
 *
 * Supplements stack with each other — they are separate purchases and owning
 * both should be worth more than owning one — and at most one drink applies,
 * because a drink is armed for a match rather than accumulated. Each trait is
 * capped separately: past a point the player is not tired at all, and a match
 * nobody can lose on fitness is one where the trait may as well not exist.
 */
export const BOOST_CAP: Required<SupplyBoost> = { stamina: 1.8, agility: 1.35, precision: 1.25 };

const BOOST_KEYS = ["stamina", "agility", "precision"] as const;

/** Every multiplier the bag is worth, capped. 1 everywhere with an empty bag. */
export function supplyBoost(
  taken: readonly string[],
  drink: string | null
): Required<SupplyBoost> {
  const total: Required<SupplyBoost> = { stamina: 1, agility: 1, precision: 1 };
  const apply = (supply: Supply | null): void => {
    if (!supply) return;
    for (const key of BOOST_KEYS) total[key] *= supply.boost[key] ?? 1;
  };
  for (const id of taken) {
    const supply = supplyFor(id);
    if (supply?.kind === "supplement") apply(supply);
  }
  const armed = drink ? supplyFor(drink) : null;
  if (armed?.kind === "drink") apply(armed);
  for (const key of BOOST_KEYS) total[key] = Math.min(BOOST_CAP[key], total[key]);
  return total;
}

/** Just the legs, which is the one the shop screen puts a number on. */
export function staminaMultiplier(taken: readonly string[], drink: string | null): number {
  return supplyBoost(taken, drink).stamina;
}

/**
 * The player, carrying what they bought.
 *
 * Shaped like `withBall` and `withCareer` — traits in, traits out — so the
 * physics, the AI and the card all read one already-modified `CharacterDef`
 * and none of them has to know a shop was involved.
 */
export function withSupplies(
  def: CharacterDef,
  taken: readonly string[],
  drink: string | null
): CharacterDef {
  const boost = supplyBoost(taken, drink);
  return {
    ...def,
    stamina: def.stamina * boost.stamina,
    agility: def.agility * boost.agility,
    precision: def.precision * boost.precision,
  };
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
