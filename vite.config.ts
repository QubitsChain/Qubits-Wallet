import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * `manifest.json` at the extension root points into `dist/`, so the `extension` folder itself can
 * be loaded with "Load unpacked". `dist/` gets its own copy with the prefix removed, for packaging.
 */
function distManifest(): Plugin {
  return {
    name: "dist-manifest",
    writeBundle(options) {
      const source = readFileSync(resolve(import.meta.dirname, "manifest.json"), "utf8");
      const out = resolve(options.dir ?? "dist", "manifest.json");
      writeFileSync(out, source.replaceAll('"dist/', '"'));
    },
  };
}

export default defineConfig({
  // Relative asset URLs work both from dist/popup.html (root manifest) and popup.html (dist manifest).
  base: "./",
  plugins: [tailwindcss(), distManifest()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        popup: "popup.html",
        background: "src/background.ts",
        bridge: "src/bridge.ts",
        provider: "src/provider.ts",
      },
      // the manifest names these three, and the two content scripts must be one file each
      output: {
        entryFileNames: (chunk) => (chunk.name === "popup" ? "assets/[name]-[hash].js" : "[name].js"),
      },
    },
  },
  test: {
    environment: "jsdom",
    // Argon2id with 64 MiB in WebAssembly takes a few seconds per key.
    testTimeout: 60_000,
  },
});
