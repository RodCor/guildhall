import {
  ArtifactSubmissionSchema,
  MissionEventSchema,
  MissionSchema,
  PactAcceptanceSchema,
  ReplacementProofSchema,
  ReceiptSchema,
  artifactProofDigest,
  artifactSigningBytes,
  canonicalJsonDigest,
  importEd25519PrivateJwk,
  pactSigningBytes,
  receiptSigningBytes,
  replacementSigningBytes,
  signEd25519,
  unsignedReceiptProjection,
  verifyRegisteredEd25519Proof,
  type ArtifactSubmission,
  type Mission,
  type MissionEvent,
  type MissionStage,
  type Receipt,
  type ReplacementProof,
  type VerificationResult,
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
  canonicalJsonDigestSync,
  canonicalDigestSync,
  createRedactedPublicPayload,
  scanPublicPayload,
  verifyAccessibilityDungeon,
  ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST,
  ACCESSIBILITY_DUNGEON_FIXTURE_ID,
  ON_TIME_TIMELINESS_DELTA,
  OVERDUE_TIMELINESS_DELTA,
  POST_BIND_DEFAULT_RELIABILITY_DELTA,
  VERIFIED_REPLACEMENT_RELIABILITY_DELTA,
  VERIFIED_ROLE_RELIABILITY_DELTA,
} from "@guildhall/trust-engine";
import { DurableObject } from "cloudflare:workers";

import { executeBoundDemoMission } from "../executionOrchestrator.js";

