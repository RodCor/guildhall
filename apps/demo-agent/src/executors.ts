import {
  A2ATaskExecutionError,
  type A2AExecutionContext,
  type A2AExecutionResult,
  type A2AMessage,
  type A2ATaskExecutor,
  type JsonObject,
  type JsonValue,
} from "@guildhall/a2a-worker";

import type { HostedAgentKind } from "./agent-card";
import {
  ACCESSIBILITY_FIXTURE_ID,
  CONTROLLED_SCRIBE_FAILURE,
  CONTROLLED_SCRIBE_FAILURE_CODE,
  CONTROLLED_SCRIBE_FAILURE_MESSAGE,
  type AccessibilityFinding,
  findingsArtifactContent,
  parseApprovedFixture,
  remediationArtifactContent,
} from "./fixtures";
import {
  REPLACEMENT_PROOF_METADATA_KEY,
  createSignedArtifact,
  createSignedReplacementProof,
} from "./identity";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface HostedExecutorOptions {
  readonly privateJwk: JsonWebKey;
  readonly publicKeyX?: string;
  readonly keyId?: string;
  readonly origin: string;
  readonly now?: () => Date;
}

export function createSignedHostedExecutor(
  kind: HostedAgentKind,
  options: HostedExecutorOptions,
): A2ATaskExecutor {
  const now = options.now ?? (() => new Date());
  return {
    execute(context): Promise<A2AExecutionResult> {
      switch (kind) {
        case "scout":
          return executeScout(context, options, now);
        case "scribe":
          return executeScribe(context, options, now);
        case "warden":
          return executeWarden(context, options, now);
      }
    },
  };
}

async function executeScout(
  context: A2AExecutionContext,
  options: HostedExecutorOptions,
  now: () => Date,
): Promise<A2AExecutionResult> {
  ensureAction(context, "execute-role");
  const payload = assignmentPayload(context.message, "scout");
  const attempt = requiredAttempt(payload);
  const proof = commitmentProof(context);
  const findings = parseApprovedFixture(requiredString(payload, "fixtureId"));
  const content = findingsArtifactContent(findings);
  const artifact = await createSignedArtifact({
    kind: "scout",
    privateJwk: options.privateJwk,
    ...identityOverrides(options),
    origin: options.origin,
    completedAt: now().toISOString(),
    missionId: context.contextId,
    pactDigest: proof.pactDigest,
    roleSlotId: proof.roleSlotId,
    attempt,
    artifactType: "accessibility-findings",
    content,
  });
  return completedResult(artifact.artifactId, [artifact]);
}

async function executeScribe(
  context: A2AExecutionContext,
  options: HostedExecutorOptions,
  now: () => Date,
): Promise<A2AExecutionResult> {
  ensureAction(context, "execute-role");
  const payload = assignmentPayload(context.message, "scribe");
  const attempt = requiredAttempt(payload);
  const proof = commitmentProof(context);
  const findings = parseFindings(payload.findings);
  if (
    optionalString(payload, "fixtureScenario") === CONTROLLED_SCRIBE_FAILURE
  ) {
    throw new A2ATaskExecutionError(CONTROLLED_SCRIBE_FAILURE_MESSAGE, {
      code: CONTROLLED_SCRIBE_FAILURE_CODE,
      metadata: {
        deterministic: true,
        failedRole: "scribe",
        failureFixture: CONTROLLED_SCRIBE_FAILURE,
        guildMissionVerification: "pending",
        retryable: false,
      },
    });
  }
  const content = remediationArtifactContent(findings);
  const artifact = await createSignedArtifact({
    kind: "scribe",
    privateJwk: options.privateJwk,
    ...identityOverrides(options),
    origin: options.origin,
    completedAt: now().toISOString(),
    missionId: context.contextId,
    pactDigest: proof.pactDigest,
    roleSlotId: proof.roleSlotId,
    attempt,
    artifactType: "remediation-plan",
    content,
  });
  return completedResult(artifact.artifactId, [artifact]);
}

