import type { MissionCoordinator } from "./durable/MissionCoordinator.js";

export interface GuildhallEnv {
  ASSETS: Fetcher;
  GUILD_DB: D1Database;
  MISSIONS: DurableObjectNamespace<MissionCoordinator>;
  PUBLIC_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_OAUTH_BASE_URL?: string;
  GITHUB_API_BASE_URL?: string;
  AUTH_COOKIE_SECRET: string;
}
