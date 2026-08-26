import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { MissionCoordinator } from "../../apps/guildhall/src/worker/durable/MissionCoordinator";
import type { CoordinatorCommand } from "../../apps/guildhall/src/worker/durable/protocol";
import {
  projectMissionCatalog,
  readMissionCatalogRow,
} from "../../apps/guildhall/src/worker/repositories/missionCatalog";
import { verifyEventChain } from "../../packages/trust-engine/src";

const REQUESTER = "10000000-0000-4000-8000-000000000001";
const HELPER_RED = "20000000-0000-4000-8000-000000000001";
const HELPER_BLUE = "20000000-0000-4000-8000-000000000002";
const ROLE_RED = "30000000-0000-4000-8000-000000000001";
const PACT_DIGEST = "P".repeat(43);
const guildhallWorker = (exports as unknown as { default: Fetcher }).default;

type CoordinatorRpc = Pick<
  MissionCoordinator,
  | "initializeMission"
  | "executeCommand"
  | "getSnapshot"
  | "inspectCore"
  | "retryProjection"
  | "scheduleDeadline"
  | "fetch"
>;

describe("MissionCoordinator transactional protocol core", () => {
  it("serializes concurrent applications without losing either helper", async () => {
    const stub = await recruitingMission("concurrent-applications");

    const [red, blue] = await Promise.all([
      stub.executeCommand(command({ type: "apply", agentId: HELPER_RED })),
      stub.executeCommand(command({ type: "apply", agentId: HELPER_BLUE })),
    ]);

    expect(red.ok).toBe(true);
    expect(blue.ok).toBe(true);
    const snapshot = await stub.getSnapshot();
    expect(snapshot.snapshot.applicationAgentIds).toEqual([
      HELPER_RED,
      HELPER_BLUE,
    ]);
    expect(snapshot.latestSequence).toBe(3);
  });

  it("serializes concurrent final acceptances and binds the pact exactly once", async () => {
    const stub = await negotiatingMission("concurrent-acceptances");

    const [requester, helper] = await Promise.all([
      stub.executeCommand(
        command({
          type: "accept_pact",
          agentId: REQUESTER,
          pactVersion: 1,
          pactDigest: PACT_DIGEST,
        }),
      ),
      stub.executeCommand(
        command({
          type: "accept_pact",
          agentId: HELPER_RED,
          pactVersion: 1,
          pactDigest: PACT_DIGEST,
        }),
      ),
    ]);

    expect(requester.ok).toBe(true);
    expect(helper.ok).toBe(true);
    const snapshot = await stub.getSnapshot();
    expect(snapshot.snapshot.stage).toBe("EXECUTE");
    expect(
      snapshot.events.filter((event) => event.type === "pact_bound"),
    ).toHaveLength(1);
  });

  it("replays the exact stored result and conflicts on command-id reuse", async () => {
    const stub = await recruitingMission("command-idempotency");
    const commandId = crypto.randomUUID();
    const firstCommand = command(
      { type: "apply", agentId: HELPER_RED },
      { commandId },
    );

    const first = await stub.executeCommand(firstCommand);
    const replay = await stub.executeCommand(firstCommand);
    const conflict = await stub.executeCommand(
      command({ type: "apply", agentId: HELPER_BLUE }, { commandId }),
    );

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ ok: false, code: "COMMAND_ID_REUSED" });
    expect((await stub.getSnapshot()).snapshot.applicationAgentIds).toEqual([
      HELPER_RED,
    ]);
  });

  it("keeps canonical mission truth when D1 fails, then clears its retry", async () => {
    const stub = await recruitingMission("d1-retry");
    await env.GUILD_DB.exec(
      "ALTER TABLE mission_catalog RENAME TO mission_catalog_offline",
    );

    const accepted = await stub.executeCommand(
      command({ type: "apply", agentId: HELPER_RED }),
    );
    const failedProjection = await stub.inspectCore();

    expect(accepted).toMatchObject({ ok: true, resultingSequence: 2 });
    expect(failedProjection.snapshot?.applicationAgentIds).toEqual([
      HELPER_RED,
    ]);
    expect(
      failedProjection.projectionOutbox.some(
        (row) => row.sourceSequence === 2 && row.status === "pending",
      ),
    ).toBe(true);
    expect(failedProjection.scheduledAlarm).not.toBeNull();

    await env.GUILD_DB.exec(
      "ALTER TABLE mission_catalog_offline RENAME TO mission_catalog",
    );
    expect(await stub.retryProjection()).toMatchObject({ pending: 0 });
    const recovered = await stub.inspectCore();
    expect(
      recovered.projectionOutbox.find((row) => row.sourceSequence === 2),
    ).toMatchObject({ status: "complete", attempts: 2 });
    expect(
      await readMissionCatalogRow(env.GUILD_DB, recovered.snapshot!.missionId),
    ).toMatchObject({ last_sequence: 2 });
  });

  it("prevents a stale D1 catalog projection from overwriting newer state", async () => {
    const missionId = missionUuid("stale-projection");
    const base = {
      missionId,
      missionVersion: 1,
      requesterAgentId: REQUESTER,
      lifecycleState: "EXECUTE",
      displayState: "Executing",
      projection: { marker: "newer" },
      projectedAt: "2026-08-26T12:00:10.000Z",
    } as const;

    expect(
      await projectMissionCatalog(env.GUILD_DB, {
        ...base,
        lastSequence: 10,
      }),
    ).toMatchObject({ applied: true, currentSequence: 10 });
    expect(
      await projectMissionCatalog(env.GUILD_DB, {
        ...base,
        displayState: "Recruiting",
        projection: { marker: "stale" },
        lastSequence: 9,
      }),
    ).toEqual({
      applied: false,
      incomingSequence: 9,
      currentSequence: 10,
    });
    expect(await readMissionCatalogRow(env.GUILD_DB, missionId)).toMatchObject({
      display_state: "Executing",
      projection_json: JSON.stringify({ marker: "newer" }),
      last_sequence: 10,
    });
  });

  it("restores snapshot plus sequence-gated events across hibernation", async () => {
    const stub = await recruitingMission("websocket-resume");
    const response = await stub.fetch(
      new Request("https://guildhall.test/stream?after=0", {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    const initialMessage = nextSocketJson(socket!);
    socket!.accept();
    const initial = await initialMessage;
    expect(initial).toMatchObject({ type: "snapshot", latestSequence: 1 });

    const deltaMessage = nextSocketJson(socket!);
    await stub.executeCommand(command({ type: "apply", agentId: HELPER_RED }));
    const delta = await deltaMessage;
    expect(delta).toMatchObject({ type: "events", latestSequence: 2 });

    await evictDurableObject(asDurableStub(stub));
    const resumedMessage = nextSocketJson(socket!);
    socket!.send(JSON.stringify({ type: "resume", afterSequence: 1 }));
    const resumed = await resumedMessage;
    expect(resumed).toMatchObject({
      type: "snapshot",
      afterSequence: 1,
      latestSequence: 2,
    });
    expect((resumed as { events: unknown[] }).events).toHaveLength(1);

    const rejectedMutation = nextSocketJson(socket!);
    socket!.send(JSON.stringify({ type: "command", action: "cancel" }));
    expect(await rejectedMutation).toMatchObject({
      type: "error",
      code: "READ_ONLY_STREAM",
    });
    socket!.close(1000, "done");
  });

  it("maintains one earliest alarm across deadline sources", async () => {
    const stub = await recruitingMission("earliest-alarm");
    const later = Date.now() + 60_000;
    const earlier = Date.now() + 30_000;
    await stub.scheduleDeadline("delivery", later);
    const scheduled = await stub.scheduleDeadline("a2a_retry", earlier);
    expect(scheduled).toBe(earlier);

    expect(await runDurableObjectAlarm(asDurableStub(stub))).toBe(true);
    const inspection = await stub.inspectCore();
    expect(inspection.scheduledAlarm).toBe(earlier);
  });

  it("persists a completed, verifiable event stream and inspectable outboxes", async () => {
    const stub = await completeMission("completed-chain");
    const inspection = await stub.inspectCore();

    expect(inspection.snapshot).toMatchObject({
      stage: "RECEIPT",
      terminalOutcome: "completed",
    });
    expect(verifyEventChain(inspection.events)).toMatchObject({
      valid: true,
      eventCount: inspection.snapshot!.sequence,
      finalSequence: inspection.snapshot!.sequence,
    });
    expect(inspection.effectOutbox.length).toBeGreaterThan(0);
    expect(
      inspection.effectOutbox.every((row) => row.status === "complete"),
    ).toBe(true);
    expect(
      inspection.projectionOutbox.every((row) => row.status === "complete"),
    ).toBe(true);

    await runInDurableObject(
      asDurableStub(stub),
      async (_instance: MissionCoordinator, state) => {
        const snapshot = state.storage.sql
          .exec<{ sequence: number; stage: string }>(
            "SELECT sequence, stage FROM mission_state",
          )
          .one();
        const counts = state.storage.sql
          .exec<{ events: number; commands: number }>(
            `SELECT
               (SELECT COUNT(*) FROM events) AS events,
               (SELECT COUNT(*) FROM command_results) AS commands`,
          )
          .one();
        expect(snapshot).toMatchObject({
          sequence: inspection.snapshot!.sequence,
          stage: "RECEIPT",
        });
        expect(counts.events).toBe(inspection.events.length);
        expect(counts.commands).toBeGreaterThan(0);
      },
    );
  });

  it("exposes the minimal canonical HTTP command API", async () => {
    const missionId = missionUuid("http-api");
    const created = await guildhallWorker.fetch(
      `https://guildhall.test/api/missions/${missionId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requesterAgentId: REQUESTER }),
      },
    );
    expect(created.status).toBe(201);

    const published = await guildhallWorker.fetch(
      `https://guildhall.test/api/missions/${missionId}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command({ type: "publish" })),
      },
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      ok: true,
      resultingSequence: 1,
    });

    const snapshot = await guildhallWorker.fetch(
      `https://guildhall.test/api/missions/${missionId}?after=0`,
    );
    expect(await snapshot.json()).toMatchObject({ latestSequence: 1 });
  });
});

