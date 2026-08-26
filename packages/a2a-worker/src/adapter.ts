import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  COMMITMENT_V1_EXTENSION_URI,
} from "./constants.js";
import {
  A2AProtocolError,
  A2ATaskExecutionError,
  a2aErrorResponse,
  invalidRequest,
} from "./errors.js";
import { InMemoryA2ATaskStore } from "./store.js";
import type {
  A2AArtifact,
  A2AHttpJsonAdapterOptions,
  A2AHttpJsonHandler,
  A2AIdempotencyRecord,
  A2AMessage,
  A2ASendMessageRequest,
  A2ATask,
  A2ATaskState,
  A2ATaskStore,
  A2AWorker,
  CommitmentV1Metadata,
  JsonObject,
} from "./types.js";
import {
  commitmentMetadataFromRequest,
  resolveA2ALimits,
  validateA2AAgentCard,
  validateA2AArtifact,
  validateA2ASendMessageRequest,
} from "./validation.js";

const MISSION_VERIFICATION_PENDING = "PENDING";

export function createA2AHttpJsonHandler(
  options: A2AHttpJsonAdapterOptions,
): A2AHttpJsonHandler {
  const extensionUri =
    options.requiredExtensionUri ?? COMMITMENT_V1_EXTENSION_URI;
  validateA2AAgentCard(options.agentCard, extensionUri);
  const limits = resolveA2ALimits(options.limits);
  const store = options.taskStore ?? new InMemoryA2ATaskStore();
  const basePath = normalizeBasePath(options.basePath ?? "");
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === A2A_AGENT_CARD_PATH) {
        return jsonResponse(options.agentCard, 200, true, extensionUri);
      }

      const relativePath = relativeA2APath(url.pathname, basePath);
      if (relativePath === undefined) {
        return notFoundResponse();
      }
      assertProtocolHeaders(request, extensionUri);

      if (request.method === "POST" && relativePath === "/message:send") {
        assertJsonContentType(request);
        const boundedBody = await readBoundedJson(
          request,
          limits.requestBodyBytes,
        );
        const sendRequest = validateA2ASendMessageRequest(
          boundedBody.value,
          extensionUri,
          limits,
        );
        await options.validatePublicInput?.(sendRequest.message);
        const commitment = commitmentMetadataFromRequest(
          sendRequest,
          extensionUri,
        );
        await options.authorizeRequest?.({
          request,
          bodyText: boundedBody.text,
          message: sendRequest.message,
          commitment,
          signal: request.signal,
        });
        const requestHash = await canonicalRequestHash(sendRequest);
        const task = await executeMessage(
          sendRequest.message,
          commitment,
          request,
          boundedBody.text,
          requestHash,
          options,
          store,
          extensionUri,
          limits,
          idFactory,
          now,
        );
        return jsonResponse({ task }, 200, false, extensionUri);
      }

      if (request.method === "GET" && relativePath === "/tasks") {
        assertSupportedListParameters(url.searchParams);
        const pageSize = boundedQueryInteger(
          url.searchParams.get("pageSize"),
          "pageSize",
          1,
          50,
          20,
        );
        const historyLength = boundedQueryInteger(
          url.searchParams.get("historyLength"),
          "historyLength",
          0,
          limits.historyMessages,
          limits.historyMessages,
        );
        const contextId = optionalQueryIdentifier(
          url.searchParams.get("contextId"),
          "contextId",
        );
        const status = optionalTaskState(url.searchParams.get("status"));
        const storedTasks = await store.list({
          limit: pageSize,
          ...(contextId === undefined ? {} : { contextId }),
          ...(status === undefined ? {} : { status }),
        });
        const tasks = storedTasks.map((task) => ({
          ...task,
          history:
            historyLength === 0 ? [] : task.history.slice(-historyLength),
        }));
        return jsonResponse(
          {
            tasks,
            totalSize: tasks.length,
            pageSize,
            nextPageToken: "",
          },
          200,
          false,
          extensionUri,
        );
      }

      const taskMatch = /^\/tasks\/([^/:]+)$/u.exec(relativePath);
      if (request.method === "GET" && taskMatch !== null) {
        const taskId = decodeTaskId(taskMatch[1]);
        const task = await requireTask(store, taskId);
        const historyLength = boundedQueryInteger(
          url.searchParams.get("historyLength"),
          "historyLength",
          0,
          limits.historyMessages,
          limits.historyMessages,
        );
        return jsonResponse(
          {
            ...task,
            history:
              historyLength === 0 ? [] : task.history.slice(-historyLength),
          },
          200,
          false,
          extensionUri,
        );
      }

      const cancelMatch = /^\/tasks\/([^/:]+):cancel$/u.exec(relativePath);
      if (request.method === "POST" && cancelMatch !== null) {
        const task = await requireTask(store, decodeTaskId(cancelMatch[1]));
        throw new A2AProtocolError(
          "Tasks executed by this blocking adapter cannot be canceled.",
          {
            httpStatus: 400,
            status: "FAILED_PRECONDITION",
            reason: "TASK_NOT_CANCELABLE",
            metadata: { taskId: task.id },
          },
        );
      }

      if (relativePath.includes("/pushNotificationConfigs")) {
        throw new A2AProtocolError("Push notifications are not supported.", {
          httpStatus: 400,
          status: "FAILED_PRECONDITION",
          reason: "PUSH_NOTIFICATION_NOT_SUPPORTED",
        });
      }
      if (
        relativePath === "/message:stream" ||
        relativePath.endsWith(":subscribe") ||
        relativePath === "/extendedAgentCard"
      ) {
        throw new A2AProtocolError("This operation is not supported.", {
          httpStatus: 400,
          status: "FAILED_PRECONDITION",
          reason: "UNSUPPORTED_OPERATION",
        });
      }
      return notFoundResponse();
    } catch (error: unknown) {
      if (error instanceof A2AProtocolError) return a2aErrorResponse(error);
      console.error(
        JSON.stringify({
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: "A2A HTTP+JSON adapter failed",
        }),
      );
      return a2aErrorResponse(
        new A2AProtocolError("Internal error.", {
          httpStatus: 500,
          status: "INTERNAL",
          reason: "INTERNAL_ERROR",
        }),
      );
    }
  };
}

