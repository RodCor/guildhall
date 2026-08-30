import {
  CommandProofSchema,
  MissionSchema,
  type CommandProof,
  type Mission,
} from "@guildhall/contracts";
import {
  PUBLIC_SAFETY_RULESET_VERSION,
  createRedactedPublicPayload,
  scanPublicPayload,
} from "@guildhall/trust-engine";

import { readMissionCatalogRow } from "../repositories/missionCatalog.js";
import {
  consumePairingChallenge,
  createAgent,
  createPairingChallenge,
  createPrivateDraft,
  getAutonomyPolicy,
  getPendingPairingChallenge,
  listAgentKeys,
  readOwnedAgent,
  readPrivateDraft,
  recordDraftSafetyResult,
  recordEmergencyPublicRedaction,
  registerAgentKey,
  revokeAgentKey,
  revokeScopedCredential,
  setAutonomyPolicy,
  updateOwnedAgent,
  type AgentProfile,
  type PublicRedactionCategory,
} from "../repositories/index.js";
import type { GuildhallEnv } from "../types.js";
import {
  authorizeAgentAction,
  type AgentAuthorization,
} from "./agentAuthorization.js";
import { verifyAuthenticatedCommandProof } from "./commandProof.js";
import {
  canonicalizeEd25519PublicJwk,
  deriveEd25519KeyId,
  hashOpaqueCredential,
  importEd25519VerificationKey,
  randomBase64UrlToken,
  sha256Base64Url,
  verifyEd25519Challenge,
} from "./crypto.js";
import { noStoreJson } from "./httpSecurity.js";
import { sealPrivateDraft, unsealPrivateDraft } from "./privateDraftCipher.js";
import { authenticateOwner, authorizeOwnerMutation } from "./session.js";

const AGENT_ROUTE = /^\/api\/agents\/([^/]+)$/u;
const PAIRING_START_ROUTE = /^\/api\/agents\/([^/]+)\/pairing$/u;
const KEY_REVOKE_ROUTE = /^\/api\/agents\/([^/]+)\/keys\/([^/]+)\/revoke$/u;
const BROWSER_KEY_REPLACE_ROUTE =
  /^\/api\/agents\/([^/]+)\/keys\/browser\/replace$/u;
const CREDENTIAL_REVOKE_ROUTE =
  /^\/api\/agents\/([^/]+)\/credentials\/([^/]+)\/revoke$/u;
const AUTONOMY_ROUTE = /^\/api\/agents\/([^/]+)\/autonomy$/u;
const DRAFT_ROUTE = /^\/api\/drafts\/([^/]+)$/u;
const DRAFT_PUBLISH_ROUTE = /^\/api\/drafts\/([^/]+)\/publish$/u;
const WEBMCP_DRAFT_PUBLISH_ROUTE = /^\/api\/webmcp\/drafts\/([^/]+)\/publish$/u;
const REDACTION_ROUTE = /^\/api\/missions\/([^/]+)\/redactions$/u;
const PAIRING_SCOPES = [
  "missions:read",
  "missions:write",
  "artifacts:write",
] as const;

