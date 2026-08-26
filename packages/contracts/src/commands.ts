import { z } from "zod";

import {
  AgentIdentitySchema,
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

export const MissionCommandSchema = z
  .object({
    commandId: UuidSchema,
    action: MissionActionSchema,
    missionId: UuidSchema,
    expectedSequence: z.number().int().nonnegative(),
    actor: AgentIdentitySchema,
    source: ProvenanceSourceSchema,
    issuedAt: TimestampSchema,
    payload: z.record(z.string(), z.unknown()),
    proof: CommandProofSchema,
  })
  .strict();

export type MissionAction = z.infer<typeof MissionActionSchema>;
export type MissionCommand = z.infer<typeof MissionCommandSchema>;
