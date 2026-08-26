import { describe, expect, it, vi } from "vitest";
import {
  AgentCard as OfficialAgentCard,
  SendMessageResponse as OfficialSendMessageResponse,
  Task as OfficialTask,
} from "@a2a-js/sdk";

import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2AProtocolError,
  A2APublicInputRejectedError,
  A2A_VERSION_HEADER,
  A2ATaskExecutionError,
  COMMITMENT_V1_EXTENSION_URI,
  createA2AAgentCard,
  createA2AHttpJsonClient,
  createA2AWorker,
  type A2AExecutionContext,
  type A2AExecutionResult,
  type A2ASendMessageRequest,
  type A2ATask,
  type A2ATaskExecutor,
  type A2ATaskStore,
} from "../../packages/a2a-worker/src/index.js";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "command-1";
const NOW = new Date("2026-08-26T12:00:00.000Z");
const ARTIFACT_ID = "c0000000-0000-4000-8000-000000000001";
const canonicalArtifactMetadata = {
  protocol: "commitment/v1",
  kind: "artifact-metadata",
  artifactId: ARTIFACT_ID,
  missionId: MISSION_ID,
  pactDigest: "A".repeat(43),
  roleSlotId: "c0000000-0000-4000-8000-000000000002",
  producingAgentId: "c0000000-0000-4000-8000-000000000003",
  keyId: "c0000000-0000-4000-8000-000000000004",
  attempt: 1,
  artifactType: "accessibility-findings",
  mediaType: "application/json",
  publicLocation: "https://agent.test/artifacts/findings.json",
  contentDigest: "B".repeat(43),
  signature: "C".repeat(86),
  safetyStatus: "approved",
  completedAt: NOW.toISOString(),
} as const;

const validSendRequest: A2ASendMessageRequest = {
  message: {
    messageId: MESSAGE_ID,
    contextId: MISSION_ID,
    role: "ROLE_USER",
    parts: [
      {
        data: {
          artifactId: "artifact-input-1",
          summary: "Create the deterministic accessibility findings.",
        },
        mediaType: "application/json",
      },
    ],
    extensions: [COMMITMENT_V1_EXTENSION_URI],
    metadata: {
      [COMMITMENT_V1_EXTENSION_URI]: {
        protocol: "commitment/v1",
        action: "guild.submit_artifact",
        missionId: MISSION_ID,
        missionVersion: 1,
        pactVersion: 1,
      },
    },
  },
  configuration: {
    acceptedOutputModes: ["application/json"],
    historyLength: 8,
    returnImmediately: false,
  },
};

