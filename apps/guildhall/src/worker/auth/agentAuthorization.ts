import {
  authenticateScopedCredential,
  consumeAgentRequestNonce,
  listAgentKeys,
  readOwnedAgent,
  type CredentialPrincipal,
} from "../repositories/index.js";
import type { GuildhallEnv } from "../types.js";
import { createAgentRequestSignatureMessage } from "@guildhall/trust-engine";
import {
  hashOpaqueCredential,
  sha256Base64Url,
  verifyEd25519Challenge,
} from "./crypto.js";
import { noStoreJson } from "./httpSecurity.js";
import { authorizeOwnerMutation, type OwnerAuthorization } from "./session.js";

export type AgentAuthorization =
  | {
      readonly ok: true;
      readonly kind: "owner";
      readonly owner: Extract<OwnerAuthorization, { ok: true }>;
      readonly agentId: string;
      readonly keyId: string;
    }
  | {
      readonly ok: true;
      readonly kind: "guild-node";
      readonly credential: CredentialPrincipal;
      readonly agentId: string;
      readonly keyId: string;
    }
  | { readonly ok: false; readonly response: Response };

export async function authorizeAgentAction(
  request: Request,
  env: GuildhallEnv,
  input: {
    readonly agentId: string;
    readonly bodyText: string;
    readonly requiredScope: string;
  },
): Promise<AgentAuthorization> {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("GuildNode ") === true) {
    return authorizeGuildNode(request, env, input, authorization.slice(10));
  }

  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner;
  const ownedAgent = await readOwnedAgent(
    env.GUILD_DB,
    owner.principal.ownerId,
    input.agentId,
  );
  if (ownedAgent === null) return denied();
  const browserKey = (await listAgentKeys(env.GUILD_DB, input.agentId)).find(
    (candidate) =>
      candidate.source === "browser" && candidate.status === "active",
  );
  return browserKey === undefined
    ? denied()
    : {
        ok: true,
        kind: "owner",
        owner,
        agentId: ownedAgent.agentId,
        keyId: browserKey.keyId,
      };
}

async function authorizeGuildNode(
  request: Request,
  env: GuildhallEnv,
  input: {
    readonly agentId: string;
    readonly bodyText: string;
    readonly requiredScope: string;
  },
  credentialToken: string,
): Promise<AgentAuthorization> {
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(credentialToken)) return denied();
  const credential = await authenticateScopedCredential(
    env.GUILD_DB,
    await hashOpaqueCredential(credentialToken),
    new Date().toISOString(),
  );
  if (
    credential === null ||
    credential.agentId !== input.agentId ||
    !credential.scopes.includes(input.requiredScope)
  ) {
    return denied();
  }

  const keyId = request.headers.get("X-Guild-Key-Id");
  const signature = request.headers.get("X-Guild-Signature");
  const issuedAt = request.headers.get("X-Guild-Issued-At");
  const nonce = request.headers.get("X-Guild-Nonce");
  if (
    keyId === null ||
    signature === null ||
    issuedAt === null ||
    nonce === null ||
    keyId !== credential.keyId
  ) {
    return denied();
  }
  const issuedAtMs = Date.parse(issuedAt);
  if (
    !Number.isFinite(issuedAtMs) ||
    Math.abs(Date.now() - issuedAtMs) > 5 * 60 * 1_000 ||
    !/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)
  ) {
    return denied();
  }
  const key = (await listAgentKeys(env.GUILD_DB, input.agentId)).find(
    (candidate) => candidate.keyId === keyId && candidate.status === "active",
  );
  if (
    key === undefined ||
    !(await verifyEd25519Challenge(
      key.publicJwk,
      createAgentRequestSignatureMessage({
        method: request.method,
        requestTarget: `${new URL(request.url).pathname}${new URL(request.url).search}`,
        bodyText: input.bodyText,
        issuedAt,
        nonce,
      }),
      signature,
    ))
  ) {
    return denied();
  }
  if (
    !(await consumeAgentRequestNonce(env.GUILD_DB, {
      credentialId: credential.credentialId,
      nonceHash: await sha256Base64Url(nonce),
      issuedAt,
      consumedAt: new Date().toISOString(),
    }))
  ) {
    return denied();
  }

  return {
    ok: true,
    kind: "guild-node",
    credential,
    agentId: credential.agentId,
    keyId,
  };
}

function denied(): AgentAuthorization {
  return {
    ok: false,
    response: noStoreJson(
      { error: "AGENT_NOT_AUTHORIZED", message: "Agent authorization failed" },
      { status: 403 },
    ),
  };
}
