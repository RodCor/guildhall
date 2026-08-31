import { scanPublicPayload } from "@guildhall/trust-engine";
import {
  canonicalJsonDigest,
  pactMatchesMission,
  type Mission,
} from "@guildhall/contracts";
import type {
  LifecycleCommand,
  LifecycleState,
} from "@guildhall/mission-engine";

import {
  isUnverifiedAgentCommand,
  type MissionSnapshotPacket,
} from "./durable/protocol.js";
import { handleAgentRoute } from "./auth/agentRoutes.js";
import { authorizeAgentAction } from "./auth/agentAuthorization.js";
import { verifyAuthenticatedCommandProof } from "./auth/commandProof.js";
import { handleOAuthRoute } from "./auth/oauth.js";
import { handleSessionRoute } from "./auth/session.js";
import { getAutonomyPolicy } from "./repositories/index.js";
import { handlePublicApiRoute } from "./publicApi.js";
import { handleGuildBrokerRoute } from "./a2a/guildBroker.js";
import type { GuildhallEnv } from "./types.js";
import { executeBoundDemoMission } from "./executionOrchestrator.js";
import { handleDemoRallyRoute } from "./demoRally.js";
import { attemptAutomaticFormation } from "./formation.js";

export { MissionCoordinator } from "./durable/MissionCoordinator.js";
export type { GuildhallEnv as Env } from "./types.js";