function buildCard() {
  return createA2AAgentCard({
    name: "Guildhall Scout",
    description: "Produces deterministic accessibility findings.",
    version: "1.0.0",
    endpointUrl: "https://agent.test/a2a/v1",
    provider: { organization: "Guildhall", url: "https://agent.test" },
    skills: [
      {
        id: "accessibility-findings",
        name: "Accessibility Findings",
        description: "Creates structured accessibility findings.",
        tags: ["accessibility", "deterministic"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  });
}

function successfulExecution(): A2AExecutionResult {
  return {
    artifacts: [
      {
        artifactId: ARTIFACT_ID,
        name: "Accessibility findings",
        parts: [
          {
            data: { findings: [{ ruleId: "button-name", count: 1 }] },
            mediaType: "application/json",
          },
        ],
        metadata: {
          producerAgentId: "scout-1",
          [COMMITMENT_V1_EXTENSION_URI]: canonicalArtifactMetadata,
        },
      },
    ],
    taskMetadata: { executor: "deterministic-fixture" },
  };
}

function createHarness(
  implementation: (
    context: A2AExecutionContext,
  ) => Promise<A2AExecutionResult> = async () => successfulExecution(),
) {
  const execute = vi.fn(implementation);
  const executor: A2ATaskExecutor = { execute };
  const worker = createA2AWorker({
    agentCard: buildCard(),
    executor,
    basePath: "/a2a/v1",
    idFactory: () => "task-1",
    now: () => NOW,
  });
  return { execute, worker };
}

function protocolHeaders(
  options: { version?: string | null; extension?: boolean } = {},
): Headers {
  const headers = new Headers({ "Content-Type": A2A_CONTENT_TYPE });
  const version =
    options.version === undefined ? A2A_PROTOCOL_VERSION : options.version;
  if (version !== null) headers.set(A2A_VERSION_HEADER, version);
  if (options.extension !== false) {
    headers.set(A2A_EXTENSIONS_HEADER, COMMITMENT_V1_EXTENSION_URI);
  }
  return headers;
}

function send(
  worker: ReturnType<typeof createA2AWorker>,
  body: unknown = validSendRequest,
  headers = protocolHeaders(),
): Promise<Response> {
  return worker.fetch(
    new Request("https://agent.test/a2a/v1/message:send", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function errorReason(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as {
    error?: { details?: Array<{ reason?: string }> };
  };
  return body.error?.details?.find(({ reason }) => reason !== undefined)
    ?.reason;
}

describe("Workers-native A2A 1.0 HTTP+JSON adapter", () => {
  it("serves a valid v1 Agent Card with the required commitment extension", async () => {
    const { worker } = createHarness();
    const response = await worker.fetch(
      new Request(`https://agent.test${A2A_AGENT_CARD_PATH}`),
    );
    const card = (await response.json()) as ReturnType<typeof buildCard>;

    expect(response.status).toBe(200);
    expect(response.headers.get(A2A_VERSION_HEADER)).toBe("1.0");
    expect(response.headers.get(A2A_EXTENSIONS_HEADER)).toBe(
      COMMITMENT_V1_EXTENSION_URI,
    );
    expect(card.supportedInterfaces).toContainEqual(
      expect.objectContaining({
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      }),
    );
    expect(card.capabilities).toMatchObject({
      streaming: false,
      pushNotifications: false,
      extensions: [
        expect.objectContaining({
          uri: COMMITMENT_V1_EXTENSION_URI,
          required: true,
        }),
      ],
    });
    expect(OfficialAgentCard.toJSON(OfficialAgentCard.fromJSON(card))).toEqual(
      expect.objectContaining({
        name: card.name,
        supportedInterfaces: expect.arrayContaining([
          expect.objectContaining({ protocolVersion: "1.0" }),
        ]),
      }),
    );
  });

  it("returns and stores official Task/Artifact shapes without claiming mission verification", async () => {
    const { execute, worker } = createHarness();
    const response = await send(worker);
    const { task } = (await response.json()) as { task: A2ATask };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(A2A_CONTENT_TYPE);
    expect(response.headers.get(A2A_EXTENSIONS_HEADER)).toBe(
      COMMITMENT_V1_EXTENSION_URI,
    );
    expect(task).toMatchObject({
      id: "task-1",
      contextId: MISSION_ID,
      status: { state: "TASK_STATE_COMPLETED", timestamp: NOW.toISOString() },
      artifacts: [
        expect.objectContaining({
          artifactId: ARTIFACT_ID,
          parts: [expect.objectContaining({ data: expect.any(Object) })],
          extensions: [COMMITMENT_V1_EXTENSION_URI],
        }),
      ],
    });
    expect(task.metadata[COMMITMENT_V1_EXTENSION_URI]).toMatchObject({
      a2aTaskState: "TASK_STATE_COMPLETED",
      guildMissionVerification: "PENDING",
    });
    expect(task.artifacts[0]?.metadata?.[COMMITMENT_V1_EXTENSION_URI]).toEqual(
      canonicalArtifactMetadata,
    );
    expect(JSON.stringify(task)).not.toContain(
      '"guildMissionVerification":"PASSED"',
    );
    expect(OfficialTask.toJSON(OfficialTask.fromJSON(task))).toMatchObject({
      id: task.id,
      contextId: task.contextId,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.any(Request),
        taskId: "task-1",
        contextId: MISSION_ID,
        commitment: expect.objectContaining({
          protocol: "commitment/v1",
          action: "guild.submit_artifact",
        }),
      }),
    );

    const retrieved = await worker.fetch(
      new Request("https://agent.test/a2a/v1/tasks/task-1", {
        headers: protocolHeaders(),
      }),
    );
    expect(await retrieved.json()).toEqual(task);
  });

  it.each([
    ["missing", null],
    ["unsupported", "0.3"],
  ])(
    "rejects %s A2A versions with VersionNotSupportedError",
    async (_label, version) => {
      const { worker } = createHarness();
      const response = await send(
        worker,
        validSendRequest,
        protocolHeaders({ version }),
      );

      expect(response.status).toBe(400);
      expect(await errorReason(response)).toBe("VERSION_NOT_SUPPORTED");
    },
  );

  it("rejects a missing required extension declaration", async () => {
    const { worker } = createHarness();
    const response = await send(
      worker,
      validSendRequest,
      protocolHeaders({ extension: false }),
    );

    expect(response.status).toBe(400);
    expect(await errorReason(response)).toBe("EXTENSION_SUPPORT_REQUIRED");
  });

  it("rejects malformed Parts with structured BadRequest details", async () => {
    const { execute, worker } = createHarness();
    const malformed = structuredClone(validSendRequest) as {
      message: { parts: unknown[] };
    };
    malformed.message.parts = [{ text: "ambiguous", data: { action: "work" } }];
    const response = await send(worker, malformed);
    const body = (await response.json()) as {
      error: {
        details: Array<{ "@type": string; fieldViolations?: unknown[] }>;
      };
    };

    expect(response.status).toBe(400);
    expect(body.error.details).toContainEqual(
      expect.objectContaining({
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: expect.any(Array),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects missing namespaced commitment metadata and legacy blocking", async () => {
    const { worker } = createHarness();
    const missingMetadata = structuredClone(validSendRequest) as {
      message: { metadata: Record<string, unknown> };
    };
    missingMetadata.message.metadata = {};
    const metadataResponse = await send(worker, missingMetadata);
    expect(metadataResponse.status).toBe(400);
    expect(await errorReason(metadataResponse)).toBe("INVALID_PARAMS");

    const legacy = structuredClone(validSendRequest) as {
      configuration: Record<string, unknown>;
    };
    legacy.configuration.blocking = true;
    const legacyResponse = await send(worker, legacy);
    expect(legacyResponse.status).toBe(400);
    expect(await errorReason(legacyResponse)).toBe("INVALID_PARAMS");
  });

  it("maps a public-safe executor error to a valid FAILED Task", async () => {
    const { worker } = createHarness(async () => {
      throw new A2ATaskExecutionError("Controlled fixture failure.", {
        code: "CONTROLLED_FAILURE",
      });
    });
    const response = await send(worker);
    const { task } = (await response.json()) as { task: A2ATask };

    expect(response.status).toBe(200);
    expect(task.status).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: expect.objectContaining({ role: "ROLE_AGENT" }),
    });
    expect(task.artifacts).toEqual([]);
    expect(task.metadata).toMatchObject({
      executionErrorCode: "CONTROLLED_FAILURE",
      [COMMITMENT_V1_EXTENSION_URI]: {
        guildMissionVerification: "PENDING",
      },
    });
  });

  it("offers a bounded Fetch client for the v1 HTTP+JSON binding", async () => {
    const { worker } = createHarness();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get(A2A_VERSION_HEADER)).toBe("1.0");
      expect(new Headers(init?.headers).get(A2A_EXTENSIONS_HEADER)).toBe(
        COMMITMENT_V1_EXTENSION_URI,
      );
      expect(init?.redirect).toBe("manual");
      const response = await worker.fetch(new Request(input, init));
      const headers = new Headers(response.headers);
      // Official SDK servers need not echo A2A-Version on responses.
      headers.delete(A2A_VERSION_HEADER);
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    });
    const client = createA2AHttpJsonClient({
      baseUrl: "https://agent.test/a2a/v1",
      fetch: fetchImpl,
      maximumResponseBytes: 32_768,
    });

    const result = await client.sendMessage(validSendRequest);
    if (result.task === undefined) throw new Error("Expected a Task result.");
    const { task } = result;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    await expect(client.getTask(task.id)).resolves.toEqual(task);
  });

  it("normalizes official SDK Task defaults and accepts the Message response oneof", async () => {
    const sdkTask = OfficialTask.toJSON(
      OfficialTask.fromJSON({
        id: "official-task-1",
        contextId: MISSION_ID,
        status: { state: "TASK_STATE_WORKING" },
      }),
    ) as Record<string, unknown>;
    expect(sdkTask).not.toHaveProperty("artifacts");
    expect(sdkTask).not.toHaveProperty("history");
    expect(sdkTask).not.toHaveProperty("metadata");
    expect(sdkTask.status).not.toHaveProperty("timestamp");

    const taskClient = createA2AHttpJsonClient({
      baseUrl: "https://official.test/a2a/v1",
      fetch: async () =>
        Response.json(sdkTask, {
          headers: {
            "Content-Type": "application/json",
            [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
          },
        }),
    });
    await expect(taskClient.getTask("official-task-1")).resolves.toMatchObject({
      artifacts: [],
      history: [],
      metadata: {},
      status: { state: "TASK_STATE_WORKING" },
    });

    const sdkMessageResponse = OfficialSendMessageResponse.toJSON(
      OfficialSendMessageResponse.fromJSON({
        message: {
          messageId: "official-message-1",
          contextId: MISSION_ID,
          role: "ROLE_AGENT",
          parts: [{ text: "Additional input is required." }],
        },
      }),
    );
    const messageClient = createA2AHttpJsonClient({
      baseUrl: "https://official.test/a2a/v1",
      fetch: async () =>
        Response.json(sdkMessageResponse, {
          headers: {
            "Content-Type": "application/json",
            [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
          },
        }),
    });
    const result = await messageClient.sendMessage(validSendRequest);
    expect(result).toEqual({
      message: expect.objectContaining({
        messageId: "official-message-1",
        contextId: MISSION_ID,
        role: "ROLE_AGENT",
        metadata: {},
        extensions: [],
      }),
    });
  });

  it("normalizes official SDK omitted Message context and Artifact name defaults", async () => {
    const directMessageResponse = OfficialSendMessageResponse.toJSON(
      OfficialSendMessageResponse.fromJSON({
        message: {
          messageId: "context-free-message-1",
          role: "ROLE_AGENT",
          parts: [{ text: "A direct response without a context." }],
        },
      }),
    ) as Record<string, unknown>;
    expect(directMessageResponse.message).not.toHaveProperty("contextId");

    const directMessageClient = createA2AHttpJsonClient({
      baseUrl: "https://official.test/a2a/v1",
      fetch: async () =>
        Response.json(directMessageResponse, {
          headers: {
            "Content-Type": "application/json",
            [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
          },
        }),
    });
    await expect(
      directMessageClient.sendMessage(validSendRequest),
    ).resolves.toMatchObject({
      message: { messageId: "context-free-message-1", contextId: "" },
    });

    const unnamedArtifactTask = OfficialTask.toJSON(
      OfficialTask.fromJSON({
        id: "official-task-with-artifact",
        contextId: MISSION_ID,
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [
          {
            artifactId: "official-artifact-1",
            parts: [{ text: "Artifact output." }],
          },
        ],
      }),
    ) as Record<string, unknown>;
    expect(
      (unnamedArtifactTask.artifacts as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("name");

    const unnamedArtifactClient = createA2AHttpJsonClient({
      baseUrl: "https://official.test/a2a/v1",
      fetch: async () =>
        Response.json(unnamedArtifactTask, {
          headers: {
            "Content-Type": "application/json",
            [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
          },
        }),
    });
    await expect(
      unnamedArtifactClient.getTask("official-task-with-artifact"),
    ).resolves.toMatchObject({
      artifacts: [{ artifactId: "official-artifact-1", name: "" }],
    });
  });

  it("enforces secure client origins, JSON responses, deadlines, and nested Task schemas", async () => {
    expect(() =>
      createA2AHttpJsonClient({ baseUrl: "http://agent.test/a2a/v1" }),
    ).toThrow(/HTTPS/u);
    expect(() =>
      createA2AHttpJsonClient({
        baseUrl: "https://agent.test/a2a/v1",
        allowedOrigins: ["https://other.test"],
      }),
    ).toThrow(/not allowed/u);

    const redirectFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.redirect("https://other.test/a2a/v1/tasks/task-1", 302),
    );
    const redirectClient = createA2AHttpJsonClient({
      baseUrl: "https://agent.test/a2a/v1",
      fetch: redirectFetch,
    });
    await expect(redirectClient.getTask("task-1")).rejects.toMatchObject({
      httpStatus: 302,
      message: "A2A redirects are not allowed.",
    });
    expect(redirectFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" }),
    );

    const nonJson = createA2AHttpJsonClient({
      baseUrl: "https://agent.test/a2a/v1",
      fetch: async () =>
        new Response("not json", {
          headers: {
            "Content-Type": "text/plain",
            [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
          },
        }),
    });
    await expect(nonJson.getTask("task-1")).rejects.toThrow(
      /JSON content type/u,
    );

    const invalidTask = createA2AHttpJsonClient({
      baseUrl: "https://agent.test/a2a/v1",
      fetch: async () =>
        Response.json(
          {
            id: "task-1",
            contextId: MISSION_ID,
            status: { state: "NOT_A_STATE", timestamp: NOW.toISOString() },
            artifacts: [],
            history: [],
            metadata: {},
          },
          {
            headers: {
              "Content-Type": A2A_CONTENT_TYPE,
              [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
            },
          },
        ),
    });
    await expect(invalidTask.getTask("task-1")).rejects.toThrow(
      /invalid Task response/u,
    );

    const timeoutClient = createA2AHttpJsonClient({
      baseUrl: "https://agent.test/a2a/v1",
      timeoutMs: 5,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });
    await expect(timeoutClient.getTask("task-1")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("replays identical message IDs and conflicts on changed canonical bytes", async () => {
    const { execute, worker } = createHarness();
    const first = await send(worker);
    const firstBody = (await first.json()) as { task: A2ATask };
    const replay = await send(worker);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(execute).toHaveBeenCalledOnce();

    const changed = structuredClone(validSendRequest) as {
      message: { parts: Array<{ data: Record<string, unknown> }> };
    };
    changed.message.parts[0]!.data.summary = "Changed payload under same ID.";
    const conflict = await send(worker, changed);
    expect(conflict.status).toBe(409);
    expect(await errorReason(conflict)).toBe("INVALID_PARAMS");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects follow-up turns once the referenced A2A Task is terminal", async () => {
    const { execute, worker } = createHarness();
    await send(worker);
    const followUp = structuredClone(validSendRequest) as {
      message: { messageId: string; taskId?: string };
    };
    followUp.message.messageId = "command-2";
    followUp.message.taskId = "task-1";

    const response = await send(worker, followUp);
    expect(response.status).toBe(400);
    expect(await errorReason(response)).toBe("INVALID_PARAMS");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("runs public-safety validation before any Task-store write", async () => {
    const beginMessage = vi.fn(async () => undefined);
    const put = vi.fn(async () => undefined);
    const store: A2ATaskStore = {
      get: vi.fn(async () => undefined),
      getMessage: vi.fn(async () => undefined),
      beginMessage,
      put,
      list: vi.fn(async () => []),
    };
    const execute = vi.fn(async () => successfulExecution());
    const worker = createA2AWorker({
      agentCard: buildCard(),
      executor: { execute },
      taskStore: store,
      basePath: "/a2a/v1",
      validatePublicInput: async () => {
        throw new A2APublicInputRejectedError("Secret-like input rejected.");
      },
    });

    const response = await send(worker);
    expect(response.status).toBe(400);
    expect(await errorReason(response)).toBe("INVALID_PARAMS");
    expect(beginMessage).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("authorizes exact transport input before idempotency persistence", async () => {
    let authorized = false;
    const execute = vi.fn(async () => successfulExecution());
    const authorizeRequest = vi.fn(
      async (context: { bodyText: string; request: Request }) => {
        expect(context.bodyText).toBe(JSON.stringify(validSendRequest));
        expect(context.request.headers.get(A2A_VERSION_HEADER)).toBe("1.0");
        if (!authorized) {
          throw new A2AProtocolError("Authentication required.", {
            httpStatus: 401,
            status: "UNAUTHENTICATED",
            reason: "UNAUTHENTICATED",
          });
        }
      },
    );
    const worker = createA2AWorker({
      agentCard: buildCard(),
      executor: { execute },
      basePath: "/a2a/v1",
      idFactory: () => "task-1",
      now: () => NOW,
      authorizeRequest,
    });

    const denied = await send(worker);
    expect(denied.status).toBe(401);
    expect(await errorReason(denied)).toBe("UNAUTHENTICATED");
    expect(execute).not.toHaveBeenCalled();

    authorized = true;
    const accepted = await send(worker);
    expect(accepted.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(authorizeRequest).toHaveBeenCalledTimes(2);
  });

  it("honors zero history and bounds/filters task listing", async () => {
    const { worker } = createHarness();
    await send(worker);

    const getResponse = await worker.fetch(
      new Request("https://agent.test/a2a/v1/tasks/task-1?historyLength=0", {
        headers: protocolHeaders(),
      }),
    );
    const task = (await getResponse.json()) as A2ATask;
    expect(task.history).toEqual([]);

    const listResponse = await worker.fetch(
      new Request(
        `https://agent.test/a2a/v1/tasks?contextId=${MISSION_ID}&status=TASK_STATE_COMPLETED&pageSize=1&historyLength=0`,
        { headers: protocolHeaders() },
      ),
    );
    const list = (await listResponse.json()) as {
      tasks: A2ATask[];
      pageSize: number;
    };
    expect(list.pageSize).toBe(1);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]?.history).toEqual([]);

    const unsupported = await worker.fetch(
      new Request("https://agent.test/a2a/v1/tasks?pageToken=opaque", {
        headers: protocolHeaders(),
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(await errorReason(unsupported)).toBe("UNSUPPORTED_OPERATION");
  });

  it("returns the dedicated push-notification error", async () => {
    const { worker } = createHarness();
    const response = await worker.fetch(
      new Request(
        "https://agent.test/a2a/v1/tasks/task-1/pushNotificationConfigs",
        { method: "POST", headers: protocolHeaders() },
      ),
    );

    expect(response.status).toBe(400);
    expect(await errorReason(response)).toBe("PUSH_NOTIFICATION_NOT_SUPPORTED");
  });
});
