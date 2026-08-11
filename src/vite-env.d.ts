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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
