import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Single-source the dashboard version from the package manifest, so the sidebar never hardcodes a version
// that drifts from what is published. Read at config time and inlined via `define` (compile-time constant).
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as { version: string };

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), tailwindcss()],
  define: {
    // biome-ignore lint/style/useNamingConvention: the `__NAME__` form is the established Vite convention for a compile-time injected global.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: resolve(__dirname, "../../../dist/dashboard"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3847",
        changeOrigin: true,
      },
    },
  },
});
