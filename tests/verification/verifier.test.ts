import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PactSchema,
  type ArtifactMetadata,
  type Pact,
} from "../../packages/contracts/src/index.js";
import {
  ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST,
  ACCESSIBILITY_DUNGEON_FIXTURE_ID,
  canonicalJsonDigestSync,
  verifyAccessibilityDungeon,
  type AccessibilityVerificationInput,
  type VerificationArtifact,
} from "../../packages/trust-engine/src/index.js";

const FINDINGS_ARTIFACT_ID = "c0000000-0000-4000-8000-000000000001";
const PLAN_ARTIFACT_ID = "c0000000-0000-4000-8000-000000000002";
const SIGNATURE =
  "geeS8OfkZu58SbruseOyMNxOx99WeNxotlKprYIsx-wJumv1iMANhB8JidULFPmTjDs-wuATE4w6vJ0URig2IA";

const findings = [
  {
    evidence: "The root html element has no lang attribute.",
    findingId: "finding-html-lang",
    ruleId: "html-has-lang",
    selector: "html",
    severity: "serious",
  },
  {
    evidence: "The quest-map image has no alt attribute.",
    findingId: "finding-image-alt",
    ruleId: "image-alt",
    selector: "img[src='quest-map.png']",
    severity: "serious",
  },
  {
    evidence: "The empty button has no accessible name.",
    findingId: "finding-button-name",
    ruleId: "button-name",
    selector: "#accept-quest",
    severity: "serious",
  },
  {
    evidence:
      "The visible label is not programmatically associated with the input.",
    findingId: "finding-form-label",
    ruleId: "label",
    selector: "#hero-name",
    severity: "moderate",
  },
] as const;

const findingsContent = {
  protocol: "commitment/v1",
  kind: "accessibility-findings",
  fixtureId: ACCESSIBILITY_DUNGEON_FIXTURE_ID,
  parserVersion: "1.0.0",
  findings,
} as const;

const remediationContent = {
  protocol: "commitment/v1",
  kind: "remediation-plan",
  fixtureId: ACCESSIBILITY_DUNGEON_FIXTURE_ID,
  templateVersion: "1.0.0",
  coveredFindingIds: [
    "finding-button-name",
    "finding-form-label",
    "finding-html-lang",
    "finding-image-alt",
  ],
  steps: [
    {
      acceptance: "The button-name rule passes for the approved fixture.",
      change: "Add the visible text Accept quest to the button.",
      findingId: "finding-button-name",
      ruleId: "button-name",
      selector: "#accept-quest",
    },
    {
      acceptance: "The label rule passes for the approved fixture.",
      change: 'Add for="hero-name" to the visible Hero name label.',
      findingId: "finding-form-label",
      ruleId: "label",
      selector: "#hero-name",
    },
    {
      acceptance: "The html-has-lang rule passes for the approved fixture.",
      change: 'Add lang="en" to the root html element.',
      findingId: "finding-html-lang",
      ruleId: "html-has-lang",
      selector: "html",
    },
    {
      acceptance: "The image-alt rule passes for the approved fixture.",
      change: 'Add alt="Map of the accessibility dungeon" to the quest image.',
      findingId: "finding-image-alt",
      ruleId: "image-alt",
      selector: "img[src='quest-map.png']",
    },
  ],
} as const;

