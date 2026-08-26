import {
  assertCapabilityInput,
  getCapabilityDefinition,
  type GuildCapabilityName,
} from "@guildhall/capability-manifest";
import {
  PactAcceptanceSchema,
  canonicalJsonDigest,
  pactSigningBytes,
  verifyRegisteredEd25519Proof,
} from "@guildhall/contracts";
import type {
  LifecycleCommand,
  LifecycleState,
} from "@guildhall/mission-engine";
import { scanPublicPayload } from "@guildhall/trust-engine";
import {
  A2APublicInputRejectedError,
  A2AProtocolError,
  A2ATaskExecutionError,
  COMMITMENT_V1_EXTENSION_URI,
  createA2AHttpJsonHandler,
  type A2AArtifact,
  type A2AExecutionContext,
  type A2AExecutionResult,
  type A2ARequestAuthorizationContext,
  type A2ATaskExecutor,
  type JsonObject,
  type JsonValue,
} from "@guildhall/a2a-worker";

import { handlePublicApiRoute } from "../publicApi.js";
import type { MissionSnapshotPacket } from "../durable/protocol.js";
import {
  authorizeAgentAction,
  type AgentAuthorization,
} from "../auth/agentAuthorization.js";
import { listAgentKeys } from "../repositories/index.js";
import type { GuildhallEnv } from "../types.js";
import { D1A2ATaskStore } from "./d1TaskStore.js";
import { buildGuildBrokerCard } from "./guildCard.js";

const BASE_PATH = "/a2a/guild/v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const MUTATING_ACTIONS = new Set([
  "guild.publish_mission",
  "guild.apply_to_mission",
  "guild.withdraw_application",
  "guild.propose_allocation",
  "guild.accept_pact",
  "guild.report_progress",
  "guild.submit_artifact",
]);

export async function handleGuildBrokerRoute(
  request: Request,
  env: GuildhallEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/.well-known/agent-card.json" &&
    !url.pathname.startsWith(`${BASE_PATH}/`)
  ) {
    return null;
  }
  const executor = new GuildBrokerExecutor(env, url.origin);
  const handler = createA2AHttpJsonHandler({
    agentCard: buildGuildBrokerCard(url.origin),
    executor,
    taskStore: new D1A2ATaskStore(env.GUILD_DB),
    basePath: BASE_PATH,
    requiredExtensionUri: COMMITMENT_V1_EXTENSION_URI,
    validatePublicInput(message) {
      if (!scanPublicPayload(message).safe) {
        throw new A2APublicInputRejectedError();
      }
    },
    authorizeRequest(context) {
      return executor.authorize(context);
    },
  });
  return handler(request);
}

class GuildBrokerExecutor implements A2ATaskExecutor {
  readonly #authorizations = new Map<
    string,
    Extract<AgentAuthorization, { ok: true }>
  >();

  constructor(
    private readonly env: GuildhallEnv,
    private readonly origin: string,
  ) {}

  async authorize(context: A2ARequestAuthorizationContext): Promise<void> {
    if (!MUTATING_ACTIONS.has(context.commitment.action)) return;
    const agentId = context.commitment.agentId;
    if (typeof agentId !== "string" || !UUID_PATTERN.test(agentId)) {
      throw unauthenticatedA2A();
    }
    const authorization = await authorizeAgentAction(
      context.request,
      this.env,
      {
        agentId,
        bodyText: context.bodyText,
        requiredScope:
          context.commitment.action === "guild.submit_artifact"
            ? "artifacts:write"
            : "missions:write",
      },
    );
    if (!authorization.ok) throw unauthenticatedA2A();
    this.#authorizations.set(context.message.messageId, authorization);
  }

