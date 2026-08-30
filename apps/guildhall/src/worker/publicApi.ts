import { ReceiptSchema } from "@guildhall/contracts";
import {
  ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST,
  ACCESSIBILITY_DUNGEON_FIXTURE_HTML,
} from "@guildhall/trust-engine";

import { authorizeAgentAction } from "./auth/agentAuthorization.js";
import {
  sha256Base64Url,
  signCompactValue,
  verifyCompactValue,
} from "./auth/crypto.js";
import { noStoreJson } from "./auth/httpSecurity.js";
import {
  ensureCurrentIssuerKey,
  issuerPublicJwk,
  listAgentKeys,
  listIssuerKeys,
} from "./repositories/index.js";
import type { GuildhallEnv } from "./types.js";

const DEFAULT_LIMIT = 20;
const MAXIMUM_LIMIT = 50;
const CURSOR_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const DISPLAY_STATES = new Set([
  "Draft",
  "Recruiting",
  "Negotiating",
  "Bound",
  "Executing",
  "Overdue",
  "Replacement needed",
  "Verifying",
  "Verification pending",
  "Correction available",
  "Paused for safety",
  "Safety rejected",
  "Completed",
  "Failed",
  "Canceled",
  "Expired",
]);
const DIFFICULTIES = new Set(["novice", "adept", "expert"]);
const REFERENCE_AGENT_IDS = new Set([
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
]);

const PUBLIC_AGENT_ROUTE = /^\/api\/agents\/([^/]+)$/u;
const PUBLIC_AGENT_KEYS_ROUTE = /^\/api\/agents\/([^/]+)\/keys$/u;
const AGENT_INBOX_ROUTE = /^\/api\/agents\/([^/]+)\/inbox$/u;
const RECEIPT_ROUTE = /^\/api\/missions\/([^/]+)\/receipt$/u;

interface PublicCapabilityRow {
  readonly agent_id: string;
  readonly capability: string;
  readonly declared_level: number;
  readonly verified_points: number;
  readonly verified_missions: number;
  readonly reliability: number;
  readonly timeliness: number;
}

interface PublicAgentRow {
  readonly agent_id: string;
  readonly character_name: string;
  readonly character_class: string;
  readonly technical_name: string;
  readonly guild_name: string | null;
  readonly public_bio: string;
  readonly transport_status: "offline" | "online" | "busy";
  readonly total_points: number;
  readonly completed_missions: number;
}

interface MissionCardRow {
  readonly mission_id: string;
  readonly mission_version: number;
  readonly requester_agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly required_capabilities_json: string;
  readonly minimum_party_size: number;
  readonly preferred_party_size: number;
  readonly maximum_party_size: number;
  readonly formation_deadline: string;
  readonly delivery_deadline: string;
  readonly difficulty: "novice" | "adept" | "expert";
  readonly point_reward: number;
  readonly display_state: string;
  readonly projection_json: string;
  readonly last_sequence: number;
  readonly projected_at: string;
  readonly catalog_kind: "community" | "reference";
}

interface AgentCursor {
  readonly points: number;
  readonly completed: number;
  readonly id: string;
}

interface MissionCursor {
  readonly projectedAt: string;
  readonly id: string;
}

interface MissionFilters {
  readonly capability: string | null;
  readonly displayState: string | null;
  readonly difficulty: string | null;
  readonly catalogKind: "community" | "reference" | "all";
}

interface Page<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

