import {
  ReceiptSchema,
  canonicalJson,
  type Receipt,
} from "@guildhall/contracts";
import { deriveReceiptReputation } from "@guildhall/trust-engine";

export interface ReceiptProjectionWrite {
  readonly applied: boolean;
  readonly receiptId: string;
}

/**
 * Project one terminal receipt and its score deltas as a single D1 batch.
 * Every mutation is guarded by the stored canonical receipt and its durable
 * `(receipt, agent, capability)` application marker, so exact replay is a no-op.
 */
export async function projectReceipt(
  database: D1Database,
  receiptInput: unknown,
  lastSequence: number,
  projectedAt: string,
): Promise<ReceiptProjectionWrite> {
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 1) {
    throw new RangeError("Receipt projection sequence must be positive");
  }
  const receipt = ReceiptSchema.parse(receiptInput);
  const projection = deriveReceiptReputation(receipt);
  const receiptJson = canonicalJson(receipt);
  const existing = await database
    .prepare(
      `SELECT receipt_json FROM receipts
       WHERE receipt_id = ? OR mission_id = ? LIMIT 1`,
    )
    .bind(receipt.receiptId, receipt.missionId)
    .first<{ receipt_json: string }>();
  if (existing !== null) {
    if (canonicalJson(JSON.parse(existing.receipt_json)) !== receiptJson) {
      throw new Error("Receipt identity conflicts with a different receipt");
    }
    return { applied: false, receiptId: receipt.receiptId };
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT OR IGNORE INTO receipts(
           receipt_id, mission_id, outcome, pact_digest, event_chain_head,
           receipt_json, last_sequence, issued_at, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        receipt.receiptId,
        receipt.missionId,
        receipt.outcome,
        receipt.pactDigest,
        receipt.eventChainHead,
        receiptJson,
        lastSequence,
        receipt.issuedAt,
        projectedAt,
      ),
  ];

  for (const update of projection.capabilityUpdates) {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO agent_capabilities(
             agent_id, capability, declared_level, verified_points,
             verified_missions, reliability, timeliness, updated_at
           )
           SELECT agent_id, ?, 0, 0, 0, 0, 0, ?
           FROM agents
           WHERE agent_id = ?
             AND EXISTS (
               SELECT 1 FROM receipts
               WHERE receipt_id = ? AND receipt_json = ?
             )`,
        )
        .bind(
          update.capability,
          projectedAt,
          update.agentId,
          receipt.receiptId,
          receiptJson,
        ),
    );
    statements.push(
      database
        .prepare(
          `UPDATE agent_capabilities
           SET verified_points = verified_points + ?,
               verified_missions = verified_missions + ?,
               reliability = MAX(0, MIN(1, reliability + ?)),
               timeliness = MAX(0, MIN(1, timeliness + ?)),
               updated_at = ?
           WHERE agent_id = ? AND capability = ?
             AND EXISTS (
               SELECT 1 FROM receipts
               WHERE receipt_id = ? AND receipt_json = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM receipt_deltas
               WHERE receipt_id = ? AND agent_id = ? AND capability = ?
             )`,
        )
        .bind(
          update.pointsDelta,
          update.verifiedMissionsDelta,
          update.reliabilityDelta,
          update.timelinessDelta,
          projectedAt,
          update.agentId,
          update.capability,
          receipt.receiptId,
          receiptJson,
          receipt.receiptId,
          update.agentId,
          update.capability,
        ),
    );
  }

  for (const update of projection.agentUpdates) {
    statements.push(
      database
        .prepare(
          `UPDATE agents
           SET total_points = total_points + ?,
               completed_missions = completed_missions + ?,
               updated_at = ?
           WHERE agent_id = ?
             AND EXISTS (
               SELECT 1 FROM receipts
               WHERE receipt_id = ? AND receipt_json = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM receipt_deltas
               WHERE receipt_id = ? AND agent_id = ?
             )`,
        )
        .bind(
          update.pointsDelta,
          update.completedMissionsDelta,
          projectedAt,
          update.agentId,
          receipt.receiptId,
          receiptJson,
          receipt.receiptId,
          update.agentId,
        ),
    );
  }

  for (const delta of receipt.reputationDeltas) {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO receipt_deltas(
             receipt_id, agent_id, capability, points_delta,
             reliability_delta, timeliness_delta, recovery_bonus, reason,
             applied_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM receipts
             WHERE receipt_id = ? AND receipt_json = ?
           )`,
        )
        .bind(
          receipt.receiptId,
          delta.agentId,
          delta.capability,
          delta.pointsDelta,
          delta.reliabilityDelta,
          delta.timelinessDelta,
          delta.recoveryBonus,
          delta.reason,
          projectedAt,
          receipt.receiptId,
          receiptJson,
        ),
    );
  }

  await database.batch(statements);
  const stored = await database
    .prepare(`SELECT receipt_json FROM receipts WHERE receipt_id = ? LIMIT 1`)
    .bind(receipt.receiptId)
    .first<{ receipt_json: string }>();
  if (
    stored === null ||
    canonicalJson(JSON.parse(stored.receipt_json)) !== receiptJson
  ) {
    throw new Error("Receipt projection conflicted during atomic application");
  }
  return { applied: true, receiptId: receipt.receiptId };
}

export type { Receipt };
