import {
  ArtifactMetadataSchema,
  artifactSigningBytes,
  canonicalJsonDigest,
} from "@guildhall/contracts";
import type { A2AArtifact, JsonObject } from "@guildhall/a2a-worker";

import type { HostedAgentKind } from "./agent-card";

export interface HostedAgentIdentity {
  readonly agentId: string;
  readonly keyId: string;
  readonly publicJwk: JsonObject;
}

const identities: Readonly<Record<HostedAgentKind, HostedAgentIdentity>> = {
  scout: {
    agentId: "11111111-1111-4111-8111-111111111111",
    keyId: "11111111-1111-4111-8111-111111111112",
    publicJwk: {
      crv: "Ed25519",
      kty: "OKP",
      x: "OnvPItzy4bFTxKLR70P_mJ6VczONWAhEY38hZwWspuc",
    },
  },
  scribe: {
    agentId: "22222222-2222-4222-8222-222222222222",
    keyId: "22222222-2222-4222-8222-222222222223",
    publicJwk: {
      crv: "Ed25519",
      kty: "OKP",
      x: "rjPfz-vSVEjQ277fyf3gk1HM03ehmSyIqXFbVWAT-Mw",
    },
  },
  warden: {
    agentId: "33333333-3333-4333-8333-333333333333",
    keyId: "33333333-3333-4333-8333-333333333334",
    publicJwk: {
      crv: "Ed25519",
      kty: "OKP",
      x: "-MYRCzSmXR_SWzoYTS753Y-biGih5DZn6QonCF518HY",
    },
  },
};

export function hostedIdentity(kind: HostedAgentKind): HostedAgentIdentity {
  return identities[kind];
}

export function parseHostedPrivateJwk(
  kind: HostedAgentKind,
  serialized: string,
): JsonWebKey {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new TypeError("The hosted signing secret is not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new TypeError("The hosted signing secret must be a JWK object.");
  }
  const identity = hostedIdentity(kind);
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.d !== "string" ||
    typeof value.x !== "string" ||
    value.x !== identity.publicJwk.x
  ) {
    throw new TypeError("The hosted signing secret does not match this agent.");
  }
  return {
    crv: "Ed25519",
    d: value.d,
    ext: false,
    key_ops: ["sign"],
    kty: "OKP",
    x: value.x,
  };
}

export async function createSignedArtifact(input: {
  readonly kind: HostedAgentKind;
  readonly privateJwk: JsonWebKey;
  readonly origin: string;
  readonly completedAt: string;
  readonly missionId: string;
  readonly pactDigest: string;
  readonly roleSlotId: string;
  readonly artifactType: "accessibility-findings" | "remediation-plan";
  readonly content: JsonObject;
}): Promise<A2AArtifact> {
  const identity = hostedIdentity(input.kind);
  const contentDigest = await canonicalJsonDigest(input.content);
  const artifactId = await artifactIdForContent(input.content);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    input.privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const artifactProof = artifactSigningBytes(input.pactDigest, contentDigest);
  const signingInput = new ArrayBuffer(artifactProof.byteLength);
  new Uint8Array(signingInput).set(artifactProof);
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", privateKey, signingInput),
    ),
  );
  const metadata = ArtifactMetadataSchema.parse({
    protocol: "commitment/v1",
    kind: "artifact-metadata",
    artifactId,
    missionId: input.missionId,
    pactDigest: input.pactDigest,
    roleSlotId: input.roleSlotId,
    producingAgentId: identity.agentId,
    keyId: identity.keyId,
    attempt: 1,
    artifactType: input.artifactType,
    mediaType: "application/json",
    publicLocation: `${input.origin}/artifacts/${artifactId}`,
    contentDigest,
    signature,
    safetyStatus: "approved",
    completedAt: input.completedAt,
  });

  return {
    artifactId,
    name:
      input.artifactType === "accessibility-findings"
        ? "Accessibility findings"
        : "Accessibility remediation plan",
    description:
      input.artifactType === "accessibility-findings"
        ? "Deterministic findings from the approved public fixture."
        : "Deterministic remediation steps covering each supplied finding.",
    parts: [{ data: input.content, mediaType: "application/json" }],
    extensions: ["https://guildhall.example/extensions/commitment/v1"],
    metadata: {
      "https://guildhall.example/extensions/commitment/v1": metadata,
    },
  };
}

export async function artifactIdForContent(
  content: JsonObject,
): Promise<string> {
  return deterministicUuid(await canonicalJsonDigest(content));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function deterministicUuid(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
