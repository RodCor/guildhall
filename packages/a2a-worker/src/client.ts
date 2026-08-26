import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  COMMITMENT_V1_EXTENSION_URI,
} from "./constants.js";
import type {
  A2AArtifact,
  A2AClientCallOptions,
  A2AErrorStatus,
  A2AHttpJsonClient,
  A2AHttpJsonClientOptions,
  A2AMessage,
  A2APart,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2ATask,
  A2ATaskState,
  JsonObject,
} from "./index.js";
import { validateA2ASendMessageRequest } from "./validation.js";

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 131_072;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAXIMUM_TIMEOUT_MS = 300_000;
const TASK_STATES = new Set([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export class A2AClientResponseError extends Error {
  readonly httpStatus: number;
  readonly status?: A2AErrorStatus;

  constructor(httpStatus: number, message: string, status?: A2AErrorStatus) {
    super(message);
    this.name = "A2AClientResponseError";
    this.httpStatus = httpStatus;
    if (status !== undefined) this.status = status;
  }
}

/** Fetch-native bounded client aligned with the official v1 HTTP+JSON binding. */
export function createA2AHttpJsonClient(
  options: A2AHttpJsonClientOptions,
): A2AHttpJsonClient {
  const endpoint = new URL(options.baseUrl);
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError(
      "A2A client baseUrl cannot include credentials, a query, or a fragment.",
    );
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && options.allowInsecureHttp === true)
  ) {
    throw new TypeError(
      "A2A client baseUrl must use HTTPS (or explicitly allow insecure HTTP).",
    );
  }
  assertAllowedOrigin(endpoint, options.allowedOrigins);
  const baseUrl = endpoint.href.replace(/\/+$/u, "");
  const extensionUri = options.extensionUri ?? COMMITMENT_V1_EXTENSION_URI;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maximumResponseBytes =
    options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new RangeError("maximumResponseBytes must be a positive integer.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAXIMUM_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer between 1 and ${MAXIMUM_TIMEOUT_MS}.`,
    );
  }

  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const { signal, dispose } = deadlineSignal(init.signal, timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal,
        headers: {
          Accept: A2A_CONTENT_TYPE,
          [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
          [A2A_EXTENSIONS_HEADER]: extensionUri,
          ...(init.body === undefined
            ? {}
            : { "Content-Type": A2A_CONTENT_TYPE }),
          ...headersRecord(init.headers),
        },
      });
      if (response.status >= 300 && response.status < 400) {
        throw new A2AClientResponseError(
          response.status,
          "A2A redirects are not allowed.",
        );
      }
      assertJsonContentType(response);
      const body = await readBoundedResponseJson(
        response,
        maximumResponseBytes,
      );
      if (!response.ok) {
        const status = isA2AErrorStatus(body) ? body : undefined;
        throw new A2AClientResponseError(
          response.status,
          status?.error.message ??
            `A2A HTTP request failed with ${response.status}.`,
          status,
        );
      }
      const responseVersion = response.headers.get(A2A_VERSION_HEADER);
      if (
        responseVersion !== null &&
        responseVersion !== A2A_PROTOCOL_VERSION
      ) {
        throw new A2AClientResponseError(
          response.status,
          `A2A response declared unsupported protocol version ${responseVersion}.`,
        );
      }
      const responseExtensions = response.headers
        .get(A2A_EXTENSIONS_HEADER)
        ?.split(",")
        .map((value) => value.trim());
      if (responseExtensions?.includes(extensionUri) !== true) {
        throw new A2AClientResponseError(
          response.status,
          "A2A response did not confirm the required extension.",
        );
      }
      return body;
    } finally {
      dispose();
    }
  };

  return {
    async sendMessage(
      request: A2ASendMessageRequest,
      callOptions: A2AClientCallOptions = {},
    ): Promise<A2ASendMessageResponse> {
      validateA2ASendMessageRequest(request, extensionUri);
      const body = await call("/message:send", {
        method: "POST",
        body: JSON.stringify(request),
        ...(callOptions.signal === undefined
          ? {}
          : { signal: callOptions.signal }),
      });
      const record = asRecord(body);
      const task = normalizeTask(record?.task);
      const message = normalizeMessage(record?.message);
      if ((task === undefined) === (message === undefined)) {
        throw new A2AClientResponseError(
          200,
          "A2A agent returned an invalid SendMessage response.",
        );
      }
      return task === undefined ? { message: message! } : { task };
    },

    async getTask(
      taskId: string,
      callOptions: A2AClientCallOptions = {},
    ): Promise<A2ATask> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId)) {
        throw new TypeError("Invalid A2A task ID.");
      }
      const body = await call(`/tasks/${encodeURIComponent(taskId)}`, {
        method: "GET",
        ...(callOptions.signal === undefined
          ? {}
          : { signal: callOptions.signal }),
      });
      const task = normalizeTask(body);
      if (task === undefined) {
        throw new A2AClientResponseError(
          200,
          "A2A agent returned an invalid Task response.",
        );
      }
      return task;
    },
  };
}

