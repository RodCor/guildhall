import type { DisplayState } from "@guildhall/contracts";

import type {
  LifecycleCommand,
  LifecycleState,
  RuntimeRoleSlot,
  TransitionFailureCode,
  TransitionResult,
} from "./types.js";

export function initialLifecycleState(options: {
  readonly missionId: string;
  readonly requesterAgentId: string;
}): LifecycleState {
  return {
    missionId: options.missionId,
    stage: "DRAFT",
    sequence: 0,
    missionVersion: 1,
    requesterAgentId: options.requesterAgentId,
    applicationAgentIds: [],
    selectedHelperIds: [],
    candidatePact: null,
    acceptances: {},
    roleSlots: [],
    correctionCount: 0,
    correctionAvailable: false,
    verificationPending: false,
    executionStarted: false,
    overdue: false,
    safety: "none",
    terminalOutcome: null,
    published: false,
  };
}

export function deriveDisplayState(state: LifecycleState): DisplayState {
  if (state.terminalOutcome !== null) {
    return {
      completed: "Completed",
      failed: "Failed",
      canceled: "Canceled",
      expired: "Expired",
    }[state.terminalOutcome] as DisplayState;
  }
  if (state.safety === "paused") return "Paused for safety";
  if (state.safety === "rejected") return "Safety rejected";
  if (state.verificationPending) return "Verification pending";
  if (state.correctionAvailable) return "Correction available";
  if (state.roleSlots.some((slot) => slot.status !== "active"))
    return "Replacement needed";
  if (state.overdue) return "Overdue";
  if (state.stage === "VERIFY") return "Verifying";
  if (state.stage === "EXECUTE" || state.stage === "DELIVER") {
    return state.executionStarted ? "Executing" : "Bound";
  }
  if (state.stage === "RESERVE" || state.stage === "COMMIT")
    return "Negotiating";
  if (state.stage === "PREPARE")
    return state.published ? "Recruiting" : "Draft";
  return "Draft";
}

