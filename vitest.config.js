import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      "open-sse": path.join(root, "open-sse"),
    },
  },
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["tests/translator/real/**", "tests/unit/*.live.test.js"],
    environment: "node",
    testTimeout: 10000,
    hookTimeout: 10000,
    isolate: true,
    reporters: ["default"],
  },
});
