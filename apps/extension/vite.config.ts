import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

// CRXJS builds the MV3 bundle and provides HMR for the popup/options/content.
// Load the built extension unpacked from apps/extension/dist (see CLAUDE.md).
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
  },
});