describe("Accessibility Dungeon deterministic verifier", () => {
  let pact: Pact;

  beforeAll(async () => {
    const normativePact = PactSchema.parse(
      JSON.parse(
        await readFile(
          resolve("protocol/commitment-v1/examples/pact.valid.json"),
          "utf8",
        ),
      ) as unknown,
    );
    pact = PactSchema.parse({
      ...normativePact,
      publicInputs: normativePact.publicInputs.map((input) => ({
        ...input,
        location: "https://guildhall.test/fixtures/accessibility-dungeon-v1",
      })),
    });
  });

  it("passes exact role-owned outputs, dependency linkage, and hashes", () => {
    const result = verifyAccessibilityDungeon(validInput(pact));

    expect(result.status).toBe("passed");
    expect(
      result.criteria.every((criterion) => criterion.status === "passed"),
    ).toBe(true);
    expect(result.correctionConsumed).toBe(false);
  });

  it("rejects a pact whose public input does not bind the fixture bytes", () => {
    const substitutedInput = PactSchema.parse({
      ...pact,
      publicInputs: pact.publicInputs.map((input) => ({
        ...input,
        contentDigest: "D".repeat(43),
      })),
    });

    expect(() =>
      verifyAccessibilityDungeon(validInput(substitutedInput)),
    ).toThrow("Pact does not reference the allowlisted fixture");
  });

  it("accepts the live formation seed's minimum-one structural criteria", () => {
    const formationSeed = PactSchema.parse({
      ...pact,
      minimumPartySize: 1,
      verificationCriteria: pact.verificationCriteria.map(
        (criterion, index) => ({
          ...criterion,
          description:
            index === 0
              ? "Every finding includes a stable rule and selector."
              : "Every finding maps to one remediation step.",
        }),
      ),
    });

    expect(verifyAccessibilityDungeon(validInput(formationSeed)).status).toBe(
      "passed",
    );
  });

  it("accepts one-helper inheritance without weakening output coverage", () => {
    const firstSlot = pact.roleSlots[0];
    const requester = pact.participants.find(
      (participant) => participant.role === "requester",
    );
    const helper = pact.participants.find(
      (participant) => participant.agentId === firstSlot?.originalAgentId,
    );
    if (
      firstSlot === undefined ||
      requester === undefined ||
      helper === undefined
    ) {
      throw new Error("Pact fixture does not contain the inherited helper");
    }
    const inherited = PactSchema.parse({
      ...pact,
      minimumPartySize: 1,
      participants: [requester, helper],
      roleSlots: [
        {
          ...firstSlot,
          requiredCapabilities: ["accessibility-audit", "remediation-planning"],
          dependencyRoleSlotIds: [],
          requiredOutputIds: pact.requiredOutputs.map(
            (output) => output.outputId,
          ),
          verificationCriterionIds: pact.verificationCriteria.map(
            (criterion) => criterion.criterionId,
          ),
          pointAllocation: pact.reward.totalPoints,
        },
      ],
    });

    expect(verifyAccessibilityDungeon(validInput(inherited)).status).toBe(
      "passed",
    );
  });

  it("returns a correctable semantic failure on the first attempt", () => {
    const input = validInput(pact);
    const invalidPlan = {
      ...remediationContent,
      coveredFindingIds: remediationContent.coveredFindingIds.slice(1),
    };
    input.artifacts[1] = artifact(pact, "plan", invalidPlan, [
      FINDINGS_ARTIFACT_ID,
    ]);

    const result = verifyAccessibilityDungeon(input);

    expect(result.status).toBe("failed");
    expect(result.correctionConsumed).toBe(false);
    expect(
      result.criteria.some((criterion) =>
        criterion.evidence.includes("REMEDIATION_ORACLE_MISMATCH"),
      ),
    ).toBe(true);
  });

  it("marks the second unresolved semantic failure as correction consumed", () => {
    const input = validInput(pact, 2);
    const invalidFindings = {
      ...findingsContent,
      findings: findings.slice(1),
    };
    input.artifacts[0] = artifact(pact, "findings", invalidFindings, [], 2);

    const result = verifyAccessibilityDungeon(input);

    expect(result.status).toBe("failed");
    expect(result.correctionConsumed).toBe(true);
    expect(
      result.criteria.some((criterion) =>
        criterion.evidence.includes("FINDINGS_ORACLE_MISMATCH"),
      ),
    ).toBe(true);
  });

  it("returns infrastructure-pending without consuming a correction or fetching", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const input = validInput(pact, 2);
    input.infrastructureStatus = "unavailable";
    delete input.completedAt;

    const result = verifyAccessibilityDungeon(input);

    expect(result.status).toBe("infrastructure-pending");
    expect(result.infrastructureStatus).toBe("unavailable");
    expect(result.completedAt).toBeNull();
    expect(result.correctionConsumed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    {
      name: "missing required output and role",
      mutate(input: MutableVerificationInput) {
        input.artifacts.splice(1, 1);
      },
      evidence: "OUTPUT_COVERAGE",
      scope: "all",
    },
    {
      name: "dependency evidence from the wrong role",
      mutate(input: MutableVerificationInput) {
        input.artifacts[1] = artifact(pact, "plan", remediationContent, [
          PLAN_ARTIFACT_ID,
        ]);
      },
      evidence: "DEPENDENCY_EVIDENCE_MISSING",
      scope: "relevant",
    },
    {
      name: "content hash mismatch",
      mutate(input: MutableVerificationInput) {
        const first = requireArtifact(input, 0);
        input.artifacts[0] = {
          ...first,
          metadata: {
            ...first.metadata,
            contentDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        };
      },
      evidence: "CONTENT_DIGEST_MISMATCH",
      scope: "relevant",
    },
    {
      name: "unknown-role duplicate cannot hide output coverage",
      mutate(input: MutableVerificationInput) {
        const first = requireArtifact(input, 0);
        input.artifacts.push({
          ...first,
          metadata: {
            ...first.metadata,
            artifactId: "c0000000-0000-4000-8000-000000000003",
            roleSlotId: "99999999-9999-4999-8999-999999999999",
          },
        });
      },
      evidence: "OUTPUT_COVERAGE",
      scope: "all",
    },
  ])("fails $name", ({ mutate, evidence, scope }) => {
    const input = validInput(pact);
    mutate(input);

    const result = verifyAccessibilityDungeon(input);

    expect(result.status).toBe("failed");
    const evidenceMatches = result.criteria.filter((criterion) =>
      criterion.evidence.includes(evidence),
    );
    expect(evidenceMatches.length).toBeGreaterThan(0);
    if (scope === "all") {
      expect(evidenceMatches).toHaveLength(result.criteria.length);
    }
  });

  it("rejects a pact that substitutes self-certified verifier evidence", () => {
    const unsupported = PactSchema.parse({
      ...pact,
      requiredOutputs: pact.requiredOutputs.map((output, index) =>
        index === 0 ? { ...output, type: "verification-evidence" } : output,
      ),
    });
    const input = validInput(pact);
    input.pact = unsupported;
    input.pactDigest = canonicalJsonDigestSync(unsupported);

    expect(() => verifyAccessibilityDungeon(input)).toThrow(
      /outputs do not match/u,
    );
  });
});

type MutableVerificationInput = Omit<
  AccessibilityVerificationInput,
  "artifacts" | "completedAt" | "infrastructureStatus" | "pact" | "pactDigest"
> & {
  artifacts: VerificationArtifact[];
  completedAt?: string;
  infrastructureStatus: "available" | "unavailable";
  pact: Pact;
  pactDigest: string;
};

function validInput(pact: Pact, attempt: 1 | 2 = 1): MutableVerificationInput {
  return {
    verificationRunId: "e0000000-0000-4000-8000-000000000001",
    pact,
    pactDigest: canonicalJsonDigestSync(pact),
    attempt,
    fixture: {
      fixtureId: ACCESSIBILITY_DUNGEON_FIXTURE_ID,
      contentDigest: ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST,
      publicLocation: requireFixtureLocation(pact),
    },
    artifacts: [
      artifact(pact, "findings", findingsContent, [], attempt),
      artifact(
        pact,
        "plan",
        remediationContent,
        [FINDINGS_ARTIFACT_ID],
        attempt,
      ),
    ],
    infrastructureStatus: "available",
    startedAt: "2026-08-26T12:49:58.000Z",
    completedAt: "2026-08-26T12:50:00.000Z",
  };
}

function requireFixtureLocation(pact: Pact): string {
  const input = pact.publicInputs[0];
  if (input?.type !== "url") throw new Error("Pact fixture URL is missing");
  return input.location;
}

function artifact(
  pact: Pact,
  kind: "findings" | "plan",
  content: unknown,
  dependencyArtifactIds: readonly string[],
  attempt: 1 | 2 = 1,
): VerificationArtifact {
  const expectedType =
    kind === "findings" ? "accessibility-findings" : "remediation-plan";
  const output = pact.requiredOutputs.find(
    (candidate) => candidate.type === expectedType,
  );
  const slot = pact.roleSlots.find((candidate) =>
    output === undefined
      ? false
      : candidate.requiredOutputIds.includes(output.outputId),
  );
  if (slot === undefined || output === undefined) {
    throw new Error("Pact fixture is incomplete");
  }
  const artifactId =
    kind === "findings" ? FINDINGS_ARTIFACT_ID : PLAN_ARTIFACT_ID;
  const metadata: ArtifactMetadata = {
    protocol: "commitment/v1",
    kind: "artifact-metadata",
    artifactId,
    missionId: pact.missionId,
    pactDigest: canonicalJsonDigestSync(pact),
    roleSlotId: slot.roleSlotId,
    producingAgentId: slot.originalAgentId,
    keyId: "f0000000-0000-4000-8000-000000000002",
    attempt,
    artifactType: output.type,
    mediaType: "application/json",
    publicLocation: `https://guildhall.example/artifacts/${artifactId}`,
    contentDigest: canonicalJsonDigestSync(content),
    signature: SIGNATURE,
    safetyStatus: "approved",
    completedAt: "2026-08-26T12:49:59.000Z",
  };
  return {
    outputId: output.outputId,
    metadata,
    content,
    dependencyArtifactIds,
  };
}

function requireArtifact(
  input: MutableVerificationInput,
  index: number,
): VerificationArtifact {
  const value = input.artifacts[index];
  if (value === undefined) throw new Error(`Missing artifact ${index}`);
  return value;
}