  async execute(context: A2AExecutionContext): Promise<A2AExecutionResult> {
    const input = dataInput(context);
    const action = context.commitment.action;
    let data: JsonValue;
    if (action === "guild.list_missions") {
      data = await this.publicGet("/api/missions", input, context.signal);
    } else if (action === "guild.get_profile") {
      data = await this.publicGet(
        `/api/agents/${segment(requiredString(input, "agentId"))}`,
        {},
        context.signal,
      );
    } else if (action === "guild.inspect_mission") {
      data = jsonValue(
        await (
          this.env.MISSIONS.getByName(
            context.commitment.missionId,
          ) as unknown as {
            getSnapshot(afterSequence?: number): Promise<MissionSnapshotPacket>;
          }
        ).getSnapshot(optionalSequence(input.afterSequence)),
      );
    } else if (action === "guild.inspect_receipt") {
      data = await this.publicGet(
        `/api/missions/${segment(context.commitment.missionId)}/receipt`,
        {},
        context.signal,
      );
    } else if (MUTATING_ACTIONS.has(action)) {
      data = await this.executeMutation(context, input);
    } else {
      throw new A2ATaskExecutionError("Unsupported Guild action.", {
        code: "GUILD_ACTION_UNSUPPORTED",
        metadata: { canonicalAction: action, guildMissionVerified: false },
      });
    }

    return {
      artifacts: [resultArtifact(context, data)],
      taskMetadata: {
        canonicalAction: action,
        guildMissionVerified: false,
        note: "A2A task completion records transport work only; Guild verification is separate.",
      },
    };
  }

  private async executeMutation(
    context: A2AExecutionContext,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    const action = context.commitment.action as GuildCapabilityName;
    let capability;
    try {
      capability = getCapabilityDefinition(action);
      assertCapabilityInput(capability, input);
    } catch {
      throw taskError("Guild action input is invalid.", "GUILD_INPUT_INVALID", {
        canonicalAction: action,
      });
    }
    if (capability.readOnly) {
      throw taskError(
        "Guild action routing is invalid.",
        "GUILD_ACTION_INVALID",
      );
    }
    const missionId = requiredString(input, "missionId");
    if (
      !UUID_PATTERN.test(missionId) ||
      missionId !== context.commitment.missionId
    ) {
      throw taskError(
        "Guild mission identity is invalid.",
        "GUILD_MISSION_INVALID",
      );
    }
    const agentId = metadataString(context.commitment, "agentId");
    if (!UUID_PATTERN.test(agentId)) {
      throw taskError(
        "Registered Guild agent identity is required.",
        "GUILD_AUTH_REQUIRED",
        {
          canonicalAction: action,
        },
      );
    }
    const authorization = this.#authorizations.get(context.message.messageId);
    this.#authorizations.delete(context.message.messageId);
    if (authorization === undefined || authorization.agentId !== agentId) {
      throw taskError(
        "The transport authorization context was unavailable.",
        "GUILD_AUTH_CONTEXT_MISSING",
        { canonicalAction: action },
      );
    }
    const snapshot = await this.snapshot(missionId);
    const expectedSequence = requiredSequence(input, "expectedSequence");
    if (snapshot.latestSequence !== expectedSequence) {
      throw taskError(
        "Guild mission sequence is stale.",
        "GUILD_SEQUENCE_CONFLICT",
        {
          actualSequence: snapshot.latestSequence,
          expectedSequence,
        },
      );
    }
    const command = await lifecycleCommand(
      action,
      input,
      authorization.agentId,
      {
        keyId: authorization.keyId,
        commitment: context.commitment,
      },
    );
    if (
      !isA2AMutationAuthorized(
        snapshot.snapshot,
        command,
        authorization.agentId,
      )
    ) {
      throw taskError(
        "Guild mission participation is not authorized.",
        "GUILD_PARTICIPANT_REQUIRED",
      );
    }
    if (command.type === "accept_pact") {
      await verifyPactAcceptance(
        this.env,
        missionId,
        command,
        authorization.agentId,
      );
    }
    const commandId = stableCommandId(
      input.commandId,
      context.message.messageId,
    );
    const result = await this.env.MISSIONS.getByName(missionId).executeCommand({
      commandId,
      expectedSequence,
      actor: {
        agentId: authorization.agentId,
        ownerId:
          authorization.kind === "owner"
            ? `github:${authorization.owner.principal.githubUserId}`
            : authorization.credential.publicOwnerId,
        keyId: authorization.keyId,
      },
      source: "a2a",
      issuedAt: new Date().toISOString(),
      command,
    });
    if (!result.ok) {
      throw taskError("Guild command was rejected.", result.code, {
        canonicalAction: action,
        resultingSequence: result.resultingSequence,
      });
    }
    return jsonValue({
      ...result,
      missionId,
      missionVersion: snapshot.snapshot.missionVersion,
      displayState: snapshot.snapshot.stage,
    });
  }

