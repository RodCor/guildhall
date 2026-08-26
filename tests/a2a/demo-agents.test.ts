import {
  AgentCard,
  Role,
  SendMessageRequest,
  Task,
  TaskState,
  type AgentCard as OfficialAgentCard,
  type SendMessageRequest as OfficialSendMessageRequest,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  RestTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  withA2AVersion,
} from "@a2a-js/sdk/client";
import {
  ArtifactMetadataSchema,
  artifactSigningBytes,
  canonicalJsonDigest,
} from "../../packages/contracts/src";
import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  COMMITMENT_V1_EXTENSION_URI,
} from "../../packages/a2a-worker/src";
import { describe, expect, it } from "vitest";

import {
  buildAgentCard,
  type HostedAgentKind,
} from "../../apps/demo-agent/src/agent-card";
import {
  ACCESSIBILITY_FIXTURE_ID,
  CONTROLLED_SCRIBE_FAILURE,
  parseApprovedFixture,
} from "../../apps/demo-agent/src/fixtures";
import { createAgentWorker } from "../../apps/demo-agent/src/worker";
import { TEST_PRIVATE_JWKS } from "./fixtures/test-identities";

const COMPLETED_AT = "2026-08-26T15:00:00.000Z";
const MISSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOUT_SLOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCRIBE_SLOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PREDECESSOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PACT_DIGEST = "P".repeat(43);
const ASSIGNMENT_DIGEST = "A".repeat(43);

const origins: Readonly<Record<HostedAgentKind, string>> = {
  scout: "https://scout.guildhall.test",
  scribe: "https://scribe.guildhall.test",
  warden: "https://warden.guildhall.test",
};
const workers: Readonly<
  Record<HostedAgentKind, ReturnType<typeof createAgentWorker>>
> = {
  scout: createAgentWorker("scout", { now: fixedNow }),
  scribe: createAgentWorker("scribe", { now: fixedNow }),
  warden: createAgentWorker("warden", { now: fixedNow }),
};

