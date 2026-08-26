/**
 * D1 persistence for GitHub identity, OAuth challenges, and Guild sessions.
 *
 * Callers generate and hash secrets before invoking this module. Provider
 * access tokens are intentionally absent from every repository contract.
 */

export interface GithubOwnerProfile {
  readonly ownerId: string;
  readonly githubUserId: number;
  readonly githubLogin: string;
  readonly githubAvatarUrl: string | null;
}

export interface SessionPrincipal extends GithubOwnerProfile {
  readonly sessionExpiresAt: string;
}

export type ConditionalActionStatus =
  "applied" | "replay" | "invalid_or_expired";

export interface ConditionalActionResult {
  readonly status: ConditionalActionStatus;
}

export interface CreateOAuthFlowInput {
  readonly flowId: string;
  readonly stateHash: string;
  readonly pkceVerifierHash: string;
  /** Sealed with an application key; never selected by this repository. */
  readonly pkceVerifierCiphertext: string;
  readonly exactRedirectUri: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface ConsumeOAuthFlowInput {
  readonly flowId: string;
  readonly stateHash: string;
  readonly pkceVerifierHash: string;
  readonly exactRedirectUri: string;
  readonly now: string;
  readonly consumedAt: string;
}

/** Internal callback material. Never serialize this into an HTTP response. */
export interface PendingOAuthFlowSecret {
  readonly flowId: string;
  readonly pkceVerifierCiphertext: string;
  readonly stateHash: string;
  readonly pkceVerifierHash: string;
  readonly exactRedirectUri: string;
  readonly expiresAt: string;
}

export interface GithubSessionInput {
  readonly proposedOwnerId: string;
  readonly githubUserId: number;
  readonly githubLogin: string;
  readonly githubAvatarUrl: string | null;
  readonly sessionHash: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface SessionPrincipalRow {
  readonly owner_id: string;
  readonly github_user_id: number;
  readonly github_login: string;
  readonly github_avatar_url: string | null;
  readonly session_expires_at: string;
}

interface OAuthFlowStatusRow {
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

interface SessionRevocationStatusRow {
  readonly revoked_at: string | null;
}

const SESSION_PRINCIPAL_COLUMNS = `
  SELECT
    owners.owner_id,
    owners.github_user_id,
    owners.github_login,
    owners.github_avatar_url,
    sessions.expires_at AS session_expires_at
  FROM sessions
  INNER JOIN owners ON owners.owner_id = sessions.owner_id
`;

export async function createOAuthFlow(
  database: D1Database,
  input: CreateOAuthFlowInput,
): Promise<{ readonly flowId: string; readonly expiresAt: string }> {
  await database
    .prepare(
      `INSERT INTO oauth_flows (
        flow_id,
        state_hash,
        pkce_verifier_hash,
        pkce_verifier_ciphertext,
        redirect_uri,
        expires_at,
        consumed_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      input.flowId,
      input.stateHash,
      input.pkceVerifierHash,
      input.pkceVerifierCiphertext,
      input.exactRedirectUri,
      input.expiresAt,
      input.createdAt,
    )
    .run();

  return { flowId: input.flowId, expiresAt: input.expiresAt };
}

/**
 * Narrow internal read for the OAuth callback. This is the only repository
 * method that reveals sealed verifier material; callers must not log it.
 */
export async function getPendingOAuthFlow(
  database: D1Database,
  flowId: string,
  now: string,
): Promise<PendingOAuthFlowSecret | null> {
  const row = await database
    .prepare(
      `SELECT
         pkce_verifier_ciphertext,
         state_hash,
         pkce_verifier_hash,
         redirect_uri,
         expires_at
       FROM oauth_flows
       WHERE flow_id = ?
         AND consumed_at IS NULL
         AND pkce_verifier_ciphertext IS NOT NULL
         AND expires_at > ?
       LIMIT 1`,
    )
    .bind(flowId, now)
    .first<{
      pkce_verifier_ciphertext: string;
      state_hash: string;
      pkce_verifier_hash: string;
      redirect_uri: string;
      expires_at: string;
    }>();

  return row === null
    ? null
    : {
        flowId,
        pkceVerifierCiphertext: row.pkce_verifier_ciphertext,
        stateHash: row.state_hash,
        pkceVerifierHash: row.pkce_verifier_hash,
        exactRedirectUri: row.redirect_uri,
        expiresAt: row.expires_at,
      };
}

/**
 * Atomically validates and consumes a flow. The encrypted verifier is cleared,
 * not returned; the caller must hold its verifier in the signed flow cookie.
 */
export async function consumeOAuthFlow(
  database: D1Database,
  input: ConsumeOAuthFlowInput,
): Promise<ConditionalActionResult> {
  const results = await database.batch<OAuthFlowStatusRow>([
    database
      .prepare(
        `UPDATE oauth_flows
         SET consumed_at = ?, pkce_verifier_ciphertext = NULL
         WHERE flow_id = ?
           AND state_hash = ?
           AND pkce_verifier_hash = ?
           AND redirect_uri = ?
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .bind(
        input.consumedAt,
        input.flowId,
        input.stateHash,
        input.pkceVerifierHash,
        input.exactRedirectUri,
        input.now,
      ),
    database
      .prepare(
        `SELECT expires_at, consumed_at
         FROM oauth_flows
         WHERE flow_id = ?
           AND state_hash = ?
           AND pkce_verifier_hash = ?
           AND redirect_uri = ?
         LIMIT 1`,
      )
      .bind(
        input.flowId,
        input.stateHash,
        input.pkceVerifierHash,
        input.exactRedirectUri,
      ),
  ]);

