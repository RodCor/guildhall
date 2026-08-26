import { normalizeBaseUrl, writeNodeConfig } from "./config.js";
import { createGuildNodeIdentity, randomToken, signMessage } from "./crypto.js";

export interface PairGuildNodeInput {
  readonly baseUrl: string;
  readonly code: string;
  readonly challenge: string;
  readonly configPath: string;
  readonly fetch?: typeof globalThis.fetch;
}

export async function pairGuildNode(input: PairGuildNodeInput): Promise<{
  readonly paired: true;
  readonly agentId: string;
  readonly keyId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
}> {
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(input.code)) {
    throw new TypeError("Pairing code is malformed");
  }
  const challengeMatch =
    /^GUILDHALL-PAIRING-V1\n([0-9a-f-]{36})\n[A-Za-z0-9_-]{43}$/iu.exec(
      input.challenge,
    );
  if (challengeMatch === null)
    throw new TypeError("Pairing challenge is malformed");
  const agentId = challengeMatch[1]!;
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const identity = await createGuildNodeIdentity();
  const credential = randomToken();
  const response = await (input.fetch ?? globalThis.fetch)(
    `${baseUrl}/api/pairings/complete`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        credential,
        signature: await signMessage(identity.privateJwk, input.challenge),
        key: {
          keyId: identity.keyId,
          publicJwk: identity.publicJwk,
          source: "guild-node",
        },
      }),
    },
  );
  const result = await readJson(response);
  if (
    !response.ok ||
    !isPairingResponse(result) ||
    result.agentId !== agentId
  ) {
    throw new Error(`Guild Node pairing failed (${String(response.status)})`);
  }
  const pairedAt = new Date().toISOString();
  await writeNodeConfig(
    {
      version: 1,
      baseUrl,
      agentId: result.agentId,
      keyId: identity.keyId,
      credential,
      credentialId: result.credentialId,
      scopes: result.scopes,
      publicJwk: identity.publicJwk,
      privateJwk: identity.privateJwk,
      inboxCursor: null,
      pairedAt,
    },
    input.configPath,
  );
  return {
    paired: true,
    agentId: result.agentId,
    keyId: identity.keyId,
    credentialId: result.credentialId,
    scopes: result.scopes,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1_048_576) throw new Error("Guild response is too large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Guild returned a non-JSON pairing response");
  }
}

function isPairingResponse(value: unknown): value is {
  readonly paired: true;
  readonly agentId: string;
  readonly keyId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
} {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).paired === true &&
    typeof (value as Record<string, unknown>).agentId === "string" &&
    typeof (value as Record<string, unknown>).keyId === "string" &&
    typeof (value as Record<string, unknown>).credentialId === "string" &&
    Array.isArray((value as Record<string, unknown>).scopes)
  );
}
