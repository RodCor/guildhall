import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Mission } from "../../packages/contracts/src";
import type { MissionCoordinator } from "../../apps/guildhall/src/worker/durable/MissionCoordinator";

const REQUESTER_ID = "10000000-0000-4000-8000-000000000001";
const worker = (exports as unknown as { default: Fetcher }).default;
type CoordinatorRpc = Pick<
  MissionCoordinator,
  "initializeMission" | "executeCommand" | "getSnapshot"
>;

describe("immutable public mission publication", () => {
  it("persists full terms, projects a complete card, and exposes the definition", async () => {
    const definition = missionDefinition("complete-publication");
    const durableStub = env.MISSIONS.getByName(definition.missionId);
    const stub = durableStub as unknown as CoordinatorRpc;

    await stub.initializeMission(
      definition.missionId,
      definition.requesterAgentId,
      definition,
    );
    expect(
      await stub.executeCommand(publishCommand(definition.requesterAgentId)),
    ).toMatchObject({ ok: true, resultingSequence: 1 });

    const snapshot = await stub.getSnapshot();
    expect(snapshot.definition).toEqual(definition);
    expect(snapshot.snapshot.stage).toBe("PREPARE");

    await runInDurableObject(
      durableStub,
      async (_instance: MissionCoordinator, state) => {
        const row = state.storage.sql
          .exec<{
            definition_json: string;
            definition_digest: string;
          }>(
            "SELECT definition_json, definition_digest FROM mission_definition",
          )
          .one();
        expect(JSON.parse(row.definition_json)).toEqual(definition);
        expect(row.definition_digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      },
    );

    const catalog = await env.GUILD_DB.prepare(
      `SELECT title, summary, difficulty, point_reward,
              minimum_party_size, preferred_party_size, maximum_party_size,
              required_capabilities_json, formation_deadline,
              delivery_deadline, projection_json, last_sequence
       FROM mission_catalog WHERE mission_id = ? LIMIT 1`,
    )
      .bind(definition.missionId)
      .first<Record<string, string | number>>();
    expect(catalog).toMatchObject({
      title: definition.title,
      summary: definition.goal,
      difficulty: definition.difficulty,
      point_reward: definition.pointReward,
      minimum_party_size: definition.minimumPartySize,
      preferred_party_size: definition.preferredPartySize,
      maximum_party_size: definition.maximumPartySize,
      formation_deadline: definition.formationDeadline,
      delivery_deadline: definition.deliveryDeadline,
      last_sequence: 1,
    });
    expect(JSON.parse(String(catalog?.required_capabilities_json))).toEqual(
      definition.requiredCapabilities,
    );
    expect(JSON.parse(String(catalog?.projection_json))).toMatchObject({
      definition,
      stage: "PREPARE",
    });

    const listing = await worker.fetch("https://guildhall.test/api/missions");
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      missions: [
        {
          missionId: definition.missionId,
          title: definition.title,
          goal: definition.goal,
          requiredCapabilities: definition.requiredCapabilities,
          displayState: "Recruiting",
        },
      ],
    });

    const detail = await worker.fetch(
      `https://guildhall.test/api/missions/${definition.missionId}`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      missionId: definition.missionId,
      definition,
      latestSequence: 1,
    });
  });

  it("accepts idempotent initialization but rejects definition replacement", async () => {
    const definition = missionDefinition("immutable-definition");
    const durableStub = env.MISSIONS.getByName(definition.missionId);
    const stub = durableStub as unknown as CoordinatorRpc;
    await stub.initializeMission(
      definition.missionId,
      definition.requesterAgentId,
      definition,
    );
    await expect(
      stub.initializeMission(
        definition.missionId,
        definition.requesterAgentId,
        definition,
      ),
    ).resolves.toMatchObject({ sequence: 0 });

    await runInDurableObject(
      durableStub,
      async (instance: MissionCoordinator) => {
        await expect(
          instance.initializeMission(
            definition.missionId,
            definition.requesterAgentId,
            { ...definition, title: "Mutated mission terms" },
          ),
        ).rejects.toThrow(/immutable/u);
      },
    );
    expect((await stub.getSnapshot()).definition).toEqual(definition);

    await runInDurableObject(
      durableStub,
      async (_instance: MissionCoordinator, state) => {
        expect(() =>
          state.storage.sql.exec(
            "UPDATE mission_definition SET definition_json = '{}'",
          ),
        ).toThrow(/immutable/u);
        expect(() =>
          state.storage.sql.exec("DELETE FROM mission_definition"),
        ).toThrow(/immutable/u);
      },
    );
  });

  it("keeps legacy initialization compatible without accepting invalid terms", async () => {
    const legacyId = missionId("legacy-initializer");
    const legacy = env.MISSIONS.getByName(
      legacyId,
    ) as unknown as CoordinatorRpc;
    await expect(
      legacy.initializeMission(legacyId, REQUESTER_ID),
    ).resolves.toMatchObject({ missionId: legacyId, sequence: 0 });
    expect((await legacy.getSnapshot()).definition).toBeNull();

    const definition = missionDefinition("invalid-definition");
    const invalidDurableStub = env.MISSIONS.getByName(definition.missionId);
    await runInDurableObject(
      invalidDurableStub,
      async (instance: MissionCoordinator, state) => {
        await expect(
          instance.initializeMission(
            definition.missionId,
            definition.requesterAgentId,
            {
              ...definition,
              minimumPartySize: 2,
              preferredPartySize: 1,
            },
          ),
        ).rejects.toThrow();
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM mission_state",
            )
            .one().count,
        ).toBe(0);
      },
    );
  });
});

