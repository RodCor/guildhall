import type { D1Migration } from "@cloudflare/vitest-plugin";

import type { GuildhallEnv } from "../../apps/guildhall/src/worker/types";

declare global {
  namespace Cloudflare {
    interface Env extends GuildhallEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
