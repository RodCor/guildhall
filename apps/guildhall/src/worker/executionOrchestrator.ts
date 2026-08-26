import {
  COMMITMENT_V1_EXTENSION_URI,
  createA2AHttpJsonClient,
  type A2AArtifact,
  type A2ATask,
  type JsonObject,
  type JsonValue,
} from "@guildhall/a2a-worker";
import {
  ArtifactMetadataSchema,
  ReplacementProofSchema,
  canonicalJsonDigest,
  type ArtifactSubmission,
  type Pact,
} from "@guildhall/contracts";
import { ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST } from "@guildhall/trust-engine";

import type { MissionSnapshotWithDefinition } from "./durable/MissionCoordinator.js";
import type {
  CoordinatorCommand,
  CoordinatorCommandResult,
} from "./durable/protocol.js";
import type { GuildhallEnv } from "./types.js";

const REPLACEMENT_PROOF_METADATA_KEY =
  "https://guildhall.example/extensions/commitment/v1/replacement-proof";
const SCOUT_ID = "11111111-1111-4111-8111-111111111111";
const SCRIBE_ID = "22222222-2222-4222-8222-222222222222";
const WARDEN_ID = "33333333-3333-4333-8333-333333333333";

export interface DemoExecutionResult {
  readonly executed: boolean;
  readonly injectedFailure: boolean;
  readonly receiptId: string | null;
}

/**
 * Run the hackathon's real deterministic A2A failure/recovery arc. Every
 * artifact returned by an independent Worker still passes the coordinator's
 * safety, key, pact, slot, digest, and deterministic-verifier boundaries.
 */