const MISSION_ROUTE = /^\/api\/missions\/([^/]+)$/u;
const COMMAND_ROUTE = /^\/api\/missions\/([^/]+)\/commands$/u;
const WEBMCP_COMMAND_ROUTE = /^\/api\/webmcp\/missions\/([^/]+)\/commands$/u;
const STREAM_ROUTE = /^\/api\/missions\/([^/]+)\/stream$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        service: "guildhall",
        status: "ok",
        protocolCore: "commitment/v1",
      });
    }

    if (url.pathname === "/api/ready") {
      return readinessResponse(env);
    }

    const demoRallyResponse = await handleDemoRallyRoute(request, env);
    if (demoRallyResponse !== null) return demoRallyResponse;

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
      if (
        !isUnverifiedAgentCommand(body) ||
        body.actor === null ||
        body.actor.keyId === undefined ||
        body.proof === undefined
      ) {
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
        command: publicCommandForSafetyScan(body.command),
      });
      if (!publicScan.safe) {
        return Response.json(
          {
            error: "PUBLIC_SAFETY_REJECTED",
            message: "The public command did not pass the safety boundary",
            fieldPath: publicScan.fieldPath,
            category: publicScan.category,
          },
          { status: 422 },
        );
      }
      const authorization = await authorizeAgentAction(request, env, {
        agentId: body.actor.agentId,
        bodyText,
        requiredScope: "missions:write",
        keyId: body.actor.keyId,
      });
      if (!authorization.ok) return authorization.response;
      if (
        body.actor.keyId !== authorization.keyId ||
        !commandIdentityMatches(
          body.command,
          authorization.agentId,
          authorization.keyId,
        )
      ) {
        return Response.json(
          {
            error: "COMMAND_NOT_AUTHORIZED",
            message: "Command signer does not match the authenticated agent",
          },
          { status: 403 },
        );
      }
      const verifiedProof = await verifyAuthenticatedCommandProof({
        authorization,
        commandId: body.commandId,
        action: body.command.type,
        missionId,
        expectedSequence: body.expectedSequence,
        issuedAt: body.issuedAt,
        payload: body.command,
        proof: body.proof,
      });
      if (verifiedProof === null) {
        return Response.json(
          {
            error: "COMMAND_PROOF_INVALID",
            message:
              "The agent command signature is missing, stale, or invalid",
          },
          { status: 403 },
        );
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
        // The server records the authenticated network transport. A route name
        // alone is not evidence that a browser invoked the WebMCP tool.
        source:
          authorization.kind === "guild-node"
            ? ("mcp" as const)
            : ("http" as const),
        command: body.command,
        proof: body.proof,
        proofVerifiedAt: verifiedProof.verifiedAt,
        keyStatusCheckedAt: verifiedProof.keyStatusCheckedAt,
      };
      const coordinator = env.MISSIONS.getByName(missionId);
      const replay = await coordinator.replayCommand(authenticatedCommand);
      if (replay !== null) {
        return Response.json(replay, { status: replay.ok ? 200 : 409 });
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
      const result =
        authenticatedCommand.command.type === "submit_artifact"
          ? await coordinator.submitArtifact(authenticatedCommand)
          : authenticatedCommand.command.type === "accept_pact"
            ? await coordinator.acceptPact(authenticatedCommand)
            : authenticatedCommand.command.type === "fill_role_slot"
              ? await coordinator.bindReplacement(authenticatedCommand)
              : await coordinator.executeCommand(authenticatedCommand);
      let responseResult = result;
      if (result.ok && authenticatedCommand.command.type === "apply") {
        await attemptAutomaticFormation(env, missionId);
        const reconciled = await (
          coordinator as unknown as {
            getSnapshot(): Promise<MissionSnapshotPacket>;
          }
        ).getSnapshot();
        responseResult = {
          ...result,
          resultingSequence: reconciled.latestSequence,
        };
      }
      if (
        result.ok &&
        authenticatedCommand.command.type === "accept_pact" &&
        result.eventTypes.includes("pact_bound")
      ) {
        ctx.waitUntil(
          executeBoundDemoMission(env, missionId, true).catch((error) => {
            console.error(
              JSON.stringify({
                missionId,
                errorName: error instanceof Error ? error.name : "UnknownError",
                message: "autonomous demo execution failed",
              }),
            );
          }),
        );
      }
      if (
        result.ok &&
        authenticatedCommand.command.type === "submit_artifact"
      ) {
        const afterArtifact = await (
          coordinator as unknown as {
            getSnapshot(): Promise<
              MissionSnapshotPacket & {
                readonly receipt?: unknown;
              }
            >;
          }
        ).getSnapshot();
        if (
          afterArtifact.snapshot.stage === "DELIVER" ||
          (afterArtifact.snapshot.terminalOutcome !== null &&
            afterArtifact.receipt == null)
        ) {
          await coordinator.runVerification({
            infrastructureStatus: "available",
          });
        }
        const reconciled = await (
          coordinator as unknown as {
            getSnapshot(): Promise<MissionSnapshotPacket>;
          }
        ).getSnapshot();
        responseResult = {
          ...result,
          resultingSequence: reconciled.latestSequence,
        };
      }
      const status = responseResult.ok
        ? 200
        : responseResult.code === "PACT_PROOF_INVALID"
          ? 403
          : responseResult.code === "COMMAND_ID_REUSED" ||
              responseResult.code === "EXPECTED_SEQUENCE_MISMATCH"
            ? 409
            : 422;
      return Response.json(responseResult, { status });
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

    return Response.json(
      {
        error: "NOT_FOUND",
        message: "The requested Guildhall Worker route does not exist",
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<GuildhallEnv>;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function readinessResponse(env: GuildhallEnv): Promise<Response> {
  try {
    const origin = new URL(env.PUBLIC_ORIGIN);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== env.PUBLIC_ORIGIN ||
      env.GITHUB_CLIENT_ID.length < 12 ||
      env.GITHUB_CLIENT_SECRET.length < 20 ||
      env.AUTH_COOKIE_SECRET.length < 32 ||
      env.GUILD_ISSUER_KEY_ID === undefined ||
      !UUID_PATTERN.test(env.GUILD_ISSUER_KEY_ID) ||
      env.GUILD_ISSUER_PRIVATE_JWK === undefined
    ) {
      throw new TypeError("required binding is invalid");
    }
    const issuer: unknown = JSON.parse(env.GUILD_ISSUER_PRIVATE_JWK);
    if (
      !isRecord(issuer) ||
      issuer.kty !== "OKP" ||
      issuer.crv !== "Ed25519" ||
      typeof issuer.d !== "string" ||
      typeof issuer.x !== "string"
    ) {
      throw new TypeError("issuer key is invalid");
    }
    const database = await env.GUILD_DB.prepare("SELECT 1 AS ok").first<{
      ok: number;
    }>();
    if (database?.ok !== 1) throw new TypeError("database is unavailable");
    const complete =
      env.GUILD_DEMO_RALLY_SECRET !== undefined &&
      env.GUILD_DEMO_RALLY_SECRET.length >= 32 &&
      [env.SCOUT_A2A_URL, env.SCRIBE_A2A_URL, env.WARDEN_A2A_URL].every(
        (value) => {
          if (value === undefined) return false;
          const endpoint = new URL(value);
          return (
            endpoint.protocol === "https:" && endpoint.pathname === "/a2a/v1"
          );
        },
      );
    return Response.json(
      {
        service: "guildhall",
        status: "ok",
        protocolCore: "commitment/v1",
        phase: complete ? "complete" : "guildhall",
        database: "reachable",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { service: "guildhall", status: "not-ready" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function commandIdentityMatches(
  command: LifecycleCommand,
  agentId: string,
  keyId: string,
): boolean {
  switch (command.type) {
    case "apply":
    case "submit_capability_bid":
      return command.agentId === agentId && command.keyId === keyId;
    case "withdraw":
      return command.agentId === agentId;
    case "submit_proposal":
      return command.proposerAgentId === agentId;
    case "submit_assignment_proposal":
      return command.proposerAgentId === agentId && command.keyId === keyId;
    case "accept_pact":
      return command.agentId === agentId && command.keyId === keyId;
    case "submit_artifact":
      return (
        command.artifact.metadata.producingAgentId === agentId &&
        command.artifact.metadata.keyId === keyId
      );
    case "fill_role_slot":
      return (
        command.replacementAgentId === agentId && command.proof.keyId === keyId
      );
    default:
      return true;
  }
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
    case "report_progress":
      return state.roleSlots.some(
        (slot) =>
          slot.roleSlotId === command.roleSlotId &&
          slot.status === "active" &&
          slot.occupantAgentId === authenticatedAgentId,
      );
    case "submit_artifact":
      return state.roleSlots.some(
        (slot) =>
          slot.roleSlotId === command.roleSlotId &&
          slot.status === "active" &&
          slot.occupantAgentId === authenticatedAgentId &&
          command.artifact.metadata.producingAgentId === authenticatedAgentId,
      );
    case "fill_role_slot":
      return command.replacementAgentId === authenticatedAgentId;
    case "publish":
    case "revise_mission":
    case "start_execution":
    case "safety_pause":
    case "cancel":
      return authenticatedAgentId === state.requesterAgentId;
    case "release_role":
      return state.roleSlots.some(
        (slot) =>
          slot.roleSlotId === command.roleSlotId &&
          slot.status === "active" &&
          slot.occupantAgentId === authenticatedAgentId,
      );
    case "form_party":
      // Party selection is server-derived from the frozen application and
      // registry evidence snapshot; no external adapter may supply helper IDs.
      return false;
    case "safety_redact":
      return false;
    case "negotiation_timeout":
    case "mark_overdue":
    case "default_role":
    case "verify":
    case "verifier_unavailable":
    case "verification_failed":
    case "verification_passed":
    case "issue_receipt":
    case "safety_reject":
    case "expire":
      return false;
  }
}

function publicCommandForSafetyScan(command: LifecycleCommand): unknown {
  if (command.type === "accept_pact") {
    return { ...command, signature: "[public-ed25519-signature]" };
  }
  if (command.type === "submit_artifact") {
    return {
      ...command,
      artifact: {
        ...command.artifact,
        metadata: {
          ...command.artifact.metadata,
          signature: "[public-ed25519-signature]",
        },
      },
    };
  }
  if (command.type === "fill_role_slot") {
    return {
      ...command,
      proof: { ...command.proof, signature: "[public-ed25519-signature]" },
    };
  }
  return command;
}
