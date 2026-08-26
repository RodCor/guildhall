import {
  assertCapabilityInput,
  createCapabilityResultEnvelope,
} from "./capabilities.js";
import {
  guildCapabilityManifest,
  validateGuildCapabilityManifest,
} from "./manifest.js";
import type {
  CapabilityDefinition,
  CapabilityHandler,
  CapabilityReconciler,
  GuildCapabilityName,
  JsonSchema,
  ReconciliationRequest,
} from "./types.js";

export const WEBMCP_INPUT_BYTE_LIMIT = 16_384;

export interface ModelContextTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly untrustedContentHint?: boolean;
  };
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
}

export interface ModelContextLike {
  registerTool(
    tool: ModelContextTool,
    options?: {
      readonly exposedTo?: readonly string[];
      readonly signal?: AbortSignal;
    },
  ): Promise<void>;
}

export interface WebMcpDocumentLike {
  readonly modelContext?: ModelContextLike;
}

export interface RegisterWebMcpOptions {
  readonly document: WebMcpDocumentLike;
  readonly secureContext: boolean;
  readonly handler: CapabilityHandler;
  readonly reconcile?: CapabilityReconciler;
  readonly manifest?: readonly CapabilityDefinition[];
  readonly exposedTo?: readonly string[];
  readonly lifetimeSignal?: AbortSignal;
  readonly createCommandId?: () => string;
  readonly onReconciliationError?: (
    error: unknown,
    request: ReconciliationRequest,
  ) => void;
}

export type WebMcpUnsupportedReason = "insecure-context" | "api-unavailable";

export type WebMcpRegistrationResult =
  | {
      readonly status: "unsupported";
      readonly reason: WebMcpUnsupportedReason;
      readonly registrationCount: 0;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly registrationCount: 0;
    }
  | {
      readonly status: "registered";
      readonly registrationCount: number;
      readonly signal: AbortSignal;
      abort(reason?: unknown): void;
    };

function defaultCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error(
      "A secure randomUUID implementation is required for mutating WebMCP tools.",
    );
  }

  return globalThis.crypto.randomUUID();
}

function asInputRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("WebMCP tool input must be a JSON object.");
  }

  return input as Readonly<Record<string, unknown>>;
}

function withCommandId(
  input: Readonly<Record<string, unknown>>,
  createCommandId: () => string,
): {
  readonly input: Readonly<Record<string, unknown>>;
  readonly commandId: string;
} {
  const supplied = input.commandId;
  const commandId =
    typeof supplied === "string" && supplied.length > 0
      ? supplied
      : createCommandId();

  return {
    commandId,
    input: supplied === commandId ? input : { ...input, commandId },
  };
}

function assertWithinInputLimit(
  input: Readonly<Record<string, unknown>>,
): void {
  const serialized = JSON.stringify(input);
  const byteLength = new TextEncoder().encode(serialized).byteLength;

  if (byteLength > WEBMCP_INPUT_BYTE_LIMIT) {
    throw new RangeError(
      `WebMCP tool input exceeds the ${WEBMCP_INPUT_BYTE_LIMIT}-byte limit.`,
    );
  }
}

