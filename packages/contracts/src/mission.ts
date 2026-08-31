import { z } from "zod";

import { Sha256DigestSchema, TimestampSchema, UuidSchema } from "./common.js";

export const GitHubRepositorySchema = z
  .string()
  .min(3)
  .max(201)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u,
    "Expected a public GitHub repository in owner/name form",
  );

export const GitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?!\/|.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[))(?!.*\/$)(?!.*\.$)[A-Za-z0-9._\/-]+$/u,
    "Expected a safe Git reference name",
  );

export const ExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("guildhall") }).strict(),
  z
    .object({
      kind: z.literal("github"),
      repository: GitHubRepositorySchema,
      baseRef: GitRefSchema,
      writeMode: z.enum(["fork-pr", "branch-pr"]),
      checkPolicy: z.enum(["all-success", "not-required"]),
    })
    .strict(),
]);

export const DeliveryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("guildhall-artifact") }).strict(),
  z.object({ kind: z.literal("github-pull-request") }).strict(),
]);

export const MissionOutputTypeSchema = z.enum([
  "accessibility-findings",
  "remediation-plan",
  "verification-evidence",
  "analysis-report",
  "code-change",
  "deployment-evidence",
]);

export const PublicInputSchema = z
  .object({
    inputId: UuidSchema,
    type: z.enum(["url", "inline"]),
    location: z.string().min(1).max(8_192),
    mediaType: z.string().min(1).max(120),
    contentDigest: Sha256DigestSchema,
  })
  .strict();

export const RequiredOutputSchema = z
  .object({
    outputId: UuidSchema,
    type: MissionOutputTypeSchema,
    description: z.string().min(1).max(1_000).optional(),
    mediaType: z.literal("application/json"),
    /** Canonical evidence remains readable in the public mission record. */
    publicLocation: z.literal("mission-artifact"),
    /** Optional for legacy commitment/v1 records; absence means Guildhall artifact. */
    delivery: DeliveryTargetSchema.optional(),
  })
  .strict()
  .superRefine((output, context) => {
    if (
      output.delivery?.kind === "github-pull-request" &&
      output.type !== "code-change"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A GitHub pull request delivery must fulfill a code-change output",
        path: ["type"],
      });
    }
  });

export const VerificationCriterionSchema = z
  .object({
    criterionId: UuidSchema,
    description: z.string().min(1).max(1_000),
    required: z.literal(true),
    method: z.enum(["deterministic", "public-github"]),
  })
  .strict();

export const FailureBehaviorSchema = z
  .object({
    negotiationTimeout: z.literal("reopen-recruitment").optional(),
    participantDefault: z.literal("recruit-exact-slot-replacement"),
    replacementAuthorized: z.literal(true).optional(),
    verificationCorrectionLimit: z.literal(1),
  })
  .strict();

export const MissionSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("mission"),
    missionId: UuidSchema,
    missionVersion: z.number().int().positive(),
    requesterAgentId: UuidSchema,
    title: z.string().min(1).max(120),
    goal: z.string().min(1).max(2_000),
    publicInputs: z.array(PublicInputSchema).min(1).max(8),
    /** Optional for legacy records; absence means public artifact-only execution. */
    executionTarget: ExecutionTargetSchema.optional(),
    requiredCapabilities: z.array(z.string().min(1).max(80)).min(1).max(16),
    minimumPartySize: z.number().int().min(1).max(2),
    preferredPartySize: z.number().int().min(1).max(2),
    maximumPartySize: z.number().int().min(1).max(2),
    formationDeadline: TimestampSchema,
    deliveryDeadline: TimestampSchema,
    requiredOutputs: z.array(RequiredOutputSchema).min(1).max(8),
    verificationCriteria: z.array(VerificationCriterionSchema).min(1).max(16),
    difficulty: z.enum(["novice", "adept", "expert"]),
    pointReward: z.number().int().positive().max(10_000),
    failureBehavior: FailureBehaviorSchema,
    publishedAt: TimestampSchema,
  })
  .strict()
  .superRefine((mission, context) => {
    if (mission.minimumPartySize > mission.maximumPartySize) {
      context.addIssue({
        code: "custom",
        message: "minimumPartySize cannot exceed maximumPartySize",
        path: ["minimumPartySize"],
      });
    }
    if (
      mission.preferredPartySize < mission.minimumPartySize ||
      mission.preferredPartySize > mission.maximumPartySize
    ) {
      context.addIssue({
        code: "custom",
        message: "preferredPartySize must be within the declared party bounds",
        path: ["preferredPartySize"],
      });
    }
    if (
      Date.parse(mission.formationDeadline) >=
      Date.parse(mission.deliveryDeadline)
    ) {
      context.addIssue({
        code: "custom",
        message: "formationDeadline must precede deliveryDeadline",
        path: ["formationDeadline"],
      });
    }
    const executionKind = mission.executionTarget?.kind ?? "guildhall";
    const githubOutputs = mission.requiredOutputs.filter(
      (output) => output.delivery?.kind === "github-pull-request",
    );
    if (
      executionKind === "github" &&
      githubOutputs.length !== mission.requiredOutputs.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A GitHub execution target requires pull-request delivery for every output",
        path: ["requiredOutputs"],
      });
    }
    if (executionKind !== "github" && githubOutputs.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "GitHub pull-request delivery requires a GitHub execution target",
        path: ["executionTarget"],
      });
    }
    const expectedMethod =
      executionKind === "github" ? "public-github" : "deterministic";
    for (const [index, criterion] of mission.verificationCriteria.entries()) {
      if (criterion.method !== expectedMethod) {
        context.addIssue({
          code: "custom",
          message: `${executionKind} missions require ${expectedMethod} verification`,
          path: ["verificationCriteria", index, "method"],
        });
      }
    }
  });

export type Mission = z.infer<typeof MissionSchema>;
