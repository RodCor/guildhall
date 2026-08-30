import {
  assertCapabilityInput,
  getCapabilityDefinition,
  type GuildCapabilityName,
} from "@guildhall/capability-manifest";
import {
  ArtifactSubmissionSchema,
  CommandProofSchema,
  TimestampSchema,
  buildPact,
  canonicalJsonDigest,
  type AllocationAssignment,
  type Mission,
} from "@guildhall/contracts";
import {
  deriveDisplayState,
  type LifecycleCommand,
  type LifecycleState,
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
import { verifyAuthenticatedCommandProof } from "../auth/commandProof.js";
import type { GuildhallEnv } from "../types.js";
import { attemptAutomaticFormation } from "../formation.js";
import { D1A2ATaskStore } from "./d1TaskStore.js";
import { buildGuildBrokerCard } from "./guildCard.js";
import { executeBoundDemoMission } from "../executionOrchestrator.js";

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
      const scan = scanPublicPayload(message);
      if (!scan.safe) {
        throw new A2APublicInputRejectedError(undefined, {
          fieldPath: scan.fieldPath,
          category: scan.category,
        });
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
    const commandProof = CommandProofSchema.safeParse(
      context.commitment.commandProof,
    );
    const issuedAt = metadataString(context.commitment, "commandIssuedAt");
    const proofPayload = {
      input,
      commitment: unsignedA2ACommitment(context.commitment),
    };
    if (!commandProof.success) {
      throw taskError(
        "The A2A command proof is missing, stale, or invalid.",
        "GUILD_COMMAND_PROOF_INVALID",
      );
    }
    const verifiedProof = await verifyAuthenticatedCommandProof({
      authorization,
      commandId: stableCommandId(input.commandId, context.message.messageId),
      action,
      missionId,
      expectedSequence,
      issuedAt,
      payload: proofPayload,
      proof: commandProof.data,
    });
    if (verifiedProof === null) {
      throw taskError(
        "The A2A command proof is missing, stale, or invalid.",
        "GUILD_COMMAND_PROOF_INVALID",
      );
    }
    if (
      action === "guild.apply_to_mission" &&
      (snapshot.definition === null ||
        snapshot.definition === undefined ||
        Date.now() >= Date.parse(snapshot.definition.formationDeadline))
    ) {
      throw taskError(
        "The Guild formation deadline has passed.",
        "GUILD_FORMATION_CLOSED",
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
      snapshot,
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
    const commandId = stableCommandId(
      input.commandId,
      context.message.messageId,
    );
    const coordinator = this.env.MISSIONS.getByName(missionId);
    const coordinatorCommand = {
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
      issuedAt,
      command,
      proof: commandProof.data,
      proofVerifiedAt: verifiedProof.verifiedAt,
      keyStatusCheckedAt: verifiedProof.keyStatusCheckedAt,
      proofAction: action,
      proofPayload,
    } as const;
    const result =
      command.type === "submit_artifact"
        ? await coordinator.submitArtifact(coordinatorCommand)
        : command.type === "accept_pact"
          ? await coordinator.acceptPact(coordinatorCommand)
          : await coordinator.executeCommand(coordinatorCommand);
    if (!result.ok) {
      throw taskError("Guild command was rejected.", result.code, {
        canonicalAction: action,
        resultingSequence: result.resultingSequence,
      });
    }
    const formation =
      command.type === "apply"
        ? await attemptAutomaticFormation(this.env, missionId)
        : undefined;
    if (
      result.ok &&
      command.type === "accept_pact" &&
      result.eventTypes.includes("pact_bound")
    ) {
      await executeBoundDemoMission(this.env, missionId, true);
    }
    if (result.ok && command.type === "submit_artifact") {
      const afterArtifact = await this.snapshot(missionId);
      if (
        afterArtifact.snapshot.stage === "DELIVER" ||
        (afterArtifact.snapshot.terminalOutcome !== null &&
          afterArtifact.receipt == null)
      ) {
        await coordinator.runVerification({
          infrastructureStatus: "available",
        });
      }
    }
    const current = await this.snapshot(missionId);
    return jsonValue({
      ...result,
      resultingSequence: current.latestSequence,
      missionId,
      missionVersion: current.snapshot.missionVersion,
      displayState: displayState(current.snapshot),
      candidatePact: current.snapshot.candidatePact,
      ...(formation === undefined ? {} : { automaticFormation: formation }),
    });
  }

  private async snapshot(
    missionId: string,
  ): Promise<MissionSnapshotPacket & { readonly definition?: Mission | null }> {
    try {
      return await (
        this.env.MISSIONS.getByName(missionId) as unknown as {
          getSnapshot(
            afterSequence?: number,
          ): Promise<
            MissionSnapshotPacket & { readonly definition?: Mission | null }
          >;
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

function unsignedA2ACommitment(
  commitment: Readonly<Record<string, JsonValue>>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(commitment).filter(
      ([key]) =>
        key !== "protocol" &&
        key !== "action" &&
        key !== "missionId" &&
        key !== "agentId" &&
        key !== "commandIssuedAt" &&
        key !== "commandProof",
    ),
  ) as JsonObject;
}

async function lifecycleCommand(
  action: GuildCapabilityName,
  input: Readonly<Record<string, JsonValue>>,
  agentId: string,
  trusted: {
    readonly keyId: string;
    readonly commitment: Readonly<Record<string, JsonValue>>;
  },
  snapshot: MissionSnapshotPacket & { readonly definition?: Mission | null },
): Promise<LifecycleCommand> {
  switch (action) {
    case "guild.apply_to_mission":
      return {
        type: "apply",
        agentId,
        keyId: trusted.keyId,
        missionVersion: positiveSequence(input, "missionVersion"),
        relevantCapabilities: stringArray(input, "relevantCapabilities"),
        proposedContribution: requiredString(input, "proposedContribution"),
        availability: availability(input.availability),
      };
    case "guild.withdraw_application":
      return { type: "withdraw", agentId };
    case "guild.propose_allocation":
      return negotiationCommand(input, agentId, trusted.keyId, snapshot);
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
    case "guild.report_progress":
      return {
        type: "report_progress",
        roleSlotId: requiredString(input, "roleSlotId"),
        status: progressStatus(input.status),
        summary: requiredString(input, "summary"),
        completedOutputIds: stringArray(input, "completedOutputIds", true),
        occurredAt: requiredString(input, "occurredAt"),
      };
    case "guild.submit_artifact": {
      const artifact = ArtifactSubmissionSchema.safeParse(
        trusted.commitment.artifactSubmission,
      );
      if (!artifact.success) {
        throw taskError(
          "The signed artifact submission metadata is missing or malformed.",
          "GUILD_ARTIFACT_INVALID",
        );
      }
      const summary = jsonRecord(input.artifact, "artifact");
      if (
        artifact.data.metadata.artifactId !==
          requiredString(summary, "artifactId") ||
        artifact.data.outputId !== requiredString(summary, "outputId") ||
        artifact.data.metadata.contentDigest !==
          requiredString(summary, "contentDigest") ||
        artifact.data.metadata.pactDigest !==
          requiredString(input, "pactDigest") ||
        artifact.data.metadata.roleSlotId !==
          requiredString(input, "roleSlotId")
      ) {
        throw taskError(
          "Artifact summary does not match the signed submission.",
          "GUILD_ARTIFACT_INVALID",
        );
      }
      return {
        type: "submit_artifact",
        roleSlotId: artifact.data.metadata.roleSlotId,
        artifact: artifact.data,
      };
    }
    case "guild.publish_mission":
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

async function negotiationCommand(
  input: Readonly<Record<string, JsonValue>>,
  proposerAgentId: string,
  keyId: string,
  snapshot: MissionSnapshotPacket & { readonly definition?: Mission | null },
): Promise<LifecycleCommand> {
  const negotiationStep = requiredString(input, "negotiationStep");
  if (negotiationStep === "capability-bid") {
    return {
      type: "submit_capability_bid",
      agentId: proposerAgentId,
      keyId,
      relevantCapabilities: stringArray(input, "relevantCapabilities"),
      proposedContribution: requiredString(input, "proposedContribution"),
    };
  }
  const mission = snapshot.definition;
  if (mission === null || mission === undefined) {
    throw taskError(
      "The immutable mission definition is unavailable.",
      "GUILD_MISSION_DEFINITION_MISSING",
    );
  }
  const deliveryDeadline = requiredString(input, "deliveryDeadline");
  const criterionIds = stringArray(input, "verificationCriterionIds");
  const failureBehavior = jsonRecord(input.failureBehavior, "failureBehavior");
  if (
    deliveryDeadline !== mission.deliveryDeadline ||
    !sameStrings(
      criterionIds,
      mission.verificationCriteria.map((criterion) => criterion.criterionId),
    ) ||
    (await canonicalJsonDigest(failureBehavior)) !==
      (await canonicalJsonDigest(mission.failureBehavior))
  ) {
    throw taskError(
      "A proposal cannot alter immutable mission terms.",
      "GUILD_MISSION_TERMS_CHANGED",
    );
  }
  const proposalRound = positiveSequence(input, "pactVersion");
  const pact = await buildPact({
    mission,
    selectedHelperIds: snapshot.snapshot.selectedHelperIds,
    pactVersion: proposalRound,
    assignments: allocationAssignments(input.assignments),
    createdAt:
      proposalRound === 2 && snapshot.snapshot.candidatePact !== null
        ? snapshot.snapshot.candidatePact.pact.createdAt
        : new Date().toISOString(),
  });
  const pactDigest = await canonicalJsonDigest(pact);
  if (negotiationStep === "requester-proposal") {
    return {
      type: "submit_proposal",
      proposerAgentId,
      proposalRound,
      pactDigest,
      pact,
    };
  }
  if (negotiationStep === "assignment-proposal") {
    return {
      type: "submit_assignment_proposal",
      proposerAgentId,
      keyId,
      pactDigest,
      pact,
    };
  }
  throw taskError(
    "The negotiation step is unsupported.",
    "GUILD_INPUT_INVALID",
  );
}

function allocationAssignments(
  value: JsonValue | undefined,
): AllocationAssignment[] {
  if (!Array.isArray(value)) {
    throw taskError("Guild assignments are required.", "GUILD_INPUT_INVALID");
  }
  return value.map((candidate) => {
    const assignment = jsonRecord(candidate, "assignment");
    const pointAllocation = assignment.pointAllocation;
    if (
      typeof pointAllocation !== "number" ||
      !Number.isSafeInteger(pointAllocation) ||
      pointAllocation < 1
    ) {
      throw taskError(
        "Guild assignment points are invalid.",
        "GUILD_INPUT_INVALID",
      );
    }
    return {
      roleSlotId: requiredString(assignment, "roleSlotId"),
      agentId: requiredString(assignment, "agentId"),
      responsibilities: stringArray(assignment, "responsibilities"),
      requiredCapabilities: stringArray(assignment, "requiredCapabilities"),
      dependencyRoleSlotIds: stringArray(
        assignment,
        "dependencyRoleSlotIds",
        true,
      ),
      outputIds: stringArray(assignment, "outputIds"),
      verificationCriterionIds: stringArray(
        assignment,
        "verificationCriterionIds",
      ),
      pointAllocation,
    };
  });
}

function availability(value: JsonValue | undefined): {
  readonly availableFrom: string;
  readonly availableUntil: string;
} {
  const parsed = jsonRecord(value, "availability");
  const availableFrom = requiredString(parsed, "availableFrom");
  const availableUntil = requiredString(parsed, "availableUntil");
  if (
    !TimestampSchema.safeParse(availableFrom).success ||
    !TimestampSchema.safeParse(availableUntil).success ||
    Date.parse(availableFrom) >= Date.parse(availableUntil)
  ) {
    throw taskError("Guild availability is invalid.", "GUILD_INPUT_INVALID");
  }
  return { availableFrom, availableUntil };
}

function progressStatus(
  value: JsonValue | undefined,
): "working" | "blocked" | "ready-for-delivery" {
  if (
    value !== "working" &&
    value !== "blocked" &&
    value !== "ready-for-delivery"
  ) {
    throw taskError("Guild progress status is invalid.", "GUILD_INPUT_INVALID");
  }
  return value;
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
    case "accept_pact":
      return (
        command.agentId === authenticatedAgentId &&
        (authenticatedAgentId === state.requesterAgentId ||
          state.selectedHelperIds.includes(authenticatedAgentId))
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

function positiveSequence(
  input: Readonly<Record<string, JsonValue>>,
  field: string,
): number {
  const value = requiredSequence(input, field);
  if (value < 1) {
    throw taskError(`Guild field ${field} is invalid.`, "GUILD_INPUT_INVALID");
  }
  return value;
}

function stringArray(
  input: Readonly<Record<string, JsonValue>>,
  field: string,
  allowEmpty = false,
): string[] {
  const value = input[field];
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw taskError(`Guild field ${field} is invalid.`, "GUILD_INPUT_INVALID");
  }
  return value as string[];
}

function jsonRecord(
  value: JsonValue | undefined,
  field: string,
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw taskError(`Guild field ${field} is invalid.`, "GUILD_INPUT_INVALID");
  }
  return { ...(value as JsonObject) };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function displayState(state: LifecycleState): string {
  return deriveDisplayState(state);
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
