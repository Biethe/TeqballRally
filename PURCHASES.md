# Purchases

**There are no subscriptions.** Real money buys exactly two things: the arena,
once and for all, and coins. Everything else in the game — characters, balls,
levels, supplies — is bought with coins and trophies, and both are earned by
playing. A game that rents out its content has to keep being paid to stay the
same game, and that is not the deal this one makes.

The arena hangs off one entitlement. The game asks `ownsArena()`;
`src/purchases.ts` is the only module that imports the SDK, so there is one
answer rather than one per call site.

The entitlement identifier is still the string the dashboard was first
configured with (`Teqie Pro`, in `ARENA_ENTITLEMENT`). That is deliberate:
renaming it would strip the arena from everybody who has already bought it.
What changed is the offer behind it, not the key the app checks — and a legacy
subscription still carrying somebody's entitlement keeps working until it
lapses, at which point RevenueCat drops it out of `entitlements.active` by
itself.

## What is actually sold

The **sports hall** — the indoor arena, `gym` in `src/venue.ts`. The three
outdoor courts are free, which is the shape of the offer: what is given away is
a whole game rather than a demo, and the venue that costs is the one that looks
like a fixture rather than a kickabout.

The rule lives on the venue itself (`premium: true`), so adding a venue forces
somebody to answer whether it is for sale, and two pure functions decide the
rest:

- `isPremiumVenue(id)` — what the picker marks with a padlock.
- `permittedVenue(id, pro)` — what a **remembered** choice is allowed to be.

That second one is the case worth naming. A venue chosen while paying is kept
in `localStorage`, and an entitlement can go away between two sessions — a
refund, a legacy subscription lapsing — so a remembered choice has to be
re-checked rather than trusted. It is applied at boot, *after* the store
answers rather than before —
holding the first frame on a network round trip would make a paying player wait
to see what they paid for, whereas showing a lapsed one the hall for a moment on
the title screen costs nothing.

A `?venue=` URL override is deliberately **not** gated: it is the hook the
harnesses in `scripts/` drive, and this is a cosmetic backdrop in an open web
bundle. Obfuscating a client-side check there would be theatre, not security.

Where it is wired:

| Screen | What it does |
| --- | --- |
| VENUE tab on the select screen | The sports hall is previewed at full size in the real scene, with the lock line under its name and PLAY turned into UNLOCK. Browsing only previews — nothing is bought by scrolling past it |
| SETTINGS → THE ARENA | Whether it is yours, UNLOCK if it is not, and RESTORE. Nothing renews, so there is no term to explain and no subscription screen to hand anybody off to |

`node scripts/verify-purchase-gate.mjs` proves all of it in a real browser at
A20e size, against a build.

## Why the Capacitor plugin rather than Kotlin

The game is TypeScript in a WebView; `android/` is a shell around it. Every
gate worth putting behind a purchase lives in the web layer, and an entitlement
the WebView cannot read is one that nothing can act on.

`@revenuecat/purchases-capacitor` **is** the native Android SDK: its
`build.gradle` pulls in `com.revenuecat.purchases:purchases-hybrid-common`,
which wraps `com.revenuecat.purchases:purchases`. The Gradle dependency from
RevenueCat's Android install guide is there — it just arrives through the
plugin, and comes with a bridge into the game instead of needing one written.

Version note: the plugin line is pinned to **11.3.2**, the last that supports
Capacitor 7. Moving to 12 or 13 means migrating the app to Capacitor 8 first.

## What you have to do in the dashboard

The code is finished; none of it does anything until these exist, spelled
exactly like this.

1. **Products** — in Play Console, then imported in RevenueCat:

   | Identifier | Type |
   | --- | --- |
   | `lifetime` | One-time purchase — the arena |
   | `coins_handful` | Consumable |
   | `coins_pocket` | Consumable |
   | `coins_bag` | Consumable |

   Any subscription products that already exist can stay attached to the
   entitlement so existing subscribers keep their arena, but nothing in the
   game offers them any more. Remove them from the *offering* and Play stops
   selling them, without taking anything away from anybody.

2. **Entitlement** — create `Teqie Pro` and attach `lifetime` to it. The
   identifier must match `ARENA_ENTITLEMENT` in `src/purchases.ts` character
   for character, including the space and the capitals: it is a dictionary key,
   and a mismatch fails silently and only for paying players.

3. **Offerings** — one marked *current* holding `lifetime`, and a second named
   `coins` holding the three consumables. `coinPackages()` reads the `coins`
   offering by name; the paywall reads the current one.

4. **Paywall** — design it under Tools → Paywalls against the current
   offering. `offerArena()` presents whatever is configured there, so the price
   and the copy can change without shipping a build.

## Coins

The supplies shelf — energy drinks and supplements, which are the only things
that touch stamina — is priced in coins, and coins are earned by playing. The
real purchase sells **coins**, not the items.