  if (batchResult(results, 0).meta.changes > 0) return { status: "applied" };
  const row = firstBatchRow(results, 1);
  if (row?.consumed_at !== null && row?.consumed_at !== undefined) {
    return { status: "replay" };
  }
  return { status: "invalid_or_expired" };
}

/**
 * Persists only GitHub's numeric ID/login/avatar and only session/CSRF hashes.
 * The owner upsert and session creation commit in one D1 transaction batch.
 */
export async function upsertGithubOwnerAndSession(
  database: D1Database,
  input: GithubSessionInput,
): Promise<SessionPrincipal> {
  const results = await database.batch<SessionPrincipalRow>([
    database
      .prepare(
        `INSERT INTO owners (
          owner_id,
          github_user_id,
          github_login,
          github_avatar_url,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(github_user_id) DO UPDATE SET
          github_login = excluded.github_login,
          github_avatar_url = excluded.github_avatar_url,
          updated_at = excluded.updated_at`,
      )
      .bind(
        input.proposedOwnerId,
        input.githubUserId,
        input.githubLogin,
        input.githubAvatarUrl,
        input.createdAt,
        input.createdAt,
      ),
    database
      .prepare(
        `INSERT INTO sessions (
          session_hash,
          owner_id,
          csrf_hash,
          expires_at,
          revoked_at,
          created_at
        )
        SELECT ?, owner_id, ?, ?, NULL, ?
        FROM owners
        WHERE github_user_id = ?`,
      )
      .bind(
        input.sessionHash,
        input.csrfHash,
        input.expiresAt,
        input.createdAt,
        input.githubUserId,
      ),
    database
      .prepare(
        `${SESSION_PRINCIPAL_COLUMNS}
         WHERE sessions.session_hash = ?
         LIMIT 1`,
      )
      .bind(input.sessionHash),
  ]);

  const row = requireBatchRow(results, 2, "session principal");
  return toSessionPrincipal(row);
}

export async function authenticateSession(
  database: D1Database,
  sessionHash: string,
  now: string,
): Promise<SessionPrincipal | null> {
  const row = await database
    .prepare(
      `${SESSION_PRINCIPAL_COLUMNS}
       WHERE sessions.session_hash = ?
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
       LIMIT 1`,
    )
    .bind(sessionHash, now)
    .first<SessionPrincipalRow>();
  return row === null ? null : toSessionPrincipal(row);
}

export async function authorizeSessionMutation(
  database: D1Database,
  sessionHash: string,
  csrfHash: string,
  now: string,
): Promise<SessionPrincipal | null> {
  const row = await database
    .prepare(
      `${SESSION_PRINCIPAL_COLUMNS}
       WHERE sessions.session_hash = ?
         AND sessions.csrf_hash = ?
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
       LIMIT 1`,
    )
    .bind(sessionHash, csrfHash, now)
    .first<SessionPrincipalRow>();
  return row === null ? null : toSessionPrincipal(row);
}

export async function revokeSession(
  database: D1Database,
  sessionHash: string,
  revokedAt: string,
): Promise<ConditionalActionResult> {
  const results = await database.batch<SessionRevocationStatusRow>([
    database
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE session_hash = ? AND revoked_at IS NULL`,
      )
      .bind(revokedAt, sessionHash),
    database
      .prepare(
        `SELECT revoked_at
         FROM sessions
         WHERE session_hash = ?
         LIMIT 1`,
      )
      .bind(sessionHash),
  ]);

  if (batchResult(results, 0).meta.changes > 0) return { status: "applied" };
  const row = firstBatchRow(results, 1);
  return row?.revoked_at === null || row === undefined
    ? { status: "invalid_or_expired" }
    : { status: "replay" };
}

function toSessionPrincipal(row: SessionPrincipalRow): SessionPrincipal {
  return {
    ownerId: row.owner_id,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    githubAvatarUrl: row.github_avatar_url,
    sessionExpiresAt: row.session_expires_at,
  };
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