describe("three independent deterministic A2A Workers", () => {
  it("serves three honest official Agent Cards with distinct public identities", async () => {
    const cards = await Promise.all(
      (["scout", "scribe", "warden"] as const).map(readCard),
    );
    expect(new Set(cards.map((entry) => entry.card.name)).size).toBe(3);
    expect(
      new Set(cards.map((entry) => requiredString(entry.identity, "agentId")))
        .size,
    ).toBe(3);
    expect(
      new Set(cards.map((entry) => requiredString(entry.identity, "keyId")))
        .size,
    ).toBe(3);

    for (const entry of cards) {
      expect(entry.card.supportedInterfaces).toEqual([
        expect.objectContaining({
          protocolBinding: "HTTP+JSON",
          protocolVersion: A2A_PROTOCOL_VERSION,
          url: `${origins[entry.kind]}/a2a/v1`,
        }),
      ]);
      expect(entry.card.capabilities?.streaming).toBe(false);
      expect(entry.card.capabilities?.pushNotifications).toBe(false);
      expect(entry.card.skills).toHaveLength(1);
      const publicJwk = requiredRecord(entry.identity, "publicJwk");
      expect(publicJwk).toMatchObject({ crv: "Ed25519", kty: "OKP" });
      expect(publicJwk).not.toHaveProperty("d");
    }
  });

  it("runs Scout and Scribe through official request/task shapes with signed artifacts", async () => {
    const scoutRequest = assignmentRequest("scout", SCOUT_SLOT, {
      fixtureId: ACCESSIBILITY_FIXTURE_ID,
      kind: "role-assignment",
      protocol: "commitment/v1",
      role: "scout",
    });
    const scout = await send("scout", scoutRequest);
    expect(scout.response.status).toBe(200);
    expect(scout.response.headers.get(A2A_EXTENSIONS_HEADER)).toContain(
      COMMITMENT_V1_EXTENSION_URI,
    );
    expect(scout.task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(scout.task.artifacts).toHaveLength(1);
    expect(scout.task.artifacts[0]?.parts[0]?.content?.$case).toBe("data");
    const scoutArtifact = firstArtifact(scout.rawTask);
    await verifyArtifact("scout", scoutArtifact);
    const findingsPayload = artifactData(scoutArtifact);
    const findings = requiredArray(findingsPayload, "findings");
    expect(findings).toHaveLength(4);

    const replay = await send("scout", scoutRequest);
    expect(requiredString(replay.rawTask, "id")).toBe(
      requiredString(scout.rawTask, "id"),
    );
    expect(replay.rawTask).toEqual(scout.rawTask);
    const fetched = await getTask("scout", requiredString(scout.rawTask, "id"));
    expect(fetched.id).toBe(requiredString(scout.rawTask, "id"));
    expect(fetched.artifacts[0]?.artifactId).toBe(
      scout.task.artifacts[0]?.artifactId,
    );

    const scribe = await send(
      "scribe",
      assignmentRequest("scribe", SCRIBE_SLOT, {
        findings,
        fixtureId: ACCESSIBILITY_FIXTURE_ID,
        kind: "role-assignment",
        protocol: "commitment/v1",
        role: "scribe",
      }),
    );
    expect(scribe.task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const scribeArtifact = firstArtifact(scribe.rawTask);
    await verifyArtifact("scribe", scribeArtifact);
    const plan = artifactData(scribeArtifact);
    expect(requiredArray(plan, "steps")).toHaveLength(findings.length);
    expect(requiredArray(plan, "coveredFindingIds").sort()).toEqual(
      findings
        .map((finding) => requiredString(asRecord(finding), "findingId"))
        .sort(),
    );
    expect(taskExtension(scribe.rawTask)).toMatchObject({
      guildMissionVerification: "PENDING",
    });
  });

  it("turns the named Scribe fixture into a controlled FAILED Task", async () => {
    const findings = fixtureFindings();
    const failed = await send(
      "scribe",
      assignmentRequest("scribe", SCRIBE_SLOT, {
        findings,
        fixtureId: ACCESSIBILITY_FIXTURE_ID,
        fixtureScenario: CONTROLLED_SCRIBE_FAILURE,
        kind: "role-assignment",
        protocol: "commitment/v1",
        role: "scribe",
      }),
    );
    expect(failed.response.status).toBe(200);
    expect(failed.task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(failed.task.artifacts).toEqual([]);
    expect(failed.task.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Controlled Scribe failure fixture activated.",
    });
  });

  it("interoperates through the official ClientFactory REST client", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      return workers.scout.fetch(request, {
        HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS.scout),
      });
    };
    const cardResponse = await fetchImpl(
      `${origins.scout}/.well-known/agent-card.json`,
    );
    const card = AgentCard.fromJSON(await cardResponse.json());
    const client = await new ClientFactory({
      transports: [new RestTransportFactory({ fetchImpl })],
    }).createFromAgentCard(card);
    const serviceParameters = ServiceParameters.create(
      withA2AExtensions(COMMITMENT_V1_EXTENSION_URI),
      withA2AVersion(A2A_PROTOCOL_VERSION),
    );
    const request = assignmentRequest("scout", SCOUT_SLOT, {
      fixtureId: ACCESSIBILITY_FIXTURE_ID,
      kind: "role-assignment",
      protocol: "commitment/v1",
      role: "scout",
    });
    const first = await client.sendMessage(request, { serviceParameters });
    if (!("status" in first)) throw new TypeError("Expected an A2A Task.");
    expect(first.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const replay = await client.sendMessage(request, { serviceParameters });
    if (!("status" in replay)) throw new TypeError("Expected an A2A Task.");
    expect(replay.id).toBe(first.id);
    const fetched = await client.getTask(
      { tenant: "", id: first.id, historyLength: 4 },
      { serviceParameters },
    );
    expect(fetched.id).toBe(first.id);
    expect(fetched.artifacts[0]?.artifactId).toBe(
      first.artifacts[0]?.artifactId,
    );
  });

  it("lets Warden recover only an unchanged exact role assignment", async () => {
    const findings = fixtureFindings();
    const recovered = await send(
      "warden",
      recoveryRequest({
        findings,
        originalRole: "scribe",
        replacementRole: "scribe",
        replacementAssignmentDigest: ASSIGNMENT_DIGEST,
      }),
    );
    expect(recovered.task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const recoveredArtifact = firstArtifact(recovered.rawTask);
    await verifyArtifact("warden", recoveredArtifact);
    expect(taskExtension(recovered.rawTask)).toMatchObject({
      guildMissionVerification: "PENDING",
    });
    expect(recovered.rawTask.metadata).toMatchObject({
      recoveredRole: "scribe",
      recoveryMode: "exact-role",
    });

    const recoveredScout = await send(
      "warden",
      recoveryRequest({
        findings,
        originalRole: "scout",
        replacementRole: "scout",
        replacementAssignmentDigest: ASSIGNMENT_DIGEST,
      }),
    );
    expect(recoveredScout.task.status?.state).toBe(
      TaskState.TASK_STATE_COMPLETED,
    );
    const scoutArtifact = firstArtifact(recoveredScout.rawTask);
    await verifyArtifact("warden", scoutArtifact);
    expect(
      ArtifactMetadataSchema.parse(
        requiredRecord(
          requiredRecord(scoutArtifact, "metadata"),
          COMMITMENT_V1_EXTENSION_URI,
        ),
      ).artifactType,
    ).toBe("accessibility-findings");

    const changedScope = await send(
      "warden",
      recoveryRequest({
        findings,
        originalRole: "scribe",
        replacementRole: "scribe",
        replacementAssignmentDigest: "Z".repeat(43),
      }),
    );
    expect(changedScope.task.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(changedScope.task.artifacts).toEqual([]);
    expect(changedScope.task.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value:
        "Recovery must preserve the exact role, slot, pact, and assignment digest.",
    });
  });

  it("rejects unsafe public input before reserving its message ID", async () => {
    const syntheticMatch = `sk-proj-${"S".repeat(28)}`;
    const unsafe = assignmentRequest("scout", SCOUT_SLOT, {
      fixtureId: ACCESSIBILITY_FIXTURE_ID,
      kind: "role-assignment",
      protocol: "commitment/v1",
      role: "scout",
      diagnostic: syntheticMatch,
    });
    const hosted = createAgentWorker("scout", {
      now: () => new Date(COMPLETED_AT),
    });
    const env = {
      HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS.scout),
    };
    const rejected = await hosted.fetch(wireRequest("scout", unsafe), env);
    expect(rejected.status).toBe(400);
    const rejectedText = await rejected.text();
    expect(rejectedText).not.toContain(syntheticMatch);
    expect(rejectedText).toContain("INVALID_PARAMS");

    const safeBase = assignmentRequest("scout", SCOUT_SLOT, {
      fixtureId: ACCESSIBILITY_FIXTURE_ID,
      kind: "role-assignment",
      protocol: "commitment/v1",
      role: "scout",
    });
    const safe = {
      ...safeBase,
      message: { ...safeBase.message, messageId: unsafe.message.messageId },
    } satisfies OfficialSendMessageRequest;
    const accepted = await hosted.fetch(wireRequest("scout", safe), env);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      task: { status: { state: "TASK_STATE_COMPLETED" } },
    });
  });
});

