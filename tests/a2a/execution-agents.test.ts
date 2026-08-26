import {
  Role,
  SendMessageRequest,
  type SendMessageRequest as OfficialSendMessageRequest,
} from "@a2a-js/sdk";
import {
  ArtifactMetadataSchema,
  ReplacementProofSchema,
  artifactSigningBytes,
  canonicalJsonDigest,
  importEd25519PublicJwk,
  replacementSigningBytes,
  verifyEd25519,
} from "../../packages/contracts/src";
import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  COMMITMENT_V1_EXTENSION_URI,
} from "../../packages/a2a-worker/src";
import { describe, expect, it, vi } from "vitest";

import type { HostedAgentKind } from "../../apps/demo-agent/src/agent-card";
import {
  ACCESSIBILITY_FIXTURE_ID,
  CONTROLLED_SCRIBE_FAILURE,
  CONTROLLED_SCRIBE_FAILURE_CODE,
  CONTROLLED_SCRIBE_FAILURE_MESSAGE,
  findingsArtifactContent,
  parseApprovedFixture,
} from "../../apps/demo-agent/src/fixtures";
import {
  REPLACEMENT_PROOF_METADATA_KEY,
  hostedIdentity,
} from "../../apps/demo-agent/src/identity";
import {
  createAgentWorker,
  type HostedAgentWorker,
} from "../../apps/demo-agent/src/worker";
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

