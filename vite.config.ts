import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Online play runs in the Worker, under `npm run dev:online`; the rest of the API in Node.
      "/api/online": { target: "http://localhost:8788", changeOrigin: true, ws: true },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { three: ["three"], react: ["react", "react-dom", "react-router-dom"] },
      },
    },
  },
});
