import type {
  ConditionalActionResult,
  ConditionalActionStatus,
} from "./authRepository.js";

export type AgentTransportStatus = "offline" | "online" | "busy";
export type AgentKeySource = "browser" | "guild-node" | "a2a";
export type AgentKeyStatus = "active" | "retired" | "revoked";

export interface AgentProfile {
  readonly agentId: string;
  readonly ownerId: string;
  readonly slug: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly technicalName: string;
  readonly guildName: string | null;
  readonly publicBio: string;
  readonly transportStatus: AgentTransportStatus;
  readonly totalPoints: number;
  readonly completedMissions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAgentInput {
  readonly agentId: string;
  readonly ownerId: string;
  readonly slug: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly technicalName: string;
  readonly guildName: string | null;
  readonly publicBio: string;
  readonly createdAt: string;
}

export interface UpdateOwnedAgentInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly slug: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly technicalName: string;
  readonly guildName: string | null;
  readonly publicBio: string;
  readonly updatedAt: string;
}

export interface DeclareAgentCapabilityInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly capability: string;
  readonly declaredLevel: number;
  readonly updatedAt: string;
}

export interface AgentKeyRecord {
  readonly keyId: string;
  readonly agentId: string;
  readonly publicJwk: JsonWebKey;
  readonly source: AgentKeySource;
  readonly status: AgentKeyStatus;
  readonly createdAt: string;
  readonly retiredAt: string | null;
  readonly revokedAt: string | null;
}

export interface RegisterAgentKeyInput {
  readonly keyId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly publicJwk: JsonWebKey;
  readonly source: AgentKeySource;
  readonly createdAt: string;
}

