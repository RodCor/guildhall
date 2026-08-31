import { describe, expect, it } from "vitest";

import {
  PactSchema,
  canonicalJsonDigest,
} from "../../packages/contracts/src/index.js";
import {
  deriveDisplayState,
  initialLifecycleState,
  transition,
  type LifecycleCommand,
  type LifecycleState,
  type RuntimeRoleSlot,
} from "../../packages/mission-engine/src/index.js";
import {
  MISSION_ID,
  PACT_DIGEST_A,
  PACT_DIGEST_B,
  PACT_DIGEST_C,
  REQUESTER_AGENT_ID,
  SCOUT_AGENT_ID,
  SCRIBE_AGENT_ID,
  WARDEN_AGENT_ID,
  applyToMission,
  formParty,
  submitAssignmentProposal,
  submitCapabilityBid,
  submitProposal,
} from "./fixtures.js";

const requester = REQUESTER_AGENT_ID;
const scout = SCOUT_AGENT_ID;
const scribe = SCRIBE_AGENT_ID;
const warden = WARDEN_AGENT_ID;
const pactDigest = PACT_DIGEST_A;
const acceptanceKeyId = "70000000-0000-4000-8000-000000000001";
const acceptedAt = "2026-08-26T12:00:00.000Z";

const scoutSlot: RuntimeRoleSlot = {
  roleSlotId: "30000000-0000-4000-8000-000000000001",
  originalAgentId: scout,
  occupantAgentId: scout,
  status: "active",
  artifactRequired: true,
  artifactDelivered: false,
};
const scribeSlot: RuntimeRoleSlot = {
  roleSlotId: "30000000-0000-4000-8000-000000000002",
  originalAgentId: scribe,
  occupantAgentId: scribe,
  status: "active",
  artifactRequired: true,
  artifactDelivered: false,
};

function apply(
  state: LifecycleState,
  command: LifecycleCommand,
): LifecycleState {
  const result = transition(state, command);
  expect(result.ok, result.ok ? undefined : result.code).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

function acceptPact(
  agentId: string,
  digest = PACT_DIGEST_B,
  pactVersion = 2,
): Extract<LifecycleCommand, { type: "accept_pact" }> {
  return {
    type: "accept_pact",
    acceptanceId: crypto.randomUUID(),
    agentId,
    keyId: acceptanceKeyId,
    pactVersion,
    pactDigest: digest,
    signature: "S".repeat(86),
    acceptedAt,
  };
}

function submitArtifact(
  state: LifecycleState,
  roleSlotId: string,
): Extract<LifecycleCommand, { type: "submit_artifact" }> {
  const candidate = state.candidatePact;
  if (candidate === null) throw new Error("Expected a candidate pact");
  const pactSlot = candidate.pact.roleSlots.find(
    (slot) => slot.roleSlotId === roleSlotId,
  );
  const runtimeSlot = state.roleSlots.find(
    (slot) => slot.roleSlotId === roleSlotId,
  );
  const output = candidate.pact.requiredOutputs.find(
    (entry) => entry.outputId === pactSlot?.requiredOutputIds[0],
  );
  if (
    pactSlot === undefined ||
    runtimeSlot === undefined ||
    output === undefined
  ) {
    throw new Error("Expected a bound role output");
  }
  return {
    type: "submit_artifact",
    roleSlotId,
    artifact: {
      outputId: output.outputId,
      metadata: {
        protocol: "commitment/v1",
        kind: "artifact-metadata",
        artifactId: output.outputId,
        missionId: state.missionId,
        pactDigest: candidate.pactDigest,
        roleSlotId,
        producingAgentId: runtimeSlot.occupantAgentId,
        keyId: acceptanceKeyId,
        attempt: (state.correctionCount + 1) as 1 | 2,
        artifactType: output.type,
        mediaType: "application/json",
        publicLocation: `https://guildhall.test/artifacts/${output.outputId}`,
        contentDigest: "D".repeat(43),
        signature: "S".repeat(86),
        safetyStatus: "approved",
        completedAt: acceptedAt,
      },
      content: { fixture: "test" },
      dependencyArtifactIds: [],
    },
  };
}

function defaultRole(
  roleSlotId: string,
): Extract<LifecycleCommand, { type: "default_role" }> {
  return {
    type: "default_role",
    roleSlotId,
    evidence: {
      taskId: crypto.randomUUID(),
      taskState: "TASK_STATE_FAILED",
      errorCode: "CONTROLLED_TEST_FAILURE",
      failureFixture: "state-machine-test",
      retryable: false,
      observedAt: acceptedAt,
    },
  };
}

function replacementProof(roleSlotId: string, pactDigestValue: string) {
  return {
    protocol: "commitment/v1" as const,
    kind: "replacement" as const,
    replacementId: "90000000-0000-4000-8000-000000000001",
    missionId: MISSION_ID,
    pactDigest: pactDigestValue,
    roleSlotId,
    predecessorAgentId: scribe,
    replacementAgentId: warden,
    keyId: acceptanceKeyId,
    reason: "participant-defaulted" as const,
    preservesPactDigest: true as const,
    signature: "S".repeat(86),
    acceptedAt,
  };
}

function boundParty(
  helperIds = [scout, scribe],
  slots = [scoutSlot, scribeSlot],
): LifecycleState {
  let state = reservedParty(helperIds, slots);
  state = apply(state, submitProposal(1, pactDigest, requester, slots));
  for (const agentId of helperIds) {
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        agentId,
        slots,
        "matching-helper-plan",
      ),
    );
  }
  for (const agentId of [requester, ...helperIds]) {
    state = apply(state, acceptPact(agentId));
  }
  return state;
}

