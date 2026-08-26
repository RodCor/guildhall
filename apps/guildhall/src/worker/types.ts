import type { MissionCoordinator } from "./durable/MissionCoordinator.js";

export interface GuildhallEnv {
  ASSETS: Fetcher;
  GUILD_DB: D1Database;
  MISSIONS: DurableObjectNamespace<MissionCoordinator>;
}