export interface ScopedCredentialRegistration {
  readonly credentialId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly keyId: string;
  readonly credentialHash: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface CredentialPrincipal {
  readonly credentialId: string;
  readonly ownerId: string;
  readonly publicOwnerId: `github:${number}`;
  readonly agentId: string;
  readonly keyId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
}

export interface ConsumeAgentRequestNonceInput {
  readonly credentialId: string;
  readonly nonceHash: string;
  readonly issuedAt: string;
  readonly consumedAt: string;
}

export interface PairingChallengeInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly codeHash: string;
  readonly challenge: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface PairingChallengeRecord {
  readonly ownerId: string;
  readonly agentId: string;
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface ConsumePairingInput {
  readonly codeHash: string;
  readonly challenge: string;
  readonly now: string;
  readonly consumedAt: string;
  /** Must only be constructed after Ed25519 challenge verification. */
  readonly possessionVerified: true;
  readonly possessionProofDigest: string;
  readonly possessionSignature: string;
  readonly keyId: string;
  readonly publicJwk: JsonWebKey;
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly scopes: readonly string[];
  readonly credentialExpiresAt: string | null;
}

export interface PairingConsumeResult extends ConditionalActionResult {
  readonly agentId?: string;
  readonly keyId?: string;
  readonly credentialId?: string;
}

export interface HistoricalPairingProof {
  readonly agentId: string;
  readonly keyId: string;
  readonly credentialId: string;
  readonly challenge: string;
  readonly signature: string;
  readonly proofDigest: string;
  readonly consumedAt: string;
}

export interface AutonomyPolicy {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly consentedAt: string | null;
  readonly revokedAt: string | null;
  readonly updatedAt: string;
}

export interface SetAutonomyPolicyInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly expectedVersion: number;
  readonly enabled: boolean;
  readonly effectiveAt: string;
}

export interface AutonomyPolicyWriteResult {
  readonly status: "applied" | "replay" | "conflict_or_forbidden";
  readonly policy: AutonomyPolicy | null;
}

export type DraftSafetyStatus = "pending" | "safe" | "unsafe" | "redacted";

export interface PrivateMissionDraft {
  readonly draftId: string;
  readonly ownerId: string;
  readonly requesterAgentId: string;
  /** Opaque encrypted mission material, available only through owner auth. */
  readonly sealedPayload: string;
  readonly safetyStatus: DraftSafetyStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly redactedAt: string | null;
}

export interface CreatePrivateDraftInput {
  readonly draftId: string;
  readonly ownerId: string;
  readonly requesterAgentId: string;
  readonly sealedPayload: string;
  readonly payloadDigest: string;
  readonly createdAt: string;
}

export interface DraftSafetyResultInput {
  readonly safetyResultId: string;
  readonly draftId: string;
  readonly ownerId: string;
  readonly scannerVersion: string;
  readonly decision: "safe" | "unsafe";
  /** Category names only: never include matching input fragments. */
  readonly categories: readonly string[];
  readonly ruleIds: readonly string[];
  readonly resultDigest: string;
  readonly scannedAt: string;
}

export interface RedactPrivateDraftInput {
  readonly draftId: string;
  readonly ownerId: string;
  readonly replacementSealedPayload: string;
  readonly replacementPayloadDigest: string;
  readonly redactedAt: string;
}

export type PublicRedactionCategory =
  "credentials" | "pii" | "sensitive" | "unsafe" | "other";

export interface EmergencyPublicRedactionInput {
  readonly redactionId: string;
  readonly missionId: string;
  readonly eventId: string | null;
  readonly proofId: string | null;
  readonly requestedByOwnerId: string;
  readonly reason: string;
  readonly category: PublicRedactionCategory;
  readonly createdAt: string;
  readonly effectiveAt: string;
}

export interface PublicRedactionRecord {
  readonly redactionId: string;
  readonly missionId: string;
  readonly eventId: string | null;
  readonly proofId: string | null;
  readonly requestedByOwnerId: string;
  readonly marker: "[REDACTED]";
  readonly reason: string;
  readonly category: PublicRedactionCategory;
  readonly createdAt: string;
  readonly effectiveAt: string;
}

interface AgentRow {
  readonly agent_id: string;
  readonly owner_id: string;
  readonly slug: string;
  readonly character_name: string;
  readonly character_class: string;
  readonly technical_name: string;
  readonly guild_name: string | null;
  readonly public_bio: string;
  readonly transport_status: AgentTransportStatus;
  readonly total_points: number;
  readonly completed_missions: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AgentKeyRow {
  readonly key_id: string;
  readonly agent_id: string;
  readonly public_jwk_json: string;
  readonly source: AgentKeySource;
  readonly status: AgentKeyStatus;
  readonly created_at: string;
  readonly retired_at: string | null;
  readonly revoked_at: string | null;
}

interface CredentialRow {
  readonly credential_id: string;
  readonly owner_id: string;
  readonly public_owner_id: string;
  readonly agent_id: string;
  readonly key_id: string;
  readonly scope_json: string;
  readonly expires_at: string | null;
}

interface PairingStatusRow {
  readonly agent_id: string;
  readonly consumed_at: string | null;
  readonly consumed_key_id: string | null;
  readonly consumed_credential_id: string | null;
}

interface AutonomyRow {
  readonly agent_id: string;
  readonly public_publication_enabled: number;
  readonly policy_version: number;
  readonly consented_at: string | null;
  readonly revoked_at: string | null;
  readonly updated_at: string;
}

interface PrivateDraftRow {
  readonly draft_id: string;
  readonly owner_id: string;
  readonly requester_agent_id: string;
  readonly sealed_payload: string;
  readonly safety_status: DraftSafetyStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly redacted_at: string | null;
}

interface RedactionRow {
  readonly redaction_id: string;
  readonly mission_id: string;
  readonly event_id: string | null;
  readonly proof_id: string | null;
  readonly requested_by_owner_id: string;
  readonly marker: "[REDACTED]";
  readonly reason: string;
  readonly category: PublicRedactionCategory;
  readonly created_at: string;
  readonly effective_at: string;
}

const AGENT_COLUMNS = `
  agent_id,
  owner_id,
  slug,
  character_name,
  character_class,
  technical_name,
  guild_name,
  public_bio,
  transport_status,
  total_points,
  completed_missions,
  created_at,
  updated_at
`;

const AGENT_KEY_COLUMNS = `
  key_id,
  agent_id,
  public_jwk_json,
  source,
  status,
  created_at,
  retired_at,
  revoked_at
`;

const DRAFT_COLUMNS = `
  draft_id,
  owner_id,
  requester_agent_id,
  sealed_payload,
  safety_status,
  created_at,
  updated_at,
  redacted_at
`;

export async function createAgent(
  database: D1Database,
  input: CreateAgentInput,
): Promise<AgentProfile> {
  const results = await database.batch<AgentRow>([
    database
      .prepare(
        `INSERT INTO agents (
          agent_id, owner_id, slug, character_name, character_class,
          technical_name, guild_name, public_bio, transport_status,
          total_points, completed_missions, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'offline', 0, 0, ?, ?
        FROM owners
        WHERE owner_id = ?`,
      )
      .bind(
        input.agentId,
        input.ownerId,
        input.slug,
        input.characterName,
        input.characterClass,
        input.technicalName,
        input.guildName,
        input.publicBio,
        input.createdAt,
        input.createdAt,
        input.ownerId,
      ),
    database
      .prepare(
        `INSERT INTO autonomy_policies (
          agent_id, public_publication_enabled, policy_version,
          consented_at, revoked_at, updated_at
        )
        SELECT ?, 0, 1, NULL, NULL, ?
        FROM agents
        WHERE agent_id = ? AND owner_id = ?`,
      )
      .bind(input.agentId, input.createdAt, input.agentId, input.ownerId),
    database
      .prepare(
        `INSERT INTO autonomy_policy_history (
          agent_id, policy_version, public_publication_enabled,
          consented_at, revoked_at, recorded_at
        )
        SELECT agent_id, policy_version, public_publication_enabled,
               consented_at, revoked_at, ?
        FROM autonomy_policies
        WHERE agent_id = ?`,
      )
      .bind(input.createdAt, input.agentId),
    database
      .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE agent_id = ? LIMIT 1`)
      .bind(input.agentId),
  ]);

  return toAgent(requireBatchRow(results, 3, "created agent"));
}

/** Owner-declared capability; verified rank fields remain receipt-owned. */
export async function declareAgentCapability(
  database: D1Database,
  input: DeclareAgentCapabilityInput,
): Promise<boolean> {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(input.capability) ||
    !Number.isSafeInteger(input.declaredLevel) ||
    input.declaredLevel < 0 ||
    input.declaredLevel > 100
  ) {
    throw new TypeError("Declared capability is invalid");
  }
  const result = await database
    .prepare(
      `INSERT INTO agent_capabilities (
         agent_id, capability, declared_level, verified_points,
         verified_missions, reliability, timeliness, updated_at
       )
       SELECT agents.agent_id, ?, ?, 0, 0, 0, 0, ?
       FROM agents
       WHERE agents.agent_id = ? AND agents.owner_id = ?
       ON CONFLICT(agent_id, capability) DO UPDATE SET
         declared_level = excluded.declared_level,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.capability,
      input.declaredLevel,
      input.updatedAt,
      input.agentId,
      input.ownerId,
    )
    .run();
  return result.meta.changes > 0;
}

export async function readOwnedAgent(
  database: D1Database,
  ownerId: string,
  agentId: string,
): Promise<AgentProfile | null> {
  const row = await database
    .prepare(
      `SELECT ${AGENT_COLUMNS}
       FROM agents
       WHERE agent_id = ? AND owner_id = ?
       LIMIT 1`,
    )
    .bind(agentId, ownerId)
    .first<AgentRow>();
  return row === null ? null : toAgent(row);
}

export async function updateOwnedAgent(
  database: D1Database,
  input: UpdateOwnedAgentInput,
): Promise<AgentProfile | null> {
  const results = await database.batch<AgentRow>([
    database
      .prepare(
        `UPDATE agents
         SET slug = ?, character_name = ?, character_class = ?,
             technical_name = ?, guild_name = ?, public_bio = ?, updated_at = ?
         WHERE agent_id = ? AND owner_id = ?
           AND EXISTS (
             SELECT 1
             FROM agent_keys
             WHERE agent_keys.agent_id = agents.agent_id
               AND agent_keys.source = 'browser'
               AND agent_keys.status = 'active'
           )`,
      )
      .bind(
        input.slug,
        input.characterName,
        input.characterClass,
        input.technicalName,
        input.guildName,
        input.publicBio,
        input.updatedAt,
        input.agentId,
        input.ownerId,
      ),
    database
      .prepare(
        `SELECT ${AGENT_COLUMNS}
         FROM agents
         WHERE agent_id = ? AND owner_id = ?
           AND EXISTS (
             SELECT 1
             FROM agent_keys
             WHERE agent_keys.agent_id = agents.agent_id
               AND agent_keys.source = 'browser'
               AND agent_keys.status = 'active'
           )
         LIMIT 1`,
      )
      .bind(input.agentId, input.ownerId),
  ]);
  const row = firstBatchRow(results, 1);
  return row === undefined ? null : toAgent(row);
}

export async function registerAgentKey(
  database: D1Database,
  input: RegisterAgentKeyInput,
): Promise<AgentKeyRecord | null> {
  const jwkJson = serializeJson(input.publicJwk, "publicJwk");
  const results = await database.batch<AgentKeyRow>([
    database
      .prepare(
        `INSERT INTO agent_keys (
          key_id, agent_id, public_jwk_json, source, status, created_at,
          retired_at, revoked_at
        )
        SELECT ?, agent_id, ?, ?, 'active', ?, NULL, NULL
        FROM agents
        WHERE agent_id = ? AND owner_id = ?`,
      )
      .bind(
        input.keyId,
        jwkJson,
        input.source,
        input.createdAt,
        input.agentId,
        input.ownerId,
      ),
    database
      .prepare(
        `SELECT ${AGENT_KEY_COLUMNS}
         FROM agent_keys
         WHERE key_id = ? AND agent_id = ?
         LIMIT 1`,
      )
      .bind(input.keyId, input.agentId),
  ]);
  const row = firstBatchRow(results, 1);
  return row === undefined ? null : toAgentKey(row);
}

export async function listAgentKeys(
  database: D1Database,
  agentId: string,
): Promise<readonly AgentKeyRecord[]> {
  const result = await database
    .prepare(
      `SELECT ${AGENT_KEY_COLUMNS}
       FROM agent_keys
       WHERE agent_id = ?
       ORDER BY created_at DESC, key_id`,
    )
    .bind(agentId)
    .all<AgentKeyRow>();
  return result.results.map(toAgentKey);
}

export async function revokeAgentKey(
  database: D1Database,
  ownerId: string,
  agentId: string,
  keyId: string,
  revokedAt: string,
): Promise<ConditionalActionResult> {
  const results = await database.batch<{ status: AgentKeyStatus }>([
    database
      .prepare(
        `UPDATE agent_keys
         SET status = 'revoked', revoked_at = ?
         WHERE key_id = ?
           AND agent_id = ?
           AND status <> 'revoked'
           AND EXISTS (
             SELECT 1 FROM agents
             WHERE agents.agent_id = agent_keys.agent_id
               AND agents.owner_id = ?
           )`,
      )
      .bind(revokedAt, keyId, agentId, ownerId),
    database
      .prepare(
        `SELECT agent_keys.status
         FROM agent_keys
         INNER JOIN agents ON agents.agent_id = agent_keys.agent_id
         WHERE agent_keys.key_id = ?
           AND agent_keys.agent_id = ?
           AND agents.owner_id = ?
         LIMIT 1`,
      )
      .bind(keyId, agentId, ownerId),
  ]);
  return conditionalStatus(results, 0, 1, (row) => row.status === "revoked");
}

export async function registerScopedCredential(
  database: D1Database,
  input: ScopedCredentialRegistration,
): Promise<CredentialPrincipal | null> {
  const scopeJson = serializeJson(input.scopes, "scopes");
  const results = await database.batch<CredentialRow>([
    database
      .prepare(
        `INSERT INTO agent_credentials (
          credential_id, agent_id, key_id, credential_hash, scope_json, expires_at,
          revoked_at, created_at, last_used_at
        )
        SELECT ?, agents.agent_id, agent_keys.key_id, ?, ?, ?, NULL, ?, NULL
        FROM agents
        INNER JOIN agent_keys ON agent_keys.agent_id = agents.agent_id
        WHERE agents.agent_id = ?
          AND agents.owner_id = ?
          AND agent_keys.key_id = ?
          AND agent_keys.status = 'active'
          AND agent_keys.revoked_at IS NULL`,
      )
      .bind(
        input.credentialId,
        input.credentialHash,
        scopeJson,
        input.expiresAt,
        input.createdAt,
        input.agentId,
        input.ownerId,
        input.keyId,
      ),
    credentialPrincipalStatement(database, input.credentialId, input.ownerId),
  ]);
  const row = firstBatchRow(results, 1);
  return row === undefined ? null : toCredentialPrincipal(row);
}

export async function authenticateScopedCredential(
  database: D1Database,
  credentialHash: string,
  now: string,
): Promise<CredentialPrincipal | null> {
  const results = await database.batch<CredentialRow>([
    database
      .prepare(
        `UPDATE agent_credentials
         SET last_used_at = ?
         WHERE credential_hash = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND EXISTS (
             SELECT 1 FROM agent_keys
             WHERE agent_keys.key_id = agent_credentials.key_id
               AND agent_keys.agent_id = agent_credentials.agent_id
               AND agent_keys.status = 'active'
               AND agent_keys.revoked_at IS NULL
           )`,
      )
      .bind(now, credentialHash, now),
    database
      .prepare(
        `SELECT
           agent_credentials.credential_id,
           agents.owner_id,
           'github:' || owners.github_user_id AS public_owner_id,
           agent_credentials.agent_id,
           agent_credentials.key_id,
           agent_credentials.scope_json,
           agent_credentials.expires_at
         FROM agent_credentials
         INNER JOIN agents ON agents.agent_id = agent_credentials.agent_id
         INNER JOIN owners ON owners.owner_id = agents.owner_id
         INNER JOIN agent_keys
           ON agent_keys.key_id = agent_credentials.key_id
          AND agent_keys.agent_id = agent_credentials.agent_id
         WHERE agent_credentials.credential_hash = ?
           AND agent_credentials.revoked_at IS NULL
           AND agent_keys.status = 'active'
           AND agent_keys.revoked_at IS NULL
           AND (
             agent_credentials.expires_at IS NULL
             OR agent_credentials.expires_at > ?
           )
         LIMIT 1`,
      )
      .bind(credentialHash, now),
  ]);
  const row = firstBatchRow(results, 1);
  return row === undefined ? null : toCredentialPrincipal(row);
}

/** Atomically records a signed request nonce. False means it was already used. */
export async function consumeAgentRequestNonce(
  database: D1Database,
  input: ConsumeAgentRequestNonceInput,
): Promise<boolean> {
  const result = await database
    .prepare(
      `INSERT OR IGNORE INTO agent_request_nonces (
         credential_id, nonce_hash, issued_at, consumed_at
       )
       SELECT credential_id, ?, ?, ?
       FROM agent_credentials
       WHERE credential_id = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(
      input.nonceHash,
      input.issuedAt,
      input.consumedAt,
      input.credentialId,
      input.consumedAt,
    )
    .run();
  return result.meta.changes === 1;
}

export async function revokeScopedCredential(
  database: D1Database,
  ownerId: string,
  credentialId: string,
  revokedAt: string,
): Promise<ConditionalActionResult> {
  const results = await database.batch<{ revoked_at: string | null }>([
    database
      .prepare(
        `UPDATE agent_credentials
         SET revoked_at = ?
         WHERE credential_id = ?
           AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM agents
             WHERE agents.agent_id = agent_credentials.agent_id
               AND agents.owner_id = ?
           )`,
      )
      .bind(revokedAt, credentialId, ownerId),
    database
      .prepare(
        `SELECT agent_credentials.revoked_at
         FROM agent_credentials
         INNER JOIN agents ON agents.agent_id = agent_credentials.agent_id
         WHERE agent_credentials.credential_id = ?
           AND agents.owner_id = ?
         LIMIT 1`,
      )
      .bind(credentialId, ownerId),
  ]);
  return conditionalStatus(results, 0, 1, (row) => row.revoked_at !== null);
}

export async function createPairingChallenge(
  database: D1Database,
  input: PairingChallengeInput,
): Promise<PairingChallengeRecord | null> {
  const results = await database.batch<{
    owner_id: string;
    agent_id: string;
    challenge: string;
    expires_at: string;
  }>([
    database
      .prepare(
        `INSERT INTO pairing_codes (
          code_hash, owner_id, agent_id, challenge, expires_at, consumed_at,
          created_at, consumed_key_id, consumed_credential_id,
          possession_proof_digest, possession_signature, finalized_at
        )
        SELECT ?, owner_id, agent_id, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL
        FROM agents
        WHERE agent_id = ? AND owner_id = ?`,
      )
      .bind(
        input.codeHash,
        input.challenge,
        input.expiresAt,
        input.createdAt,
        input.agentId,
        input.ownerId,
      ),
    database
      .prepare(
        `SELECT owner_id, agent_id, challenge, expires_at
         FROM pairing_codes
         WHERE code_hash = ?
         LIMIT 1`,
      )
      .bind(input.codeHash),
  ]);
  const row = firstBatchRow(results, 1);
  return row === undefined
    ? null
    : {
        ownerId: row.owner_id,
        agentId: row.agent_id,
        challenge: row.challenge,
        expiresAt: row.expires_at,
      };
}

/** Public cryptographic evidence remains inspectable after key revocation. */
export async function getHistoricalPairingProof(
  database: D1Database,
  keyId: string,
): Promise<HistoricalPairingProof | null> {
  const row = await database
    .prepare(
      `SELECT
         agent_id,
         consumed_key_id,
         consumed_credential_id,
         challenge,
         possession_signature,
         possession_proof_digest,
         consumed_at
       FROM pairing_codes
       WHERE consumed_key_id = ?
         AND consumed_credential_id IS NOT NULL
         AND possession_signature IS NOT NULL
         AND possession_proof_digest IS NOT NULL
         AND consumed_at IS NOT NULL
         AND finalized_at IS NOT NULL
       LIMIT 1`,
    )
    .bind(keyId)
    .first<{
      agent_id: string;
      consumed_key_id: string;
      consumed_credential_id: string;
      challenge: string;
      possession_signature: string;
      possession_proof_digest: string;
      consumed_at: string;
    }>();
  return row === null
    ? null
    : {
        agentId: row.agent_id,
        keyId: row.consumed_key_id,
        credentialId: row.consumed_credential_id,
        challenge: row.challenge,
        signature: row.possession_signature,
        proofDigest: row.possession_proof_digest,
        consumedAt: row.consumed_at,
      };
}

/** Internal lookup used before Ed25519 challenge verification. */
export async function getPendingPairingChallenge(
  database: D1Database,
  codeHash: string,
  now: string,
): Promise<PairingChallengeRecord | null> {
  const row = await database
    .prepare(
      `SELECT owner_id, agent_id, challenge, expires_at
       FROM pairing_codes
       WHERE code_hash = ?
         AND consumed_at IS NULL
         AND expires_at > ?
       LIMIT 1`,
    )
    .bind(codeHash, now)
    .first<{
      owner_id: string;
      agent_id: string;
      challenge: string;
      expires_at: string;
    }>();
  return row === null
    ? null
    : {
        ownerId: row.owner_id,
        agentId: row.agent_id,
        challenge: row.challenge,
        expiresAt: row.expires_at,
      };
}

/**
 * Atomically installs the proven key/credential and consumes the pairing code.
 * The caller verifies the Ed25519 challenge before constructing this input.
 */
export async function consumePairingChallenge(
  database: D1Database,
  input: ConsumePairingInput,
): Promise<PairingConsumeResult> {
  const jwkJson = serializeJson(input.publicJwk, "publicJwk");
  const scopeJson = serializeJson(input.scopes, "scopes");
  const results = await database.batch<PairingStatusRow>([
    database
      .prepare(
        `UPDATE pairing_codes
         SET consumed_at = ?,
             consumed_key_id = ?,
             consumed_credential_id = ?,
             possession_proof_digest = ?,
             possession_signature = ?
         WHERE code_hash = ?
           AND challenge = ?
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .bind(
        input.consumedAt,
        input.keyId,
        input.credentialId,
        input.possessionProofDigest,
        input.possessionSignature,
        input.codeHash,
        input.challenge,
        input.now,
      ),
    database
      .prepare(
        `INSERT INTO agent_keys (
          key_id, agent_id, public_jwk_json, source, status, created_at,
          retired_at, revoked_at
        )
        SELECT ?, agent_id, ?, 'guild-node', 'active', ?, NULL, NULL
        FROM pairing_codes
        WHERE code_hash = ?
          AND challenge = ?
          AND consumed_at = ?
          AND consumed_key_id = ?
          AND consumed_credential_id = ?
          AND possession_proof_digest = ?
          AND finalized_at IS NULL
        ON CONFLICT(key_id) DO UPDATE SET
          public_jwk_json = CASE
            WHEN agent_keys.agent_id = excluded.agent_id
              AND agent_keys.public_jwk_json = excluded.public_jwk_json
              AND agent_keys.source = excluded.source
              AND agent_keys.status = 'active'
              AND agent_keys.revoked_at IS NULL
            THEN agent_keys.public_jwk_json
            ELSE NULL
          END`,
      )
      .bind(
        input.keyId,
        jwkJson,
        input.consumedAt,
        input.codeHash,
        input.challenge,
        input.consumedAt,
        input.keyId,
        input.credentialId,
        input.possessionProofDigest,
      ),
    database
      .prepare(
        `INSERT INTO agent_credentials (
          credential_id, agent_id, key_id, credential_hash, scope_json, expires_at,
          revoked_at, created_at, last_used_at
        )
        SELECT ?, agent_id, ?, ?, ?, ?, NULL, ?, NULL
        FROM pairing_codes
        WHERE code_hash = ?
           AND challenge = ?
          AND consumed_at = ?
          AND consumed_key_id = ?
          AND consumed_credential_id = ?
          AND possession_proof_digest = ?
          AND finalized_at IS NULL
        ON CONFLICT(credential_id) DO UPDATE SET
          scope_json = CASE
            WHEN agent_credentials.agent_id = excluded.agent_id
              AND agent_credentials.key_id = excluded.key_id
              AND agent_credentials.credential_hash = excluded.credential_hash
              AND agent_credentials.scope_json = excluded.scope_json
              AND agent_credentials.expires_at IS excluded.expires_at
              AND agent_credentials.revoked_at IS NULL
            THEN agent_credentials.scope_json
            ELSE NULL
          END`,
      )
      .bind(
        input.credentialId,
        input.keyId,
        input.credentialHash,
        scopeJson,
        input.credentialExpiresAt,
        input.consumedAt,
        input.codeHash,
        input.challenge,
        input.consumedAt,
        input.keyId,
        input.credentialId,
        input.possessionProofDigest,
      ),
    database
      .prepare(
        `UPDATE pairing_codes
         SET finalized_at = ?
         WHERE code_hash = ?
           AND challenge = ?
           AND consumed_at = ?
           AND consumed_key_id = ?
           AND consumed_credential_id = ?
           AND possession_proof_digest = ?
           AND finalized_at IS NULL
           AND EXISTS (
             SELECT 1 FROM agent_keys
             WHERE key_id = ?
               AND agent_id = pairing_codes.agent_id
               AND public_jwk_json = ?
               AND source = 'guild-node'
               AND status = 'active'
               AND revoked_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM agent_credentials
             WHERE credential_id = ?
               AND agent_id = pairing_codes.agent_id
               AND key_id = pairing_codes.consumed_key_id
               AND credential_hash = ?
               AND scope_json = ?
               AND expires_at IS ?
               AND revoked_at IS NULL
           )`,
      )
      .bind(
        input.consumedAt,
        input.codeHash,
        input.challenge,
        input.consumedAt,
        input.keyId,
        input.credentialId,
        input.possessionProofDigest,
        input.keyId,
        jwkJson,
        input.credentialId,
        input.credentialHash,
        scopeJson,
        input.credentialExpiresAt,
      ),
    database
      .prepare(
        `SELECT
           agent_id,
           consumed_at,
           consumed_key_id,
           consumed_credential_id
         FROM pairing_codes
         WHERE code_hash = ? AND challenge = ?
         LIMIT 1`,
      )
      .bind(input.codeHash, input.challenge),
  ]);

