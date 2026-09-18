import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The benchmark server holds the provider credentials; the browser only
    // ever talks to this proxy, never to a provider directly.
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Three.js is most of the bundle and changes far less often than the
        // application, so it gets its own chunk.
        manualChunks: { three: ["three"], react: ["react", "react-dom", "react-router-dom"] },
      },
    },
  },
});
