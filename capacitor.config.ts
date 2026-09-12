import type { CapacitorConfig } from "@capacitor/cli";

/**
 * IMPORTANT — `appId` is permanent.
 *
 * It is the Android package name and the identity Google Play uses. Once an
 * app is uploaded under an appId it can never be changed, and a different
 * appId is a *different app* with a different listing and no shared installs.
 * If a Play Console entry or an installed APK already exists, set this to that
 * app's existing id before building anything.
 */
const config: CapacitorConfig = {
  appId: "com.biethe.teqopen",
  appName: "TeqRallly",
  // Vite's build output. `npx cap sync` copies this into the native project,
  // so `npm run build` has to run first.
  webDir: "dist",
  android: {
    // The game is its own world: a bouncing overscroll at the edge of a canvas
    // reads as a bug.
    allowMixedContent: false,
  },
  server: {
    // Must be https for a packaged/production build: a packaged app's origin
    // is https://localhost, and a secure origin is required to open the secure
    // (wss://) relay.
    //
    // The exception is a build aimed at a relay running on the development
    // machine, which speaks plain `ws://`. A page on https may not open an
    // insecure socket at all — the WebSocket constructor throws before any
    // connection is attempted — so that build has to be served from http, and
    // `CAP_ANDROID_SCHEME=http npm run android:apk` is how to ask for it.
    // `http://localhost` is still a secure context in Chromium, so nothing
    // that needs one (`crypto.subtle` in `src/protected.ts`) stops working.
    // It is a different origin, though, so such a build starts with empty
    // local storage.
    androidScheme: process.env.CAP_ANDROID_SCHEME === "http" ? "http" : "https",
    // To iterate against a dev server instead of a bundled build, run
    //   npm run dev -- --host
    // and set CAP_SERVER_URL to the printed LAN address before `npx cap sync`.
    // Leave it unset for a real, self-contained build.
    ...(process.env.CAP_SERVER_URL
      ? { url: process.env.CAP_SERVER_URL, cleartext: true }
      : {}),
  },
};

export default config;