That is deliberate. Selling the advantage directly would give the shop two
prices for the same thing and make one of them money; selling the currency
keeps one shelf, one set of prices, and leaves paying as a shortcut through the
grind rather than a different game. A player who never spends anything can own
everything on it.

Coin packs are **consumables**, so RevenueCat keeps no balance for them: the
credit is applied by the app and stored with the career. What has to exist in
the dashboard:

1. **Products** in Play, then imported: `coins_handful`, `coins_pocket`,
   `coins_bag`, all one-time purchases.
2. **An offering identified `coins`**, with a package per product. `coinPackages()`
   reads `offerings.all.coins`, not the current offering — the current one
   belongs to the arena.

How many coins each is worth lives in `COIN_PACKS` in `src/purchases.ts`, never
in the store: a product renamed or mispriced in the dashboard then credits
nothing rather than guessing. Being wrong in the player's favour is still being
wrong, and being wrong the other way takes their money.

Nothing here is required for the game to run. With no `coins` offering the shop
says there is nothing on sale, which is a fact about the account rather than a
fault.

## The API key

`API_KEY` defaults to the **Test Store** key, which is right for development and
wrong for release. A Play build needs the `goog_…` Android key:

```sh
VITE_REVENUECAT_KEY=goog_your_key npm run build && npx cap sync android
```

Public SDK keys are meant to ship inside the app, so this is not a secret — it
is overridable because the key is per-store and per-project.

## Using it

The entitlement is available synchronously once known, and observable while it
is not:

```ts
import { ownsArena, arenaStatus, subscribeToArena, offerArena } from "./purchases";

// Gate a feature. `ready` matters: before the store answers, "does not own it"
// is a guess, and locking somebody out of what they paid for is worse than
// briefly showing something you should not have.
const status = arenaStatus();
if (status.ready && !status.owned) lockArena();

// Keep a screen honest as restores and refunds arrive.
const stop = subscribeToArena((s) => arenaButton.classList.toggle("locked", !s.owned));

// Sell it. Does nothing for somebody who already owns it, so no ownsArena()
// check is needed around the call.
if (await offerArena()) unlockArena();
```

Coins are the other half, and the only other thing money buys:

```ts
import { coinPackages, coinsForProduct, purchaseCoins } from "./purchases";

for (const pkg of await coinPackages()) {
  // pkg.product.priceString is already localised — never format prices yourself.
  addRow(`${coinsForProduct(pkg.product.identifier)} coins`, pkg.product.priceString, async () => {
    const outcome = await purchaseCoins(pkg);
    if (outcome.ok && outcome.coins) return credit(outcome.coins);
    // Cancellation is not failure. An error toast after somebody deliberately
    // backed out reads as the app arguing with them.
    if (!outcome.ok && !outcome.cancelled) showError(outcome.message);
  });
}
```

Coins are also bought with **trophies**, which needs no store at all —
`tradeTrophies` in `src/progress.ts`, offered on the same screen as the packs
so there is one place a player goes to get coins. It is a real decision rather
than a discount: trophies are rank, rank is the coin bonus on every match, and
cashing them in trades tomorrow's earning rate for something to spend tonight.
`best` is deliberately untouched, so trading down never takes away a character
the player already unlocked.

Both stores require a restore path, and a player who reinstalls has no other
way back to what they paid for:

```ts
import { restorePurchases } from "./purchases";

restoreButton.onclick = () => restorePurchases();
```

There is no Customer Center: it exists to manage subscriptions, and there are
none. A refund request goes through Play, as it does for any one-time purchase.

## Off-device

`purchasesAvailable()` is false in a browser, so the dev server, the hosted
build and every harness in `scripts/` run with no store: `initPurchases()`
settles immediately on "ready, does not own it", purchase calls return a
failure with a readable message, and the paywall no-ops. Nothing has to be
stubbed to run the game outside the app — and the trophies-for-coins exchange
still works, because it never needed a store.

## Testing a purchase

The Test Store key works without Play at all — useful before products are live.
For real sandbox purchases:

1. Add your Google account to **License testers** in Play Console.
2. Install a build signed with the upload key (`bundleRelease`/`assembleRelease`),
   from an internal testing track. Sideloaded debug builds cannot buy anything.
3. Purchases are free. Consumables can be bought repeatedly; the arena is a
   one-time purchase, so clear it from the test account between runs.

## Before release

- `VITE_REVENUECAT_KEY` set to the `goog_…` key, not the test one.
- Every product active in Play Console, not just in RevenueCat: `lifetime`
  and the three coin packs.
- No subscription left in the *current* offering. Existing ones may stay
  attached to the entitlement so past subscribers keep the arena, but nothing
  should still be on sale.
- Restore path reachable without buying anything first — Apple rejects for this,
  and Play expects it.
- A purchase and a restore tried on a real device, on a release-signed build.
