import { ReceiptSchema, type Receipt } from "@guildhall/contracts";

export const VERIFIED_ROLE_RELIABILITY_DELTA = 0.02;
export const VERIFIED_REPLACEMENT_RELIABILITY_DELTA = 0.03;
export const POST_BIND_DEFAULT_RELIABILITY_DELTA = -0.1;
export const ON_TIME_TIMELINESS_DELTA = 0.01;
export const OVERDUE_TIMELINESS_DELTA = -0.02;

type ReputationDelta = Receipt["reputationDeltas"][number];

export interface ReceiptCapabilityReputationUpdate {
  /** Stable idempotency key for the receipt-delta projection row. */
  readonly applicationKey: string;
  readonly receiptId: string;
  readonly agentId: string;
  readonly capability: string;
  readonly pointsDelta: number;
  readonly reliabilityDelta: number;
  readonly timelinessDelta: number;
  readonly recoveryBonus: number;
  readonly verifiedMissionsDelta: 0 | 1;
  readonly provisionalCleared: boolean;
  readonly reason: ReputationDelta["reason"];
}

export interface ReceiptAgentReputationUpdate {
  readonly agentId: string;
  readonly pointsDelta: number;
  /** Incremented once per successful producing agent, not per capability. */
  readonly completedMissionsDelta: 0 | 1;
  readonly recoveredMission: boolean;
}

export interface ReceiptReputationProjection {
  readonly receiptId: string;
  readonly missionId: string;
  readonly outcome: Receipt["outcome"];
  readonly capabilityUpdates: readonly ReceiptCapabilityReputationUpdate[];
  readonly agentUpdates: readonly ReceiptAgentReputationUpdate[];
  readonly totals: {
    readonly pointsDelta: number;
    readonly recoveryBonus: number;
  };
}

/**
 * Validate and project reputation exclusively from an immutable terminal receipt.
 * The returned values are pure data; D1 idempotency and score clamping belong to
 * the registry projection layer.
 */
export function deriveReceiptReputation(
  receiptInput: unknown,
): ReceiptReputationProjection {
  const receipt = ReceiptSchema.parse(receiptInput);
  assertTimelinessTruth(receipt);
  assertReceiptOutcomeSemantics(receipt);
  assertParticipantEvidence(receipt);

  const successful = receipt.outcome === "completed";
  const capabilityUpdates = receipt.reputationDeltas.map((delta) => ({
    applicationKey: [receipt.receiptId, delta.agentId, delta.capability].join(
      "\u0000",
    ),
    receiptId: receipt.receiptId,
    agentId: delta.agentId,
    capability: delta.capability,
    pointsDelta: delta.pointsDelta,
    reliabilityDelta: delta.reliabilityDelta,
    timelinessDelta: delta.timelinessDelta,
    recoveryBonus: delta.recoveryBonus,
    verifiedMissionsDelta:
      successful && delta.reason !== "post-bind-default" ? 1 : 0,
    provisionalCleared: successful && delta.reason !== "post-bind-default",
    reason: delta.reason,
  })) satisfies readonly ReceiptCapabilityReputationUpdate[];

  const producingAgentIds = new Set(
    receipt.artifacts.map((artifact) => artifact.producingAgentId),
  );
  const replacementAgentIds = new Set(
    receipt.replacements.map((replacement) => replacement.replacementAgentId),
  );
  const agentUpdates = [
    ...new Set(receipt.reputationDeltas.map((delta) => delta.agentId)),
  ]
    .sort()
    .map((agentId) => {
      const deltas = receipt.reputationDeltas.filter(
        (delta) => delta.agentId === agentId,
      );
      const completedMissionsDelta =
        successful && producingAgentIds.has(agentId) ? 1 : 0;
      return {
        agentId,
        pointsDelta: deltas.reduce(
          (total, delta) => total + delta.pointsDelta,
          0,
        ),
        completedMissionsDelta,
        recoveredMission:
          completedMissionsDelta === 1 && replacementAgentIds.has(agentId),
      } as const;
    });

  return {
    receiptId: receipt.receiptId,
    missionId: receipt.missionId,
    outcome: receipt.outcome,
    capabilityUpdates,
    agentUpdates,
    totals: {
      pointsDelta: sum(receipt.reputationDeltas, (delta) => delta.pointsDelta),
      recoveryBonus: sum(
        receipt.reputationDeltas,
        (delta) => delta.recoveryBonus,
      ),
    },
  };
}

function assertTimelinessTruth(receipt: Receipt): void {
  const actuallyOverdue =
    Date.parse(receipt.timeliness.completedAt) >
    Date.parse(receipt.timeliness.deliveryDeadline);
  if (receipt.timeliness.overdue !== actuallyOverdue) {
    throw new TypeError("Receipt overdue flag does not match its timestamps");
  }
}

