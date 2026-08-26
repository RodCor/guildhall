import type { Pact } from "@guildhall/contracts";

import type {
  LifecycleCommand,
  RuntimeRoleSlot,
} from "../../packages/mission-engine/src/index.js";

export const MISSION_ID = "00000000-0000-4000-8000-000000000001";
export const REQUESTER_AGENT_ID = "10000000-0000-4000-8000-000000000001";
export const SCOUT_AGENT_ID = "20000000-0000-4000-8000-000000000001";
export const SCRIBE_AGENT_ID = "20000000-0000-4000-8000-000000000002";
export const WARDEN_AGENT_ID = "20000000-0000-4000-8000-000000000003";
export const APPLICATION_KEY_ID = "70000000-0000-4000-8000-000000000001";
export const PACT_DIGEST_A = "A".repeat(43);
export const PACT_DIGEST_B = "B".repeat(43);
export const PACT_DIGEST_C = "C".repeat(43);

const INPUT_ID = "40000000-0000-4000-8000-000000000001";
const OUTPUT_IDS = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
] as const;
const CRITERION_IDS = [
  "60000000-0000-4000-8000-000000000001",
  "60000000-0000-4000-8000-000000000002",
] as const;
const PACT_IDS = [
  "80000000-0000-4000-8000-000000000001",
  "80000000-0000-4000-8000-000000000002",
] as const;

export function applyToMission(
  agentId: string,
  overrides: Partial<
    Omit<Extract<LifecycleCommand, { type: "apply" }>, "type" | "agentId">
  > = {},
): Extract<LifecycleCommand, { type: "apply" }> {
  return {
    type: "apply",
    agentId,
    keyId: APPLICATION_KEY_ID,
    missionVersion: 1,
    relevantCapabilities: ["typescript"],
    proposedContribution: `Contribute as ${agentId}`,
    availability: {
      availableFrom: "2026-08-26T15:00:00.000Z",
      availableUntil: "2026-08-26T18:00:00.000Z",
    },
    ...overrides,
  };
}

export function formParty(
  helperIds: readonly string[],
  roleSlots: readonly RuntimeRoleSlot[],
  minimumNotMet = false,
): Extract<LifecycleCommand, { type: "form_party" }> {
  const canProceed = helperIds.length > 0 && helperIds.length <= 2;
  return {
    type: "form_party",
    helperIds,
    roleSlots,
    selectionEvidence: {
      selectedAgentIds: [...helperIds],
      evidence: helperIds.map((agentId, index) => ({
        agentId,
        matchedSkills: ["typescript"],
        requiredSkillCount: 1,
        skillCoverageCount: 1,
        skillCoverageRatio: 1,
        verifiedCapabilityRank: 1,
        reliability: 0.9,
        applicationEventSequence: index + 2,
        eligible: true,
        selected: true,
        selectionPosition: index + 1,
      })),
      targetHelperCount: helperIds.length,
      minimumSatisfied: canProceed && !minimumNotMet,
      oneHelperFallbackUsed: canProceed && minimumNotMet,
      canProceed,
    },
    ...(minimumNotMet ? { minimumNotMet: true } : {}),
  };
}