/** Handle only bounded public projections and the signed node inbox. */
export async function handlePublicApiRoute(
  request: Request,
  env: GuildhallEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);

  if (url.pathname === "/protocol/commitment/v1") {
    return noStoreJson({
      protocol: "commitment/v1",
      extensionUri:
        "https://guildhall.kimetsu-dev.workers.dev/protocol/commitment/v1",
      canonicalization: "RFC 8785 JCS",
      digest: "SHA-256 base64url without padding",
      signatureAlgorithm: "Ed25519",
      commandSigningDomain: "PACTBRIDGE-COMMAND-V1",
      artifactSigningDomain: "PACTBRIDGE-ARTIFACT-V1",
      receiptSigningDomain: "PACTBRIDGE-RECEIPT-V1",
      issuerKeySet: "/.well-known/guildhall-issuer-keys.json",
      agentKeySetTemplate: "/api/agents/{agentId}/keys",
      revocationSemantics:
        "A new proof is accepted only from a key observed active at keyStatusCheckedAt. proofVerifiedAt records cryptographic verification completion; later revocation does not invalidate an already accepted event.",
    });
  }

  if (url.pathname === "/fixtures/accessibility-dungeon-v1") {
    return new Response(ACCESSIBILITY_DUNGEON_FIXTURE_HTML, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Guildhall-Content-Digest": ACCESSIBILITY_DUNGEON_FIXTURE_DIGEST,
      },
    });
  }

  if (url.pathname === "/.well-known/guildhall-issuer-key.json") {
    return readIssuerKey(env);
  }
  if (url.pathname === "/.well-known/guildhall-issuer-keys.json") {
    return readIssuerKeyHistory(env);
  }

  if (url.pathname === "/api/agents") {
    return listAgents(url, env);
  }
  if (url.pathname === "/api/leaderboard") {
    return listLeaderboard(url, env);
  }
  if (url.pathname === "/api/missions") {
    return listMissions(url, env);
  }

  const inboxMatch = AGENT_INBOX_ROUTE.exec(url.pathname);
  if (inboxMatch !== null) {
    const agentId = decodeURIComponent(inboxMatch[1]!);
    return UUID_PATTERN.test(agentId)
      ? readAgentInbox(request, url, env, agentId)
      : noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }

  const receiptMatch = RECEIPT_ROUTE.exec(url.pathname);
  if (receiptMatch !== null) {
    const missionId = decodeURIComponent(receiptMatch[1]!);
    return UUID_PATTERN.test(missionId)
      ? readReceipt(env.GUILD_DB, missionId)
      : noStoreJson({ error: "MISSION_NOT_FOUND" }, { status: 404 });
  }

  const agentKeysMatch = PUBLIC_AGENT_KEYS_ROUTE.exec(url.pathname);
  if (agentKeysMatch !== null) {
    const agentId = decodeURIComponent(agentKeysMatch[1]!);
    return UUID_PATTERN.test(agentId)
      ? readAgentKeyHistory(env.GUILD_DB, agentId)
      : noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }

  const agentMatch = PUBLIC_AGENT_ROUTE.exec(url.pathname);
  if (agentMatch !== null) {
    const agentId = decodeURIComponent(agentMatch[1]!);
    return UUID_PATTERN.test(agentId)
      ? readAgentProfile(env.GUILD_DB, agentId)
      : noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }

  return null;
}

async function readAgentKeyHistory(
  database: D1Database,
  agentId: string,
): Promise<Response> {
  const keys = await listAgentKeys(database, agentId);
  if (keys.length === 0) {
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }
  return noStoreJson({
    protocol: "commitment/v1",
    agentId,
    algorithm: "Ed25519",
    commandSigningDomain: "PACTBRIDGE-COMMAND-V1",
    artifactSigningDomain: "PACTBRIDGE-ARTIFACT-V1",
    keys: keys.map((key) => ({
      keyId: key.keyId,
      publicJwk: key.publicJwk,
      source: key.source,
      status: key.status,
      createdAt: key.createdAt,
      retiredAt: key.retiredAt,
      revokedAt: key.revokedAt,
    })),
  });
}

async function listAgents(url: URL, env: GuildhallEnv): Promise<Response> {
  try {
    const limit = queryLimit(url);
    const cursorValue = singleQueryValue(url, "cursor");
    const cursor =
      cursorValue === null
        ? null
        : await decodeAgentCursor(cursorValue, env.AUTH_COOKIE_SECRET);
    const page = await queryPublicAgents(env.GUILD_DB, cursor, limit);
    const last = page.items.at(-1);
    const nextCursor =
      page.hasMore && last !== undefined
        ? await encodeAgentCursor(last, env.AUTH_COOKIE_SECRET)
        : null;
    return noStoreJson({ agents: page.items, nextCursor });
  } catch (error) {
    return invalidQuery(error);
  }
}

