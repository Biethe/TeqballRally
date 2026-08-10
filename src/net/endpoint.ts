/**
 * Where the match relay lives.
 *
 * This cannot always be derived from the page. A packaged Capacitor app serves
 * itself from `https://localhost`, so a same-origin guess would point the game
 * at the phone itself. Hosted and packaged builds therefore have to be told,
 * at build time, via `VITE_RELAY_URL`.
 *
 * The derivation exists only for local development, where the relay runs on
 * the same machine as the dev server and a phone on the same Wi-Fi reaches
 * both at the same hostname.
 */

/** Port `npm run relay` listens on by default. */
export const DEFAULT_RELAY_PORT = 8787;

export interface PageLocation {
  /** "http:" or "https:" */
  protocol: string;
  hostname: string;
}

/**
 * Resolve the relay's WebSocket URL.
 *
 * A configured value always wins and is used verbatim, so a hosted build can
 * point anywhere. Otherwise the dev-server host is reused with the relay's
 * port — right for `npm run dev:lan`, and wrong (deliberately visibly so) for
 * a packaged build that forgot to set the variable.
 */
export function resolveRelayUrl(configured: string | undefined, page: PageLocation): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  // A page served over TLS may only open a secure socket; mixed content is
  // blocked by the browser and by the app's release network policy alike.
  const scheme = page.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${page.hostname}:${DEFAULT_RELAY_PORT}`;
}

/**
 * Whether this build can plausibly reach a relay. A packaged app pointed at
 * localhost is a build that forgot `VITE_RELAY_URL`, and online play should be
 * offered as unavailable rather than failing at the end of a lobby flow.
 */
export function looksReachable(url: string, isNativeApp: boolean): boolean {
  if (!isNativeApp) return true;
  return !/^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

/** The relay URL for the running build. */
export function relayUrl(): string {
  return resolveRelayUrl(import.meta.env.VITE_RELAY_URL, window.location);
}

/**
 * The accounts API's base URL, derived from the relay's.
 *
 * One address to configure, not two: the API is served by the same process on
 * the same port, so deriving it means a deployment cannot end up with a relay
 * and an API pointing at different places — which would show up as a player
 * whose trophies exist but whose opponent is a stranger.
 */
export function apiBase(url: string = relayUrl()): string {
  const http = url.replace(/^ws(s?):/i, "http$1:");
  return http.replace(/\/+$/, "");
}