import {
  projectMissionCatalog,
  projectReceipt,
  ensureCurrentIssuerKey,
  issuerPublicJwk,
  listAgentKeys,
  type MissionCatalogProjection,
} from "../repositories/index.js";
import { derivePartyFormation } from "../formation.js";
import type { GuildhallEnv } from "../types.js";
import type {
  CoordinatorCommand,
  CoordinatorCommandResult,
  CoordinatorInspection,
  AcceptedArtifactRecord,
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

interface MissionDefinitionRow {
  [key: string]: SqlStorageValue;
  mission_id: string;
  definition_json: string;
  definition_digest: string;
}

export type MissionSnapshotWithDefinition = MissionSnapshotPacket & {
  readonly definition: Mission | null;
  readonly artifacts: readonly AcceptedArtifactRecord[];
  readonly replacements: readonly ReplacementProof[];
  readonly verificationRuns: readonly VerificationResult[];
  readonly receipt: Receipt | null;
};

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

interface JsonRecordRow {
  [key: string]: SqlStorageValue;
  record_json: string;
}

interface ProofJsonRow {
  [key: string]: SqlStorageValue;
  proof_json: string;
}

interface ResultJsonRow {
  [key: string]: SqlStorageValue;
  result_json: string | null;
}

interface ReceiptJsonRow {
  [key: string]: SqlStorageValue;
  receipt_json: string;
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
  row_type?: string;
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
const A2A_RETRY_MS = 30_000;

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
    definition?: Mission,
  ): Promise<LifecycleState> {
    if (missionId.length === 0 || requesterAgentId.length === 0) {
      throw new TypeError("missionId and requesterAgentId are required");
    }

    const validatedDefinition =
      definition === undefined ? null : MissionSchema.parse(definition);
    if (
      validatedDefinition !== null &&
      (validatedDefinition.missionId !== missionId ||
        validatedDefinition.requesterAgentId !== requesterAgentId ||
        validatedDefinition.missionVersion !== 1)
    ) {
      throw new TypeError(
        "Mission definition identity must match initialization at version 1",
      );
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
        this.assertOrAttachDefinition(existing, validatedDefinition, now);
        return existing;
      }

      const initial = initialLifecycleState({ missionId, requesterAgentId });
      if (validatedDefinition !== null) {
        this.persistDefinition(validatedDefinition, now);
      }
      this.persistState(initial, now);
      this.enqueueProjection(initial, now);
      return initial;
    });

    await this.flushProjectionOutbox();
    await this.scheduleNextAlarm();
    return state;
  }

  /** Atomically fixes the immutable Mission and appends mission_published. */
  async publishMission(
    definition: Mission,
    input: CoordinatorCommand,
  ): Promise<CoordinatorCommandResult> {
    const mission = MissionSchema.parse(definition);
    if (
      input.command.type !== "publish" ||
      input.actor?.agentId !== mission.requesterAgentId
    ) {
      throw new TypeError(
        "Publication command must match the mission requester",
      );
    }
    const now = new Date().toISOString();
    const requestHash = coordinatorRequestHash(input);
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.readState();
      if (existing === null) {
        const initial = initialLifecycleState({
          missionId: mission.missionId,
          requesterAgentId: mission.requesterAgentId,
        });
        this.persistDefinition(mission, now);
        this.persistState(initial, now);
      } else {
        if (
          existing.missionId !== mission.missionId ||
          existing.requesterAgentId !== mission.requesterAgentId
        ) {
          throw new Error("MissionCoordinator is already initialized");
        }
        this.assertOrAttachDefinition(existing, mission, now);
      }
      const response = this.executeCommandInOpenTransaction(
        input,
        requestHash,
        now,
      );
      if (response.ok) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO deadlines(deadline_type, due_at, handled_at)
           VALUES ('formation', ?, NULL)`,
          Date.parse(mission.formationDeadline),
        );
      }
      return response;
    });
    if (result.ok) {
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
    }
    await this.scheduleNextAlarm();
    return result;
  }

  async executeCommand(
    input: CoordinatorCommand,
  ): Promise<CoordinatorCommandResult> {
    const result = this.executeCommandTransaction(input);

    if (result.ok) {
      const state = this.readState();
      if (
        (state?.terminalOutcome === "canceled" ||
          state?.terminalOutcome === "expired") &&
        this.readReceipt() === null
      ) {
        await this.finalizeTerminalReceipt(state, null);
      }
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
    }
    await this.scheduleNextAlarm();

    return result;
  }

  /** Authenticated adapters use this before mutable-state authorization. */
  replayCommand(input: CoordinatorCommand): CoordinatorCommandResult | null {
    return this.replayResult(input);
  }

  /** Replay accepted pact proofs before requiring an active key for new ones. */
  async acceptPact(
    input: CoordinatorCommand,
  ): Promise<CoordinatorCommandResult> {
    const replay = this.replayResult(input);
    if (replay !== null) return replay;
    if (input.command.type !== "accept_pact" || input.actor === null) {
      return this.rejectBeforeTransition(input, "INVALID_COMMAND");
    }
    const acceptance = PactAcceptanceSchema.safeParse({
      protocol: "commitment/v1",
      kind: "acceptance",
      acceptanceId: input.command.acceptanceId,
      missionId: this.readState()?.missionId,
      pactVersion: input.command.pactVersion,
      agentId: input.command.agentId,
      keyId: input.command.keyId,
      pactDigest: input.command.pactDigest,
      signature: input.command.signature,
      acceptedAt: input.command.acceptedAt,
    });
    if (
      !acceptance.success ||
      acceptance.data.agentId !== input.actor.agentId ||
      acceptance.data.keyId !== input.actor.keyId ||
      Math.abs(Date.now() - Date.parse(acceptance.data.acceptedAt)) >
        5 * 60 * 1_000
    ) {
      return this.rejectBeforeTransition(input, "PACT_PROOF_INVALID");
    }
    const key = (
      await listAgentKeys(this.env.GUILD_DB, input.actor.agentId)
    ).find(
      (candidate) =>
        candidate.keyId === acceptance.data.keyId &&
        candidate.status === "active",
    );
    const proof =
      key === undefined
        ? null
        : await verifyRegisteredEd25519Proof({
            key: {
              keyId: key.keyId,
              publicJwk: key.publicJwk,
              status: "active",
            },
            proof: {
              keyId: acceptance.data.keyId,
              signature: acceptance.data.signature,
            },
            message: pactSigningBytes(acceptance.data.pactDigest),
            policy: { kind: "new-proof" },
          });
    if (proof?.valid !== true) {
      return this.rejectBeforeTransition(input, "PACT_PROOF_INVALID");
    }
    return this.executeCommand(input);
  }

  /** Verify and atomically persist one public artifact with its lifecycle event. */
  async submitArtifact(
    input: CoordinatorCommand,
  ): Promise<CoordinatorCommandResult> {
    const replay = this.replayResult(input);
    if (replay !== null) return replay;
    if (input.command.type !== "submit_artifact" || input.actor === null) {
      return this.rejectBeforeTransition(input, "INVALID_COMMAND");
    }
    const parsed = ArtifactSubmissionSchema.safeParse(input.command.artifact);
    if (!parsed.success) {
      return this.rejectBeforeTransition(input, "INVALID_COMMAND");
    }
    const artifact = parsed.data;
    const publicScan = scanPublicPayload({
      ...artifact,
      metadata: {
        ...artifact.metadata,
        signature: "[public-ed25519-signature]",
        safetyStatus: "approved-after-server-scan",
      },
    });
    if (!publicScan.safe) {
      return this.rejectBeforeTransition(input, "PUBLIC_SAFETY_REJECTED", {
        fieldPath: publicScan.fieldPath,
        category: publicScan.category,
      });
    }
    if (
      artifact.metadata.roleSlotId !== input.command.roleSlotId ||
      artifact.metadata.producingAgentId !== input.actor.agentId ||
      artifact.metadata.keyId !== input.actor.keyId ||
      canonicalJsonDigestSync(artifact.content) !==
        artifact.metadata.contentDigest
    ) {
      return this.rejectBeforeTransition(input, "ARTIFACT_PROOF_INVALID");
    }
    const key = (
      await listAgentKeys(this.env.GUILD_DB, input.actor.agentId)
    ).find(
      (candidate) =>
        candidate.keyId === artifact.metadata.keyId &&
        candidate.status === "active",
    );
    const proof =
      key === undefined
        ? null
        : await verifyRegisteredEd25519Proof({
            key: {
              keyId: key.keyId,
              publicJwk: key.publicJwk,
              status: "active",
            },
            proof: {
              keyId: artifact.metadata.keyId,
              signature: artifact.metadata.signature,
            },
            message: artifactSigningBytes(
              artifact.metadata.pactDigest,
              await artifactProofDigest(artifact),
            ),
            policy: { kind: "new-proof" },
          });
    if (proof?.valid !== true) {
      return this.rejectBeforeTransition(input, "ARTIFACT_PROOF_INVALID");
    }

    const requestHash = coordinatorRequestHash(input);
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const response = this.executeCommandInOpenTransaction(
        input,
        requestHash,
        now,
      );
      if (response.ok) {
        const record: AcceptedArtifactRecord = {
          ...artifact,
          acceptedAt: now,
          acceptedSequence: response.resultingSequence,
        };
        this.ctx.storage.sql.exec(
          `INSERT INTO artifact_records(
             artifact_id, attempt, role_slot_id, output_id, producing_agent_id,
             content_digest, record_json, accepted_sequence, accepted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          artifact.metadata.artifactId,
          artifact.metadata.attempt,
          artifact.metadata.roleSlotId,
          artifact.outputId,
          artifact.metadata.producingAgentId,
          artifact.metadata.contentDigest,
          JSON.stringify(record),
          response.resultingSequence,
          now,
        );
      }
      return response;
    });
    if (result.ok) {
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
    }
    await this.scheduleNextAlarm();
    return result;
  }

  /** Verify the replacement's active key before changing the exact slot ledger. */
  async bindReplacement(
    input: CoordinatorCommand,
  ): Promise<CoordinatorCommandResult> {
    const replay = this.replayResult(input);
    if (replay !== null) return replay;
    if (input.command.type !== "fill_role_slot" || input.actor === null) {
      return this.rejectBeforeTransition(input, "INVALID_COMMAND");
    }
    const parsed = ReplacementProofSchema.safeParse(input.command.proof);
    if (!parsed.success) {
      return this.rejectBeforeTransition(input, "INVALID_COMMAND");
    }
    const replacement = parsed.data;
    if (
      replacement.replacementAgentId !== input.actor.agentId ||
      replacement.keyId !== input.actor.keyId
    ) {
      return this.rejectBeforeTransition(input, "REPLACEMENT_PROOF_INVALID");
    }
    const state = this.readState();
    const requiredCapabilities = state?.candidatePact?.pact.roleSlots.find(
      (slot) => slot.roleSlotId === replacement.roleSlotId,
    )?.requiredCapabilities;
    if (
      state === null ||
      requiredCapabilities === undefined ||
      replacement.replacementAgentId === state.requesterAgentId
    ) {
      return this.rejectBeforeTransition(input, "REPLACEMENT_PROOF_INVALID");
    }
    const registeredCapabilities = new Set(
      (
        await this.env.GUILD_DB.prepare(
          `SELECT capability FROM agent_capabilities WHERE agent_id = ?`,
        )
          .bind(replacement.replacementAgentId)
          .all<{ capability: string }>()
      ).results.map((row) => row.capability),
    );
    if (
      !requiredCapabilities.every((capability) =>
        registeredCapabilities.has(capability),
      )
    ) {
      return this.rejectBeforeTransition(input, "REPLACEMENT_PROOF_INVALID");
    }
    const key = (
      await listAgentKeys(this.env.GUILD_DB, input.actor.agentId)
    ).find(
      (candidate) =>
        candidate.keyId === replacement.keyId && candidate.status === "active",
    );
    const proof =
      key === undefined
        ? null
        : await verifyRegisteredEd25519Proof({
            key: {
              keyId: key.keyId,
              publicJwk: key.publicJwk,
              status: "active",
            },
            proof: {
              keyId: replacement.keyId,
              signature: replacement.signature,
            },
            message: replacementSigningBytes(
              replacement.pactDigest,
              replacement.roleSlotId,
              replacement.predecessorAgentId,
            ),
            policy: { kind: "new-proof" },
          });
    if (proof?.valid !== true) {
      return this.rejectBeforeTransition(input, "REPLACEMENT_PROOF_INVALID");
    }

    const requestHash = coordinatorRequestHash(input);
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const response = this.executeCommandInOpenTransaction(
        input,
        requestHash,
        now,
      );
      if (response.ok) {
        this.ctx.storage.sql.exec(
          `INSERT INTO replacement_records(
             replacement_id, role_slot_id, predecessor_agent_id,
             replacement_agent_id, proof_json, accepted_sequence, accepted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          replacement.replacementId,
          replacement.roleSlotId,
          replacement.predecessorAgentId,
          replacement.replacementAgentId,
          JSON.stringify(replacement),
          response.resultingSequence,
          now,
        );
      }
      return response;
    });
    if (result.ok) {
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
    }
    await this.scheduleNextAlarm();
    return result;
  }

  /** Run the bounded verifier and issue a signed receipt only on a terminal result. */
  async runVerification(input: {
    readonly infrastructureStatus: "available" | "unavailable";
  }): Promise<{
    readonly verification: VerificationResult;
    readonly receipt: Receipt | null;
  }> {
    const existingReceipt = this.readReceipt();
    if (existingReceipt !== null) {
      const latest = this.readVerificationRuns().at(-1);
      if (latest === undefined) {
        throw new Error("Receipt exists without verification evidence");
      }
      return { verification: latest, receipt: existingReceipt };
    }

    let state = this.readState();
    if (state === null) {
      throw new Error("A mission is required for verification");
    }
    if (state.terminalOutcome !== null) {
      const latest = this.readVerificationRuns().at(-1) ?? null;
      const receipt = await this.finalizeTerminalReceipt(state, latest);
      if (latest === null) {
        throw new Error("Terminal verification mission lost its result");
      }
      return { verification: latest, receipt };
    }
    if (state.candidatePact === null) {
      throw new Error("A bound mission is required for verification");
    }
    if (state.stage === "DELIVER") {
      const started = await this.executeCommand({
        commandId: crypto.randomUUID(),
        expectedSequence: state.sequence,
        actor: null,
        source: "system",
        issuedAt: new Date().toISOString(),
        command: { type: "verify" },
      });
      if (!started.ok)
        throw new Error(`Verification start failed: ${started.code}`);
      state = this.readState()!;
    }
    if (state.stage !== "VERIFY") {
      throw new Error("Mission is not ready for verification");
    }
    if (state.candidatePact === null) {
      throw new Error("Verification lost its bound pact");
    }

    const candidatePact = state.candidatePact;
    const pact = candidatePact.pact;
    const artifacts = currentVerificationArtifacts(
      this.readArtifacts(),
      state.deliveredOutputIds,
    );
    const startedAt = new Date().toISOString();
    const verification = verifyAccessibilityDungeon({
      verificationRunId: crypto.randomUUID(),
      pact,
      pactDigest: candidatePact.pactDigest,
      attempt: (state.correctionCount + 1) as 1 | 2,
      fixture: {
        fixtureId: ACCESSIBILITY_DUNGEON_FIXTURE_ID,
        contentDigest: ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST,
        publicLocation: new URL(
          "/fixtures/accessibility-dungeon-v1",
          this.env.PUBLIC_ORIGIN,
        ).toString(),
      },
      artifacts,
      replacements: this.readReplacements(),
      infrastructureStatus: input.infrastructureStatus,
      startedAt,
      ...(input.infrastructureStatus === "available"
        ? { completedAt: new Date().toISOString() }
        : {}),
    });
    const failedRoleSlotIds = [
      ...new Set(
        verification.criteria
          .filter((criterion) => criterion.status === "failed")
          .flatMap((criterion) =>
            pact.roleSlots
              .filter((slot) =>
                slot.verificationCriterionIds.includes(criterion.criterionId),
              )
              .map((slot) => slot.roleSlotId),
          ),
      ),
    ];
    const lifecycleCommand: LifecycleCommand =
      verification.status === "infrastructure-pending"
        ? { type: "verifier_unavailable" }
        : verification.status === "passed"
          ? { type: "verification_passed" }
          : {
              type: "verification_failed",
              failedRoleSlotIds:
                failedRoleSlotIds.length > 0
                  ? failedRoleSlotIds
                  : state.roleSlots.map((slot) => slot.roleSlotId),
            };
    const command: CoordinatorCommand = {
      commandId: crypto.randomUUID(),
      expectedSequence: state.sequence,
      actor: null,
      source: "system",
      issuedAt: new Date().toISOString(),
      command: lifecycleCommand,
    };
    const requestHash = coordinatorRequestHash(command);
    const now = new Date().toISOString();
    const transitionResult = this.ctx.storage.transactionSync(() => {
      const response = this.executeCommandInOpenTransaction(
        command,
        requestHash,
        now,
      );
      if (response.ok) {
        this.ctx.storage.sql.exec(
          `INSERT INTO verification_runs(
             verification_id, status, sequence, result_json, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
          verification.verificationRunId,
          verification.status,
          response.resultingSequence,
          JSON.stringify(verification),
          now,
        );
      }
      return response;
    });
    if (!transitionResult.ok) {
      throw new Error(`Verification result failed: ${transitionResult.code}`);
    }

    const terminalState = this.readState()!;
    let receipt: Receipt | null = null;
    if (terminalState.terminalOutcome !== null) {
      receipt = await this.finalizeTerminalReceipt(terminalState, verification);
    }
    await this.flushEffectOutbox();
    await this.flushProjectionOutbox();
    await this.scheduleNextAlarm();
    return { verification, receipt };
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
        if (state.terminalOutcome === null && state.safety !== "paused") {
          const requestHash = coordinatorRequestHash(input.pauseCommand);
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
      if (outcome.missionCanceled && this.readReceipt() === null) {
        const state = this.readState();
        if (state !== null) await this.finalizeTerminalReceipt(state, null);
      }
      await this.flushEffectOutbox();
      await this.flushProjectionOutbox();
      this.broadcastRedaction(outcome.eventId, outcome.marker);
    }
    await this.scheduleNextAlarm();
    return outcome;
  }

  getSnapshot(afterSequence = 0): MissionSnapshotWithDefinition {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative safe integer");
    }
    const snapshot = this.readState();
    if (snapshot === null) {
      throw new Error("Mission is not initialized");
    }

    return {
      missionId: snapshot.missionId,
      definition: this.readDefinition(),
      snapshot,
      events: this.readEvents(afterSequence),
      afterSequence,
      latestSequence: snapshot.sequence,
      artifacts: this.readArtifacts(),
      replacements: this.readReplacements(),
      verificationRuns: this.readVerificationRuns(),
      receipt: this.readReceipt(),
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
      if (deadline.deadline_type === "a2a_retry") {
        let handled = false;
        try {
          const state = this.readState();
          if (state === null) {
            handled = true;
          } else {
            const result = await executeBoundDemoMission(
              this.env,
              state.missionId,
              true,
              globalThis.fetch,
              this,
            );
            handled = result.receiptId !== null;
          }
        } catch (error: unknown) {
          console.error(
            JSON.stringify({
              deadlineType: "a2a_retry",
              errorName: error instanceof Error ? error.name : "UnknownError",
              message: "durable demo execution retry failed",
            }),
          );
        }
        if (handled) {
          this.ctx.storage.sql.exec(
            `UPDATE deadlines SET handled_at = ?
             WHERE deadline_type = 'a2a_retry' AND handled_at IS NULL`,
            new Date().toISOString(),
          );
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE deadlines SET due_at = ?
             WHERE deadline_type = 'a2a_retry' AND handled_at IS NULL`,
            now + A2A_RETRY_MS,
          );
        }
        continue;
      }
      const command = await this.deadlineCommand(deadline);
      let handled = command === null;
      if (command !== null && this.readState() !== null) {
        const result = await this.executeCommand(command);
        handled = result.ok;
      }
      if (handled) {
        this.ctx.storage.sql.exec(
          `UPDATE deadlines SET handled_at = ?
           WHERE deadline_type = ? AND handled_at IS NULL`,
          new Date().toISOString(),
          deadline.deadline_type,
        );
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

  private replayResult(
    input: CoordinatorCommand,
  ): CoordinatorCommandResult | null {
    const requestHash = coordinatorRequestHash(input);
    const existing = this.ctx.storage.sql
      .exec<CommandResultRow>(
        `SELECT command_id, request_hash, response_json, resulting_sequence
         FROM command_results WHERE command_id = ? LIMIT 1`,
        input.commandId,
      )
      .toArray()[0];
    if (existing === undefined) return null;
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

  private rejectBeforeTransition(
    input: CoordinatorCommand,
    code: Extract<CoordinatorCommandResult, { ok: false }>["code"],
    safetyIssue?: Readonly<{ fieldPath: string; category: string }>,
  ): CoordinatorCommandResult {
    const requestHash = coordinatorRequestHash(input);
    return this.ctx.storage.transactionSync(() => {
      const replay = this.replayResult(input);
      if (replay !== null) return replay;
      return this.persistRejection(
        input.commandId,
        requestHash,
        this.readState()?.sequence ?? 0,
        code,
        new Date().toISOString(),
        undefined,
        undefined,
        safetyIssue,
      );
    });
  }

  private async finalizeTerminalReceipt(
    state: LifecycleState,
    verification: VerificationResult | null,
  ): Promise<Receipt> {
    const existing = this.readReceipt();
    if (existing !== null) return existing;
    if (state.terminalOutcome === null) {
      throw new Error("Cannot issue a receipt for a non-terminal mission");
    }
    if (state.receiptIssued) {
      throw new Error("Receipt event exists without its durable receipt");
    }
    const receipt = await this.createTerminalReceipt(state, verification);
    const issueCommand: CoordinatorCommand = {
      commandId: receipt.receiptId,
      expectedSequence: state.sequence,
      actor: null,
      source: "system",
      issuedAt: receipt.issuedAt,
      command: { type: "issue_receipt", receiptId: receipt.receiptId },
    };
    const requestHash = coordinatorRequestHash(issueCommand);
    const result = this.ctx.storage.transactionSync(() => {
      const response = this.executeCommandInOpenTransaction(
        issueCommand,
        requestHash,
        receipt.issuedAt,
      );
      if (!response.ok) return response;
      this.ctx.storage.sql.exec(
        `INSERT INTO mission_receipt(
           receipt_id, receipt_json, issued_sequence, issued_at
         ) VALUES (?, ?, ?, ?)`,
        receipt.receiptId,
        JSON.stringify(receipt),
        response.resultingSequence,
        receipt.issuedAt,
      );
      this.enqueueReceiptProjection(receipt, response.resultingSequence);
      return response;
    });
    if (!result.ok) throw new Error(`Receipt issuance failed: ${result.code}`);
    return receipt;
  }

  private async createTerminalReceipt(
    state: LifecycleState,
    verification: VerificationResult | null,
  ): Promise<Receipt> {
    const pact = state.candidatePact?.pact;
    const issuedAt = new Date().toISOString();
    const priorChainHead = this.ctx.storage.sql
      .exec<{ event_hash: string }>(
        `SELECT event_hash FROM events ORDER BY sequence DESC LIMIT 1`,
      )
      .toArray()[0]?.event_hash;
    if (priorChainHead === undefined) {
      throw new Error("Receipt requires an event head");
    }
    const receiptId = crypto.randomUUID();
    const receiptCommand = { type: "issue_receipt" as const, receiptId };
    const receiptEvent = appendMissionEvent({
      eventId: receiptId,
      missionId: state.missionId,
      sequence: state.sequence + 1,
      type: "receipt_issued",
      stage: "RECEIPT",
      displayState: deriveDisplayState(state),
      emittedAt: issuedAt,
      source: "system",
      actor: null,
      payload: {
        commandId: receiptId,
        expectedSequence: state.sequence,
        issuedAt,
        command: receiptCommand,
      },
      previousEventHash: priorChainHead,
    });
    const acceptedRecords = currentAcceptedArtifactRecords(
      this.readArtifacts(),
      state.deliveredOutputIds,
    );
    const acceptedArtifacts = acceptedRecords.map(
      ({ acceptedAt: _acceptedAt, acceptedSequence: _sequence, ...record }) =>
        ArtifactSubmissionSchema.parse(record),
    );
    const replacements = this.readReplacements();
    const replacementBySlot = new Map(
      replacements.map((replacement) => [replacement.roleSlotId, replacement]),
    );
    const defaults =
      pact === undefined
        ? []
        : this.readCanonicalEvents()
            .filter(
              (event) =>
                event.type === "role_defaulted" ||
                event.type === "role_released",
            )
            .map((event) => {
              const command = event.payload.command as {
                roleSlotId?: unknown;
                type?: unknown;
              };
              if (typeof command.roleSlotId !== "string") {
                throw new Error("Default event is missing its role slot");
              }
              const replacement = replacementBySlot.get(command.roleSlotId);
              const original = pact.roleSlots.find(
                (slot) => slot.roleSlotId === command.roleSlotId,
              );
              if (replacement === undefined && original === undefined) {
                throw new Error("Default event is outside the bound pact");
              }
              return {
                agentId:
                  replacement?.predecessorAgentId ?? original!.originalAgentId,
                roleSlotId: command.roleSlotId,
                reason:
                  event.type === "role_defaulted"
                    ? ("participant-defaulted" as const)
                    : ("participant-released" as const),
              };
            });
    const deliveryDeadline = pact?.deliveryDeadline ?? issuedAt;
    const deliveryCompletedAt =
      acceptedRecords
        .map((record) => record.acceptedAt)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ??
      issuedAt;
    const overdue =
      Date.parse(deliveryCompletedAt) > Date.parse(deliveryDeadline);
    const completed = state.terminalOutcome === "completed";
    const reputationDeltas: Receipt["reputationDeltas"][number][] = [];

    if (completed) {
      if (pact === undefined || verification === null) {
        throw new Error("Completed receipt requires pact and verification");
      }
      for (const slot of pact.roleSlots) {
        const producer = acceptedArtifacts.find(
          (artifact) => artifact.metadata.roleSlotId === slot.roleSlotId,
        )?.metadata.producingAgentId;
        if (producer === undefined) {
          throw new Error("Completed receipt is missing a bound role artifact");
        }
        const capabilities = [...slot.requiredCapabilities].sort();
        const allocations = divideInteger(
          slot.pointAllocation,
          capabilities.length,
        );
        const replacement = replacementBySlot.get(slot.roleSlotId);
        for (const [index, capability] of capabilities.entries()) {
          reputationDeltas.push({
            agentId: producer,
            capability,
            pointsDelta: allocations[index]!,
            reliabilityDelta:
              replacement === undefined
                ? VERIFIED_ROLE_RELIABILITY_DELTA
                : VERIFIED_REPLACEMENT_RELIABILITY_DELTA,
            timelinessDelta: overdue
              ? OVERDUE_TIMELINESS_DELTA
              : ON_TIME_TIMELINESS_DELTA,
            recoveryBonus: 0,
            reason:
              replacement === undefined
                ? "verified-role-output"
                : "verified-replacement-output",
          });
        }
      }
      const recoveryCandidates = reputationDeltas
        .map((delta, index) => ({ delta, index }))
        .filter(({ delta }) => delta.reason === "verified-replacement-output");
      const recovery = divideInteger(
        recoveryCandidates.length === 0
          ? 0
          : pact.reward.replacementRecoveryBonus,
        recoveryCandidates.length,
      );
      for (const [index, candidate] of recoveryCandidates.entries()) {
        const bonus = recovery[index]!;
        reputationDeltas[candidate.index] = {
          ...candidate.delta,
          pointsDelta: candidate.delta.pointsDelta + bonus,
          recoveryBonus: bonus,
        };
      }
    } else if (
      state.terminalOutcome === "failed" &&
      pact !== undefined &&
      verification !== null
    ) {
      const failedCriteria = new Set(
        verification.criteria
          .filter((criterion) => criterion.status === "failed")
          .map((criterion) => criterion.criterionId),
      );
      for (const slot of pact.roleSlots) {
        if (
          !slot.verificationCriterionIds.some((criterionId) =>
            failedCriteria.has(criterionId),
          )
        ) {
          continue;
        }
        const producer = acceptedArtifacts.find(
          (artifact) => artifact.metadata.roleSlotId === slot.roleSlotId,
        )?.metadata.producingAgentId;
        if (producer === undefined) continue;
        for (const capability of [...slot.requiredCapabilities].sort()) {
          reputationDeltas.push({
            agentId: producer,
            capability,
            pointsDelta: 0,
            reliabilityDelta: -0.02,
            timelinessDelta: overdue ? OVERDUE_TIMELINESS_DELTA : 0,
            recoveryBonus: 0,
            reason: replacementBySlot.has(slot.roleSlotId)
              ? "verified-replacement-output"
              : "verified-role-output",
          });
        }
      }
    }
    for (const entry of defaults) {
      const slot = pact!.roleSlots.find(
        (candidate) => candidate.roleSlotId === entry.roleSlotId,
      )!;
      for (const capability of [...slot.requiredCapabilities].sort()) {
        if (
          reputationDeltas.some(
            (delta) =>
              delta.agentId === entry.agentId &&
              delta.capability === capability,
          )
        ) {
          throw new Error("Receipt cannot merge default and success evidence");
        }
        reputationDeltas.push({
          agentId: entry.agentId,
          capability,
          pointsDelta: 0,
          reliabilityDelta: POST_BIND_DEFAULT_RELIABILITY_DELTA,
          timelinessDelta: 0,
          recoveryBonus: 0,
          reason: "post-bind-default",
        });
      }
    }

    const basePointsAwarded = completed
      ? pact!.roleSlots.reduce((total, slot) => total + slot.pointAllocation, 0)
      : 0;
    const recoveryBonusAwarded = completed
      ? reputationDeltas.reduce(
          (total, delta) => total + delta.recoveryBonus,
          0,
        )
      : 0;
    const issuerKeyId = this.requireIssuerKeyId();
    const issuerJwk = this.requireIssuerJwk();
    const publicIssuerJwk = issuerPublicJwk(issuerJwk);
    await ensureCurrentIssuerKey(this.env.GUILD_DB, {
      keyId: issuerKeyId,
      publicJwk: publicIssuerJwk,
      observedAt: issuedAt,
    });
    const unsigned = {
      protocol: "commitment/v1" as const,
      kind: "receipt" as const,
      receiptId,
      missionId: state.missionId,
      outcome: state.terminalOutcome!,
      pactDigest: state.candidatePact?.pactDigest ?? null,
      eventChainHead: receiptEvent.eventHash,
      artifacts: acceptedArtifacts.map((artifact) => ({
        artifactId: artifact.metadata.artifactId,
        roleSlotId: artifact.metadata.roleSlotId,
        producingAgentId: artifact.metadata.producingAgentId,
        contentDigest: artifact.metadata.contentDigest,
      })),
      verification:
        verification === null
          ? null
          : {
              verificationRunId: verification.verificationRunId,
              status:
                verification.status === "passed"
                  ? ("passed" as const)
                  : ("failed" as const),
              criterionResults: verification.criteria.map((criterion) => ({
                criterionId: criterion.criterionId,
                status: criterion.status,
              })),
            },
      timeliness: {
        overdue,
        deliveryDeadline,
        completedAt: deliveryCompletedAt,
      },
      defaults,
      replacements: replacements.map((replacement) => ({
        replacementId: replacement.replacementId,
        roleSlotId: replacement.roleSlotId,
        predecessorAgentId: replacement.predecessorAgentId,
        replacementAgentId: replacement.replacementAgentId,
      })),
      reward: {
        basePointsAwarded,
        recoveryBonusAwarded,
        totalPointsAwarded: basePointsAwarded + recoveryBonusAwarded,
        transferable: false as const,
        redeemable: false as const,
        monetaryValue: false as const,
      },
      reputationDeltas,
      issuerKeyId,
      issuedAt,
    };
    const privateKey = await importEd25519PrivateJwk(issuerJwk);
    const digest = await canonicalJsonDigest(unsigned);
    const issuerSignature = await signEd25519(
      privateKey,
      receiptSigningBytes(digest),
    );
    const receipt = ReceiptSchema.parse({ ...unsigned, issuerSignature });
    // Defensive assertion that the exact validated object is what was signed.
    if (
      (await canonicalJsonDigest(unsignedReceiptProjection(receipt))) !== digest
    ) {
      throw new Error("Receipt canonical projection changed during validation");
    }
    return receipt;
  }

  private requireIssuerKeyId(): string {
    if (this.env.GUILD_ISSUER_KEY_ID === undefined) {
      throw new Error("GUILD_ISSUER_KEY_ID is required to issue receipts");
    }
    return this.env.GUILD_ISSUER_KEY_ID;
  }

  private requireIssuerJwk(): JsonWebKey {
    if (this.env.GUILD_ISSUER_PRIVATE_JWK === undefined) {
      throw new Error("GUILD_ISSUER_PRIVATE_JWK is required to issue receipts");
    }
    const parsed = JSON.parse(this.env.GUILD_ISSUER_PRIVATE_JWK) as unknown;
    if (!isRecord(parsed)) throw new Error("Guild issuer JWK is malformed");
    return parsed as JsonWebKey;
  }

  private executeCommandTransaction(
    input: CoordinatorCommand,
  ): CoordinatorCommandResult {
    const requestHash = coordinatorRequestHash(input);
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
    if (
      reduced.events.includes("pact_bound") &&
      isReferenceDemoPact(reduced.state, this.env.PUBLIC_ORIGIN)
    ) {
      this.ctx.storage.sql.exec(
        `INSERT INTO deadlines(deadline_type, due_at, handled_at)
         VALUES ('a2a_retry', ?, NULL)
         ON CONFLICT(deadline_type) DO UPDATE SET
           due_at = excluded.due_at,
           handled_at = NULL`,
        Date.parse(now) + A2A_RETRY_MS,
      );
    }

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
    safetyIssue?: Readonly<{ fieldPath: string; category: string }>,
  ): CoordinatorCommandResult {
    const response: CoordinatorCommandResult = {
      ok: false,
      commandId,
      requestHash,
      resultingSequence: sequence,
      code,
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
      ...(actualSequence === undefined ? {} : { actualSequence }),
      ...(safetyIssue === undefined ? {} : { safetyIssue }),
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
        eventId:
          eventType === "receipt_issued" &&
          command.command.type === "issue_receipt"
            ? command.command.receiptId
            : crypto.randomUUID(),
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
          expectedSequence: command.expectedSequence ?? null,
          issuedAt: command.issuedAt,
          command: command.command,
          ...(command.proof === undefined
            ? {}
            : {
                commandProof: command.proof,
                commandProofMaterial: {
                  commandId: command.commandId,
                  action: command.proofAction ?? command.command.type,
                  missionId: after.missionId,
                  expectedSequence: command.expectedSequence,
                  actor:
                    command.actor === null
                      ? null
                      : {
                          agentId: command.actor.agentId,
                          keyId: command.actor.keyId,
                        },
                  issuedAt: command.issuedAt,
                  payload: structuredClone(
                    command.proofPayload ?? command.command,
                  ),
                },
                proofVerifiedAt: command.proofVerifiedAt,
                keyStatusCheckedAt: command.keyStatusCheckedAt,
              }),
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
        state.candidatePact.pact.pactVersion,
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

  private readCanonicalEvents(): MissionEvent[] {
    return this.ctx.storage.sql
      .exec<{ event_json: string }>(
        `SELECT event_json FROM events ORDER BY sequence`,
      )
      .toArray()
      .map((row) => MissionEventSchema.parse(JSON.parse(row.event_json)));
  }

  private readArtifacts(): AcceptedArtifactRecord[] {
    return this.ctx.storage.sql
      .exec<JsonRecordRow>(
        `SELECT record_json FROM artifact_records
         ORDER BY accepted_sequence, artifact_id, attempt`,
      )
      .toArray()
      .map((row) => {
        const stored = JSON.parse(row.record_json) as Record<string, unknown>;
        const { acceptedAt, acceptedSequence, ...submission } = stored;
        const artifact = ArtifactSubmissionSchema.parse(submission);
        if (
          typeof acceptedAt !== "string" ||
          !Number.isFinite(Date.parse(acceptedAt)) ||
          typeof acceptedSequence !== "number" ||
          !Number.isSafeInteger(acceptedSequence) ||
          acceptedSequence < 1
        ) {
          throw new Error("Stored artifact acceptance record is malformed");
        }
        return {
          ...artifact,
          acceptedAt,
          acceptedSequence,
        };
      });
  }

  private readReplacements(): ReplacementProof[] {
    return this.ctx.storage.sql
      .exec<ProofJsonRow>(
        `SELECT proof_json FROM replacement_records
         ORDER BY accepted_sequence, replacement_id`,
      )
      .toArray()
      .map((row) => ReplacementProofSchema.parse(JSON.parse(row.proof_json)));
  }

  private readVerificationRuns(): VerificationResult[] {
    return this.ctx.storage.sql
      .exec<ResultJsonRow>(
        `SELECT result_json FROM verification_runs
         WHERE result_json IS NOT NULL ORDER BY sequence, verification_id`,
      )
      .toArray()
      .map((row) => JSON.parse(row.result_json!) as VerificationResult);
  }

  private readReceipt(): Receipt | null {
    const row = this.ctx.storage.sql
      .exec<ReceiptJsonRow>(`SELECT receipt_json FROM mission_receipt LIMIT 1`)
      .toArray()[0];
    return row === undefined ? null : (JSON.parse(row.receipt_json) as Receipt);
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
    const projection = toCatalogProjection(state, this.readDefinition(), now);
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

  private enqueueReceiptProjection(
    receipt: Receipt,
    sourceSequence: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO projection_outbox(
         projection_type, payload_json, source_sequence, status, attempts,
         next_attempt_at
       ) VALUES ('receipt', ?, ?, 'pending', 0, ?)`,
      JSON.stringify(receipt),
      sourceSequence,
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
        `SELECT id, projection_type AS row_type, payload_json,
                source_sequence, attempts
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
        if (row.row_type === "receipt") {
          await projectReceipt(
            this.env.GUILD_DB,
            JSON.parse(row.payload_json),
            row.source_sequence,
            new Date().toISOString(),
          );
        } else {
          const projection = JSON.parse(
            row.payload_json,
          ) as MissionCatalogProjection;
          await projectMissionCatalog(this.env.GUILD_DB, projection);
        }
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

  private async deadlineCommand(
    deadline: DeadlineRow,
  ): Promise<CoordinatorCommand | null> {
    const state = this.readState();
    if (state === null) return null;
    let command: LifecycleCommand | null = null;
    if (deadline.deadline_type === "formation") {
      if (state.stage !== "PREPARE") return null;
      const mission = this.readDefinition();
      const derived =
        mission === null
          ? null
          : await derivePartyFormation(this.env.GUILD_DB, mission, state, true);
      command =
        derived === null
          ? { type: "expire" }
          : {
              type: "form_party",
              helperIds: derived.selection.selectedAgentIds,
              roleSlots: derived.roleSlots,
              selectionEvidence: derived.selection,
              ...(derived.selection.oneHelperFallbackUsed
                ? { minimumNotMet: true }
                : {}),
            };
    }
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

  private readDefinition(): Mission | null {
    const row = this.ctx.storage.sql
      .exec<MissionDefinitionRow>(
        `SELECT mission_id, definition_json, definition_digest
         FROM mission_definition LIMIT 1`,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const definition = MissionSchema.parse(JSON.parse(row.definition_json));
    if (
      definition.missionId !== row.mission_id ||
      canonicalDigestSync(definition) !== row.definition_digest
    ) {
      throw new Error("Stored mission definition failed integrity validation");
    }
    return definition;
  }

  private persistDefinition(definition: Mission, now: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO mission_definition(
         mission_id, definition_json, definition_digest, created_at
       ) VALUES (?, ?, ?, ?)`,
      definition.missionId,
      JSON.stringify(definition),
      canonicalDigestSync(definition),
      now,
    );
  }

  private assertOrAttachDefinition(
    state: LifecycleState,
    definition: Mission | null,
    now: string,
  ): void {
    if (definition === null) return;
    const existing = this.readDefinition();
    if (existing !== null) {
      if (canonicalDigestSync(existing) !== canonicalDigestSync(definition)) {
        throw new Error("Mission definition is immutable");
      }
      return;
    }
    if (state.sequence !== 0 || state.stage !== "DRAFT") {
      throw new Error(
        "Mission definition cannot be attached after publication",
      );
    }
    this.persistDefinition(definition, now);
    this.enqueueProjection(state, now);
  }
}