async function readCard(kind: HostedAgentKind): Promise<{
  readonly kind: HostedAgentKind;
  readonly card: OfficialAgentCard;
  readonly identity: Record<string, unknown>;
}> {
  const response = await callWorker(
    kind,
    new Request(`${origins[kind]}/.well-known/agent-card.json`),
    false,
  );
  expect(response.status).toBe(200);
  const raw: unknown = await response.json();
  const card = AgentCard.fromJSON(raw);
  const rawCard = asRecord(raw);
  const capabilities = requiredRecord(rawCard, "capabilities");
  const extension = requiredArray(capabilities, "extensions")
    .map(asRecord)
    .find((candidate) => candidate.uri === COMMITMENT_V1_EXTENSION_URI);
  expect(extension).toBeDefined();
  return {
    kind,
    card,
    identity: requiredRecord(extension!, "params"),
  };
}

async function send(
  kind: HostedAgentKind,
  body: OfficialSendMessageRequest,
): Promise<{
  readonly response: Response;
  readonly rawTask: Record<string, unknown>;
  readonly task: Task;
}> {
  const response = await callWorker(
    kind,
    new Request(`${origins[kind]}/a2a/v1/message:send`, {
      method: "POST",
      headers: {
        [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
        "Content-Type": A2A_CONTENT_TYPE,
      },
      body: JSON.stringify(SendMessageRequest.toJSON(body)),
    }),
  );
  const raw: unknown = await response.json();
  const rawTask = requiredRecord(asRecord(raw), "task");
  return { response, rawTask, task: Task.fromJSON(rawTask) };
}

function wireRequest(
  kind: HostedAgentKind,
  body: OfficialSendMessageRequest,
): Request {
  return new Request(`${origins[kind]}/a2a/v1/message:send`, {
    method: "POST",
    headers: {
      [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      "Content-Type": A2A_CONTENT_TYPE,
    },
    body: JSON.stringify(SendMessageRequest.toJSON(body)),
  });
}

function assignmentRequest(
  role: "scout" | "scribe",
  roleSlotId: string,
  data: unknown,
): OfficialSendMessageRequest {
  return officialRequest("execute-role", roleSlotId, data);
}

function recoveryRequest(input: {
  readonly findings: readonly unknown[];
  readonly originalRole: "scout" | "scribe";
  readonly replacementRole: "scout" | "scribe";
  readonly replacementAssignmentDigest: string;
}): OfficialSendMessageRequest {
  return officialRequest("recover-role", SCRIBE_SLOT, {
    findings: input.findings,
    fixtureId: ACCESSIBILITY_FIXTURE_ID,
    kind: "role-recovery",
    originalAssignment: {
      assignmentDigest: ASSIGNMENT_DIGEST,
      pactDigest: PACT_DIGEST,
      role: input.originalRole,
      roleSlotId: SCRIBE_SLOT,
    },
    protocol: "commitment/v1",
    replacement: {
      assignmentDigest: input.replacementAssignmentDigest,
      pactDigest: PACT_DIGEST,
      predecessorAgentId: PREDECESSOR_ID,
      role: input.replacementRole,
      roleSlotId: SCRIBE_SLOT,
    },
  });
}

function officialRequest(
  action: "execute-role" | "recover-role",
  roleSlotId: string,
  data: unknown,
): OfficialSendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId: MISSION_ID,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "data", value: data },
          metadata: undefined,
          filename: "assignment.json",
          mediaType: "application/json",
        },
      ],
      metadata: {
        [COMMITMENT_V1_EXTENSION_URI]: {
          action,
          missionId: MISSION_ID,
          pactDigest: PACT_DIGEST,
          protocol: "commitment/v1",
          roleSlotId,
        },
      },
      extensions: [COMMITMENT_V1_EXTENSION_URI],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ["application/json"],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: false,
    },
    metadata: undefined,
  };
}

