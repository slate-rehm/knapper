import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Every test runs against fixtures and mocks; none require a live Obsidian, so
    // the suite is safe in CI.
    testTimeout: 10_000,
  },
});