async function listLeaderboard(url: URL, env: GuildhallEnv): Promise<Response> {
  try {
    const limit = queryLimit(url);
    const capability = singleQueryValue(url, "capability");
    if (capability !== null && !CAPABILITY_PATTERN.test(capability)) {
      throw new TypeError("Invalid capability filter");
    }
    const agents =
      capability === null
        ? (await queryPublicAgents(env.GUILD_DB, null, limit)).items
        : await queryCapabilityLeaders(env.GUILD_DB, capability, limit);
    return noStoreJson({
      capability,
      rankings: agents.map((profile, index) => {
        const metric =
          capability === null
            ? null
            : (profile.capabilities.find(
                (entry) => entry.capability === capability,
              ) ?? null);
        return {
          rank: index + 1,
          profile,
          verifiedPoints: metric?.verifiedPoints ?? profile.totalPoints,
          verifiedMissions:
            metric?.verifiedMissions ?? profile.completedMissions,
          reliability: metric?.reliability ?? null,
          timeliness: metric?.timeliness ?? null,
        };
      }),
    });
  } catch (error) {
    return invalidQuery(error);
  }
}

async function readAgentProfile(
  database: D1Database,
  agentId: string,
): Promise<Response> {
  const row = await database
    .prepare(`${PUBLIC_AGENT_SELECT} WHERE agents.agent_id = ? LIMIT 1`)
    .bind(agentId)
    .first<PublicAgentRow>();
  if (row === null) {
    return noStoreJson({ error: "AGENT_NOT_FOUND" }, { status: 404 });
  }
  const capabilities = await queryCapabilities(database, [agentId]);
  return noStoreJson({
    profile: toPublicAgent(row, capabilities.get(agentId) ?? []),
  });
}

async function listMissions(url: URL, env: GuildhallEnv): Promise<Response> {
  try {
    const limit = queryLimit(url);
    const filters = missionFilters(url);
    const filterHash = await sha256Base64Url(JSON.stringify(filters));
    const cursorValue = singleQueryValue(url, "cursor");
    const cursor =
      cursorValue === null
        ? null
        : await decodeMissionCursor(
            cursorValue,
            "mission-list",
            filterHash,
            env.AUTH_COOKIE_SECRET,
          );
    const page = await queryMissionCards(
      env.GUILD_DB,
      filters,
      cursor,
      limit,
      "descending",
    );
    const last = page.items.at(-1);
    const nextCursor =
      page.hasMore && last !== undefined
        ? await encodeMissionCursor(
            "mission-list",
            filterHash,
            { projectedAt: last.projectedAt, id: last.mission.missionId },
            env.AUTH_COOKIE_SECRET,
          )
        : null;
    return noStoreJson({
      missions: page.items.map((item) => item.mission),
      nextCursor,
    });
  } catch (error) {
    return invalidQuery(error);
  }
}

async function readAgentInbox(
  request: Request,
  url: URL,
  env: GuildhallEnv,
  agentId: string,
): Promise<Response> {
  const authorization = await authorizeAgentAction(request, env, {
    agentId,
    bodyText: "",
    requiredScope: "missions:read",
  });
  if (!authorization.ok) return authorization.response;
  if (authorization.kind !== "guild-node") {
    return noStoreJson(
      { error: "AGENT_NOT_AUTHORIZED", message: "Agent authorization failed" },
      { status: 403 },
    );
  }

  try {
    const limit = queryLimit(url);
    const cursorValue = singleQueryValue(url, "cursor");
    const filterHash = await sha256Base64Url(`inbox\n${agentId}`);
    const cursor =
      cursorValue === null
        ? null
        : await decodeMissionCursor(
            cursorValue,
            "agent-inbox",
            filterHash,
            env.AUTH_COOKIE_SECRET,
          );
    const page = await queryInboxCards(env.GUILD_DB, agentId, cursor, limit);
    const last = page.items.at(-1);
    const nextCursor =
      last === undefined
        ? cursorValue
        : await encodeMissionCursor(
            "agent-inbox",
            filterHash,
            { projectedAt: last.projectedAt, id: last.mission.missionId },
            env.AUTH_COOKIE_SECRET,
          );
    return noStoreJson({
      missions: page.items.map((item) => item.mission),
      nextCursor,
      hasMore: page.hasMore,
    });
  } catch (error) {
    return invalidQuery(error);
  }
}

