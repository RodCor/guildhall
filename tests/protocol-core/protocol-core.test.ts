import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { MissionCoordinator } from "../../apps/guildhall/src/worker/durable/MissionCoordinator";
import type { CoordinatorCommand } from "../../apps/guildhall/src/worker/durable/protocol";
import {
  createAgent,
  registerAgentKey,
  upsertGithubOwnerAndSession,
} from "../../apps/guildhall/src/worker/repositories";
import {
  projectMissionCatalog,
  readMissionCatalogRow,
} from "../../apps/guildhall/src/worker/repositories/missionCatalog";
import {
  deriveEd25519KeyId,
  hashOpaqueCredential,
  randomBase64UrlToken,
} from "../../apps/guildhall/src/worker/auth/crypto";
import {
  artifactSigningBytes,
  canonicalJsonDigest,
  signEd25519,
} from "../../packages/contracts/src";
import { verifyEventChain } from "../../packages/trust-engine/src";
import {
  applyToMission,
  formParty,
  submitAssignmentProposal,
  submitCapabilityBid,
  submitProposal,
} from "../state-machine/fixtures";

const REQUESTER = "10000000-0000-4000-8000-000000000001";
const HELPER_RED = "20000000-0000-4000-8000-000000000001";
const HELPER_BLUE = "20000000-0000-4000-8000-000000000002";
const ROLE_RED = "30000000-0000-4000-8000-000000000001";
const OUTPUT_RED = "50000000-0000-4000-8000-000000000001";
const PACT_DIGEST_V1 = "P".repeat(43);
const PACT_DIGEST_V2 = "Q".repeat(43);
const ACCEPTANCE_KEY_ID = "70000000-0000-4000-8000-000000000001";
const guildhallWorker = (exports as unknown as { default: Fetcher }).default;

type CoordinatorRpc = Pick<
  MissionCoordinator,
  | "initializeMission"
  | "executeCommand"
  | "getSnapshot"
  | "inspectCore"
  | "retryProjection"
  | "scheduleDeadline"
  | "submitArtifact"
  | "fetch"
>;

