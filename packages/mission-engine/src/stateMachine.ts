import { PactSchema, type DisplayState, type Pact } from "@guildhall/contracts";

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
    applications: [],
    selectedHelperIds: [],
    selectionEvidence: null,
    candidatePact: null,
    proposalHistory: [],
    capabilityBids: [],
    assignmentProposals: [],
    assignmentResolution: null,
    acceptances: {},
    roleSlots: [],
    deliveredOutputIds: [],
    correctionCount: 0,
    correctionAvailable: false,
    verificationPending: false,
    executionStarted: false,
    progressReports: [],
    overdue: false,
    safety: "none",
    terminalOutcome: null,
    receiptIssued: false,
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
  if (state.terminalOutcome !== null) {
    if (command.type === "issue_receipt" && !state.receiptIssued) {
      return success(state, { receiptIssued: true }, ["receipt_issued"]);
    }
    return failure(state, "TERMINAL_MISSION");
  }
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
      if (!validApplication(state, command)) {
        return failure(state, "INVALID_APPLICATION");
      }
      return success(
        state,
        {
          applicationAgentIds: [...state.applicationAgentIds, command.agentId],
          applications: [
            ...state.applications,
            {
              agentId: command.agentId,
              keyId: command.keyId,
              missionVersion: command.missionVersion,
              relevantCapabilities: [...command.relevantCapabilities],
              proposedContribution: command.proposedContribution,
              availability: { ...command.availability },
              applicationEventSequence: state.sequence + 1,
            },
          ],
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
            applications: state.applications.filter(
              (application) => application.agentId !== command.agentId,
            ),
            selectedHelperIds: [],
            selectionEvidence: null,
            roleSlots: [],
            candidatePact: null,
            proposalHistory: [],
            capabilityBids: [],
            assignmentProposals: [],
            assignmentResolution: null,
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
          applications: state.applications.filter(
            (application) => application.agentId !== command.agentId,
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
        !validSelectionEvidence(state, command) ||
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
          selectionEvidence: snapshotSelectionEvidence(
            command.selectionEvidence,
          ),
          roleSlots: command.roleSlots.map((slot) => ({ ...slot })),
          candidatePact: null,
          proposalHistory: [],
          capabilityBids: [],
          assignmentProposals: [],
          assignmentResolution: null,
          acceptances: {},
        },
        [
          ...(command.minimumNotMet === true ? ["party_minimum_not_met"] : []),
          "party_reserved",
          "assignment_negotiation_started",
        ],
      );
    }

    case "submit_capability_bid": {
      const application = state.applications.find(
        (item) => item.agentId === command.agentId,
      );
      if (
        state.stage !== "RESERVE" ||
        !state.selectedHelperIds.includes(command.agentId) ||
        application === undefined ||
        state.capabilityBids.some((bid) => bid.agentId === command.agentId) ||
        !isNonEmpty(command.keyId) ||
        command.relevantCapabilities.length < 1 ||
        command.relevantCapabilities.length > 16 ||
        !uniqueNonEmptyStrings(command.relevantCapabilities) ||
        !command.relevantCapabilities.every((capability) =>
          application.relevantCapabilities.includes(capability),
        ) ||
        !isNonEmpty(command.proposedContribution) ||
        command.proposedContribution.length > 2_000
      ) {
        return failure(state, "INVALID_PROPOSAL");
      }
      return success(
        state,
        {
          capabilityBids: [
            ...state.capabilityBids,
            {
              agentId: command.agentId,
              keyId: command.keyId,
              relevantCapabilities: [...command.relevantCapabilities],
              proposedContribution: command.proposedContribution,
              bidEventSequence: state.sequence + 1,
            },
          ],
        },
        ["capability_bid_submitted"],
      );
    }

    case "submit_proposal":
      if (state.stage !== "RESERVE" && state.stage !== "COMMIT") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (!/^[A-Za-z0-9_-]{43}$/u.test(command.pactDigest)) {
        return failure(state, "PACT_MISMATCH");
      }
      if (
        command.proposalRound !== 1 ||
        state.proposalHistory.length !== 0 ||
        command.proposalRound !==
          (state.candidatePact?.proposalRound ?? 0) + 1 ||
        command.proposalRound !== state.proposalHistory.length + 1
      ) {
        return failure(state, "NEGOTIATION_ROUNDS_EXHAUSTED");
      }
      if (state.candidatePact?.pactDigest === command.pactDigest) {
        return failure(state, "PACT_MISMATCH");
      }
      if (
        command.proposerAgentId !== state.requesterAgentId ||
        !sameStringSet(
          state.capabilityBids.map((bid) => bid.agentId),
          state.selectedHelperIds,
        )
      ) {
        return failure(state, "INVALID_PROPOSAL");
      }
      if (!validPactCandidate(state, command)) {
        return failure(state, "INVALID_PROPOSAL");
      }
      const candidatePact = {
        proposerAgentId: command.proposerAgentId,
        proposalRound: command.proposalRound,
        pactDigest: command.pactDigest,
        pact: structuredClone(command.pact),
      };
      return success(
        state,
        {
          stage: "COMMIT",
          candidatePact,
          proposalHistory: [...state.proposalHistory, candidatePact],
          acceptances: {},
        },
        ["pact_candidate_published"],
      );

    case "submit_assignment_proposal": {
      if (
        state.stage !== "COMMIT" ||
        state.candidatePact?.proposalRound !== 1 ||
        state.proposalHistory.length !== 1 ||
        !state.selectedHelperIds.includes(command.proposerAgentId) ||
        state.assignmentProposals.some(
          (proposal) => proposal.proposerAgentId === command.proposerAgentId,
        ) ||
        !isNonEmpty(command.keyId) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(command.pactDigest) ||
        command.pactDigest === state.candidatePact.pactDigest ||
        command.pact.pactVersion !== 2 ||
        !validPactCandidate(state, {
          proposerAgentId: command.proposerAgentId,
          proposalRound: 2,
          pactDigest: command.pactDigest,
          pact: command.pact,
        })
      ) {
        return failure(state, "INVALID_PROPOSAL");
      }
      const proposal = {
        proposerAgentId: command.proposerAgentId,
        keyId: command.keyId,
        proposalRound: 2,
        pactDigest: command.pactDigest,
        pact: structuredClone(command.pact),
        proposalEventSequence: state.sequence + 1,
      };
      const assignmentProposals = [...state.assignmentProposals, proposal];
      if (assignmentProposals.length < state.selectedHelperIds.length) {
        return success(state, { assignmentProposals }, [
          "assignment_proposal_submitted",
        ]);
      }
      const ordered = state.selectedHelperIds.map((agentId) => {
        const candidate = assignmentProposals.find(
          (item) => item.proposerAgentId === agentId,
        );
        if (candidate === undefined) throw new TypeError("Missing proposal");
        return candidate;
      });
      const matching =
        new Set(ordered.map((item) => item.pactDigest)).size === 1;
      const resolved = ordered[0]!;
      const candidatePact = {
        proposerAgentId: resolved.proposerAgentId,
        proposalRound: 2,
        pactDigest: resolved.pactDigest,
        pact: structuredClone(resolved.pact),
      };
      return success(
        state,
        {
          candidatePact,
          proposalHistory: [...state.proposalHistory, candidatePact],
          assignmentProposals,
          assignmentResolution: {
            strategy: matching ? "matching" : "selection-order",
            selectedProposalAgentId: resolved.proposerAgentId,
            consideredProposalAgentIds: ordered.map(
              (item) => item.proposerAgentId,
            ),
            consideredPactDigests: ordered.map((item) => item.pactDigest),
          },
          acceptances: {},
        },
        [
          "assignment_proposal_submitted",
          "assignment_proposals_resolved",
          "pact_candidate_published",
        ],
      );
    }

    case "negotiation_timeout":
      if (state.stage !== "RESERVE" && state.stage !== "COMMIT") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      return success(
        state,
        {
          stage: "PREPARE",
          selectedHelperIds: [],
          selectionEvidence: null,
          roleSlots: [],
          candidatePact: null,
          proposalHistory: [],
          capabilityBids: [],
          assignmentProposals: [],
          assignmentResolution: null,
          acceptances: {},
        },
        ["reservations_released", "recruitment_reopened"],
      );

    case "accept_pact": {
      if (state.stage !== "COMMIT" || state.candidatePact === null) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (
        state.candidatePact.proposalRound !== 2 ||
        state.proposalHistory.length !== 2 ||
        state.assignmentResolution === null ||
        state.assignmentProposals.length !== state.selectedHelperIds.length ||
        state.candidatePact.pactDigest !== command.pactDigest ||
        state.candidatePact.pact.pactVersion !== command.pactVersion
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
        (agentId) =>
          acceptances[agentId]?.pactVersion === command.pactVersion &&
          acceptances[agentId]?.pactDigest === command.pactDigest,
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
          applications: [],
          selectedHelperIds: [],
          selectionEvidence: null,
          roleSlots: [],
          candidatePact: null,
          proposalHistory: [],
          capabilityBids: [],
          assignmentProposals: [],
          assignmentResolution: null,
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

    case "report_progress": {
      if (state.stage !== "EXECUTE" && state.stage !== "DELIVER") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      if (
        !state.roleSlots.some(
          (candidate) => candidate.roleSlotId === command.roleSlotId,
        )
      ) {
        return failure(state, "ROLE_SLOT_NOT_FOUND");
      }
      if (
        command.completedOutputIds.some(
          (outputId) =>
            state.candidatePact?.pact.requiredOutputs.some(
              (output) => output.outputId === outputId,
            ) !== true,
        )
      ) {
        return failure(state, "INVALID_COMMAND");
      }
      return success(
        state,
        {
          executionStarted: true,
          progressReports: [
            ...state.progressReports,
            {
              roleSlotId: command.roleSlotId,
              status: command.status,
              summary: command.summary,
              completedOutputIds: [...command.completedOutputIds],
              occurredAt: command.occurredAt,
              sequence: state.sequence + 1,
            },
          ],
        },
        ["progress_reported"],
      );
    }

    case "submit_artifact": {
      if (state.stage !== "EXECUTE" && state.stage !== "DELIVER") {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      const slotIndex = state.roleSlots.findIndex(
        (slot) => slot.roleSlotId === command.roleSlotId,
      );
      if (slotIndex < 0) return failure(state, "ROLE_SLOT_NOT_FOUND");
      const slot = state.roleSlots[slotIndex];
      const artifact = command.artifact;
      if (state.deliveredOutputIds.includes(artifact.outputId))
        return failure(state, "ARTIFACT_ALREADY_DELIVERED");
      const pact = state.candidatePact;
      const requiredOutput = pact?.pact.requiredOutputs.find(
        (output) => output.outputId === artifact.outputId,
      );
      const pactSlot = pact?.pact.roleSlots.find(
        (candidate) => candidate.roleSlotId === command.roleSlotId,
      );
      if (
        pact === null ||
        artifact.metadata.missionId !== state.missionId ||
        artifact.metadata.pactDigest !== pact.pactDigest ||
        artifact.metadata.roleSlotId !== command.roleSlotId ||
        artifact.metadata.producingAgentId !== slot?.occupantAgentId ||
        pactSlot?.requiredOutputIds.includes(artifact.outputId) !== true ||
        requiredOutput === undefined ||
        artifact.metadata.artifactType !== requiredOutput.type ||
        artifact.metadata.mediaType !== requiredOutput.mediaType ||
        artifact.metadata.attempt !== state.correctionCount + 1
      ) {
        return failure(state, "INVALID_COMMAND");
      }
      const deliveredOutputIds = [
        ...state.deliveredOutputIds,
        artifact.outputId,
      ];
      const roleSlots = replaceSlot(state.roleSlots, slotIndex, {
        ...slot!,
        artifactDelivered:
          pactSlot?.requiredOutputIds.every((outputId) =>
            deliveredOutputIds.includes(outputId),
          ) === true,
      });
      const allDelivered = pact.pact.requiredOutputs.every((output) =>
        deliveredOutputIds.includes(output.outputId),
      );
      return success(
        state,
        {
          roleSlots,
          deliveredOutputIds,
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
      if (slot?.status !== "active") {
        return failure(state, "ROLE_SLOT_NOT_REPLACEABLE");
      }
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
      const proof = command.proof;
      if (
        state.candidatePact.pact.failureBehavior.participantDefault !==
          "recruit-exact-slot-replacement" ||
        proof.pactDigest !== command.pactDigest ||
        proof.missionId !== state.missionId ||
        proof.roleSlotId !== command.roleSlotId ||
        proof.predecessorAgentId !== command.predecessorAgentId ||
        proof.replacementAgentId !== command.replacementAgentId ||
        proof.reason !==
          (state.roleSlots.find(
            (slot) => slot.roleSlotId === command.roleSlotId,
          )?.status === "defaulted"
            ? "participant-defaulted"
            : "participant-released") ||
        proof.preservesPactDigest !== true
      ) {
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
        slot.occupantAgentId !== slot.originalAgentId ||
        slot.occupantAgentId !== command.predecessorAgentId ||
        command.predecessorAgentId === command.replacementAgentId ||
        command.replacementAgentId === state.requesterAgentId
      ) {
        return failure(state, "ROLE_SLOT_NOT_REPLACEABLE");
      }
      const otherActiveAgents = new Set(
        state.roleSlots
          .filter((_, index) => index !== slotIndex)
          .filter((candidate) => candidate.status === "active")
          .map((candidate) => candidate.occupantAgentId),
      );
      if (otherActiveAgents.has(command.replacementAgentId)) {
        return failure(state, "ROLE_SLOT_NOT_REPLACEABLE");
      }
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
      const allDelivered = state.candidatePact.pact.requiredOutputs.every(
        (output) => state.deliveredOutputIds.includes(output.outputId),
      );
      return success(
        state,
        {
          roleSlots,
          stage: stillNeedsReplacement
            ? "COMPENSATE"
            : allDelivered
              ? "DELIVER"
              : "EXECUTE",
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
            deliveredOutputIds:
              command.failedRoleSlotIds === undefined
                ? []
                : state.deliveredOutputIds.filter((outputId) => {
                    const owner = state.candidatePact?.pact.roleSlots.find(
                      (slot) => slot.requiredOutputIds.includes(outputId),
                    );
                    return (
                      owner !== undefined &&
                      !command.failedRoleSlotIds!.includes(owner.roleSlotId)
                    );
                  }),
          },
          ["verification_failed", "correction_opened"],
        );
      }
      return terminal(state, "failed", ["verification_failed"]);

    case "verification_passed":
      if (state.stage !== "VERIFY") return failure(state, "ILLEGAL_TRANSITION");
      return terminal(state, "completed", ["verification_passed"]);

    case "issue_receipt":
      return failure(state, "ILLEGAL_TRANSITION");

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
          ["safety_redacted", "mission_canceled"],
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
          ? ["compensation_started", "mission_canceled"]
          : ["mission_canceled"],
      );

    case "expire":
      if (
        state.stage !== "PREPARE" &&
        state.stage !== "RESERVE" &&
        state.stage !== "COMMIT"
      ) {
        return failure(state, "ILLEGAL_TRANSITION");
      }
      return terminal(state, "expired", ["mission_expired"]);
  }
}

function validSelectionEvidence(
  state: LifecycleState,
  command: Extract<LifecycleCommand, { type: "form_party" }>,
): boolean {
  const result = command.selectionEvidence;
  const selectedRows = result.evidence
    .filter((row) => row.selected)
    .sort(
      (left, right) =>
        (left.selectionPosition ?? Number.MAX_SAFE_INTEGER) -
        (right.selectionPosition ?? Number.MAX_SAFE_INTEGER),
    );
  return (
    result.canProceed &&
    result.targetHelperCount === command.helperIds.length &&
    sameOrderedStrings(result.selectedAgentIds, command.helperIds) &&
    sameOrderedStrings(
      selectedRows.map((row) => row.agentId),
      command.helperIds,
    ) &&
    new Set(result.evidence.map((row) => row.agentId)).size ===
      result.evidence.length &&
    sameStringSet(
      result.evidence.map((row) => row.agentId),
      state.applicationAgentIds,
    ) &&
    result.evidence.every((row) =>
      state.applications.some(
        (application) =>
          application.agentId === row.agentId &&
          application.applicationEventSequence === row.applicationEventSequence,
      ),
    ) &&
    selectedRows.every(
      (row, index) =>
        row.eligible &&
        row.selectionPosition === index + 1 &&
        state.applications.some(
          (application) => application.agentId === row.agentId,
        ),
    ) &&
    (command.minimumNotMet === true) === result.oneHelperFallbackUsed &&
    result.minimumSatisfied !== result.oneHelperFallbackUsed
  );
}

function snapshotSelectionEvidence(
  result: NonNullable<LifecycleState["selectionEvidence"]>,
): NonNullable<LifecycleState["selectionEvidence"]> {
  return {
    selectedAgentIds: [...result.selectedAgentIds],
    evidence: result.evidence.map((row) => ({
      agentId: row.agentId,
      matchedSkills: [...row.matchedSkills],
      requiredSkillCount: row.requiredSkillCount,
      skillCoverageCount: row.skillCoverageCount,
      skillCoverageRatio: row.skillCoverageRatio,
      verifiedCapabilityRank: row.verifiedCapabilityRank,
      reliability: row.reliability,
      applicationEventSequence: row.applicationEventSequence,
      eligible: row.eligible,
      selected: row.selected,
      ...(row.selectionPosition === undefined
        ? {}
        : { selectionPosition: row.selectionPosition }),
      ...(row.exclusionReason === undefined
        ? {}
        : { exclusionReason: row.exclusionReason }),
    })),
    targetHelperCount: result.targetHelperCount,
    minimumSatisfied: result.minimumSatisfied,
    oneHelperFallbackUsed: result.oneHelperFallbackUsed,
    canProceed: result.canProceed,
  };
}

function validApplication(
  state: LifecycleState,
  command: Extract<LifecycleCommand, { type: "apply" }>,
): boolean {
  return (
    command.agentId !== state.requesterAgentId &&
    isNonEmpty(command.agentId) &&
    isNonEmpty(command.keyId) &&
    command.missionVersion === state.missionVersion &&
    command.relevantCapabilities.length >= 1 &&
    command.relevantCapabilities.length <= 16 &&
    uniqueNonEmptyStrings(command.relevantCapabilities) &&
    isNonEmpty(command.proposedContribution) &&
    command.proposedContribution.length <= 2_000 &&
    validDeadlineOrder(
      command.availability.availableFrom,
      command.availability.availableUntil,
    )
  );
}

function validPactCandidate(
  state: LifecycleState,
  command: {
    readonly proposerAgentId: string;
    readonly proposalRound: number;
    readonly pactDigest: string;
    readonly pact: Pact;
  },
): boolean {
  if (!PactSchema.safeParse(command.pact).success) return false;
  const pact = command.pact;
  const participantIds = pact.participants.map(
    (participant) => participant.agentId,
  );
  const helperIds = pact.participants
    .filter((participant) => participant.role === "helper")
    .map((participant) => participant.agentId);
  const requesterIds = pact.participants
    .filter((participant) => participant.role === "requester")
    .map((participant) => participant.agentId);
  const pactSlotIds = pact.roleSlots.map((slot) => slot.roleSlotId);
  const runtimeSlotIds = state.roleSlots.map((slot) => slot.roleSlotId);
  const outputIds = pact.requiredOutputs.map((output) => output.outputId);
  const criterionIds = pact.verificationCriteria.map(
    (criterion) => criterion.criterionId,
  );
  const allocatedPoints = pact.roleSlots.reduce(
    (total, slot) => total + slot.pointAllocation,
    0,
  );

  return (
    participantIds.includes(command.proposerAgentId) &&
    pact.missionId === state.missionId &&
    pact.missionVersion === state.missionVersion &&
    pact.pactVersion === command.proposalRound &&
    requesterIds.length === 1 &&
    requesterIds[0] === state.requesterAgentId &&
    sameStringSet(helperIds, state.selectedHelperIds) &&
    sameStringSet(pactSlotIds, runtimeSlotIds) &&
    pact.roleSlots.every((slot) => {
      const runtimeSlot = state.roleSlots.find(
        (candidate) => candidate.roleSlotId === slot.roleSlotId,
      );
      return (
        runtimeSlot?.originalAgentId === slot.originalAgentId &&
        runtimeSlot.occupantAgentId === slot.originalAgentId &&
        slot.dependencyRoleSlotIds.every((roleSlotId) =>
          pactSlotIds.includes(roleSlotId),
        ) &&
        slot.requiredOutputIds.every((outputId) =>
          outputIds.includes(outputId),
        ) &&
        slot.verificationCriterionIds.every((criterionId) =>
          criterionIds.includes(criterionId),
        )
      );
    }) &&
    new Set(pact.roleSlots.flatMap((slot) => slot.requiredOutputIds)).size ===
      outputIds.length &&
    new Set(pact.roleSlots.flatMap((slot) => slot.verificationCriterionIds))
      .size === criterionIds.length &&
    allocatedPoints === pact.reward.totalPoints &&
    validDeadlineOrder(pact.formationDeadline, pact.deliveryDeadline)
  );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function uniqueNonEmptyStrings(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value) => isNonEmpty(value))
  );
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function positiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validDeadlineOrder(formation: string, delivery: string): boolean {
  const formationTime = Date.parse(formation);
  const deliveryTime = Date.parse(delivery);
  return (
    Number.isFinite(formationTime) &&
    Number.isFinite(deliveryTime) &&
    formationTime < deliveryTime
  );
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