function assertAllowedOrigin(
  endpoint: URL,
  allowedOrigins: readonly string[] | undefined,
): void {
  if (allowedOrigins === undefined) return;
  const normalized = allowedOrigins.map((value) => {
    const candidate = new URL(value);
    if (
      candidate.origin === "null" ||
      candidate.username !== "" ||
      candidate.password !== "" ||
      candidate.pathname !== "/" ||
      candidate.search !== "" ||
      candidate.hash !== ""
    ) {
      throw new TypeError(
        "allowedOrigins entries must be exact HTTP(S) origins.",
      );
    }
    return candidate.origin;
  });
  if (!normalized.includes(endpoint.origin)) {
    throw new TypeError("A2A client baseUrl origin is not allowed.");
  }
}

function deadlineSignal(
  parent: AbortSignal | null | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted === true) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("A2A request timed out.", "TimeoutError"),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function assertJsonContentType(response: Response): void {
  const value = response.headers.get("Content-Type");
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== A2A_CONTENT_TYPE &&
    mediaType !== "application/json" &&
    mediaType?.endsWith("+json") !== true
  ) {
    throw new A2AClientResponseError(
      response.status,
      "A2A response did not use a JSON content type.",
    );
  }
}

async function readBoundedResponseJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new A2AClientResponseError(
      response.status,
      "A2A response exceeded the configured byte limit.",
    );
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("A2A response limit exceeded.");
        throw new A2AClientResponseError(
          response.status,
          "A2A response exceeded the configured byte limit.",
        );
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
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new A2AClientResponseError(
      response.status,
      "A2A response was not valid UTF-8 JSON.",
    );
  }
}

function headersRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function isA2AErrorStatus(value: unknown): value is A2AErrorStatus {
  const root = asRecord(value);
  const error = asRecord(root?.error);
  return (
    typeof error?.code === "number" &&
    typeof error.status === "string" &&
    typeof error.message === "string" &&
    Array.isArray(error.details)
  );
}

function normalizeTask(value: unknown): A2ATask | undefined {
  const task = asRecord(value);
  const status = asRecord(task?.status);
  if (
    !isIdentifier(task?.id) ||
    !isIdentifier(task.contextId) ||
    typeof status?.state !== "string" ||
    !TASK_STATES.has(status.state) ||
    (status.timestamp !== undefined && !isTimestamp(status.timestamp))
  ) {
    return undefined;
  }
  const statusMessage =
    status.message === undefined ? undefined : normalizeMessage(status.message);
  if (status.message !== undefined && statusMessage === undefined) {
    return undefined;
  }
  const artifactValues = task.artifacts ?? [];
  const historyValues = task.history ?? [];
  if (!Array.isArray(artifactValues) || !Array.isArray(historyValues)) {
    return undefined;
  }
  const artifacts = artifactValues.map(normalizeArtifact);
  const history = historyValues.map(normalizeMessage);
  const metadata = task.metadata === undefined ? {} : asRecord(task.metadata);
  if (
    artifacts.some((artifact) => artifact === undefined) ||
    history.some((message) => message === undefined) ||
    metadata === undefined
  ) {
    return undefined;
  }
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: status.state as A2ATaskState,
      ...(statusMessage === undefined ? {} : { message: statusMessage }),
      ...(status.timestamp === undefined
        ? {}
        : { timestamp: status.timestamp as string }),
    },
    artifacts: artifacts as A2AArtifact[],
    history: history as A2AMessage[],
    metadata: metadata as JsonObject,
  };
}

