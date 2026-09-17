/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
  // Serve the existing repo asset folder as static files: /models/..., /audio/...
  publicDir: "assets",
  // Babylon lazily imports shader/loader modules at runtime; letting the dep
  // optimizer bundle them causes mid-session re-optimisation and stale-hash
  // "file does not exist in the optimize deps directory" errors on reload.
  optimizeDeps: {
    exclude: ["@babylonjs/core", "@babylonjs/loaders"],
  },
  server: {
    host: true,
  },
  // What a release hands to anyone who opens the bundle.
  //
  // esbuild already mangles locals and drops types; these three take away what
  // it leaves behind. The console calls are the interesting one: several of
  // them name internal state as they report it, and a packaged app has nobody
  // reading them anyway — the one place a shipped build has to speak up is the
  // startup reporter in index.html, which is a separate classic script.
  //
  // Not dropped for `build:harness`: the browser harnesses watch the page's
  // console for errors, and a build that cannot report one is a build they
  // cannot fail against.
  esbuild: {
    drop: process.env.VITE_HARNESS === "1" ? ["debugger"] : ["console", "debugger"],
    legalComments: "none",
  },
  build: {
    // No source maps in any build: a map hands back the original TypeScript,
    // file names and comments included, which is the whole of the client.
    sourcemap: false,
    // Vite defaults to Chrome 87+. The System WebView on a budget Android can
    // be years behind that, and syntax it cannot parse is not a graceful
    // degradation — it is a black screen before a single line of the game runs.
    // es2019 covers Chrome 73+, and costs nothing measurable here.
    target: "es2019",
    // The Babylon vendor chunk is legitimately ~1.9 MB. Warn on anything that
    // grows past it so a genuine regression in the app chunk is still visible.
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        // Split Babylon out of the app chunk so a game-code deploy does not
        // invalidate the ~1.9 MB engine the browser already has cached.
        //
        // Only the part of Babylon the app pulls in *statically* may move: the
        // engine reaches its shaders and texture loaders through dynamic
        // imports, and Rollup already emits those as small on-demand chunks.
        // Forcing a lazily-reached module into the eager vendor chunk would
        // grow the first load instead of shrinking it, so a module qualifies
        // only when a static import chain runs from app code down to it.
        manualChunks(id, { getModuleInfo }) {
          if (!id.includes("node_modules/@babylonjs/")) return;

          const seen = new Map<string, boolean>();
          const staticallyReachedByApp = (module: string): boolean => {
            const cached = seen.get(module);
            if (cached !== undefined) return cached;
            seen.set(module, false); // breaks import cycles
            const importers = getModuleInfo(module)?.importers ?? [];
            const eager = importers.some(
              (importer) =>
                !importer.includes("node_modules") || staticallyReachedByApp(importer)
            );
            seen.set(module, eager);
            return eager;
          };

          return staticallyReachedByApp(id) ? "babylon" : undefined;
        },
      },
    },
  },
});
