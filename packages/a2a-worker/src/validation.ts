import {
  COMMITMENT_V1_EXTENSION_URI,
  COMMITMENT_V1_PROTOCOL,
  DEFAULT_A2A_LIMITS,
  type A2ALimits,
} from "./constants.js";
import {
  A2AProtocolError,
  invalidRequest,
  type A2AFieldViolation,
} from "./errors.js";
import type {
  A2AAgentCard,
  A2AArtifact,
  A2APart,
  A2ASendMessageRequest,
  CommitmentV1Metadata,
  JsonObject,
  JsonValue,
} from "./types.js";

export function resolveA2ALimits(
  overrides: Partial<A2ALimits> = {},
): A2ALimits {
  const resolved = { ...DEFAULT_A2A_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`A2A limit ${key} must be a positive safe integer.`);
    }
  }
  return Object.freeze(resolved);
}

export function validateA2AAgentCard(
  value: unknown,
  requiredExtensionUri: string = COMMITMENT_V1_EXTENSION_URI,
): asserts value is A2AAgentCard {
  const issues: A2AFieldViolation[] = [];
  const card = recordAt(value, "agentCard", issues);
  boundedString(card?.name, "name", 120, issues);
  boundedString(card?.description, "description", 2_000, issues);
  boundedString(card?.version, "version", 64, issues);

  const interfaces = arrayAt(card?.supportedInterfaces);
  if (interfaces === undefined || interfaces.length === 0) {
    issues.push(
      violation("supportedInterfaces", "At least one interface is required."),
    );
  } else {
    const hasHttpJsonV1 = interfaces.some((candidate, index) => {
      const item = recordAt(candidate, `supportedInterfaces[${index}]`, issues);
      if (item === undefined) return false;
      boundedHttpUrl(item.url, `supportedInterfaces[${index}].url`, issues);
      return (
        item.protocolBinding === "HTTP+JSON" && item.protocolVersion === "1.0"
      );
    });
    if (!hasHttpJsonV1) {
      issues.push(
        violation(
          "supportedInterfaces",
          "An HTTP+JSON interface with protocolVersion 1.0 is required.",
        ),
      );
    }
  }

  const capabilities = recordAt(card?.capabilities, "capabilities", issues);
  if (capabilities !== undefined) {
    if (capabilities.streaming !== false) {
      issues.push(violation("capabilities.streaming", "Must be false."));
    }
    if (capabilities.pushNotifications !== false) {
      issues.push(
        violation("capabilities.pushNotifications", "Must be false."),
      );
    }
    const extensions = arrayAt(capabilities.extensions);
    const required = extensions?.some((candidate) => {
      const extension = asRecord(candidate);
      return (
        extension?.uri === requiredExtensionUri && extension.required === true
      );
    });
    if (required !== true) {
      issues.push(
        violation(
          "capabilities.extensions",
          `Must declare ${requiredExtensionUri} with required=true.`,
        ),
      );
    }
  }

  stringArray(card?.defaultInputModes, "defaultInputModes", 16, issues);
  stringArray(card?.defaultOutputModes, "defaultOutputModes", 16, issues);
  const skills = arrayAt(card?.skills);
  if (skills === undefined || skills.length === 0 || skills.length > 32) {
    issues.push(violation("skills", "Must contain between 1 and 32 skills."));
  } else {
    skills.forEach((candidate, index) => {
      const skill = recordAt(candidate, `skills[${index}]`, issues);
      if (skill === undefined) return;
      boundedString(skill.id, `skills[${index}].id`, 128, issues);
      boundedString(skill.name, `skills[${index}].name`, 120, issues);
      boundedString(
        skill.description,
        `skills[${index}].description`,
        1_000,
        issues,
      );
      stringArray(skill.tags, `skills[${index}].tags`, 32, issues);
    });
  }

  if (issues.length > 0) throw invalidRequest(issues, "Invalid Agent Card");
}