export function pactForProposal(
  proposalRound: number,
  requesterAgentId: string,
  roleSlots: readonly RuntimeRoleSlot[],
  assignmentLabel = "round-one",
  options: {
    readonly missionId?: string;
    readonly missionVersion?: number;
    readonly publicInputDigest?: string;
  } = {},
): Pact {
  return {
    protocol: "commitment/v1",
    kind: "pact",
    pactId: PACT_IDS[proposalRound - 1] ?? PACT_IDS[1],
    missionId: options.missionId ?? MISSION_ID,
    missionVersion: options.missionVersion ?? 1,
    pactVersion: proposalRound,
    goal: "Audit the public accessibility fixture",
    publicInputs: [
      {
        inputId: INPUT_ID,
        type: "url",
        location: "https://guildhall.test/fixtures/accessibility-dungeon-v1",
        mediaType: "text/html",
        contentDigest:
          options.publicInputDigest ??
          "geKBB1Pr83xZU8RzZaoC-YcNy6MO2jw3lB_lupUQQ58",
      },
    ],
    minimumPartySize: 1,
    maximumPartySize: 2,
    participants: [
      { agentId: requesterAgentId, role: "requester" },
      ...roleSlots.map((slot) => ({
        agentId: slot.originalAgentId,
        role: "helper" as const,
      })),
    ],
    roleSlots: roleSlots.map((slot, index) => ({
      roleSlotId: slot.roleSlotId,
      originalAgentId: slot.originalAgentId,
      assignment: `${assignmentLabel}: complete role ${index + 1}`,
      requiredCapabilities: ["typescript"],
      dependencyRoleSlotIds:
        index === 0 ? [] : [roleSlots[index - 1]!.roleSlotId],
      requiredOutputIds: [OUTPUT_IDS[index]!],
      verificationCriterionIds: [CRITERION_IDS[index]!],
      pointAllocation: 50,
    })),
    requiredOutputs: roleSlots.map((_slot, index) => ({
      outputId: OUTPUT_IDS[index]!,
      type:
        index === 0
          ? ("accessibility-findings" as const)
          : ("remediation-plan" as const),
      description: `Public result for role ${index + 1}`,
      mediaType: "application/json",
      publicLocation: "mission-artifact",
    })),
    formationDeadline: "2026-08-26T16:00:00.000Z",
    deliveryDeadline: "2026-08-26T17:00:00.000Z",
    verificationCriteria: roleSlots.map((_slot, index) => ({
      criterionId: CRITERION_IDS[index]!,
      description: `Deterministically verify role ${index + 1}`,
      required: true,
      method: "deterministic",
    })),
    reward: {
      totalPoints: 50 * roleSlots.length,
      replacementRecoveryBonus: 10,
      transferable: false,
      redeemable: false,
    },
    failureBehavior: {
      negotiationTimeout: "reopen-recruitment",
      participantDefault: "recruit-exact-slot-replacement",
      replacementAuthorized: true,
      verificationCorrectionLimit: 1,
    },
    createdAt: "2026-08-26T15:30:00.000Z",
  };
}

export function submitProposal(
  proposalRound: number,
  pactDigest: string,
  proposerAgentId: string,
  roleSlots: readonly RuntimeRoleSlot[],
  assignmentLabel?: string,
  options: {
    readonly missionId?: string;
    readonly missionVersion?: number;
    readonly requesterAgentId?: string;
    readonly publicInputDigest?: string;
  } = {},
): Extract<LifecycleCommand, { type: "submit_proposal" }> {
  return {
    type: "submit_proposal",
    proposerAgentId,
    proposalRound,
    pactDigest,
    pact: pactForProposal(
      proposalRound,
      options.requesterAgentId ?? REQUESTER_AGENT_ID,
      roleSlots,
      assignmentLabel,
      options,
    ),
  };
}

export function submitCapabilityBid(
  agentId: string,
  relevantCapabilities: readonly string[] = ["typescript"],
): Extract<LifecycleCommand, { type: "submit_capability_bid" }> {
  return {
    type: "submit_capability_bid",
    agentId,
    keyId: APPLICATION_KEY_ID,
    relevantCapabilities,
    proposedContribution: `Bid from ${agentId}`,
  };
}

export function submitAssignmentProposal(
  pactDigest: string,
  proposerAgentId: string,
  roleSlots: readonly RuntimeRoleSlot[],
  assignmentLabel = "helper-proposal",
  options: {
    readonly missionId?: string;
    readonly missionVersion?: number;
    readonly requesterAgentId?: string;
    readonly publicInputDigest?: string;
  } = {},
): Extract<LifecycleCommand, { type: "submit_assignment_proposal" }> {
  return {
    type: "submit_assignment_proposal",
    proposerAgentId,
    keyId: APPLICATION_KEY_ID,
    pactDigest,
    pact: pactForProposal(
      2,
      options.requesterAgentId ?? REQUESTER_AGENT_ID,
      roleSlots,
      assignmentLabel,
      options,
    ),
  };
}
