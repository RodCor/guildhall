import {
  classifyPactChange,
  MAX_SELECTED_HELPERS,
  type PactTerms,
} from "./negotiation.js";

export type RoleSlotOccupancyStatus = "active" | "defaulted" | "released";

export interface StableRoleSlotOccupancy {
  readonly roleSlotId: string;
  readonly originalAgentId: string;
  readonly occupantAgentId: string;
  readonly status: RoleSlotOccupancyStatus;
}

export interface ReplacementAcceptance {
  readonly roleSlotId: string;
  readonly predecessorAgentId: string;
  readonly replacementAgentId: string;
  readonly pactDigest: string;
  readonly keyId: string;
  readonly signature: string;
  readonly reason: "participant-defaulted" | "participant-released";
  readonly preservesPactDigest: true;
}

export interface ReplacementAttempt {
  readonly boundPactDigest: string;
  readonly boundTerms: PactTerms;
  readonly proposedPactDigest: string;
  readonly proposedTerms: PactTerms;
  readonly slots: readonly StableRoleSlotOccupancy[];
  readonly acceptance: ReplacementAcceptance;
}

export interface ReplacementResult {
  readonly pactDigest: string;
  readonly terms: PactTerms;
  readonly slots: readonly StableRoleSlotOccupancy[];
  readonly acceptance: ReplacementAcceptance;
}

export type ReplacementErrorCode =
  | "SLOT_NOT_FOUND"
  | "SLOT_NOT_REPLACEABLE"
  | "PREDECESSOR_MISMATCH"
  | "PACT_DIGEST_MISMATCH"
  | "MATERIAL_PACT_CHANGE"
  | "INVALID_REPLACEMENT_ACCEPTANCE"
  | "ACTIVE_HELPER_LIMIT";

export class ReplacementError extends Error {
  readonly code: ReplacementErrorCode;

  constructor(code: ReplacementErrorCode, message: string) {
    super(message);
    this.name = "ReplacementError";
    this.code = code;
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ReplacementError(
      "INVALID_REPLACEMENT_ACCEPTANCE",
      `${field} must not be empty`,
    );
  }
}

/**
 * Fills one pre-authorized stable slot. Pact bytes and material terms are
 * returned unchanged; only the slot's current-occupant ledger is updated.
 */
export function replaceStableRoleSlot(
  attempt: ReplacementAttempt,
): ReplacementResult {
  const { acceptance } = attempt;
  const matchingSlots = attempt.slots.filter(
    (slot) => slot.roleSlotId === acceptance.roleSlotId,
  );
  if (matchingSlots.length !== 1) {
    throw new ReplacementError(
      "SLOT_NOT_FOUND",
      "Replacement must target one exact stable role slot",
    );
  }
  const slot = matchingSlots[0];
  if (slot === undefined) {
    throw new ReplacementError(
      "SLOT_NOT_FOUND",
      "Replacement must target one exact stable role slot",
    );
  }
  if (slot.status !== "defaulted" && slot.status !== "released") {
    throw new ReplacementError(
      "SLOT_NOT_REPLACEABLE",
      "Only a defaulted or explicitly released slot can be replaced",
    );
  }

  const expectedReason =
    slot.status === "defaulted"
      ? "participant-defaulted"
      : "participant-released";
  if (
    acceptance.predecessorAgentId !== slot.originalAgentId ||
    acceptance.predecessorAgentId !== slot.occupantAgentId
  ) {
    throw new ReplacementError(
      "PREDECESSOR_MISMATCH",
      "Replacement must name the role slot's original predecessor",
    );
  }
  if (
    acceptance.replacementAgentId === acceptance.predecessorAgentId ||
    acceptance.reason !== expectedReason
  ) {
    throw new ReplacementError(
      "INVALID_REPLACEMENT_ACCEPTANCE",
      "Replacement occupant and reason must match the released slot",
    );
  }

  assertNonEmpty(acceptance.replacementAgentId, "replacementAgentId");
  assertNonEmpty(acceptance.keyId, "keyId");
  assertNonEmpty(acceptance.signature, "signature");
  if (
    !acceptance.preservesPactDigest ||
    acceptance.pactDigest !== attempt.boundPactDigest ||
    attempt.proposedPactDigest !== attempt.boundPactDigest
  ) {
    throw new ReplacementError(
      "PACT_DIGEST_MISMATCH",
      "A replacement must accept the unchanged bound pact digest",
    );
  }

  const change = classifyPactChange(attempt.boundTerms, attempt.proposedTerms);
  if (change.material) {
    throw new ReplacementError(
      "MATERIAL_PACT_CHANGE",
      `Replacement cannot change material pact fields: ${change.changedMaterialFields.join(", ")}`,
    );
  }

  const activeOutsideSlot = attempt.slots.filter(
    (candidate) =>
      candidate.roleSlotId !== slot.roleSlotId && candidate.status === "active",
  );
  const activeHelperIds = new Set(
    activeOutsideSlot.map((candidate) => candidate.occupantAgentId),
  );
  activeHelperIds.add(acceptance.replacementAgentId);
  if (activeHelperIds.size > MAX_SELECTED_HELPERS) {
    throw new ReplacementError(
      "ACTIVE_HELPER_LIMIT",
      "Replacement cannot exceed two active helpers",
    );
  }

  const slots = attempt.slots.map((candidate) =>
    candidate.roleSlotId === slot.roleSlotId
      ? {
          ...candidate,
          occupantAgentId: acceptance.replacementAgentId,
          status: "active" as const,
        }
      : candidate,
  );

  return {
    pactDigest: attempt.boundPactDigest,
    terms: attempt.boundTerms,
    slots,
    acceptance,
  };
}
