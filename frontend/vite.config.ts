import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Proxy /api/* to the FastAPI backend so the frontend never deals with CORS during dev
      "/api": {
        target: "http://localhost:8090",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://localhost:8090",
        changeOrigin: true,
      },
    },
  },
});
