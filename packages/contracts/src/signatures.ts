import { canonicalizeEx } from "json-canonicalize";

const textEncoder = new TextEncoder();

const PACT_DOMAIN = "PACTBRIDGE-COMMITMENT-V1";
const REPLACEMENT_DOMAIN = "PACTBRIDGE-REPLACEMENT-V1";
const ARTIFACT_DOMAIN = "PACTBRIDGE-ARTIFACT-V1";
const RECEIPT_DOMAIN = "PACTBRIDGE-RECEIPT-V1";
const COMMAND_DOMAIN = "PACTBRIDGE-COMMAND-V1";

export type SigningKeyStatus = "active" | "revoked";

export interface RegisteredEd25519Key {
  keyId: string;
  publicJwk: JsonWebKey;
  status: SigningKeyStatus;
  revokedAt?: string;
}

export interface Ed25519Proof {
  keyId: string;
  signature: string;
}

export type ProofVerificationPolicy =
  { kind: "new-proof" } | { kind: "historical-proof"; acceptedAt: string };

export type ProofVerificationFailure =
  | "KEY_ID_MISMATCH"
  | "KEY_REVOKED"
  | "KEY_REVOCATION_TIME_UNKNOWN"
  | "PROOF_ACCEPTED_AFTER_REVOCATION"
  | "INVALID_TIMESTAMP"
  | "INVALID_PUBLIC_KEY"
  | "INVALID_SIGNATURE";

export type ProofVerificationResult =
  | { valid: true; keyId: string; keyThumbprint: string }
  | { valid: false; reason: ProofVerificationFailure };

/**
 * Serialize an I-JSON value with RFC 8785 JSON Canonicalization Scheme rules.
 * Unsupported JavaScript values are rejected instead of being silently removed.
 */
export function canonicalJson(value: unknown): string {
  assertIJson(value, "$", new Set<object>());

  return canonicalizeEx(value, {
    allowCircular: false,
    filterUndefined: false,
    undefinedInArrayToNull: false,
  });
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalJson(value));
}

/** SHA-256 encoded as RFC 4648 base64url without padding. */
export async function sha256Base64Url(
  input: string | Uint8Array,
): Promise<string> {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));

  return encodeBase64Url(new Uint8Array(digest));
}

export async function canonicalJsonDigest(value: unknown): Promise<string> {
  return sha256Base64Url(canonicalJsonBytes(value));
}

export function pactSigningBytes(pactDigest: string): Uint8Array {
  return domainBytes(PACT_DOMAIN, pactDigest);
}

export function replacementSigningBytes(
  pactDigest: string,
  roleSlotId: string,
  predecessorAgentId: string,
): Uint8Array {
  return domainBytes(
    REPLACEMENT_DOMAIN,
    pactDigest,
    roleSlotId,
    predecessorAgentId,
  );
}

export function artifactSigningBytes(
  pactDigest: string,
  artifactDigest: string,
): Uint8Array {
  return domainBytes(ARTIFACT_DOMAIN, pactDigest, artifactDigest);
}

export function receiptSigningBytes(receiptDigest: string): Uint8Array {
  return domainBytes(RECEIPT_DOMAIN, receiptDigest);
}

/** Signature-free canonical projection committed by a receipt issuer. */
export function unsignedReceiptProjection<
  T extends { issuerSignature: string },
>(receipt: T): Omit<T, "issuerSignature"> {
  const { issuerSignature: _signature, ...unsigned } = receipt;
  return unsigned;
}

export interface CommandHashInput {
  readonly commandId: string;
  readonly action: string;
  readonly missionId: string;
  readonly expectedSequence: number;
  readonly actor: unknown;
  readonly issuedAt: string;
  readonly payload: unknown;
  readonly source?: unknown;
  readonly proof?: unknown;
}

/** Hash the signed command fields; trusted transport source and proof are excluded. */
export function commandBodyHash(command: CommandHashInput): Promise<string> {
  return canonicalJsonDigest({
    action: command.action,
    actor: command.actor,
    commandId: command.commandId,
    expectedSequence: command.expectedSequence,
    issuedAt: command.issuedAt,
    missionId: command.missionId,
    payload: command.payload,
  });
}

export function commandSigningBytes(bodyHash: string): Uint8Array {
  return domainBytes(COMMAND_DOMAIN, bodyHash);
}

export async function generateEd25519KeyPair(
  extractable = true,
): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, extractable, [
    "sign",
    "verify",
  ]);
}

export async function importEd25519PublicJwk(
  publicJwk: JsonWebKey,
): Promise<CryptoKey> {
  assertEd25519PublicJwk(publicJwk);

  return crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
    "verify",
  ]);
}

export async function importEd25519PrivateJwk(
  privateJwk: JsonWebKey,
  extractable = false,
): Promise<CryptoKey> {
  assertEd25519PrivateJwk(privateJwk);

  return crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    extractable,
    ["sign"],
  );
}

export async function signEd25519(
  privateKey: CryptoKey,
  message: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof message === "string" ? textEncoder.encode(message) : message;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    toArrayBuffer(bytes),
  );

  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyEd25519(
  publicKey: CryptoKey,
  message: string | Uint8Array,
  signature: string,
): Promise<boolean> {
  let signatureBytes: Uint8Array;

  try {
    signatureBytes = decodeBase64Url(signature);
  } catch {
    return false;
  }

  if (signatureBytes.byteLength !== 64) {
    return false;
  }

  const bytes =
    typeof message === "string" ? textEncoder.encode(message) : message;

  try {
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      toArrayBuffer(signatureBytes),
      toArrayBuffer(bytes),
    );
  } catch {
    return false;
  }
}