  const row = firstBatchRow(results, 4);
  if (batchResult(results, 3).meta.changes > 0 && row !== undefined) {
    return {
      status: "applied",
      agentId: row.agent_id,
      keyId: input.keyId,
      credentialId: input.credentialId,
    };
  }
  if (row?.consumed_at !== null && row?.consumed_at !== undefined) {
    return {
      status: "replay",
      agentId: row.agent_id,
      ...(row.consumed_key_id === null ? {} : { keyId: row.consumed_key_id }),
      ...(row.consumed_credential_id === null
        ? {}
        : { credentialId: row.consumed_credential_id }),
    };
  }
  return { status: "invalid_or_expired" };
}

export async function getAutonomyPolicy(
  database: D1Database,
  ownerId: string,
  agentId: string,
): Promise<AutonomyPolicy | null> {
  const row = await database
    .prepare(
      `SELECT
         autonomy_policies.agent_id,
         autonomy_policies.public_publication_enabled,
         autonomy_policies.policy_version,
         autonomy_policies.consented_at,
         autonomy_policies.revoked_at,
         autonomy_policies.updated_at
       FROM autonomy_policies
       INNER JOIN agents ON agents.agent_id = autonomy_policies.agent_id
       WHERE autonomy_policies.agent_id = ? AND agents.owner_id = ?
       LIMIT 1`,
    )
    .bind(agentId, ownerId)
    .first<AutonomyRow>();
  return row === null ? null : toAutonomyPolicy(row);
}

export async function setAutonomyPolicy(
  database: D1Database,
  input: SetAutonomyPolicyInput,
): Promise<AutonomyPolicyWriteResult> {
  const enabled = input.enabled ? 1 : 0;
  const nextVersion = input.expectedVersion + 1;
  const results = await database.batch<AutonomyRow>([
    database
      .prepare(
        `INSERT INTO autonomy_policies (
          agent_id, public_publication_enabled, policy_version,
          consented_at, revoked_at, updated_at
        )
        SELECT agent_id, 0, 1, NULL, NULL, ?
        FROM agents
        WHERE agent_id = ? AND owner_id = ?
        ON CONFLICT(agent_id) DO NOTHING`,
      )
      .bind(input.effectiveAt, input.agentId, input.ownerId),
    database
      .prepare(
        `INSERT INTO autonomy_policy_history (
          agent_id, policy_version, public_publication_enabled,
          consented_at, revoked_at, recorded_at
        )
        SELECT agent_id, policy_version, public_publication_enabled,
               consented_at, revoked_at, ?
        FROM autonomy_policies
        WHERE agent_id = ?
        ON CONFLICT(agent_id, policy_version) DO NOTHING`,
      )
      .bind(input.effectiveAt, input.agentId),
    database
      .prepare(
        `UPDATE autonomy_policies
         SET public_publication_enabled = ?,
             policy_version = policy_version + 1,
             consented_at = CASE WHEN ? = 1 THEN ? ELSE consented_at END,
             revoked_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
             updated_at = ?
         WHERE agent_id = ?
           AND policy_version = ?
           AND EXISTS (
             SELECT 1 FROM agents
             WHERE agents.agent_id = autonomy_policies.agent_id
               AND agents.owner_id = ?
           )`,
      )
      .bind(
        enabled,
        enabled,
        input.effectiveAt,
        enabled,
        input.effectiveAt,
        input.effectiveAt,
        input.agentId,
        input.expectedVersion,
        input.ownerId,
      ),
    database
      .prepare(
        `INSERT INTO autonomy_policy_history (
          agent_id, policy_version, public_publication_enabled,
          consented_at, revoked_at, recorded_at
        )
        SELECT agent_id, policy_version, public_publication_enabled,
               consented_at, revoked_at, ?
        FROM autonomy_policies
        WHERE agent_id = ?
          AND policy_version = ?
          AND updated_at = ?
        ON CONFLICT(agent_id, policy_version) DO NOTHING`,
      )
      .bind(input.effectiveAt, input.agentId, nextVersion, input.effectiveAt),
    database
      .prepare(
        `SELECT
           autonomy_policies.agent_id,
           autonomy_policies.public_publication_enabled,
           autonomy_policies.policy_version,
           autonomy_policies.consented_at,
           autonomy_policies.revoked_at,
           autonomy_policies.updated_at
         FROM autonomy_policies
         INNER JOIN agents ON agents.agent_id = autonomy_policies.agent_id
         WHERE autonomy_policies.agent_id = ? AND agents.owner_id = ?
         LIMIT 1`,
      )
      .bind(input.agentId, input.ownerId),
  ]);

  const row = firstBatchRow(results, 4);
  const policy = row === undefined ? null : toAutonomyPolicy(row);
  if (batchResult(results, 2).meta.changes > 0) {
    return { status: "applied", policy };
  }
  if (
    policy?.version === nextVersion &&
    policy.enabled === input.enabled &&
    policy.updatedAt === input.effectiveAt
  ) {
    return { status: "replay", policy };
  }
  return { status: "conflict_or_forbidden", policy };
}

export async function createPrivateDraft(
  database: D1Database,
  input: CreatePrivateDraftInput,
): Promise<PrivateMissionDraft | null> {
  const results = await database.batch<PrivateDraftRow>([
    database
      .prepare(
        `INSERT INTO private_mission_drafts (
          draft_id, owner_id, requester_agent_id, sealed_payload,
          payload_digest, safety_status, created_at, updated_at, redacted_at
        )
        SELECT ?, owner_id, agent_id, ?, ?, 'pending', ?, ?, NULL
        FROM agents
        WHERE agent_id = ? AND owner_id = ?`,
      )
      .bind(
        input.draftId,
        input.sealedPayload,
        input.payloadDigest,
        input.createdAt,
        input.createdAt,
        input.requesterAgentId,
        input.ownerId,
      ),
    database
      .prepare(
        `SELECT ${DRAFT_COLUMNS} FROM private_mission_drafts WHERE draft_id = ? LIMIT 1`,
      )
      .bind(input.draftId),
  ]);
  const row = firstBatchRow(results, 1);
  return row === undefined ? null : toPrivateDraft(row);
}

export async function readPrivateDraft(
  database: D1Database,
  ownerId: string,
  draftId: string,
): Promise<PrivateMissionDraft | null> {
  const row = await database
    .prepare(
      `SELECT ${DRAFT_COLUMNS}
       FROM private_mission_drafts
       WHERE draft_id = ? AND owner_id = ?
       LIMIT 1`,
    )
    .bind(draftId, ownerId)
    .first<PrivateDraftRow>();
  return row === null ? null : toPrivateDraft(row);
}

export async function recordDraftSafetyResult(
  database: D1Database,
  input: DraftSafetyResultInput,
): Promise<ConditionalActionResult> {
  const categoriesJson = serializeJson(input.categories, "categories");
  const ruleIdsJson = serializeJson(input.ruleIds, "ruleIds");
  const results = await database.batch<unknown>([
    database
      .prepare(
        `INSERT INTO draft_safety_results (
          safety_result_id, draft_id, scanner_version, decision,
          categories_json, rule_ids_json, result_digest, scanned_at
        )
        SELECT ?, draft_id, ?, ?, ?, ?, ?, ?
        FROM private_mission_drafts
        WHERE draft_id = ? AND owner_id = ?
        ON CONFLICT(safety_result_id) DO NOTHING`,
      )
      .bind(
        input.safetyResultId,
        input.scannerVersion,
        input.decision,
        categoriesJson,
        ruleIdsJson,
        input.resultDigest,
        input.scannedAt,
        input.draftId,
        input.ownerId,
      ),
    database
      .prepare(
        `UPDATE private_mission_drafts
         SET safety_status = ?, updated_at = ?
         WHERE draft_id = ?
           AND owner_id = ?
           AND EXISTS (
             SELECT 1 FROM draft_safety_results
             WHERE safety_result_id = ?
               AND draft_id = private_mission_drafts.draft_id
               AND decision = ?
               AND result_digest = ?
           )`,
      )
      .bind(
        input.decision,
        input.scannedAt,
        input.draftId,
        input.ownerId,
        input.safetyResultId,
        input.decision,
        input.resultDigest,
      ),
  ]);
  return batchResult(results, 0).meta.changes > 0
    ? { status: "applied" }
    : batchResult(results, 1).meta.changes > 0
      ? { status: "replay" }
      : { status: "invalid_or_expired" };
}

export async function redactPrivateDraft(
  database: D1Database,
  input: RedactPrivateDraftInput,
): Promise<{
  readonly status: ConditionalActionStatus;
  readonly draft: PrivateMissionDraft | null;
}> {
  const results = await database.batch<PrivateDraftRow>([
    database
      .prepare(
        `UPDATE private_mission_drafts
         SET sealed_payload = ?,
             payload_digest = ?,
             safety_status = 'redacted',
             updated_at = ?,
             redacted_at = ?
         WHERE draft_id = ?
           AND owner_id = ?
           AND redacted_at IS NULL`,
      )
      .bind(
        input.replacementSealedPayload,
        input.replacementPayloadDigest,
        input.redactedAt,
        input.redactedAt,
        input.draftId,
        input.ownerId,
      ),
    database
      .prepare(
        `SELECT ${DRAFT_COLUMNS}
         FROM private_mission_drafts
         WHERE draft_id = ? AND owner_id = ?
         LIMIT 1`,
      )
      .bind(input.draftId, input.ownerId),
  ]);
  const row = firstBatchRow(results, 1);
  const draft = row === undefined ? null : toPrivateDraft(row);
  return {
    status:
      batchResult(results, 0).meta.changes > 0
        ? "applied"
        : draft?.redactedAt === null || draft === null
          ? "invalid_or_expired"
          : "replay",
    draft,
  };
}

/** Records only an immutable marker and stable public identifiers. */
export async function recordEmergencyPublicRedaction(
  database: D1Database,
  input: EmergencyPublicRedactionInput,
): Promise<{
  readonly status: ConditionalActionStatus;
  readonly redaction: PublicRedactionRecord | null;
}> {
  const results = await database.batch<RedactionRow>([
    database
      .prepare(
        `INSERT INTO public_redactions (
          redaction_id, mission_id, event_id, proof_id,
          requested_by_owner_id, marker, reason, category,
          created_at, effective_at
        )
        SELECT ?, ?, ?, ?, owner_id, '[REDACTED]', ?, ?, ?, ?
        FROM owners
        WHERE owner_id = ?
        ON CONFLICT(redaction_id) DO NOTHING`,
      )
      .bind(
        input.redactionId,
        input.missionId,
        input.eventId,
        input.proofId,
        input.reason,
        input.category,
        input.createdAt,
        input.effectiveAt,
        input.requestedByOwnerId,
      ),
    database
      .prepare(
        `SELECT
           redaction_id, mission_id, event_id, proof_id,
           requested_by_owner_id, marker, reason, category,
           created_at, effective_at
         FROM public_redactions
         WHERE redaction_id = ?
           AND mission_id = ?
           AND event_id IS ?
           AND proof_id IS ?
           AND requested_by_owner_id = ?
           AND reason = ?
           AND category = ?
           AND created_at = ?
           AND effective_at = ?
         LIMIT 1`,
      )
      .bind(
        input.redactionId,
        input.missionId,
        input.eventId,
        input.proofId,
        input.requestedByOwnerId,
        input.reason,
        input.category,
        input.createdAt,
        input.effectiveAt,
      ),
  ]);
  const row = firstBatchRow(results, 1);
  const redaction = row === undefined ? null : toPublicRedaction(row);
  return {
    status:
      batchResult(results, 0).meta.changes > 0
        ? "applied"
        : redaction === null
          ? "invalid_or_expired"
          : "replay",
    redaction,
  };
}

function credentialPrincipalStatement(
  database: D1Database,
  credentialId: string,
  ownerId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `SELECT
         agent_credentials.credential_id,
         agents.owner_id,
         'github:' || owners.github_user_id AS public_owner_id,
         agent_credentials.agent_id,
         agent_credentials.key_id,
         agent_credentials.scope_json,
         agent_credentials.expires_at
       FROM agent_credentials
       INNER JOIN agents ON agents.agent_id = agent_credentials.agent_id
       INNER JOIN owners ON owners.owner_id = agents.owner_id
       INNER JOIN agent_keys
         ON agent_keys.key_id = agent_credentials.key_id
        AND agent_keys.agent_id = agent_credentials.agent_id
       WHERE agent_credentials.credential_id = ? AND agents.owner_id = ?
         AND agent_keys.status = 'active'
         AND agent_keys.revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(credentialId, ownerId);
}

function toAgent(row: AgentRow): AgentProfile {
  return {
    agentId: row.agent_id,
    ownerId: row.owner_id,
    slug: row.slug,
    characterName: row.character_name,
    characterClass: row.character_class,
    technicalName: row.technical_name,
    guildName: row.guild_name,
    publicBio: row.public_bio,
    transportStatus: row.transport_status,
    totalPoints: row.total_points,
    completedMissions: row.completed_missions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAgentKey(row: AgentKeyRow): AgentKeyRecord {
  return {
    keyId: row.key_id,
    agentId: row.agent_id,
    publicJwk: parseJson<JsonWebKey>(row.public_jwk_json, "public JWK"),
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    revokedAt: row.revoked_at,
  };
}

function toCredentialPrincipal(row: CredentialRow): CredentialPrincipal {
  return {
    credentialId: row.credential_id,
    ownerId: row.owner_id,
    publicOwnerId: row.public_owner_id as `github:${number}`,
    agentId: row.agent_id,
    keyId: row.key_id,
    scopes: parseJson<string[]>(row.scope_json, "credential scopes"),
    expiresAt: row.expires_at,
  };
}

function toAutonomyPolicy(row: AutonomyRow): AutonomyPolicy {
  return {
    agentId: row.agent_id,
    enabled: row.public_publication_enabled === 1,
    version: row.policy_version,
    consentedAt: row.consented_at,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at,
  };
}

function toPrivateDraft(row: PrivateDraftRow): PrivateMissionDraft {
  return {
    draftId: row.draft_id,
    ownerId: row.owner_id,
    requesterAgentId: row.requester_agent_id,
    sealedPayload: row.sealed_payload,
    safetyStatus: row.safety_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    redactedAt: row.redacted_at,
  };
}

function toPublicRedaction(row: RedactionRow): PublicRedactionRecord {
  return {
    redactionId: row.redaction_id,
    missionId: row.mission_id,
    eventId: row.event_id,
    proofId: row.proof_id,
    requestedByOwnerId: row.requested_by_owner_id,
    marker: row.marker,
    reason: row.reason,
    category: row.category,
    createdAt: row.created_at,
    effectiveAt: row.effective_at,
  };
}

function conditionalStatus<T>(
  results: readonly D1Result<T>[],
  updateIndex: number,
  readIndex: number,
  isReplay: (row: T) => boolean,
): ConditionalActionResult {
  if (batchResult(results, updateIndex).meta.changes > 0) {
    return { status: "applied" };
  }
  const row = firstBatchRow(results, readIndex);
  return row !== undefined && isReplay(row)
    ? { status: "replay" }
    : { status: "invalid_or_expired" };
}

function batchResult<T>(
  results: readonly D1Result<T>[],
  index: number,
): D1Result<T> {
  const result = results[index];
  if (result === undefined)
    throw new Error(`D1 batch result ${index} is missing`);
  return result;
}

function firstBatchRow<T>(
  results: readonly D1Result<T>[],
  index: number,
): T | undefined {
  return batchResult(results, index).results[0];
}

function requireBatchRow<T>(
  results: readonly D1Result<T>[],
  index: number,
  description: string,
): T {
  const row = firstBatchRow(results, index);
  if (row === undefined) throw new Error(`D1 did not return ${description}`);
  return row;
}

function serializeJson(value: unknown, description: string): string {
  let result: string | undefined;
  try {
    result = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${description} must be JSON serializable`, {
      cause: error,
    });
  }
  if (result === undefined) {
    throw new TypeError(`${description} must be JSON serializable`);
  }
  return result;
}

function parseJson<T>(value: string, description: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Stored ${description} is invalid JSON`, { cause: error });
  }
}