export async function handleAgentRoute(
  request: Request,
  env: GuildhallEnv,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/agents" && request.method === "POST") {
    return registerBrowserAgent(request, env);
  }
  if (url.pathname === "/api/pairings/complete" && request.method === "POST") {
    return completePairing(request, env);
  }
  if (url.pathname === "/api/drafts" && request.method === "POST") {
    return savePrivateDraft(request, env);
  }

  const pairingMatch = PAIRING_START_ROUTE.exec(url.pathname);
  if (pairingMatch !== null && request.method === "POST") {
    return startPairing(request, env, decodeURIComponent(pairingMatch[1]!));
  }
  const browserKeyReplaceMatch = BROWSER_KEY_REPLACE_ROUTE.exec(url.pathname);
  if (browserKeyReplaceMatch !== null && request.method === "POST") {
    return replaceBrowserKey(
      request,
      env,
      decodeURIComponent(browserKeyReplaceMatch[1]!),
    );
  }
  const keyMatch = KEY_REVOKE_ROUTE.exec(url.pathname);
  if (keyMatch !== null && request.method === "POST") {
    return revokeKey(
      request,
      env,
      decodeURIComponent(keyMatch[1]!),
      decodeURIComponent(keyMatch[2]!),
    );
  }
  const credentialMatch = CREDENTIAL_REVOKE_ROUTE.exec(url.pathname);
  if (credentialMatch !== null && request.method === "POST") {
    return revokeCredential(
      request,
      env,
      decodeURIComponent(credentialMatch[1]!),
      decodeURIComponent(credentialMatch[2]!),
    );
  }
  const autonomyMatch = AUTONOMY_ROUTE.exec(url.pathname);
  if (autonomyMatch !== null && request.method === "GET") {
    return readAutonomy(request, env, decodeURIComponent(autonomyMatch[1]!));
  }
  if (autonomyMatch !== null && request.method === "PUT") {
    return changeAutonomy(request, env, decodeURIComponent(autonomyMatch[1]!));
  }
  const publishMatch = DRAFT_PUBLISH_ROUTE.exec(url.pathname);
  if (publishMatch !== null && request.method === "POST") {
    return publishPrivateDraft(
      request,
      env,
      decodeURIComponent(publishMatch[1]!),
    );
  }
  const webMcpPublishMatch = WEBMCP_DRAFT_PUBLISH_ROUTE.exec(url.pathname);
  if (webMcpPublishMatch !== null && request.method === "POST") {
    return publishPrivateDraft(
      request,
      env,
      decodeURIComponent(webMcpPublishMatch[1]!),
    );
  }
  const draftMatch = DRAFT_ROUTE.exec(url.pathname);
  if (draftMatch !== null && request.method === "GET") {
    return getPrivateDraft(request, env, decodeURIComponent(draftMatch[1]!));
  }
  const redactionMatch = REDACTION_ROUTE.exec(url.pathname);
  if (redactionMatch !== null && request.method === "POST") {
    return emergencyRedaction(
      request,
      env,
      decodeURIComponent(redactionMatch[1]!),
    );
  }
  const agentMatch = AGENT_ROUTE.exec(url.pathname);
  if (agentMatch !== null && request.method === "PATCH") {
    return updateAgentProfile(request, env, decodeURIComponent(agentMatch[1]!));
  }
  if (agentMatch !== null && request.method === "GET") {
    return getOwnedAgent(request, env, decodeURIComponent(agentMatch[1]!));
  }
  return null;
}

async function registerBrowserAgent(
  request: Request,
  env: GuildhallEnv,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const body = await readJsonRecord(request);
  const profile = parseAgentProfile(body);
  const key = parsePublicKey(body?.key);
  if (profile === null || key === null || key.source !== "browser")
    return invalid("agent");
  const scan = scanPublicPayload(profile);
  if (!scan.safe) return unsafe(scan);
  const keyScan = scanPublicPayload({
    keyId: key.keyId,
    publicJwk: key.publicJwk,
  });
  if (!keyScan.safe) return unsafe(keyScan);
  let canonicalJwk: JsonWebKey;
  try {
    canonicalJwk = canonicalizeEd25519PublicJwk(key.publicJwk);
    await importEd25519VerificationKey(canonicalJwk);
    if ((await deriveEd25519KeyId("browser", canonicalJwk)) !== key.keyId) {
      return invalid("public key identifier");
    }
  } catch {
    return invalid("public key");
  }

  const now = new Date().toISOString();
  let agent: Awaited<ReturnType<typeof createAgent>>;
  try {
    agent = await createAgent(env.GUILD_DB, {
      agentId: crypto.randomUUID(),
      ownerId: owner.principal.ownerId,
      ...profile,
      createdAt: now,
    });
  } catch (error) {
    if (isUniqueConstraint(error)) return profileConflict();
    throw error;
  }

  let registeredKey: Awaited<ReturnType<typeof registerAgentKey>>;
  try {
    registeredKey = await registerAgentKey(env.GUILD_DB, {
      keyId: key.keyId,
      ownerId: owner.principal.ownerId,
      agentId: agent.agentId,
      publicJwk: canonicalJwk,
      source: "browser",
      createdAt: now,
    });
  } catch (error) {
    await discardUnconnectedAgent(
      env.GUILD_DB,
      owner.principal.ownerId,
      agent.agentId,
    );
    if (isUniqueConstraint(error)) return signerConflict();
    throw error;
  }
  if (registeredKey === null) {
    await discardUnconnectedAgent(
      env.GUILD_DB,
      owner.principal.ownerId,
      agent.agentId,
    );
    return invalid("public key");
  }
  return noStoreJson(
    {
      ...ownedAgentResponse(agent, registeredKey.keyId),
      autonomy: { enabled: false, version: 1 },
    },
    { status: 201 },
  );
}

async function getOwnedAgent(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const owner = await authenticateOwner(request, env);
  if (!owner.ok) return owner.response;
  const agent = await readOwnedAgent(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
  );
  return agent === null
    ? noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 })
    : noStoreJson({ agent });
}

