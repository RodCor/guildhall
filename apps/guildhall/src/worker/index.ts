import { isCoordinatorCommand } from "./durable/protocol.js";
import type { GuildhallEnv } from "./types.js";

export { MissionCoordinator } from "./durable/MissionCoordinator.js";
export type { GuildhallEnv as Env } from "./types.js";

const MISSION_ROUTE = /^\/api\/missions\/([^/]+)$/u;
const COMMAND_ROUTE = /^\/api\/missions\/([^/]+)\/commands$/u;
const STREAM_ROUTE = /^\/api\/missions\/([^/]+)\/stream$/u;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        service: "guildhall",
        status: "ok",
        protocolCore: "commitment/v1",
      });
    }

    const commandMatch = COMMAND_ROUTE.exec(url.pathname);
    if (commandMatch !== null && request.method === "POST") {
      const missionId = decodeURIComponent(commandMatch[1]!);
      const body = await readJson(request);
      if (!isCoordinatorCommand(body)) {
        return Response.json(
          {
            error: "INVALID_COMMAND",
            message: "Malformed coordinator command",
          },
          { status: 400 },
        );
      }
      const result =
        await env.MISSIONS.getByName(missionId).executeCommand(body);
      const status = result.ok
        ? 200
        : result.code === "COMMAND_ID_REUSED" ||
            result.code === "EXPECTED_SEQUENCE_MISMATCH"
          ? 409
          : 422;
      return Response.json(result, { status });
    }

    const streamMatch = STREAM_ROUTE.exec(url.pathname);
    if (streamMatch !== null && request.method === "GET") {
      const missionId = decodeURIComponent(streamMatch[1]!);
      return env.MISSIONS.getByName(missionId).fetch(request);
    }

    const missionMatch = MISSION_ROUTE.exec(url.pathname);
    if (missionMatch !== null) {
      const missionId = decodeURIComponent(missionMatch[1]!);
      const coordinator = env.MISSIONS.getByName(missionId);
      if (request.method === "POST") {
        const body = await readJson(request);
        if (
          !isRecord(body) ||
          typeof body.requesterAgentId !== "string" ||
          body.requesterAgentId.length === 0
        ) {
          return Response.json(
            {
              error: "INVALID_MISSION",
              message: "requesterAgentId is required",
            },
            { status: 400 },
          );
        }
        return Response.json(
          await coordinator.initializeMission(missionId, body.requesterAgentId),
          { status: 201 },
        );
      }
      if (request.method === "GET") {
        const after = Number(url.searchParams.get("after") ?? 0);
        try {
          return Response.json(await coordinator.getSnapshot(after));
        } catch (error) {
          return Response.json(
            {
              error: "MISSION_NOT_FOUND",
              message: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 404 },
          );
        }
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<GuildhallEnv>;

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
