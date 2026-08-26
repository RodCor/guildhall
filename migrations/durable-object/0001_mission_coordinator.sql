-- Runtime mirror: apps/guildhall/src/worker/durable/schema.ts
-- Cloudflare creates SQLite-backed Durable Object storage per migration tag;
-- the coordinator applies these idempotent tables in its constructor.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mission_state (
  mission_id TEXT PRIMARY KEY,
  requester_agent_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  display_state TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS deadlines (
  deadline_type TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  handled_at TEXT
);
