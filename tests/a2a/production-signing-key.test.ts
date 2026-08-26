import {
  Role,
  SendMessageRequest,
  type SendMessageRequest as OfficialSendMessageRequest,
} from "@a2a-js/sdk";
import {
  ArtifactMetadataSchema,
  ReplacementProofSchema,
  artifactSigningBytes,
  importEd25519PublicJwk,
  replacementSigningBytes,
  verifyEd25519,
} from "../../packages/contracts/src";
import { createAgentRequestSignatureMessage } from "../../packages/trust-engine/src";
import {
  A2A_CONTENT_TYPE,
  A2A_EXTENSIONS_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  COMMITMENT_V1_EXTENSION_URI,
} from "../../packages/a2a-worker/src";
import { describe, expect, it, vi } from "vitest";

import {
  ACCESSIBILITY_FIXTURE_ID,
  parseApprovedFixture,
} from "../../apps/demo-agent/src/fixtures";
import {
  REPLACEMENT_PROOF_METADATA_KEY,
  hostedIdentity,
} from "../../apps/demo-agent/src/identity";
import {
  createAgentWorker,
  type HostedAgentEnv,
} from "../../apps/demo-agent/src/worker";
import { TEST_PRIVATE_JWKS } from "./fixtures/test-identities";

const COMPLETED_AT = "2026-08-26T15:00:00.000Z";
const MISSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLE_SLOT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREDECESSOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PRODUCTION_KEY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PACT_DIGEST = "P".repeat(43);
const ASSIGNMENT_DIGEST = "A".repeat(43);
const ORIGIN = "https://scout.guildhall.test";
const BROKER_ORIGIN = "https://guildhall.test";