/** RFC 7638 thumbprint for an Ed25519 (OKP) public JWK. */
export async function ed25519PublicJwkThumbprint(
  publicJwk: JsonWebKey,
): Promise<string> {
  assertEd25519PublicJwk(publicJwk);

  return canonicalJsonDigest({
    crv: "Ed25519",
    kty: "OKP",
    x: publicJwk.x,
  });
}

/**
 * Verify a proof against a registered key and the key's revocation history.
 * Cryptographic verification is still performed for historical proofs; history
 * changes authorization policy, never signature validity.
 */
export async function verifyRegisteredEd25519Proof(options: {
  key: RegisteredEd25519Key;
  proof: Ed25519Proof;
  message: string | Uint8Array;
  policy: ProofVerificationPolicy;
}): Promise<ProofVerificationResult> {
  const { key, message, policy, proof } = options;

  if (proof.keyId !== key.keyId) {
    return { valid: false, reason: "KEY_ID_MISMATCH" };
  }

  const statusFailure = keyStatusFailure(key, policy);
  if (statusFailure !== undefined) {
    return { valid: false, reason: statusFailure };
  }

  let publicKey: CryptoKey;
  let keyThumbprint: string;

  try {
    [publicKey, keyThumbprint] = await Promise.all([
      importEd25519PublicJwk(key.publicJwk),
      ed25519PublicJwkThumbprint(key.publicJwk),
    ]);
  } catch {
    return { valid: false, reason: "INVALID_PUBLIC_KEY" };
  }

  const valid = await verifyEd25519(publicKey, message, proof.signature);
  if (!valid) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }

  return { valid: true, keyId: key.keyId, keyThumbprint };
}

function keyStatusFailure(
  key: RegisteredEd25519Key,
  policy: ProofVerificationPolicy,
): ProofVerificationFailure | undefined {
  if (key.status === "active") {
    return undefined;
  }

  if (policy.kind === "new-proof") {
    return "KEY_REVOKED";
  }

  if (key.revokedAt === undefined) {
    return "KEY_REVOCATION_TIME_UNKNOWN";
  }

  // acceptedAt is the server-persisted acceptance/event timestamp, never a
  // caller assertion supplied after revocation.
  const proofCreatedAt = Date.parse(policy.acceptedAt);
  const revokedAt = Date.parse(key.revokedAt);
  if (!Number.isFinite(proofCreatedAt) || !Number.isFinite(revokedAt)) {
    return "INVALID_TIMESTAMP";
  }

  if (proofCreatedAt > revokedAt) {
    return "PROOF_ACCEPTED_AFTER_REVOCATION";
  }

  return undefined;
}

function domainBytes(domain: string, ...parts: string[]): Uint8Array {
  for (const [index, part] of parts.entries()) {
    if (part.length === 0 || /[\u0000-\u001f\u007f]/u.test(part)) {
      throw new TypeError(
        `Domain component ${index + 1} must be non-empty and contain no control characters`,
      );
    }
  }

  return textEncoder.encode([domain, ...parts].join("\n"));
}

function assertEd25519PublicJwk(
  jwk: JsonWebKey,
): asserts jwk is JsonWebKey & { crv: "Ed25519"; kty: "OKP"; x: string } {
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    jwk.d !== undefined ||
    !isBase64Url(jwk.x) ||
    decodeBase64Url(jwk.x).byteLength !== 32 ||
    (jwk.alg !== undefined && jwk.alg !== "EdDSA" && jwk.alg !== "Ed25519")
  ) {
    throw new TypeError("Expected an Ed25519 public JWK");
  }
}

function assertEd25519PrivateJwk(jwk: JsonWebKey): asserts jwk is JsonWebKey & {
  crv: "Ed25519";
  d: string;
  kty: "OKP";
  x: string;
} {
  const { d, ...publicJwk } = jwk;
  assertEd25519PublicJwk(publicJwk);

  if (
    typeof d !== "string" ||
    !isBase64Url(d) ||
    decodeBase64Url(d).byteLength !== 32
  ) {
    throw new TypeError("Expected an Ed25519 private JWK");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!isBase64Url(value) || value.length % 4 === 1) {
    throw new TypeError("Expected unpadded base64url");
  }

  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  if (encodeBase64Url(bytes) !== value) {
    throw new TypeError("Expected canonical unpadded base64url");
  }

  return bytes;
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function assertIJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === "boolean") {
    return;
  }

  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number`);
    }
    return;
  }

  if (typeof value !== "object") {
    throw new TypeError(
      `${path} contains a value outside the I-JSON data model`,
    );
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only JSON objects and arrays`);
  }

  ancestors.add(value);
  if (isArray) {
    for (const [index, item] of value.entries()) {
      assertIJson(item, `${path}[${index}]`, ancestors);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertUnicodeScalarString(key, `${path} property name`);
      assertIJson(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        Number.isNaN(nextCodeUnit) ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
    }
  }
}
