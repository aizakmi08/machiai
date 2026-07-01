import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  root: resolve(here, "src/renderer"),
  build: {
    emptyOutDir: true,
    outDir: resolve(here, "../../dist/apps/overlay/renderer"),
  },
});
