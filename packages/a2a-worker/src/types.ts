import type { A2ALimits } from "./constants.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

interface A2APartBase {
  readonly filename?: string;
  readonly mediaType?: string;
  readonly metadata?: JsonObject;
}

export interface A2ATextPart extends A2APartBase {
  readonly text: string;
}

export interface A2ARawPart extends A2APartBase {
  /** Base64-encoded bytes on the JSON wire. */
  readonly raw: string;
  readonly mediaType: string;
}

export interface A2AUrlPart extends A2APartBase {
  readonly url: string;
  readonly mediaType: string;
}

export interface A2ADataPart extends A2APartBase {
  readonly data: JsonValue;
  readonly mediaType?: "application/json";
}

export type A2APart = A2ATextPart | A2ARawPart | A2AUrlPart | A2ADataPart;

export interface CommitmentV1Metadata extends JsonObject {
  readonly protocol: "commitment/v1";
  readonly action: string;
  readonly missionId: string;
}

export interface A2AMessage {
  readonly messageId: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly role: "ROLE_USER" | "ROLE_AGENT";
  readonly parts: readonly A2APart[];
  readonly metadata: JsonObject;
  readonly extensions: readonly string[];
  readonly referenceTaskIds?: readonly string[];
}

export interface A2AArtifact {
  readonly artifactId: string;
  readonly name: string;
  readonly description?: string;
  readonly parts: readonly A2APart[];
  readonly metadata?: JsonObject;
  readonly extensions?: readonly string[];
}

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED";

export interface A2ATaskStatus {
  readonly state: A2ATaskState;
  readonly message?: A2AMessage;
  readonly timestamp?: string;
}

export interface A2ATask {
  readonly id: string;
  readonly contextId: string;
  readonly status: A2ATaskStatus;
  readonly artifacts: readonly A2AArtifact[];
  readonly history: readonly A2AMessage[];
  readonly metadata: JsonObject;
}

export interface A2ASendMessageRequest {
  readonly message: A2AMessage;
  readonly configuration?: {
    readonly acceptedOutputModes?: readonly string[];
    readonly taskPushNotificationConfig?: JsonObject;
    readonly historyLength?: number;
    readonly returnImmediately?: boolean;
  };
  readonly metadata?: JsonObject;
}

export type A2ASendMessageResponse =
  | { readonly task: A2ATask; readonly message?: never }
  | { readonly task?: never; readonly message: A2AMessage };

export interface A2AAgentExtension {
  readonly uri: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly params?: JsonObject;
}

export interface A2AAgentInterface {
  readonly url: string;
  readonly protocolBinding: "HTTP+JSON";
  readonly tenant?: string;
  readonly protocolVersion: "1.0";
}

export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
  readonly securityRequirements?: readonly JsonObject[];
}

export interface A2AAgentCard {
  readonly name: string;
  readonly description: string;
  readonly supportedInterfaces: readonly A2AAgentInterface[];
  readonly provider?: {
    readonly organization: string;
    readonly url: string;
  };
  readonly version: string;
  readonly documentationUrl?: string;
  readonly capabilities: {
    readonly streaming: false;
    readonly pushNotifications: false;
    readonly extendedAgentCard?: false;
    readonly extensions: readonly A2AAgentExtension[];
  };
  readonly securitySchemes: JsonObject;
  readonly securityRequirements: readonly JsonObject[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2AAgentSkill[];
  readonly signatures?: readonly JsonObject[];
}

export interface A2AExecutionContext {
  /** Original transport request; use bodyText for its already-consumed body. */
  readonly request: Request;
  /** Exact bounded UTF-8 request body used for transport-signature checks. */
  readonly bodyText: string;
  readonly message: A2AMessage;
  readonly taskId: string;
  readonly contextId: string;
  readonly commitment: CommitmentV1Metadata;
  readonly signal: AbortSignal;
}

export interface A2ARequestAuthorizationContext {
  readonly request: Request;
  /** Exact bounded UTF-8 body used for transport-signature checks. */
  readonly bodyText: string;
  readonly message: A2AMessage;
  readonly commitment: CommitmentV1Metadata;
  readonly signal: AbortSignal;
}

export interface A2AExecutionResult {
  readonly artifacts: readonly A2AArtifact[];
  readonly taskMetadata?: JsonObject;
}

export interface A2ATaskExecutor {
  execute(context: A2AExecutionContext): Promise<A2AExecutionResult>;
}

export interface A2AIdempotencyRecord {
  readonly messageId: string;
  readonly requestHash: string;
  readonly taskId: string;
}

export interface A2ATaskListOptions {
  readonly limit: number;
  readonly contextId?: string;
  readonly status?: A2ATaskState;
}

export interface A2ATaskStore {
  get(taskId: string): Promise<A2ATask | undefined>;
  getMessage(messageId: string): Promise<A2AIdempotencyRecord | undefined>;
  /** Atomically claims a message ID and saves its submitted Task. */
  beginMessage(
    task: A2ATask,
    record: A2AIdempotencyRecord,
  ): Promise<A2AIdempotencyRecord | undefined>;
  put(task: A2ATask): Promise<void>;
  list(options: A2ATaskListOptions): Promise<readonly A2ATask[]>;
}

export interface A2AHttpJsonAdapterOptions {
  readonly agentCard: A2AAgentCard;
  readonly executor: A2ATaskExecutor;
  readonly taskStore?: A2ATaskStore;
  readonly requiredExtensionUri?: string;
  readonly basePath?: string;
  readonly limits?: Partial<A2ALimits>;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  /** Must reject unsafe public content before the adapter writes any Task. */
  readonly validatePublicInput?: (message: A2AMessage) => void | Promise<void>;
  /** Runs before idempotency lookup or persistence; throw A2AProtocolError to deny. */
  readonly authorizeRequest?: (
    context: A2ARequestAuthorizationContext,
  ) => void | Promise<void>;
}

export type A2AHttpJsonHandler = (request: Request) => Promise<Response>;

export interface A2AWorker {
  fetch(request: Request): Promise<Response>;
}

export interface A2AClientCallOptions {
  readonly signal?: AbortSignal;
}

export interface A2AHttpJsonClientOptions {
  readonly baseUrl: string;
  readonly extensionUri?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maximumResponseBytes?: number;
  /** Per-call deadline. Defaults to 15 seconds and may not exceed 5 minutes. */
  readonly timeoutMs?: number;
  /** HTTP is disabled by default; enable only for explicitly trusted local use. */
  readonly allowInsecureHttp?: boolean;
  /** Optional exact-origin allowlist for deployments with stricter egress policy. */
  readonly allowedOrigins?: readonly string[];
}

export interface A2AHttpJsonClient {
  sendMessage(
    request: A2ASendMessageRequest,
    options?: A2AClientCallOptions,
  ): Promise<A2ASendMessageResponse>;
  getTask(taskId: string, options?: A2AClientCallOptions): Promise<A2ATask>;
}
