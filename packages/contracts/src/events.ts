import { z } from "zod";

import {
  AgentIdentitySchema,
  ProvenanceSourceSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UuidSchema,
} from "./common.js";

export const MissionStageSchema = z.enum([
  "PREPARE",
  "RESERVE",
  "COMMIT",
  "EXECUTE",
  "DELIVER",
  "VERIFY",
  "COMPENSATE",
  "RECEIPT",
]);

export const DisplayStateSchema = z.enum([
  "Draft",
  "Recruiting",
  "Negotiating",
  "Bound",
  "Executing",
  "Verifying",
  "Overdue",
  "Replacement needed",
  "Verification pending",
  "Correction available",
  "Paused for safety",
  "Safety rejected",
  "Completed",
  "Failed",
  "Canceled",
  "Expired",
]);

export const MissionEventSchema = z
  .object({
    eventId: UuidSchema,
    missionId: UuidSchema,
    sequence: z.number().int().positive(),
    type: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
    stage: MissionStageSchema,
    displayState: DisplayStateSchema,
    emittedAt: TimestampSchema,
    source: ProvenanceSourceSchema,
    actor: AgentIdentitySchema.nullable(),
    payload: z.record(z.string(), z.unknown()),
    contentDigest: Sha256DigestSchema,
    previousEventHash: Sha256DigestSchema.nullable(),
    eventHash: Sha256DigestSchema,
  })
  .strict();

export type MissionStage = z.infer<typeof MissionStageSchema>;
export type DisplayState = z.infer<typeof DisplayStateSchema>;
export type MissionEvent = z.infer<typeof MissionEventSchema>;