export function validateA2ASendMessageRequest(
  value: unknown,
  requiredExtensionUri: string = COMMITMENT_V1_EXTENSION_URI,
  limits: A2ALimits = DEFAULT_A2A_LIMITS,
): A2ASendMessageRequest {
  const issues: A2AFieldViolation[] = [];
  const request = recordAt(value, "request", issues);
  const message = recordAt(request?.message, "message", issues);
  if (message !== undefined) {
    boundedIdentifier(message.messageId, "message.messageId", issues);
    boundedIdentifier(message.contextId, "message.contextId", issues);
    if (message.taskId !== undefined) {
      boundedIdentifier(message.taskId, "message.taskId", issues);
    }
    if (message.role !== "ROLE_USER") {
      issues.push(violation("message.role", "Must be ROLE_USER."));
    }
    const extensions = stringArray(
      message.extensions,
      "message.extensions",
      16,
      issues,
    );
    if (extensions?.includes(requiredExtensionUri) !== true) {
      issues.push(
        violation(
          "message.extensions",
          `Must include ${requiredExtensionUri}.`,
        ),
      );
    }

    const metadata = jsonObjectAt(
      message.metadata,
      "message.metadata",
      limits,
      issues,
    );
    const commitment = recordAt(
      metadata?.[requiredExtensionUri],
      `message.metadata[${JSON.stringify(requiredExtensionUri)}]`,
      issues,
    );
    if (commitment !== undefined) {
      if (commitment.protocol !== COMMITMENT_V1_PROTOCOL) {
        issues.push(
          violation(
            `message.metadata[${JSON.stringify(requiredExtensionUri)}].protocol`,
            `Must be ${COMMITMENT_V1_PROTOCOL}.`,
          ),
        );
      }
      boundedString(
        commitment.action,
        `message.metadata[${JSON.stringify(requiredExtensionUri)}].action`,
        120,
        issues,
      );
      boundedIdentifier(
        commitment.missionId,
        `message.metadata[${JSON.stringify(requiredExtensionUri)}].missionId`,
        issues,
      );
      if (
        typeof commitment.missionId === "string" &&
        commitment.missionId !== message.contextId
      ) {
        issues.push(
          violation(
            `message.metadata[${JSON.stringify(requiredExtensionUri)}].missionId`,
            "Must equal message.contextId.",
          ),
        );
      }
    }

    const parts = arrayAt(message.parts);
    if (parts === undefined || parts.length !== 1) {
      issues.push(
        violation(
          "message.parts",
          "The commitment profile requires exactly one structured data Part.",
        ),
      );
    } else {
      validatePart(parts[0], "message.parts[0]", limits, issues, true);
    }
    if (parts !== undefined && parts.length > limits.partsPerMessage) {
      issues.push(
        violation(
          "message.parts",
          `Cannot exceed ${limits.partsPerMessage} parts.`,
        ),
      );
    }
  }

  const configuration = request?.configuration;
  if (configuration !== undefined) {
    const config = recordAt(configuration, "configuration", issues);
    if (config?.acceptedOutputModes !== undefined) {
      stringArray(
        config.acceptedOutputModes,
        "configuration.acceptedOutputModes",
        16,
        issues,
      );
    }
    if (config !== undefined && Object.hasOwn(config, "blocking")) {
      issues.push(
        violation(
          "configuration.blocking",
          "blocking is a legacy field; A2A 1.0 uses returnImmediately.",
        ),
      );
    }
    if (
      config?.returnImmediately !== undefined &&
      typeof config.returnImmediately !== "boolean"
    ) {
      issues.push(
        violation("configuration.returnImmediately", "Must be a boolean."),
      );
    }
    if (config?.returnImmediately === true) {
      throw new A2AProtocolError(
        "returnImmediately is not supported by this blocking adapter.",
        {
          httpStatus: 400,
          status: "FAILED_PRECONDITION",
          reason: "UNSUPPORTED_OPERATION",
        },
      );
    }
    if (config?.historyLength !== undefined) {
      if (
        !Number.isSafeInteger(config.historyLength) ||
        (config.historyLength as number) < 0 ||
        (config.historyLength as number) > limits.historyMessages
      ) {
        issues.push(
          violation(
            "configuration.historyLength",
            `Must be an integer between 0 and ${limits.historyMessages}.`,
          ),
        );
      }
    }
    if (config?.taskPushNotificationConfig !== undefined) {
      throw new A2AProtocolError("Push notifications are not supported.", {
        httpStatus: 400,
        status: "FAILED_PRECONDITION",
        reason: "UNSUPPORTED_OPERATION",
      });
    }
  }
  if (request?.metadata !== undefined) {
    jsonObjectAt(request.metadata, "metadata", limits, issues);
  }

  if (issues.length > 0) throw invalidRequest(issues);
  return value as A2ASendMessageRequest;
}