async function updateAgentProfile(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const profile = parseAgentProfile(await readJsonRecord(request));
  if (profile === null) return invalid("agent profile");
  const scan = scanPublicPayload(profile);
  if (!scan.safe) return unsafe(scan);

  let agent: Awaited<ReturnType<typeof updateOwnedAgent>>;
  try {
    agent = await updateOwnedAgent(env.GUILD_DB, {
      ownerId: owner.principal.ownerId,
      agentId,
      ...profile,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (isUniqueConstraint(error)) return profileConflict();
    throw error;
  }
  if (agent === null) {
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }
  const browserKey = (await listAgentKeys(env.GUILD_DB, agentId)).find(
    (key) => key.source === "browser" && key.status === "active",
  );
  if (browserKey === undefined) {
    return noStoreJson(
      {
        error: "BROWSER_SIGNER_NOT_FOUND",
        message: "This agent has no active browser signer",
      },
      { status: 409 },
    );
  }
  return noStoreJson(ownedAgentResponse(agent, browserKey.keyId));
}

async function startPairing(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const code = randomBase64UrlToken();
  const nonce = randomBase64UrlToken();
  const challenge = `GUILDHALL-PAIRING-V1\n${agentId}\n${nonce}`;
  const now = Date.now();
  const pairing = await createPairingChallenge(env.GUILD_DB, {
    ownerId: owner.principal.ownerId,
    agentId,
    codeHash: await hashOpaqueCredential(code),
    challenge,
    expiresAt: new Date(now + 10 * 60 * 1_000).toISOString(),
    createdAt: new Date(now).toISOString(),
  });
  return pairing === null
    ? noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 })
    : noStoreJson(
        { code, challenge: pairing.challenge, expiresAt: pairing.expiresAt },
        { status: 201 },
      );
}

async function completePairing(
  request: Request,
  env: GuildhallEnv,
): Promise<Response> {
  const body = await readJsonRecord(request);
  const code = stringField(body, "code", 43, 128);
  const credential = stringField(body, "credential", 43, 128);
  const signature = stringField(body, "signature", 86, 128);
  const key = parsePublicKey(body?.key);
  if (
    code === null ||
    credential === null ||
    signature === null ||
    key === null ||
    key.source !== "guild-node"
  ) {
    return invalid("pairing proof");
  }
  const keyScan = scanPublicPayload({
    keyId: key.keyId,
    publicJwk: key.publicJwk,
  });
  if (!keyScan.safe) return unsafe(keyScan);
  let canonicalJwk: JsonWebKey;
  try {
    canonicalJwk = canonicalizeEd25519PublicJwk(key.publicJwk);
    if ((await deriveEd25519KeyId("guild-node", canonicalJwk)) !== key.keyId) {
      return invalid("public key identifier");
    }
  } catch {
    return invalid("public key");
  }
  const codeHash = await hashOpaqueCredential(code);
  const pending = await getPendingPairingChallenge(
    env.GUILD_DB,
    codeHash,
    new Date().toISOString(),
  );
  if (pending === null) return pairingFailure();
  if (
    !(await verifyEd25519Challenge(canonicalJwk, pending.challenge, signature))
  ) {
    return pairingFailure();
  }
  const credentialHash = await hashOpaqueCredential(credential);
  const proofDigest = await sha256Base64Url(
    `GUILDHALL-PAIRING-PROOF-V1\n${pending.challenge}\n${key.keyId}\n${credentialHash}`,
  );
  const result = await consumePairingChallenge(env.GUILD_DB, {
    codeHash,
    challenge: pending.challenge,
    now: new Date().toISOString(),
    consumedAt: new Date().toISOString(),
    possessionVerified: true,
    possessionProofDigest: proofDigest,
    possessionSignature: signature,
    keyId: key.keyId,
    publicJwk: canonicalJwk,
    credentialId: crypto.randomUUID(),
    credentialHash,
    scopes: PAIRING_SCOPES,
    credentialExpiresAt: null,
  });
  return result.status !== "applied"
    ? pairingFailure()
    : noStoreJson(
        {
          paired: true,
          agentId: result.agentId,
          keyId: result.keyId,
          credentialId: result.credentialId,
          scopes: PAIRING_SCOPES,
        },
        { status: 201 },
      );
}

async function revokeKey(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
  keyId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const result = await revokeAgentKey(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
    keyId,
    new Date().toISOString(),
  );
  return result.status === "invalid_or_expired"
    ? noStoreJson({ error: "KEY_NOT_FOUND" }, { status: 404 })
    : noStoreJson({ revoked: true, keyId });
}