export async function executeBoundDemoMission(
  env: GuildhallEnv,
  missionId: string,
  injectScribeFailure = true,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  coordinatorOverride?: DemoCoordinatorRpc,
): Promise<DemoExecutionResult> {
  const urls = demoAgentUrls(env);
  if (urls === null) {
    return { executed: false, injectedFailure: false, receiptId: null };
  }
  const coordinator =
    coordinatorOverride ??
    (env.MISSIONS.getByName(missionId) as unknown as DemoCoordinatorRpc);
  let packet = await coordinator.getSnapshot();
  const candidate = packet.snapshot.candidatePact;
  if (candidate === null) {
    return {
      executed: false,
      injectedFailure: false,
      receiptId: packet.receipt?.receiptId ?? null,
    };
  }
  if (
    packet.snapshot.stage === "DRAFT" ||
    packet.snapshot.stage === "PREPARE" ||
    packet.snapshot.stage === "RESERVE" ||
    packet.snapshot.stage === "COMMIT"
  ) {
    return {
      executed: false,
      injectedFailure: false,
      receiptId: packet.receipt?.receiptId ?? null,
    };
  }
  const approvedFixtureLocation = new URL(
    "/fixtures/accessibility-dungeon-v1",
    env.PUBLIC_ORIGIN,
  ).toString();
  if (
    candidate.pact.publicInputs.length !== 1 ||
    candidate.pact.publicInputs[0]?.location !== approvedFixtureLocation ||
    candidate.pact.publicInputs[0]?.contentDigest !==
      ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST
  ) {
    return {
      executed: false,
      injectedFailure: false,
      receiptId: packet.receipt?.receiptId ?? null,
    };
  }
  if (packet.snapshot.terminalOutcome !== null) {
    if (packet.receipt === null) {
      const recovered = await coordinator.runVerification({
        infrastructureStatus: "available",
      });
      return {
        executed: true,
        injectedFailure: packet.replacements.length > 0,
        receiptId: recovered.receipt?.receiptId ?? null,
      };
    }
    return {
      executed: true,
      injectedFailure: packet.replacements.length > 0,
      receiptId: packet.receipt.receiptId,
    };
  }
  const pact = candidate.pact;
  const scoutSlot = roleForOutput(pact, "accessibility-findings", SCOUT_ID);
  const scribeSlot = roleForOutput(pact, "remediation-plan", SCRIBE_ID);
  if (
    packet.snapshot.stage === "DELIVER" ||
    packet.snapshot.stage === "VERIFY"
  ) {
    const terminal = await coordinator.runVerification({
      infrastructureStatus: "available",
    });
    return {
      executed: true,
      injectedFailure: packet.replacements.length > 0,
      receiptId: terminal.receipt?.receiptId ?? null,
    };
  }
  if (
    packet.snapshot.stage === "EXECUTE" &&
    !packet.snapshot.executionStarted
  ) {
    await requireAccepted(
      coordinator.executeCommand(
        systemCommand(
          packet,
          { type: "start_execution" },
          `demo:start:${missionId}`,
          pact.createdAt,
        ),
      ),
      "start execution",
    );
    packet = await coordinator.getSnapshot();
  }

  let scoutArtifact = acceptedOutput(packet, scoutSlot.requiredOutputIds[0]!);
  if (scoutArtifact === null && packet.snapshot.stage === "EXECUTE") {
    const attempt = correctionAttempt(packet);
    const scoutTask = await executeRole(
      urls.scout,
      {
        dispatchId: `demo-${missionId}-scout-v${attempt}`,
        action: "execute-role",
        missionId,
        pactDigest: candidate.pactDigest,
        roleSlotId: scoutSlot.roleSlotId,
        data: {
          dependencyArtifactIds: [],
          fixtureId: "accessibility-dungeon-v1",
          kind: "role-assignment",
          outputId: scoutSlot.requiredOutputIds[0]!,
          attempt,
          protocol: "commitment/v1",
          role: "scout",
        },
      },
      fetchImpl,
    );
    scoutArtifact = artifactSubmission(
      onlyCompletedArtifact(scoutTask),
      scoutSlot.requiredOutputIds[0]!,
      [],
    );
    await requireAccepted(
      coordinator.submitArtifact(
        await artifactCommand(env, packet, scoutArtifact, "a2a"),
      ),
      "accept Scout artifact",
    );
    packet = await coordinator.getSnapshot();
  }
  if (scoutArtifact === null) {
    throw new Error("Scout artifact is unavailable for dependent execution");
  }

  let scribeArtifact = acceptedOutput(packet, scribeSlot.requiredOutputIds[0]!);
  const findings = scoutArtifact.content.findings;
  const scribeRuntimeSlot = packet.snapshot.roleSlots.find(
    (slot) => slot.roleSlotId === scribeSlot.roleSlotId,
  );
  if (
    scribeArtifact === null &&
    packet.snapshot.stage === "EXECUTE" &&
    scribeRuntimeSlot?.occupantAgentId === SCRIBE_ID
  ) {
    const attempt = correctionAttempt(packet);
    const scribeTask = await executeRole(
      urls.scribe,
      {
        dispatchId: `demo-${missionId}-scribe-v${attempt}`,
        action: "execute-role",
        missionId,
        pactDigest: candidate.pactDigest,
        roleSlotId: scribeSlot.roleSlotId,
        data: {
          dependencyArtifactIds: [scoutArtifact.metadata.artifactId],
          findings: findings as JsonValue,
          fixtureId: "accessibility-dungeon-v1",
          ...(injectScribeFailure
            ? { fixtureScenario: "scribe-controlled-failure-v1" }
            : {}),
          kind: "role-assignment",
          outputId: scribeSlot.requiredOutputIds[0]!,
          attempt,
          protocol: "commitment/v1",
          role: "scribe",
        },
      },
      fetchImpl,
    );
    if (scribeTask.status.state === "TASK_STATE_COMPLETED") {
      scribeArtifact = artifactSubmission(
        onlyCompletedArtifact(scribeTask),
        scribeSlot.requiredOutputIds[0]!,
        [scoutArtifact.metadata.artifactId],
      );
      await requireAccepted(
        coordinator.submitArtifact(
          await artifactCommand(env, packet, scribeArtifact, "a2a"),
        ),
        "accept Scribe artifact",
      );
      packet = await coordinator.getSnapshot();
    } else {
      const evidence = controlledScribeFailure(scribeTask);
      await requireAccepted(
        coordinator.executeCommand(
          systemCommand(
            packet,
            {
              type: "default_role",
              roleSlotId: scribeSlot.roleSlotId,
              evidence,
            },
            `demo:default:${missionId}:${scribeSlot.roleSlotId}`,
            evidence.observedAt,
          ),
        ),
        "record Scribe default",
      );
      packet = await coordinator.getSnapshot();
    }
  }

  const assignmentDigest = await canonicalJsonDigest(scribeSlot);
  const recoveryData = {
    dependencyArtifactIds: [scoutArtifact.metadata.artifactId],
    findings: findings as JsonValue,
    fixtureId: "accessibility-dungeon-v1",
    kind: "role-recovery",
    originalAssignment: {
      assignmentDigest,
      pactDigest: candidate.pactDigest,
      role: "scribe",
      roleSlotId: scribeSlot.roleSlotId,
    },
    outputId: scribeSlot.requiredOutputIds[0]!,
    attempt: correctionAttempt(packet),
    protocol: "commitment/v1",
    replacement: {
      assignmentDigest,
      pactDigest: candidate.pactDigest,
      predecessorAgentId: scribeSlot.originalAgentId,
      role: "scribe",
      roleSlotId: scribeSlot.roleSlotId,
    },
  } as const satisfies JsonObject;
  let replacement = packet.replacements.find(
    (entry) => entry.roleSlotId === scribeSlot.roleSlotId,
  );
  if (packet.snapshot.stage === "COMPENSATE" && replacement === undefined) {
    const offerTask = await executeRole(
      urls.warden,
      {
        dispatchId: `demo-${missionId}-warden-offer-v1`,
        action: "offer-recovery",
        missionId,
        pactDigest: candidate.pactDigest,
        roleSlotId: scribeSlot.roleSlotId,
        data: recoveryData,
      },
      fetchImpl,
    );
    const proof = ReplacementProofSchema.parse(
      record(offerTask.metadata[REPLACEMENT_PROOF_METADATA_KEY]),
    );
    const bindCommand: CoordinatorCommand = {
      commandId: proof.replacementId,
      expectedSequence: packet.latestSequence,
      actor: {
        agentId: proof.replacementAgentId,
        ownerId: await publicOwnerId(env, proof.replacementAgentId),
        keyId: proof.keyId,
      },
      source: "a2a",
      issuedAt: proof.acceptedAt,
      command: {
        type: "fill_role_slot",
        roleSlotId: proof.roleSlotId,
        predecessorAgentId: proof.predecessorAgentId,
        replacementAgentId: proof.replacementAgentId,
        pactDigest: proof.pactDigest,
        proof,
      },
    };
    await requireAccepted(
      coordinator.bindReplacement(bindCommand),
      "bind Warden replacement",
    );
    packet = await coordinator.getSnapshot();
    replacement = proof;
  }
  if (
    scribeArtifact === null &&
    packet.snapshot.stage === "EXECUTE" &&
    replacement !== undefined
  ) {
    const attempt = correctionAttempt(packet);
    const wardenTask = await executeRole(
      urls.warden,
      {
        dispatchId: `demo-${missionId}-warden-work-v${attempt}`,
        action: "recover-role",
        missionId,
        pactDigest: candidate.pactDigest,
        roleSlotId: scribeSlot.roleSlotId,
        data: {
          ...recoveryData,
          acceptedReplacementId: replacement.replacementId,
        },
      },
      fetchImpl,
    );
    const rawWardenArtifact = onlyCompletedArtifact(wardenTask);
    const wardenArtifact = artifactSubmission(
      rawWardenArtifact,
      scribeSlot.requiredOutputIds[0]!,
      [scoutArtifact.metadata.artifactId],
    );
    await requireAccepted(
      coordinator.submitArtifact(
        await artifactCommand(env, packet, wardenArtifact, "a2a"),
      ),
      "accept Warden artifact",
    );
    packet = await coordinator.getSnapshot();
  }

  if (packet.snapshot.stage !== "DELIVER") {
    throw new Error(`Demo execution stopped in ${packet.snapshot.stage}`);
  }
  const terminal = await coordinator.runVerification({
    infrastructureStatus: "available",
  });
  return {
    executed: true,
    injectedFailure: packet.replacements.length > 0,
    receiptId: terminal.receipt?.receiptId ?? null,
  };
}