async function executeWarden(
  context: A2AExecutionContext,
  options: HostedExecutorOptions,
  now: () => Date,
): Promise<A2AExecutionResult> {
  ensureWardenAction(context);
  const payload = dataPayload(context.message);
  const attempt = requiredAttempt(payload);
  if (
    requiredString(payload, "protocol") !== "commitment/v1" ||
    requiredString(payload, "kind") !== "role-recovery" ||
    requiredString(payload, "fixtureId") !== ACCESSIBILITY_FIXTURE_ID
  ) {
    throw rejectedAssignment(
      "Warden supports only the approved recovery fixture.",
    );
  }

  const original = requiredRecord(payload, "originalAssignment");
  const replacement = requiredRecord(payload, "replacement");
  const role = requiredRecoveryRole(original, "role");
  const replacementRole = requiredRecoveryRole(replacement, "role");
  const proof = commitmentProof(context);
  const originalSlot = requiredUuid(original, "roleSlotId");
  const replacementSlot = requiredUuid(replacement, "roleSlotId");
  const originalPact = requiredDigest(original, "pactDigest");
  const replacementPact = requiredDigest(replacement, "pactDigest");
  const originalWork = requiredDigest(original, "assignmentDigest");
  const replacementWork = requiredDigest(replacement, "assignmentDigest");
  const predecessorAgentId = requiredUuid(replacement, "predecessorAgentId");

  if (
    role !== replacementRole ||
    originalSlot !== replacementSlot ||
    originalSlot !== proof.roleSlotId ||
    originalPact !== replacementPact ||
    originalPact !== proof.pactDigest ||
    originalWork !== replacementWork
  ) {
    throw rejectedAssignment(
      "Recovery must preserve the exact role, slot, pact, and assignment digest.",
    );
  }

  const content =
    role === "scout"
      ? findingsArtifactContent(parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID))
      : remediationArtifactContent(parseFindings(payload.findings));
  const artifactType =
    role === "scout" ? "accessibility-findings" : "remediation-plan";
  const completedAt = now().toISOString();
  const replacementProof = await createSignedReplacementProof({
    privateJwk: options.privateJwk,
    ...identityOverrides(options),
    acceptedAt: completedAt,
    missionId: context.contextId,
    pactDigest: proof.pactDigest,
    roleSlotId: proof.roleSlotId,
    predecessorAgentId,
  });
  if (context.commitment.action === "offer-recovery") {
    return {
      artifacts: [],
      taskMetadata: {
        deterministic: true,
        guildMissionVerification: "pending",
        [REPLACEMENT_PROOF_METADATA_KEY]: replacementProof,
        predecessorAgentId,
        recoveredRole: role,
        recoveryMode: "exact-role-offer",
        replacementProofId: requiredString(replacementProof, "replacementId"),
      },
    };
  }
  if (
    requiredString(payload, "acceptedReplacementId") !==
    requiredString(replacementProof, "replacementId")
  ) {
    throw rejectedAssignment(
      "Recovery work requires the bound replacement ID.",
    );
  }
  const signedArtifact = await createSignedArtifact({
    kind: "warden",
    privateJwk: options.privateJwk,
    ...identityOverrides(options),
    origin: options.origin,
    completedAt,
    missionId: context.contextId,
    pactDigest: proof.pactDigest,
    roleSlotId: proof.roleSlotId,
    attempt,
    artifactType,
    content,
  });
  const artifact = {
    ...signedArtifact,
    metadata: {
      ...signedArtifact.metadata,
      [REPLACEMENT_PROOF_METADATA_KEY]: replacementProof,
    },
  };
  return completedResult(artifact.artifactId, [artifact], {
    predecessorAgentId,
    recoveredRole: role,
    recoveryMode: "exact-role",
    replacementProofId: requiredString(replacementProof, "replacementId"),
  });
}

function completedResult(
  artifactId: string,
  artifacts: A2AExecutionResult["artifacts"],
  extra: JsonObject = {},
): A2AExecutionResult {
  return {
    artifacts,
    taskMetadata: {
      ...extra,
      deterministic: true,
      guildMissionVerification: "pending",
      primaryArtifactId: artifactId,
    },
  };
}

function identityOverrides(options: HostedExecutorOptions): {
  readonly publicKeyX?: string;
  readonly keyId?: string;
} {
  return {
    ...(options.publicKeyX === undefined
      ? {}
      : { publicKeyX: options.publicKeyX }),
    ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
  };
}

function assignmentPayload(
  message: A2AMessage,
  expectedRole: "scout" | "scribe",
): JsonObject {
  const payload = dataPayload(message);
  if (
    requiredString(payload, "protocol") !== "commitment/v1" ||
    requiredString(payload, "kind") !== "role-assignment" ||
    requiredString(payload, "role") !== expectedRole ||
    requiredString(payload, "fixtureId") !== ACCESSIBILITY_FIXTURE_ID
  ) {
    throw rejectedAssignment(
      `This agent accepts only the ${expectedRole} role.`,
    );
  }
  return payload;
}

function dataPayload(message: A2AMessage): JsonObject {
  const dataParts = message.parts.filter(
    (
      part,
    ): part is Extract<(typeof message.parts)[number], { data: JsonValue }> =>
      "data" in part,
  );
  if (dataParts.length !== 1 || !isRecord(dataParts[0]?.data)) {
    throw rejectedAssignment("Exactly one structured data part is required.");
  }
  return dataParts[0].data;
}

