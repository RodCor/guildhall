import {
  MissionEventSchema,
  type MissionEvent,
  type MissionStage,
} from "@guildhall/contracts";
import {
  deriveDisplayState,
  initialLifecycleState,
  transition,
  type LifecycleCommand,
  type LifecycleState,
} from "@guildhall/mission-engine";
import {
  appendMissionEvent,
  canonicalDigestSync,
  createRedactedPublicPayload,
} from "@guildhall/trust-engine";
import { DurableObject } from "cloudflare:workers";

import {
  projectMissionCatalog,
  type MissionCatalogProjection,
} from "../repositories/index.js";
import type { GuildhallEnv } from "../types.js";
import type {
  CoordinatorCommand,
  CoordinatorCommandResult,
  CoordinatorInspection,
  MissionSnapshotPacket,
  OutboxInspectionRow,
} from "./protocol.js";
import { isCoordinatorCommand } from "./protocol.js";
import { MISSION_COORDINATOR_SCHEMA } from "./schema.js";

interface MissionStateRow {
  [key: string]: SqlStorageValue;
  mission_id: string;
  state_json: string;
}

interface EventRow {
  [key: string]: SqlStorageValue;
  event_id: string;
  event_json: string;
  marker_json: string | null;
}

interface EventRedactionRow {
  [key: string]: SqlStorageValue;
  redaction_id: string;
  event_id: string;
  marker_json: string;
  redacted_at: string;
}

export type EmergencyEventRedactionResult =
  | {
      readonly ok: true;
      readonly redactionId: string;
      readonly eventId: string;
      readonly marker: ReturnType<typeof createRedactedPublicPayload>;
      readonly missionPaused: boolean;
      readonly missionCanceled: boolean;
      readonly resultingSequence: number;
      readonly replay: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "MISSION_NOT_INITIALIZED"
        | "EVENT_NOT_FOUND"
        | "EVENT_NOT_REDACTABLE"
        | "REDACTION_CONFLICT"
        | "EXPECTED_SEQUENCE_MISMATCH"
        | "SAFETY_PAUSE_REJECTED";
    };

interface CommandResultRow {
  [key: string]: SqlStorageValue;
  command_id: string;
  request_hash: string;
  response_json: string;
  resulting_sequence: number;
}

interface PendingOutboxRow {
  [key: string]: SqlStorageValue;
  id: number;
  payload_json: string;
  source_sequence: number;
  attempts: number;
}

interface DeadlineRow {
  [key: string]: SqlStorageValue;
  deadline_type: DeadlineType;
  due_at: number;
}

interface WebSocketAttachment {
  afterSequence: number;
}

export type DeadlineType =
  | "formation"
  | "negotiation"
  | "delivery"
  | "correction"
  | "a2a_retry"
  | "d1_retry";

const DEADLINE_TYPES = new Set<DeadlineType>([
  "formation",
  "negotiation",
  "delivery",
  "correction",
  "a2a_retry",
  "d1_retry",
]);

const PROJECTION_RETRY_BASE_MS = 1_000;

class RedactionPauseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * One SQLite-backed Durable Object owns each mission. All transition decisions,
 * event appends, idempotency records, and outbox writes happen in one
 * synchronous transaction before any network or D1 work begins.
 */
export class MissionCoordinator extends DurableObject<GuildhallEnv> {
  constructor(ctx: DurableObjectState, env: GuildhallEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(MISSION_COORDINATOR_SCHEMA);
  }

  async initializeMission(
    missionId: string,
    requesterAgentId: string,
  ): Promise<LifecycleState> {
    if (missionId.length === 0 || requesterAgentId.length === 0) {
      throw new TypeError("missionId and requesterAgentId are required");
    }

    const now = new Date().toISOString();
    const state = this.ctx.storage.transactionSync(() => {
      const existing = this.readState();
      if (existing !== null) {
        if (
          existing.missionId !== missionId ||
          existing.requesterAgentId !== requesterAgentId
        ) {
          throw new Error("MissionCoordinator is already initialized");
        }
        return existing;
      }

      const initial = initialLifecycleState({ missionId, requesterAgentId });
      this.persistState(initial, now);
      this.enqueueProjection(initial, now);
      return initial;
    });

    await this.flushProjectionOutbox();
    await this.scheduleNextAlarm();
    return state;
  }

