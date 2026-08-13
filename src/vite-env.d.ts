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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
