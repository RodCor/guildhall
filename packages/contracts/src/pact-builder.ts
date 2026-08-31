import { PactSchema, type Pact } from "./commitment-v1.js";
import type { Mission } from "./mission.js";

export interface AllocationAssignment {
  readonly roleSlotId: string;
  readonly agentId: string;
  readonly responsibilities: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly dependencyRoleSlotIds: readonly string[];
  readonly outputIds: readonly string[];
  readonly verificationCriterionIds: readonly string[];
  readonly pointAllocation: number;
}

/** Builds the complete public contract that proposal signatures bind. */
export async function buildPact(input: {
  readonly mission: Mission;
  readonly selectedHelperIds: readonly string[];
  readonly pactVersion: number;
  readonly assignments: readonly AllocationAssignment[];
  readonly createdAt: string;
}): Promise<Pact> {
  const helpers = unique(input.selectedHelperIds);
  if (helpers.length < 1 || helpers.length > 2) {
    throw new TypeError("A pact requires one or two selected helpers");
  }
  if (
    input.assignments.length !== helpers.length ||
    unique(input.assignments.map((assignment) => assignment.agentId)).length !==
      helpers.length ||
    !sameSet(
      input.assignments.map((assignment) => assignment.agentId),
      helpers,
    )
  ) {
    throw new TypeError(
      "Assignments must cover every selected helper exactly once",
    );
  }
  requireCoverage(
    input.mission.requiredCapabilities,
    input.assignments.flatMap((assignment) => assignment.requiredCapabilities),
    "required capabilities",
  );
  requireCoverage(
    input.mission.requiredOutputs.map((output) => output.outputId),
    input.assignments.flatMap((assignment) => assignment.outputIds),
    "required outputs",
  );
  requireCoverage(
    input.mission.verificationCriteria.map(
      (criterion) => criterion.criterionId,
    ),
    input.assignments.flatMap(
      (assignment) => assignment.verificationCriterionIds,
    ),
    "verification criteria",
  );
  const points = input.assignments.reduce(
    (total, assignment) => total + assignment.pointAllocation,
    0,
  );
  if (points !== input.mission.pointReward) {
    throw new TypeError("Role allocations must equal the mission point reward");
  }

  return PactSchema.parse({
    protocol: "commitment/v1",
    kind: "pact",
    pactId: await pactIdForMission(input.mission.missionId),
    missionId: input.mission.missionId,
    missionVersion: input.mission.missionVersion,
    pactVersion: input.pactVersion,
    goal: input.mission.goal,
    publicInputs: input.mission.publicInputs,
    ...(input.mission.executionTarget === undefined
      ? {}
      : { executionTarget: input.mission.executionTarget }),
    minimumPartySize: input.mission.minimumPartySize,
    maximumPartySize: input.mission.maximumPartySize,
    participants: [
      { agentId: input.mission.requesterAgentId, role: "requester" },
      ...helpers.map((agentId) => ({ agentId, role: "helper" as const })),
    ],
    roleSlots: input.assignments.map((assignment) => ({
      roleSlotId: assignment.roleSlotId,
      originalAgentId: assignment.agentId,
      assignment: assignment.responsibilities.join("; "),
      requiredCapabilities: unique(assignment.requiredCapabilities),
      dependencyRoleSlotIds: unique(assignment.dependencyRoleSlotIds),
      requiredOutputIds: unique(assignment.outputIds),
      verificationCriterionIds: unique(assignment.verificationCriterionIds),
      pointAllocation: assignment.pointAllocation,
    })),
    requiredOutputs: input.mission.requiredOutputs,
    formationDeadline: input.mission.formationDeadline,
    deliveryDeadline: input.mission.deliveryDeadline,
    verificationCriteria: input.mission.verificationCriteria,
    reward: {
      totalPoints: input.mission.pointReward,
      replacementRecoveryBonus: replacementRecoveryBonus(
        input.mission.pointReward,
      ),
      transferable: false,
      redeemable: false,
    },
    failureBehavior: input.mission.failureBehavior,
    createdAt: input.createdAt,
  });
}

/** Confirms that negotiation changed allocation only, never mission terms. */
export function pactMatchesMission(pact: Pact, mission: Mission): boolean {
  return (
    pact.missionId === mission.missionId &&
    pact.missionVersion === mission.missionVersion &&
    pact.goal === mission.goal &&
    sameJson(pact.publicInputs, mission.publicInputs) &&
    sameJson(
      pact.executionTarget ?? { kind: "guildhall" },
      mission.executionTarget ?? { kind: "guildhall" },
    ) &&
    pact.minimumPartySize === mission.minimumPartySize &&
    pact.maximumPartySize === mission.maximumPartySize &&
    sameSet(
      pact.roleSlots.flatMap((slot) => slot.requiredCapabilities),
      mission.requiredCapabilities,
    ) &&
    sameJson(pact.requiredOutputs, mission.requiredOutputs) &&
    pact.formationDeadline === mission.formationDeadline &&
    pact.deliveryDeadline === mission.deliveryDeadline &&
    sameJson(pact.verificationCriteria, mission.verificationCriteria) &&
    pact.reward.totalPoints === mission.pointReward &&
    pact.reward.replacementRecoveryBonus ===
      replacementRecoveryBonus(mission.pointReward) &&
    pact.reward.transferable === false &&
    pact.reward.redeemable === false &&
    sameJson(pact.failureBehavior, mission.failureBehavior)
  );
}

function replacementRecoveryBonus(pointReward: number): number {
  return Math.min(1_000, Math.max(1, Math.floor(pointReward / 10)));
}

async function pactIdForMission(missionId: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`guildhall:pact:${missionId}`),
    ),
  ).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function requireCoverage(
  required: readonly string[],
  allocated: readonly string[],
  field: string,
): void {
  if (!sameSet(unique(required), unique(allocated))) {
    throw new TypeError(
      `Pact allocation must cover exactly the mission ${field}`,
    );
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
