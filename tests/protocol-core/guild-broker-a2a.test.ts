import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  deriveEd25519KeyId,
  encodeBase64Url,
  hashOpaqueCredential,
  randomBase64UrlToken,
} from "../../apps/guildhall/src/worker/auth/crypto";
import {
  createAgent,
  registerAgentKey,
  registerScopedCredential,
  upsertGithubOwnerAndSession,
} from "../../apps/guildhall/src/worker/repositories";
import { createAgentRequestSignatureMessage } from "../../packages/trust-engine/src";
import {
  commandBodyHash,
  commandSigningBytes,
} from "../../packages/contracts/src";

import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  COMMITMENT_V1_EXTENSION_URI,
} from "../../packages/a2a-worker/src";

const ORIGIN = "https://guildhall.test";
const worker = (exports as unknown as { default: Fetcher }).default;

describe("Guild Broker A2A binding", () => {
  it("publishes a valid card with three honest Guild skills", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/agent-card.json`),
    );
    expect(response.status).toBe(200);
    const card = await json<Record<string, unknown>>(response);
    expect(card).toMatchObject({
      name: "Guildhall Guild Broker",
      supportedInterfaces: [
        {
          url: `${ORIGIN}/a2a/guild/v1`,
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
        },
      ],
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [{ uri: COMMITMENT_V1_EXTENSION_URI, required: true }],
      },
    });
    expect(card.skills).toHaveLength(3);
  });

  it("executes public discovery as a completed A2A task without claiming Guild verification", async () => {
    const response = await worker.fetch(
      a2aRequest("guild.list_missions", "guild-catalog", { limit: 3 }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(A2A_CONTENT_TYPE);
    expect(response.headers.get(A2A_EXTENSIONS_HEADER)).toBe(
      COMMITMENT_V1_EXTENSION_URI,
    );
    const result = await json<{
      task: {
        id: string;
        status: { state: string };
        artifacts: Array<{
          parts: Array<{ data: unknown }>;
          metadata: Record<string, unknown>;
        }>;
        metadata: Record<string, unknown>;
      };
    }>(response);
    expect(result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(result.task.metadata).toMatchObject({
      canonicalAction: "guild.list_missions",
      guildMissionVerified: false,
    });
    expect(result.task.artifacts[0]?.parts[0]?.data).toMatchObject({
      missions: expect.any(Array),
      nextCursor: null,
    });

    const taskResponse = await worker.fetch(
      new Request(
        `${ORIGIN}/a2a/guild/v1/tasks/${encodeURIComponent(result.task.id)}`,
        { headers: a2aHeaders() },
      ),
    );
    expect(taskResponse.status).toBe(200);
    expect(await json(taskResponse)).toMatchObject({
      id: result.task.id,
      status: { state: "TASK_STATE_COMPLETED" },
    });
  });

  it("rejects unsigned mutations before reserving an A2A message ID", async () => {
    const missionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const response = await worker.fetch(
      a2aRequest(
        "guild.apply_to_mission",
        missionId,
        {
          missionId,
          expectedSequence: 0,
          missionVersion: 1,
          relevantCapabilities: ["accessibility-audit"],
          proposedContribution: "Inspect the bounded fixture.",
          availability: {
            availableFrom: "2026-08-26T12:00:00.000Z",
            availableUntil: "2026-08-26T16:00:00.000Z",
          },
        },
        { agentId: crypto.randomUUID() },
        messageId,
      ),
    );
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({
      error: {
        status: "UNAUTHENTICATED",
        details: [
          expect.objectContaining({ metadata: { authentication: "required" } }),
        ],
      },
    });
    const persisted = await env.GUILD_DB.prepare(
      "SELECT COUNT(*) AS count FROM a2a_tasks WHERE message_id = ?",
    )
      .bind(messageId)
      .first<{ count: number }>();
    expect(persisted?.count).toBe(0);
  });

  it("replays one D1-backed task for the same message and rejects conflicts", async () => {
    const messageId = crypto.randomUUID();
    const first = await worker.fetch(
      a2aRequest(
        "guild.list_missions",
        "guild-catalog",
        { limit: 2 },
        {},
        messageId,
      ),
    );
    const firstBody = await json<{ task: { id: string } }>(first);
    const replay = await worker.fetch(
      a2aRequest(
        "guild.list_missions",
        "guild-catalog",
        { limit: 2 },
        {},
        messageId,
      ),
    );
    expect(await json(replay)).toMatchObject({
      task: { id: firstBody.task.id },
    });

    const conflict = await worker.fetch(
      a2aRequest(
        "guild.list_missions",
        "guild-catalog",
        { limit: 4 },
        {},
        messageId,
      ),
    );
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      error: {
        status: "ALREADY_EXISTS",
        details: [expect.objectContaining({ reason: "INVALID_PARAMS" })],
      },
    });
  });

  it("rejects unsafe public input before persisting or echoing it", async () => {
    const messageId = crypto.randomUUID();
    const syntheticMatch = `sk-proj-${"Q".repeat(28)}`;
    const response = await worker.fetch(
      a2aRequest(
        "guild.list_missions",
        "guild-catalog",
        { capability: syntheticMatch },
        {},
        messageId,
      ),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(syntheticMatch);
    expect(text).toContain("INVALID_PARAMS");
    const persisted = await env.GUILD_DB.prepare(
      "SELECT COUNT(*) AS count FROM a2a_tasks WHERE message_id = ?",
    )
      .bind(messageId)
      .first<{ count: number }>();
    expect(persisted?.count).toBe(0);
  });

  it("authenticates a signed mutation once and executes it", async () => {
    const identity = await seedGuildNode();
    const missionId = crypto.randomUUID();
    const requesterAgentId = crypto.randomUUID();
    const coordinator = env.MISSIONS.getByName(missionId);
    const now = Date.now();
    await coordinator.initializeMission(
      missionId,
      requesterAgentId,
      brokerMission(missionId, requesterAgentId, now),
    );
    const published = await coordinator.executeCommand({
      commandId: crypto.randomUUID(),
      expectedSequence: 0,
      actor: null,
      source: "system",
      issuedAt: new Date().toISOString(),
      command: { type: "publish" },
    });
    expect(published.ok).toBe(true);

    const body = a2aBody(
      "guild.apply_to_mission",
      missionId,
      {
        missionId,
        expectedSequence: 1,
        missionVersion: 1,
        relevantCapabilities: ["accessibility-audit"],
        proposedContribution: "Inspect the bounded public fixture.",
        availability: {
          availableFrom: new Date(now - 60_000).toISOString(),
          availableUntil: new Date(now + 4 * 60 * 60_000).toISOString(),
        },
      },
      { agentId: identity.agentId },
      crypto.randomUUID(),
    );
    const response = await worker.fetch(await signedA2ARequest(body, identity));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      task: {
        status: { state: "TASK_STATE_COMPLETED" },
        metadata: { canonicalAction: "guild.apply_to_mission" },
      },
    });
    const snapshot = await (
      coordinator as unknown as {
        getSnapshot(): Promise<{
          snapshot: { applicationAgentIds: readonly string[] };
        }>;
      }
    ).getSnapshot();
    expect(snapshot.snapshot.applicationAgentIds).toEqual([identity.agentId]);

    const transportMessageId = crypto.randomUUID();
    const mismatched = a2aBody(
      "guild.withdraw_application",
      missionId,
      {
        commandId: crypto.randomUUID(),
        missionId,
        expectedSequence: 2,
        missionVersion: 1,
      },
      { agentId: identity.agentId },
      transportMessageId,
    );
    const mismatchResponse = await worker.fetch(
      await signedA2ARequest(mismatched, identity),
    );
    expect(mismatchResponse.status).toBe(200);
    expect(await json(mismatchResponse)).toMatchObject({
      task: {
        status: { state: "TASK_STATE_FAILED" },
        metadata: { executionErrorCode: "GUILD_COMMAND_ID_MISMATCH" },
      },
    });
  });

  it("rejects a signed application after the immutable formation deadline", async () => {
    const identity = await seedGuildNode(9_910_002);
    const missionId = crypto.randomUUID();
    const requesterAgentId = crypto.randomUUID();
    const now = Date.now();
    const coordinator = env.MISSIONS.getByName(missionId);
    await coordinator.initializeMission(missionId, requesterAgentId, {
      ...brokerMission(missionId, requesterAgentId, now),
      formationDeadline: new Date(now - 60_000).toISOString(),
      deliveryDeadline: new Date(now + 60 * 60_000).toISOString(),
      publishedAt: new Date(now - 2 * 60_000).toISOString(),
    });
    await coordinator.executeCommand({
      commandId: crypto.randomUUID(),
      expectedSequence: 0,
      actor: null,
      source: "system",
      issuedAt: new Date(now - 2 * 60_000).toISOString(),
      command: { type: "publish" },
    });

    const body = a2aBody(
      "guild.apply_to_mission",
      missionId,
      {
        missionId,
        expectedSequence: 1,
        missionVersion: 1,
        relevantCapabilities: ["accessibility-audit"],
        proposedContribution: "This application arrived too late.",
        availability: {
          availableFrom: new Date(now - 60_000).toISOString(),
          availableUntil: new Date(now + 2 * 60 * 60_000).toISOString(),
        },
      },
      { agentId: identity.agentId },
      crypto.randomUUID(),
    );
    const response = await worker.fetch(await signedA2ARequest(body, identity));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      task: {
        status: { state: "TASK_STATE_FAILED" },
        metadata: { executionErrorCode: "GUILD_FORMATION_CLOSED" },
      },
    });
  });
});

function brokerMission(
  missionId: string,
  requesterAgentId: string,
  now: number,
) {
  return {
    protocol: "commitment/v1" as const,
    kind: "mission" as const,
    missionId,
    missionVersion: 1,
    requesterAgentId,
    title: "Signed A2A application mission",
    goal: "Inspect a bounded public fixture.",
    publicInputs: [
      {
        inputId: crypto.randomUUID(),
        type: "url" as const,
        location: "https://guildhall.test/fixtures/accessibility-dungeon-v1",
        mediaType: "text/html",
        contentDigest: "geKBB1Pr83xZU8RzZaoC-YcNy6MO2jw3lB_lupUQQ58",
      },
    ],
    requiredCapabilities: ["accessibility-audit"],
    minimumPartySize: 1,
    preferredPartySize: 1,
    maximumPartySize: 2,
    formationDeadline: new Date(now + 60 * 60_000).toISOString(),
    deliveryDeadline: new Date(now + 3 * 60 * 60_000).toISOString(),
    requiredOutputs: [
      {
        outputId: crypto.randomUUID(),
        type: "accessibility-findings" as const,
        description: "Deterministic public findings.",
        mediaType: "application/json" as const,
        publicLocation: "mission-artifact" as const,
      },
    ],
    verificationCriteria: [
      {
        criterionId: crypto.randomUUID(),
        description: "The findings validate deterministically.",
        required: true as const,
        method: "deterministic" as const,
      },
    ],
    difficulty: "adept" as const,
    pointReward: 50,
    failureBehavior: {
      negotiationTimeout: "reopen-recruitment" as const,
      participantDefault: "recruit-exact-slot-replacement" as const,
      replacementAuthorized: true as const,
      verificationCorrectionLimit: 1 as const,
    },
    publishedAt: new Date(now).toISOString(),
  };
}

function a2aRequest(
  action: string,
  contextId: string,
  data: Record<string, unknown>,
  commitmentFields: Record<string, unknown> = {},
  messageId = crypto.randomUUID(),
): Request {
  return new Request(`${ORIGIN}/a2a/guild/v1/message:send`, {
    method: "POST",
    headers: a2aHeaders(),
    body: JSON.stringify(
      a2aBody(action, contextId, data, commitmentFields, messageId),
    ),
  });
}

function a2aBody(
  action: string,
  contextId: string,
  data: Record<string, unknown>,
  commitmentFields: Record<string, unknown>,
  messageId: string,
): Record<string, unknown> {
  return {
    message: {
      messageId,
      contextId,
      role: "ROLE_USER",
      parts: [{ data }],
      metadata: {
        [COMMITMENT_V1_EXTENSION_URI]: {
          protocol: "commitment/v1",
          action,
          missionId: contextId,
          ...commitmentFields,
        },
      },
      extensions: [COMMITMENT_V1_EXTENSION_URI],
    },
  };
}

function a2aHeaders(): Headers {
  return new Headers({
    "Content-Type": A2A_CONTENT_TYPE,
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
  });
}

async function json<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}

async function seedGuildNode(githubUserId = 9_910_001): Promise<{
  readonly agentId: string;
  readonly credential: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}> {
  const now = new Date().toISOString();
  const ownerId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId: ownerId,
    githubUserId,
    githubLogin: `broker-a2a-test-${githubUserId}`,
    githubAvatarUrl: null,
    sessionHash: randomBase64UrlToken(),
    csrfHash: randomBase64UrlToken(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: now,
  });
  await createAgent(env.GUILD_DB, {
    agentId,
    ownerId,
    slug: `broker-${agentId.slice(0, 8)}`,
    characterName: "Nonce Sentinel",
    characterClass: "Ranger",
    technicalName: "Broker mutation verifier",
    guildName: "Guildhall",
    publicBio: "A deterministic protocol test agent.",
    createdAt: now,
  });
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const keyId = await deriveEd25519KeyId("guild-node", publicJwk);
  await registerAgentKey(env.GUILD_DB, {
    keyId,
    ownerId,
    agentId,
    publicJwk,
    source: "guild-node",
    createdAt: now,
  });
  const credential = randomBase64UrlToken();
  await registerScopedCredential(env.GUILD_DB, {
    credentialId: crypto.randomUUID(),
    ownerId,
    agentId,
    keyId,
    credentialHash: await hashOpaqueCredential(credential),
    scopes: ["missions:write"],
    expiresAt: null,
    createdAt: now,
  });
  return { agentId, credential, keyId, privateKey: pair.privateKey };
}

async function signedA2ARequest(
  body: Record<string, unknown>,
  identity: {
    readonly agentId: string;
    readonly credential: string;
    readonly keyId: string;
    readonly privateKey: CryptoKey;
  },
): Promise<Request> {
  const message = body.message as Record<string, unknown>;
  const part = (message.parts as Record<string, unknown>[])[0]!;
  const input = part.data as Record<string, unknown>;
  const metadata = message.metadata as Record<string, Record<string, unknown>>;
  const commitment = metadata[COMMITMENT_V1_EXTENSION_URI]!;
  const commandIssuedAt = new Date().toISOString();
  const commandId =
    typeof input.commandId === "string"
      ? input.commandId
      : String(message.messageId);
  const {
    protocol: _protocol,
    action,
    missionId,
    agentId: _agentId,
    commandIssuedAt: _priorIssuedAt,
    commandProof: _priorProof,
    ...unsignedCommitment
  } = commitment;
  const bodyHash = await commandBodyHash({
    commandId,
    action: String(action),
    missionId: String(missionId),
    expectedSequence: Number(input.expectedSequence),
    actor: { agentId: identity.agentId, keyId: identity.keyId },
    issuedAt: commandIssuedAt,
    payload: { input, commitment: unsignedCommitment },
  });
  commitment.commandIssuedAt = commandIssuedAt;
  commitment.commandProof = {
    bodyHash,
    signature: encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          identity.privateKey,
          commandSigningBytes(bodyHash).slice().buffer as ArrayBuffer,
        ),
      ),
    ),
  };
  const bodyText = JSON.stringify(body);
  const requestTarget = "/a2a/guild/v1/message:send";
  const issuedAt = new Date().toISOString();
  const nonce = randomBase64UrlToken();
  const proof = new TextEncoder().encode(
    createAgentRequestSignatureMessage({
      method: "POST",
      requestTarget,
      bodyText,
      issuedAt,
      nonce,
    }),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    identity.privateKey,
    proof.slice().buffer as ArrayBuffer,
  );
  return new Request(`${ORIGIN}${requestTarget}`, {
    method: "POST",
    headers: {
      ...Object.fromEntries(a2aHeaders()),
      Authorization: `GuildNode ${identity.credential}`,
      "X-Guild-Key-Id": identity.keyId,
      "X-Guild-Issued-At": issuedAt,
      "X-Guild-Nonce": nonce,
      "X-Guild-Signature": encodeBase64Url(new Uint8Array(signature)),
    },
    body: bodyText,
  });
}
