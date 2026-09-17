/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute WebSocket URL of the match relay, e.g.
   * wss://teqopen-relay-xxxxx.europe-west9.run.app
   *
   * Required for any build not served by the local dev server: a hosted build
   * and a packaged app cannot derive it from their own origin.
   */
  readonly VITE_RELAY_URL?: string;
  /**
   * RevenueCat's public SDK key for this platform.
   *
   * Public keys are meant to ship inside the app, so this is not a secret — but
   * it is per-store and per-project, and the default baked into
   * `src/purchases.ts` is a Test Store key. A Play release needs the `goog_…`
   * one, which is what this overrides.
   */
  readonly VITE_REVENUECAT_KEY?: string;
  /**
   * Whether this build's assets were encrypted by
   * `scripts/protect-assets.mjs`. "1" means every loader must decrypt; the dev
   * server serves `assets/` plain and leaves this unset.
   */
  readonly VITE_PROTECTED_ASSETS?: string;
  /**
   * The key the assets were encrypted with.
   *
   * It ships inside the bundle — the game has to read its own assets offline —
   * so it raises the bar rather than being a secret. **No default:** the one
   * that used to live here was the passphrase every shipped build really used,
   * because nothing ever set this variable, and it was written in a repository
   * about to be made public. Both halves now refuse to run without it.
   */
  readonly VITE_ASSET_KEY?: string;
  /**
   * "1" builds the production bundle with its internals still reachable from
   * `window` (`__teq`, `__teqUi`, `__viewer`, `__swap`) and the F2 free camera
   * still listening, for the browser harnesses in `scripts/`. A release must
   * never set it: those handles can write to a live match.
   *
   * `npm run build:harness`.
   */
  readonly VITE_HARNESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
