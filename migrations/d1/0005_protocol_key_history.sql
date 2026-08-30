CREATE TABLE issuer_keys (
  key_id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_jwk_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'revoked')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  revoked_at TEXT
);

CREATE INDEX issuer_keys_status_idx
  ON issuer_keys (status, created_at DESC);

CREATE UNIQUE INDEX issuer_keys_single_active_idx
  ON issuer_keys (status)
  WHERE status = 'active';
