import { describe, expect, it } from "vitest";

import {
  deriveWorkSlots,
  mergeMissionPacket,
} from "../../apps/guildhall/src/client/mission/TechnicalMission";
import {
  referenceAgents,
  type MissionPacket,
} from "../../apps/guildhall/src/client/mission/types";

const MISSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOUT_SLOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SCRIBE_SLOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const SCOUT_OUTPUT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const PLAN_OUTPUT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

describe("mission chamber view model", () => {
  it("shows default first, then exact visible replacement and preserved output", () => {
    const packet = missionPacket();
    const agents = new Map(
      referenceAgents.map((agent) => [agent.agentId, agent]),
    );
    const pact = packet.snapshot.candidatePact as {
      pact: Record<string, unknown>;
    };

    const afterDefault = deriveWorkSlots(
      packet,
      packet.events.slice(0, 3),
      pact.pact,
      agents,
    );
    expect(afterDefault).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          characterName: "Scout",
          status: "Artifact accepted",
          tone: "complete",
        }),
        expect.objectContaining({
          characterName: "Scribe",
          status: "Defaulted",
          tone: "danger",
          replaced: false,
        }),
      ]),
    );

    const afterReplacement = deriveWorkSlots(
      packet,
      packet.events,
      pact.pact,
      agents,
    );
    expect(afterReplacement[1]).toMatchObject({
      characterName: "Warden",
      originalName: "Scribe",
      status: "Artifact accepted",
      tone: "complete",
      replaced: true,
    });
  });

  it("merges a resumed stream snapshot without duplicating prior events", () => {
    const packet = missionPacket();
    const resumed: MissionPacket = {
      ...packet,
      latestSequence: 5,
      events: [packet.events[3]!, packet.events[4]!],
    };
    const merged = mergeMissionPacket(
      { ...packet, latestSequence: 3, events: packet.events.slice(0, 4) },
      resumed,
    );
    expect(merged.events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(new Set(merged.events.map((event) => event.eventId)).size).toBe(5);
  });
});

function missionPacket(): MissionPacket {
  const scout = referenceAgents[0]!;
  const scribe = referenceAgents[1]!;
  const warden = referenceAgents[2]!;
  return {
    missionId: MISSION_ID,
    definition: null,
    latestSequence: 5,
    events: [
      event(1, "pact_bound", null),
      event(2, "artifact_submitted", SCOUT_SLOT),
      event(3, "role_defaulted", SCRIBE_SLOT),
      event(4, "replacement_bound", SCRIBE_SLOT),
      event(5, "artifact_submitted", SCRIBE_SLOT),
    ],
    snapshot: {
      stage: "DELIVER",
      candidatePact: {
        pactDigest: "D".repeat(43),
        pact: {
          pactVersion: 2,
          roleSlots: [
            {
              roleSlotId: SCOUT_SLOT,
              originalAgentId: scout.agentId,
              assignment: "Map every accessibility hazard.",
              requiredOutputIds: [SCOUT_OUTPUT],
              pointAllocation: 50,
            },
            {
              roleSlotId: SCRIBE_SLOT,
              originalAgentId: scribe.agentId,
              assignment: "Link every finding to a remedy.",
              requiredOutputIds: [PLAN_OUTPUT],
              pointAllocation: 50,
            },
          ],
          requiredOutputs: [
            { outputId: SCOUT_OUTPUT, type: "accessibility-findings" },
            { outputId: PLAN_OUTPUT, type: "remediation-plan" },
          ],
        },
      },
      roleSlots: [
        {
          roleSlotId: SCOUT_SLOT,
          originalAgentId: scout.agentId,
          occupantAgentId: scout.agentId,
        },
        {
          roleSlotId: SCRIBE_SLOT,
          originalAgentId: scribe.agentId,
          occupantAgentId: warden.agentId,
        },
      ],
    },
  };
}

function event(sequence: number, type: string, roleSlotId: string | null) {
  return {
    eventId: `dddddddd-dddd-4ddd-8ddd-${String(sequence).padStart(12, "0")}`,
    sequence,
    type,
    source: "a2a",
    emittedAt: `2026-08-26T12:00:0${sequence}.000Z`,
    eventHash: `${String(sequence).repeat(43).slice(0, 43)}`,
    payload: {
      command: {
        type,
        ...(roleSlotId === null ? {} : { roleSlotId }),
      },
    },
  };
}
