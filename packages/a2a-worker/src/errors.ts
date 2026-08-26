import { A2A_CONTENT_TYPE, A2A_PROTOCOL_VERSION } from "./constants.js";
import type { JsonObject, JsonValue } from "./types.js";

export interface A2AFieldViolation {
  readonly field: string;
  readonly description: string;
}

export type A2AErrorReason =
  | "INVALID_PARAMS"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELABLE"
  | "PUSH_NOTIFICATION_NOT_SUPPORTED"
  | "UNSUPPORTED_OPERATION"
  | "CONTENT_TYPE_NOT_SUPPORTED"
  | "INVALID_AGENT_RESPONSE"
  | "EXTENSION_SUPPORT_REQUIRED"
  | "VERSION_NOT_SUPPORTED"
  | "UNAUTHENTICATED"
  | "INTERNAL_ERROR";

export interface A2AErrorStatus {
  readonly error: {
    readonly code: number;
    readonly status: string;
    readonly message: string;
    readonly details: readonly JsonObject[];
  };
}

interface A2AProtocolErrorOptions {
  readonly httpStatus: number;
  readonly status: string;
  readonly reason: A2AErrorReason;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly fieldViolations?: readonly A2AFieldViolation[];
}

export class A2AProtocolError extends Error {
  readonly httpStatus: number;
  readonly status: string;
  readonly reason: A2AErrorReason;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly fieldViolations?: readonly A2AFieldViolation[];

  constructor(message: string, options: A2AProtocolErrorOptions) {
    super(message);
    this.name = "A2AProtocolError";
    this.httpStatus = options.httpStatus;
    this.status = options.status;
    this.reason = options.reason;
    if (options.metadata !== undefined) this.metadata = options.metadata;
    if (options.fieldViolations !== undefined) {
      this.fieldViolations = options.fieldViolations;
    }
  }
}

export interface A2ATaskExecutionErrorOptions {
  readonly code?: string;
  readonly metadata?: JsonObject;
}

/** A public-safe executor failure that becomes a valid FAILED A2A Task. */
export class A2ATaskExecutionError extends Error {
  readonly code?: string;
  readonly metadata?: JsonObject;

  constructor(
    publicMessage: string,
    options: A2ATaskExecutionErrorOptions = {},
  ) {
    super(publicMessage);
    this.name = "A2ATaskExecutionError";
    if (options.code !== undefined) this.code = options.code;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }
}

/** Public scanner/policy rejection safe to return without persisting input. */
export class A2APublicInputRejectedError extends A2AProtocolError {
  constructor(publicMessage = "Public input did not pass the safety policy.") {
    super(publicMessage, {
      httpStatus: 400,
      status: "INVALID_ARGUMENT",
      reason: "INVALID_PARAMS",
      fieldViolations: [
        { field: "message", description: "Public input was rejected." },
      ],
    });
    this.name = "A2APublicInputRejectedError";
  }
}

export function invalidRequest(
  fieldViolations: readonly A2AFieldViolation[],
  message = "Request payload validation error",
): A2AProtocolError {
  return new A2AProtocolError(message, {
    httpStatus: 400,
    status: "INVALID_ARGUMENT",
    reason: "INVALID_PARAMS",
    fieldViolations,
  });
}

export function a2aErrorStatus(error: A2AProtocolError): A2AErrorStatus {
  const details: JsonObject[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: error.reason,
      domain: "a2a-protocol.org",
      ...(error.metadata === undefined
        ? {}
        : { metadata: asJsonObject(error.metadata) }),
    },
  ];
  if (error.fieldViolations !== undefined) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: error.fieldViolations.map(({ field, description }) => ({
        field,
        description,
      })),
    });
  }
  return {
    error: {
      code: error.httpStatus,
      status: error.status,
      message: error.message,
      details,
    },
  };
}

export function a2aErrorResponse(error: A2AProtocolError): Response {
  return Response.json(a2aErrorStatus(error), {
    status: error.httpStatus,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": A2A_CONTENT_TYPE,
      "A2A-Version": A2A_PROTOCOL_VERSION,
    },
  });
}

function asJsonObject(value: Readonly<Record<string, string>>): JsonObject {
  return Object.fromEntries(Object.entries(value)) as Record<string, JsonValue>;
}