function commitmentProof(context: A2AExecutionContext): {
  readonly pactDigest: string;
  readonly roleSlotId: string;
} {
  if (context.commitment.missionId !== context.contextId) {
    throw rejectedAssignment("Mission and A2A context identifiers must match.");
  }
  return {
    pactDigest: requiredDigest(context.commitment, "pactDigest"),
    roleSlotId: requiredUuid(context.commitment, "roleSlotId"),
  };
}

function ensureAction(
  context: A2AExecutionContext,
  expected: "execute-role" | "recover-role",
): void {
  if (context.signal.aborted) {
    throw rejectedAssignment("Execution was canceled before it started.");
  }
  if (context.commitment.action !== expected) {
    throw rejectedAssignment(`Expected the ${expected} commitment action.`);
  }
}

function ensureWardenAction(context: A2AExecutionContext): void {
  if (context.signal.aborted) {
    throw rejectedAssignment("Execution was canceled before it started.");
  }
  if (
    context.commitment.action !== "offer-recovery" &&
    context.commitment.action !== "recover-role"
  ) {
    throw rejectedAssignment(
      "Expected the offer-recovery or recover-role commitment action.",
    );
  }
}

function parseFindings(value: JsonValue | undefined): AccessibilityFinding[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw rejectedAssignment(
      "One to sixteen structured findings are required.",
    );
  }
  const findings = value.map((entry) => {
    if (!isRecord(entry)) throw rejectedAssignment("A finding is malformed.");
    const severity = requiredString(entry, "severity");
    if (severity !== "moderate" && severity !== "serious") {
      throw rejectedAssignment("A finding severity is unsupported.");
    }
    return {
      evidence: boundedString(entry, "evidence", 300),
      findingId: boundedString(entry, "findingId", 80),
      ruleId: boundedString(entry, "ruleId", 80),
      selector: boundedString(entry, "selector", 200),
      severity,
    } satisfies AccessibilityFinding;
  });
  const ids = new Set(findings.map((finding) => finding.findingId));
  if (ids.size !== findings.length) {
    throw rejectedAssignment("Finding identifiers must be unique.");
  }
  const expected = [...parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID)].sort(
    (left, right) => left.findingId.localeCompare(right.findingId),
  );
  const received = [...findings].sort((left, right) =>
    left.findingId.localeCompare(right.findingId),
  );
  if (
    received.length !== expected.length ||
    received.some((finding, index) => !sameFinding(finding, expected[index]))
  ) {
    throw rejectedAssignment(
      "Findings must match the approved accessibility fixture exactly.",
    );
  }
  return findings;
}

function sameFinding(
  left: AccessibilityFinding,
  right: AccessibilityFinding | undefined,
): boolean {
  return (
    right !== undefined &&
    left.evidence === right.evidence &&
    left.findingId === right.findingId &&
    left.ruleId === right.ruleId &&
    left.selector === right.selector &&
    left.severity === right.severity
  );
}

function requiredRecord(value: JsonObject, key: string): JsonObject {
  const candidate = value[key];
  if (!isRecord(candidate)) throw rejectedAssignment(`${key} is required.`);
  return candidate;
}

function requiredRecoveryRole(
  value: JsonObject,
  key: string,
): "scout" | "scribe" {
  const candidate = requiredString(value, key);
  if (candidate !== "scout" && candidate !== "scribe") {
    throw rejectedAssignment("Recovery role must be scout or scribe.");
  }
  return candidate;
}

function requiredUuid(value: JsonObject, key: string): string {
  const candidate = requiredString(value, key);
  if (!UUID_PATTERN.test(candidate))
    throw rejectedAssignment(`${key} is invalid.`);
  return candidate;
}

function requiredDigest(value: JsonObject, key: string): string {
  const candidate = requiredString(value, key);
  if (!DIGEST_PATTERN.test(candidate)) {
    throw rejectedAssignment(`${key} is invalid.`);
  }
  return candidate;
}

function requiredAttempt(value: JsonObject): 1 | 2 {
  const candidate = value.attempt;
  if (candidate !== 1 && candidate !== 2) {
    throw rejectedAssignment("attempt must be 1 or 2.");
  }
  return candidate;
}

function boundedString(
  value: JsonObject,
  key: string,
  maximum: number,
): string {
  const candidate = requiredString(value, key);
  if (candidate.length > maximum)
    throw rejectedAssignment(`${key} is too long.`);
  return candidate;
}

function requiredString(value: JsonObject, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw rejectedAssignment(`${key} is required.`);
  }
  return candidate;
}

function optionalString(value: JsonObject, key: string): string | null {
  const candidate = value[key];
  if (candidate === undefined) return null;
  if (typeof candidate !== "string")
    throw rejectedAssignment(`${key} is invalid.`);
  return candidate;
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectedAssignment(message: string): A2ATaskExecutionError {
  return new A2ATaskExecutionError(message);
}