async function readReceipt(
  database: D1Database,
  missionId: string,
): Promise<Response> {
  const row = await database
    .prepare("SELECT receipt_json FROM receipts WHERE mission_id = ? LIMIT 1")
    .bind(missionId)
    .first<{ receipt_json: string }>();
  if (row === null) return noStoreJson({ receipt: null });

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_json) as unknown;
  } catch {
    return invalidProjection();
  }
  const receipt = ReceiptSchema.safeParse(parsed);
  if (!receipt.success) return invalidProjection();
  return noStoreJson({ receipt: receipt.data });
}

async function readIssuerKey(env: GuildhallEnv): Promise<Response> {
  let current: Awaited<ReturnType<typeof registerConfiguredIssuerKey>>;
  try {
    current = await registerConfiguredIssuerKey(env);
  } catch {
    current = null;
  }
  if (current === null) {
    return noStoreJson({ error: "ISSUER_KEY_UNAVAILABLE" }, { status: 503 });
  }
  return noStoreJson({
    ...current,
    receiptSigningDomain: "PACTBRIDGE-RECEIPT-V1",
    keySetUrl: "/.well-known/guildhall-issuer-keys.json",
  });
}

async function readIssuerKeyHistory(env: GuildhallEnv): Promise<Response> {
  let keys: Awaited<ReturnType<typeof listIssuerKeys>>;
  try {
    await registerConfiguredIssuerKey(env);
    keys = await listIssuerKeys(env.GUILD_DB);
  } catch {
    return noStoreJson({ error: "ISSUER_KEY_UNAVAILABLE" }, { status: 503 });
  }
  return noStoreJson({
    protocol: "commitment/v1",
    algorithm: "Ed25519",
    receiptSigningDomain: "PACTBRIDGE-RECEIPT-V1",
    keys,
  });
}

async function registerConfiguredIssuerKey(env: GuildhallEnv): Promise<{
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicJwk: JsonWebKey;
} | null> {
  if (
    env.GUILD_ISSUER_KEY_ID === undefined ||
    env.GUILD_ISSUER_PRIVATE_JWK === undefined
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.GUILD_ISSUER_PRIVATE_JWK) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  let publicJwk: JsonWebKey;
  try {
    publicJwk = issuerPublicJwk(parsed as JsonWebKey);
  } catch {
    return null;
  }
  await ensureCurrentIssuerKey(env.GUILD_DB, {
    keyId: env.GUILD_ISSUER_KEY_ID,
    publicJwk,
    observedAt: new Date().toISOString(),
  });
  return {
    keyId: env.GUILD_ISSUER_KEY_ID,
    algorithm: "Ed25519",
    publicJwk,
  };
}

const PUBLIC_AGENT_SELECT = `
  SELECT
    agents.agent_id,
    agents.character_name,
    agents.character_class,
    agents.technical_name,
    agents.guild_name,
    agents.public_bio,
    agents.transport_status,
    agents.total_points,
    agents.completed_missions
  FROM agents
`;

