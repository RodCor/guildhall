import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    exclude: ["**/node_modules/**", "**/dist/**", "tests/protocol-core/**"],
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
