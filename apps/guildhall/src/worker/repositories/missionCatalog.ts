/**
 * D1 is a public, recoverable projection. This repository deliberately exposes
 * no mission transition operations: a MissionCoordinator Durable Object owns
 * all canonical mission decisions.
 */

export interface MissionCatalogProjection {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly requesterAgentId: string;
  readonly lifecycleState: string;
  readonly displayState: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly difficulty?: "novice" | "adept" | "expert" | null;
  readonly pointReward?: number | null;
  readonly minimumPartySize?: number | null;
  readonly preferredPartySize?: number | null;
  readonly maximumPartySize?: number | null;
  readonly requiredCapabilities?: readonly string[];
  readonly participantAgentIds?: readonly string[];
  readonly formationDeadline?: string | null;
  readonly deliveryDeadline?: string | null;
  readonly publishedAt?: string | null;
  readonly terminalAt?: string | null;
  readonly pactDigest?: string | null;
  readonly projection: unknown;
  readonly lastSequence: number;
  readonly projectedAt: string;
}

export interface MissionCatalogRow {
  readonly mission_id: string;
  readonly mission_version: number;
  readonly requester_agent_id: string;
  readonly lifecycle_state: string;
  readonly display_state: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly difficulty: "novice" | "adept" | "expert" | null;
  readonly point_reward: number | null;
  readonly minimum_party_size: number | null;
  readonly preferred_party_size: number | null;
  readonly maximum_party_size: number | null;
  readonly required_capabilities_json: string;
  readonly participant_agent_ids_json: string;
  readonly formation_deadline: string | null;
  readonly delivery_deadline: string | null;
  readonly published_at: string | null;
  readonly terminal_at: string | null;
  readonly pact_digest: string | null;
  readonly projection_json: string;
  readonly last_sequence: number;
  readonly projected_at: string;
}

export interface MissionCatalogProjectionWrite {
  /** True only when this write inserted a row or advanced its sequence. */
  readonly applied: boolean;
  readonly incomingSequence: number;
  /** Sequence visible after the attempted write. */
  readonly currentSequence: number;
}

const UPSERT_MISSION_CATALOG = `
  INSERT INTO mission_catalog (
    mission_id,
    mission_version,
    requester_agent_id,
    lifecycle_state,
    display_state,
    title,
    summary,
    difficulty,
    point_reward,
    minimum_party_size,
    preferred_party_size,
    maximum_party_size,
    required_capabilities_json,
    participant_agent_ids_json,
    formation_deadline,
    delivery_deadline,
    published_at,
    terminal_at,
    pact_digest,
    projection_json,
    last_sequence,
    projected_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT(mission_id) DO UPDATE SET
    mission_version = excluded.mission_version,
    requester_agent_id = excluded.requester_agent_id,
    lifecycle_state = excluded.lifecycle_state,
    display_state = excluded.display_state,
    title = excluded.title,
    summary = excluded.summary,
    difficulty = excluded.difficulty,
    point_reward = excluded.point_reward,
    minimum_party_size = excluded.minimum_party_size,
    preferred_party_size = excluded.preferred_party_size,
    maximum_party_size = excluded.maximum_party_size,
    required_capabilities_json = excluded.required_capabilities_json,
    participant_agent_ids_json = excluded.participant_agent_ids_json,
    formation_deadline = excluded.formation_deadline,
    delivery_deadline = excluded.delivery_deadline,
    published_at = excluded.published_at,
    terminal_at = excluded.terminal_at,
    pact_digest = excluded.pact_digest,
    projection_json = excluded.projection_json,
    last_sequence = excluded.last_sequence,
    projected_at = excluded.projected_at
  WHERE excluded.last_sequence > mission_catalog.last_sequence
`;

/**
 * Inserts or advances one public mission projection.
 *
 * Equal and older sequences are deliberate no-ops, including when their
 * payload differs. This makes delayed/out-of-order outbox delivery safe.
 */
export async function projectMissionCatalog(
  database: D1Database,
  projection: MissionCatalogProjection,
): Promise<MissionCatalogProjectionWrite> {
  assertProjection(projection);
  const projectionJson = serializeJson(projection.projection, "projection");

  const result = await database
    .prepare(UPSERT_MISSION_CATALOG)
    .bind(
      projection.missionId,
      projection.missionVersion,
      projection.requesterAgentId,
      projection.lifecycleState,
      projection.displayState,
      projection.title ?? null,
      projection.summary ?? null,
      projection.difficulty ?? null,
      projection.pointReward ?? null,
      projection.minimumPartySize ?? null,
      projection.preferredPartySize ?? null,
      projection.maximumPartySize ?? null,
      JSON.stringify(projection.requiredCapabilities ?? []),
      JSON.stringify(projection.participantAgentIds ?? []),
      projection.formationDeadline ?? null,
      projection.deliveryDeadline ?? null,
      projection.publishedAt ?? null,
      projection.terminalAt ?? null,
      projection.pactDigest ?? null,
      projectionJson,
      projection.lastSequence,
      projection.projectedAt,
    )
    .run();

  const applied = result.meta.changes > 0;
  const currentSequence = applied
    ? projection.lastSequence
    : await readMissionCatalogSequence(database, projection.missionId);

  return {
    applied,
    incomingSequence: projection.lastSequence,
    currentSequence,
  };
}

export async function readMissionCatalogRow(
  database: D1Database,
  missionId: string,
): Promise<MissionCatalogRow | null> {
  return database
    .prepare("SELECT * FROM mission_catalog WHERE mission_id = ? LIMIT 1")
    .bind(missionId)
    .first<MissionCatalogRow>();
}

export async function readMissionCatalogSequence(
  database: D1Database,
  missionId: string,
): Promise<number> {
  const row = await database
    .prepare(
      "SELECT last_sequence FROM mission_catalog WHERE mission_id = ? LIMIT 1",
    )
    .bind(missionId)
    .first<{ last_sequence: number }>();

  if (row === null) {
    throw new Error(
      `Mission catalog projection ${missionId} disappeared during an upsert`,
    );
  }
  return row.last_sequence;
}

/** Marks a trusted guided-demo projection without deleting its public record. */
export async function markReferenceMission(
  database: D1Database,
  missionId: string,
): Promise<boolean> {
  const result = await database
    .prepare(
      "UPDATE mission_catalog SET catalog_kind = 'reference' WHERE mission_id = ?",
    )
    .bind(missionId)
    .run();
  return result.meta.changes > 0;
}

function assertProjection(projection: MissionCatalogProjection): void {
  if (
    !Number.isSafeInteger(projection.lastSequence) ||
    projection.lastSequence < 0
  ) {
    throw new RangeError("lastSequence must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(projection.missionVersion) ||
    projection.missionVersion < 1
  ) {
    throw new RangeError("missionVersion must be a positive safe integer");
  }

  const partySizes = [
    projection.minimumPartySize,
    projection.preferredPartySize,
    projection.maximumPartySize,
  ].filter((size): size is number => size !== undefined && size !== null);
  if (
    partySizes.some(
      (size) => !Number.isSafeInteger(size) || size < 1 || size > 2,
    )
  ) {
    throw new RangeError("party sizes must be safe integers between 1 and 2");
  }
}

function serializeJson(value: unknown, field: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${field} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError(`${field} must be JSON serializable`);
  }
  return serialized;
}