function normalizeArtifact(value: unknown): A2AArtifact | undefined {
  const artifact = asRecord(value);
  if (
    !isIdentifier(artifact?.artifactId) ||
    (artifact.name !== undefined && typeof artifact.name !== "string") ||
    !Array.isArray(artifact.parts) ||
    artifact.parts.length === 0 ||
    (artifact.metadata !== undefined &&
      asRecord(artifact.metadata) === undefined) ||
    (artifact.extensions !== undefined && !isStringArray(artifact.extensions))
  ) {
    return undefined;
  }
  const parts = artifact.parts.map(normalizePart);
  if (parts.some((part) => part === undefined)) return undefined;
  return {
    artifactId: artifact.artifactId,
    name: (artifact.name ?? "") as string,
    ...(typeof artifact.description === "string"
      ? { description: artifact.description }
      : {}),
    parts: parts as A2APart[],
    ...(artifact.metadata === undefined
      ? {}
      : { metadata: artifact.metadata as JsonObject }),
    ...(artifact.extensions === undefined
      ? {}
      : { extensions: artifact.extensions as string[] }),
  };
}

function normalizeMessage(value: unknown): A2AMessage | undefined {
  const message = asRecord(value);
  if (
    !isIdentifier(message?.messageId) ||
    (message.contextId !== undefined &&
      message.contextId !== "" &&
      !isIdentifier(message.contextId)) ||
    (message.taskId !== undefined && !isIdentifier(message.taskId)) ||
    (message.role !== "ROLE_USER" && message.role !== "ROLE_AGENT") ||
    !Array.isArray(message.parts) ||
    message.parts.length === 0 ||
    (message.metadata !== undefined &&
      asRecord(message.metadata) === undefined) ||
    (message.extensions !== undefined && !isStringArray(message.extensions)) ||
    (message.referenceTaskIds !== undefined &&
      !isStringArray(message.referenceTaskIds))
  ) {
    return undefined;
  }
  const parts = message.parts.map(normalizePart);
  if (parts.some((part) => part === undefined)) return undefined;
  return {
    messageId: message.messageId,
    contextId: (message.contextId ?? "") as string,
    ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    role: message.role,
    parts: parts as A2APart[],
    metadata: (message.metadata ?? {}) as JsonObject,
    extensions: (message.extensions ?? []) as string[],
    ...(message.referenceTaskIds === undefined
      ? {}
      : { referenceTaskIds: message.referenceTaskIds as string[] }),
  };
}

function normalizePart(value: unknown): A2APart | undefined {
  const part = asRecord(value);
  if (part === undefined) return undefined;
  const variants = ["text", "raw", "url", "data"].filter((key) =>
    Object.hasOwn(part, key),
  );
  if (
    variants.length !== 1 ||
    (variants[0] === "text" && typeof part.text !== "string") ||
    (variants[0] === "raw" && typeof part.raw !== "string") ||
    (variants[0] === "url" && typeof part.url !== "string") ||
    (variants[0] === "data" && part.data === undefined) ||
    (part.mediaType !== undefined && typeof part.mediaType !== "string") ||
    (part.metadata !== undefined && asRecord(part.metadata) === undefined)
  ) {
    return undefined;
  }
  return part as unknown as A2APart;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
