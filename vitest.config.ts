import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Live testnet/integration runs are opt-in, never part of the default run.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