function reservedParty(
  helperIds = [scout, scribe],
  slots = [scoutSlot, scribeSlot],
): LifecycleState {
  let state = initialLifecycleState({
    missionId: MISSION_ID,
    requesterAgentId: requester,
  });
  state = apply(state, { type: "publish" });
  for (const agentId of helperIds)
    state = apply(state, applyToMission(agentId));
  state = apply(state, formParty(helperIds, slots, helperIds.length === 1));
  for (const agentId of helperIds) {
    state = apply(state, submitCapabilityBid(agentId));
  }
  return state;
}

describe("pure mission lifecycle", () => {
  it("retains signed application evidence for the exact public mission version", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    const application = applyToMission(scout, {
      relevantCapabilities: ["accessibility-audit", "typescript"],
      proposedContribution: "Inspect the bounded public fixture.",
      availability: {
        availableFrom: "2026-08-26T15:15:00.000Z",
        availableUntil: "2026-08-26T17:30:00.000Z",
      },
    });
    state = apply(state, application);

    expect(state.applications).toEqual([
      {
        agentId: scout,
        keyId: application.keyId,
        missionVersion: 1,
        relevantCapabilities: ["accessibility-audit", "typescript"],
        proposedContribution: "Inspect the bounded public fixture.",
        availability: application.availability,
        applicationEventSequence: 2,
      },
    ]);
    expect(state.applications[0]!.relevantCapabilities).not.toBe(
      application.relevantCapabilities,
    );
    expect(
      transition(
        state,
        applyToMission(scribe, { missionVersion: state.missionVersion + 1 }),
      ),
    ).toMatchObject({ ok: false, code: "INVALID_APPLICATION" });
  });

  it("executes the complete legal success path", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    expect(deriveDisplayState(state)).toBe("Draft");
    state = apply(state, { type: "publish" });
    state = apply(state, applyToMission(scout));
    state = apply(state, applyToMission(scribe));
    expect(deriveDisplayState(state)).toBe("Recruiting");
    state = apply(state, formParty([scout, scribe], [scoutSlot, scribeSlot]));
    expect(state.selectionEvidence).toMatchObject({
      selectedAgentIds: [scout, scribe],
      targetHelperCount: 2,
      minimumSatisfied: true,
      oneHelperFallbackUsed: false,
      canProceed: true,
      evidence: [
        { agentId: scout, selectionPosition: 1, selected: true },
        { agentId: scribe, selectionPosition: 2, selected: true },
      ],
    });
    expect(deriveDisplayState(state)).toBe("Negotiating");
    state = apply(state, submitCapabilityBid(scout));
    state = apply(state, submitCapabilityBid(scribe));
    state = apply(
      state,
      submitProposal(1, pactDigest, requester, [scoutSlot, scribeSlot]),
    );
    for (const agentId of [scout, scribe]) {
      state = apply(
        state,
        submitAssignmentProposal(
          PACT_DIGEST_B,
          agentId,
          [scoutSlot, scribeSlot],
          "matching-helper-plan",
        ),
      );
    }
    for (const agentId of [requester, scout, scribe]) {
      state = apply(state, acceptPact(agentId));
    }
    expect(state.stage).toBe("EXECUTE");
    expect(deriveDisplayState(state)).toBe("Bound");
    state = apply(state, { type: "start_execution" });
    state = apply(state, submitArtifact(state, scoutSlot.roleSlotId));
    state = apply(state, submitArtifact(state, scribeSlot.roleSlotId));
    expect(state.stage).toBe("DELIVER");
    state = apply(state, { type: "verify" });
    expect(deriveDisplayState(state)).toBe("Verifying");
    state = apply(state, { type: "verification_passed" });
    expect(state.stage).toBe("RECEIPT");
    expect(deriveDisplayState(state)).toBe("Completed");
  });

  it("allows the one-helper fallback even when two were preferred", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, applyToMission(scout));
    const formed = transition(state, formParty([scout], [scoutSlot], true));
    expect(formed.ok).toBe(true);
    if (!formed.ok) throw new Error(formed.code);
    expect(formed.events).toContain("party_minimum_not_met");
    state = formed.state;
    expect(state.selectionEvidence).toMatchObject({
      selectedAgentIds: [scout],
      minimumSatisfied: false,
      oneHelperFallbackUsed: true,
      canProceed: true,
    });
    state = apply(state, submitCapabilityBid(scout));
    state = apply(state, submitProposal(1, pactDigest, requester, [scoutSlot]));
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        scout,
        [scoutSlot],
        "solo-counter",
      ),
    );
    for (const agentId of [requester, scout]) {
      state = apply(state, acceptPact(agentId));
    }
    expect(state.selectedHelperIds).toEqual([scout]);
    expect(deriveDisplayState(state)).toBe("Bound");
  });

  it("locks the exact full public Pact JSON behind the candidate digest", async () => {
    let state = reservedParty([scout], [scoutSlot]);
    const draft = submitProposal(1, PACT_DIGEST_A, requester, [scoutSlot]);
    const exactDigest = await canonicalJsonDigest(draft.pact);
    expect(
      transition(state, {
        ...draft,
        pactDigest: exactDigest,
        pact: { ...draft.pact, missionVersion: state.missionVersion + 1 },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_PROPOSAL" });
    state = apply(state, { ...draft, pactDigest: exactDigest });

    expect(state.candidatePact).not.toBeNull();
    expect(state.candidatePact!.pact).toEqual(draft.pact);
    expect(state.candidatePact!.pact).not.toBe(draft.pact);
    expect(await canonicalJsonDigest(state.candidatePact!.pact)).toBe(
      state.candidatePact!.pactDigest,
    );
  });

  it("keeps both immutable public Pact proposals visible and opens acceptance only after round two", () => {
    let state = reservedParty();
    const firstCommand = submitProposal(
      1,
      PACT_DIGEST_A,
      requester,
      [scoutSlot, scribeSlot],
      "requester-plan",
    );
    state = apply(state, firstCommand);
    expect(state.proposalHistory).toHaveLength(1);
    expect(state.candidatePact).toEqual(state.proposalHistory[0]);
    expect(state.proposalHistory[0]).toMatchObject({
      proposerAgentId: requester,
      proposalRound: 1,
      pactDigest: PACT_DIGEST_A,
      pact: {
        missionId: MISSION_ID,
        missionVersion: 1,
        pactVersion: 1,
        roleSlots: [
          {
            originalAgentId: scout,
            dependencyRoleSlotIds: [],
            pointAllocation: 50,
            requiredOutputIds: [expect.any(String)],
          },
          {
            originalAgentId: scribe,
            dependencyRoleSlotIds: [scoutSlot.roleSlotId],
            pointAllocation: 50,
            requiredOutputIds: [expect.any(String)],
          },
        ],
        reward: { totalPoints: 100 },
        deliveryDeadline: "2026-08-26T17:00:00.000Z",
        failureBehavior: { verificationCorrectionLimit: 1 },
      },
    });
    expect(state.proposalHistory[0]!.pact).not.toBe(firstCommand.pact);
    expect(state.proposalHistory[0]!.pact).toEqual(firstCommand.pact);
    const firstSnapshot = structuredClone(state.proposalHistory[0]);

    expect(
      transition(state, acceptPact(requester, PACT_DIGEST_A, 1)),
    ).toMatchObject({
      ok: false,
      code: "PACT_MISMATCH",
    });
    expect(state.acceptances).toEqual({});
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        scout,
        [scoutSlot, scribeSlot],
        "matching-helper-plan",
      ),
    );
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        scribe,
        [scoutSlot, scribeSlot],
        "matching-helper-plan",
      ),
    );

    expect(state.acceptances).toEqual({});
    expect(state.proposalHistory).toHaveLength(2);
    expect(state.proposalHistory[0]).toEqual(firstSnapshot);
    expect(state.proposalHistory[1]).toMatchObject({
      proposerAgentId: scout,
      proposalRound: 2,
      pactDigest: PACT_DIGEST_B,
      pact: { pactVersion: 2 },
    });
    expect(state.candidatePact).toEqual(state.proposalHistory[1]);
    expect(state.capabilityBids).toHaveLength(2);
    expect(state.assignmentProposals).toHaveLength(2);
    expect(state.assignmentResolution).toEqual({
      strategy: "matching",
      selectedProposalAgentId: scout,
      consideredProposalAgentIds: [scout, scribe],
      consideredPactDigests: [PACT_DIGEST_B, PACT_DIGEST_B],
    });

    const thirdRound = transition(
      state,
      submitProposal(
        3,
        PACT_DIGEST_C,
        scribe,
        [scoutSlot, scribeSlot],
        "forbidden-third-round",
      ),
    );
    expect(thirdRound).toEqual({
      ok: false,
      state,
      code: "NEGOTIATION_ROUNDS_EXHAUSTED",
    });
    expect(state.proposalHistory).toHaveLength(2);
  });

  it("requires the requester opening round and a selected helper counter-round", () => {
    const reserved = reservedParty();
    expect(
      transition(
        reserved,
        submitProposal(1, PACT_DIGEST_A, scout, [scoutSlot, scribeSlot]),
      ),
    ).toMatchObject({ ok: false, code: "INVALID_PROPOSAL" });

    const opened = apply(
      reserved,
      submitProposal(1, PACT_DIGEST_A, requester, [scoutSlot, scribeSlot]),
    );
    expect(
      transition(
        opened,
        submitAssignmentProposal(
          PACT_DIGEST_B,
          requester,
          [scoutSlot, scribeSlot],
          "requester-cannot-submit-helper-proposal",
        ),
      ),
    ).toMatchObject({ ok: false, code: "INVALID_PROPOSAL" });
  });

  it("resolves disagreeing helper proposals by frozen selection order", () => {
    let state = reservedParty();
    state = apply(
      state,
      submitProposal(1, PACT_DIGEST_A, requester, [scoutSlot, scribeSlot]),
    );
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        scout,
        [scoutSlot, scribeSlot],
        "scout-work-map",
      ),
    );
    expect(state.candidatePact?.proposalRound).toBe(1);
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_C,
        scribe,
        [scoutSlot, scribeSlot],
        "scribe-work-map",
      ),
    );

    expect(state.candidatePact).toMatchObject({
      proposerAgentId: scout,
      proposalRound: 2,
      pactDigest: PACT_DIGEST_B,
    });
    expect(state.assignmentResolution).toEqual({
      strategy: "selection-order",
      selectedProposalAgentId: scout,
      consideredProposalAgentIds: [scout, scribe],
      consideredPactDigests: [PACT_DIGEST_B, PACT_DIGEST_C],
    });
  });

  it("becomes Bound only after requester and every selected helper accept one exact version and digest", () => {
    let state = reservedParty();
    state = apply(
      state,
      submitProposal(1, PACT_DIGEST_A, requester, [scoutSlot, scribeSlot]),
    );
    for (const agentId of [scout, scribe]) {
      state = apply(
        state,
        submitAssignmentProposal(
          PACT_DIGEST_B,
          agentId,
          [scoutSlot, scribeSlot],
          "matching-helper-plan",
        ),
      );
    }

    expect(
      transition(state, acceptPact(requester, PACT_DIGEST_A, 1)),
    ).toMatchObject({ ok: false, code: "PACT_MISMATCH" });
    expect(
      transition(state, acceptPact(requester, PACT_DIGEST_A, 2)),
    ).toMatchObject({ ok: false, code: "PACT_MISMATCH" });

    state = apply(state, acceptPact(requester, PACT_DIGEST_B, 2));
    expect(state.stage).toBe("COMMIT");
    expect(deriveDisplayState(state)).toBe("Negotiating");
    state = apply(state, acceptPact(scout, PACT_DIGEST_B, 2));
    expect(state.stage).toBe("COMMIT");
    state = apply(state, acceptPact(scribe, PACT_DIGEST_B, 2));
    expect(state.stage).toBe("EXECUTE");
    expect(deriveDisplayState(state)).toBe("Bound");
    expect(Object.values(state.acceptances)).toHaveLength(3);
    expect(
      Object.values(state.acceptances).every(
        (acceptance) =>
          acceptance.pactVersion === 2 &&
          acceptance.pactDigest === PACT_DIGEST_B,
      ),
    ).toBe(true);
  });

  it("does not bind mixed pact digests or non-party signatures", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, applyToMission(scout));
    state = apply(state, formParty([scout], [scoutSlot]));
    state = apply(state, submitCapabilityBid(scout));
    state = apply(state, submitProposal(1, pactDigest, requester, [scoutSlot]));
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        scout,
        [scoutSlot],
        "helper-counter",
      ),
    );

    const mixed = transition(state, acceptPact(scout, "different-digest"));
    expect(mixed).toMatchObject({ ok: false, code: "PACT_MISMATCH" });
    const outsider = transition(state, acceptPact(warden));
    expect(outsider).toMatchObject({ ok: false, code: "SIGNER_NOT_REQUIRED" });
  });

  it("invalidates applications, reservations, and acceptances after a material pre-bind edit", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, applyToMission(scout));
    state = apply(state, formParty([scout], [scoutSlot]));
    state = apply(state, submitCapabilityBid(scout));
    state = apply(state, submitProposal(1, pactDigest, requester, [scoutSlot]));
    state = apply(
      state,
      submitAssignmentProposal(
        PACT_DIGEST_B,
        scout,
        [scoutSlot],
        "helper-counter",
      ),
    );
    state = apply(state, acceptPact(requester));
    const priorVersion = state.missionVersion;
    state = apply(state, { type: "revise_mission" });
    expect(state).toMatchObject({
      stage: "PREPARE",
      missionVersion: priorVersion + 1,
      applicationAgentIds: [],
      applications: [],
      selectedHelperIds: [],
      candidatePact: null,
      acceptances: {},
    });
  });

  it("releases reservations without penalty when a selected helper withdraws pre-bind", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, applyToMission(scout));
    state = apply(state, formParty([scout], [scoutSlot]));
    state = apply(state, { type: "withdraw", agentId: scout });
    expect(state).toMatchObject({
      stage: "PREPARE",
      applicationAgentIds: [],
      applications: [],
      selectedHelperIds: [],
      roleSlots: [],
      candidatePact: null,
      acceptances: {},
    });
  });

  it("replaces only the defaulted exact slot without changing the pact", () => {
    let state = boundParty();
    state = apply(state, defaultRole(scribeSlot.roleSlotId));
    expect(state.stage).toBe("COMPENSATE");
    expect(deriveDisplayState(state)).toBe("Replacement needed");

    const changedPact = transition(state, {
      type: "fill_role_slot",
      roleSlotId: scribeSlot.roleSlotId,
      predecessorAgentId: scribe,
      replacementAgentId: warden,
      pactDigest: "changed-pact",
      proof: replacementProof(scribeSlot.roleSlotId, "changed-pact"),
    });
    expect(changedPact).toMatchObject({
      ok: false,
      code: "REPLACEMENT_CHANGES_PACT",
    });

    state = apply(state, {
      type: "fill_role_slot",
      roleSlotId: scribeSlot.roleSlotId,
      predecessorAgentId: scribe,
      replacementAgentId: warden,
      pactDigest: PACT_DIGEST_B,
      proof: replacementProof(scribeSlot.roleSlotId, PACT_DIGEST_B),
    });
    expect(state.stage).toBe("EXECUTE");
    expect(state.roleSlots[1]).toMatchObject({
      roleSlotId: scribeSlot.roleSlotId,
      originalAgentId: scribe,
      occupantAgentId: warden,
      status: "active",
    });
  });

  it("separates safety rejection from the single semantic correction", () => {
    let state = boundParty([scout], [scoutSlot]);
    state = apply(state, submitArtifact(state, scoutSlot.roleSlotId));
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "safety_reject" });
    expect(state.correctionCount).toBe(0);
    state = apply(state, {
      type: "verification_failed",
      failedRoleSlotIds: [scoutSlot.roleSlotId],
    });
    expect(state.correctionCount).toBe(1);
    expect(state.correctionAvailable).toBe(true);
  });

  it("opens one correction and makes the second semantic failure terminal", () => {
    let state = boundParty([scout], [scoutSlot]);
    state = apply(state, submitArtifact(state, scoutSlot.roleSlotId));
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "verification_failed" });
    state = apply(state, submitArtifact(state, scoutSlot.roleSlotId));
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "verification_failed" });
    expect(deriveDisplayState(state)).toBe("Failed");
  });

  it("preserves a valid artifact when another role slot needs correction", () => {
    let state = boundParty();
    state = apply(state, submitArtifact(state, scoutSlot.roleSlotId));
    state = apply(state, submitArtifact(state, scribeSlot.roleSlotId));
    state = apply(state, { type: "verify" });
    state = apply(state, {
      type: "verification_failed",
      failedRoleSlotIds: [scribeSlot.roleSlotId],
    });
    expect(
      state.roleSlots.find((slot) => slot.roleSlotId === scoutSlot.roleSlotId),
    ).toMatchObject({
      artifactDelivered: true,
    });
    expect(
      state.roleSlots.find((slot) => slot.roleSlotId === scribeSlot.roleSlotId),
    ).toMatchObject({
      artifactDelivered: false,
    });
  });

  it("keeps overdue missions completable while giving overdue display priority", () => {
    let state = boundParty([scout], [scoutSlot]);
    state = apply(state, { type: "mark_overdue" });
    expect(deriveDisplayState(state)).toBe("Overdue");
    state = apply(state, submitArtifact(state, scoutSlot.roleSlotId));
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "verification_passed" });
    expect(deriveDisplayState(state)).toBe("Completed");
  });

  it("requires signed GitHub PR evidence to match the immutable delivery target", () => {
    const bound = boundParty([scout], [scoutSlot]);
    if (bound.candidatePact === null) throw new Error("Expected bound pact");
    const githubPact = PactSchema.parse({
      ...bound.candidatePact.pact,
      executionTarget: {
        kind: "github",
        repository: "kimetsu-ai/guildhall",
        baseRef: "main",
        writeMode: "fork-pr",
        checkPolicy: "all-success",
      },
      requiredOutputs: bound.candidatePact.pact.requiredOutputs.map(
        (output) => ({
          ...output,
          type: "code-change",
          delivery: { kind: "github-pull-request" },
        }),
      ),
      verificationCriteria: bound.candidatePact.pact.verificationCriteria.map(
        (criterion) => ({ ...criterion, method: "public-github" }),
      ),
    });
    const state: LifecycleState = {
      ...bound,
      candidatePact: { ...bound.candidatePact, pact: githubPact },
    };
    const withoutEvidence = submitArtifact(state, scoutSlot.roleSlotId);
    expect(transition(state, withoutEvidence)).toMatchObject({
      ok: false,
      code: "INVALID_COMMAND",
    });

    const withEvidence: typeof withoutEvidence = {
      ...withoutEvidence,
      artifact: {
        ...withoutEvidence.artifact,
        metadata: {
          ...withoutEvidence.artifact.metadata,
          deliveryEvidence: {
            kind: "github-pull-request",
            repository: "kimetsu-ai/guildhall",
            pullRequestUrl: "https://github.com/kimetsu-ai/guildhall/pull/42",
            baseRef: "main",
            headSha: "a".repeat(40),
            checks: [
              {
                name: "test",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        },
      },
    };
    expect(transition(state, withEvidence)).toMatchObject({
      ok: true,
      state: { stage: "DELIVER" },
    });
  });

  it("cancels an unbound mission when public content is redacted", () => {
    let state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    const redacted = transition(state, {
      type: "safety_redact",
      redactedEventId: "event-1",
    });
    expect(redacted).toMatchObject({
      ok: true,
      state: { safety: "paused", terminalOutcome: "canceled" },
      events: ["safety_redacted", "mission_canceled"],
    });
  });

  it("freezes normal completion after a bound-mission redaction", () => {
    const bound = boundParty([scout], [scoutSlot]);
    const redacted = transition(bound, {
      type: "safety_redact",
      redactedEventId: "event-1",
    });
    if (!redacted.ok) throw new Error(redacted.code);
    expect(deriveDisplayState(redacted.state)).toBe("Paused for safety");
    expect(
      transition(redacted.state, {
        type: "submit_artifact",
        roleSlotId: scoutSlot.roleSlotId,
      }),
    ).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(transition(redacted.state, { type: "cancel" })).toMatchObject({
      ok: true,
      state: { terminalOutcome: "canceled" },
      events: ["compensation_started", "mission_canceled"],
    });
  });

  it("returns illegal transitions without mutating the original state", () => {
    const state = initialLifecycleState({
      missionId: MISSION_ID,
      requesterAgentId: requester,
    });
    const result = transition(state, { type: "verify" });
    expect(result).toEqual({ ok: false, state, code: "ILLEGAL_TRANSITION" });
    expect(result.state).toBe(state);
  });
});
