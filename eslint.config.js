import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // server/rules.mjs is generated (scripts/build-rules.mjs) and bundles more
    // of config.ts than the server reads — linting a bundle tells you about
    // the bundler, not the code.
    ignores: [
      "dist/**",
      "node_modules/**",
      ".firebase/**",
      "assets/**",
      "server/rules.mjs",
    ],
  },

  // Game and test sources: TypeScript, type-aware rules on.
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "*.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_unused` is the project's opt-out for a parameter it has to declare.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // `no-console` stays off on purpose: the console is a documented part of
      // the tuning workflow (see TUNING.md — the F2 free camera prints the
      // placement to copy back into code) and of the gamepad diagnostics.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // Browser sources run against the DOM and the game canvas.
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Test sources run in Node.
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Vite/Vitest config files run in Node.
  {
    files: ["*.config.ts", "*.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Node-side ESM with no type information: the Playwright dev helpers and the
  // relay server.
  {
    files: ["scripts/**/*.mjs", "server/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  }
);
