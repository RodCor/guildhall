export const MISSION_COORDINATOR_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_state (
  mission_id TEXT PRIMARY KEY,
  requester_agent_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  display_state TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_definition (
  mission_id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS mission_definition_immutable_update
BEFORE UPDATE ON mission_definition
BEGIN
  SELECT RAISE(ABORT, 'mission definition is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mission_definition_immutable_delete
BEFORE DELETE ON mission_definition
BEGIN
  SELECT RAISE(ABORT, 'mission definition is immutable');
END;

CREATE TABLE IF NOT EXISTS mission_versions (
  mission_id TEXT NOT NULL,
  mission_version INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, mission_version, sequence)
);

CREATE TABLE IF NOT EXISTS applications (
  agent_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pact_versions (
  pact_version INTEGER PRIMARY KEY,
  pact_digest TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pact_acceptances (
  acceptance_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  pact_version INTEGER NOT NULL,
  pact_digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY (agent_id, pact_version)
);

CREATE TABLE IF NOT EXISTS role_slots (
  role_slot_id TEXT PRIMARY KEY,
  original_agent_id TEXT NOT NULL,
  occupant_agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_required INTEGER NOT NULL,
  artifact_delivered INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  role_slot_id TEXT NOT NULL,
  artifact_digest TEXT,
  sequence INTEGER NOT NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_runs (
  verification_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  result_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  emitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_redactions (
  redaction_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  marker_json TEXT NOT NULL,
  redacted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_results (
  command_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  resulting_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS effect_outbox_due
  ON effect_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS projection_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projection_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS projection_outbox_due
  ON projection_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS deadlines (
  deadline_type TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  handled_at TEXT
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;
