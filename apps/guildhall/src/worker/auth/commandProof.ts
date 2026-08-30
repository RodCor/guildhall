import {
  AgentCommandEnvelopeSchema,
  commandBodyHash,
  commandSigningBytes,
  verifyRegisteredEd25519Proof,
  type CommandProof,
} from "@guildhall/contracts";

import type { AgentAuthorization } from "./agentAuthorization.js";

const MAX_COMMAND_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type VerifiedCommandProof = Readonly<{
  bodyHash: string;
  signature: string;
  verifiedAt: string;
  keyStatusCheckedAt: string;
}>;

/** Verify an agent's command independently from its HTTP/A2A authentication. */
export async function verifyAuthenticatedCommandProof(input: {
  readonly authorization: Extract<AgentAuthorization, { ok: true }>;
  readonly commandId: string;
  readonly action: string;
  readonly missionId: string;
  readonly expectedSequence: number;
  readonly issuedAt: string;
  readonly payload: unknown;
  readonly proof: CommandProof;
  readonly now?: Date;
}): Promise<VerifiedCommandProof | null> {
  const now = input.now ?? new Date();
  const material = {
    commandId: input.commandId,
    action: input.action,
    missionId: input.missionId,
    expectedSequence: input.expectedSequence,
    actor: {
      agentId: input.authorization.agentId,
      keyId: input.authorization.keyId,
    },
    issuedAt: input.issuedAt,
    payload: input.payload,
    proof: input.proof,
  };
  const parsed = AgentCommandEnvelopeSchema.safeParse(material);
  if (!parsed.success) return null;
  const issuedAt = Date.parse(parsed.data.issuedAt);
  if (Math.abs(now.getTime() - issuedAt) > MAX_COMMAND_CLOCK_SKEW_MS) {
    return null;
  }
  const bodyHash = await commandBodyHash(parsed.data);
  if (bodyHash !== parsed.data.proof.bodyHash) return null;
  const result = await verifyRegisteredEd25519Proof({
    key: {
      keyId: input.authorization.signingKey.keyId,
      publicJwk: input.authorization.signingKey.publicJwk,
      status: "active",
    },
    proof: {
      keyId: input.authorization.keyId,
      signature: parsed.data.proof.signature,
    },
    message: commandSigningBytes(bodyHash),
    policy: { kind: "new-proof" },
  });
  return result.valid
    ? {
        bodyHash,
        signature: parsed.data.proof.signature,
        verifiedAt: (input.now ?? new Date()).toISOString(),
        keyStatusCheckedAt: input.authorization.keyStatusCheckedAt,
      }
    : null;
}
