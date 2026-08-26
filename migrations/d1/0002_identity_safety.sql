-- Identity lifecycle, private safety staging, and marker-only redaction audit.
-- This forward migration intentionally preserves all tables created by 0001.

PRAGMA foreign_keys = ON;

ALTER TABLE pairing_codes ADD COLUMN consumed_key_id TEXT;
ALTER TABLE pairing_codes ADD COLUMN consumed_credential_id TEXT;
ALTER TABLE pairing_codes ADD COLUMN possession_proof_digest TEXT;
ALTER TABLE pairing_codes ADD COLUMN possession_signature TEXT;
ALTER TABLE pairing_codes ADD COLUMN finalized_at TEXT;
ALTER TABLE agent_credentials ADD COLUMN key_id TEXT REFERENCES agent_keys(key_id);

CREATE INDEX agent_credentials_key_idx
  ON agent_credentials (key_id, revoked_at, expires_at);

CREATE TRIGGER agent_credentials_require_key
BEFORE INSERT ON agent_credentials
WHEN NEW.key_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'agent credential requires a proof key');
END;

CREATE TABLE agent_request_nonces (
  credential_id TEXT NOT NULL
    REFERENCES agent_credentials(credential_id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, nonce_hash)
) STRICT;

CREATE INDEX agent_request_nonces_consumed_idx
  ON agent_request_nonces (consumed_at);

CREATE UNIQUE INDEX pairing_codes_consumed_key_idx
  ON pairing_codes (consumed_key_id)
  WHERE consumed_key_id IS NOT NULL;

CREATE TABLE autonomy_policy_history (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  public_publication_enabled INTEGER NOT NULL
    CHECK (public_publication_enabled IN (0, 1)),
  consented_at TEXT,
  revoked_at TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, policy_version)
) STRICT;

CREATE TABLE private_mission_drafts (
  draft_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
  requester_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  sealed_payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  safety_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (safety_status IN ('pending', 'safe', 'unsafe', 'redacted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  redacted_at TEXT,
  CHECK (
    (safety_status = 'redacted' AND redacted_at IS NOT NULL)
    OR safety_status <> 'redacted'
  )
) STRICT;

CREATE INDEX private_mission_drafts_owner_idx
  ON private_mission_drafts (owner_id, updated_at DESC, draft_id);

CREATE TABLE draft_safety_results (
  safety_result_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES private_mission_drafts(draft_id) ON DELETE CASCADE,
  scanner_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('safe', 'unsafe')),
  categories_json TEXT NOT NULL CHECK (json_valid(categories_json)),
  rule_ids_json TEXT NOT NULL CHECK (json_valid(rule_ids_json)),
  result_digest TEXT NOT NULL,
  scanned_at TEXT NOT NULL
) STRICT;

CREATE INDEX draft_safety_results_draft_idx
  ON draft_safety_results (draft_id, scanned_at DESC, safety_result_id);

CREATE TABLE public_redactions (
  redaction_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  event_id TEXT,
  proof_id TEXT,
  requested_by_owner_id TEXT NOT NULL REFERENCES owners(owner_id),
  marker TEXT NOT NULL DEFAULT '[REDACTED]' CHECK (marker = '[REDACTED]'),
  reason TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN ('credentials', 'pii', 'sensitive', 'unsafe', 'other')),
  created_at TEXT NOT NULL,
  effective_at TEXT NOT NULL
) STRICT;

CREATE INDEX public_redactions_mission_idx
  ON public_redactions (mission_id, effective_at DESC, redaction_id);
CREATE INDEX public_redactions_event_idx
  ON public_redactions (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX public_redactions_proof_idx
  ON public_redactions (proof_id) WHERE proof_id IS NOT NULL;
