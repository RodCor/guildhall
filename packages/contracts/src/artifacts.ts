import { z } from "zod";

import {
  Ed25519SignatureSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";
import {
  GitHubRepositorySchema,
  GitRefSchema,
  MissionOutputTypeSchema,
} from "./mission.js";

export const GitHubCheckEvidenceSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: z.literal("completed"),
    conclusion: z.enum(["success", "neutral", "skipped"]),
    detailsUrl: z.url({ protocol: /^https$/ }).optional(),
  })
  .strict();

export const GitHubPullRequestEvidenceSchema = z
  .object({
    kind: z.literal("github-pull-request"),
    repository: GitHubRepositorySchema,
    pullRequestUrl: z.url({ protocol: /^https$/ }),
    baseRef: GitRefSchema,
    headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    checks: z.array(GitHubCheckEvidenceSchema).max(64),
  })
  .strict()
  .superRefine((evidence, context) => {
    let url: URL;
    try {
      url = new URL(evidence.pullRequestUrl);
    } catch {
      return;
    }
    const [owner, repository] = evidence.repository.split("/");
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      segments.length !== 4 ||
      segments[0]?.toLowerCase() !== owner?.toLowerCase() ||
      segments[1]?.toLowerCase() !== repository?.toLowerCase() ||
      segments[2] !== "pull" ||
      !/^[1-9][0-9]*$/u.test(segments[3] ?? "")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "pullRequestUrl must be the declared repository's canonical GitHub PR URL",
        path: ["pullRequestUrl"],
      });
    }
    const checkNames = evidence.checks.map((check) => check.name);
    if (new Set(checkNames).size !== checkNames.length) {
      context.addIssue({
        code: "custom",
        message: "GitHub check names must be unique",
        path: ["checks"],
      });
    }
  });

export const ArtifactMetadataSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("artifact-metadata"),
    artifactId: UuidSchema,
    missionId: UuidSchema,
    pactDigest: Sha256DigestSchema,
    roleSlotId: UuidSchema,
    producingAgentId: UuidSchema,
    keyId: UuidSchema,
    attempt: z.number().int().min(1).max(2),
    artifactType: MissionOutputTypeSchema,
    mediaType: z.literal("application/json"),
    publicLocation: z.url({ protocol: /^https$/ }),
    deliveryEvidence: GitHubPullRequestEvidenceSchema.optional(),
    contentDigest: Sha256DigestSchema,
    signature: Ed25519SignatureSchema,
    safetyStatus: z.literal("approved"),
    completedAt: TimestampSchema,
  })
  .strict();

/** Complete public artifact accepted by the authoritative mission coordinator. */
export const ArtifactSubmissionSchema = z
  .object({
    outputId: UuidSchema,
    metadata: ArtifactMetadataSchema,
    content: z.record(z.string(), z.unknown()),
    dependencyArtifactIds: z.array(UuidSchema).max(8),
  })
  .strict()
  .superRefine((submission, context) => {
    if (
      new Set(submission.dependencyArtifactIds).size !==
      submission.dependencyArtifactIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Artifact dependency identifiers must be unique",
        path: ["dependencyArtifactIds"],
      });
    }
  });

export const VerificationCriterionResultSchema = z
  .object({
    criterionId: UuidSchema,
    status: z.enum(["passed", "failed"]),
    artifactIds: z.array(UuidSchema).min(1).max(8),
    evidence: z.string().min(1).max(2_000),
  })
  .strict();

export const VerificationResultSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("verification"),
    verificationRunId: UuidSchema,
    missionId: UuidSchema,
    pactDigest: Sha256DigestSchema,
    attempt: z.number().int().min(1).max(2),
    status: z.enum([
      "passed",
      "failed",
      "infrastructure-pending",
      "safety-rejected",
    ]),
    verifier: z
      .object({
        verifierId: z.enum([
          "accessibility-dungeon-v1",
          "github-pull-request-v1",
        ]),
        version: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
      })
      .strict(),
    infrastructureStatus: z.enum(["available", "unavailable"]),
    criteria: z.array(VerificationCriterionResultSchema).min(1).max(16),
    correctionConsumed: z.boolean(),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const allPassed = result.criteria.every(
      (criterion) => criterion.status === "passed",
    );
    if ((result.status === "passed") !== allPassed) {
      context.addIssue({
        code: "custom",
        message: "passed status must match all criterion results",
        path: ["status"],
      });
    }
    if (
      result.status === "infrastructure-pending" &&
      result.infrastructureStatus !== "unavailable"
    ) {
      context.addIssue({
        code: "custom",
        message: "infrastructure-pending requires an unavailable verifier",
        path: ["infrastructureStatus"],
      });
    }
  });

export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export type ArtifactSubmission = z.infer<typeof ArtifactSubmissionSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
