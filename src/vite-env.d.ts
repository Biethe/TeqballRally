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
   * Whether this build's models were scrambled by
   * `scripts/protect-assets.mjs`. "1" means the loader must unscramble; the
   * dev server serves `assets/` plain and leaves this unset.
   */
  readonly VITE_PROTECTED_ASSETS?: string;
  /**
   * The key the models were scrambled with.
   *
   * It ships inside the bundle — the game has to read its own models offline —
   * so it is obfuscation rather than a secret. Setting it per release at least
   * means the value is not the one written in the repository.
   */
  readonly VITE_ASSET_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