  async executeCommand(
    input: CoordinatorCommand,
  ): Promise<CoordinatorCommandResult> {
    const result = this.executeCommandTransaction(input);

    if (result.ok) {
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
    }
    await this.scheduleNextAlarm();

    return result;
  }

  /**
   * Masks one public event and places the mission in the safety-paused state in
   * the same authoritative SQLite transaction. Event hashes remain immutable;
   * only the public payload projection is replaced with a marker.
   */
  async emergencyRedactEvent(input: {
    readonly redactionId: string;
    readonly eventId: string;
    readonly redactedAt: string;
    readonly pauseCommand: CoordinatorCommand;
  }): Promise<EmergencyEventRedactionResult> {
    const marker = createRedactedPublicPayload();
    let outcome: EmergencyEventRedactionResult;
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const byId = this.ctx.storage.sql
          .exec<EventRedactionRow>(
            `SELECT redaction_id, event_id, marker_json, redacted_at
           FROM event_redactions WHERE redaction_id = ? LIMIT 1`,
            input.redactionId,
          )
          .toArray()[0];
        if (byId !== undefined) {
          return byId.event_id === input.eventId
            ? ({
                ok: true,
                redactionId: byId.redaction_id,
                eventId: byId.event_id,
                marker: JSON.parse(byId.marker_json) as typeof marker,
                missionPaused: this.readState()?.terminalOutcome === null,
                missionCanceled:
                  this.readState()?.terminalOutcome === "canceled",
                resultingSequence: this.readState()?.sequence ?? 0,
                replay: true,
              } satisfies EmergencyEventRedactionResult)
            : ({ ok: false, code: "REDACTION_CONFLICT" } as const);
        }
        const byEvent = this.ctx.storage.sql
          .exec<EventRedactionRow>(
            `SELECT redaction_id, event_id, marker_json, redacted_at
           FROM event_redactions WHERE event_id = ? LIMIT 1`,
            input.eventId,
          )
          .toArray()[0];
        if (byEvent !== undefined) {
          return {
            ok: true,
            redactionId: byEvent.redaction_id,
            eventId: byEvent.event_id,
            marker: JSON.parse(byEvent.marker_json) as typeof marker,
            missionPaused: this.readState()?.terminalOutcome === null,
            missionCanceled: this.readState()?.terminalOutcome === "canceled",
            resultingSequence: this.readState()?.sequence ?? 0,
            replay: true,
          } satisfies EmergencyEventRedactionResult;
        }
        const state = this.readState();
        if (state === null) {
          return { ok: false, code: "MISSION_NOT_INITIALIZED" } as const;
        }
        const targetEvent = this.ctx.storage.sql
          .exec<{ event_type: string }>(
            `SELECT event_type FROM events WHERE event_id = ? LIMIT 1`,
            input.eventId,
          )
          .toArray()[0];
        if (targetEvent === undefined)
          return { ok: false, code: "EVENT_NOT_FOUND" } as const;
        if (targetEvent.event_type === "safety_redacted") {
          return { ok: false, code: "EVENT_NOT_REDACTABLE" } as const;
        }

        let resultingSequence = state.sequence;
        if (state.safety !== "paused") {
          const requestHash = canonicalDigestSync(input.pauseCommand);
          const pause = this.executeCommandInOpenTransaction(
            input.pauseCommand,
            requestHash,
            input.redactedAt,
          );
          if (!pause.ok) {
            throw new RedactionPauseError(pause.code);
          }
          resultingSequence = pause.resultingSequence;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO event_redactions(
           redaction_id, event_id, marker_json, redacted_at
         ) VALUES (?, ?, ?, ?)`,
          input.redactionId,
          input.eventId,
          JSON.stringify(marker),
          input.redactedAt,
        );
        const finalState = this.readState();
        return {
          ok: true,
          redactionId: input.redactionId,
          eventId: input.eventId,
          marker,
          missionPaused: finalState?.terminalOutcome === null,
          missionCanceled: finalState?.terminalOutcome === "canceled",
          resultingSequence,
          replay: false,
        } satisfies EmergencyEventRedactionResult;
      });
    } catch (error) {
      if (error instanceof RedactionPauseError) {
        return {
          ok: false,
          code:
            error.code === "EXPECTED_SEQUENCE_MISMATCH"
              ? "EXPECTED_SEQUENCE_MISMATCH"
              : "SAFETY_PAUSE_REJECTED",
        };
      }
      throw error;
    }

    if (outcome.ok) {
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
      this.broadcastRedaction(outcome.eventId, outcome.marker);
    }
    await this.scheduleNextAlarm();
    return outcome;
  }

  getSnapshot(afterSequence = 0): MissionSnapshotPacket {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative safe integer");
    }
    const snapshot = this.readState();
    if (snapshot === null) {
      throw new Error("Mission is not initialized");
    }

    return {
      missionId: snapshot.missionId,
      snapshot,
      events: this.readEvents(afterSequence),
      afterSequence,
      latestSequence: snapshot.sequence,
    };
  }

  async inspectCore(): Promise<CoordinatorInspection> {
    const commandResults = this.ctx.storage.sql
      .exec<CommandResultRow>(
        `SELECT command_id, request_hash, response_json, resulting_sequence
         FROM command_results ORDER BY rowid`,
      )
      .toArray()
      .map((row) => ({
        commandId: row.command_id,
        requestHash: row.request_hash,
        resultingSequence: row.resulting_sequence,
        response: JSON.parse(row.response_json) as CoordinatorCommandResult,
      }));

    return {
      snapshot: this.readState(),
      events: this.readEvents(0),
      commandResults,
      effectOutbox: this.inspectOutbox("effect_outbox", "effect_type"),
      projectionOutbox: this.inspectOutbox(
        "projection_outbox",
        "projection_type",
      ),
      scheduledAlarm: await this.ctx.storage.getAlarm(),
    };
  }

  async retryProjection(): Promise<{ pending: number; completed: number }> {
    this.ctx.storage.sql.exec(
      `UPDATE projection_outbox
       SET next_attempt_at = ?
       WHERE status = 'pending'`,
      Date.now(),
    );
    const completed = await this.flushProjectionOutbox(true);
    await this.scheduleNextAlarm();
    const pending = this.countPending("projection_outbox");
    return { pending, completed };
  }

  async scheduleDeadline(type: DeadlineType, dueAt: number): Promise<number> {
    if (!DEADLINE_TYPES.has(type)) {
      throw new TypeError(`Unsupported deadline type: ${type}`);
    }
    if (!Number.isSafeInteger(dueAt) || dueAt < 0) {
      throw new RangeError("dueAt must be a non-negative epoch millisecond");
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO deadlines(deadline_type, due_at, handled_at)
         VALUES (?, ?, NULL)
         ON CONFLICT(deadline_type) DO UPDATE SET
           due_at = excluded.due_at,
           handled_at = NULL`,
        type,
        dueAt,
      );
    });
    await this.scheduleNextAlarm();
    return (await this.ctx.storage.getAlarm()) ?? dueAt;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const deadlines = this.ctx.storage.sql
      .exec<DeadlineRow>(
        `SELECT deadline_type, due_at
         FROM deadlines
         WHERE handled_at IS NULL AND due_at <= ?
         ORDER BY due_at, deadline_type`,
        now,
      )
      .toArray();

    for (const deadline of deadlines) {
      this.ctx.storage.sql.exec(
        `UPDATE deadlines SET handled_at = ?
         WHERE deadline_type = ? AND handled_at IS NULL`,
        new Date().toISOString(),
        deadline.deadline_type,
      );
      const command = this.deadlineCommand(deadline);
      if (command !== null && this.readState() !== null) {
        await this.executeCommand(command);
      }
    }

    await this.flushEffectOutbox(true);
    await this.flushProjectionOutbox(true);
    await this.scheduleNextAlarm();
  }

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "This endpoint only accepts WebSocket upgrades" },
        { status: 426 },
      );
    }

    const url = new URL(request.url);
    const afterSequence = parseSequence(url.searchParams.get("after"));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["mission-read-model"]);
    server.serializeAttachment({ afterSequence } satisfies WebSocketAttachment);
    server.send(
      JSON.stringify({ type: "snapshot", ...this.getSnapshot(afterSequence) }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    if (typeof message !== "string") {
      ws.send(JSON.stringify({ type: "error", code: "READ_ONLY_STREAM" }));
      return;
    }

    try {
      const value = JSON.parse(message) as unknown;
      if (
        !isRecord(value) ||
        value.type !== "resume" ||
        typeof value.afterSequence !== "number"
      ) {
        ws.send(JSON.stringify({ type: "error", code: "READ_ONLY_STREAM" }));
        return;
      }
      const afterSequence = parseSequence(value.afterSequence);
      ws.serializeAttachment({ afterSequence } satisfies WebSocketAttachment);
      ws.send(
        JSON.stringify({
          type: "snapshot",
          ...this.getSnapshot(afterSequence),
        }),
      );
    } catch {
      ws.send(
        JSON.stringify({ type: "error", code: "INVALID_STREAM_REQUEST" }),
      );
    }
  }

  override webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): void {
    ws.close(code, reason);
  }

  private executeCommandTransaction(
    input: CoordinatorCommand,
  ): CoordinatorCommandResult {
    const requestHash = canonicalDigestSync(input);
    const now = new Date().toISOString();

    return this.ctx.storage.transactionSync(() =>
      this.executeCommandInOpenTransaction(input, requestHash, now),
    );
  }

  private executeCommandInOpenTransaction(
    input: CoordinatorCommand,
    requestHash: string,
    now: string,
  ): CoordinatorCommandResult {
    const existing = this.ctx.storage.sql
      .exec<CommandResultRow>(
        `SELECT command_id, request_hash, response_json, resulting_sequence
           FROM command_results WHERE command_id = ? LIMIT 1`,
        input.commandId,
      )
      .toArray()[0];
    if (existing !== undefined) {
      if (existing.request_hash === requestHash) {
        return JSON.parse(existing.response_json) as CoordinatorCommandResult;
      }
      return {
        ok: false,
        commandId: input.commandId,
        requestHash,
        resultingSequence: existing.resulting_sequence,
        code: "COMMAND_ID_REUSED",
      };
    }

    const state = this.readState();
    if (state === null) {
      return this.persistRejection(
        input.commandId,
        requestHash,
        0,
        "MISSION_NOT_INITIALIZED",
        now,
      );
    }

    if (!isCoordinatorCommand(input as unknown)) {
      return this.persistRejection(
        String(
          (input as unknown as { commandId?: unknown }).commandId ?? "invalid",
        ),
        requestHash,
        state.sequence,
        "INVALID_COMMAND",
        now,
      );
    }

    if (
      input.expectedSequence !== undefined &&
      input.expectedSequence !== state.sequence
    ) {
      return this.persistRejection(
        input.commandId,
        requestHash,
        state.sequence,
        "EXPECTED_SEQUENCE_MISMATCH",
        now,
        input.expectedSequence,
        state.sequence,
      );
    }

    let reduced: ReturnType<typeof transition>;
    try {
      reduced = transition(state, input.command);
    } catch {
      return this.persistRejection(
        input.commandId,
        requestHash,
        state.sequence,
        "INVALID_COMMAND",
        now,
      );
    }
    if (!reduced.ok) {
      return this.persistRejection(
        input.commandId,
        requestHash,
        state.sequence,
        reduced.code,
        now,
      );
    }

    const appendedEvents = this.appendEvents(
      state,
      reduced.state,
      reduced.events,
      input,
      now,
    );
    this.persistState(reduced.state, now);
    this.persistRelationalSnapshot(reduced.state, now);
    this.enqueueEffect(appendedEvents, reduced.state.sequence, now);
    this.enqueueProjection(reduced.state, now);

    const response: CoordinatorCommandResult = {
      ok: true,
      commandId: input.commandId,
      requestHash,
      resultingSequence: reduced.state.sequence,
      eventTypes: reduced.events,
      projectionEnqueued: true,
    };
    this.persistCommandResult(response, now);
    return response;
  }

  private persistRejection(
    commandId: string,
    requestHash: string,
    sequence: number,
    code: Extract<CoordinatorCommandResult, { ok: false }>["code"],
    now: string,
    expectedSequence?: number,
    actualSequence?: number,
  ): CoordinatorCommandResult {
    const response: CoordinatorCommandResult = {
      ok: false,
      commandId,
      requestHash,
      resultingSequence: sequence,
      code,
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
      ...(actualSequence === undefined ? {} : { actualSequence }),
    };
    this.persistCommandResult(response, now);
    return response;
  }

  private persistCommandResult(
    response: CoordinatorCommandResult,
    now: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO command_results(
         command_id, request_hash, response_json, resulting_sequence, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      response.commandId,
      response.requestHash,
      JSON.stringify(response),
      response.resultingSequence,
      now,
    );
  }

  private appendEvents(
    before: LifecycleState,
    after: LifecycleState,
    eventTypes: readonly string[],
    command: CoordinatorCommand,
    emittedAt: string,
  ): MissionEvent[] {
    const prior = this.ctx.storage.sql
      .exec<{ sequence: number; event_hash: string }>(
        `SELECT sequence, event_hash FROM events ORDER BY sequence DESC LIMIT 1`,
      )
      .toArray()[0];
    let previousEventHash = prior?.event_hash ?? null;
    let sequence = before.sequence;
    const events: MissionEvent[] = [];

    for (const eventType of eventTypes) {
      sequence += 1;
      const event = appendMissionEvent({
        eventId: crypto.randomUUID(),
        missionId: after.missionId,
        sequence,
        type: eventType,
        stage: eventStage(after.stage),
        displayState: deriveDisplayState(after),
        emittedAt,
        source: command.source,
        actor: completeActor(command),
        payload: {
          commandId: command.commandId,
          command: command.command,
        },
        previousEventHash,
      });
      MissionEventSchema.parse(event);
      this.ctx.storage.sql.exec(
        `INSERT INTO events(
           sequence, event_id, event_type, event_json, content_digest,
           previous_event_hash, event_hash, emitted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        event.sequence,
        event.eventId,
        event.type,
        JSON.stringify(event),
        event.contentDigest,
        event.previousEventHash,
        event.eventHash,
        event.emittedAt,
      );
      previousEventHash = event.eventHash;
      events.push(event);
    }

    if (sequence !== after.sequence) {
      throw new Error(
        "Reducer event sequence did not match appended event count",
      );
    }
    return events;
  }

  private readState(): LifecycleState | null {
    const row = this.ctx.storage.sql
      .exec<MissionStateRow>(
        `SELECT mission_id, state_json FROM mission_state LIMIT 1`,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : (JSON.parse(row.state_json) as LifecycleState);
  }

  private persistState(state: LifecycleState, now: string): void {
    const stateJson = JSON.stringify(state);
    this.ctx.storage.sql.exec(
      `INSERT INTO mission_state(
         mission_id, requester_agent_id, stage, display_state, sequence,
         state_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mission_id) DO UPDATE SET
         requester_agent_id = excluded.requester_agent_id,
         stage = excluded.stage,
         display_state = excluded.display_state,
         sequence = excluded.sequence,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
      state.missionId,
      state.requesterAgentId,
      state.stage,
      deriveDisplayState(state),
      state.sequence,
      stateJson,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO mission_versions(
         mission_id, mission_version, sequence, state_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      state.missionId,
      state.missionVersion,
      state.sequence,
      stateJson,
      now,
    );
  }

  private persistRelationalSnapshot(state: LifecycleState, now: string): void {
    this.ctx.storage.sql.exec("DELETE FROM applications");
    for (const agentId of state.applicationAgentIds) {
      this.ctx.storage.sql.exec(
        `INSERT INTO applications(agent_id, status, sequence, updated_at)
         VALUES (?, ?, ?, ?)`,
        agentId,
        state.selectedHelperIds.includes(agentId) ? "selected" : "applied",
        state.sequence,
        now,
      );
    }

    if (state.candidatePact !== null) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO pact_versions(
           pact_version, pact_digest, sequence, created_at
         ) VALUES (?, ?, ?, ?)`,
        state.candidatePact.pactVersion,
        state.candidatePact.pactDigest,
        state.sequence,
        now,
      );
    }

    this.ctx.storage.sql.exec("DELETE FROM pact_acceptances");
    for (const acceptance of Object.values(state.acceptances)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO pact_acceptances(
           acceptance_id, agent_id, key_id, pact_version, pact_digest,
           signature, accepted_at, sequence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        acceptance.acceptanceId,
        acceptance.agentId,
        acceptance.keyId,
        acceptance.pactVersion,
        acceptance.pactDigest,
        acceptance.signature,
        acceptance.acceptedAt,
        state.sequence,
      );
    }

    this.ctx.storage.sql.exec("DELETE FROM role_slots");
    for (const slot of state.roleSlots) {
      this.ctx.storage.sql.exec(
        `INSERT INTO role_slots(
           role_slot_id, original_agent_id, occupant_agent_id, status,
           artifact_required, artifact_delivered, sequence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        slot.roleSlotId,
        slot.originalAgentId,
        slot.occupantAgentId,
        slot.status,
        slot.artifactRequired ? 1 : 0,
        slot.artifactDelivered ? 1 : 0,
        state.sequence,
        now,
      );
    }
  }

  private readEvents(afterSequence: number): MissionEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT events.event_id, events.event_json,
                event_redactions.marker_json
         FROM events
         LEFT JOIN event_redactions
           ON event_redactions.event_id = events.event_id
         WHERE events.sequence > ? ORDER BY events.sequence`,
        afterSequence,
      )
      .toArray()
      .map((row) =>
        this.applyPublicRedaction(
          JSON.parse(row.event_json) as MissionEvent,
          row.marker_json,
        ),
      );
  }

  private applyPublicRedaction(
    event: MissionEvent,
    knownMarkerJson?: string | null,
  ): MissionEvent {
    const markerJson =
      knownMarkerJson ??
      this.ctx.storage.sql
        .exec<{ marker_json: string }>(
          `SELECT marker_json FROM event_redactions
           WHERE event_id = ? LIMIT 1`,
          event.eventId,
        )
        .toArray()[0]?.marker_json;
    return markerJson === undefined || markerJson === null
      ? event
      : {
          ...event,
          payload: JSON.parse(markerJson) as MissionEvent["payload"],
        };
  }

  private enqueueEffect(
    events: readonly MissionEvent[],
    sourceSequence: number,
    now: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO effect_outbox(
         effect_type, payload_json, source_sequence, status, attempts,
         next_attempt_at
       ) VALUES ('websocket_broadcast', ?, ?, 'pending', 0, ?)`,
      JSON.stringify({ events, enqueuedAt: now }),
      sourceSequence,
      Date.now(),
    );
  }

  private enqueueProjection(state: LifecycleState, now: string): void {
    const projection = toCatalogProjection(state, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO projection_outbox(
         projection_type, payload_json, source_sequence, status, attempts,
         next_attempt_at
       ) VALUES ('mission_catalog', ?, ?, 'pending', 0, ?)`,
      JSON.stringify(projection),
      state.sequence,
      Date.now(),
    );
  }

  private async flushEffectOutbox(force = false): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec<PendingOutboxRow>(
        `SELECT id, payload_json, source_sequence, attempts
         FROM effect_outbox
         WHERE status = 'pending' AND (? = 1 OR next_attempt_at <= ?)
         ORDER BY source_sequence, id`,
        force ? 1 : 0,
        Date.now(),
      )
      .toArray();
    let completed = 0;

    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as {
        events: MissionEvent[];
      };
      this.broadcastEvents(
        payload.events.map((event) => this.applyPublicRedaction(event)),
      );
      this.ctx.storage.sql.exec(
        `UPDATE effect_outbox
         SET status = 'complete', attempts = attempts + 1, completed_at = ?
         WHERE id = ? AND status = 'pending'`,
        new Date().toISOString(),
        row.id,
      );
      completed += 1;
    }
    return completed;
  }

  private async flushProjectionOutbox(force = false): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec<PendingOutboxRow>(
        `SELECT id, payload_json, source_sequence, attempts
         FROM projection_outbox
         WHERE status = 'pending' AND (? = 1 OR next_attempt_at <= ?)
         ORDER BY source_sequence, id`,
        force ? 1 : 0,
        Date.now(),
      )
      .toArray();
    let completed = 0;

    for (const row of rows) {
      try {
        const projection = JSON.parse(
          row.payload_json,
        ) as MissionCatalogProjection;
        await projectMissionCatalog(this.env.GUILD_DB, projection);
        this.ctx.storage.sql.exec(
          `UPDATE projection_outbox
           SET status = 'complete', attempts = attempts + 1, completed_at = ?
           WHERE id = ? AND status = 'pending'`,
          new Date().toISOString(),
          row.id,
        );
        completed += 1;
      } catch {
        const attempts = row.attempts + 1;
        const delay = Math.min(
          PROJECTION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
          5 * 60_000,
        );
        this.ctx.storage.sql.exec(
          `UPDATE projection_outbox
           SET attempts = ?, next_attempt_at = ?
           WHERE id = ? AND status = 'pending'`,
          attempts,
          Date.now() + delay,
          row.id,
        );
        break;
      }
    }
    return completed;
  }

  private broadcastEvents(events: readonly MissionEvent[]): void {
    if (events.length === 0) return;
    for (const ws of this.ctx.getWebSockets("mission-read-model")) {
      try {
        const attachment = readAttachment(ws);
        const delta = events.filter(
          (event) => event.sequence > attachment.afterSequence,
        );
        if (delta.length === 0) continue;
        ws.send(
          JSON.stringify({
            type: "events",
            events: delta,
            latestSequence: delta.at(-1)?.sequence ?? attachment.afterSequence,
          }),
        );
        ws.serializeAttachment({
          afterSequence: delta.at(-1)?.sequence ?? attachment.afterSequence,
        } satisfies WebSocketAttachment);
      } catch {
        ws.close(1011, "stream delivery failed");
      }
    }
  }

  private broadcastRedaction(
    eventId: string,
    marker: ReturnType<typeof createRedactedPublicPayload>,
  ): void {
    for (const ws of this.ctx.getWebSockets("mission-read-model")) {
      try {
        ws.send(
          JSON.stringify({ type: "redaction", eventId, payload: marker }),
        );
      } catch {
        ws.close(1011, "stream delivery failed");
      }
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ due_at: number | null }>(
        `SELECT MIN(due_at) AS due_at FROM (
           SELECT due_at FROM deadlines WHERE handled_at IS NULL
           UNION ALL
           SELECT next_attempt_at AS due_at FROM effect_outbox WHERE status = 'pending'
           UNION ALL
           SELECT next_attempt_at AS due_at FROM projection_outbox WHERE status = 'pending'
         )`,
      )
      .toArray()[0];
    if (row?.due_at === null || row?.due_at === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(row.due_at);
  }

  private deadlineCommand(deadline: DeadlineRow): CoordinatorCommand | null {
    const state = this.readState();
    if (state === null) return null;
    let command: LifecycleCommand | null = null;
    if (deadline.deadline_type === "formation") command = { type: "expire" };
    if (deadline.deadline_type === "negotiation") {
      command = { type: "negotiation_timeout" };
    }
    if (
      deadline.deadline_type === "delivery" ||
      deadline.deadline_type === "correction"
    ) {
      command = { type: "mark_overdue" };
    }
    if (command === null) return null;
    return {
      commandId: `deadline:${deadline.deadline_type}:${deadline.due_at}`,
      expectedSequence: state.sequence,
      actor: null,
      source: "system",
      issuedAt: new Date(deadline.due_at).toISOString(),
      command,
    };
  }

  private inspectOutbox(
    table: "effect_outbox" | "projection_outbox",
    typeColumn: "effect_type" | "projection_type",
  ): OutboxInspectionRow[] {
    return this.ctx.storage.sql
      .exec<{
        id: number;
        row_type: string;
        source_sequence: number;
        status: string;
        attempts: number;
        next_attempt_at: number;
        completed_at: string | null;
      }>(
        `SELECT id, ${typeColumn} AS row_type, source_sequence, status,
                attempts, next_attempt_at, completed_at
         FROM ${table} ORDER BY id`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        type: row.row_type,
        sourceSequence: row.source_sequence,
        status: row.status as "pending" | "complete",
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        completedAt: row.completed_at,
      }));
  }

  private countPending(table: "effect_outbox" | "projection_outbox"): number {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE status = 'pending'`,
        )
        .toArray()[0]?.count ?? 0
    );
  }
}

