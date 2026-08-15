import { describe, expect, it } from "vitest";
import {
  STAMINA_CAP,
  SUPPLIES,
  buy,
  canBuy,
  consumeArmed,
  staminaMultiplier,
  supplyFor,
  type Wallet,
} from "../src/supplies";

/**
 * The shop, and the only place in the game where coins leave a player.
 *
 * Everything here is about not taking something twice or giving something
 * away: a purchase that debits and delivers nothing costs a real person real
 * money, and a drink that survives the match it was drunk in makes every hard
 * game retryable for free.
 */

const wallet = (over: Partial<Wallet> = {}): Wallet => ({
  coins: 5000,
  drinks: {},
  taken: [],
  ...over,
});

describe("the shelf", () => {
  it("prices a supplement above a drink", () => {
    // One is for a match and one is for good; if they cost the same the drink
    // is pointless.
    const drinks = SUPPLIES.filter((s) => s.kind === "drink");
    const supplements = SUPPLIES.filter((s) => s.kind === "supplement");

    expect(drinks.length).toBeGreaterThan(0);
    expect(supplements.length).toBeGreaterThan(0);
    expect(Math.min(...supplements.map((s) => s.coins))).toBeGreaterThan(
      Math.max(...drinks.map((s) => s.coins))
    );
  });

  it("only ever helps", () => {
    for (const supply of SUPPLIES) expect(supply.stamina, supply.id).toBeGreaterThan(1);
  });

  it("charges more for more", () => {
    // Within a kind, a bigger lift costs more. Otherwise one item is strictly
    // the right answer and the rest are decoration.
    for (const kind of ["drink", "supplement"] as const) {
      const sorted = SUPPLIES.filter((s) => s.kind === kind).sort((a, b) => a.coins - b.coins);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].stamina, `${sorted[i].id} vs ${sorted[i - 1].id}`).toBeGreaterThan(
          sorted[i - 1].stamina
        );
      }
    }
  });
});

describe("buying", () => {
  it("takes the coins and hands over the drink", () => {
    const before = wallet({ coins: 1000 });
    const after = buy(before, "isotonic");
    const price = supplyFor("isotonic")!.coins;

    expect(after.coins).toBe(1000 - price);
    expect(after.drinks.isotonic).toBe(1);
  });

  it("refuses when the coins are not there", () => {
    const broke = wallet({ coins: 10 });

    expect(buy(broke, "espresso")).toEqual(broke);
  });

  it("never debits without delivering", () => {
    // The failure that costs somebody something real.
    for (const supply of SUPPLIES) {
      const exact = wallet({ coins: supply.coins - 1 });
      const after = buy(exact, supply.id);
      expect(after.coins, supply.id).toBe(exact.coins);
      expect(after.drinks, supply.id).toEqual({});
      expect(after.taken, supply.id).toEqual([]);
    }
  });

  it("stacks drinks and does not stack supplements", () => {
    let bag = wallet();
    bag = buy(bag, "water");
    bag = buy(bag, "water");
    expect(bag.drinks.water).toBe(2);

    let shelf = wallet();
    shelf = buy(shelf, "creatine");
    const spent = shelf.coins;
    shelf = buy(shelf, "creatine");

    expect(shelf.taken).toEqual(["creatine"]);
    expect(shelf.coins, "charged twice for a one-off").toBe(spent);
  });

  it("will not sell a supplement already taken", () => {
    const supplement = SUPPLIES.find((s) => s.kind === "supplement")!;

    expect(canBuy(supplement, 99999, [supplement.id])).toBe(false);
  });

  it("ignores an id that is not on the shelf", () => {
    const before = wallet();

    expect(buy(before, "steroids")).toEqual(before);
  });
});

describe("what it does to the legs", () => {
  it("is neutral with nothing taken and nothing drunk", () => {
    expect(staminaMultiplier([], null)).toBe(1);
  });

  it("stacks supplements with each other", () => {
    const both = staminaMultiplier(["creatine", "protocol"], null);
    const one = staminaMultiplier(["creatine"], null);

    expect(both).toBeGreaterThan(one);
  });

  it("adds the armed drink on top", () => {
    expect(staminaMultiplier(["creatine"], "espresso")).toBeGreaterThan(
      staminaMultiplier(["creatine"], null)
    );
  });

  it("caps, so fitness never stops mattering", () => {
    const everything = SUPPLIES.filter((s) => s.kind === "supplement").map((s) => s.id);

    expect(staminaMultiplier(everything, "espresso")).toBeLessThanOrEqual(STAMINA_CAP);
  });

  it("ignores a drink in the taken list and a supplement in the armed slot", () => {
    // Storage outlives a shelf change, and the two kinds are not interchangeable.
    expect(staminaMultiplier(["espresso"], null)).toBe(1);
    expect(staminaMultiplier([], "creatine")).toBe(1);
  });
});

describe("drinking it", () => {
  it("takes one out of the bag", () => {
    const bag = wallet({ drinks: { water: 2 } });
    const { wallet: after, drank } = consumeArmed(bag, "water");

    expect(drank).toBe("water");
    expect(after.drinks.water).toBe(1);
  });

  it("removes the entry entirely on the last one", () => {
    const bag = wallet({ drinks: { water: 1 } });

    expect(consumeArmed(bag, "water").wallet.drinks).toEqual({});
  });

  it("does nothing when the bag is empty", () => {
    const bag = wallet({ drinks: {} });
    const { wallet: after, drank } = consumeArmed(bag, "water");

    expect(drank).toBeNull();
    expect(after).toEqual(bag);
  });

  it("does nothing when nothing is armed", () => {
    const bag = wallet({ drinks: { water: 1 } });

    expect(consumeArmed(bag, null).drank).toBeNull();
    expect(consumeArmed(bag, null).wallet.drinks.water).toBe(1);
  });
});