export function commitmentMetadataFromRequest(
  request: A2ASendMessageRequest,
  extensionUri: string = COMMITMENT_V1_EXTENSION_URI,
): CommitmentV1Metadata {
  return request.message.metadata[extensionUri] as CommitmentV1Metadata;
}

export function validateA2AArtifact(
  value: unknown,
  field: string,
  limits: A2ALimits,
): asserts value is A2AArtifact {
  const issues: A2AFieldViolation[] = [];
  const artifact = recordAt(value, field, issues);
  if (artifact !== undefined) {
    boundedIdentifier(artifact.artifactId, `${field}.artifactId`, issues);
    boundedString(artifact.name, `${field}.name`, 120, issues);
    if (artifact.description !== undefined) {
      boundedString(
        artifact.description,
        `${field}.description`,
        1_000,
        issues,
      );
    }
    const parts = arrayAt(artifact.parts);
    if (
      parts === undefined ||
      parts.length < 1 ||
      parts.length > limits.artifactParts
    ) {
      issues.push(
        violation(
          `${field}.parts`,
          `Must contain between 1 and ${limits.artifactParts} parts.`,
        ),
      );
    } else {
      parts.forEach((part, index) =>
        validatePart(part, `${field}.parts[${index}]`, limits, issues, false),
      );
    }
    if (artifact.metadata !== undefined) {
      jsonObjectAt(artifact.metadata, `${field}.metadata`, limits, issues);
    }
    if (artifact.extensions !== undefined) {
      stringArray(artifact.extensions, `${field}.extensions`, 16, issues);
    }
  }
  if (issues.length > 0) {
    throw new A2AProtocolError("Agent returned an invalid Artifact.", {
      httpStatus: 500,
      status: "INTERNAL",
      reason: "INVALID_AGENT_RESPONSE",
      fieldViolations: issues,
    });
  }
}

function validatePart(
  value: unknown,
  field: string,
  limits: A2ALimits,
  issues: A2AFieldViolation[],
  requireData: boolean,
): value is A2APart {
  const part = recordAt(value, field, issues);
  if (part === undefined) return false;
  const contentFields = ["text", "raw", "url", "data"].filter((key) =>
    Object.hasOwn(part, key),
  );
  if (contentFields.length !== 1) {
    issues.push(
      violation(
        field,
        "A Part must contain exactly one of text, raw, url, or data.",
      ),
    );
    return false;
  }
  if (requireData && contentFields[0] !== "data") {
    issues.push(violation(field, "Commitment input must use a data Part."));
  }
  if (Object.hasOwn(part, "text")) {
    boundedString(part.text, `${field}.text`, limits.partBytes, issues);
  }
  if (Object.hasOwn(part, "raw")) {
    boundedString(part.raw, `${field}.raw`, limits.partBytes, issues);
    if (
      typeof part.raw === "string" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        part.raw,
      )
    ) {
      issues.push(violation(`${field}.raw`, "Must be valid base64."));
    }
  }
  if (Object.hasOwn(part, "url")) {
    boundedHttpUrl(part.url, `${field}.url`, issues);
  }
  if (Object.hasOwn(part, "data")) {
    validateJsonValue(part.data, `${field}.data`, limits, issues);
  }
  if (part.filename !== undefined) {
    boundedString(part.filename, `${field}.filename`, 255, issues);
  }
  if (part.mediaType !== undefined) {
    boundedString(part.mediaType, `${field}.mediaType`, 120, issues);
  }
  if (
    (Object.hasOwn(part, "raw") || Object.hasOwn(part, "url")) &&
    typeof part.mediaType !== "string"
  ) {
    issues.push(violation(`${field}.mediaType`, "Is required for file parts."));
  }
  if (
    requireData &&
    part.mediaType !== undefined &&
    part.mediaType !== "application/json"
  ) {
    issues.push(
      violation(`${field}.mediaType`, "Must be application/json when set."),
    );
  }
  if (part.metadata !== undefined) {
    jsonObjectAt(part.metadata, `${field}.metadata`, limits, issues);
  }
  if (jsonBytes(part) > limits.partBytes) {
    issues.push(
      violation(field, `Serialized Part exceeds ${limits.partBytes} bytes.`),
    );
  }
  return true;
}