async function queryPublicAgents(
  database: D1Database,
  cursor: AgentCursor | null,
  limit: number,
): Promise<Page<ReturnType<typeof toPublicAgent>>> {
  const result = await database
    .prepare(
      `${PUBLIC_AGENT_SELECT}
       WHERE (? IS NULL OR agents.total_points < ?
         OR (agents.total_points = ? AND agents.completed_missions < ?)
         OR (agents.total_points = ? AND agents.completed_missions = ?
             AND agents.agent_id > ?))
       ORDER BY agents.total_points DESC, agents.completed_missions DESC,
                agents.agent_id ASC
       LIMIT ?`,
    )
    .bind(
      cursor?.points ?? null,
      cursor?.points ?? null,
      cursor?.points ?? null,
      cursor?.completed ?? null,
      cursor?.points ?? null,
      cursor?.completed ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<PublicAgentRow>();
  const rows = result.results.slice(0, limit);
  const capabilities = await queryCapabilities(
    database,
    rows.map((row) => row.agent_id),
  );
  return {
    items: rows.map((row) =>
      toPublicAgent(row, capabilities.get(row.agent_id) ?? []),
    ),
    hasMore: result.results.length > limit,
  };
}

async function queryCapabilities(
  database: D1Database,
  agentIds: readonly string[],
): Promise<Map<string, readonly ReturnType<typeof toPublicCapability>[]>> {
  const grouped = new Map<string, ReturnType<typeof toPublicCapability>[]>();
  if (agentIds.length === 0) return grouped;
  const placeholders = agentIds.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT
         agent_id, capability, declared_level, verified_points,
         verified_missions, reliability, timeliness
       FROM agent_capabilities
       WHERE agent_id IN (${placeholders})
       ORDER BY agent_id, verified_points DESC, reliability DESC,
                timeliness DESC, capability ASC`,
    )
    .bind(...agentIds)
    .all<PublicCapabilityRow>();
  for (const row of result.results) {
    const entries = grouped.get(row.agent_id) ?? [];
    if (entries.length < 32) entries.push(toPublicCapability(row));
    grouped.set(row.agent_id, entries);
  }
  return grouped;
}

async function queryCapabilityLeaders(
  database: D1Database,
  capability: string,
  limit: number,
): Promise<readonly ReturnType<typeof toPublicAgent>[]> {
  const result = await database
    .prepare(
      `${PUBLIC_AGENT_SELECT}
       JOIN agent_capabilities AS ranked_capability
         ON ranked_capability.agent_id = agents.agent_id
       WHERE ranked_capability.capability = ?
       ORDER BY ranked_capability.verified_points DESC,
                ranked_capability.reliability DESC,
                ranked_capability.timeliness DESC,
                agents.agent_id ASC
       LIMIT ?`,
    )
    .bind(capability, limit)
    .all<PublicAgentRow>();
  const capabilities = await queryCapabilities(
    database,
    result.results.map((row) => row.agent_id),
  );
  return result.results.map((row) =>
    toPublicAgent(row, capabilities.get(row.agent_id) ?? []),
  );
}

function toPublicAgent(
  row: PublicAgentRow,
  capabilities: readonly ReturnType<typeof toPublicCapability>[],
) {
  return {
    agentId: row.agent_id,
    characterName: row.character_name,
    characterClass: row.character_class,
    technicalName: row.technical_name,
    guildName: row.guild_name,
    publicBio: row.public_bio,
    transportStatus: row.transport_status,
    totalPoints: row.total_points,
    completedMissions: row.completed_missions,
    keySetUrl: `/api/agents/${row.agent_id}/keys`,
    capabilities,
  };
}

function toPublicCapability(row: PublicCapabilityRow) {
  return {
    capability: row.capability,
    declaredLevel: row.declared_level,
    verifiedPoints: row.verified_points,
    verifiedMissions: row.verified_missions,
    reliability: row.reliability,
    timeliness: row.timeliness,
  };
}

const COMPLETE_MISSION_CARD_PREDICATE = `
  mission_catalog.last_sequence > 0
  AND mission_catalog.title IS NOT NULL
  AND mission_catalog.summary IS NOT NULL
  AND mission_catalog.difficulty IS NOT NULL
  AND mission_catalog.point_reward IS NOT NULL
  AND mission_catalog.minimum_party_size IS NOT NULL
  AND mission_catalog.preferred_party_size IS NOT NULL
  AND mission_catalog.maximum_party_size IS NOT NULL
  AND mission_catalog.formation_deadline IS NOT NULL
  AND mission_catalog.delivery_deadline IS NOT NULL
  AND json_array_length(mission_catalog.required_capabilities_json) > 0
`;

const MISSION_CARD_SELECT = `
  SELECT
    mission_id, mission_version, requester_agent_id, title, summary,
    required_capabilities_json, minimum_party_size, preferred_party_size,
    maximum_party_size, formation_deadline, delivery_deadline, difficulty,
    point_reward, display_state, projection_json, last_sequence, projected_at,
    catalog_kind
  FROM mission_catalog
`;

async function queryMissionCards(
  database: D1Database,
  filters: MissionFilters,
  cursor: MissionCursor | null,
  limit: number,
  direction: "ascending" | "descending",
): Promise<
  Page<{ mission: ReturnType<typeof toMissionCard>; projectedAt: string }>
> {
  const cursorOperator = direction === "descending" ? "<" : ">";
  const order = direction === "descending" ? "DESC" : "ASC";
  const idOperator = direction === "descending" ? ">" : ">";
  const result = await database
    .prepare(
      `${MISSION_CARD_SELECT}
       WHERE ${COMPLETE_MISSION_CARD_PREDICATE}
         AND (? = 'all' OR mission_catalog.catalog_kind = ?)
         AND (? IS NULL OR mission_catalog.display_state = ?)
         AND (? IS NULL OR mission_catalog.difficulty = ?)
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM json_each(mission_catalog.required_capabilities_json)
           WHERE json_each.value = ?
         ))
         AND (? IS NULL OR mission_catalog.projected_at ${cursorOperator} ?
           OR (mission_catalog.projected_at = ?
               AND mission_catalog.mission_id ${idOperator} ?))
       ORDER BY mission_catalog.projected_at ${order}, mission_catalog.mission_id ASC
       LIMIT ?`,
    )
    .bind(
      filters.catalogKind,
      filters.catalogKind,
      filters.displayState,
      filters.displayState,
      filters.difficulty,
      filters.difficulty,
      filters.capability,
      filters.capability,
      cursor?.projectedAt ?? null,
      cursor?.projectedAt ?? null,
      cursor?.projectedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<MissionCardRow>();
  return missionPage(result.results, limit);
}

async function queryInboxCards(
  database: D1Database,
  agentId: string,
  cursor: MissionCursor | null,
  limit: number,
): Promise<
  Page<{ mission: ReturnType<typeof toMissionCard>; projectedAt: string }>
> {
  const catalogKind = REFERENCE_AGENT_IDS.has(agentId) ? null : "community";
  const result = await database
    .prepare(
      `${MISSION_CARD_SELECT}
       WHERE ${COMPLETE_MISSION_CARD_PREDICATE}
         AND (? IS NULL OR mission_catalog.catalog_kind = ?)
         AND mission_catalog.requester_agent_id <> ?
         AND mission_catalog.display_state IN ('Recruiting', 'Replacement needed')
         AND (? IS NULL OR mission_catalog.projected_at > ?
           OR (mission_catalog.projected_at = ? AND mission_catalog.mission_id > ?))
       ORDER BY mission_catalog.projected_at ASC, mission_catalog.mission_id ASC
       LIMIT ?`,
    )
    .bind(
      catalogKind,
      catalogKind,
      agentId,
      cursor?.projectedAt ?? null,
      cursor?.projectedAt ?? null,
      cursor?.projectedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    )
    .all<MissionCardRow>();
  return missionPage(result.results, limit);
}

function missionPage(
  rows: readonly MissionCardRow[],
  limit: number,
): Page<{ mission: ReturnType<typeof toMissionCard>; projectedAt: string }> {
  return {
    items: rows.slice(0, limit).map((row) => ({
      mission: toMissionCard(row),
      projectedAt: row.projected_at,
    })),
    hasMore: rows.length > limit,
  };
}

function toMissionCard(row: MissionCardRow) {
  const requiredCapabilities = parseStringArray(
    row.required_capabilities_json,
    16,
  );
  const projection = parseRecord(row.projection_json);
  const applications = projection?.applicationAgentIds;
  const applicantCount = Array.isArray(applications)
    ? Math.min(applications.length, 10_000)
    : 0;
  return {
    missionId: row.mission_id,
    missionVersion: row.mission_version,
    requesterAgentId: row.requester_agent_id,
    title: row.title,
    goal: row.summary,
    requiredCapabilities,
    minimumPartySize: row.minimum_party_size,
    preferredPartySize: row.preferred_party_size,
    maximumPartySize: row.maximum_party_size,
    formationDeadline: row.formation_deadline,
    deliveryDeadline: row.delivery_deadline,
    difficulty: row.difficulty,
    pointReward: row.point_reward,
    applicantCount,
    displayState: row.display_state,
    catalogKind: row.catalog_kind,
  };
}

function missionFilters(url: URL): MissionFilters {
  const capability = singleQueryValue(url, "capability");
  const displayState = singleQueryValue(url, "displayState");
  const difficulty = singleQueryValue(url, "difficulty");
  const catalogKindValue = singleQueryValue(url, "catalogKind");
  const catalogKind = catalogKindValue ?? "community";
  if (capability !== null && !CAPABILITY_PATTERN.test(capability)) {
    throw new TypeError("Invalid capability filter");
  }
  if (displayState !== null && !DISPLAY_STATES.has(displayState)) {
    throw new TypeError("Invalid display-state filter");
  }
  if (difficulty !== null && !DIFFICULTIES.has(difficulty)) {
    throw new TypeError("Invalid difficulty filter");
  }
  if (
    catalogKind !== "community" &&
    catalogKind !== "reference" &&
    catalogKind !== "all"
  ) {
    throw new TypeError("Invalid catalog-kind filter");
  }
  return { capability, displayState, difficulty, catalogKind };
}

function queryLimit(url: URL): number {
  const raw = singleQueryValue(url, "limit");
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new TypeError("Invalid limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > MAXIMUM_LIMIT) {
    throw new TypeError("Invalid limit");
  }
  return limit;
}

function singleQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new TypeError("Duplicate query parameter");
  return values[0] ?? null;
}

async function encodeAgentCursor(
  agent: ReturnType<typeof toPublicAgent>,
  secret: string,
): Promise<string> {
  return signCompactValue(
    JSON.stringify({
      k: "agents",
      p: agent.totalPoints,
      c: agent.completedMissions,
      i: agent.agentId,
    }),
    Date.now() + CURSOR_LIFETIME_MS,
    secret,
  );
}

async function decodeAgentCursor(
  cursor: string,
  secret: string,
): Promise<AgentCursor> {
  const payload = await verifiedCursorPayload(cursor, secret);
  if (
    payload.k !== "agents" ||
    typeof payload.p !== "number" ||
    !Number.isSafeInteger(payload.p) ||
    payload.p < 0 ||
    typeof payload.c !== "number" ||
    !Number.isSafeInteger(payload.c) ||
    payload.c < 0 ||
    typeof payload.i !== "string" ||
    !UUID_PATTERN.test(payload.i)
  ) {
    throw new InvalidCursorError();
  }
  return { points: payload.p, completed: payload.c, id: payload.i };
}

async function encodeMissionCursor(
  kind: "mission-list" | "agent-inbox",
  filterHash: string,
  cursor: MissionCursor,
  secret: string,
): Promise<string> {
  return signCompactValue(
    JSON.stringify({
      k: kind,
      q: filterHash,
      t: cursor.projectedAt,
      i: cursor.id,
    }),
    Date.now() + CURSOR_LIFETIME_MS,
    secret,
  );
}

async function decodeMissionCursor(
  cursor: string,
  kind: "mission-list" | "agent-inbox",
  filterHash: string,
  secret: string,
): Promise<MissionCursor> {
  const payload = await verifiedCursorPayload(cursor, secret);
  if (
    payload.k !== kind ||
    payload.q !== filterHash ||
    typeof payload.t !== "string" ||
    !isTimestamp(payload.t) ||
    typeof payload.i !== "string" ||
    !UUID_PATTERN.test(payload.i)
  ) {
    throw new InvalidCursorError();
  }
  return { projectedAt: payload.t, id: payload.i };
}

async function verifiedCursorPayload(
  cursor: string,
  secret: string,
): Promise<Record<string, unknown>> {
  if (cursor.length === 0 || cursor.length > 512) {
    throw new InvalidCursorError();
  }
  const verified = await verifyCompactValue(cursor, secret);
  if (!verified.valid) throw new InvalidCursorError();
  const payload = parseRecord(verified.payload);
  if (payload === null) throw new InvalidCursorError();
  return payload;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStringArray(value: string, maximum: number): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.length <= maximum &&
      parsed.every(
        (item) => typeof item === "string" && CAPABILITY_PATTERN.test(item),
      )
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function isTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function invalidQuery(error: unknown): Response {
  return noStoreJson(
    {
      error:
        error instanceof InvalidCursorError
          ? "INVALID_CURSOR"
          : "INVALID_QUERY",
      message: "The bounded query could not be accepted",
    },
    { status: 400 },
  );
}

function invalidProjection(): Response {
  return noStoreJson(
    {
      error: "PROJECTION_UNAVAILABLE",
      message: "The public projection is unavailable",
    },
    { status: 500 },
  );
}
