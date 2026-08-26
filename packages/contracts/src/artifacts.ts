import { z } from "zod";

import {
  Ed25519SignatureSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";

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
    artifactType: z.enum([
      "accessibility-findings",
      "remediation-plan",
      "verification-evidence",
    ]),
    mediaType: z.literal("application/json"),
    publicLocation: z.url({ protocol: /^https$/ }),
    contentDigest: Sha256DigestSchema,
    signature: Ed25519SignatureSchema,
    safetyStatus: z.literal("approved"),
    completedAt: TimestampSchema,
  })
  .strict();

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
        verifierId: z.literal("accessibility-dungeon-v1"),
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
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
