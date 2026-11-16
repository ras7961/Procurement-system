import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The in-memory MongoDB may need to download a binary on first use.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
