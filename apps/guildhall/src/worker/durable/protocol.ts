import type {
  LifecycleCommand,
  LifecycleState,
  TransitionFailureCode,
} from "@guildhall/mission-engine";
import {
  ArtifactSubmissionSchema,
  PactSchema,
  ReplacementProofSchema,
  type ArtifactSubmission,
  type MissionEvent,
  type Receipt,
  type ReplacementProof,
  type VerificationResult,
} from "@guildhall/contracts";

export type ProvenanceSource = "webmcp" | "mcp" | "a2a" | "http" | "system";

export interface CommandActor {
  readonly agentId: string;
  readonly ownerId?: string;
  readonly keyId?: string;
}

/**
 * Internal command accepted by MissionCoordinator after an adapter has
 * authenticated and normalized a WebMCP, A2A, MCP, HTTP, or system request.
 */
export interface CoordinatorCommand {
  readonly commandId: string;
  readonly expectedSequence?: number;
  readonly actor: CommandActor | null;
  readonly source: ProvenanceSource;
  readonly issuedAt: string;
  readonly command: LifecycleCommand;
}

export interface AcceptedCommandResult {
  readonly ok: true;
  readonly commandId: string;
  readonly requestHash: string;
  readonly resultingSequence: number;
  readonly eventTypes: readonly string[];
  readonly projectionEnqueued: true;
}

export interface RejectedCommandResult {
  readonly ok: false;
  readonly commandId: string;
  readonly requestHash: string;
  readonly resultingSequence: number;
  readonly code:
    | TransitionFailureCode
    | "EXPECTED_SEQUENCE_MISMATCH"
    | "COMMAND_ID_REUSED"
    | "INVALID_COMMAND"
    | "ARTIFACT_PROOF_INVALID"
    | "PACT_PROOF_INVALID"
    | "PUBLIC_SAFETY_REJECTED"
    | "REPLACEMENT_PROOF_INVALID"
    | "MISSION_NOT_INITIALIZED";
  readonly expectedSequence?: number;
  readonly actualSequence?: number;
  readonly safetyIssue?: Readonly<{
    fieldPath: string;
    category: string;
  }>;
}

export type CoordinatorCommandResult =
  AcceptedCommandResult | RejectedCommandResult;

export interface MissionSnapshotPacket {
  readonly missionId: string;
  readonly snapshot: LifecycleState;
  readonly events: readonly MissionEvent[];
  readonly afterSequence: number;
  readonly latestSequence: number;
  readonly artifacts?: readonly AcceptedArtifactRecord[];
  readonly replacements?: readonly ReplacementProof[];
  readonly verificationRuns?: readonly VerificationResult[];
  readonly receipt?: Receipt | null;
}

export interface AcceptedArtifactRecord extends ArtifactSubmission {
  readonly acceptedAt: string;
  readonly acceptedSequence: number;
}

export interface CoordinatorInspection {
  readonly snapshot: LifecycleState | null;
  readonly events: readonly MissionEvent[];
  readonly commandResults: readonly {
    commandId: string;
    requestHash: string;
    resultingSequence: number;
    response: CoordinatorCommandResult;
  }[];
  readonly effectOutbox: readonly OutboxInspectionRow[];
  readonly projectionOutbox: readonly OutboxInspectionRow[];
  readonly scheduledAlarm: number | null;
}

export interface OutboxInspectionRow {
  readonly id: number;
  readonly type: string;
  readonly sourceSequence: number;
  readonly status: "pending" | "complete";
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly completedAt: string | null;
}

const allowedSources = new Set<ProvenanceSource>([
  "webmcp",
  "mcp",
  "a2a",
  "http",
  "system",
]);

export function isCoordinatorCommand(
  value: unknown,
): value is CoordinatorCommand {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "commandId",
      "expectedSequence",
      "actor",
      "source",
      "issuedAt",
      "command",
    ]) ||
    typeof value.commandId !== "string" ||
    value.commandId.length === 0 ||
    (value.expectedSequence !== undefined &&
      (typeof value.expectedSequence !== "number" ||
        !Number.isInteger(value.expectedSequence) ||
        value.expectedSequence < 0)) ||
    !allowedSources.has(value.source as ProvenanceSource) ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    !isLifecycleCommand(value.command)
  ) {
    return false;
  }

  return (
    value.actor === null ||
    (isRecord(value.actor) &&
      hasOnlyKeys(value.actor, ["agentId", "ownerId", "keyId"]) &&
      typeof value.actor.agentId === "string" &&
      value.actor.agentId.length > 0 &&
      (value.actor.ownerId === undefined ||
        (typeof value.actor.ownerId === "string" &&
          value.actor.ownerId.length > 0)) &&
      (value.actor.keyId === undefined ||
        (typeof value.actor.keyId === "string" &&
          value.actor.keyId.length > 0)))
  );
}

