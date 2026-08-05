import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY_PORT, looksReachable, resolveRelayUrl } from "../src/net/endpoint";

const page = (protocol: string, hostname: string) => ({ protocol, hostname });

describe("resolveRelayUrl", () => {
  it("uses a configured URL verbatim", () => {
    const url = "wss://teqopen-relay-abc123.europe-west1.run.app";
    expect(resolveRelayUrl(url, page("https:", "teqopen.web.app"))).toBe(url);
  });

  it("ignores a blank or whitespace-only setting", () => {
    expect(resolveRelayUrl("", page("http:", "192.168.1.5"))).toBe(
      `ws://192.168.1.5:${DEFAULT_RELAY_PORT}`
    );
    expect(resolveRelayUrl("   ", page("http:", "192.168.1.5"))).toBe(
      `ws://192.168.1.5:${DEFAULT_RELAY_PORT}`
    );
    expect(resolveRelayUrl(undefined, page("http:", "192.168.1.5"))).toBe(
      `ws://192.168.1.5:${DEFAULT_RELAY_PORT}`
    );
  });

  it("reuses the dev-server host for local development", () => {
    // `npm run dev:lan` on a laptop, phone on the same Wi-Fi: the relay is on
    // the same machine as the page.
    expect(resolveRelayUrl(undefined, page("http:", "192.168.1.5"))).toBe("ws://192.168.1.5:8787");
    expect(resolveRelayUrl(undefined, page("http:", "localhost"))).toBe("ws://localhost:8787");
  });

  it("never downgrades a secure page to an insecure socket", () => {
    // Browsers block mixed content, and the app's release network policy
    // refuses cleartext, so a https page must produce wss.
    expect(resolveRelayUrl(undefined, page("https:", "example.com"))).toMatch(/^wss:/);
    expect(resolveRelayUrl(undefined, page("http:", "example.com"))).toMatch(/^ws:/);
  });
});

describe("looksReachable", () => {
  it("accepts anything in a browser, including localhost during development", () => {
    expect(looksReachable("ws://localhost:8787", false)).toBe(true);
    expect(looksReachable("wss://relay.example.com", false)).toBe(true);
  });

  it("rejects a packaged app pointed at itself", () => {
    // A Capacitor build serves from https://localhost, so a derived URL points
    // at the phone. That is a build missing VITE_RELAY_URL, not a live relay.
    expect(looksReachable("wss://localhost:8787", true)).toBe(false);
    expect(looksReachable("ws://127.0.0.1:8787", true)).toBe(false);
    expect(looksReachable("ws://[::1]:8787", true)).toBe(false);
  });

  it("accepts a properly configured packaged app", () => {
    expect(looksReachable("wss://teqopen-relay-abc.run.app", true)).toBe(true);
    expect(looksReachable("ws://192.168.1.5:8787", true)).toBe(true);
  });

  it("does not mistake a hostname that merely contains localhost", () => {
    expect(looksReachable("wss://localhost.example.com", true)).toBe(true);
    expect(looksReachable("wss://notlocalhost", true)).toBe(true);
  });
});
