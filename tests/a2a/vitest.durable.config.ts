import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const wranglerConfig = fileURLToPath(
  new URL("../../apps/demo-agent/wrangler.scout.jsonc", import.meta.url),
);

export default defineConfig({
  plugins: [
    cloudflareTest(() => ({
      wrangler: { configPath: wranglerConfig },
    })),
  ],
  test: {
    fileParallelism: false,
    include: [
      `${projectRoot.replaceAll("\\", "/")}/tests/a2a/durable-task-store.worker.ts`,
    ],
    testTimeout: 30_000,
  },
});