export interface DemoCoordinatorRpc {
  getSnapshot():
    MissionSnapshotWithDefinition | Promise<MissionSnapshotWithDefinition>;
  executeCommand(input: CoordinatorCommand): Promise<CoordinatorCommandResult>;
  submitArtifact(input: CoordinatorCommand): Promise<CoordinatorCommandResult>;
  bindReplacement(input: CoordinatorCommand): Promise<CoordinatorCommandResult>;
  runVerification(input: {
    readonly infrastructureStatus: "available" | "unavailable";
  }): Promise<{
    readonly verification: unknown;
    readonly receipt: { readonly receiptId: string } | null;
  }>;
}

function demoAgentUrls(env: GuildhallEnv): {
  readonly scout: string;
  readonly scribe: string;
  readonly warden: string;
} | null {
  if (
    env.SCOUT_A2A_URL === undefined ||
    env.SCRIBE_A2A_URL === undefined ||
    env.WARDEN_A2A_URL === undefined
  ) {
    return null;
  }
  return {
    scout: env.SCOUT_A2A_URL,
    scribe: env.SCRIBE_A2A_URL,
    warden: env.WARDEN_A2A_URL,
  };
}

async function executeRole(
  baseUrl: string,
  input: {
    readonly dispatchId: string;
    readonly action: "execute-role" | "offer-recovery" | "recover-role";
    readonly missionId: string;
    readonly pactDigest: string;
    readonly roleSlotId: string;
    readonly data: JsonObject;
  },
  fetchImpl: typeof globalThis.fetch,
): Promise<A2ATask> {
  const client = createA2AHttpJsonClient({
    baseUrl,
    allowInsecureHttp: new URL(baseUrl).protocol === "http:",
    timeoutMs: 10_000,
    fetch: fetchImpl,
  });
  const response = await client.sendMessage({
    message: {
      messageId: input.dispatchId,
      contextId: input.missionId,
      role: "ROLE_USER",
      parts: [{ data: input.data, mediaType: "application/json" }],
      metadata: {
        [COMMITMENT_V1_EXTENSION_URI]: {
          protocol: "commitment/v1",
          action: input.action,
          missionId: input.missionId,
          pactDigest: input.pactDigest,
          roleSlotId: input.roleSlotId,
        },
      },
      extensions: [COMMITMENT_V1_EXTENSION_URI],
    },
  });
  if (response.task === undefined) {
    throw new Error("Hosted agent returned a message instead of a Task");
  }
  return response.task;
}