function toCatalogProjection(
  state: LifecycleState,
  projectedAt: string,
): MissionCatalogProjection {
  return {
    missionId: state.missionId,
    missionVersion: state.missionVersion,
    requesterAgentId: state.requesterAgentId,
    lifecycleState: state.stage,
    displayState: deriveDisplayState(state),
    participantAgentIds: [
      state.requesterAgentId,
      ...state.roleSlots.map((slot) => slot.occupantAgentId),
    ],
    pactDigest: state.candidatePact?.pactDigest ?? null,
    terminalAt: state.terminalOutcome === null ? null : projectedAt,
    projection: state,
    lastSequence: state.sequence,
    projectedAt,
  };
}

function completeActor(command: CoordinatorCommand): MissionEvent["actor"] {
  const actor = command.actor;
  if (
    actor === null ||
    actor.ownerId === undefined ||
    actor.keyId === undefined
  ) {
    return null;
  }
  return {
    agentId: actor.agentId,
    ownerId: actor.ownerId,
    keyId: actor.keyId,
  };
}

function eventStage(stage: LifecycleState["stage"]): MissionStage {
  return stage === "DRAFT" ? "PREPARE" : stage;
}

function readAttachment(ws: WebSocket): WebSocketAttachment {
  const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
  return attachment ?? { afterSequence: 0 };
}

function parseSequence(value: string | number | null): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("afterSequence must be a non-negative safe integer");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
