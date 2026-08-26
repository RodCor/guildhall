import { scanPublicPayload } from "@guildhall/trust-engine";
import {
  PactAcceptanceSchema,
  canonicalJsonDigest,
  pactMatchesMission,
  pactSigningBytes,
  type Mission,
  verifyRegisteredEd25519Proof,
} from "@guildhall/contracts";
import type {
  LifecycleCommand,
  LifecycleState,
} from "@guildhall/mission-engine";

import {
  isCoordinatorCommand,
  type MissionSnapshotPacket,
} from "./durable/protocol.js";
import { handleAgentRoute } from "./auth/agentRoutes.js";
import { authorizeAgentAction } from "./auth/agentAuthorization.js";
import { handleOAuthRoute } from "./auth/oauth.js";
import { handleSessionRoute } from "./auth/session.js";
import { getAutonomyPolicy, listAgentKeys } from "./repositories/index.js";
import { handlePublicApiRoute } from "./publicApi.js";
import { handleGuildBrokerRoute } from "./a2a/guildBroker.js";
import type { GuildhallEnv } from "./types.js";

export { MissionCoordinator } from "./durable/MissionCoordinator.js";
export type { GuildhallEnv as Env } from "./types.js";

const MISSION_ROUTE = /^\/api\/missions\/([^/]+)$/u;
const COMMAND_ROUTE = /^\/api\/missions\/([^/]+)\/commands$/u;
const WEBMCP_COMMAND_ROUTE = /^\/api\/webmcp\/missions\/([^/]+)\/commands$/u;
const STREAM_ROUTE = /^\/api\/missions\/([^/]+)\/stream$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

    const oauthResponse = await handleOAuthRoute(request, env);
    if (oauthResponse !== null) return oauthResponse;
    const sessionResponse = await handleSessionRoute(request, env);
    if (sessionResponse !== null) return sessionResponse;
    const guildBrokerResponse = await handleGuildBrokerRoute(request, env);
    if (guildBrokerResponse !== null) return guildBrokerResponse;
    const publicApiResponse = await handlePublicApiRoute(request, env);
    if (publicApiResponse !== null) return publicApiResponse;
    const agentResponse = await handleAgentRoute(request, env);
    if (agentResponse !== null) return agentResponse;

    const webMcpCommandMatch = WEBMCP_COMMAND_ROUTE.exec(url.pathname);
    const commandMatch = webMcpCommandMatch ?? COMMAND_ROUTE.exec(url.pathname);
    if (commandMatch !== null && request.method === "POST") {
      const missionId = decodeURIComponent(commandMatch[1]!);
      if (!UUID_PATTERN.test(missionId)) {
        return Response.json(
          {
            error: "INVALID_MISSION",
            message: "Mission identifier is invalid",
          },
          { status: 400 },
        );
      }
      const bodyText = await request.text();
      const body = parseJson(bodyText);
      if (!isCoordinatorCommand(body) || body.actor === null) {
        return Response.json(
          {
            error: "INVALID_COMMAND",
            message: "Malformed coordinator command",
          },
          { status: 400 },
        );
      }
      if (
        !UUID_PATTERN.test(body.commandId) ||
        body.expectedSequence === undefined
      ) {
        return Response.json(
          {
            error: "INVALID_COMMAND",
            message: "External commands require a UUID and expected sequence",
          },
          { status: 400 },
        );
      }
      const publicScan = scanPublicPayload({
        commandId: body.commandId,
        command:
          body.command.type === "accept_pact"
            ? { ...body.command, signature: "[public-ed25519-signature]" }
            : body.command,
      });
      if (!publicScan.safe) {
        return Response.json(
          {
            error: "PUBLIC_SAFETY_REJECTED",
            message: "The public command did not pass the safety boundary",
          },
          { status: 422 },
        );
      }
      const authorization = await authorizeAgentAction(request, env, {
        agentId: body.actor.agentId,
        bodyText,
        requiredScope: "missions:write",
      });
      if (!authorization.ok) return authorization.response;
      const acceptedAt = new Date().toISOString();
      if (body.command.type === "accept_pact") {
        const suppliedAcceptedAt = Date.parse(body.command.acceptedAt);
        const key = (
          await listAgentKeys(env.GUILD_DB, authorization.agentId)
        ).find(
          (candidate) =>
            candidate.keyId === authorization.keyId &&
            candidate.status === "active",
        );
        const proof =
          key === undefined ||
          body.command.keyId !== authorization.keyId ||
          body.command.agentId !== authorization.agentId ||
          !Number.isFinite(suppliedAcceptedAt) ||
          Math.abs(Date.now() - suppliedAcceptedAt) > 5 * 60 * 1_000
            ? null
            : await verifyRegisteredEd25519Proof({
                key: {
                  keyId: key.keyId,
                  publicJwk: key.publicJwk,
                  status: "active",
                },
                proof: {
                  keyId: body.command.keyId,
                  signature: body.command.signature,
                },
                message: pactSigningBytes(body.command.pactDigest),
                policy: { kind: "new-proof" },
              });
        if (proof?.valid !== true) {
          return Response.json(
            {
              error: "PACT_PROOF_NOT_AUTHORIZED",
              message: "Pact acceptance proof failed",
            },
            { status: 403 },
          );
        }
        if (
          !PactAcceptanceSchema.safeParse({
            protocol: "commitment/v1",
            kind: "acceptance",
            acceptanceId: body.command.acceptanceId,
            missionId,
            pactVersion: body.command.pactVersion,
            agentId: authorization.agentId,
            keyId: authorization.keyId,
            pactDigest: body.command.pactDigest,
            signature: body.command.signature,
            acceptedAt,
          }).success
        ) {
          return Response.json(
            { error: "INVALID_COMMAND", message: "Pact proof is malformed" },
            { status: 400 },
          );
        }
      }
      let snapshot: MissionSnapshotPacket & {
        readonly definition?: Mission | null;
      };
      try {
        snapshot = await (
          env.MISSIONS.getByName(missionId) as unknown as {
            getSnapshot(
              afterSequence?: number,
            ): Promise<
              MissionSnapshotPacket & { readonly definition?: Mission | null }
            >;
          }
        ).getSnapshot();
      } catch {
        return Response.json(
          { error: "MISSION_NOT_FOUND", message: "Mission is not initialized" },
          { status: 404 },
        );
      }
      if (
        body.expectedSequence !== snapshot.latestSequence ||
        !isExternalCommandAuthorized(
          snapshot.snapshot,
          body.command,
          authorization.agentId,
        )
      ) {
        return Response.json(
          {
            error: "COMMAND_NOT_AUTHORIZED",
            message: "Command authorization failed",
          },
          { status: 403 },
        );
      }
      if (
        body.command.type === "apply" &&
        (snapshot.definition === null ||
          snapshot.definition === undefined ||
          Date.now() >= Date.parse(snapshot.definition.formationDeadline))
      ) {
        return Response.json(
          {
            error: "FORMATION_CLOSED",
            message: "The formation deadline has passed",
          },
          { status: 409 },
        );
      }
      if (
        body.command.type === "submit_proposal" ||
        body.command.type === "submit_assignment_proposal"
      ) {
        const definition = snapshot.definition;
        if (
          definition === null ||
          definition === undefined ||
          !pactMatchesMission(body.command.pact, definition) ||
          (await canonicalJsonDigest(body.command.pact)) !==
            body.command.pactDigest
        ) {
          return Response.json(
            {
              error: "PACT_DIGEST_MISMATCH",
              message: "The proposal does not match its canonical mission pact",
            },
            { status: 422 },
          );
        }
      }
      if (
        body.command.type === "publish" &&
        authorization.kind === "guild-node"
      ) {
        const policy = await getAutonomyPolicy(
          env.GUILD_DB,
          authorization.credential.ownerId,
          authorization.agentId,
        );
        if (policy?.enabled !== true) {
          return Response.json(
            {
              error: "AUTONOMY_DISABLED",
              message: "Public publication needs owner consent",
            },
            { status: 403 },
          );
        }
      }
      const authenticatedCommand = {
        ...body,
        actor: {
          agentId: authorization.agentId,
          ownerId:
            authorization.kind === "owner"
              ? `github:${authorization.owner.principal.githubUserId}`
              : authorization.credential.publicOwnerId,
          keyId: authorization.keyId,
        },
        source:
          webMcpCommandMatch !== null
            ? ("webmcp" as const)
            : authorization.kind === "guild-node"
              ? ("mcp" as const)
              : ("http" as const),
        command:
          body.command.type === "accept_pact"
            ? { ...body.command, acceptedAt }
            : body.command.type === "apply"
              ? {
                  ...body.command,
                  agentId: authorization.agentId,
                  keyId: authorization.keyId,
                }
              : body.command.type === "submit_capability_bid"
                ? {
                    ...body.command,
                    agentId: authorization.agentId,
                    keyId: authorization.keyId,
                  }
                : body.command.type === "submit_assignment_proposal"
                  ? {
                      ...body.command,
                      proposerAgentId: authorization.agentId,
                      keyId: authorization.keyId,
                    }
                  : body.command,
      };
      const result =
        await env.MISSIONS.getByName(missionId).executeCommand(
          authenticatedCommand,
        );
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
      if (!UUID_PATTERN.test(missionId)) {
        return Response.json({ error: "MISSION_NOT_FOUND" }, { status: 404 });
      }
      return env.MISSIONS.getByName(missionId).fetch(request);
    }

    const missionMatch = MISSION_ROUTE.exec(url.pathname);
    if (missionMatch !== null) {
      const missionId = decodeURIComponent(missionMatch[1]!);
      if (!UUID_PATTERN.test(missionId)) {
        return Response.json({ error: "MISSION_NOT_FOUND" }, { status: 404 });
      }
      const coordinator = env.MISSIONS.getByName(missionId);
      if (request.method === "POST") {
        const bodyText = await request.text();
        const body = parseJson(bodyText);
        if (
          !isRecord(body) ||
          typeof body.requesterAgentId !== "string" ||
          !UUID_PATTERN.test(body.requesterAgentId)
        ) {
          return Response.json(
            {
              error: "INVALID_MISSION",
              message: "requesterAgentId is required",
            },
            { status: 400 },
          );
        }
        const authorization = await authorizeAgentAction(request, env, {
          agentId: body.requesterAgentId,
          bodyText,
          requiredScope: "missions:write",
        });
        if (!authorization.ok) return authorization.response;
        if (
          !scanPublicPayload({
            missionId,
            requesterAgentId: authorization.agentId,
          }).safe
        ) {
          return Response.json(
            {
              error: "PUBLIC_SAFETY_REJECTED",
              message: "The public mission did not pass the safety boundary",
            },
            { status: 422 },
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Authorization belongs at the public adapter boundary, after identity normalization. */
function isExternalCommandAuthorized(
  state: LifecycleState,
  command: LifecycleCommand,
  authenticatedAgentId: string,
): boolean {
  switch (command.type) {
    case "apply":
    case "withdraw":
    case "accept_pact":
      return command.agentId === authenticatedAgentId;
    case "submit_proposal":
      return (
        command.proposerAgentId === authenticatedAgentId &&
        authenticatedAgentId === state.requesterAgentId
      );
    case "submit_capability_bid":
      return (
        command.agentId === authenticatedAgentId &&
        state.selectedHelperIds.includes(authenticatedAgentId)
      );
    case "submit_assignment_proposal":
      return (
        command.proposerAgentId === authenticatedAgentId &&
        state.selectedHelperIds.includes(authenticatedAgentId)
      );
    case "submit_artifact":
    case "fill_role_slot":
      // Dedicated artifact/replacement adapters add their domain proofs in item 8.
      return false;
    case "publish":
    case "revise_mission":
    case "start_execution":
    case "default_role":
    case "release_role":
    case "safety_pause":
    case "cancel":
      return authenticatedAgentId === state.requesterAgentId;
    case "form_party":
      // Party selection is server-derived from the frozen application and
      // registry evidence snapshot; no external adapter may supply helper IDs.
      return false;
    case "safety_redact":
      return false;
    case "negotiation_timeout":
    case "mark_overdue":
    case "verify":
    case "verifier_unavailable":
    case "verification_failed":
    case "verification_passed":
    case "safety_reject":
    case "expire":
      return false;
  }
}