function jsonObjectAt(
  value: unknown,
  field: string,
  limits: A2ALimits,
  issues: A2AFieldViolation[],
): Readonly<Record<string, unknown>> | undefined {
  const object = recordAt(value, field, issues);
  if (object === undefined) return undefined;
  validateJsonValue(object, field, limits, issues);
  if (jsonBytes(object) > limits.metadataBytes) {
    issues.push(
      violation(
        field,
        `Serialized metadata exceeds ${limits.metadataBytes} bytes.`,
      ),
    );
  }
  return object;
}

function validateJsonValue(
  root: unknown,
  field: string,
  limits: A2ALimits,
  issues: A2AFieldViolation[],
): root is JsonValue {
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > limits.jsonNodes) return;
    if (depth > limits.jsonDepth) {
      issues.push(violation(path, `JSON depth exceeds ${limits.jsonDepth}.`));
      return;
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        issues.push(violation(path, "Must be a finite JSON number."));
      }
      return;
    }
    if (typeof value === "string") {
      if (utf8Bytes(value) > limits.partBytes) {
        issues.push(violation(path, "JSON string is too large."));
      }
      if (containsUnpairedSurrogate(value)) {
        issues.push(violation(path, "Contains an unpaired Unicode surrogate."));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        visit(item, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    const record = asRecord(value);
    if (record !== undefined) {
      for (const [key, item] of Object.entries(record)) {
        if (containsUnpairedSurrogate(key)) {
          issues.push(violation(path, "Contains an invalid property name."));
        }
        visit(item, `${path}.${key}`, depth + 1);
      }
      return;
    }
    issues.push(violation(path, "Must be an I-JSON value."));
  };
  visit(root, field, 0);
  if (nodes > limits.jsonNodes) {
    issues.push(
      violation(field, `JSON node count exceeds ${limits.jsonNodes}.`),
    );
  }
  return issues.length === 0;
}

function recordAt(
  value: unknown,
  field: string,
  issues: A2AFieldViolation[],
): Readonly<Record<string, unknown>> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    issues.push(violation(field, "Must be a JSON object."));
  }
  return record;
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function arrayAt(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function boundedIdentifier(
  value: unknown,
  field: string,
  issues: A2AFieldViolation[],
): void {
  boundedString(value, field, 128, issues);
  if (
    typeof value === "string" &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    issues.push(
      violation(field, "Contains unsupported identifier characters."),
    );
  }
}

function boundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  issues: A2AFieldViolation[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(violation(field, "Must be a non-empty string."));
    return;
  }
  if (utf8Bytes(value) > maximumBytes) {
    issues.push(violation(field, `Cannot exceed ${maximumBytes} UTF-8 bytes.`));
  }
  if (containsUnpairedSurrogate(value)) {
    issues.push(violation(field, "Contains an unpaired Unicode surrogate."));
  }
}

function boundedHttpUrl(
  value: unknown,
  field: string,
  issues: A2AFieldViolation[],
): void {
  boundedString(value, field, 2_048, issues);
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      issues.push(violation(field, "Must use HTTP or HTTPS."));
    }
  } catch {
    issues.push(violation(field, "Must be a valid absolute URL."));
  }
}

function stringArray(
  value: unknown,
  field: string,
  maximumItems: number,
  issues: A2AFieldViolation[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maximumItems) {
    issues.push(
      violation(field, `Must be an array of at most ${maximumItems} strings.`),
    );
    return undefined;
  }
  const strings: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 2_048) {
      issues.push(violation(`${field}[${index}]`, "Must be a bounded string."));
    } else {
      strings.push(item);
    }
  });
  return strings;
}

function violation(field: string, description: string): A2AFieldViolation {
  return { field, description };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : utf8Bytes(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
