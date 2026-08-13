# Purchases

Everything paid hangs off one entitlement, **Teqie Pro**. The game asks
`isPro()`; it never asks which product somebody bought, because a month, a year
and a lifetime all mean the same thing to a locked arena.

`src/purchases.ts` is the only module that imports the SDK, so there is one
answer to "is this player pro" rather than one per call site.

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
   | `monthly` | Auto-renewing subscription |
   | `yearly` | Auto-renewing subscription |
   | `lifetime` | One-time purchase |

2. **Entitlement** — create `Teqie Pro` and attach all three products to it.
   The identifier must match `PRO_ENTITLEMENT` in `src/purchases.ts`
   character for character, including the space and the capitals: it is a
   dictionary key, and a mismatch fails silently and only for paying players.

3. **Offering** — one offering marked *current*, with a package per product.
   The paywall and `proPackages()` both read the current offering, which is what
   lets you change the offer without shipping a build.

4. **Paywall** — design it under Tools → Paywalls against that offering.
   `showPaywall()` presents whatever is configured there.

5. **Customer Center** — enable it under Tools. `showCustomerCenter()` opens
   it; it handles cancel, restore and refund requests without the game having
   to explain store policy.

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
import { isPro, subscribeToPro, showPaywallIfNeeded } from "./purchases";

// Gate a feature. `ready` matters: before the store answers, "not pro" is a
// guess, and locking a subscriber out of what they paid for is worse than
// briefly showing something you should not have.
const status = proStatus();
if (status.ready && !status.pro) lockArena();

// Keep a screen honest as renewals, lapses and restores arrive.
const stop = subscribeToPro((s) => arenaButton.classList.toggle("locked", !s.pro));

// Sell it. Does nothing to somebody who already owns it, so no isPro() check
// is needed around the call.
if (await showPaywallIfNeeded()) unlockArena();
```

Building a shop in the game's own UI instead of using the paywall:

```ts
import { proPackages, purchasePro } from "./purchases";

for (const pkg of await proPackages()) {
  // pkg.product.priceString is already localised — never format prices yourself.
  addRow(pkg.product.title, pkg.product.priceString, async () => {
    const outcome = await purchasePro(pkg);
    if (outcome.ok) return celebrate();
    // Cancellation is not failure. An error toast after somebody deliberately
    // backed out reads as the app arguing with them.
    if (!outcome.cancelled) showError(outcome.message);
  });
}
```

Both stores require a restore path, and a player who reinstalls has no other
way back to what they paid for:

```ts
import { restorePro, showCustomerCenter } from "./purchases";

restoreButton.onclick = () => restorePro();
manageButton.onclick = () => showCustomerCenter();   // cancel, refund, restore
```

## Off-device

`purchasesAvailable()` is false in a browser, so the dev server, the hosted
build and every harness in `scripts/` run with no store: `initPurchases()`
settles immediately on "ready, not pro", purchase calls return a failure with a
readable message, and the paywall calls no-op. Nothing has to be stubbed to run
the game outside the app.

## Testing a purchase

The Test Store key works without Play at all — useful before products are live.
For real sandbox purchases:

1. Add your Google account to **License testers** in Play Console.
2. Install a build signed with the upload key (`bundleRelease`/`assembleRelease`),
   from an internal testing track. Sideloaded debug builds cannot buy anything.
3. Purchases are free and renew in minutes rather than months.

## Before release

- `VITE_REVENUECAT_KEY` set to the `goog_…` key, not the test one.
- All three products active in Play Console, not just in RevenueCat.
- Restore path reachable without buying anything first — Apple rejects for this,
  and Play expects it.
- A purchase and a restore tried on a real device, on a release-signed build.