  private async snapshot(missionId: string): Promise<MissionSnapshotPacket> {
    try {
      return await (
        this.env.MISSIONS.getByName(missionId) as unknown as {
          getSnapshot(afterSequence?: number): Promise<MissionSnapshotPacket>;
        }
      ).getSnapshot();
    } catch {
      throw taskError(
        "Guild mission was not found.",
        "GUILD_MISSION_NOT_FOUND",
      );
    }
  }

  private async publicGet(
    path: string,
    input: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const url = new URL(path, this.origin);
    for (const key of [
      "cursor",
      "capability",
      "displayState",
      "difficulty",
      "limit",
    ] as const) {
      const value = input[key];
      if (typeof value === "string" || typeof value === "number") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await handlePublicApiRoute(
      new Request(url, { method: "GET", signal }),
      this.env,
    );
    if (response === null || !response.ok) {
      throw new A2ATaskExecutionError(
        "The Guild public projection could not satisfy this action.",
        { code: "GUILD_PROJECTION_UNAVAILABLE" },
      );
    }
    return jsonValue(await response.json());
  }
}

async function lifecycleCommand(
  action: GuildCapabilityName,
  input: Readonly<Record<string, JsonValue>>,
  agentId: string,
  trusted: {
    readonly keyId: string;
    readonly commitment: Readonly<Record<string, JsonValue>>;
  },
): Promise<LifecycleCommand> {
  switch (action) {
    case "guild.apply_to_mission":
      return { type: "apply", agentId };
    case "guild.withdraw_application":
      return { type: "withdraw", agentId };
    case "guild.propose_allocation":
      return {
        type: "submit_proposal",
        pactVersion: requiredSequence(input, "pactVersion"),
        pactDigest: await canonicalJsonDigest({
          protocol: "commitment/v1",
          kind: "allocation-proposal",
          missionId: requiredString(input, "missionId"),
          pactVersion: requiredSequence(input, "pactVersion"),
          assignments: input.assignments,
          deliveryDeadline: input.deliveryDeadline,
          verificationCriterionIds: input.verificationCriterionIds,
          failureBehavior: input.failureBehavior,
        }),
      };
    case "guild.accept_pact":
      return {
        type: "accept_pact",
        acceptanceId: metadataString(trusted.commitment, "acceptanceId"),
        agentId,
        keyId: trusted.keyId,
        pactVersion: requiredSequence(input, "pactVersion"),
        pactDigest: requiredString(input, "pactDigest"),
        signature: metadataString(trusted.commitment, "pactSignature"),
        acceptedAt: metadataString(trusted.commitment, "acceptedAt"),
      };
    case "guild.publish_mission":
    case "guild.report_progress":
    case "guild.submit_artifact":
      throw taskError(
        "This Guild mutation is available after party binding in the next lifecycle phase.",
        "GUILD_ACTION_NOT_AVAILABLE",
      );
    default:
      throw taskError(
        "Unsupported Guild mutation.",
        "GUILD_ACTION_UNSUPPORTED",
      );
  }
}

async function verifyPactAcceptance(
  env: GuildhallEnv,
  missionId: string,
  command: Extract<LifecycleCommand, { type: "accept_pact" }>,
  authenticatedAgentId: string,
): Promise<void> {
  const suppliedAcceptedAt = Date.parse(command.acceptedAt);
  const key = (await listAgentKeys(env.GUILD_DB, authenticatedAgentId)).find(
    (candidate) =>
      candidate.keyId === command.keyId && candidate.status === "active",
  );
  const proof =
    key === undefined ||
    command.agentId !== authenticatedAgentId ||
    !Number.isFinite(suppliedAcceptedAt) ||
    Math.abs(Date.now() - suppliedAcceptedAt) > 5 * 60 * 1_000
      ? null
      : await verifyRegisteredEd25519Proof({
          key: { keyId: key.keyId, publicJwk: key.publicJwk, status: "active" },
          proof: { keyId: command.keyId, signature: command.signature },
          message: pactSigningBytes(command.pactDigest),
          policy: { kind: "new-proof" },
        });
  if (
    proof?.valid !== true ||
    !PactAcceptanceSchema.safeParse({
      protocol: "commitment/v1",
      kind: "acceptance",
      acceptanceId: command.acceptanceId,
      missionId,
      pactVersion: command.pactVersion,
      agentId: authenticatedAgentId,
      keyId: command.keyId,
      pactDigest: command.pactDigest,
      signature: command.signature,
      acceptedAt: command.acceptedAt,
    }).success
  ) {
    throw taskError(
      "Pact acceptance proof failed.",
      "GUILD_PACT_PROOF_INVALID",
    );
  }
}

function isA2AMutationAuthorized(
  state: LifecycleState,
  command: LifecycleCommand,
  authenticatedAgentId: string,
): boolean {
  switch (command.type) {
    case "apply":
    case "withdraw":
      return command.agentId === authenticatedAgentId;
    case "submit_proposal":
      return (
        authenticatedAgentId === state.requesterAgentId ||
        state.selectedHelperIds.includes(authenticatedAgentId)
      );
    case "accept_pact":
      return (
        command.agentId === authenticatedAgentId &&
        (authenticatedAgentId === state.requesterAgentId ||
          state.selectedHelperIds.includes(authenticatedAgentId))
      );
    default:
      return false;
  }
}

function resultArtifact(
  context: A2AExecutionContext,
  data: JsonValue,
): A2AArtifact {
  return {
    artifactId: crypto.randomUUID(),
    name: `${context.commitment.action} result`,
    description: "Public-safe Guild Broker result",
    parts: [{ data, mediaType: "application/json" }],
    extensions: [COMMITMENT_V1_EXTENSION_URI],
    metadata: {
      [COMMITMENT_V1_EXTENSION_URI]: {
        ...context.commitment,
        guildMissionVerified: false,
      },
    },
  };
}

function dataInput(context: A2AExecutionContext): Record<string, JsonValue> {
  const part = context.message.parts.find(
    (candidate): candidate is { readonly data: JsonValue } =>
      "data" in candidate,
  );
  if (
    part === undefined ||
    part.data === null ||
    typeof part.data !== "object" ||
    Array.isArray(part.data)
  ) {
    throw new A2ATaskExecutionError("Guild actions require one data object.", {
      code: "GUILD_DATA_REQUIRED",
    });
  }
  return { ...(part.data as Readonly<Record<string, JsonValue>>) };
}

function requiredString(
  input: Readonly<Record<string, JsonValue>>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new A2ATaskExecutionError(`Guild field ${field} is required.`, {
      code: "GUILD_FIELD_REQUIRED",
    });
  }
  return value;
}

