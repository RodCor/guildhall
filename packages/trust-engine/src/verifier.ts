import {
  ArtifactMetadataSchema,
  PactSchema,
  ReplacementProofSchema,
  VerificationResultSchema,
  type ArtifactMetadata,
  type Pact,
  type ReplacementProof,
  type VerificationResult,
} from "@guildhall/contracts";

import {
  canonicalJsonDigestSync,
  sha256Base64UrlSync,
} from "./eventHashChain.js";

export const ACCESSIBILITY_DUNGEON_FIXTURE_ID = "accessibility-dungeon-v1";
export const ACCESSIBILITY_DUNGEON_VERIFIER_ID =
  "accessibility-dungeon-v1" as const;
export const ACCESSIBILITY_DUNGEON_VERIFIER_VERSION = "1.0.0" as const;

export const ACCESSIBILITY_DUNGEON_FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>Accessibility Dungeon</title></head>
  <body>
    <img src="quest-map.png">
    <button id="accept-quest"></button>
    <label>Hero name</label><input id="hero-name">
  </body>
</html>`;

export const ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST = sha256Base64UrlSync(
  ACCESSIBILITY_DUNGEON_FIXTURE_HTML,
);

const MAXIMUM_ARTIFACT_CONTENT_BYTES = 64 * 1024;
const MAXIMUM_JSON_DEPTH = 16;
const MAXIMUM_JSON_NODES = 2_048;

interface ExpectedFinding {
  readonly acceptance: string;
  readonly change: string;
  readonly evidence: string;
  readonly findingId: string;
  readonly ruleId: string;
  readonly selector: string;
  readonly severity: "moderate" | "serious";
}

const EXPECTED_FINDINGS: readonly ExpectedFinding[] = Object.freeze([
  {
    acceptance: "The button-name rule passes for the approved fixture.",
    change: "Add the visible text Accept quest to the button.",
    evidence: "The empty button has no accessible name.",
    findingId: "finding-button-name",
    ruleId: "button-name",
    selector: "#accept-quest",
    severity: "serious",
  },
  {
    acceptance: "The label rule passes for the approved fixture.",
    change: 'Add for="hero-name" to the visible Hero name label.',
    evidence:
      "The visible label is not programmatically associated with the input.",
    findingId: "finding-form-label",
    ruleId: "label",
    selector: "#hero-name",
    severity: "moderate",
  },
  {
    acceptance: "The html-has-lang rule passes for the approved fixture.",
    change: 'Add lang="en" to the root html element.',
    evidence: "The root html element has no lang attribute.",
    findingId: "finding-html-lang",
    ruleId: "html-has-lang",
    selector: "html",
    severity: "serious",
  },
  {
    acceptance: "The image-alt rule passes for the approved fixture.",
    change: 'Add alt="Map of the accessibility dungeon" to the quest image.',
    evidence: "The quest-map image has no alt attribute.",
    findingId: "finding-image-alt",
    ruleId: "image-alt",
    selector: "img[src='quest-map.png']",
    severity: "serious",
  },
]);

export interface VerificationArtifact {
  /** Pact required-output identifier fulfilled by this artifact. */
  readonly outputId: string;
  readonly metadata: ArtifactMetadata;
  /** Parsed application/json body whose canonical digest is in metadata. */
  readonly content: unknown;
  /** Artifact IDs consumed from dependency role slots. */
  readonly dependencyArtifactIds: readonly string[];
}

export interface AccessibilityVerificationInput {
  readonly verificationRunId: string;
  readonly pact: Pact;
  readonly pactDigest: string;
  readonly attempt: 1 | 2;
  readonly fixture: {
    readonly fixtureId: string;
    readonly contentDigest: string;
    /** Exact public URL bound into the pact; never dereferenced by the verifier. */
    readonly publicLocation: string;
  };
  readonly artifacts: readonly VerificationArtifact[];
  readonly replacements?: readonly ReplacementProof[];
  readonly infrastructureStatus: "available" | "unavailable";
  readonly startedAt: string;
  /** Required only when infrastructure is available. */
  readonly completedAt?: string;
}

interface AssessedArtifact {
  readonly artifact: VerificationArtifact;
  readonly errors: readonly string[];
}

interface ArtifactEvidence {
  readonly artifactType: ArtifactMetadata["artifactType"];
  readonly roleSlotId: string;
}

/**
 * Verify only the immutable in-repository Accessibility Dungeon fixture.
 * This function deliberately performs no I/O and never dereferences URLs.
 */
export function verifyAccessibilityDungeon(
  input: AccessibilityVerificationInput,
): VerificationResult {
  const pact = PactSchema.parse(input.pact);
  if (canonicalJsonDigestSync(pact) !== input.pactDigest) {
    throw new TypeError("pactDigest does not match the canonical Pact");
  }
  if (input.artifacts.length < 1 || input.artifacts.length > 8) {
    throw new RangeError(
      "Verification requires between one and eight artifacts",
    );
  }
  if (input.fixture.fixtureId !== ACCESSIBILITY_DUNGEON_FIXTURE_ID) {
    throw new TypeError(
      "Only the allowlisted Accessibility Dungeon is supported",
    );
  }
  if (input.fixture.contentDigest !== ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST) {
    throw new TypeError("The approved fixture digest does not match");
  }
  assertApprovedPactInput(pact, input.fixture.publicLocation);
  assertSupportedPactShape(pact);

  const replacements = (input.replacements ?? []).map((replacement) =>
    ReplacementProofSchema.parse(replacement),
  );
  if (replacements.length > 2) {
    throw new RangeError("At most two replacement proofs are supported");
  }
  const occupants = resolveOccupants(pact, input.pactDigest, replacements);
  input.artifacts.forEach((artifact) => {
    ArtifactMetadataSchema.parse(artifact.metadata);
    assertBoundedJson(artifact.content);
    assertDependencyIds(artifact.dependencyArtifactIds);
  });
  const artifactIds = input.artifacts.map(
    (artifact) => artifact.metadata.artifactId,
  );
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new TypeError("Artifact identifiers must be unique");
  }

  if (input.infrastructureStatus === "unavailable") {
    return VerificationResultSchema.parse({
      protocol: "commitment/v1",
      kind: "verification",
      verificationRunId: input.verificationRunId,
      missionId: pact.missionId,
      pactDigest: input.pactDigest,
      attempt: input.attempt,
      status: "infrastructure-pending",
      verifier: {
        verifierId: ACCESSIBILITY_DUNGEON_VERIFIER_ID,
        version: ACCESSIBILITY_DUNGEON_VERIFIER_VERSION,
      },
      infrastructureStatus: "unavailable",
      criteria: pact.verificationCriteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        status: "failed",
        artifactIds,
        evidence: "Deterministic verifier infrastructure was unavailable.",
      })),
      correctionConsumed: false,
      startedAt: input.startedAt,
      completedAt: null,
    });
  }

  if (input.completedAt === undefined) {
    throw new TypeError("completedAt is required for an available verifier");
  }

  const artifactEvidence = new Map<string, ArtifactEvidence>(
    input.artifacts.map((artifact) => [
      artifact.metadata.artifactId,
      {
        artifactType: artifact.metadata.artifactType,
        roleSlotId: artifact.metadata.roleSlotId,
      },
    ]),
  );
  const globalErrors = validatePactCoverage(pact);
  const assessed = input.artifacts.map((artifact) =>
    assessArtifact(
      artifact,
      pact,
      input.pactDigest,
      input.attempt,
      occupants,
      artifactEvidence,
    ),
  );
  const outputCounts = countBy(assessed, ({ artifact }) => artifact.outputId);
  const slotCounts = countBy(
    assessed,
    ({ artifact }) => artifact.metadata.roleSlotId,
  );
  for (const output of pact.requiredOutputs) {
    if ((outputCounts.get(output.outputId) ?? 0) !== 1) {
      globalErrors.push(`OUTPUT_COVERAGE:${output.outputId}`);
    }
  }
  for (const slot of pact.roleSlots) {
    if ((slotCounts.get(slot.roleSlotId) ?? 0) < 1) {
      globalErrors.push(`ROLE_OUTPUT_MISSING:${slot.roleSlotId}`);
    }
  }

  const criteria = pact.verificationCriteria.map((criterion) => {
    const criterionSlots = pact.roleSlots.filter((slot) =>
      slot.verificationCriterionIds.includes(criterion.criterionId),
    );
    const relevant = assessed.filter(({ artifact }) =>
      criterionSlots.some(
        (slot) => slot.roleSlotId === artifact.metadata.roleSlotId,
      ),
    );
    const errors = [
      ...globalErrors,
      ...relevant.flatMap(({ errors: artifactErrors }) => artifactErrors),
    ];
    const uniqueErrors = [...new Set(errors)].sort();
    const relevantIds = relevant.map(
      ({ artifact }) => artifact.metadata.artifactId,
    );
    return {
      criterionId: criterion.criterionId,
      status: uniqueErrors.length === 0 ? "passed" : "failed",
      artifactIds: relevantIds.length === 0 ? artifactIds : relevantIds,
      evidence:
        uniqueErrors.length === 0
          ? "Required output, role ownership, dependencies, fixture oracle, and hashes passed."
          : `Deterministic checks failed: ${uniqueErrors.join(", ").slice(0, 1_900)}`,
    } as const;
  });
  const status = criteria.every((criterion) => criterion.status === "passed")
    ? "passed"
    : "failed";

  return VerificationResultSchema.parse({
    protocol: "commitment/v1",
    kind: "verification",
    verificationRunId: input.verificationRunId,
    missionId: pact.missionId,
    pactDigest: input.pactDigest,
    attempt: input.attempt,
    status,
    verifier: {
      verifierId: ACCESSIBILITY_DUNGEON_VERIFIER_ID,
      version: ACCESSIBILITY_DUNGEON_VERIFIER_VERSION,
    },
    infrastructureStatus: "available",
    criteria,
    correctionConsumed: input.attempt === 2,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

function assessArtifact(
  candidate: VerificationArtifact,
  pact: Pact,
  pactDigest: string,
  verificationAttempt: 1 | 2,
  occupants: ReadonlyMap<string, string>,
  artifactEvidence: ReadonlyMap<string, ArtifactEvidence>,
): AssessedArtifact {
  const metadata = ArtifactMetadataSchema.parse(candidate.metadata);
  assertBoundedJson(candidate.content);
  const errors: string[] = [];
  const slot = pact.roleSlots.find(
    (entry) => entry.roleSlotId === metadata.roleSlotId,
  );
  const output = pact.requiredOutputs.find(
    (entry) => entry.outputId === candidate.outputId,
  );
  if (metadata.missionId !== pact.missionId) errors.push("MISSION_ID_MISMATCH");
  if (metadata.pactDigest !== pactDigest) errors.push("PACT_DIGEST_MISMATCH");
  if (metadata.attempt > verificationAttempt)
    errors.push("ARTIFACT_ATTEMPT_INVALID");
  if (slot === undefined) errors.push("ROLE_SLOT_UNKNOWN");
  if (output === undefined) errors.push("OUTPUT_UNKNOWN");
  if (
    slot !== undefined &&
    !slot.requiredOutputIds.includes(candidate.outputId)
  )
    errors.push("OUTPUT_ROLE_MISMATCH");
  if (output !== undefined && metadata.artifactType !== output.type)
    errors.push("OUTPUT_TYPE_MISMATCH");
  if (output !== undefined && metadata.mediaType !== output.mediaType)
    errors.push("OUTPUT_MEDIA_TYPE_MISMATCH");
  if (occupants.get(metadata.roleSlotId) !== metadata.producingAgentId)
    errors.push("ROLE_OCCUPANT_MISMATCH");
  if (canonicalJsonDigestSync(candidate.content) !== metadata.contentDigest)
    errors.push("CONTENT_DIGEST_MISMATCH");

  if (slot !== undefined) {
    const suppliedDependencies = new Set(candidate.dependencyArtifactIds);
    for (const dependencySlotId of slot.dependencyRoleSlotIds) {
      if (
        !pact.roleSlots.some((entry) => entry.roleSlotId === dependencySlotId)
      ) {
        errors.push("DEPENDENCY_ROLE_UNKNOWN");
      } else if (
        ![...suppliedDependencies].some(
          (artifactId) =>
            artifactEvidence.get(artifactId)?.roleSlotId === dependencySlotId,
        )
      ) {
        errors.push("DEPENDENCY_EVIDENCE_MISSING");
      }
    }
    for (const artifactId of suppliedDependencies) {
      const dependency = artifactEvidence.get(artifactId);
      const inheritedOutputDependency =
        metadata.artifactType === "remediation-plan" &&
        dependency?.artifactType === "accessibility-findings" &&
        dependency.roleSlotId === metadata.roleSlotId &&
        slot.requiredOutputIds.length === 2;
      if (
        dependency === undefined ||
        (!slot.dependencyRoleSlotIds.includes(dependency.roleSlotId) &&
          !inheritedOutputDependency)
      ) {
        errors.push("UNDECLARED_DEPENDENCY_EVIDENCE");
      }
    }
    if (
      metadata.artifactType === "remediation-plan" &&
      ![...suppliedDependencies].some(
        (artifactId) =>
          artifactEvidence.get(artifactId)?.artifactType ===
          "accessibility-findings",
      )
    ) {
      errors.push("DEPENDENCY_EVIDENCE_MISSING");
    }
  }

  errors.push(
    ...validateArtifactContent(metadata.artifactType, candidate.content),
  );
  return { artifact: candidate, errors };
}

function validatePactCoverage(pact: Pact): string[] {
  const errors: string[] = [];
  for (const output of pact.requiredOutputs) {
    const owners = pact.roleSlots.filter((slot) =>
      slot.requiredOutputIds.includes(output.outputId),
    );
    if (owners.length !== 1)
      errors.push(`PACT_OUTPUT_OWNER:${output.outputId}`);
  }
  for (const criterion of pact.verificationCriteria) {
    if (
      !pact.roleSlots.some((slot) =>
        slot.verificationCriterionIds.includes(criterion.criterionId),
      )
    ) {
      errors.push(`PACT_CRITERION_OWNER:${criterion.criterionId}`);
    }
  }
  return errors;
}

function resolveOccupants(
  pact: Pact,
  pactDigest: string,
  replacements: readonly ReplacementProof[],
): ReadonlyMap<string, string> {
  const occupants = new Map(
    pact.roleSlots.map((slot) => [slot.roleSlotId, slot.originalAgentId]),
  );
  for (const replacement of replacements) {
    if (
      replacement.missionId !== pact.missionId ||
      replacement.pactDigest !== pactDigest ||
      !occupants.has(replacement.roleSlotId)
    ) {
      throw new TypeError("Replacement is outside the bound Pact");
    }
    if (
      occupants.get(replacement.roleSlotId) !== replacement.predecessorAgentId
    ) {
      throw new TypeError(
        "Replacement predecessor is not the current occupant",
      );
    }
    occupants.set(replacement.roleSlotId, replacement.replacementAgentId);
  }
  return occupants;
}

function assertApprovedPactInput(pact: Pact, publicLocation: string): void {
  let approvedUrl: URL;
  try {
    approvedUrl = new URL(publicLocation);
  } catch {
    throw new TypeError("Verifier fixture location is invalid");
  }
  if (
    approvedUrl.protocol !== "https:" ||
    approvedUrl.search !== "" ||
    approvedUrl.hash !== "" ||
    approvedUrl.pathname !== "/fixtures/accessibility-dungeon-v1"
  ) {
    throw new TypeError("Verifier fixture location is not allowlisted");
  }
  const approved =
    pact.publicInputs.length === 1 &&
    pact.publicInputs.some((input) => {
      if (input.type !== "url" || input.mediaType !== "text/html") return false;
      if (input.contentDigest !== ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST) {
        return false;
      }
      try {
        const url = new URL(input.location);
        return (
          url.href === approvedUrl.href &&
          url.protocol === "https:" &&
          url.search === "" &&
          url.hash === "" &&
          url.pathname === "/fixtures/accessibility-dungeon-v1"
        );
      } catch {
        return false;
      }
    });
  if (!approved) {
    throw new TypeError("Pact does not reference the allowlisted fixture");
  }
}

function assertSupportedPactShape(pact: Pact): void {
  if (
    pact.maximumPartySize !== 2 ||
    pact.roleSlots.length < 1 ||
    pact.roleSlots.length > 2 ||
    pact.requiredOutputs.length !== 2 ||
    pact.verificationCriteria.length !== 2
  ) {
    throw new TypeError(
      "Pact is not the supported Accessibility Dungeon shape",
    );
  }
  const findingsOutput = pact.requiredOutputs.find(
    (output) => output.type === "accessibility-findings",
  );
  const remediationOutput = pact.requiredOutputs.find(
    (output) => output.type === "remediation-plan",
  );
  if (
    findingsOutput === undefined ||
    remediationOutput === undefined ||
    findingsOutput.mediaType !== "application/json" ||
    remediationOutput.mediaType !== "application/json" ||
    findingsOutput.publicLocation !== "mission-artifact" ||
    remediationOutput.publicLocation !== "mission-artifact"
  ) {
    throw new TypeError("Pact outputs do not match the fixture verifier");
  }
  const findingsSlot = pact.roleSlots.find((slot) =>
    slot.requiredOutputIds.includes(findingsOutput.outputId),
  );
  const remediationSlot = pact.roleSlots.find((slot) =>
    slot.requiredOutputIds.includes(remediationOutput.outputId),
  );
  const criterionIds = pact.verificationCriteria.map(
    (criterion) => criterion.criterionId,
  );
  const assignedCriterionIds = pact.roleSlots.flatMap(
    (slot) => slot.verificationCriterionIds,
  );
  const inherited = findingsSlot === remediationSlot;
  if (
    findingsSlot === undefined ||
    remediationSlot === undefined ||
    pact.verificationCriteria.some(
      (criterion) =>
        !criterion.required || criterion.method !== "deterministic",
    ) ||
    !sameStringArray(assignedCriterionIds, criterionIds) ||
    !sameStringArray(findingsSlot.dependencyRoleSlotIds, [])
  ) {
    throw new TypeError(
      "Pact roles and criteria do not match the fixture verifier",
    );
  }
  if (inherited) {
    if (
      !sameStringArray(findingsSlot.requiredCapabilities, [
        "accessibility-audit",
        "remediation-planning",
      ]) ||
      !sameStringArray(findingsSlot.requiredOutputIds, [
        findingsOutput.outputId,
        remediationOutput.outputId,
      ]) ||
      !sameStringArray(findingsSlot.verificationCriterionIds, criterionIds)
    ) {
      throw new TypeError("Inherited role does not cover the complete fixture");
    }
  } else if (
    !sameStringArray(findingsSlot.requiredCapabilities, [
      "accessibility-audit",
    ]) ||
    !sameStringArray(findingsSlot.requiredOutputIds, [
      findingsOutput.outputId,
    ]) ||
    !sameStringArray(remediationSlot.requiredCapabilities, [
      "remediation-planning",
    ]) ||
    !sameStringArray(remediationSlot.requiredOutputIds, [
      remediationOutput.outputId,
    ]) ||
    !sameStringArray(remediationSlot.dependencyRoleSlotIds, [
      findingsSlot.roleSlotId,
    ]) ||
    findingsSlot.verificationCriterionIds.length !== 1 ||
    remediationSlot.verificationCriterionIds.length !== 1
  ) {
    throw new TypeError("Split roles do not preserve fixture dependencies");
  }
}

function validateArtifactContent(
  artifactType: ArtifactMetadata["artifactType"],
  value: unknown,
): string[] {
  const record = asRecord(value);
  if (
    record === undefined ||
    record.protocol !== "commitment/v1" ||
    record.kind !== artifactType ||
    record.fixtureId !== ACCESSIBILITY_DUNGEON_FIXTURE_ID
  ) {
    return ["ARTIFACT_CONTENT_SHAPE"];
  }
  if (artifactType === "accessibility-findings") {
    return record.parserVersion === ACCESSIBILITY_DUNGEON_VERIFIER_VERSION &&
      Object.keys(record).length === 5 &&
      sameFindings(record.findings)
      ? []
      : ["FINDINGS_ORACLE_MISMATCH"];
  }
  if (artifactType === "remediation-plan") {
    return record.templateVersion === ACCESSIBILITY_DUNGEON_VERIFIER_VERSION &&
      Object.keys(record).length === 6 &&
      sameRemediation(record)
      ? []
      : ["REMEDIATION_ORACLE_MISMATCH"];
  }
  return ["UNSUPPORTED_SELF_CERTIFIED_EVIDENCE"];
}

function sameFindings(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== EXPECTED_FINDINGS.length)
    return false;
  const received = [...value].sort((left, right) =>
    String(asRecord(left)?.findingId ?? "").localeCompare(
      String(asRecord(right)?.findingId ?? ""),
    ),
  );
  return received.every((candidate, index) => {
    const record = asRecord(candidate);
    const expected = EXPECTED_FINDINGS[index];
    return (
      record !== undefined &&
      expected !== undefined &&
      record.evidence === expected.evidence &&
      record.findingId === expected.findingId &&
      record.ruleId === expected.ruleId &&
      record.selector === expected.selector &&
      record.severity === expected.severity &&
      Object.keys(record).length === 5
    );
  });
}

function sameRemediation(record: Readonly<Record<string, unknown>>): boolean {
  const expectedIds = EXPECTED_FINDINGS.map((finding) => finding.findingId);
  if (
    !sameStringArray(record.coveredFindingIds, expectedIds) ||
    !Array.isArray(record.steps) ||
    record.steps.length !== EXPECTED_FINDINGS.length
  ) {
    return false;
  }
  const steps = [...record.steps].sort((left, right) =>
    String(asRecord(left)?.findingId ?? "").localeCompare(
      String(asRecord(right)?.findingId ?? ""),
    ),
  );
  return steps.every((candidate, index) => {
    const step = asRecord(candidate);
    const finding = EXPECTED_FINDINGS[index];
    return (
      step !== undefined &&
      finding !== undefined &&
      step.findingId === finding.findingId &&
      step.ruleId === finding.ruleId &&
      step.selector === finding.selector &&
      step.change === finding.change &&
      step.acceptance === finding.acceptance &&
      Object.keys(step).length === 5
    );
  });
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    [...value]
      .sort()
      .every((entry, index) => entry === [...expected].sort()[index])
  );
}

function assertBoundedJson(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      MAXIMUM_ARTIFACT_CONTENT_BYTES
  ) {
    throw new RangeError("Artifact content exceeds the verifier byte limit");
  }
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) {
      throw new RangeError("Artifact content exceeds verifier JSON limits");
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, depth + 1));
    } else if (asRecord(candidate) !== undefined) {
      Object.values(candidate as Record<string, unknown>).forEach((entry) =>
        visit(entry, depth + 1),
      );
    }
  };
  visit(value, 0);
}

function assertDependencyIds(values: readonly string[]): void {
  if (values.length > 2 || new Set(values).size !== values.length) {
    throw new TypeError("Artifact dependency IDs must be unique and bounded");
  }
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const itemKey = key(value);
    counts.set(itemKey, (counts.get(itemKey) ?? 0) + 1);
  });
  return counts;
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