async function replaceBrowserKey(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const body = await readJsonRecord(request);
  const previousKeyId = uuidField(body, "previousKeyId");
  const possessionSignature = stringField(body, "possessionSignature", 86, 128);
  const key = parsePublicKey(body?.key);
  if (
    previousKeyId === null ||
    possessionSignature === null ||
    key === null ||
    key.source !== "browser" ||
    key.keyId === previousKeyId
  ) {
    return invalid("browser signer replacement");
  }

  const agent = await readOwnedAgent(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
  );
  if (agent === null) {
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }
  const previousKey = (await listAgentKeys(env.GUILD_DB, agentId)).find(
    (candidate) =>
      candidate.keyId === previousKeyId &&
      candidate.source === "browser" &&
      candidate.status === "active",
  );
  if (previousKey === undefined) {
    return noStoreJson(
      {
        error: "BROWSER_SIGNER_NOT_FOUND",
        message: "The browser signer is no longer active",
      },
      { status: 409 },
    );
  }

  const keyScan = scanPublicPayload({
    keyId: key.keyId,
    publicJwk: key.publicJwk,
  });
  if (!keyScan.safe) return unsafe(keyScan);

  let canonicalJwk: JsonWebKey;
  try {
    canonicalJwk = canonicalizeEd25519PublicJwk(key.publicJwk);
    await importEd25519VerificationKey(canonicalJwk);
    if ((await deriveEd25519KeyId("browser", canonicalJwk)) !== key.keyId) {
      return invalid("public key identifier");
    }
  } catch {
    return invalid("public key");
  }

  const replacementMessage = browserSignerReplacementMessage(
    agentId,
    previousKeyId,
    key.keyId,
  );
  if (
    !(await verifyEd25519Challenge(
      canonicalJwk,
      replacementMessage,
      possessionSignature,
    ))
  ) {
    return noStoreJson(
      {
        error: "SIGNER_POSSESSION_REJECTED",
        message: "The replacement key proof was not accepted",
      },
      { status: 403 },
    );
  }

  const replacedAt = new Date().toISOString();
  let registeredKey: Awaited<ReturnType<typeof registerAgentKey>>;
  try {
    registeredKey = await registerAgentKey(env.GUILD_DB, {
      keyId: key.keyId,
      ownerId: owner.principal.ownerId,
      agentId,
      publicJwk: canonicalJwk,
      source: "browser",
      createdAt: replacedAt,
    });
  } catch (error) {
    if (isUniqueConstraint(error)) return signerConflict();
    throw error;
  }
  if (registeredKey === null) {
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }

  const revocation = await revokeAgentKey(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
    previousKeyId,
    replacedAt,
  );
  if (revocation.status === "invalid_or_expired") {
    const currentKeys = await listAgentKeys(env.GUILD_DB, agentId);
    const previousAlreadyRevoked = currentKeys.some(
      (candidate) =>
        candidate.keyId === previousKeyId && candidate.status === "revoked",
    );
    if (!previousAlreadyRevoked) {
      await revokeAgentKey(
        env.GUILD_DB,
        owner.principal.ownerId,
        agentId,
        registeredKey.keyId,
        new Date().toISOString(),
      );
      return noStoreJson(
        {
          error: "SIGNER_REPLACEMENT_CONFLICT",
          message: "The signer changed in another session. Refresh and retry",
        },
        { status: 409 },
      );
    }
  }

  return noStoreJson({
    ...ownedAgentResponse(agent, registeredKey.keyId),
    replacedKeyId: previousKeyId,
  });
}

async function revokeCredential(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
  credentialId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const agent = await readOwnedAgent(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
  );
  if (agent === null)
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  const result = await revokeScopedCredential(
    env.GUILD_DB,
    owner.principal.ownerId,
    credentialId,
    new Date().toISOString(),
  );
  return result.status === "invalid_or_expired"
    ? noStoreJson({ error: "CREDENTIAL_NOT_FOUND" }, { status: 404 })
    : noStoreJson({ revoked: true, credentialId });
}

async function changeAutonomy(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const body = await readJsonRecord(request);
  if (
    typeof body?.enabled !== "boolean" ||
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1
  ) {
    return invalid("autonomy policy");
  }
  const result = await setAutonomyPolicy(env.GUILD_DB, {
    ownerId: owner.principal.ownerId,
    agentId,
    expectedVersion: body.expectedVersion,
    enabled: body.enabled,
    effectiveAt: new Date().toISOString(),
  });
  return result.status === "conflict_or_forbidden"
    ? noStoreJson(
        { error: "POLICY_VERSION_CONFLICT", policy: result.policy },
        { status: 409 },
      )
    : noStoreJson({ policy: result.policy });
}

