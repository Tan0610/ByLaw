/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Read VITE_* from the repo-root .env (one env file for the whole project).
  envDir: "../..",
  // The DAO page reads proposal templates from contracts/charter/dao-proposals (outside this package).
  server: { fs: { allow: ["../.."] } },
  build: { chunkSizeWarningLimit: 1800 },
  define: { global: "globalThis" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    env: { VITE_USE_MOCKS: "true" },
  },
});
