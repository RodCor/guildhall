import {
  ArtifactMetadataSchema,
  GitHubPullRequestEvidenceSchema,
  PactSchema,
  ReplacementProofSchema,
  VerificationResultSchema,
  type Pact,
  type ReplacementProof,
  type VerificationResult,
} from "@guildhall/contracts";

import { canonicalJsonDigestSync } from "./eventHashChain.js";
import type { VerificationArtifact } from "./verifier.js";

export const GITHUB_PULL_REQUEST_VERIFIER_ID =
  "github-pull-request-v1" as const;
export const GITHUB_PULL_REQUEST_VERIFIER_VERSION = "1.0.0" as const;

const MAXIMUM_GITHUB_RESPONSE_BYTES = 512 * 1024;
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export interface GitHubDeliveryVerificationInput {
  readonly verificationRunId: string;
  readonly pact: Pact;
  readonly pactDigest: string;
  readonly attempt: 1 | 2;
  readonly artifacts: readonly VerificationArtifact[];
  readonly replacements?: readonly ReplacementProof[];
  readonly infrastructureStatus: "available" | "unavailable";
  readonly startedAt: string;
  readonly completedAt?: string;
}

interface AssessedArtifact {
  readonly artifact: VerificationArtifact;
  readonly errors: string[];
}

interface GitHubAssessment {
  readonly infrastructureUnavailable: boolean;
  readonly errors: readonly string[];
}

/**
 * Verifies a tokenless delivery against GitHub's allowlisted public API.
 * Repository writes remain in the producer's harness; Guildhall only reads
 * the exact public repository, PR number, commit, base ref, and check runs
 * committed by the signed artifact metadata.
 */
export async function verifyGitHubPullRequestDelivery(
  input: GitHubDeliveryVerificationInput,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<VerificationResult> {
  const pact = PactSchema.parse(input.pact);
  if (canonicalJsonDigestSync(pact) !== input.pactDigest) {
    throw new TypeError("pactDigest does not match the canonical Pact");
  }
  if (input.artifacts.length < 1 || input.artifacts.length > 8) {
    throw new RangeError(
      "Verification requires between one and eight artifacts",
    );
  }

  const artifactIds = input.artifacts.map(
    (artifact) => artifact.metadata.artifactId,
  );
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new TypeError("Artifact identifiers must be unique");
  }
  const completedAt = input.completedAt;
  if (
    input.infrastructureStatus === "unavailable" ||
    completedAt === undefined
  ) {
    return pendingResult(input, pact, artifactIds);
  }

  const replacements = (input.replacements ?? []).map((replacement) =>
    ReplacementProofSchema.parse(replacement),
  );
  const occupants = resolveOccupants(pact, input.pactDigest, replacements);
  const globalErrors = validatePactShape(pact);
  const assessed = input.artifacts.map((artifact) =>
    assessArtifact(artifact, pact, input.pactDigest, input.attempt, occupants),
  );
  const artifactRoles = new Map(
    input.artifacts.map((artifact) => [
      artifact.metadata.artifactId,
      artifact.metadata.roleSlotId,
    ]),
  );
  for (const assessment of assessed) {
    assessment.errors.push(
      ...validateDependencies(assessment.artifact, pact, artifactRoles),
    );
  }
  const outputCounts = countBy(assessed, ({ artifact }) => artifact.outputId);
  for (const output of pact.requiredOutputs) {
    if ((outputCounts.get(output.outputId) ?? 0) !== 1) {
      globalErrors.push(`OUTPUT_COVERAGE:${output.outputId}`);
    }
  }

  const evidenceAssessments = await Promise.all(
    assessed.map(async ({ artifact, errors }) => {
      if (errors.length > 0)
        return { infrastructureUnavailable: false, errors };
      const evidence = artifact.metadata.deliveryEvidence;
      const target = pact.executionTarget;
      if (evidence === undefined || target?.kind !== "github") {
        return {
          infrastructureUnavailable: false,
          errors: [...errors, "GITHUB_DELIVERY_EVIDENCE_MISSING"],
        };
      }
      const github = await assessPublicPullRequest(target, evidence, fetchImpl);
      return {
        infrastructureUnavailable: github.infrastructureUnavailable,
        errors: [...errors, ...github.errors],
      };
    }),
  );
  if (evidenceAssessments.some((result) => result.infrastructureUnavailable)) {
    return pendingResult(input, pact, artifactIds);
  }
  for (const [index, assessment] of evidenceAssessments.entries()) {
    const errors = assessed[index]!.errors;
    errors.length = 0;
    errors.push(...assessment.errors);
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
      ...relevant.flatMap((assessment) => assessment.errors),
    ];
    const uniqueErrors = [...new Set(errors)].sort();
    const relevantIds = relevant.map(
      ({ artifact }) => artifact.metadata.artifactId,
    );
    return {
      criterionId: criterion.criterionId,
      status:
        uniqueErrors.length === 0 ? ("passed" as const) : ("failed" as const),
      artifactIds: relevantIds.length > 0 ? relevantIds : artifactIds,
      evidence:
        uniqueErrors.length === 0
          ? "Public GitHub PR, head commit, base branch, and declared check policy verified."
          : `GitHub delivery rejected: ${uniqueErrors.join(", ")}`,
    };
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
      verifierId: GITHUB_PULL_REQUEST_VERIFIER_ID,
      version: GITHUB_PULL_REQUEST_VERIFIER_VERSION,
    },
    infrastructureStatus: "available",
    criteria,
    correctionConsumed: input.attempt === 2,
    startedAt: input.startedAt,
    completedAt,
  });
}