function roleForOutput(
  pact: Pact,
  outputType: "accessibility-findings" | "remediation-plan",
  expectedAgentId: string,
): Pact["roleSlots"][number] {
  const output = pact.requiredOutputs.find(
    (candidate) => candidate.type === outputType,
  );
  const slot = pact.roleSlots.find(
    (candidate) =>
      output !== undefined &&
      candidate.requiredOutputIds.includes(output.outputId),
  );
  if (slot === undefined || slot.originalAgentId !== expectedAgentId) {
    throw new Error(`Bound pact does not assign the hosted ${outputType} role`);
  }
  return slot;
}

function onlyCompletedArtifact(task: A2ATask): A2AArtifact {
  if (
    task.status.state !== "TASK_STATE_COMPLETED" ||
    task.artifacts.length !== 1
  ) {
    throw new Error(
      `Expected one completed artifact, received ${task.status.state}`,
    );
  }
  return task.artifacts[0]!;
}

function artifactSubmission(
  artifact: A2AArtifact,
  outputId: string,
  dependencyArtifactIds: readonly string[],
): ArtifactSubmission {
  const contentPart = artifact.parts.find(
    (
      part,
    ): part is Extract<(typeof artifact.parts)[number], { data: unknown }> =>
      "data" in part,
  );
  const metadata = ArtifactMetadataSchema.parse(
    record(record(artifact.metadata)[COMMITMENT_V1_EXTENSION_URI]),
  );
  if (contentPart === undefined || !isRecord(contentPart.data)) {
    throw new Error("Hosted artifact requires one public JSON object");
  }
  return {
    outputId,
    metadata,
    content: contentPart.data,
    dependencyArtifactIds: [...dependencyArtifactIds],
  };
}

