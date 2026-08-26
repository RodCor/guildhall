import {
  ArtifactMetadataSchema,
  ReplacementProofSchema,
  artifactSigningBytes,
  canonicalJsonDigest,
  replacementSigningBytes,
} from "@guildhall/contracts";
import type { A2AArtifact, JsonObject } from "@guildhall/a2a-worker";

import type { HostedAgentKind } from "./agent-card";

export const REPLACEMENT_PROOF_METADATA_KEY =
  "https://guildhall.example/extensions/commitment/v1/replacement-proof";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

export function hostedIdentity(
  kind: HostedAgentKind,
  publicKeyX?: string,
  keyId?: string,
): HostedAgentIdentity {
  const identity = identities[kind];
  if (publicKeyX === undefined && keyId === undefined) return identity;
  if (publicKeyX !== undefined) assertEd25519PublicKeyX(publicKeyX);
  if (keyId !== undefined && !UUID_PATTERN.test(keyId)) {
    throw new TypeError("The hosted signing key ID must be a UUID.");
  }
  return {
    ...identity,
    ...(keyId === undefined ? {} : { keyId }),
    publicJwk:
      publicKeyX === undefined
        ? identity.publicJwk
        : { ...identity.publicJwk, x: publicKeyX },
  };
}

export function parseHostedPrivateJwk(
  kind: HostedAgentKind,
  serialized: string,
  publicKeyX?: string,
  keyId?: string,
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
  const identity = hostedIdentity(kind, publicKeyX, keyId);
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

function assertEd25519PublicKeyX(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError(
      "The hosted public signing key must be a canonical Ed25519 x value.",
    );
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError(
      "The hosted public signing key must be a canonical Ed25519 x value.",
    );
  }
  if (
    binary.length !== 32 ||
    encodeBase64Url(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    ) !== value
  ) {
    throw new TypeError(
      "The hosted public signing key must be a canonical Ed25519 x value.",
    );
  }
}

export async function createSignedArtifact(input: {
  readonly kind: HostedAgentKind;
  readonly privateJwk: JsonWebKey;
  readonly publicKeyX?: string;
  readonly keyId?: string;
  readonly origin: string;
  readonly completedAt: string;
  readonly missionId: string;
  readonly pactDigest: string;
  readonly roleSlotId: string;
  readonly attempt: 1 | 2;
  readonly artifactType: "accessibility-findings" | "remediation-plan";
  readonly content: JsonObject;
}): Promise<A2AArtifact> {
  const identity = hostedIdentity(input.kind, input.publicKeyX, input.keyId);
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
    attempt: input.attempt,
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

export async function createSignedReplacementProof(input: {
  readonly privateJwk: JsonWebKey;
  readonly publicKeyX?: string;
  readonly keyId?: string;
  readonly acceptedAt: string;
  readonly missionId: string;
  readonly pactDigest: string;
  readonly roleSlotId: string;
  readonly predecessorAgentId: string;
}): Promise<JsonObject> {
  const identity = hostedIdentity("warden", input.publicKeyX, input.keyId);
  const replacementId = await deterministicUuid(
    await canonicalJsonDigest({
      kind: "replacement",
      missionId: input.missionId,
      pactDigest: input.pactDigest,
      predecessorAgentId: input.predecessorAgentId,
      replacementAgentId: identity.agentId,
      roleSlotId: input.roleSlotId,
    }),
  );
  const privateKey = await importSigningKey(input.privateJwk);
  const signature = await signBytes(
    privateKey,
    replacementSigningBytes(
      input.pactDigest,
      input.roleSlotId,
      input.predecessorAgentId,
    ),
  );
  const proof = ReplacementProofSchema.parse({
    protocol: "commitment/v1",
    kind: "replacement",
    replacementId,
    missionId: input.missionId,
    pactDigest: input.pactDigest,
    roleSlotId: input.roleSlotId,
    predecessorAgentId: input.predecessorAgentId,
    replacementAgentId: identity.agentId,
    keyId: identity.keyId,
    reason: "participant-defaulted",
    preservesPactDigest: true,
    signature,
    acceptedAt: input.acceptedAt,
  });

  return { ...proof };
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

async function importSigningKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function signBytes(
  privateKey: CryptoKey,
  proof: Uint8Array,
): Promise<string> {
  const signingInput = new ArrayBuffer(proof.byteLength);
  new Uint8Array(signingInput).set(proof);
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", privateKey, signingInput),
    ),
  );
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
