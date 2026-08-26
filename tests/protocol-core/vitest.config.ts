import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const wranglerConfig = fileURLToPath(
  new URL("../../apps/guildhall/wrangler.jsonc", import.meta.url),
);
const migrationsPath = fileURLToPath(
  new URL("../../migrations/d1", import.meta.url),
);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: wranglerConfig },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
          PUBLIC_ORIGIN: "https://guildhall.test",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-only-placeholder",
          GITHUB_OAUTH_BASE_URL: "https://github.test",
          GITHUB_API_BASE_URL: "https://api.github.test",
          AUTH_COOKIE_SECRET:
            "test-only-cookie-secret-with-at-least-thirty-two-characters",
        },
      },
    })),
  ],
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
    include: [
      `${projectRoot.replaceAll("\\", "/")}/tests/protocol-core/**/*.test.ts`,
    ],
    setupFiles: [
      fileURLToPath(new URL("./apply-migrations.ts", import.meta.url)),
    ],
  },
});