function isLifecycleCommand(value: unknown): value is LifecycleCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "publish":
    case "negotiation_timeout":
    case "revise_mission":
    case "start_execution":
    case "mark_overdue":
    case "verify":
    case "verifier_unavailable":
    case "verification_passed":
    case "safety_pause":
    case "safety_reject":
    case "cancel":
    case "expire":
      return hasOnlyKeys(value, ["type"]);
    case "issue_receipt":
      return hasOnlyKeys(value, ["type", "receiptId"]) && uuid(value.receiptId);
    case "report_progress":
      return (
        hasOnlyKeys(value, [
          "type",
          "roleSlotId",
          "status",
          "summary",
          "completedOutputIds",
          "occurredAt",
        ]) &&
        nonEmpty(value.roleSlotId) &&
        (value.status === "working" ||
          value.status === "blocked" ||
          value.status === "ready-for-delivery") &&
        nonEmpty(value.summary) &&
        value.summary.length <= 1_000 &&
        Array.isArray(value.completedOutputIds) &&
        stringArray(value.completedOutputIds) &&
        value.completedOutputIds.length <= 8 &&
        typeof value.occurredAt === "string" &&
        Number.isFinite(Date.parse(value.occurredAt))
      );
    case "safety_redact":
      return (
        hasOnlyKeys(value, ["type", "redactedEventId"]) &&
        nonEmpty(value.redactedEventId)
      );
    case "apply":
      return (
        hasOnlyKeys(value, [
          "type",
          "agentId",
          "keyId",
          "missionVersion",
          "relevantCapabilities",
          "proposedContribution",
          "availability",
        ]) &&
        nonEmpty(value.agentId) &&
        uuid(value.keyId) &&
        positiveInteger(value.missionVersion) &&
        Array.isArray(value.relevantCapabilities) &&
        stringArray(value.relevantCapabilities) &&
        value.relevantCapabilities.length >= 1 &&
        value.relevantCapabilities.length <= 16 &&
        nonEmpty(value.proposedContribution) &&
        value.proposedContribution.length <= 2_000 &&
        isAvailability(value.availability)
      );
    case "withdraw":
      return hasOnlyKeys(value, ["type", "agentId"]) && nonEmpty(value.agentId);
    case "submit_capability_bid":
      return (
        hasOnlyKeys(value, [
          "type",
          "agentId",
          "keyId",
          "relevantCapabilities",
          "proposedContribution",
        ]) &&
        nonEmpty(value.agentId) &&
        uuid(value.keyId) &&
        Array.isArray(value.relevantCapabilities) &&
        stringArray(value.relevantCapabilities) &&
        value.relevantCapabilities.length >= 1 &&
        value.relevantCapabilities.length <= 16 &&
        nonEmpty(value.proposedContribution) &&
        value.proposedContribution.length <= 2_000
      );
    case "accept_pact":
      return (
        hasOnlyKeys(value, [
          "type",
          "acceptanceId",
          "agentId",
          "keyId",
          "pactVersion",
          "pactDigest",
          "signature",
          "acceptedAt",
        ]) &&
        uuid(value.acceptanceId) &&
        nonEmpty(value.agentId) &&
        uuid(value.keyId) &&
        positiveInteger(value.pactVersion) &&
        /^[A-Za-z0-9_-]{43}$/u.test(String(value.pactDigest)) &&
        /^[A-Za-z0-9_-]{86}$/u.test(String(value.signature)) &&
        typeof value.acceptedAt === "string" &&
        Number.isFinite(Date.parse(value.acceptedAt))
      );
    case "submit_proposal":
      return (
        hasOnlyKeys(value, [
          "type",
          "proposerAgentId",
          "proposalRound",
          "pactDigest",
          "pact",
        ]) &&
        nonEmpty(value.proposerAgentId) &&
        value.proposalRound === 1 &&
        /^[A-Za-z0-9_-]{43}$/u.test(String(value.pactDigest)) &&
        PactSchema.safeParse(value.pact).success
      );
    case "submit_assignment_proposal":
      return (
        hasOnlyKeys(value, [
          "type",
          "proposerAgentId",
          "keyId",
          "pactDigest",
          "pact",
        ]) &&
        nonEmpty(value.proposerAgentId) &&
        uuid(value.keyId) &&
        /^[A-Za-z0-9_-]{43}$/u.test(String(value.pactDigest)) &&
        PactSchema.safeParse(value.pact).success &&
        (value.pact as { pactVersion?: unknown }).pactVersion === 2
      );
    case "form_party":
      return (
        hasOnlyKeys(value, [
          "type",
          "helperIds",
          "roleSlots",
          "selectionEvidence",
          "minimumNotMet",
        ]) &&
        stringArray(value.helperIds) &&
        Array.isArray(value.roleSlots) &&
        value.roleSlots.every(isRuntimeRoleSlot) &&
        isSelectionEvidence(value.selectionEvidence) &&
        (value.minimumNotMet === undefined ||
          typeof value.minimumNotMet === "boolean")
      );
    case "release_role":
      return (
        hasOnlyKeys(value, ["type", "roleSlotId"]) && nonEmpty(value.roleSlotId)
      );
    case "default_role":
      return (
        hasOnlyKeys(value, ["type", "roleSlotId", "evidence"]) &&
        nonEmpty(value.roleSlotId) &&
        isRecord(value.evidence) &&
        hasOnlyKeys(value.evidence, [
          "taskId",
          "taskState",
          "errorCode",
          "failureFixture",
          "retryable",
          "observedAt",
        ]) &&
        nonEmpty(value.evidence.taskId) &&
        value.evidence.taskState === "TASK_STATE_FAILED" &&
        nonEmpty(value.evidence.errorCode) &&
        nonEmpty(value.evidence.failureFixture) &&
        value.evidence.retryable === false &&
        typeof value.evidence.observedAt === "string" &&
        Number.isFinite(Date.parse(value.evidence.observedAt))
      );
    case "submit_artifact":
      return (
        hasOnlyKeys(value, ["type", "roleSlotId", "artifact"]) &&
        nonEmpty(value.roleSlotId) &&
        ArtifactSubmissionSchema.safeParse(value.artifact).success
      );
    case "fill_role_slot":
      return (
        hasOnlyKeys(value, [
          "type",
          "roleSlotId",
          "predecessorAgentId",
          "replacementAgentId",
          "pactDigest",
          "proof",
        ]) &&
        nonEmpty(value.roleSlotId) &&
        nonEmpty(value.predecessorAgentId) &&
        nonEmpty(value.replacementAgentId) &&
        nonEmpty(value.pactDigest) &&
        ReplacementProofSchema.safeParse(value.proof).success
      );
    case "verification_failed":
      return (
        hasOnlyKeys(value, ["type", "failedRoleSlotIds"]) &&
        (value.failedRoleSlotIds === undefined ||
          stringArray(value.failedRoleSlotIds))
      );
    default:
      return false;
  }
}

function isRuntimeRoleSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "roleSlotId",
      "originalAgentId",
      "occupantAgentId",
      "status",
      "artifactRequired",
      "artifactDelivered",
    ]) &&
    nonEmpty(value.roleSlotId) &&
    nonEmpty(value.originalAgentId) &&
    nonEmpty(value.occupantAgentId) &&
    (value.status === "active" ||
      value.status === "defaulted" ||
      value.status === "released") &&
    typeof value.artifactRequired === "boolean" &&
    typeof value.artifactDelivered === "boolean"
  );
}

function isAvailability(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["availableFrom", "availableUntil"]) &&
    typeof value.availableFrom === "string" &&
    typeof value.availableUntil === "string" &&
    Number.isFinite(Date.parse(value.availableFrom)) &&
    Number.isFinite(Date.parse(value.availableUntil)) &&
    Date.parse(value.availableFrom) < Date.parse(value.availableUntil)
  );
}

function isSelectionEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "selectedAgentIds",
      "evidence",
      "targetHelperCount",
      "minimumSatisfied",
      "oneHelperFallbackUsed",
      "canProceed",
    ]) &&
    stringArray(value.selectedAgentIds) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isSelectionEvidenceRow) &&
    typeof value.targetHelperCount === "number" &&
    Number.isSafeInteger(value.targetHelperCount) &&
    typeof value.minimumSatisfied === "boolean" &&
    typeof value.oneHelperFallbackUsed === "boolean" &&
    typeof value.canProceed === "boolean"
  );
}

function isSelectionEvidenceRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    Array.isArray(value.matchedSkills) &&
    value.matchedSkills.every(nonEmpty) &&
    typeof value.applicationEventSequence === "number" &&
    Number.isSafeInteger(value.applicationEventSequence) &&
    typeof value.eligible === "boolean" &&
    typeof value.selected === "boolean"
  );
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(nonEmpty);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
