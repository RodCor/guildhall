export type IssuerKeyStatus = "active" | "retired" | "revoked";

export interface IssuerKeyRecord {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicJwk: JsonWebKey;
  readonly status: IssuerKeyStatus;
  readonly createdAt: string;
  readonly retiredAt: string | null;
  readonly revokedAt: string | null;
}

interface IssuerKeyRow {
  readonly key_id: string;
  readonly algorithm: "Ed25519";
  readonly public_jwk_json: string;
  readonly status: IssuerKeyStatus;
  readonly created_at: string;
  readonly retired_at: string | null;
  readonly revoked_at: string | null;
}

const COLUMNS =
  "key_id, algorithm, public_jwk_json, status, created_at, retired_at, revoked_at";

export function issuerPublicJwk(jwk: JsonWebKey): JsonWebKey {
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
  ) {
    throw new TypeError("Issuer key must be Ed25519");
  }
  return {
    alg: "EdDSA",
    crv: "Ed25519",
    ext: true,
    key_ops: ["verify"],
    kty: "OKP",
    x: jwk.x,
  };
}

/** Persist the current public issuer key and retain every prior verification key. */
export async function ensureCurrentIssuerKey(
  database: D1Database,
  input: {
    readonly keyId: string;
    readonly publicJwk: JsonWebKey;
    readonly observedAt: string;
  },
): Promise<void> {
  const publicJwkJson = JSON.stringify(issuerPublicJwk(input.publicJwk));
  const existing = await database
    .prepare(
      "SELECT public_jwk_json, status FROM issuer_keys WHERE key_id = ? LIMIT 1",
    )
    .bind(input.keyId)
    .first<{ public_jwk_json: string; status: IssuerKeyStatus }>();
  if (existing !== null && existing.public_jwk_json !== publicJwkJson) {
    throw new Error("Issuer key ID is already bound to different key material");
  }
  if (existing?.status === "active") return;
  await database.batch([
    database
      .prepare(
        `UPDATE issuer_keys
         SET status = 'retired', retired_at = COALESCE(retired_at, ?)
         WHERE status = 'active' AND key_id <> ?`,
      )
      .bind(input.observedAt, input.keyId),
    database
      .prepare(
        `INSERT INTO issuer_keys(
           key_id, algorithm, public_jwk_json, status, created_at,
           retired_at, revoked_at
         ) VALUES (?, 'Ed25519', ?, 'active', ?, NULL, NULL)
         ON CONFLICT(key_id) DO UPDATE SET
           public_jwk_json = CASE
             WHEN issuer_keys.public_jwk_json = excluded.public_jwk_json
             THEN issuer_keys.public_jwk_json
             ELSE issuer_keys.public_jwk_json
           END,
           status = CASE
             WHEN issuer_keys.public_jwk_json = excluded.public_jwk_json
              AND issuer_keys.status <> 'revoked'
             THEN 'active'
             ELSE issuer_keys.status
           END,
           retired_at = CASE
             WHEN issuer_keys.public_jwk_json = excluded.public_jwk_json
              AND issuer_keys.status <> 'revoked'
             THEN NULL
             ELSE issuer_keys.retired_at
           END`,
      )
      .bind(input.keyId, publicJwkJson, input.observedAt),
  ]);
}

export async function listIssuerKeys(
  database: D1Database,
): Promise<readonly IssuerKeyRecord[]> {
  const rows = await database
    .prepare(
      `SELECT ${COLUMNS}
       FROM issuer_keys
       ORDER BY created_at DESC, key_id`,
    )
    .all<IssuerKeyRow>();
  return rows.results.map((row) => ({
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicJwk: JSON.parse(row.public_jwk_json) as JsonWebKey,
    status: row.status,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    revokedAt: row.revoked_at,
  }));
}