function pendingResult(
  input: GitHubDeliveryVerificationInput,
  pact: Pact,
  artifactIds: readonly string[],
): VerificationResult {
  return VerificationResultSchema.parse({
    protocol: "commitment/v1",
    kind: "verification",
    verificationRunId: input.verificationRunId,
    missionId: pact.missionId,
    pactDigest: input.pactDigest,
    attempt: input.attempt,
    status: "infrastructure-pending",
    verifier: {
      verifierId: GITHUB_PULL_REQUEST_VERIFIER_ID,
      version: GITHUB_PULL_REQUEST_VERIFIER_VERSION,
    },
    infrastructureStatus: "unavailable",
    criteria: pact.verificationCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      status: "failed",
      artifactIds,
      evidence: "GitHub public verification is temporarily unavailable.",
    })),
    correctionConsumed: false,
    startedAt: input.startedAt,
    completedAt: null,
  });
}

function assessArtifact(
  artifact: VerificationArtifact,
  pact: Pact,
  pactDigest: string,
  attempt: 1 | 2,
  occupants: ReadonlyMap<string, string>,
): AssessedArtifact {
  const metadataResult = ArtifactMetadataSchema.safeParse(artifact.metadata);
  if (!metadataResult.success)
    return { artifact, errors: ["ARTIFACT_METADATA"] };
  const metadata = metadataResult.data;
  const output = pact.requiredOutputs.find(
    (candidate) => candidate.outputId === artifact.outputId,
  );
  const slot = pact.roleSlots.find(
    (candidate) => candidate.roleSlotId === metadata.roleSlotId,
  );
  const errors: string[] = [];
  if (metadata.missionId !== pact.missionId) errors.push("MISSION_ID_MISMATCH");
  if (metadata.pactDigest !== pactDigest) errors.push("PACT_DIGEST_MISMATCH");
  if (metadata.attempt > attempt) errors.push("ARTIFACT_ATTEMPT_INVALID");
  if (output === undefined) errors.push("OUTPUT_UNKNOWN");
  if (slot === undefined) errors.push("ROLE_SLOT_UNKNOWN");
  if (
    slot !== undefined &&
    !slot.requiredOutputIds.includes(artifact.outputId)
  ) {
    errors.push("OUTPUT_ROLE_MISMATCH");
  }
  if (output !== undefined && metadata.artifactType !== output.type) {
    errors.push("OUTPUT_TYPE_MISMATCH");
  }
  if (output !== undefined && metadata.mediaType !== output.mediaType) {
    errors.push("OUTPUT_MEDIA_TYPE_MISMATCH");
  }
  if (occupants.get(metadata.roleSlotId) !== metadata.producingAgentId) {
    errors.push("ROLE_OCCUPANT_MISMATCH");
  }
  if (canonicalJsonDigestSync(artifact.content) !== metadata.contentDigest) {
    errors.push("CONTENT_DIGEST_MISMATCH");
  }
  const evidence = metadata.deliveryEvidence;
  const target = pact.executionTarget;
  if (
    output?.delivery?.kind !== "github-pull-request" ||
    target?.kind !== "github" ||
    evidence === undefined ||
    evidence.repository.toLowerCase() !== target.repository.toLowerCase() ||
    evidence.baseRef !== target.baseRef ||
    (target.checkPolicy === "all-success" && evidence.checks.length === 0)
  ) {
    errors.push("DELIVERY_CONTRACT_MISMATCH");
  }

  return { artifact, errors };
}

