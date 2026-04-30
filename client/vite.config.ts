import react from "@vitejs/plugin-react";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const apiPort = process.env.PORT || "3001";
const apiTarget = process.env.VITE_API_PROXY_TARGET || `http://localhost:${apiPort}`;

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/invest/" : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
});
