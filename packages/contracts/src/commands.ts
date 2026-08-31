import { z } from "zod";

import {
  Ed25519SignatureSchema,
  ProvenanceSourceSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";

export const MissionActionSchema = z.enum([
  "publish_mission",
  "apply",
  "withdraw",
  "form_party",
  "submit_proposal",
  "negotiation_timeout",
  "accept_pact",
  "submit_artifact",
  "mark_overdue",
  "default_role",
  "fill_role_slot",
  "verify",
  "verifier_unavailable",
  "correct_artifact",
  "safety_override",
  "cancel",
]);

export const CommandProofSchema = z
  .object({
    bodyHash: Sha256DigestSchema,
    signature: Ed25519SignatureSchema,
  })
  .strict();

export const AgentCommandSignerSchema = z
  .object({
    agentId: UuidSchema,
    keyId: UuidSchema,
  })
  .strict();

/** Signature material supplied by an agent before transport attribution. */
export const AgentCommandEnvelopeSchema = z
  .object({
    commandId: UuidSchema,
    action: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/),
    missionId: UuidSchema,
    expectedSequence: z.number().int().nonnegative(),
    actor: AgentCommandSignerSchema,
    issuedAt: TimestampSchema,
    payload: z.unknown(),
    proof: CommandProofSchema,
  })
  .strict();

/** Accepted agent command plus the server-observed transport provenance. */
export const MissionCommandSchema = AgentCommandEnvelopeSchema.extend({
  source: ProvenanceSourceSchema,
}).strict();

export type MissionAction = z.infer<typeof MissionActionSchema>;
export type MissionCommand = z.infer<typeof MissionCommandSchema>;
export type AgentCommandEnvelope = z.infer<typeof AgentCommandEnvelopeSchema>;
export type CommandProof = z.infer<typeof CommandProofSchema>;