function validateDependencies(
  artifact: VerificationArtifact,
  pact: Pact,
  artifactRoles: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  const slot = pact.roleSlots.find(
    (candidate) => candidate.roleSlotId === artifact.metadata.roleSlotId,
  );
  if (slot === undefined) return errors;
  const dependencyIds = new Set(artifact.dependencyArtifactIds);
  if (dependencyIds.size !== artifact.dependencyArtifactIds.length) {
    errors.push("DUPLICATE_DEPENDENCY_EVIDENCE");
  }
  for (const dependencySlotId of slot.dependencyRoleSlotIds) {
    if (
      ![...dependencyIds].some(
        (artifactId) => artifactRoles.get(artifactId) === dependencySlotId,
      )
    ) {
      errors.push("DEPENDENCY_EVIDENCE_MISSING");
    }
  }
  for (const artifactId of dependencyIds) {
    const roleSlotId = artifactRoles.get(artifactId);
    if (
      roleSlotId === undefined ||
      !slot.dependencyRoleSlotIds.includes(roleSlotId)
    ) {
      errors.push("UNDECLARED_DEPENDENCY_EVIDENCE");
    }
  }
  return errors;
}

function validatePactShape(pact: Pact): string[] {
  const errors: string[] = [];
  if (pact.executionTarget?.kind !== "github") {
    errors.push("GITHUB_EXECUTION_TARGET_REQUIRED");
  }
  if (
    pact.requiredOutputs.some(
      (output) =>
        output.type !== "code-change" ||
        output.delivery?.kind !== "github-pull-request",
    )
  ) {
    errors.push("GITHUB_OUTPUT_CONTRACT_REQUIRED");
  }
  if (
    pact.verificationCriteria.some(
      (criterion) => criterion.method !== "public-github",
    )
  ) {
    errors.push("GITHUB_VERIFICATION_METHOD_REQUIRED");
  }
  for (const output of pact.requiredOutputs) {
    if (
      pact.roleSlots.filter((slot) =>
        slot.requiredOutputIds.includes(output.outputId),
      ).length !== 1
    ) {
      errors.push(`PACT_OUTPUT_OWNER:${output.outputId}`);
    }
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

async function assessPublicPullRequest(
  target: Extract<NonNullable<Pact["executionTarget"]>, { kind: "github" }>,
  rawEvidence: unknown,
  fetchImpl: typeof globalThis.fetch,
): Promise<GitHubAssessment> {
  const parsed = GitHubPullRequestEvidenceSchema.safeParse(rawEvidence);
  if (!parsed.success) {
    return {
      infrastructureUnavailable: false,
      errors: ["PR_EVIDENCE_INVALID"],
    };
  }
  const evidence = parsed.data;
  const prNumber = Number(
    new URL(evidence.pullRequestUrl).pathname.split("/").at(-1),
  );
  const [owner, repository] = target.repository.split("/") as [string, string];
  const pullRequest = await readGitHubJson(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${String(prNumber)}`,
    fetchImpl,
  );
  if (pullRequest.kind === "infrastructure") {
    return { infrastructureUnavailable: true, errors: [] };
  }
  if (pullRequest.kind === "rejected") {
    return { infrastructureUnavailable: false, errors: [pullRequest.code] };
  }

  const errors: string[] = [];
  const pr = record(pullRequest.value);
  const head = record(pr?.head);
  const base = record(pr?.base);
  const baseRepository = record(base?.repo);
  if (pr === null) errors.push("PR_RESPONSE_INVALID");
  if (string(pr?.html_url) !== evidence.pullRequestUrl)
    errors.push("PR_URL_MISMATCH");
  if (string(head?.sha) !== evidence.headSha)
    errors.push("PR_HEAD_SHA_MISMATCH");
  if (string(base?.ref) !== target.baseRef) errors.push("PR_BASE_REF_MISMATCH");
  if (
    string(baseRepository?.full_name)?.toLowerCase() !==
    target.repository.toLowerCase()
  ) {
    errors.push("PR_REPOSITORY_MISMATCH");
  }
  if (pr?.draft !== false) errors.push("PR_IS_DRAFT");
  if (pr?.state !== "open" && pr?.merged !== true)
    errors.push("PR_NOT_ACTIVE_OR_MERGED");

  if (target.checkPolicy === "all-success" || evidence.checks.length > 0) {
    const checks = await readGitHubJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${evidence.headSha}/check-runs?per_page=100`,
      fetchImpl,
    );
    if (checks.kind === "infrastructure") {
      return { infrastructureUnavailable: true, errors: [] };
    }
    if (checks.kind === "rejected") {
      errors.push(checks.code);
    } else {
      const checkRuns = array(record(checks.value)?.check_runs)
        .map(record)
        .filter((value): value is Record<string, unknown> => value !== null);
      const actualByName = new Map(
        checkRuns.flatMap((check) => {
          const name = string(check.name);
          return name === undefined ? [] : [[name, check] as const];
        }),
      );
      if (target.checkPolicy === "all-success" && checkRuns.length === 0) {
        errors.push("CHECK_RUNS_MISSING");
      }
      if (
        target.checkPolicy === "all-success" &&
        checkRuns.some(
          (check) =>
            check.status !== "completed" ||
            typeof check.conclusion !== "string" ||
            !SUCCESSFUL_CHECK_CONCLUSIONS.has(check.conclusion),
        )
      ) {
        errors.push("CHECK_RUNS_NOT_SUCCESSFUL");
      }
      for (const declared of evidence.checks) {
        const actual = actualByName.get(declared.name);
        if (
          actual === undefined ||
          actual.status !== declared.status ||
          actual.conclusion !== declared.conclusion ||
          (declared.detailsUrl !== undefined &&
            actual.details_url !== declared.detailsUrl)
        ) {
          errors.push(`CHECK_EVIDENCE_MISMATCH:${declared.name}`);
        }
      }
    }
  }
  return { infrastructureUnavailable: false, errors };
}

type GitHubReadResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "infrastructure" }
  | { readonly kind: "rejected"; readonly code: string };

async function readGitHubJson(
  url: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<GitHubReadResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Guildhall-PactBridge/1.0",
      },
      redirect: "error",
    });
  } catch {
    return { kind: "infrastructure" };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "infrastructure" };
  }
  if (!response.ok) {
    return { kind: "rejected", code: `GITHUB_HTTP_${String(response.status)}` };
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAXIMUM_GITHUB_RESPONSE_BYTES
  ) {
    return { kind: "rejected", code: "GITHUB_RESPONSE_TOO_LARGE" };
  }
  let text: string | null;
  try {
    text = await readBoundedResponseText(
      response,
      MAXIMUM_GITHUB_RESPONSE_BYTES,
    );
  } catch {
    return { kind: "infrastructure" };
  }
  if (text === null) {
    return { kind: "rejected", code: "GITHUB_RESPONSE_TOO_LARGE" };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "rejected", code: "GITHUB_RESPONSE_INVALID" };
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
      occupants.get(replacement.roleSlotId) !== replacement.predecessorAgentId
    ) {
      throw new TypeError("Replacement is outside the bound Pact");
    }
    occupants.set(replacement.roleSlotId, replacement.replacementAgentId);
  }
  return occupants;
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const item = key(value);
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
