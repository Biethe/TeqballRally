import { defineConfig } from "vitest/config";

// The unit tests cover the pure gameplay maths (ball physics, clip timing,
// character traits, AI presets). They import from src/ directly and need no
// browser: anything touching a Babylon scene, canvas or the DOM is exercised by
// the Playwright helpers in scripts/ instead.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      // `src/protected.ts` reads its passphrase from the bundle at build time
      // and has no fallback, because a fallback is the value a release
      // actually ships with. The cross-boundary round trip in
      // `tests/protected.test.ts` — Node encrypts, WebCrypto decrypts — needs
      // the game half to hold the same passphrase the test half passes in, so
      // it is supplied here rather than defaulted in the source.
      VITE_ASSET_KEY: "a-passphrase-for-the-tests",
    },
  },
});
