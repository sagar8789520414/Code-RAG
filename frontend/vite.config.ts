import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In dev the API runs on :8080; leave VITE_API_URL empty to go through this proxy.
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: true } },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
