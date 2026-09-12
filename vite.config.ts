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
  build: {
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