async function readAutonomy(
  request: Request,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const owner = await authenticateOwner(request, env);
  if (!owner.ok) return owner.response;
  const agent = await readOwnedAgent(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
  );
  if (agent === null) {
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }
  const policy = await getAutonomyPolicy(
    env.GUILD_DB,
    owner.principal.ownerId,
    agentId,
  );
  return noStoreJson({
    policy: policy ?? {
      agentId,
      enabled: false,
      version: 1,
      consentedAt: null,
      revokedAt: null,
      updatedAt: null,
    },
  });
}

async function savePrivateDraft(
  request: Request,
  env: GuildhallEnv,
): Promise<Response> {
  const bodyText = await request.text();
  const body = parseJsonRecord(bodyText);
  const requesterAgentId = stringField(body, "requesterAgentId", 1, 100);
  const title = stringField(body, "title", 1, 120);
  if (
    requesterAgentId === null ||
    title === null ||
    body?.payload === undefined
  ) {
    return invalid("draft");
  }
  const authorization = await authorizeAgentAction(request, env, {
    agentId: requesterAgentId,
    bodyText,
    requiredScope: "missions:write",
  });
  if (!authorization.ok) return authorization.response;
  const ownerId =
    authorization.kind === "owner"
      ? authorization.owner.principal.ownerId
      : authorization.credential.ownerId;
  const scan = scanPublicPayload({ title, payload: body.payload });
  const draftId = crypto.randomUUID();
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({ title, payload: body.payload });
  } catch {
    return invalid("draft payload");
  }
  const binding = draftBinding(draftId, ownerId, requesterAgentId);
  const [sealedPayload, payloadDigest] = await Promise.all([
    sealPrivateDraft(payloadJson, env.AUTH_COOKIE_SECRET, binding),
    sha256Base64Url(payloadJson),
  ]);
  const now = new Date().toISOString();
  const draft = await createPrivateDraft(env.GUILD_DB, {
    draftId,
    ownerId,
    requesterAgentId,
    sealedPayload,
    payloadDigest,
    createdAt: now,
  });
  if (draft === null)
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  await storeSafetyDecision(env, ownerId, draftId, scan);
  return noStoreJson(
    {
      draftId,
      safety: scan,
      publicationEligible: scan.safe,
    },
    { status: 201 },
  );
}

async function getPrivateDraft(
  request: Request,
  env: GuildhallEnv,
  draftId: string,
): Promise<Response> {
  const owner = await authenticateOwner(request, env);
  if (!owner.ok) return owner.response;
  const draft = await readPrivateDraft(
    env.GUILD_DB,
    owner.principal.ownerId,
    draftId,
  );
  if (draft === null)
    return noStoreJson({ error: "DRAFT_NOT_FOUND" }, { status: 404 });
  const plaintext = await unsealPrivateDraft(
    draft.sealedPayload,
    env.AUTH_COOKIE_SECRET,
    draftBinding(draft.draftId, draft.ownerId, draft.requesterAgentId),
  );
  if (plaintext === null)
    return noStoreJson({ error: "DRAFT_UNAVAILABLE" }, { status: 500 });
  const envelope = parseDraftEnvelope(plaintext);
  if (envelope === null) return invalid("draft envelope");
  return noStoreJson({
    draftId: draft.draftId,
    title: envelope.title,
    requesterAgentId: draft.requesterAgentId,
    safetyStatus: draft.safetyStatus,
    payload: envelope.payload,
  });
}

