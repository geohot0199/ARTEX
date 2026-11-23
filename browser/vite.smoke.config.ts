import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds scripts/smoke.ts (and the views it imports) for Node, so the render smoke test
// can run without a browser. Not part of the shipped app.
export default defineConfig({
  plugins: [react()],
  build: {
    ssr: "scripts/smoke.ts",
    outDir: ".smoke",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
  },
});