export function transition(
  state: LifecycleState,
  command: LifecycleCommand,
): TransitionResult {
  if (state.terminalOutcome !== null) return failure(state, "TERMINAL_MISSION");
  if (
    state.safety === "paused" &&
    command.type !== "cancel" &&
    command.type !== "safety_pause" &&
    command.type !== "safety_redact"
  ) {
    return failure(state, "ILLEGAL_TRANSITION");
  }

  switch (command.type) {
    case "publish":
      if (state.stage !== "DRAFT") return failure(state, "ILLEGAL_TRANSITION");
      return success(state, { stage: "PREPARE", published: true }, [
        "mission_published",
      ]);

    case "apply":
      if (state.stage !== "PREPARE")
        return failure(state, "ILLEGAL_TRANSITION");
      if (state.applicationAgentIds.includes(command.agentId)) {
        return failure(state, "APPLICATION_DUPLICATE");
      }
      return success(
        state,
        {
          applicationAgentIds: [...state.applicationAgentIds, command.agentId],
        },
        ["application_submitted"],
      );

    case "withdraw":
      if (!state.applicationAgentIds.includes(command.agentId)) {
        return failure(state, "APPLICATION_NOT_FOUND");
      }
      if (state.stage === "RESERVE" || state.stage === "COMMIT") {
        if (!state.selectedHelperIds.includes(command.agentId)) {
          return failure(state, "ILLEGAL_TRANSITION");
        }
        return success(
          state,
          {
            stage: "PREPARE",
            applicationAgentIds: state.applicationAgentIds.filter(
              (agentId) => agentId !== command.agentId,
            ),
            selectedHelperIds: [],
            roleSlots: [],
            candidatePact: null,
            acceptances: {},
          },
          [
            "selected_helper_withdrew",
            "reservations_released",
            "recruitment_reopened",
          ],
        );
      }
      if (state.stage !== "PREPARE")
        return failure(state, "ILLEGAL_TRANSITION");
      return success(
        state,
        {
          applicationAgentIds: state.applicationAgentIds.filter(
            (agentId) => agentId !== command.agentId,
          ),
        },
        ["application_withdrawn"],
      );

    case "form_party": {
      if (state.stage !== "PREPARE")
        return failure(state, "ILLEGAL_TRANSITION");
      const uniqueHelpers = new Set(command.helperIds);
      const occupantIds = command.roleSlots.map((slot) => slot.occupantAgentId);
      const roleSlotIds = command.roleSlots.map((slot) => slot.roleSlotId);
      if (
        command.helperIds.length < 1 ||
        command.helperIds.length > 2 ||
        uniqueHelpers.size !== command.helperIds.length ||
        uniqueHelpers.has(state.requesterAgentId) ||
        !command.helperIds.every((agentId) =>
          state.applicationAgentIds.includes(agentId),
        ) ||
        command.roleSlots.length !== command.helperIds.length ||
        new Set(occupantIds).size !== command.helperIds.length ||
        new Set(roleSlotIds).size !== roleSlotIds.length ||
        !command.roleSlots.every(
          (slot) =>
            uniqueHelpers.has(slot.occupantAgentId) &&
            slot.originalAgentId === slot.occupantAgentId &&
            slot.status === "active",
        )
      ) {
        return failure(state, "INVALID_PARTY");
      }
      return success(
        state,
        {
          stage: "RESERVE",
          selectedHelperIds: [...command.helperIds],
          roleSlots: command.roleSlots.map((slot) => ({ ...slot })),
          candidatePact: null,
          acceptances: {},
        },
        [
          ...(command.minimumNotMet === true ? ["party_minimum_not_met"] : []),
          "party_reserved",
          "assignment_negotiation_started",
        ],
      );
    }

    case "submit_proposal":
      if (state.stage !== "RESERVE" && state.stage !== "COMMIT") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (command.pactVersion < 1 || command.pactDigest.length === 0) {
        return failure(state, "PACT_MISMATCH");
      }
      if (
        command.pactVersion > 2 ||
        command.pactVersion !== (state.candidatePact?.pactVersion ?? 0) + 1
      ) {
        return failure(state, "NEGOTIATION_ROUNDS_EXHAUSTED");
      }
      return success(
        state,
        {
          stage: "COMMIT",
          candidatePact: {
            pactVersion: command.pactVersion,
            pactDigest: command.pactDigest,
          },
          acceptances: {},
        },
        ["pact_candidate_published"],
      );

    case "negotiation_timeout":
      if (state.stage !== "RESERVE" && state.stage !== "COMMIT") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      return success(
        state,
        {
          stage: "PREPARE",
          selectedHelperIds: [],
          roleSlots: [],
          candidatePact: null,
          acceptances: {},
        },
        ["reservations_released", "recruitment_reopened"],
      );

    case "accept_pact": {
      if (state.stage !== "COMMIT" || state.candidatePact === null) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (
        state.candidatePact.pactDigest !== command.pactDigest ||
        state.candidatePact.pactVersion !== command.pactVersion
      ) {
        return failure(state, "PACT_MISMATCH");
      }
      const requiredSigners = [
        state.requesterAgentId,
        ...state.selectedHelperIds,
      ];
      if (!requiredSigners.includes(command.agentId)) {
        return failure(state, "SIGNER_NOT_REQUIRED");
      }
      if (state.acceptances[command.agentId] !== undefined) {
        return failure(state, "DUPLICATE_ACCEPTANCE");
      }
      const acceptances = {
        ...state.acceptances,
        [command.agentId]: {
          acceptanceId: command.acceptanceId,
          agentId: command.agentId,
          keyId: command.keyId,
          pactVersion: command.pactVersion,
          pactDigest: command.pactDigest,
          signature: command.signature,
          acceptedAt: command.acceptedAt,
        },
      };
      const bound = requiredSigners.every(
        (agentId) => acceptances[agentId]?.pactDigest === command.pactDigest,
      );
      return success(
        state,
        {
          acceptances,
          ...(bound
            ? { stage: "EXECUTE" as const, executionStarted: false }
            : {}),
        },
        bound ? ["pact_accepted", "pact_bound"] : ["pact_accepted"],
      );
    }

    case "revise_mission":
      if (
        state.stage !== "PREPARE" &&
        state.stage !== "RESERVE" &&
        state.stage !== "COMMIT"
      ) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      return success(
        state,
        {
          stage: "PREPARE",
          missionVersion: state.missionVersion + 1,
          applicationAgentIds: [],
          selectedHelperIds: [],
          roleSlots: [],
          candidatePact: null,
          acceptances: {},
        },
        [
          "mission_material_changed",
          "applications_invalidated",
          "acceptances_invalidated",
        ],
      );

    case "start_execution":
      if (state.stage !== "EXECUTE")
        return failure(state, "ILLEGAL_TRANSITION");
      if (state.executionStarted) return failure(state, "ILLEGAL_TRANSITION");
      return success(state, { executionStarted: true }, ["execution_started"]);

    case "submit_artifact": {
      if (state.stage !== "EXECUTE" && state.stage !== "DELIVER") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      const slotIndex = state.roleSlots.findIndex(
        (slot) => slot.roleSlotId === command.roleSlotId,
      );
      if (slotIndex < 0) return failure(state, "ROLE_SLOT_NOT_FOUND");
      const slot = state.roleSlots[slotIndex];
      if (slot?.artifactDelivered === true)
        return failure(state, "ARTIFACT_ALREADY_DELIVERED");
      const roleSlots = replaceSlot(state.roleSlots, slotIndex, {
        ...slot!,
        artifactDelivered: true,
      });
      const allDelivered = roleSlots
        .filter((candidate) => candidate.artifactRequired)
        .every((candidate) => candidate.artifactDelivered);
      return success(
        state,
        {
          roleSlots,
          stage: allDelivered ? "DELIVER" : "EXECUTE",
          executionStarted: true,
          correctionAvailable: false,
          verificationPending: false,
        },
        allDelivered
          ? ["artifact_submitted", "delivery_complete"]
          : ["artifact_submitted"],
      );
    }

    case "mark_overdue":
      if (
        ![
          "PREPARE",
          "RESERVE",
          "COMMIT",
          "EXECUTE",
          "DELIVER",
          "VERIFY",
          "COMPENSATE",
        ].includes(state.stage)
      ) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (state.overdue) return failure(state, "ILLEGAL_TRANSITION");
      return success(state, { overdue: true }, ["mission_marked_overdue"]);

    case "default_role":
    case "release_role": {
      if (state.stage !== "EXECUTE" && state.stage !== "DELIVER") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      const slotIndex = state.roleSlots.findIndex(
        (slot) => slot.roleSlotId === command.roleSlotId,
      );
      if (slotIndex < 0) return failure(state, "ROLE_SLOT_NOT_FOUND");
      const slot = state.roleSlots[slotIndex];
      const roleSlots = replaceSlot(state.roleSlots, slotIndex, {
        ...slot!,
        status: command.type === "default_role" ? "defaulted" : "released",
      });
      return success(state, { stage: "COMPENSATE", roleSlots }, [
        command.type === "default_role" ? "role_defaulted" : "role_released",
        "replacement_requested",
      ]);
    }

    case "fill_role_slot": {
      if (state.stage !== "COMPENSATE" || state.candidatePact === null) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (command.pactDigest !== state.candidatePact.pactDigest) {
        return failure(state, "REPLACEMENT_CHANGES_PACT");
      }
      const slotIndex = state.roleSlots.findIndex(
        (slot) => slot.roleSlotId === command.roleSlotId,
      );
      if (slotIndex < 0) return failure(state, "ROLE_SLOT_NOT_FOUND");
      const slot = state.roleSlots[slotIndex];
      if (
        slot === undefined ||
        slot.status === "active" ||
        slot.occupantAgentId !== command.predecessorAgentId ||
        command.predecessorAgentId === command.replacementAgentId
      ) {
        return failure(state, "ROLE_SLOT_NOT_REPLACEABLE");
      }
      const otherActiveAgents = new Set(
        state.roleSlots
          .filter((_, index) => index !== slotIndex)
          .filter((candidate) => candidate.status === "active")
          .map((candidate) => candidate.occupantAgentId),
      );
      otherActiveAgents.add(command.replacementAgentId);
      if (otherActiveAgents.size > 2) {
        return failure(state, "ACTIVE_HELPER_LIMIT");
      }
      const roleSlots = replaceSlot(state.roleSlots, slotIndex, {
        ...slot,
        occupantAgentId: command.replacementAgentId,
        status: "active",
      });
      const stillNeedsReplacement = roleSlots.some(
        (candidate) => candidate.status !== "active",
      );
      return success(
        state,
        {
          roleSlots,
          stage: stillNeedsReplacement ? "COMPENSATE" : "EXECUTE",
          executionStarted: true,
        },
        [
          "replacement_bound",
          ...(stillNeedsReplacement ? [] : ["execution_resumed"]),
        ],
      );
    }

    case "verify":
      if (state.stage !== "DELIVER")
        return failure(state, "ILLEGAL_TRANSITION");
      return success(state, { stage: "VERIFY", verificationPending: false }, [
        "verification_started",
      ]);

    case "verifier_unavailable":
      if (state.stage !== "VERIFY") return failure(state, "ILLEGAL_TRANSITION");
      return success(state, { verificationPending: true }, [
        "verification_deferred",
      ]);

    case "verification_failed":
      if (state.stage !== "VERIFY") return failure(state, "ILLEGAL_TRANSITION");
      if (
        command.failedRoleSlotIds !== undefined &&
        (command.failedRoleSlotIds.length === 0 ||
          command.failedRoleSlotIds.some(
            (roleSlotId) =>
              !state.roleSlots.some((slot) => slot.roleSlotId === roleSlotId),
          ))
      ) {
        return failure(state, "ROLE_SLOT_NOT_FOUND");
      }
      if (state.correctionCount === 0) {
        return success(
          state,
          {
            stage: "EXECUTE",
            correctionCount: 1,
            correctionAvailable: true,
            verificationPending: false,
            roleSlots: state.roleSlots.map((slot) => ({
              ...slot,
              artifactDelivered:
                command.failedRoleSlotIds === undefined ||
                command.failedRoleSlotIds.includes(slot.roleSlotId)
                  ? false
                  : slot.artifactDelivered,
            })),
          },
          ["verification_failed", "correction_opened"],
        );
      }
      return terminal(state, "failed", [
        "verification_failed",
        "receipt_issued",
      ]);

    case "verification_passed":
      if (state.stage !== "VERIFY") return failure(state, "ILLEGAL_TRANSITION");
      return terminal(state, "completed", [
        "verification_passed",
        "receipt_issued",
      ]);

    case "safety_pause":
      return success(state, { safety: "paused" }, ["safety_paused"]);

    case "safety_redact":
      if (
        state.stage === "DRAFT" ||
        state.stage === "PREPARE" ||
        state.stage === "RESERVE" ||
        state.stage === "COMMIT"
      ) {
        return success(
          state,
          {
            stage: "RECEIPT",
            safety: "paused",
            terminalOutcome: "canceled",
            verificationPending: false,
            correctionAvailable: false,
          },
          ["safety_redacted", "mission_canceled", "receipt_issued"],
        );
      }
      return success(state, { safety: "paused" }, [
        "safety_redacted",
        "safety_paused",
      ]);

    case "safety_reject":
      return success(state, { safety: "rejected" }, ["safety_rejected"]);

    case "cancel":
      return terminal(
        state,
        "canceled",
        state.stage === "EXECUTE" ||
          state.stage === "DELIVER" ||
          state.stage === "VERIFY"
          ? ["compensation_started", "mission_canceled", "receipt_issued"]
          : ["mission_canceled", "receipt_issued"],
      );

    case "expire":
      if (
        state.stage !== "PREPARE" &&
        state.stage !== "RESERVE" &&
        state.stage !== "COMMIT"
      ) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      return terminal(state, "expired", ["mission_expired", "receipt_issued"]);
  }
}

function success(
  state: LifecycleState,
  patch: Partial<LifecycleState>,
  events: readonly string[],
): TransitionResult {
  return {
    ok: true,
    state: { ...state, ...patch, sequence: state.sequence + events.length },
    events,
  };
}

function terminal(
  state: LifecycleState,
  outcome: NonNullable<LifecycleState["terminalOutcome"]>,
  events: readonly string[],
): TransitionResult {
  return success(
    state,
    {
      stage: "RECEIPT",
      terminalOutcome: outcome,
      verificationPending: false,
      correctionAvailable: false,
    },
    events,
  );
}

function failure(
  state: LifecycleState,
  code: TransitionFailureCode,
): TransitionResult {
  return { ok: false, state, code };
}

function replaceSlot(
  slots: readonly RuntimeRoleSlot[],
  index: number,
  replacement: RuntimeRoleSlot,
): readonly RuntimeRoleSlot[] {
  return slots.map((slot, candidateIndex) =>
    candidateIndex === index ? replacement : slot,
  );
}