export function createA2AWorker(options: A2AHttpJsonAdapterOptions): A2AWorker {
  const handler = createA2AHttpJsonHandler(options);
  return {
    fetch(request: Request): Promise<Response> {
      return handler(request);
    },
  };
}

async function executeMessage(
  message: A2AMessage,
  commitment: CommitmentV1Metadata,
  request: Request,
  bodyText: string,
  requestHash: string,
  options: A2AHttpJsonAdapterOptions,
  store: A2ATaskStore,
  extensionUri: string,
  limits: ReturnType<typeof resolveA2ALimits>,
  idFactory: () => string,
  now: () => Date,
): Promise<A2ATask> {
  const replay = await store.getMessage(message.messageId);
  if (replay !== undefined) {
    return replayTask(store, replay, requestHash);
  }
  const previous =
    message.taskId === undefined
      ? undefined
      : await requireTask(store, message.taskId);
  if (previous !== undefined && isTerminal(previous.status.state)) {
    throw invalidRequest([
      {
        field: "message.taskId",
        description: "Cannot send a follow-up message to a terminal Task.",
      },
    ]);
  }
  if (previous !== undefined && previous.contextId !== message.contextId) {
    throw invalidRequest([
      {
        field: "message.contextId",
        description: "Must match the existing task contextId.",
      },
    ]);
  }
  const taskId = previous?.id ?? generatedId(idFactory(), "taskId");
  const history = [...(previous?.history ?? []), message].slice(
    -limits.historyMessages,
  );
  const submitted: A2ATask = {
    id: taskId,
    contextId: message.contextId,
    status: {
      state: "TASK_STATE_SUBMITTED",
      timestamp: timestamp(now),
    },
    artifacts: previous?.artifacts ?? [],
    history,
    metadata: taskMetadata(commitment, "TASK_STATE_SUBMITTED", extensionUri),
  };
  const racedReplay = await store.beginMessage(submitted, {
    messageId: message.messageId,
    requestHash,
    taskId,
  });
  if (racedReplay !== undefined) {
    return replayTask(store, racedReplay, requestHash);
  }

  try {
    const result = await options.executor.execute({
      request,
      bodyText,
      message,
      taskId,
      contextId: message.contextId,
      commitment,
      signal: request.signal,
    });
    const minimumArtifactCount = commitment.action === "offer-recovery" ? 0 : 1;
    if (
      result.artifacts.length < minimumArtifactCount ||
      result.artifacts.length > limits.artifactsPerTask
    ) {
      throw new A2AProtocolError("Agent returned an invalid Artifact count.", {
        httpStatus: 500,
        status: "INTERNAL",
        reason: "INVALID_AGENT_RESPONSE",
      });
    }
    const artifacts = result.artifacts.map((artifact, index) => {
      validateA2AArtifact(artifact, `artifacts[${index}]`, limits);
      return normalizeArtifact(artifact, commitment, extensionUri);
    });
    const completed: A2ATask = {
      ...submitted,
      status: {
        state: "TASK_STATE_COMPLETED",
        timestamp: timestamp(now),
      },
      artifacts,
      metadata: {
        ...(result.taskMetadata ?? {}),
        ...taskMetadata(commitment, "TASK_STATE_COMPLETED", extensionUri),
      },
    };
    await store.put(completed);
    return completed;
  } catch (error: unknown) {
    if (!(error instanceof A2ATaskExecutionError)) throw error;
    const failureMessage = agentStatusMessage(
      error.message,
      taskId,
      message.contextId,
      extensionUri,
      commitment,
    );
    const failed: A2ATask = {
      ...submitted,
      status: {
        state: "TASK_STATE_FAILED",
        message: failureMessage,
        timestamp: timestamp(now),
      },
      artifacts: [],
      history: [...history, failureMessage].slice(-limits.historyMessages),
      metadata: {
        ...(error.metadata ?? {}),
        ...(error.code === undefined ? {} : { executionErrorCode: error.code }),
        ...taskMetadata(commitment, "TASK_STATE_FAILED", extensionUri),
      },
    };
    await store.put(failed);
    return failed;
  }
}

