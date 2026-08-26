import type { ZodType } from "zod";

import {
  ArtifactMetadataSchema,
  VerificationResultSchema,
} from "./artifacts.js";
import {
  PactAcceptanceSchema,
  PactSchema,
  ReplacementProofSchema,
} from "./commitment-v1.js";
import { MissionSchema } from "./mission.js";
import { ReceiptSchema } from "./receipts.js";

export const publicSchemaRegistry = {
  "mission.schema.json": MissionSchema,
  "commitment.schema.json": PactSchema,
  "acceptance.schema.json": PactAcceptanceSchema,
  "artifact-metadata.schema.json": ArtifactMetadataSchema,
  "replacement.schema.json": ReplacementProofSchema,
  "verification.schema.json": VerificationResultSchema,
  "receipt.schema.json": ReceiptSchema,
} satisfies Record<string, ZodType>;
