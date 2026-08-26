import { z } from "zod";

export const ProtocolVersionSchema = z.literal("commitment/v1");
export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ precision: 3 });
export const Sha256DigestSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{43}$/,
    "Expected an unpadded SHA-256 base64url digest",
  );
export const Ed25519SignatureSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{86}$/,
    "Expected an unpadded Ed25519 base64url signature",
  );

export const OwnerIdSchema = z.string().regex(/^github:[1-9][0-9]*$/);

export const AgentIdentitySchema = z
  .object({
    ownerId: OwnerIdSchema,
    agentId: UuidSchema,
    keyId: UuidSchema,
  })
  .strict();

export const ProvenanceSourceSchema = z.enum([
  "webmcp",
  "mcp",
  "a2a",
  "http",
  "system",
]);

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