async function artifactCommand(
  env: GuildhallEnv,
  packet: MissionSnapshotWithDefinition,
  artifact: ArtifactSubmission,
  source: "a2a",
): Promise<CoordinatorCommand> {
  return {
    commandId: await deterministicUuid(
      `${artifact.metadata.artifactId}:${artifact.metadata.attempt}`,
    ),
    expectedSequence: packet.latestSequence,
    actor: {
      agentId: artifact.metadata.producingAgentId,
      ownerId: await publicOwnerId(env, artifact.metadata.producingAgentId),
      keyId: artifact.metadata.keyId,
    },
    source,
    issuedAt: artifact.metadata.completedAt,
    command: {
      type: "submit_artifact",
      roleSlotId: artifact.metadata.roleSlotId,
      artifact,
    },
  };
}

async function publicOwnerId(
  env: GuildhallEnv,
  agentId: string,
): Promise<string> {
  const owner = await env.GUILD_DB.prepare(
    `SELECT o.github_user_id
     FROM agents a
     JOIN owners o ON o.owner_id = a.owner_id
     WHERE a.agent_id = ? LIMIT 1`,
  )
    .bind(agentId)
    .first<{ github_user_id: number }>();
  if (
    owner === null ||
    !Number.isSafeInteger(owner.github_user_id) ||
    owner.github_user_id < 1
  ) {
    throw new Error("Hosted execution agent has no canonical public owner");
  }
  return `github:${owner.github_user_id}`;
}

function correctionAttempt(packet: MissionSnapshotWithDefinition): 1 | 2 {
  return packet.snapshot.correctionCount === 0 ? 1 : 2;
}

async function deterministicUuid(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function systemCommand(
  packet: MissionSnapshotWithDefinition,
  command: CoordinatorCommand["command"],
  commandId: string,
  issuedAt: string,
): CoordinatorCommand {
  return {
    commandId,
    expectedSequence: packet.latestSequence,
    actor: null,
    source: "system",
    issuedAt,
    command,
  };
}

function acceptedOutput(
  packet: MissionSnapshotWithDefinition,
  outputId: string,
): ArtifactSubmission | null {
  if (!packet.snapshot.deliveredOutputIds.includes(outputId)) return null;
  const record = [...packet.artifacts]
    .filter((artifact) => artifact.outputId === outputId)
    .sort(
      (left, right) =>
        right.metadata.attempt - left.metadata.attempt ||
        right.acceptedSequence - left.acceptedSequence,
    )[0];
  if (record === undefined) return null;
  const {
    acceptedAt: _acceptedAt,
    acceptedSequence: _sequence,
    ...artifact
  } = record;
  return artifact;
}

function controlledScribeFailure(task: A2ATask): {
  readonly taskId: string;
  readonly taskState: "TASK_STATE_FAILED";
  readonly errorCode: string;
  readonly failureFixture: string;
  readonly retryable: false;
  readonly observedAt: string;
} {
  const observedAt = task.status.timestamp;
  if (
    task.status.state !== "TASK_STATE_FAILED" ||
    task.metadata.executionErrorCode !== "SCRIBE_CONTROLLED_FAILURE" ||
    task.metadata.failureFixture !== "scribe-controlled-failure-v1" ||
    task.metadata.retryable !== false ||
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new Error("Scribe failure did not match the controlled fixture");
  }
  return {
    taskId: task.id,
    taskState: "TASK_STATE_FAILED",
    errorCode: "SCRIBE_CONTROLLED_FAILURE",
    failureFixture: "scribe-controlled-failure-v1",
    retryable: false,
    observedAt,
  };
}

async function requireAccepted(
  resultPromise: Promise<{ readonly ok: boolean; readonly code?: string }>,
  operation: string,
): Promise<void> {
  const result = await resultPromise;
  if (!result.ok)
    throw new Error(`${operation} failed: ${result.code ?? "unknown"}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an A2A metadata object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