function assertReceiptOutcomeSemantics(receipt: Receipt): void {
  if (receipt.outcome !== "completed") {
    for (const delta of receipt.reputationDeltas) {
      if (delta.pointsDelta !== 0 || delta.recoveryBonus !== 0) {
        throw new TypeError(
          "A non-completed receipt cannot carry success XP or recovery points",
        );
      }
      if (delta.reliabilityDelta > 0 || delta.timelinessDelta > 0) {
        throw new TypeError(
          "A non-completed receipt cannot carry positive reputation",
        );
      }
      if (delta.reason === "post-bind-default") {
        assertDefaultDelta(delta);
      }
    }
    return;
  }

  if (
    receipt.verification === null ||
    receipt.verification.status !== "passed" ||
    receipt.verification.criterionResults.some(
      (criterion) => criterion.status !== "passed",
    )
  ) {
    throw new TypeError(
      "A completed reputation receipt requires every criterion to pass",
    );
  }

  const expectedTimeliness = receipt.timeliness.overdue
    ? OVERDUE_TIMELINESS_DELTA
    : ON_TIME_TIMELINESS_DELTA;
  for (const delta of receipt.reputationDeltas) {
    if (delta.reason === "post-bind-default") {
      assertDefaultDelta(delta);
      continue;
    }
    if (delta.pointsDelta <= 0) {
      throw new TypeError("Verified output reputation requires positive XP");
    }
    if (delta.timelinessDelta !== expectedTimeliness) {
      throw new TypeError("Verified output timeliness delta is inconsistent");
    }
    if (delta.reason === "verified-role-output") {
      if (
        delta.reliabilityDelta !== VERIFIED_ROLE_RELIABILITY_DELTA ||
        delta.recoveryBonus !== 0
      ) {
        throw new TypeError("Verified role-output reputation is inconsistent");
      }
    } else if (
      delta.reliabilityDelta !== VERIFIED_REPLACEMENT_RELIABILITY_DELTA
    ) {
      throw new TypeError(
        "Verified replacement-output reputation is inconsistent",
      );
    }
  }

  const points = sum(receipt.reputationDeltas, (delta) => delta.pointsDelta);
  const recovery = sum(
    receipt.reputationDeltas,
    (delta) => delta.recoveryBonus,
  );
  if (
    points !== receipt.reward.totalPointsAwarded ||
    recovery !== receipt.reward.recoveryBonusAwarded ||
    points - recovery !== receipt.reward.basePointsAwarded
  ) {
    throw new TypeError("Receipt reputation deltas do not reconcile to reward");
  }
}

function assertParticipantEvidence(receipt: Receipt): void {
  const defaultKeys = new Set<string>();
  for (const entry of receipt.defaults) {
    const key = `${entry.agentId}\u0000${entry.roleSlotId}`;
    if (defaultKeys.has(key)) throw new TypeError("Duplicate receipt default");
    defaultKeys.add(key);
    const matching = receipt.reputationDeltas.filter(
      (delta) =>
        delta.agentId === entry.agentId && delta.reason === "post-bind-default",
    );
    if (matching.length < 1) {
      throw new TypeError("Each default requires reputation evidence");
    }
    if (
      receipt.outcome === "completed" &&
      !receipt.replacements.some(
        (replacement) =>
          replacement.predecessorAgentId === entry.agentId &&
          replacement.roleSlotId === entry.roleSlotId,
      )
    ) {
      throw new TypeError(
        "A completed default requires exact-slot replacement",
      );
    }
  }
  for (const delta of receipt.reputationDeltas) {
    if (
      delta.reason === "post-bind-default" &&
      !receipt.defaults.some((entry) => entry.agentId === delta.agentId)
    ) {
      throw new TypeError("Default reputation has no receipt default evidence");
    }
  }

  const replacementSlots = new Set<string>();
  for (const replacement of receipt.replacements) {
    if (replacementSlots.has(replacement.roleSlotId)) {
      throw new TypeError("A receipt may replace a role slot only once");
    }
    replacementSlots.add(replacement.roleSlotId);
    if (
      !receipt.defaults.some(
        (entry) =>
          entry.agentId === replacement.predecessorAgentId &&
          entry.roleSlotId === replacement.roleSlotId,
      )
    ) {
      throw new TypeError("Replacement lacks matching default evidence");
    }
    if (
      receipt.outcome === "completed" &&
      !receipt.artifacts.some(
        (artifact) =>
          artifact.roleSlotId === replacement.roleSlotId &&
          artifact.producingAgentId === replacement.replacementAgentId,
      )
    ) {
      throw new TypeError(
        "Replacement did not produce its bound role artifact",
      );
    }
  }

  if (receipt.outcome !== "completed") return;
  for (const artifact of receipt.artifacts) {
    const replacement = receipt.replacements.find(
      (entry) =>
        entry.roleSlotId === artifact.roleSlotId &&
        entry.replacementAgentId === artifact.producingAgentId,
    );
    const expectedReason = replacement
      ? "verified-replacement-output"
      : "verified-role-output";
    if (
      !receipt.reputationDeltas.some(
        (delta) =>
          delta.agentId === artifact.producingAgentId &&
          delta.reason === expectedReason,
      )
    ) {
      throw new TypeError(
        "Artifact producer lacks matching reputation evidence",
      );
    }
  }
  for (const delta of receipt.reputationDeltas) {
    if (delta.reason === "post-bind-default") continue;
    const isReplacement = delta.reason === "verified-replacement-output";
    if (
      !receipt.artifacts.some((artifact) => {
        if (artifact.producingAgentId !== delta.agentId) return false;
        const replacement = receipt.replacements.some(
          (entry) =>
            entry.roleSlotId === artifact.roleSlotId &&
            entry.replacementAgentId === delta.agentId,
        );
        return replacement === isReplacement;
      })
    ) {
      throw new TypeError("Reputation delta lacks matching artifact evidence");
    }
  }
}

function assertDefaultDelta(delta: ReputationDelta): void {
  if (
    delta.pointsDelta !== 0 ||
    delta.reliabilityDelta !== POST_BIND_DEFAULT_RELIABILITY_DELTA ||
    delta.timelinessDelta !== 0 ||
    delta.recoveryBonus !== 0
  ) {
    throw new TypeError("Post-bind default reputation is inconsistent");
  }
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}
