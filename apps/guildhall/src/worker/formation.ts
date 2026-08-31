import type { Mission } from "@guildhall/contracts";
import {
  selectHelpers,
  type HelperApplication,
  type HelperSelectionResult,
  type LifecycleState,
  type RuntimeRoleSlot,
} from "@guildhall/mission-engine";

import type { MissionSnapshotPacket } from "./durable/protocol.js";
import type { GuildhallEnv } from "./types.js";

interface MissionFormationSnapshot extends MissionSnapshotPacket {
  readonly definition: Mission | null;
}

interface CapabilityEvidenceRow {
  readonly agent_id: string;
  readonly capability: string;
  readonly verified_points: number;
  readonly reliability: number;
}

export interface AutomaticFormationResult {
  readonly formed: boolean;
  readonly reason?: "awaiting-applicants" | "not-recruiting" | "no-definition";
  readonly selection?: HelperSelectionResult;
  readonly resultingSequence?: number;
}

export interface DerivedPartyFormation {
  readonly selection: HelperSelectionResult;
  readonly roleSlots: readonly RuntimeRoleSlot[];
}

/**
 * Freezes registry-backed evidence and lets the mission authority reserve the
 * party. No public requester route accepts helper IDs or ranking claims.
 */
export async function attemptAutomaticFormation(
  env: GuildhallEnv,
  missionId: string,
): Promise<AutomaticFormationResult> {
  const coordinator = env.MISSIONS.getByName(missionId) as unknown as {
    getSnapshot(): Promise<MissionFormationSnapshot>;
    executeCommand(input: {
      commandId: string;
      expectedSequence: number;
      actor: null;
      source: "system";
      issuedAt: string;
      command: {
        type: "form_party";
        helperIds: readonly string[];
        roleSlots: readonly RuntimeRoleSlot[];
        selectionEvidence: HelperSelectionResult;
        minimumNotMet?: boolean;
      };
    }): Promise<
      | { readonly ok: true; readonly resultingSequence: number }
      | { readonly ok: false; readonly code: string }
    >;
  };
  const packet = await coordinator.getSnapshot();
  const state = packet.snapshot;
  const mission = packet.definition;
  if (mission === null) return { formed: false, reason: "no-definition" };
  if (state.stage !== "PREPARE") {
    return { formed: false, reason: "not-recruiting" };
  }

  const deadlineReached = Date.now() >= Date.parse(mission.formationDeadline);
  const derived = await derivePartyFormation(
    env.GUILD_DB,
    mission,
    state,
    deadlineReached,
  );
  if (derived === null) {
    return { formed: false, reason: "awaiting-applicants" };
  }
  const { selection, roleSlots } = derived;
  if (
    selection.selectedAgentIds.length < mission.preferredPartySize &&
    !deadlineReached
  ) {
    return { formed: false, reason: "awaiting-applicants", selection };
  }
  const result = await coordinator.executeCommand({
    commandId: crypto.randomUUID(),
    expectedSequence: packet.latestSequence,
    actor: null,
    source: "system",
    issuedAt: new Date().toISOString(),
    command: {
      type: "form_party",
      helperIds: selection.selectedAgentIds,
      roleSlots,
      selectionEvidence: selection,
      ...(selection.oneHelperFallbackUsed ? { minimumNotMet: true } : {}),
    },
  });
  return result.ok
    ? { formed: true, selection, resultingSequence: result.resultingSequence }
    : { formed: false, reason: "not-recruiting", selection };
}

export async function derivePartyFormation(
  database: D1Database,
  mission: Mission,
  state: LifecycleState,
  allowOneHelperFallback: boolean,
): Promise<DerivedPartyFormation | null> {
  const applications = await rankedApplications(database, mission, state);
  const selection = selectHelpers(mission.requiredCapabilities, applications, {
    minimumHelpers: mission.minimumPartySize,
    preferredHelpers: mission.preferredPartySize,
    maximumHelpers: mission.maximumPartySize,
  });
  if (
    !selection.canProceed ||
    (selection.oneHelperFallbackUsed && !allowOneHelperFallback)
  ) {
    return null;
  }
  const roleSlots = await Promise.all(
    selection.selectedAgentIds.map(async (agentId) => ({
      roleSlotId: await deterministicRoleSlotId(mission.missionId, agentId),
      originalAgentId: agentId,
      occupantAgentId: agentId,
      status: "active" as const,
      artifactRequired: true,
      artifactDelivered: false,
    })),
  );
  return { selection, roleSlots };
}

async function rankedApplications(
  database: D1Database,
  mission: Mission,
  state: LifecycleState,
): Promise<readonly HelperApplication[]> {
  const ids = state.applications.map((application) => application.agentId);
  const evidence = await capabilityEvidence(database, ids);
  const required = new Set(mission.requiredCapabilities);
  const now = Date.now();
  return state.applications.map((application) => {
    const registered = evidence.get(application.agentId) ?? [];
    const declaredRelevant = new Set(application.relevantCapabilities);
    const matching = registered.filter(
      (row) =>
        required.has(row.capability) && declaredRelevant.has(row.capability),
    );
    return {
      agentId: application.agentId,
      skills: matching.map((row) => row.capability),
      verifiedCapabilityRank: matching.reduce(
        (total, row) => total + row.verified_points,
        0,
      ),
      reliability:
        matching.length === 0
          ? 0
          : matching.reduce((total, row) => total + row.reliability, 0) /
            matching.length,
      applicationEventSequence: application.applicationEventSequence,
      eligible:
        matching.length > 0 &&
        Date.parse(application.availability.availableFrom) <= now &&
        Date.parse(application.availability.availableUntil) >=
          Date.parse(mission.deliveryDeadline),
    };
  });
}

async function capabilityEvidence(
  database: D1Database,
  agentIds: readonly string[],
): Promise<Map<string, readonly CapabilityEvidenceRow[]>> {
  const grouped = new Map<string, CapabilityEvidenceRow[]>();
  if (agentIds.length === 0) return grouped;
  const result = await database
    .prepare(
      `SELECT agent_id, capability, verified_points, reliability
       FROM agent_capabilities
       WHERE agent_id IN (${agentIds.map(() => "?").join(", ")})
         AND declared_level > 0
       ORDER BY agent_id, capability`,
    )
    .bind(...agentIds)
    .all<CapabilityEvidenceRow>();
  for (const row of result.results) {
    const rows = grouped.get(row.agent_id) ?? [];
    rows.push(row);
    grouped.set(row.agent_id, rows);
  }
  return grouped;
}

async function deterministicRoleSlotId(
  missionId: string,
  agentId: string,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`guildhall:role:${missionId}:${agentId}`),
    ),
  ).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