function optionalSequence(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function metadataString(
  metadata: Readonly<Record<string, JsonValue>>,
  field: string,
): string {
  const value = metadata[field];
  if (typeof value !== "string" || value.length === 0) {
    throw taskError(
      `Guild commitment field ${field} is required.`,
      "GUILD_COMMITMENT_INVALID",
    );
  }
  return value;
}

function requiredSequence(
  input: Readonly<Record<string, JsonValue>>,
  field: string,
): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw taskError(`Guild field ${field} is invalid.`, "GUILD_INPUT_INVALID");
  }
  return value;
}

function stableCommandId(
  value: JsonValue | undefined,
  messageId: string,
): string {
  if (!UUID_PATTERN.test(messageId)) {
    throw taskError(
      "A stable UUID messageId is required for canonical idempotency.",
      "GUILD_COMMAND_ID_INVALID",
    );
  }
  if (value !== undefined && value !== messageId) {
    throw taskError(
      "A2A commandId must equal the messageId.",
      "GUILD_COMMAND_ID_MISMATCH",
    );
  }
  return messageId;
}

function taskError(
  message: string,
  code: string,
  metadata: JsonObject = {},
): A2ATaskExecutionError {
  return new A2ATaskExecutionError(message, {
    code,
    metadata: { ...metadata, guildMissionVerified: false },
  });
}

function unauthenticatedA2A(): A2AProtocolError {
  return new A2AProtocolError(
    "Signed registered Guild agent authentication is required.",
    {
      httpStatus: 401,
      status: "UNAUTHENTICATED",
      reason: "UNAUTHENTICATED",
      metadata: { authentication: "required" },
    },
  );
}