async function callWorker(
  kind: HostedAgentKind,
  request: Request,
  includeSecret = true,
): Promise<Response> {
  return workers[kind].fetch(
    request,
    includeSecret
      ? {
          HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS[kind]),
        }
      : {},
  );
}

async function getTask(kind: HostedAgentKind, taskId: string): Promise<Task> {
  const response = await callWorker(
    kind,
    new Request(`${origins[kind]}/a2a/v1/tasks/${taskId}`, {
      headers: {
        [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      },
    }),
  );
  expect(response.status).toBe(200);
  return Task.fromJSON(await response.json());
}

function fixedNow(): Date {
  return new Date(COMPLETED_AT);
}

async function verifyArtifact(
  kind: HostedAgentKind,
  artifact: Record<string, unknown>,
): Promise<void> {
  const metadata = ArtifactMetadataSchema.parse(
    requiredRecord(
      requiredRecord(artifact, "metadata"),
      COMMITMENT_V1_EXTENSION_URI,
    ),
  );
  const identity = buildAgentCard(kind, origins[kind]).capabilities
    .extensions[0]?.params;
  expect(metadata.producingAgentId).toBe(
    requiredString(identity ?? {}, "agentId"),
  );
  const data = artifactData(artifact);
  expect(metadata.contentDigest).toBe(await canonicalJsonDigest(data));
  expect(metadata.completedAt).toBe(COMPLETED_AT);
  const publicArtifact = await callWorker(
    kind,
    new Request(metadata.publicLocation),
    false,
  );
  expect(publicArtifact.status).toBe(200);
  expect(await publicArtifact.json()).toEqual(data);
  const publicJwk = requiredRecord(identity, "publicJwk");
  const verificationKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const proof = artifactSigningBytes(
    metadata.pactDigest,
    metadata.contentDigest,
  );
  const proofBuffer = new ArrayBuffer(proof.byteLength);
  new Uint8Array(proofBuffer).set(proof);
  const signature = decodeBase64Url(metadata.signature);
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      verificationKey,
      signature,
      proofBuffer,
    ),
  ).toBe(true);
}

function firstArtifact(task: Record<string, unknown>): Record<string, unknown> {
  return asRecord(requiredArray(task, "artifacts")[0]);
}

function artifactData(
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  const part = asRecord(requiredArray(artifact, "parts")[0]);
  return requiredRecord(part, "data");
}

function taskExtension(task: Record<string, unknown>): Record<string, unknown> {
  return requiredRecord(
    requiredRecord(task, "metadata"),
    COMMITMENT_V1_EXTENSION_URI,
  );
}

function fixtureFindings(): readonly Record<string, unknown>[] {
  return parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Expected an object.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  if (value === undefined) throw new TypeError(`${key} is unavailable.`);
  return asRecord(value[key]);
}

function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) throw new TypeError(`${key} is not an array.`);
  return candidate;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string")
    throw new TypeError(`${key} is not a string.`);
  return candidate;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