describe("deterministic hosted execution agents", () => {
  it("publishes a structured signed Scout artifact with a stable retry hash", async () => {
    const worker = createAgentWorker("scout", { now: fixedNow });
    const firstTask = await send(
      worker,
      "scout",
      roleRequest("scout", SCOUT_SLOT, {
        attempt: 1,
        fixtureId: ACCESSIBILITY_FIXTURE_ID,
        kind: "role-assignment",
        protocol: "commitment/v1",
        role: "scout",
      }),
    );
    const firstArtifact = onlyArtifact(firstTask);
    const firstContent = artifactData(firstArtifact);
    const firstMetadata = artifactMetadata(firstArtifact);

    expect(firstTask.status).toMatchObject({ state: "TASK_STATE_COMPLETED" });
    expect(firstContent).toEqual(
      findingsArtifactContent(parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID)),
    );
    expect(firstMetadata).toMatchObject({
      attempt: 1,
      missionId: MISSION_ID,
      pactDigest: PACT_DIGEST,
      producingAgentId: hostedIdentity("scout").agentId,
      roleSlotId: SCOUT_SLOT,
      safetyStatus: "approved",
    });
    expect(firstMetadata.contentDigest).toBe(
      await canonicalJsonDigest(firstContent),
    );
    await expectValidArtifactSignature("scout", firstMetadata);
    expect(firstTask.metadata).toMatchObject({
      guildMissionVerification: "pending",
    });
    expect(taskCommitment(firstTask)).toMatchObject({
      a2aTaskState: "TASK_STATE_COMPLETED",
    });

    const retryTask = await send(
      worker,
      "scout",
      roleRequest("scout", SCOUT_SLOT, {
        attempt: 1,
        fixtureId: ACCESSIBILITY_FIXTURE_ID,
        kind: "role-assignment",
        protocol: "commitment/v1",
        role: "scout",
      }),
    );
    const retryArtifact = onlyArtifact(retryTask);
    const retryMetadata = artifactMetadata(retryArtifact);
    expect(retryArtifact.artifactId).toBe(firstArtifact.artifactId);
    expect(retryMetadata.contentDigest).toBe(firstMetadata.contentDigest);
    expect(retryMetadata.signature).toBe(firstMetadata.signature);
  });

  it("turns the named Scribe injection into the same explicit FAILED Task", async () => {
    const worker = createAgentWorker("scribe", { now: fixedNow });
    const requestData = {
      attempt: 1,
      findings: parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID),
      fixtureId: ACCESSIBILITY_FIXTURE_ID,
      fixtureScenario: CONTROLLED_SCRIBE_FAILURE,
      kind: "role-assignment",
      protocol: "commitment/v1",
      role: "scribe",
    };
    const first = await send(
      worker,
      "scribe",
      roleRequest("scribe", SCRIBE_SLOT, requestData),
    );
    const retry = await send(
      worker,
      "scribe",
      roleRequest("scribe", SCRIBE_SLOT, requestData),
    );

    for (const task of [first, retry]) {
      expect(task.status).toMatchObject({
        state: "TASK_STATE_FAILED",
        message: {
          parts: [{ text: CONTROLLED_SCRIBE_FAILURE_MESSAGE }],
        },
      });
      expect(task.artifacts).toEqual([]);
      expect(task.metadata).toMatchObject({
        deterministic: true,
        executionErrorCode: CONTROLLED_SCRIBE_FAILURE_CODE,
        failedRole: "scribe",
        failureFixture: CONTROLLED_SCRIBE_FAILURE,
        guildMissionVerification: "pending",
        retryable: false,
      });
      expect(taskCommitment(task)).toMatchObject({
        a2aTaskState: "TASK_STATE_FAILED",
      });
    }
  });

  it("requires Warden's signed recovery offer before attempt-one replacement work", async () => {
    const findings = parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID);
    const scribe = createAgentWorker("scribe", { now: fixedNow });
    const warden = createAgentWorker("warden", { now: fixedNow });
    const scribeTask = await send(
      scribe,
      "scribe",
      roleRequest("scribe", SCRIBE_SLOT, {
        attempt: 1,
        findings,
        fixtureId: ACCESSIBILITY_FIXTURE_ID,
        kind: "role-assignment",
        protocol: "commitment/v1",
        role: "scribe",
      }),
    );
    const originalArtifact = onlyArtifact(scribeTask);
    const originalMetadata = artifactMetadata(originalArtifact);

    const offerTask = await send(
      warden,
      "warden",
      offerRecoveryRequest(findings),
    );
    expect(offerTask.status).toMatchObject({
      state: "TASK_STATE_COMPLETED",
    });
    expect(offerTask.artifacts).toEqual([]);
    expect(offerTask.metadata).toMatchObject({
      guildMissionVerification: "pending",
      recoveredRole: "scribe",
      recoveryMode: "exact-role-offer",
    });
    const offeredProof = ReplacementProofSchema.parse(
      requiredRecord(
        requiredRecord(offerTask, "metadata"),
        REPLACEMENT_PROOF_METADATA_KEY,
      ),
    );
    expect(offerTask.metadata).toMatchObject({
      replacementProofId: offeredProof.replacementId,
    });
    expect(offeredProof).toMatchObject({
      acceptedAt: COMPLETED_AT,
      missionId: MISSION_ID,
      pactDigest: PACT_DIGEST,
      predecessorAgentId: PREDECESSOR_ID,
      preservesPactDigest: true,
      reason: "participant-defaulted",
      replacementAgentId: hostedIdentity("warden").agentId,
      roleSlotId: SCRIBE_SLOT,
    });
    const wardenKey = await importEd25519PublicJwk(
      hostedIdentity("warden").publicJwk,
    );
    expect(
      await verifyEd25519(
        wardenKey,
        replacementSigningBytes(PACT_DIGEST, SCRIBE_SLOT, PREDECESSOR_ID),
        offeredProof.signature,
      ),
    ).toBe(true);

    const unboundTask = await send(warden, "warden", recoveryRequest(findings));
    expect(unboundTask.status).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: {
        parts: [{ text: "acceptedReplacementId is required." }],
      },
    });
    expect(unboundTask.artifacts).toEqual([]);

    const mismatchedTask = await send(
      warden,
      "warden",
      recoveryRequest(findings, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    );
    expect(mismatchedTask.status).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: {
        parts: [{ text: "Recovery work requires the bound replacement ID." }],
      },
    });
    expect(mismatchedTask.artifacts).toEqual([]);

    const recoveredTask = await send(
      warden,
      "warden",
      recoveryRequest(findings, offeredProof.replacementId),
    );
    const recoveredArtifact = onlyArtifact(recoveredTask);
    const recoveredMetadata = artifactMetadata(recoveredArtifact);
    const replacementProof = ReplacementProofSchema.parse(
      requiredRecord(
        requiredRecord(recoveredArtifact, "metadata"),
        REPLACEMENT_PROOF_METADATA_KEY,
      ),
    );

    expect(recoveredTask.status).toMatchObject({
      state: "TASK_STATE_COMPLETED",
    });
    expect(artifactData(recoveredArtifact)).toEqual(
      artifactData(originalArtifact),
    );
    expect(recoveredMetadata).toMatchObject({
      attempt: 1,
      missionId: MISSION_ID,
      pactDigest: originalMetadata.pactDigest,
      producingAgentId: hostedIdentity("warden").agentId,
      roleSlotId: originalMetadata.roleSlotId,
    });
    expect(recoveredMetadata.contentDigest).toBe(
      originalMetadata.contentDigest,
    );
    await expectValidArtifactSignature("warden", recoveredMetadata);
    expect(replacementProof).toEqual(offeredProof);
    expect(recoveredTask.metadata).toMatchObject({
      recoveredRole: "scribe",
      recoveryMode: "exact-role",
      replacementProofId: replacementProof.replacementId,
      guildMissionVerification: "pending",
    });

    const retryTask = await send(
      warden,
      "warden",
      recoveryRequest(findings, offeredProof.replacementId),
    );
    const retryArtifact = onlyArtifact(retryTask);
    const retryMetadata = artifactMetadata(retryArtifact);
    const retryProof = ReplacementProofSchema.parse(
      requiredRecord(
        requiredRecord(retryArtifact, "metadata"),
        REPLACEMENT_PROOF_METADATA_KEY,
      ),
    );
    expect(retryMetadata.contentDigest).toBe(recoveredMetadata.contentDigest);
    expect(retryMetadata.signature).toBe(recoveredMetadata.signature);
    expect(retryProof).toEqual(replacementProof);
  });

  it("executes every hosted role without any model or provider network call", async () => {
    const outboundFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected outbound provider call."));
    try {
      const findings = parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID);
      await send(
        createAgentWorker("scout", { now: fixedNow }),
        "scout",
        roleRequest("scout", SCOUT_SLOT, {
          attempt: 1,
          fixtureId: ACCESSIBILITY_FIXTURE_ID,
          kind: "role-assignment",
          protocol: "commitment/v1",
          role: "scout",
        }),
      );
      await send(
        createAgentWorker("scribe", { now: fixedNow }),
        "scribe",
        roleRequest("scribe", SCRIBE_SLOT, {
          attempt: 1,
          findings,
          fixtureId: ACCESSIBILITY_FIXTURE_ID,
          kind: "role-assignment",
          protocol: "commitment/v1",
          role: "scribe",
        }),
      );
      const warden = createAgentWorker("warden", { now: fixedNow });
      const offer = await send(
        warden,
        "warden",
        offerRecoveryRequest(findings),
      );
      const proof = ReplacementProofSchema.parse(
        requiredRecord(
          requiredRecord(offer, "metadata"),
          REPLACEMENT_PROOF_METADATA_KEY,
        ),
      );
      await send(
        warden,
        "warden",
        recoveryRequest(findings, proof.replacementId),
      );
      expect(outboundFetch).not.toHaveBeenCalled();
    } finally {
      outboundFetch.mockRestore();
    }
  });
});

