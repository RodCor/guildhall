import { z } from "zod";

import {
  Ed25519SignatureSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";

export const ReceiptArtifactSchema = z
  .object({
    artifactId: UuidSchema,
    roleSlotId: UuidSchema,
    producingAgentId: UuidSchema,
    contentDigest: Sha256DigestSchema,
  })
  .strict();

export const ReputationDeltaSchema = z
  .object({
    agentId: UuidSchema,
    capability: z.string().min(1).max(80),
    pointsDelta: z.number().int().min(-10_000).max(10_000),
    reliabilityDelta: z.number().min(-1).max(1),
    timelinessDelta: z.number().min(-1).max(1),
    recoveryBonus: z.number().int().nonnegative().max(1_000),
    reason: z.enum([
      "verified-role-output",
      "verified-replacement-output",
      "post-bind-default",
    ]),
  })
  .strict();

export const ReceiptSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("receipt"),
    receiptId: UuidSchema,
    missionId: UuidSchema,
    outcome: z.enum(["completed", "failed", "canceled", "expired"]),
    pactDigest: Sha256DigestSchema.nullable(),
    eventChainHead: Sha256DigestSchema,
    artifacts: z.array(ReceiptArtifactSchema).max(8),
    verification: z
      .object({
        verificationRunId: UuidSchema,
        status: z.enum(["passed", "failed"]),
        criterionResults: z
          .array(
            z
              .object({
                criterionId: UuidSchema,
                status: z.enum(["passed", "failed"]),
              })
              .strict(),
          )
          .min(1)
          .max(16),
      })
      .strict()
      .nullable(),
    timeliness: z
      .object({
        overdue: z.boolean(),
        deliveryDeadline: TimestampSchema,
        completedAt: TimestampSchema,
      })
      .strict(),
    defaults: z
      .array(
        z
          .object({
            agentId: UuidSchema,
            roleSlotId: UuidSchema,
            reason: z.enum(["participant-defaulted", "participant-released"]),
          })
          .strict(),
      )
      .max(2),
    replacements: z
      .array(
        z
          .object({
            replacementId: UuidSchema,
            roleSlotId: UuidSchema,
            predecessorAgentId: UuidSchema,
            replacementAgentId: UuidSchema,
          })
          .strict(),
      )
      .max(2),
    reward: z
      .object({
        basePointsAwarded: z.number().int().nonnegative().max(10_000),
        recoveryBonusAwarded: z.number().int().nonnegative().max(1_000),
        totalPointsAwarded: z.number().int().nonnegative().max(11_000),
        transferable: z.literal(false),
        redeemable: z.literal(false),
        monetaryValue: z.literal(false),
      })
      .strict(),
    reputationDeltas: z.array(ReputationDeltaSchema).max(8),
    issuerKeyId: UuidSchema,
    issuerSignature: Ed25519SignatureSchema,
    issuedAt: TimestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.outcome === "completed") {
      if (receipt.pactDigest === null) {
        context.addIssue({
          code: "custom",
          message: "A completed receipt requires a bound pact digest",
          path: ["pactDigest"],
        });
      }
      if (receipt.verification?.status !== "passed") {
        context.addIssue({
          code: "custom",
          message: "A completed receipt requires passed verification",
          path: ["verification"],
        });
      }
    } else if (receipt.reward.totalPointsAwarded > 0) {
      context.addIssue({
        code: "custom",
        message: "A non-completed receipt cannot award success points",
        path: ["reward", "totalPointsAwarded"],
      });
    }

    if (
      receipt.reward.totalPointsAwarded !==
      receipt.reward.basePointsAwarded + receipt.reward.recoveryBonusAwarded
    ) {
      context.addIssue({
        code: "custom",
        message: "Total points must equal base plus recovery bonus",
        path: ["reward", "totalPointsAwarded"],
      });
    }

    const deltaKeys = receipt.reputationDeltas.map(
      (delta) => `${delta.agentId}\u0000${delta.capability}`,
    );
    if (new Set(deltaKeys).size !== deltaKeys.length) {
      context.addIssue({
        code: "custom",
        message: "A receipt may apply one delta per agent and capability",
        path: ["reputationDeltas"],
      });
    }
  });

export type Receipt = z.infer<typeof ReceiptSchema>;