function normalizeArtifact(
  artifact: A2AArtifact,
  _commitment: CommitmentV1Metadata,
  extensionUri: string,
): A2AArtifact {
  return {
    ...artifact,
    extensions: [...new Set([...(artifact.extensions ?? []), extensionUri])],
    // Artifact metadata may contain a signed canonical object. Never enrich,
    // normalize, or require it at this transport boundary.
    ...(artifact.metadata === undefined ? {} : { metadata: artifact.metadata }),
  };
}

function taskMetadata(
  commitment: CommitmentV1Metadata,
  state: A2ATask["status"]["state"],
  extensionUri: string,
): JsonObject {
  return {
    [extensionUri]: {
      ...commitment,
      a2aTaskState: state,
      guildMissionVerification: MISSION_VERIFICATION_PENDING,
    },
  };
}

function agentStatusMessage(
  text: string,
  taskId: string,
  contextId: string,
  extensionUri: string,
  commitment: CommitmentV1Metadata,
): A2AMessage {
  return {
    messageId: `${taskId}:failure`,
    taskId,
    contextId,
    role: "ROLE_AGENT",
    parts: [{ text, mediaType: "text/plain" }],
    extensions: [extensionUri],
    metadata: taskMetadata(commitment, "TASK_STATE_FAILED", extensionUri),
  };
}

function assertProtocolHeaders(request: Request, extensionUri: string): void {
  const version = request.headers.get(A2A_VERSION_HEADER);
  if (version !== A2A_PROTOCOL_VERSION) {
    throw new A2AProtocolError(
      `A2A protocol version ${version ?? "(missing)"} is not supported.`,
      {
        httpStatus: 400,
        status: "FAILED_PRECONDITION",
        reason: "VERSION_NOT_SUPPORTED",
        metadata: {
          requestedVersion: version ?? "",
          supportedVersions: A2A_PROTOCOL_VERSION,
        },
      },
    );
  }
  const extensions = parseExtensions(
    request.headers.get(A2A_EXTENSIONS_HEADER),
  );
  if (!extensions.includes(extensionUri)) {
    throw new A2AProtocolError(
      `Required extension support was not declared: ${extensionUri}`,
      {
        httpStatus: 400,
        status: "FAILED_PRECONDITION",
        reason: "EXTENSION_SUPPORT_REQUIRED",
        metadata: { requiredExtension: extensionUri },
      },
    );
  }
}

function assertJsonContentType(request: Request): void {
  const mediaType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== A2A_CONTENT_TYPE && mediaType !== "application/json") {
    throw new A2AProtocolError("Incompatible content type.", {
      httpStatus: 400,
      status: "INVALID_ARGUMENT",
      reason: "CONTENT_TYPE_NOT_SUPPORTED",
      metadata: {
        supportedContentTypes: `${A2A_CONTENT_TYPE}, application/json`,
      },
    });
  }
}

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<{ readonly value: unknown; readonly text: string }> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw invalidRequest([
        {
          field: "body",
          description: `Request body cannot exceed ${maximumBytes} bytes.`,
        },
      ]);
    }
  }
  if (request.body === null) {
    throw invalidRequest([
      { field: "body", description: "JSON body is required." },
    ]);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("A2A request body limit exceeded.");
        throw invalidRequest([
          {
            field: "body",
            description: `Request body cannot exceed ${maximumBytes} bytes.`,
          },
        ]);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: JSON.parse(text) as unknown, text };
  } catch {
    throw invalidRequest([
      { field: "body", description: "Invalid UTF-8 JSON payload." },
    ]);
  }
}

