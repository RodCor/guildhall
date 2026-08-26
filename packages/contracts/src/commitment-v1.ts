import { z } from "zod";

import {
  Ed25519SignatureSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";
import {
  FailureBehaviorSchema,
  PublicInputSchema,
  RequiredOutputSchema,
  VerificationCriterionSchema,
} from "./mission.js";

export const PactParticipantSchema = z
  .object({
    agentId: UuidSchema,
    role: z.enum(["requester", "helper"]),
  })
  .strict();

export const RoleSlotSchema = z
  .object({
    roleSlotId: UuidSchema,
    originalAgentId: UuidSchema,
    assignment: z.string().min(1).max(1_000),
    requiredCapabilities: z.array(z.string().min(1).max(80)).min(1).max(16),
    dependencyRoleSlotIds: z.array(UuidSchema).max(2),
    requiredOutputIds: z.array(UuidSchema).min(1).max(8),
    verificationCriterionIds: z.array(UuidSchema).min(1).max(16),
    pointAllocation: z.number().int().positive().max(10_000),
  })
  .strict();

export const PactSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("pact"),
    pactId: UuidSchema,
    missionId: UuidSchema,
    missionVersion: z.number().int().positive(),
    pactVersion: z.number().int().positive(),
    goal: z.string().min(1).max(2_000),
    publicInputs: z.array(PublicInputSchema).min(1).max(8),
    minimumPartySize: z.number().int().min(1).max(2),
    maximumPartySize: z.number().int().min(1).max(2),
    participants: z.array(PactParticipantSchema).min(2).max(3),
    roleSlots: z.array(RoleSlotSchema).min(1).max(2),
    requiredOutputs: z.array(RequiredOutputSchema).min(1).max(8),
    formationDeadline: TimestampSchema,
    deliveryDeadline: TimestampSchema,
    verificationCriteria: z.array(VerificationCriterionSchema).min(1).max(16),
    reward: z
      .object({
        totalPoints: z.number().int().positive().max(10_000),
        replacementRecoveryBonus: z.number().int().nonnegative().max(1_000),
        transferable: z.literal(false),
        redeemable: z.literal(false),
      })
      .strict(),
    failureBehavior: FailureBehaviorSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((pact, context) => {
    const requesters = pact.participants.filter(
      (participant) => participant.role === "requester",
    );
    const helpers = pact.participants.filter(
      (participant) => participant.role === "helper",
    );
    const participantIds = pact.participants.map(
      (participant) => participant.agentId,
    );
    const slotIds = pact.roleSlots.map((slot) => slot.roleSlotId);
    const helperIds = new Set(helpers.map((helper) => helper.agentId));

    if (requesters.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A pact requires exactly one requester",
        path: ["participants"],
      });
    }
    if (helpers.length < 1 || helpers.length > pact.maximumPartySize) {
      context.addIssue({
        code: "custom",
        message: "The helper party must stay within the declared maximum",
        path: ["participants"],
      });
    }
    if (new Set(participantIds).size !== participantIds.length) {
      context.addIssue({
        code: "custom",
        message: "Pact participants must be unique",
        path: ["participants"],
      });
    }
    if (new Set(slotIds).size !== slotIds.length) {
      context.addIssue({
        code: "custom",
        message: "Role slots must be unique",
        path: ["roleSlots"],
      });
    }
    for (const [index, slot] of pact.roleSlots.entries()) {
      if (!helperIds.has(slot.originalAgentId)) {
        context.addIssue({
          code: "custom",
          message: "Every role slot must belong to a selected helper",
          path: ["roleSlots", index, "originalAgentId"],
        });
      }
      if (slot.dependencyRoleSlotIds.includes(slot.roleSlotId)) {
        context.addIssue({
          code: "custom",
          message: "A role slot cannot depend on itself",
          path: ["roleSlots", index, "dependencyRoleSlotIds"],
        });
      }
    }
  });

export const PactAcceptanceSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("acceptance"),
    acceptanceId: UuidSchema,
    missionId: UuidSchema,
    pactVersion: z.number().int().positive(),
    agentId: UuidSchema,
    keyId: UuidSchema,
    pactDigest: Sha256DigestSchema,
    signature: Ed25519SignatureSchema,
    acceptedAt: TimestampSchema,
  })
  .strict();

export const ReplacementProofSchema = z
  .object({
    protocol: z.literal("commitment/v1"),
    kind: z.literal("replacement"),
    replacementId: UuidSchema,
    missionId: UuidSchema,
    pactDigest: Sha256DigestSchema,
    roleSlotId: UuidSchema,
    predecessorAgentId: UuidSchema,
    replacementAgentId: UuidSchema,
    keyId: UuidSchema,
    reason: z.enum(["participant-defaulted", "participant-released"]),
    preservesPactDigest: z.literal(true),
    signature: Ed25519SignatureSchema,
    acceptedAt: TimestampSchema,
  })
  .strict()
  .refine((proof) => proof.predecessorAgentId !== proof.replacementAgentId, {
    message: "A replacement must change the role-slot occupant",
    path: ["replacementAgentId"],
  });

export type Pact = z.infer<typeof PactSchema>;
export type PactAcceptance = z.infer<typeof PactAcceptanceSchema>;
export type ReplacementProof = z.infer<typeof ReplacementProofSchema>;