async function recruitingMission(name: string) {
  const stub = coordinator(name);
  await stub.initializeMission(missionUuid(name), REQUESTER);
  expect(await stub.executeCommand(command({ type: "publish" }))).toMatchObject(
    {
      ok: true,
    },
  );
  return stub;
}

async function negotiatingMission(name: string) {
  const stub = await recruitingMission(name);
  await stub.executeCommand(command({ type: "apply", agentId: HELPER_RED }));
  await stub.executeCommand(
    command({
      type: "form_party",
      helperIds: [HELPER_RED],
      roleSlots: [
        {
          roleSlotId: ROLE_RED,
          originalAgentId: HELPER_RED,
          occupantAgentId: HELPER_RED,
          status: "active",
          artifactRequired: true,
          artifactDelivered: false,
        },
      ],
    }),
  );
  await stub.executeCommand(
    command({
      type: "submit_proposal",
      pactVersion: 1,
      pactDigest: PACT_DIGEST,
    }),
  );
  return stub;
}

async function completeMission(name: string) {
  const stub = await negotiatingMission(name);
  for (const agentId of [REQUESTER, HELPER_RED]) {
    await stub.executeCommand(
      command({
        type: "accept_pact",
        agentId,
        pactVersion: 1,
        pactDigest: PACT_DIGEST,
      }),
    );
  }
  await stub.executeCommand(command({ type: "start_execution" }));
  await stub.executeCommand(
    command({ type: "submit_artifact", roleSlotId: ROLE_RED }),
  );
  await stub.executeCommand(command({ type: "verify" }));
  await stub.executeCommand(command({ type: "verification_passed" }));
  return stub;
}

function coordinator(name: string): CoordinatorRpc {
  return env.MISSIONS.getByName(name) as unknown as CoordinatorRpc;
}

function asDurableStub(
  stub: CoordinatorRpc,
): DurableObjectStub<MissionCoordinator> {
  return stub as unknown as DurableObjectStub<MissionCoordinator>;
}

function command(
  lifecycleCommand: CoordinatorCommand["command"],
  options: { commandId?: string; expectedSequence?: number } = {},
): CoordinatorCommand {
  return {
    commandId: options.commandId ?? crypto.randomUUID(),
    ...(options.expectedSequence === undefined
      ? {}
      : { expectedSequence: options.expectedSequence }),
    actor: null,
    source: "http",
    issuedAt: new Date().toISOString(),
    command: lifecycleCommand,
  };
}

function missionUuid(name: string): string {
  const digest = Array.from(new TextEncoder().encode(name))
    .reduce((value, byte) => (value * 31 + byte) >>> 0, 0)
    .toString(16)
    .padStart(8, "0");
  return `${digest}-0000-4000-8000-000000000001`;
}

function nextSocketJson(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket message timeout")),
      2_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)) as unknown);
      },
      { once: true },
    );
  });
}