function eventSequenceFromData(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }

  const record = data as Readonly<Record<string, unknown>>;
  for (const key of ["sequence", "resultingSequence", "latestSequence"]) {
    const value = record[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  return undefined;
}

function scheduleReconciliation(
  reconcile: CapabilityReconciler | undefined,
  onError: RegisterWebMcpOptions["onReconciliationError"],
  request: ReconciliationRequest,
): void {
  if (reconcile === undefined) {
    return;
  }

  void reconcile(request).catch((error: unknown) => onError?.(error, request));
}

export function toWebMcpTool(
  capability: CapabilityDefinition,
  options: RegisterWebMcpOptions,
): ModelContextTool {
  return {
    name: capability.name,
    title: capability.title,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: {
      readOnlyHint: capability.readOnly,
      untrustedContentHint: capability.untrustedOutput,
    },
    execute: async (rawInput, executionOptions) => {
      const input = asInputRecord(rawInput);
      const command = capability.readOnly
        ? undefined
        : withCommandId(input, options.createCommandId ?? defaultCommandId);
      const canonicalInput = command?.input ?? input;
      assertWithinInputLimit(canonicalInput);
      assertCapabilityInput(capability, canonicalInput);

      let reconcileQueued = false;
      const queueReconciliation = (): void => {
        if (reconcileQueued || command === undefined) {
          return;
        }

        reconcileQueued = true;
        scheduleReconciliation(
          options.reconcile,
          options.onReconciliationError,
          {
            actionName: capability.name,
            canonicalHandlerId: capability.canonicalHandlerId,
            commandId: command.commandId,
          },
        );
      };

      executionOptions.signal.addEventListener("abort", queueReconciliation, {
        once: true,
      });

      try {
        const data = await options.handler(canonicalInput, {
          actionName: capability.name,
          canonicalHandlerId: capability.canonicalHandlerId,
          ...(command === undefined ? {} : { commandId: command.commandId }),
          signal: executionOptions.signal,
          provenance: "webmcp",
          provenanceTrusted: true,
        });
        const eventSequence = eventSequenceFromData(data);
        return createCapabilityResultEnvelope(capability, "webmcp", data, {
          ...(command === undefined ? {} : { commandId: command.commandId }),
          ...(eventSequence === undefined ? {} : { eventSequence }),
        });
      } finally {
        executionOptions.signal.removeEventListener(
          "abort",
          queueReconciliation,
        );
        if (executionOptions.signal.aborted) {
          queueReconciliation();
        }
      }
    },
  };
}

/**
 * Feature-detect and register Guildhall's canonical actions against the current
 * WebMCP draft. Aborting the returned signal unregisters every tool.
 */
export async function registerGuildhallWebMcp(
  options: RegisterWebMcpOptions,
): Promise<WebMcpRegistrationResult> {
  if (!options.secureContext) {
    return {
      status: "unsupported",
      reason: "insecure-context",
      registrationCount: 0,
    };
  }

  const modelContext = options.document.modelContext;
  if (typeof modelContext?.registerTool !== "function") {
    return {
      status: "unsupported",
      reason: "api-unavailable",
      registrationCount: 0,
    };
  }

  const manifest = options.manifest ?? guildCapabilityManifest;
  try {
    validateGuildCapabilityManifest(manifest);
  } catch (error: unknown) {
    return { status: "failed", error, registrationCount: 0 };
  }

  if (options.lifetimeSignal?.aborted === true) {
    return {
      status: "failed",
      error:
        options.lifetimeSignal.reason ??
        new DOMException("WebMCP registration lifetime ended.", "AbortError"),
      registrationCount: 0,
    };
  }

  const controller = new AbortController();
  const abortFromLifetime = (): void =>
    controller.abort(options.lifetimeSignal?.reason);
  options.lifetimeSignal?.addEventListener("abort", abortFromLifetime, {
    once: true,
  });

  try {
    for (const capability of manifest) {
      if (controller.signal.aborted) {
        throw (
          controller.signal.reason ??
          new DOMException("WebMCP registration lifetime ended.", "AbortError")
        );
      }
      await modelContext.registerTool(toWebMcpTool(capability, options), {
        signal: controller.signal,
        ...(options.exposedTo === undefined
          ? {}
          : { exposedTo: options.exposedTo }),
      });
    }
    if (controller.signal.aborted) {
      throw (
        controller.signal.reason ??
        new DOMException("WebMCP registration lifetime ended.", "AbortError")
      );
    }
  } catch (error: unknown) {
    controller.abort(error);
    options.lifetimeSignal?.removeEventListener("abort", abortFromLifetime);
    return { status: "failed", error, registrationCount: 0 };
  }

  return {
    status: "registered",
    registrationCount: manifest.length,
    signal: controller.signal,
    abort(reason?: unknown): void {
      controller.abort(reason);
      options.lifetimeSignal?.removeEventListener("abort", abortFromLifetime);
    },
  };
}

export function isMutatingCapability(name: GuildCapabilityName): boolean {
  return guildCapabilityManifest.some(
    (capability) => capability.name === name && !capability.readOnly,
  );
}
