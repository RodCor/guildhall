import type { Mission } from "@guildhall/contracts";

import { authorizeAgentAction } from "./auth/agentAuthorization.js";
import type { MissionSnapshotPacket } from "./durable/protocol.js";
import { markReferenceMission } from "./repositories/missionCatalog.js";
import type { GuildhallEnv } from "./types.js";

const MAX_RALLY_ROUNDS = 4;
const AGENT_PULSE_TIMEOUT_MS = 12_000;
const REFERENCE_DEMO_TITLES = new Set([
  "audit and repair an inaccessible public webpage",
  "map and remediate the accessibility dungeon",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface RallyRequest {
  readonly missionId: string;
  readonly requesterAgentId: string;
  readonly commandId?: string;
}

interface RallyPacket extends MissionSnapshotPacket {
  readonly definition?: Mission | null;
}

export async function handleDemoRallyRoute(
  request: Request,
  env: GuildhallEnv,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/demo/rally") return null;
  if (request.method !== "POST") {
    return noStoreJson({ error: "METHOD_NOT_ALLOWED" }, 405, {
      Allow: "POST",
    });
  }
  const bodyText = await request.text();
  if (bodyText.length > 8_192) {
    return noStoreJson(
      { error: "INVALID_RALLY", message: "Rally request is too large." },
      400,
    );
  }
  const body = parseRallyRequest(bodyText);
  if (body === null) {
    return noStoreJson(
      { error: "INVALID_RALLY", message: "Rally request is invalid." },
      400,
    );
  }
  const authorization = await authorizeAgentAction(request, env, {
    agentId: body.requesterAgentId,
    bodyText,
    requiredScope: "missions:write",
  });
  if (!authorization.ok) return authorization.response;

  const coordinator = env.MISSIONS.getByName(body.missionId);
  let packet: RallyPacket;
  try {
    packet = await coordinator.getSnapshot();
  } catch {
    return noStoreJson(
      { error: "MISSION_NOT_FOUND", message: "Mission is not initialized." },
      404,
    );
  }
  if (packet.definition?.requesterAgentId !== authorization.agentId) {
    return noStoreJson(
      {
        error: "RALLY_NOT_AUTHORIZED",
        message: "Only the requester may rally this party.",
      },
      403,
    );
  }
  if (
    !REFERENCE_DEMO_TITLES.has(packet.definition.title.trim().toLowerCase())
  ) {
    return noStoreJson(
      {
        error: "RALLY_NOT_REFERENCE_MISSION",
        message: "The reference party only accepts the guided demo mission.",
      },
      422,
    );
  }
  const catalogMarked = await markReferenceMission(
    env.GUILD_DB,
    body.missionId,
  );
  const secret = env.GUILD_DEMO_RALLY_SECRET;
  const agents = referenceAgentOrigins(env);
  if (secret === undefined || secret.length < 32 || agents === null) {
    return noStoreJson(
      {
        error: "RALLY_NOT_READY",
        message: "The reference party is not ready.",
      },
      503,
    );
  }

  const rallies: Array<Record<string, unknown>> = [];
  for (let round = 1; round <= MAX_RALLY_ROUNDS; round += 1) {
    let advanced = false;
    for (const [agent, origin] of agents) {
      const result = await pulseAgent(
        fetchImpl,
        origin,
        secret,
        body.missionId,
      );
      rallies.push({ round, agent, ...result.publicResult });
      if (result.advanced) advanced = true;
    }
    packet = await coordinator.getSnapshot();
    if (
      packet.snapshot.stage !== "RESERVE" &&
      packet.snapshot.stage !== "COMMIT"
    ) {
      break;
    }
    if (!advanced) break;
  }

  const event = packet.events.at(-1) ?? {};
  const candidate = packet.snapshot.candidatePact;
  console.info(
    JSON.stringify({
      missionId: body.missionId,
      rallies,
      catalogMarked,
      message: "reference party rally completed",
    }),
  );
  return noStoreJson({
    missionId: body.missionId,
    sequence: packet.latestSequence,
    missionVersion: packet.snapshot.missionVersion,
    pactVersion: candidate?.pact.pactVersion ?? null,
    displayState:
      "displayState" in event && typeof event.displayState === "string"
        ? event.displayState
        : "Unknown",
    event,
    result: {
      commandId: body.commandId ?? null,
      rallies,
      boundedRounds: MAX_RALLY_ROUNDS,
      coordination: "independent-signed-a2a",
      catalog: catalogMarked ? "reference" : "projection-pending",
    },
    replayed: false,
    catalogPending: false,
  });
}

async function pulseAgent(
  fetchImpl: typeof globalThis.fetch,
  origin: URL,
  secret: string,
  missionId: string,
): Promise<{
  readonly advanced: boolean;
  readonly publicResult: Record<string, unknown>;
}> {
  try {
    const response = await fetchImpl(
      new URL("/internal/guildhall/rally", origin),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `GuildhallRally ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ missionId }),
        redirect: "manual",
        signal: AbortSignal.timeout(AGENT_PULSE_TIMEOUT_MS),
      },
    );
    const value: unknown = await response.json();
    const recordValue = isRecord(value) ? value : {};
    const recruitment = isRecord(recordValue.result)
      ? recordValue.result
      : null;
    return {
      advanced: response.ok && recruitment?.joined === true,
      publicResult: response.ok
        ? {
            status: "answered",
            joined: recruitment?.joined === true,
            action:
              typeof recruitment?.action === "string"
                ? recruitment.action
                : null,
            reason:
              typeof recruitment?.reason === "string"
                ? recruitment.reason
                : null,
          }
        : { status: "unavailable", httpStatus: response.status },
    };
  } catch {
    return {
      advanced: false,
      publicResult: { status: "unavailable" },
    };
  }
}

function referenceAgentOrigins(
  env: GuildhallEnv,
): readonly (readonly ["scout" | "scribe", URL])[] | null {
  try {
    if (env.SCOUT_A2A_URL === undefined || env.SCRIBE_A2A_URL === undefined) {
      return null;
    }
    const scout = strictHttpsOrigin(env.SCOUT_A2A_URL);
    const scribe = strictHttpsOrigin(env.SCRIBE_A2A_URL);
    return [
      ["scout", scout],
      ["scribe", scribe],
    ];
  } catch {
    return null;
  }
}

function strictHttpsOrigin(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("Agent endpoint must use credential-free HTTPS.");
  }
  return new URL(parsed.origin);
}

function parseRallyRequest(bodyText: string): RallyRequest | null {
  try {
    const value: unknown = JSON.parse(bodyText);
    if (
      !isRecord(value) ||
      typeof value.missionId !== "string" ||
      !UUID_PATTERN.test(value.missionId) ||
      typeof value.requesterAgentId !== "string" ||
      !UUID_PATTERN.test(value.requesterAgentId) ||
      (value.commandId !== undefined &&
        (typeof value.commandId !== "string" ||
          !UUID_PATTERN.test(value.commandId)))
    ) {
      return null;
    }
    return {
      missionId: value.missionId,
      requesterAgentId: value.requesterAgentId,
      ...(value.commandId === undefined ? {} : { commandId: value.commandId }),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noStoreJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
}
