import { defineConfig } from "vitest/config";

// The unit tests cover the pure gameplay maths (ball physics, clip timing,
// character traits, AI presets). They import from src/ directly and need no
// browser: anything touching a Babylon scene, canvas or the DOM is exercised by
// the Playwright helpers in scripts/ instead.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
