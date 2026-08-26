import type {
  LifecycleCommand,
  LifecycleState,
  TransitionFailureCode,
} from "@guildhall/mission-engine";
import type { MissionEvent } from "@guildhall/contracts";

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
    | "MISSION_NOT_INITIALIZED";
  readonly expectedSequence?: number;
  readonly actualSequence?: number;
}

export type CoordinatorCommandResult =
  AcceptedCommandResult | RejectedCommandResult;

export interface MissionSnapshotPacket {
  readonly missionId: string;
  readonly snapshot: LifecycleState;
  readonly events: readonly MissionEvent[];
  readonly afterSequence: number;
  readonly latestSequence: number;
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
    case "safety_redact":
      return (
        hasOnlyKeys(value, ["type", "redactedEventId"]) &&
        nonEmpty(value.redactedEventId)
      );
    case "apply":
    case "withdraw":
      return hasOnlyKeys(value, ["type", "agentId"]) && nonEmpty(value.agentId);
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
        hasOnlyKeys(value, ["type", "pactVersion", "pactDigest"]) &&
        positiveInteger(value.pactVersion) &&
        nonEmpty(value.pactDigest)
      );
    case "form_party":
      return (
        hasOnlyKeys(value, [
          "type",
          "helperIds",
          "roleSlots",
          "minimumNotMet",
        ]) &&
        stringArray(value.helperIds) &&
        Array.isArray(value.roleSlots) &&
        value.roleSlots.every(isRuntimeRoleSlot) &&
        (value.minimumNotMet === undefined ||
          typeof value.minimumNotMet === "boolean")
      );
    case "submit_artifact":
    case "default_role":
    case "release_role":
      return (
        hasOnlyKeys(value, ["type", "roleSlotId"]) && nonEmpty(value.roleSlotId)
      );
    case "fill_role_slot":
      return (
        hasOnlyKeys(value, [
          "type",
          "roleSlotId",
          "predecessorAgentId",
          "replacementAgentId",
          "pactDigest",
        ]) &&
        nonEmpty(value.roleSlotId) &&
        nonEmpty(value.predecessorAgentId) &&
        nonEmpty(value.replacementAgentId) &&
        nonEmpty(value.pactDigest)
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