async function publishPrivateDraft(
  request: Request,
  env: GuildhallEnv,
  draftId: string,
): Promise<Response> {
  const bodyText = await request.text();
  const body = parseJsonRecord(bodyText);
  const requesterAgentId = stringField(body, "requesterAgentId", 1, 100);
  const keyId = uuidField(body, "keyId");
  const commandId = uuidField(body, "commandId");
  const issuedAt = stringField(body, "issuedAt", 1, 40);
  const proof = CommandProofSchema.safeParse(body?.proof);
  if (requesterAgentId === null) return invalid("requester agent");
  const authorization = await authorizeAgentAction(request, env, {
    agentId: requesterAgentId,
    bodyText,
    requiredScope: "missions:write",
    ...(keyId === null ? {} : { keyId }),
  });
  if (!authorization.ok) return authorization.response;
  const ownerId =
    authorization.kind === "owner"
      ? authorization.owner.principal.ownerId
      : authorization.credential.ownerId;
  const draft = await readPrivateDraft(env.GUILD_DB, ownerId, draftId);
  if (draft === null || draft.requesterAgentId !== requesterAgentId) {
    return noStoreJson({ error: "DRAFT_NOT_FOUND" }, { status: 404 });
  }
  if (authorization.kind === "guild-node") {
    const policy = await getAutonomyPolicy(
      env.GUILD_DB,
      ownerId,
      requesterAgentId,
    );
    if (policy?.enabled !== true) {
      return noStoreJson(
        {
          error: "AUTONOMY_DISABLED",
          message: "Public publication needs owner consent",
        },
        { status: 403 },
      );
    }
  }
  const plaintext = await unsealPrivateDraft(
    draft.sealedPayload,
    env.AUTH_COOKIE_SECRET,
    draftBinding(draft.draftId, draft.ownerId, draft.requesterAgentId),
  );
  if (plaintext === null)
    return noStoreJson({ error: "DRAFT_UNAVAILABLE" }, { status: 500 });
  const envelope = parseDraftEnvelope(plaintext);
  if (envelope === null) return invalid("draft envelope");
  const payload = isRecord(envelope.payload) ? envelope.payload : null;
  if (payload === null) return invalid("mission payload");
  const scan = scanPublicPayload({ title: envelope.title, payload });
  await storeSafetyDecision(env, ownerId, draftId, scan);
  if (!scan.safe) return unsafe(scan);
  const parsedMission = MissionSchema.safeParse(payload);
  if (
    !parsedMission.success ||
    parsedMission.data.requesterAgentId !== requesterAgentId
  ) {
    return invalid("mission payload");
  }
  if (
    keyId === null ||
    commandId === null ||
    issuedAt === null ||
    !proof.success ||
    authorization.keyId !== keyId
  ) {
    return invalid("publication proof");
  }
  const verifiedProof = await verifyAuthenticatedCommandProof({
    authorization,
    commandId,
    action: "publish",
    missionId: parsedMission.data.missionId,
    expectedSequence: 0,
    issuedAt,
    payload: parsedMission.data,
    proof: proof.data,
  });
  if (verifiedProof === null) {
    return noStoreJson(
      {
        error: "COMMAND_PROOF_INVALID",
        message: "The publication signature is missing, stale, or invalid",
      },
      { status: 403 },
    );
  }
  return publishMission(
    env,
    parsedMission.data,
    authorization,
    commandId,
    issuedAt,
    proof.data,
    verifiedProof.verifiedAt,
  );
}

async function publishMission(
  env: GuildhallEnv,
  mission: Mission,
  authorization: Extract<AgentAuthorization, { ok: true }>,
  commandId: string,
  issuedAt: string,
  proof: CommandProof,
  proofVerifiedAt: string,
): Promise<Response> {
  const coordinator = env.MISSIONS.getByName(mission.missionId);
  const publicOwnerId =
    authorization.kind === "owner"
      ? (`github:${authorization.owner.principal.githubUserId}` as const)
      : authorization.credential.publicOwnerId;
  const publicationCommand = {
    commandId,
    expectedSequence: 0,
    actor: {
      agentId: mission.requesterAgentId,
      ownerId: publicOwnerId,
      keyId: authorization.keyId,
    },
    source: authorization.kind === "owner" ? "http" : "mcp",
    issuedAt,
    command: { type: "publish" },
    proof,
    proofVerifiedAt,
    keyStatusCheckedAt: authorization.keyStatusCheckedAt,
    proofAction: "publish",
    proofPayload: mission,
  } as const;
  const result = await coordinator.publishMission(mission, publicationCommand);
  return result.ok
    ? noStoreJson(
        {
          missionId: mission.missionId,
          published: true,
          source: authorization.kind === "owner" ? "http" : "mcp",
          resultingSequence: result.resultingSequence,
        },
        { status: 201 },
      )
    : noStoreJson(
        { error: result.code, message: "Mission publication was not accepted" },
        { status: 409 },
      );
}

