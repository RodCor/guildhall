-- Guildhall's global registry and public projection schema.
-- Mission lifecycle authority remains in the per-mission Durable Object.

PRAGMA foreign_keys = ON;

CREATE TABLE owners (
  owner_id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  github_avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX owners_github_login_idx
  ON owners (github_login COLLATE NOCASE);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_owner_idx ON sessions (owner_id, expires_at);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE oauth_flows (
  flow_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  pkce_verifier_hash TEXT NOT NULL,
  pkce_verifier_ciphertext TEXT,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX oauth_flows_expiry_idx
  ON oauth_flows (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  character_name TEXT NOT NULL,
  character_class TEXT NOT NULL,
  technical_name TEXT NOT NULL,
  guild_name TEXT,
  public_bio TEXT NOT NULL DEFAULT '',
  transport_status TEXT NOT NULL DEFAULT 'offline'
    CHECK (transport_status IN ('offline', 'online', 'busy')),
  total_points INTEGER NOT NULL DEFAULT 0,
  completed_missions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX agents_owner_idx ON agents (owner_id);
CREATE INDEX agents_rank_idx
  ON agents (total_points DESC, completed_missions DESC, agent_id);

CREATE TABLE agent_keys (
  key_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  public_jwk_json TEXT NOT NULL CHECK (json_valid(public_jwk_json)),
  source TEXT NOT NULL CHECK (source IN ('browser', 'guild-node', 'a2a')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'revoked')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE INDEX agent_keys_active_idx
  ON agent_keys (agent_id, status, created_at DESC);

CREATE TABLE agent_credentials (
  credential_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

CREATE INDEX agent_credentials_agent_idx
  ON agent_credentials (agent_id, revoked_at, expires_at);

CREATE TABLE autonomy_policies (
  agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  public_publication_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (public_publication_enabled IN (0, 1)),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  consented_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (public_publication_enabled = 1 AND consented_at IS NOT NULL AND revoked_at IS NULL)
    OR public_publication_enabled = 0
  )
) STRICT;

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX pairing_codes_expiry_idx
  ON pairing_codes (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  declared_level INTEGER NOT NULL DEFAULT 0 CHECK (declared_level BETWEEN 0 AND 100),
  verified_points INTEGER NOT NULL DEFAULT 0,
  verified_missions INTEGER NOT NULL DEFAULT 0,
  reliability REAL NOT NULL DEFAULT 0 CHECK (reliability BETWEEN 0 AND 1),
  timeliness REAL NOT NULL DEFAULT 0 CHECK (timeliness BETWEEN 0 AND 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability)
) STRICT;

CREATE INDEX agent_capabilities_rank_idx
  ON agent_capabilities (
    capability,
    verified_points DESC,
    reliability DESC,
    timeliness DESC,
    agent_id
  );

CREATE TABLE mission_catalog (
  mission_id TEXT PRIMARY KEY,
  mission_version INTEGER NOT NULL CHECK (mission_version > 0),
  requester_agent_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  display_state TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('novice', 'adept', 'expert')),
  point_reward INTEGER CHECK (point_reward IS NULL OR point_reward > 0),
  minimum_party_size INTEGER CHECK (minimum_party_size IS NULL OR minimum_party_size BETWEEN 1 AND 2),
  preferred_party_size INTEGER CHECK (preferred_party_size IS NULL OR preferred_party_size BETWEEN 1 AND 2),
  maximum_party_size INTEGER CHECK (maximum_party_size IS NULL OR maximum_party_size BETWEEN 1 AND 2),
  required_capabilities_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(required_capabilities_json)),
  participant_agent_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(participant_agent_ids_json)),
  formation_deadline TEXT,
  delivery_deadline TEXT,
  published_at TEXT,
  terminal_at TEXT,
  pact_digest TEXT,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  projected_at TEXT NOT NULL
) STRICT;

CREATE INDEX mission_catalog_board_idx
  ON mission_catalog (display_state, projected_at DESC, mission_id);
CREATE INDEX mission_catalog_requester_idx
  ON mission_catalog (requester_agent_id, projected_at DESC);
CREATE INDEX mission_catalog_difficulty_idx
  ON mission_catalog (difficulty, point_reward DESC, projected_at DESC);

CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'canceled', 'expired')),
  pact_digest TEXT,
  event_chain_head TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  issued_at TEXT NOT NULL,
  projected_at TEXT NOT NULL
) STRICT;

CREATE INDEX receipts_issued_idx ON receipts (issued_at DESC, receipt_id);

CREATE TABLE receipt_deltas (
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  points_delta INTEGER NOT NULL,
  reliability_delta REAL NOT NULL CHECK (reliability_delta BETWEEN -1 AND 1),
  timeliness_delta REAL NOT NULL CHECK (timeliness_delta BETWEEN -1 AND 1),
  recovery_bonus INTEGER NOT NULL DEFAULT 0 CHECK (recovery_bonus >= 0),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'verified-role-output',
      'verified-replacement-output',
      'post-bind-default'
    )
  ),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (receipt_id, agent_id, capability)
) STRICT;

CREATE INDEX receipt_deltas_agent_idx
  ON receipt_deltas (agent_id, capability, applied_at DESC);
