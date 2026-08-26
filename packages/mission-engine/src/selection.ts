export interface MissionPartyConstraints {
  minimumHelpers: number;
  preferredHelpers: number;
  maximumHelpers: number;
}

export interface HelperApplication {
  agentId: string;
  skills: readonly string[];
  verifiedCapabilityRank: number;
  reliability: number;
  applicationEventSequence: number;
  eligible?: boolean;
  withdrawn?: boolean;
}

export type SelectionExclusionReason = "withdrawn" | "ineligible";

export interface SelectionEvidence {
  agentId: string;
  matchedSkills: readonly string[];
  requiredSkillCount: number;
  skillCoverageCount: number;
  skillCoverageRatio: number;
  verifiedCapabilityRank: number;
  reliability: number;
  applicationEventSequence: number;
  eligible: boolean;
  selected: boolean;
  selectionPosition?: number;
  exclusionReason?: SelectionExclusionReason;
}

export interface HelperSelectionResult {
  selectedAgentIds: readonly string[];
  evidence: readonly SelectionEvidence[];
  targetHelperCount: number;
  minimumSatisfied: boolean;
  oneHelperFallbackUsed: boolean;
  canProceed: boolean;
}

interface RankedApplication {
  application: HelperApplication;
  matchedSkills: readonly string[];
}

const GUILD_HELPER_LIMIT = 2;

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function validateConstraints(constraints: MissionPartyConstraints): void {
  assertPositiveInteger(constraints.minimumHelpers, "minimumHelpers");
  assertPositiveInteger(constraints.preferredHelpers, "preferredHelpers");
  assertPositiveInteger(constraints.maximumHelpers, "maximumHelpers");

  if (constraints.minimumHelpers > constraints.preferredHelpers) {
    throw new RangeError("minimumHelpers cannot exceed preferredHelpers");
  }

  if (constraints.preferredHelpers > constraints.maximumHelpers) {
    throw new RangeError("preferredHelpers cannot exceed maximumHelpers");
  }
}

function validateApplication(application: HelperApplication): void {
  if (application.agentId.length === 0) {
    throw new RangeError("agentId cannot be empty");
  }

  assertNonNegativeFinite(
    application.verifiedCapabilityRank,
    "verifiedCapabilityRank",
  );
  assertNonNegativeFinite(application.reliability, "reliability");
  assertNonNegativeFinite(
    application.applicationEventSequence,
    "applicationEventSequence",
  );

  if (!Number.isInteger(application.applicationEventSequence)) {
    throw new RangeError("applicationEventSequence must be an integer");
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareRanked(
  left: RankedApplication,
  right: RankedApplication,
): number {
  const coverageDifference =
    right.matchedSkills.length - left.matchedSkills.length;
  if (coverageDifference !== 0) return coverageDifference;

  const rankDifference =
    right.application.verifiedCapabilityRank -
    left.application.verifiedCapabilityRank;
  if (rankDifference !== 0) return rankDifference;

  const reliabilityDifference =
    right.application.reliability - left.application.reliability;
  if (reliabilityDifference !== 0) return reliabilityDifference;

  const sequenceDifference =
    left.application.applicationEventSequence -
    right.application.applicationEventSequence;
  if (sequenceDifference !== 0) return sequenceDifference;

  return left.application.agentId.localeCompare(right.application.agentId);
}

/**
 * Selects a mission party from a fixed application snapshot.
 *
 * The final agent-id comparison is deliberately not a Guild ranking signal. It
 * only makes malformed snapshots with duplicate application sequences resolve
 * identically on every runtime.
 */
export function selectHelpers(
  requiredSkills: readonly string[],
  applications: readonly HelperApplication[],
  constraints: MissionPartyConstraints,
): HelperSelectionResult {
  validateConstraints(constraints);

  const required = uniqueSorted(requiredSkills);
  const requiredSet = new Set(required);
  const ranked: RankedApplication[] = [];
  const excluded: RankedApplication[] = [];

  for (const application of applications) {
    validateApplication(application);
    const matchedSkills = uniqueSorted(application.skills).filter((skill) =>
      requiredSet.has(skill),
    );
    const record = { application, matchedSkills };

    if (application.withdrawn === true || application.eligible === false) {
      excluded.push(record);
    } else {
      ranked.push(record);
    }
  }

  ranked.sort(compareRanked);

  const targetHelperCount = Math.min(
    constraints.preferredHelpers,
    constraints.maximumHelpers,
    ranked.length,
    GUILD_HELPER_LIMIT,
  );
  const selected = ranked.slice(0, targetHelperCount);
  const selectedPositions = new Map(
    selected.map((candidate, index) => [
      candidate.application.agentId,
      index + 1,
    ]),
  );
  const minimumSatisfied = selected.length >= constraints.minimumHelpers;
  const oneHelperFallbackUsed =
    !minimumSatisfied && ranked.length === 1 && selected.length === 1;

  const toEvidence = (
    candidate: RankedApplication,
    eligible: boolean,
  ): SelectionEvidence => {
    const selectionPosition = selectedPositions.get(
      candidate.application.agentId,
    );
    const base: SelectionEvidence = {
      agentId: candidate.application.agentId,
      matchedSkills: candidate.matchedSkills,
      requiredSkillCount: required.length,
      skillCoverageCount: candidate.matchedSkills.length,
      skillCoverageRatio:
        required.length === 0
          ? 1
          : candidate.matchedSkills.length / required.length,
      verifiedCapabilityRank: candidate.application.verifiedCapabilityRank,
      reliability: candidate.application.reliability,
      applicationEventSequence: candidate.application.applicationEventSequence,
      eligible,
      selected: selectionPosition !== undefined,
    };

    if (selectionPosition !== undefined) {
      base.selectionPosition = selectionPosition;
    }

    if (!eligible) {
      base.exclusionReason = candidate.application.withdrawn
        ? "withdrawn"
        : "ineligible";
    }

    return base;
  };

  return {
    selectedAgentIds: selected.map(({ application }) => application.agentId),
    evidence: [
      ...ranked.map((candidate) => toEvidence(candidate, true)),
      ...excluded.map((candidate) => toEvidence(candidate, false)),
    ],
    targetHelperCount,
    minimumSatisfied,
    oneHelperFallbackUsed,
    canProceed: minimumSatisfied || oneHelperFallbackUsed,
  };
}