function isReferenceDemoPact(
  state: LifecycleState,
  publicOrigin: string,
): boolean {
  const inputs = state.candidatePact?.pact.publicInputs ?? [];
  return (
    inputs.length === 1 &&
    inputs[0]?.type === "url" &&
    inputs[0].mediaType === "text/html" &&
    inputs[0].contentDigest === ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST &&
    inputs[0].location ===
      new URL("/fixtures/accessibility-dungeon-v1", publicOrigin).toString()
  );
}

function toCatalogProjection(
  state: LifecycleState,
  definition: Mission | null,
  projectedAt: string,
): MissionCatalogProjection {
  return {
    missionId: state.missionId,
    missionVersion: state.missionVersion,
    requesterAgentId: state.requesterAgentId,
    lifecycleState: state.stage,
    displayState: deriveDisplayState(state),
    title: definition?.title ?? null,
    summary: definition?.goal ?? null,
    difficulty: definition?.difficulty ?? null,
    pointReward: definition?.pointReward ?? null,
    minimumPartySize: definition?.minimumPartySize ?? null,
    preferredPartySize: definition?.preferredPartySize ?? null,
    maximumPartySize: definition?.maximumPartySize ?? null,
    requiredCapabilities: definition?.requiredCapabilities ?? [],
    participantAgentIds: [
      state.requesterAgentId,
      ...state.roleSlots.map((slot) => slot.occupantAgentId),
    ],
    pactDigest: state.candidatePact?.pactDigest ?? null,
    formationDeadline: definition?.formationDeadline ?? null,
    deliveryDeadline: definition?.deliveryDeadline ?? null,
    publishedAt: definition?.publishedAt ?? null,
    terminalAt: state.terminalOutcome === null ? null : projectedAt,
    projection: { ...state, definition },
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

function currentVerificationArtifacts(
  records: readonly AcceptedArtifactRecord[],
  deliveredOutputIds: readonly string[],
): ArtifactSubmission[] {
  return currentAcceptedArtifactRecords(records, deliveredOutputIds).map(
    ({ acceptedAt: _acceptedAt, acceptedSequence: _sequence, ...record }) =>
      ArtifactSubmissionSchema.parse(record),
  );
}

function currentAcceptedArtifactRecords(
  records: readonly AcceptedArtifactRecord[],
  deliveredOutputIds: readonly string[],
): AcceptedArtifactRecord[] {
  const delivered = new Set(deliveredOutputIds);
  const byOutput = new Map<string, AcceptedArtifactRecord>();
  for (const record of records) {
    if (!delivered.has(record.outputId)) continue;
    const current = byOutput.get(record.outputId);
    if (
      current === undefined ||
      record.metadata.attempt > current.metadata.attempt ||
      (record.metadata.attempt === current.metadata.attempt &&
        record.acceptedSequence > current.acceptedSequence)
    ) {
      byOutput.set(record.outputId, record);
    }
  }
  return [...byOutput.values()].sort((left, right) =>
    left.outputId.localeCompare(right.outputId),
  );
}

function divideInteger(total: number, count: number): number[] {
  if (count === 0) {
    if (total !== 0)
      throw new Error("Cannot allocate points without recipients");
    return [];
  }
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Server verification time is audit metadata, not part of client command identity. */
function coordinatorRequestHash(input: CoordinatorCommand): string {
  const {
    proofVerifiedAt: _proofVerifiedAt,
    keyStatusCheckedAt: _keyStatusCheckedAt,
    ...semanticCommand
  } = input;
  if (semanticCommand.proof !== undefined) {
    return canonicalDigestSync(semanticCommand);
  }
  const { issuedAt: _issuedAt, ...unsignedInternalCommand } = semanticCommand;
  return canonicalDigestSync(unsignedInternalCommand);
}