async function emergencyRedaction(
  request: Request,
  env: GuildhallEnv,
  missionId: string,
): Promise<Response> {
  const owner = await authorizeOwnerMutation(request, env);
  if (!owner.ok) return owner.response;
  const body = await readJsonRecord(request);
  const eventId = optionalString(body?.eventId, 120);
  const proofId = optionalString(body?.proofId, 120);
  const reason = stringField(body, "reason", 1, 240);
  const category = parseRedactionCategory(body?.category);
  if (eventId === null || reason === null || category === null) {
    return invalid("redaction command");
  }
  const reasonScan = scanPublicPayload({ reason });
  if (!reasonScan.safe) return unsafe(reasonScan);
  const catalog = await readMissionCatalogRow(env.GUILD_DB, missionId);
  if (catalog === null)
    return noStoreJson({ error: "MISSION_NOT_FOUND" }, { status: 404 });
  const requester = await readOwnedAgent(
    env.GUILD_DB,
    owner.principal.ownerId,
    catalog.requester_agent_id,
  );
  if (requester === null)
    return noStoreJson({ error: "MISSION_NOT_FOUND" }, { status: 404 });
  const now = new Date().toISOString();
  const requestedRedactionId = crypto.randomUUID();
  const coordinator = env.MISSIONS.getByName(missionId);
  const rpc = coordinator as unknown as {
    getSnapshot(afterSequence?: number): Promise<{ latestSequence: number }>;
    emergencyRedactEvent(input: {
      redactionId: string;
      eventId: string;
      redactedAt: string;
      pauseCommand: {
        commandId: string;
        expectedSequence: number;
        actor: null;
        source: "http";
        issuedAt: string;
        command: { type: "safety_redact"; redactedEventId: string };
      };
    }): Promise<
      | {
          ok: true;
          redactionId: string;
          eventId: string;
          marker: ReturnType<typeof createRedactedPublicPayload>;
          missionPaused: boolean;
          missionCanceled: boolean;
          resultingSequence: number;
        }
      | { ok: false; code: string }
    >;
  };
  let authoritative:
    Awaited<ReturnType<typeof rpc.emergencyRedactEvent>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await rpc.getSnapshot();
    authoritative = await rpc.emergencyRedactEvent({
      redactionId: requestedRedactionId,
      eventId,
      redactedAt: now,
      pauseCommand: {
        commandId: crypto.randomUUID(),
        expectedSequence: snapshot.latestSequence,
        // Owner-authenticated emergency administration is not an agent
        // signature. The separate redaction audit record names the owner.
        actor: null,
        source: "http",
        issuedAt: now,
        command: { type: "safety_redact", redactedEventId: eventId },
      },
    });
    if (
      authoritative.ok ||
      authoritative.code !== "EXPECTED_SEQUENCE_MISMATCH"
    ) {
      break;
    }
  }
  if (authoritative === undefined || !authoritative.ok) {
    return noStoreJson(
      {
        error: authoritative?.code ?? "REDACTION_NOT_APPLIED",
        message: "The public redaction could not be applied",
      },
      { status: authoritative?.code === "EVENT_NOT_FOUND" ? 404 : 409 },
    );
  }
  const redaction = await recordEmergencyPublicRedaction(env.GUILD_DB, {
    redactionId: authoritative.redactionId,
    missionId,
    eventId: authoritative.eventId,
    proofId,
    requestedByOwnerId: owner.principal.ownerId,
    reason,
    category,
    createdAt: now,
    effectiveAt: now,
  });
  if (
    (redaction.status !== "applied" && redaction.status !== "replay") ||
    redaction.redaction === null
  ) {
    return noStoreJson(
      {
        error: "REDACTION_AUDIT_NOT_RECORDED",
        message:
          "The public payload is masked, but its audit record is pending",
      },
      { status: 503 },
    );
  }
  return noStoreJson({
    redaction: {
      redactionId: authoritative.redactionId,
      missionId,
      eventId: authoritative.eventId,
      proofId,
      marker: authoritative.marker,
      category,
      effectiveAt: now,
    },
    missionPaused: authoritative.missionPaused,
    missionCanceled: authoritative.missionCanceled,
  });
}

async function storeSafetyDecision(
  env: GuildhallEnv,
  ownerId: string,
  draftId: string,
  result: ReturnType<typeof scanPublicPayload>,
): Promise<void> {
  const resultJson = JSON.stringify(result);
  await recordDraftSafetyResult(env.GUILD_DB, {
    safetyResultId: crypto.randomUUID(),
    draftId,
    ownerId,
    scannerVersion: PUBLIC_SAFETY_RULESET_VERSION,
    decision: result.safe ? "safe" : "unsafe",
    categories: result.safe ? [] : [result.category],
    ruleIds: result.safe ? [] : [result.category],
    resultDigest: await sha256Base64Url(resultJson),
    scannedAt: new Date().toISOString(),
  });
}

function parseAgentProfile(body: Record<string, unknown> | null) {
  const slug = stringField(body, "slug", 1, 60);
  const characterName = stringField(body, "characterName", 1, 80);
  const characterClass = stringField(body, "characterClass", 1, 80);
  const technicalName = stringField(body, "technicalName", 1, 120);
  const guildName = optionalString(body?.guildName, 120);
  const publicBio = optionalString(body?.publicBio, 500) ?? "";
  if (
    slug === null ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ||
    characterName === null ||
    characterClass === null ||
    technicalName === null
  ) {
    return null;
  }
  return {
    slug,
    characterName,
    characterClass,
    technicalName,
    guildName,
    publicBio,
  };
}

