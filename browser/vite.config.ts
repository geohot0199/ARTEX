import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Browser edition: a fully static bundle. There is no backend process — the Go server
// of the main ARTEX install is not needed, so `vite build` output can be dropped on any
// static host (GitHub Pages, Netlify, S3, a USB stick opened through a local server…).
//
// BROWSER_BASE sets the public path for sub-directory hosting (e.g. GitHub Pages at
// /ARTEX/). Development and root hosting keep "/".
const base = process.env.BROWSER_BASE?.trim() || "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    // Sandbox / tunnel previews arrive with a different Host header; the app carries
    // no secrets and every route is client-side, so any preview origin is fine.
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