function roleRequest(
  role: "scout" | "scribe",
  roleSlotId: string,
  data: unknown,
): OfficialSendMessageRequest {
  return officialRequest("execute-role", roleSlotId, data);
}

function offerRecoveryRequest(
  findings: readonly unknown[],
): OfficialSendMessageRequest {
  return officialRequest(
    "offer-recovery",
    SCRIBE_SLOT,
    recoveryPayload(findings),
  );
}

function recoveryRequest(
  findings: readonly unknown[],
  acceptedReplacementId?: string,
): OfficialSendMessageRequest {
  return officialRequest(
    "recover-role",
    SCRIBE_SLOT,
    recoveryPayload(findings, acceptedReplacementId),
  );
}

function recoveryPayload(
  findings: readonly unknown[],
  acceptedReplacementId?: string,
): Record<string, unknown> {
  return {
    ...(acceptedReplacementId === undefined ? {} : { acceptedReplacementId }),
    attempt: 1,
    findings,
    fixtureId: ACCESSIBILITY_FIXTURE_ID,
    kind: "role-recovery",
    originalAssignment: {
      assignmentDigest: ASSIGNMENT_DIGEST,
      pactDigest: PACT_DIGEST,
      role: "scribe",
      roleSlotId: SCRIBE_SLOT,
    },
    protocol: "commitment/v1",
    replacement: {
      assignmentDigest: ASSIGNMENT_DIGEST,
      pactDigest: PACT_DIGEST,
      predecessorAgentId: PREDECESSOR_ID,
      role: "scribe",
      roleSlotId: SCRIBE_SLOT,
    },
  };
}

function officialRequest(
  action: "execute-role" | "offer-recovery" | "recover-role",
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

async function send(
  worker: HostedAgentWorker,
  kind: HostedAgentKind,
  body: OfficialSendMessageRequest,
): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    new Request(`${origins[kind]}/a2a/v1/message:send`, {
      method: "POST",
      headers: {
        [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
        "Content-Type": A2A_CONTENT_TYPE,
      },
      body: JSON.stringify(SendMessageRequest.toJSON(body)),
    }),
    {
      HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS[kind]),
    },
  );
  expect(response.status).toBe(200);
  return requiredRecord(asRecord(await response.json()), "task");
}

function onlyArtifact(task: Record<string, unknown>): Record<string, unknown> {
  const artifacts = requiredArray(task, "artifacts");
  expect(artifacts).toHaveLength(1);
  return asRecord(artifacts[0]);
}

function artifactData(
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  const parts = requiredArray(artifact, "parts");
  expect(parts).toHaveLength(1);
  return requiredRecord(asRecord(parts[0]), "data");
}

function artifactMetadata(
  artifact: Record<string, unknown>,
): ReturnType<typeof ArtifactMetadataSchema.parse> {
  return ArtifactMetadataSchema.parse(
    requiredRecord(
      requiredRecord(artifact, "metadata"),
      COMMITMENT_V1_EXTENSION_URI,
    ),
  );
}

async function expectValidArtifactSignature(
  kind: HostedAgentKind,
  metadata: ReturnType<typeof ArtifactMetadataSchema.parse>,
): Promise<void> {
  const publicKey = await importEd25519PublicJwk(
    hostedIdentity(kind).publicJwk,
  );
  expect(
    await verifyEd25519(
      publicKey,
      artifactSigningBytes(metadata.pactDigest, metadata.contentDigest),
      metadata.signature,
    ),
  ).toBe(true);
}

function taskCommitment(
  task: Record<string, unknown>,
): Record<string, unknown> {
  return requiredRecord(
    requiredRecord(task, "metadata"),
    COMMITMENT_V1_EXTENSION_URI,
  );
}

function fixedNow(): Date {
  return new Date(COMPLETED_AT);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function requiredRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asRecord(value[key]);
}

function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) throw new TypeError(`${key} is not an array.`);
  return candidate;
}