function parsePublicKey(value: unknown): {
  keyId: string;
  publicJwk: JsonWebKey;
  source: "browser" | "guild-node" | "a2a";
} | null {
  if (!isRecord(value)) return null;
  const keyId = stringField(value, "keyId", 1, 160);
  if (
    keyId === null ||
    !isRecord(value.publicJwk) ||
    (value.source !== "browser" &&
      value.source !== "guild-node" &&
      value.source !== "a2a")
  ) {
    return null;
  }
  return {
    keyId,
    publicJwk: value.publicJwk as JsonWebKey,
    source: value.source,
  };
}

async function readJsonRecord(
  request: Request,
): Promise<Record<string, unknown> | null> {
  return parseJsonRecord(await request.text());
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDraftEnvelope(value: string): {
  readonly title: string;
  readonly payload: unknown;
} | null {
  const envelope = parseJsonRecord(value);
  return envelope !== null &&
    typeof envelope.title === "string" &&
    envelope.title.length >= 1 &&
    envelope.title.length <= 120 &&
    Object.prototype.hasOwnProperty.call(envelope, "payload")
    ? { title: envelope.title, payload: envelope.payload }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown> | null,
  field: string,
  minimum: number,
  maximum: number,
): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" &&
    candidate.length >= minimum &&
    candidate.length <= maximum
    ? candidate
    : null;
}

function uuidField(
  value: Record<string, unknown> | null,
  field: string,
): string | null {
  const candidate = value?.[field];
  return typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate,
    )
    ? candidate
    : null;
}

function optionalString(value: unknown, maximum: number): string | null {
  return value === undefined || value === ""
    ? null
    : typeof value === "string" && value.length <= maximum
      ? value
      : null;
}

function parseRedactionCategory(
  value: unknown,
): PublicRedactionCategory | null {
  return value === "credentials" ||
    value === "pii" ||
    value === "sensitive" ||
    value === "unsafe" ||
    value === "other"
    ? value
    : null;
}

function draftBinding(
  draftId: string,
  ownerId: string,
  agentId: string,
): string {
  return `${draftId}\n${ownerId}\n${agentId}`;
}

function browserSignerReplacementMessage(
  agentId: string,
  previousKeyId: string,
  nextKeyId: string,
): string {
  return `GUILDHALL-BROWSER-SIGNER-REPLACEMENT-V1\n${agentId}\n${previousKeyId}\n${nextKeyId}`;
}

function invalid(subject: string): Response {
  return noStoreJson(
    { error: "INVALID_REQUEST", message: `Invalid ${subject}` },
    { status: 400 },
  );
}

function profileConflict(): Response {
  return noStoreJson(
    {
      error: "PROFILE_HANDLE_TAKEN",
      message: "Choose a different public handle",
    },
    { status: 409 },
  );
}

function signerConflict(): Response {
  return noStoreJson(
    {
      error: "SIGNER_ALREADY_CONNECTED",
      message: "Create this agent with a fresh local signer",
    },
    { status: 409 },
  );
}

async function discardUnconnectedAgent(
  database: D1Database,
  ownerId: string,
  agentId: string,
): Promise<void> {
  await database
    .prepare(
      `DELETE FROM agents
       WHERE agent_id = ? AND owner_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_keys WHERE agent_keys.agent_id = agents.agent_id
         )`,
    )
    .bind(agentId, ownerId)
    .run();
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed")
  );
}

function ownedAgentResponse(agent: AgentProfile, keyId: string) {
  return {
    agentId: agent.agentId,
    slug: agent.slug,
    characterName: agent.characterName,
    characterClass: agent.characterClass,
    technicalName: agent.technicalName,
    guildName: agent.guildName,
    publicBio: agent.publicBio,
    transportStatus: agent.transportStatus,
    totalPoints: agent.totalPoints,
    completedMissions: agent.completedMissions,
    keyId,
  };
}

function unsafe(
  result: Exclude<ReturnType<typeof scanPublicPayload>, { safe: true }>,
): Response {
  return noStoreJson(
    {
      error: "PUBLIC_SAFETY_REJECTED",
      message: "Public content did not pass the safety gate",
      fieldPath: result.fieldPath,
      category: result.category,
    },
    { status: 422 },
  );
}

function pairingFailure(): Response {
  return noStoreJson(
    { error: "PAIRING_FAILED", message: "Pairing proof was not accepted" },
    { status: 403 },
  );
}
