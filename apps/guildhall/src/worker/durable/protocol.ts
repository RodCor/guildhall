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
    typeof value.commandId !== "string" ||
    value.commandId.length === 0 ||
    (value.expectedSequence !== undefined &&
      (typeof value.expectedSequence !== "number" ||
        !Number.isInteger(value.expectedSequence) ||
        value.expectedSequence < 0)) ||
    !allowedSources.has(value.source as ProvenanceSource) ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    !isRecord(value.command) ||
    typeof value.command.type !== "string"
  ) {
    return false;
  }

  return (
    value.actor === null ||
    (isRecord(value.actor) &&
      typeof value.actor.agentId === "string" &&
      value.actor.agentId.length > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
