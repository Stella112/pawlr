import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Real EIP-3009 signing and in-memory x402 round trips can exceed 5 s on a busy machine.
    testTimeout: 20_000,
    // Live testnet/integration runs are opt-in, never part of the default run.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