describe("production hosted-agent signing key override", () => {
  it("advertises the configured public key and requires its matching private key for A2A work", async () => {
    const generated = await generatedSigningIdentity();
    expect(generated.publicKeyX).not.toBe(hostedIdentity("scout").publicJwk.x);
    expect(PRODUCTION_KEY_ID).not.toBe(hostedIdentity("scout").keyId);
    const worker = createAgentWorker("scout", { now: fixedNow });
    const env: HostedAgentEnv = {
      HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(generated.privateJwk),
      HOSTED_AGENT_KEY_ID: PRODUCTION_KEY_ID,
      HOSTED_AGENT_PUBLIC_KEY_X: generated.publicKeyX,
    };
    const cardResponse = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/agent-card.json`),
      env,
    );
    expect(cardResponse.status).toBe(200);
    const card = asRecord(await cardResponse.json());
    const extension = requiredArray(
      requiredRecord(card, "capabilities"),
      "extensions",
    )
      .map(asRecord)
      .find((entry) => entry.uri === COMMITMENT_V1_EXTENSION_URI);
    expect(extension).toBeDefined();
    expect(
      requiredRecord(requiredRecord(extension!, "params"), "publicJwk"),
    ).toMatchObject({
      crv: "Ed25519",
      kty: "OKP",
      x: generated.publicKeyX,
    });
    expect(requiredRecord(extension!, "params").keyId).toBe(PRODUCTION_KEY_ID);

    const response = await worker.fetch(executionRequest(), env);
    expect(response.status).toBe(200);
    const task = requiredRecord(asRecord(await response.json()), "task");
    expect(task.status).toMatchObject({ state: "TASK_STATE_COMPLETED" });
    const artifact = asRecord(requiredArray(task, "artifacts")[0]);
    const metadata = ArtifactMetadataSchema.parse(
      requiredRecord(
        requiredRecord(artifact, "metadata"),
        COMMITMENT_V1_EXTENSION_URI,
      ),
    );
    expect(metadata.keyId).toBe(PRODUCTION_KEY_ID);
    const verificationKey = await importEd25519PublicJwk(generated.publicJwk);
    expect(
      await verifyEd25519(
        verificationKey,
        artifactSigningBytes(metadata.pactDigest, metadata.contentDigest),
        metadata.signature,
      ),
    ).toBe(true);

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const mismatch = await worker.fetch(executionRequest(), {
        HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS.scout),
        HOSTED_AGENT_KEY_ID: PRODUCTION_KEY_ID,
        HOSTED_AGENT_PUBLIC_KEY_X: generated.publicKeyX,
      });
      expect(mismatch.status).toBe(500);
      expect(await mismatch.json()).toMatchObject({
        error: { message: "Hosted agent is unavailable." },
      });
      const invalidKeyId = await worker.fetch(
        new Request(`${ORIGIN}/.well-known/agent-card.json`),
        {
          HOSTED_AGENT_KEY_ID: "not-a-uuid",
          HOSTED_AGENT_PUBLIC_KEY_X: generated.publicKeyX,
        },
      );
      expect(invalidKeyId.status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }

    const offerResponse = await createAgentWorker("warden", {
      now: fixedNow,
    }).fetch(wardenOfferRequest(), env);
    expect(offerResponse.status).toBe(200);
    const offerTask = requiredRecord(
      asRecord(await offerResponse.json()),
      "task",
    );
    expect(offerTask.artifacts).toEqual([]);
    const replacement = ReplacementProofSchema.parse(
      requiredRecord(
        requiredRecord(offerTask, "metadata"),
        REPLACEMENT_PROOF_METADATA_KEY,
      ),
    );
    expect(replacement.keyId).toBe(PRODUCTION_KEY_ID);
    expect(
      await verifyEd25519(
        verificationKey,
        replacementSigningBytes(PACT_DIGEST, ROLE_SLOT_ID, PREDECESSOR_ID),
        replacement.signature,
      ),
    ).toBe(true);
  });

  it("propagates the configured key through scheduled Guild signing", async () => {
    const generated = await generatedSigningIdentity();
    let signedRequest: Request | undefined;
    const guildFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/missions") {
        return Response.json({
          missions:
            url.searchParams.get("displayState") === "Recruiting"
              ? [{ missionId: MISSION_ID }]
              : [],
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === `/api/missions/${MISSION_ID}`
      ) {
        return Response.json({
          latestSequence: 1,
          definition: {
            deliveryDeadline: "2026-08-26T18:00:00.000Z",
            missionVersion: 1,
          },
          snapshot: { applicationAgentIds: [] },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/a2a/guild/v1/message:send"
      ) {
        signedRequest = request;
        return Response.json(
          {
            task: {
              id: "production-key-application",
              contextId: MISSION_ID,
              status: {
                state: "TASK_STATE_COMPLETED",
                timestamp: COMPLETED_AT,
              },
              artifacts: [],
              history: [],
              metadata: {},
            },
          },
          {
            headers: {
              [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
              [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
              "Content-Type": A2A_CONTENT_TYPE,
            },
          },
        );
      }
      throw new Error(`Unexpected scheduled request ${request.method} ${url}`);
    };
    const pending: Promise<unknown>[] = [];
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    try {
      createAgentWorker("scribe", {
        fetch: guildFetch,
        now: fixedNow,
      }).scheduled(
        {
          cron: "*/5 * * * *",
          scheduledTime: Date.parse(COMPLETED_AT),
          noRetry(): void {},
        } as ScheduledController,
        {
          GUILD_AGENT_CREDENTIAL: "production-scoped-credential",
          GUILD_BROKER_URL: `${BROKER_ORIGIN}/a2a/guild/v1`,
          HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(generated.privateJwk),
          HOSTED_AGENT_KEY_ID: PRODUCTION_KEY_ID,
          HOSTED_AGENT_PUBLIC_KEY_X: generated.publicKeyX,
        },
        {
          waitUntil(promise): void {
            pending.push(promise);
          },
        } as ExecutionContext,
      );
      await Promise.all(pending);
    } finally {
      consoleInfo.mockRestore();
    }

    expect(signedRequest).toBeDefined();
    const bodyText = await signedRequest!.clone().text();
    const issuedAt = requiredHeader(signedRequest!, "X-Guild-Issued-At");
    const nonce = requiredHeader(signedRequest!, "X-Guild-Nonce");
    const signature = requiredHeader(signedRequest!, "X-Guild-Signature");
    expect(signedRequest!.headers.get("Authorization")).toBe(
      "GuildNode production-scoped-credential",
    );
    expect(signedRequest!.headers.get("X-Guild-Key-Id")).toBe(
      PRODUCTION_KEY_ID,
    );
    const verificationKey = await importEd25519PublicJwk(generated.publicJwk);
    expect(
      await verifyEd25519(
        verificationKey,
        createAgentRequestSignatureMessage({
          method: "POST",
          requestTarget: "/a2a/guild/v1/message:send",
          bodyText,
          issuedAt,
          nonce,
        }),
        signature,
      ),
    ).toBe(true);
  });
});

function executionRequest(): Request {
  const body: OfficialSendMessageRequest = {
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId: MISSION_ID,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: {
            $case: "data",
            value: {
              attempt: 1,
              fixtureId: ACCESSIBILITY_FIXTURE_ID,
              kind: "role-assignment",
              protocol: "commitment/v1",
              role: "scout",
            },
          },
          metadata: undefined,
          filename: "assignment.json",
          mediaType: "application/json",
        },
      ],
      metadata: {
        [COMMITMENT_V1_EXTENSION_URI]: {
          action: "execute-role",
          missionId: MISSION_ID,
          pactDigest: PACT_DIGEST,
          protocol: "commitment/v1",
          roleSlotId: ROLE_SLOT_ID,
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
  return new Request(`${ORIGIN}/a2a/v1/message:send`, {
    method: "POST",
    headers: {
      [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      "Content-Type": A2A_CONTENT_TYPE,
    },
    body: JSON.stringify(SendMessageRequest.toJSON(body)),
  });
}

function wardenOfferRequest(): Request {
  const body: OfficialSendMessageRequest = {
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId: MISSION_ID,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: {
            $case: "data",
            value: {
              attempt: 1,
              findings: parseApprovedFixture(ACCESSIBILITY_FIXTURE_ID),
              fixtureId: ACCESSIBILITY_FIXTURE_ID,
              kind: "role-recovery",
              originalAssignment: {
                assignmentDigest: ASSIGNMENT_DIGEST,
                pactDigest: PACT_DIGEST,
                role: "scribe",
                roleSlotId: ROLE_SLOT_ID,
              },
              protocol: "commitment/v1",
              replacement: {
                assignmentDigest: ASSIGNMENT_DIGEST,
                pactDigest: PACT_DIGEST,
                predecessorAgentId: PREDECESSOR_ID,
                role: "scribe",
                roleSlotId: ROLE_SLOT_ID,
              },
            },
          },
          metadata: undefined,
          filename: "recovery.json",
          mediaType: "application/json",
        },
      ],
      metadata: {
        [COMMITMENT_V1_EXTENSION_URI]: {
          action: "offer-recovery",
          missionId: MISSION_ID,
          pactDigest: PACT_DIGEST,
          protocol: "commitment/v1",
          roleSlotId: ROLE_SLOT_ID,
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
  return new Request("https://warden.guildhall.test/a2a/v1/message:send", {
    method: "POST",
    headers: {
      [A2A_EXTENSIONS_HEADER]: COMMITMENT_V1_EXTENSION_URI,
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      "Content-Type": A2A_CONTENT_TYPE,
    },
    body: JSON.stringify(SendMessageRequest.toJSON(body)),
  });
}

async function generatedSigningIdentity(): Promise<{
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey;
  readonly publicKeyX: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ]);
  if (typeof publicJwk.x !== "string") {
    throw new TypeError("Generated Ed25519 key is missing x.");
  }
  return { privateJwk, publicJwk, publicKeyX: publicJwk.x };
}

function fixedNow(): Date {
  return new Date(COMPLETED_AT);
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (value === null) throw new TypeError(`${name} is unavailable.`);
  return value;
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