async function requireTask(
  store: A2ATaskStore,
  taskId: string,
): Promise<A2ATask> {
  const task = await store.get(taskId);
  if (task === undefined) {
    throw new A2AProtocolError("Task not found.", {
      httpStatus: 404,
      status: "NOT_FOUND",
      reason: "TASK_NOT_FOUND",
      metadata: { taskId },
    });
  }
  return task;
}

function boundedQueryInteger(
  value: string | null,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest([
      {
        field,
        description: `Must be an integer between ${minimum} and ${maximum}.`,
      },
    ]);
  }
  return parsed;
}

function assertSupportedListParameters(parameters: URLSearchParams): void {
  const supported = new Set([
    "pageSize",
    "historyLength",
    "contextId",
    "status",
  ]);
  for (const key of new Set(parameters.keys())) {
    if (supported.has(key)) continue;
    throw new A2AProtocolError(
      `Task list parameter ${key} is not supported by this adapter.`,
      {
        httpStatus: 400,
        status: "FAILED_PRECONDITION",
        reason: "UNSUPPORTED_OPERATION",
        metadata: { parameter: key },
      },
    );
  }
}

function optionalQueryIdentifier(
  value: string | null,
  field: string,
): string | undefined {
  if (value === null) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw invalidRequest([
      { field, description: "Contains unsupported identifier characters." },
    ]);
  }
  return value;
}

function optionalTaskState(value: string | null): A2ATaskState | undefined {
  if (value === null) return undefined;
  const states = new Set<A2ATaskState>([
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
  ]);
  if (!states.has(value as A2ATaskState)) {
    throw invalidRequest([
      { field: "status", description: "Is not a valid A2A TaskState." },
    ]);
  }
  return value as A2ATaskState;
}

async function replayTask(
  store: A2ATaskStore,
  record: A2AIdempotencyRecord,
  requestHash: string,
): Promise<A2ATask> {
  if (record.requestHash !== requestHash) {
    throw new A2AProtocolError(
      "messageId was already used with a different canonical request.",
      {
        httpStatus: 409,
        status: "ALREADY_EXISTS",
        reason: "INVALID_PARAMS",
        metadata: { messageId: record.messageId },
      },
    );
  }
  const task = await store.get(record.taskId);
  if (task === undefined) {
    throw new A2AProtocolError("Idempotency record has no stored Task.", {
      httpStatus: 500,
      status: "INTERNAL",
      reason: "INTERNAL_ERROR",
    });
  }
  return task;
}

async function canonicalRequestHash(
  request: A2ASendMessageRequest,
): Promise<string> {
  const canonical = stableJson(request);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const binary = Array.from(new Uint8Array(digest), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function decodeTaskId(value: string | undefined): string {
  try {
    return generatedId(decodeURIComponent(value ?? ""), "taskId");
  } catch (error: unknown) {
    if (error instanceof A2AProtocolError) throw error;
    throw invalidRequest([
      { field: "taskId", description: "Invalid task ID." },
    ]);
  }
}

function generatedId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new A2AProtocolError(`Invalid ${field} generated by adapter.`, {
      httpStatus: 500,
      status: "INTERNAL",
      reason: "INTERNAL_ERROR",
    });
  }
  return value;
}

function timestamp(now: () => Date): string {
  const date = now();
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("A2A adapter clock returned an invalid Date.");
  }
  return date.toISOString();
}

function parseExtensions(value: string | null): readonly string[] {
  if (value === null || value.length > 8_192) return [];
  return value
    .split(",")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
}

function normalizeBasePath(value: string): string {
  if (value === "" || value === "/") return "";
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("A2A basePath must be an absolute URL path.");
  }
  return value.replace(/\/+$/u, "");
}

function relativeA2APath(
  pathname: string,
  basePath: string,
): string | undefined {
  if (basePath === "") return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : undefined;
}

function isTerminal(state: A2ATask["status"]["state"]): boolean {
  return [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(state);
}

function jsonResponse(
  body: unknown,
  status = 200,
  cacheable = false,
  extensionUri: string = COMMITMENT_V1_EXTENSION_URI,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": cacheable ? "public, max-age=60" : "no-store",
      "Content-Type": A2A_CONTENT_TYPE,
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      [A2A_EXTENSIONS_HEADER]: extensionUri,
    },
  });
}

function notFoundResponse(): Response {
  return a2aErrorResponse(
    new A2AProtocolError("Route not found.", {
      httpStatus: 404,
      status: "NOT_FOUND",
      reason: "UNSUPPORTED_OPERATION",
    }),
  );
}
