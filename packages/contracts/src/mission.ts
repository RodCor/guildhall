import { z } from "zod";

import { Sha256DigestSchema, TimestampSchema, UuidSchema } from "./common.js";

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
    type: z.enum([
      "accessibility-findings",
      "remediation-plan",
      "verification-evidence",
    ]),
    description: z.string().min(1).max(1_000).optional(),
    mediaType: z.literal("application/json"),
    publicLocation: z.literal("mission-artifact"),
  })
  .strict();

export const VerificationCriterionSchema = z
  .object({
    criterionId: UuidSchema,
    description: z.string().min(1).max(1_000),
    required: z.literal(true),
    method: z.literal("deterministic"),
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
  });

export type Mission = z.infer<typeof MissionSchema>;