describe("MissionCoordinator transactional protocol core", () => {
  it("serializes concurrent applications without losing either helper", async () => {
    const stub = await recruitingMission("concurrent-applications");

    const [red, blue] = await Promise.all([
      stub.executeCommand(command(applyToMission(HELPER_RED))),
      stub.executeCommand(command(applyToMission(HELPER_BLUE))),
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
      stub.executeCommand(command(acceptPact(REQUESTER))),
      stub.executeCommand(command(acceptPact(HELPER_RED))),
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
    const firstCommand = command(applyToMission(HELPER_RED), { commandId });

    const first = await stub.executeCommand(firstCommand);
    const replay = await stub.executeCommand(firstCommand);
    const conflict = await stub.executeCommand(
      command(applyToMission(HELPER_BLUE), { commandId }),
    );

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ ok: false, code: "COMMAND_ID_REUSED" });
    expect((await stub.getSnapshot()).snapshot.applicationAgentIds).toEqual([
      HELPER_RED,
    ]);
  });

  it("ignores transport retry time but commits semantic command evidence", async () => {
    const stub = await recruitingMission("semantic-command-hash");
    const commandId = crypto.randomUUID();
    const firstCommand = command(applyToMission(HELPER_RED), {
      commandId,
      expectedSequence: 1,
    });
    const first = await stub.executeCommand(firstCommand);
    await stub.executeCommand(command(applyToMission(HELPER_BLUE)));

    const replay = await stub.executeCommand({
      ...firstCommand,
      issuedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(replay).toEqual(first);

    const conflict = await stub.executeCommand({
      ...firstCommand,
      issuedAt: new Date(Date.now() + 120_000).toISOString(),
      source: "a2a",
    });
    expect(conflict).toMatchObject({
      ok: false,
      code: "COMMAND_ID_REUSED",
    });
  });

  it("keeps canonical mission truth when D1 fails, then clears its retry", async () => {
    const stub = await recruitingMission("d1-retry");
    await env.GUILD_DB.exec(
      "ALTER TABLE mission_catalog RENAME TO mission_catalog_offline",
    );

    const accepted = await stub.executeCommand(
      command(applyToMission(HELPER_RED)),
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
    await stub.executeCommand(command(applyToMission(HELPER_RED)));
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

  it("reschedules an unfinished A2A execution retry", async () => {
    const stub = await recruitingMission("a2a-retry-reschedule");
    const beforeAlarm = Date.now();
    const dueAt = beforeAlarm + 60_000;
    await stub.scheduleDeadline("a2a_retry", dueAt);

    const clock = vi.spyOn(Date, "now").mockReturnValue(dueAt + 1);
    try {
      expect(await runDurableObjectAlarm(asDurableStub(stub))).toBe(true);
    } finally {
      clock.mockRestore();
    }

    const inspection = await stub.inspectCore();
    expect(inspection.scheduledAlarm).not.toBeNull();
    expect(inspection.scheduledAlarm!).toBeGreaterThan(dueAt);
    expect(inspection.snapshot).toMatchObject({ stage: "PREPARE" });
  });

  it("does not schedule demo execution for a wrong fixture digest", async () => {
    const stub = await negotiatingMission(
      "wrong-fixture-digest",
      "D".repeat(43),
    );
    for (const agentId of [REQUESTER, HELPER_RED]) {
      await stub.executeCommand(command(acceptPact(agentId)));
    }

    expect((await stub.getSnapshot()).snapshot.stage).toBe("EXECUTE");
    expect((await stub.inspectCore()).scheduledAlarm).toBeNull();
  });

  it("returns a sanitized artifact safety issue without consuming correction", async () => {
    const name = "artifact-safety-correction";
    const signer = await seedArtifactSigner();
    const stub = await executingMission(name);
    const before = await stub.getSnapshot();
    const syntheticMatch = `sk-proj-${"Z".repeat(28)}`;

    const rejected = await stub.submitArtifact(
      await signedArtifactCommand(name, signer, {
        result: syntheticMatch,
      }),
    );
    expect(rejected).toMatchObject({
      ok: false,
      code: "PUBLIC_SAFETY_REJECTED",
      safetyIssue: {
        fieldPath: "$.content.result",
        category: "provider-token",
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(syntheticMatch);
    const afterRejected = await stub.getSnapshot();
    expect(afterRejected.latestSequence).toBe(before.latestSequence);
    expect(afterRejected.snapshot.correctionCount).toBe(0);
    expect(afterRejected.artifacts).toEqual([]);

    const accepted = await stub.submitArtifact(
      await signedArtifactCommand(name, signer, {
        fixture: "protocol-core-safe-resubmission",
      }),
    );
    expect(accepted).toMatchObject({ ok: true });
    const afterAccepted = await stub.getSnapshot();
    expect(afterAccepted.snapshot.correctionCount).toBe(0);
    expect(afterAccepted.artifacts).toHaveLength(1);
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
        const acceptances = state.storage.sql
          .exec<{
            acceptance_id: string;
            key_id: string;
            signature: string;
            accepted_at: string;
          }>(
            `SELECT acceptance_id, key_id, signature, accepted_at
             FROM pact_acceptances ORDER BY agent_id`,
          )
          .toArray();
        expect(snapshot).toMatchObject({
          sequence: inspection.snapshot!.sequence,
          stage: "RECEIPT",
        });
        expect(counts.events).toBe(inspection.events.length);
        expect(counts.commands).toBeGreaterThan(0);
        expect(acceptances).toHaveLength(2);
        expect(
          acceptances.every(
            (acceptance) =>
              acceptance.key_id === ACCEPTANCE_KEY_ID &&
              acceptance.signature.length === 86 &&
              Number.isFinite(Date.parse(acceptance.accepted_at)),
          ),
        ).toBe(true);
      },
    );
  });

  it("exposes the minimal canonical HTTP command API", async () => {
    const authHeaders = await seedHttpOwner();
    const missionId = missionUuid("http-api");
    const created = await guildhallWorker.fetch(
      `https://guildhall.test/api/missions/${missionId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ requesterAgentId: REQUESTER }),
      },
    );
    expect(created.status).toBe(201);

    const published = await guildhallWorker.fetch(
      `https://guildhall.test/api/missions/${missionId}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({
          ...command({ type: "publish" }, { expectedSequence: 0 }),
          actor: { agentId: REQUESTER },
        }),
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

async function seedHttpOwner(): Promise<Record<string, string>> {
  const ownerId = "90000000-0000-4000-8000-000000000001";
  const sessionToken = randomBase64UrlToken();
  const csrfToken = randomBase64UrlToken();
  const now = new Date().toISOString();
  const principal = await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId: ownerId,
    githubUserId: 9001,
    githubLogin: "guildhall-test-owner",
    githubAvatarUrl: null,
    sessionHash: await hashOpaqueCredential(sessionToken),
    csrfHash: await hashOpaqueCredential(csrfToken),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
  });
  await createAgent(env.GUILD_DB, {
    agentId: REQUESTER,
    ownerId: principal.ownerId,
    slug: "protocol-requester",
    characterName: "Protocol Requester",
    characterClass: "Artificer",
    technicalName: "Protocol Core Test",
    guildName: "Guildhall Tests",
    publicBio: "Exercises the authenticated command adapter.",
    createdAt: now,
  });
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  await registerAgentKey(env.GUILD_DB, {
    keyId: await deriveEd25519KeyId("browser", publicJwk),
    ownerId: principal.ownerId,
    agentId: REQUESTER,
    publicJwk,
    source: "browser",
    createdAt: now,
  });
  return {
    Cookie: `__Host-guild_session=${sessionToken}; __Host-guild_csrf=${csrfToken}`,
    Origin: "https://guildhall.test",
    "X-Guild-CSRF": csrfToken,
  };
}

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

async function negotiatingMission(name: string, publicInputDigest?: string) {
  const stub = await recruitingMission(name);
  await stub.executeCommand(command(applyToMission(HELPER_RED)));
  await stub.executeCommand(
    command(
      formParty(
        [HELPER_RED],
        [
          {
            roleSlotId: ROLE_RED,
            originalAgentId: HELPER_RED,
            occupantAgentId: HELPER_RED,
            status: "active",
            artifactRequired: true,
            artifactDelivered: false,
          },
        ],
      ),
    ),
  );
  await stub.executeCommand(command(submitCapabilityBid(HELPER_RED)));
  await stub.executeCommand(
    command(
      submitProposal(
        1,
        PACT_DIGEST_V1,
        REQUESTER,
        [
          {
            roleSlotId: ROLE_RED,
            originalAgentId: HELPER_RED,
            occupantAgentId: HELPER_RED,
            status: "active",
            artifactRequired: true,
            artifactDelivered: false,
          },
        ],
        undefined,
        {
          missionId: missionUuid(name),
          ...(publicInputDigest === undefined ? {} : { publicInputDigest }),
        },
      ),
    ),
  );
  await stub.executeCommand(
    command(
      submitAssignmentProposal(
        PACT_DIGEST_V2,
        HELPER_RED,
        [
          {
            roleSlotId: ROLE_RED,
            originalAgentId: HELPER_RED,
            occupantAgentId: HELPER_RED,
            status: "active",
            artifactRequired: true,
            artifactDelivered: false,
          },
        ],
        "helper-counter",
        {
          missionId: missionUuid(name),
          ...(publicInputDigest === undefined ? {} : { publicInputDigest }),
        },
      ),
    ),
  );
  return stub;
}

async function executingMission(name: string) {
  const stub = await negotiatingMission(name);
  for (const agentId of [REQUESTER, HELPER_RED]) {
    await stub.executeCommand(command(acceptPact(agentId)));
  }
  await stub.executeCommand(command({ type: "start_execution" }));
  return stub;
}

async function completeMission(name: string) {
  const stub = await executingMission(name);
  await stub.executeCommand(
    command({
      type: "submit_artifact",
      roleSlotId: ROLE_RED,
      artifact: {
        outputId: OUTPUT_RED,
        metadata: {
          protocol: "commitment/v1",
          kind: "artifact-metadata",
          artifactId: OUTPUT_RED,
          missionId: missionUuid(name),
          pactDigest: PACT_DIGEST_V2,
          roleSlotId: ROLE_RED,
          producingAgentId: HELPER_RED,
          keyId: ACCEPTANCE_KEY_ID,
          attempt: 1,
          artifactType: "accessibility-findings",
          mediaType: "application/json",
          publicLocation: `https://guildhall.test/artifacts/${OUTPUT_RED}`,
          contentDigest: "D".repeat(43),
          signature: "S".repeat(86),
          safetyStatus: "approved",
          completedAt: new Date().toISOString(),
        },
        content: { fixture: "protocol-core" },
        dependencyArtifactIds: [],
      },
    }),
  );
  await stub.executeCommand(command({ type: "verify" }));
  await stub.executeCommand(command({ type: "verification_passed" }));
  return stub;
}

interface ArtifactSigner {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

async function seedArtifactSigner(): Promise<ArtifactSigner> {
  const now = new Date().toISOString();
  const owner = await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId: crypto.randomUUID(),
    githubUserId: 9_002,
    githubLogin: "artifact-helper-owner",
    githubAvatarUrl: null,
    sessionHash: await hashOpaqueCredential(randomBase64UrlToken()),
    csrfHash: await hashOpaqueCredential(randomBase64UrlToken()),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
  });
  await createAgent(env.GUILD_DB, {
    agentId: HELPER_RED,
    ownerId: owner.ownerId,
    slug: "artifact-helper",
    characterName: "Artifact Helper",
    characterClass: "Ranger",
    technicalName: "Artifact Safety Test",
    guildName: "Guildhall Tests",
    publicBio: "Exercises private artifact safety correction.",
    createdAt: now,
  });
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const keyId = await deriveEd25519KeyId("a2a", publicJwk);
  await registerAgentKey(env.GUILD_DB, {
    keyId,
    ownerId: owner.ownerId,
    agentId: HELPER_RED,
    publicJwk,
    source: "a2a",
    createdAt: now,
  });
  return { keyId, privateKey: keyPair.privateKey };
}

async function signedArtifactCommand(
  name: string,
  signer: ArtifactSigner,
  content: Readonly<Record<string, unknown>>,
): Promise<CoordinatorCommand> {
  const contentDigest = await canonicalJsonDigest(content);
  return {
    commandId: crypto.randomUUID(),
    actor: { agentId: HELPER_RED, keyId: signer.keyId },
    source: "a2a",
    issuedAt: new Date().toISOString(),
    command: {
      type: "submit_artifact",
      roleSlotId: ROLE_RED,
      artifact: {
        outputId: OUTPUT_RED,
        metadata: {
          protocol: "commitment/v1",
          kind: "artifact-metadata",
          artifactId: crypto.randomUUID(),
          missionId: missionUuid(name),
          pactDigest: PACT_DIGEST_V2,
          roleSlotId: ROLE_RED,
          producingAgentId: HELPER_RED,
          keyId: signer.keyId,
          attempt: 1,
          artifactType: "accessibility-findings",
          mediaType: "application/json",
          publicLocation: `https://guildhall.test/artifacts/${OUTPUT_RED}`,
          contentDigest,
          signature: await signEd25519(
            signer.privateKey,
            artifactSigningBytes(PACT_DIGEST_V2, contentDigest),
          ),
          safetyStatus: "approved",
          completedAt: new Date().toISOString(),
        },
        content,
        dependencyArtifactIds: [],
      },
    },
  };
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

function acceptPact(
  agentId: string,
): Extract<CoordinatorCommand["command"], { type: "accept_pact" }> {
  return {
    type: "accept_pact",
    acceptanceId: crypto.randomUUID(),
    agentId,
    keyId: ACCEPTANCE_KEY_ID,
    pactVersion: 2,
    pactDigest: PACT_DIGEST_V2,
    signature: "S".repeat(86),
    acceptedAt: new Date().toISOString(),
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