function missionDefinition(name: string): Mission {
  const missionIdValue = missionId(name);
  return {
    protocol: "commitment/v1",
    kind: "mission",
    missionId: missionIdValue,
    missionVersion: 1,
    requesterAgentId: REQUESTER_ID,
    title: `Public mission ${name}`,
    goal: "Produce deterministic accessibility findings for a public page.",
    publicInputs: [
      {
        inputId: "20000000-0000-4000-8000-000000000001",
        type: "url",
        location: "https://example.test/public-fixture",
        mediaType: "text/html",
      },
    ],
    requiredCapabilities: ["accessibility-audit"],
    minimumPartySize: 1,
    preferredPartySize: 1,
    maximumPartySize: 2,
    formationDeadline: "2026-08-27T12:00:00.000Z",
    deliveryDeadline: "2026-08-28T12:00:00.000Z",
    requiredOutputs: [
      {
        outputId: "30000000-0000-4000-8000-000000000001",
        type: "accessibility-findings",
        description: "Deterministic accessibility findings.",
        mediaType: "application/json",
        publicLocation: "mission-artifact",
      },
    ],
    verificationCriteria: [
      {
        criterionId: "40000000-0000-4000-8000-000000000001",
        description: "The output validates against the findings schema.",
        required: true,
        method: "deterministic",
      },
    ],
    difficulty: "adept",
    pointReward: 500,
    failureBehavior: {
      negotiationTimeout: "reopen-recruitment",
      participantDefault: "recruit-exact-slot-replacement",
      replacementAuthorized: true,
      verificationCorrectionLimit: 1,
    },
    publishedAt: "2026-08-26T12:00:00.000Z",
  };
}

function publishCommand(requesterAgentId: string) {
  return {
    commandId: crypto.randomUUID(),
    expectedSequence: 0,
    actor: { agentId: requesterAgentId },
    source: "webmcp" as const,
    issuedAt: "2026-08-26T12:00:00.000Z",
    command: { type: "publish" as const },
  };
}

function missionId(name: string): string {
  const bytes = new Uint8Array(16);
  const encoded = new TextEncoder().encode(name);
  encoded.forEach((value, index) => {
    bytes[index % bytes.length] = (bytes[index % bytes.length]! + value) & 255;
  });
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .replace(/^(........)(....)(....)(....)(............)$/u, "$1-$2-$3-$4-$5");
}
