const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);

const COMPACT_VERSION = "v1";
const COMPACT_HMAC_DOMAIN = "GUILDHALL-COMPACT-V1";
const PKCE_SEAL_VERSION = "v1";
const PKCE_SEAL_DOMAIN = "GUILDHALL-PKCE-SEAL-V1";
const PKCE_SEAL_KDF_SALT = textEncoder.encode(
  "guildhall/auth/pkce-seal/hkdf-sha256/v1",
);
const PKCE_SEAL_KDF_INFO = textEncoder.encode(
  "guildhall/auth/pkce-verifier/aes-256-gcm/v1",
);

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export type CompactValueVerification =
  | {
      readonly valid: true;
      readonly payload: string;
      readonly expiresAt: number;
    }
  | {
      readonly valid: false;
      readonly reason: "invalid_or_expired";
    };

const INVALID_COMPACT_VALUE = {
  valid: false,
  reason: "invalid_or_expired",
} as const;

/** Generate an unpadded base64url token from cryptographically random bytes. */
export function randomBase64UrlToken(byteLength = 32): string {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > 65_536
  ) {
    throw new RangeError("Random token byte length is invalid");
  }

  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function encodeUtf8(value: string): Uint8Array {
  assertUnicodeScalarString(value);
  return textEncoder.encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return fatalTextDecoder.decode(bytes);
  } catch {
    throw new TypeError("Invalid UTF-8 value");
  }
}

/** Encode bytes as canonical, unpadded RFC 4648 base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;

    encoded += BASE64URL_ALPHABET[(block >>> 18) & 0x3f];
    encoded += BASE64URL_ALPHABET[(block >>> 12) & 0x3f];
    if (hasSecond) encoded += BASE64URL_ALPHABET[(block >>> 6) & 0x3f];
    if (hasThird) encoded += BASE64URL_ALPHABET[block & 0x3f];
  }

  return encoded;
}

/** Decode only canonical, unpadded base64url. */
export function decodeBase64Url(value: string): Uint8Array {
  if (
    value.length % 4 === 1 ||
    (value.length > 0 && !/^[A-Za-z0-9_-]+$/u.test(value))
  ) {
    throw new TypeError("Invalid base64url value");
  }

  const outputLength = Math.floor((value.length * 6) / 8);
  const output = new Uint8Array(outputLength);
  let accumulator = 0;
  let availableBits = 0;
  let outputIndex = 0;

  for (const character of value) {
    const nextValue = BASE64URL_VALUES.get(character);
    if (nextValue === undefined) {
      throw new TypeError("Invalid base64url value");
    }

    accumulator = (accumulator << 6) | nextValue;
    availableBits += 6;

    if (availableBits >= 8) {
      availableBits -= 8;
      output[outputIndex] = (accumulator >>> availableBits) & 0xff;
      outputIndex += 1;
      accumulator &= (1 << availableBits) - 1;
    }
  }

  if (accumulator !== 0 || encodeBase64Url(output) !== value) {
    throw new TypeError("Invalid base64url value");
  }

  return output;
}

export function encodeBase64UrlUtf8(value: string): string {
  return encodeBase64Url(encodeUtf8(value));
}

export function decodeBase64UrlUtf8(value: string): string {
  try {
    return decodeUtf8(decodeBase64Url(value));
  } catch {
    throw new TypeError("Invalid base64url UTF-8 value");
  }
}

/** SHA-256 encoded as canonical, unpadded base64url. */
export async function sha256Base64Url(
  input: string | Uint8Array,
): Promise<string> {
  const bytes = typeof input === "string" ? encodeUtf8(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return encodeBase64Url(new Uint8Array(digest));
}

/** Hash an opaque credential before it reaches persistent storage. */
export const hashOpaqueCredential = sha256Base64Url;

/** Derive the RFC 7636 S256 challenge for a valid PKCE verifier. */
export async function createPkceChallenge(verifier: string): Promise<string> {
  assertPkceVerifier(verifier);
  return sha256Base64Url(verifier);
}

/** Generate a GitHub-compatible PKCE verifier/challenge pair. */
export async function generatePkcePair(
  randomByteLength = 32,
): Promise<PkcePair> {
  if (
    !Number.isSafeInteger(randomByteLength) ||
    randomByteLength < 32 ||
    randomByteLength > 96
  ) {
    throw new RangeError("PKCE random byte length is invalid");
  }

  const verifier = randomBase64UrlToken(randomByteLength);
  return {
    verifier,
    challenge: await createPkceChallenge(verifier),
    method: "S256",
  };
}

/**
 * Compare byte strings without returning early on their contents. Cloudflare's
 * native extension is preferred for equal-length inputs; other runtimes use a
 * fixed-work fallback that also incorporates a length mismatch into the result.
 */
export function timingResistantEqual(
  first: string | Uint8Array,
  second: string | Uint8Array,
): boolean {
  const firstBytes = typeof first === "string" ? encodeUtf8(first) : first;
  const secondBytes = typeof second === "string" ? encodeUtf8(second) : second;
  const workerSubtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (first: BufferSource, second: BufferSource) => boolean;
  };

  if (
    firstBytes.byteLength === secondBytes.byteLength &&
    typeof workerSubtle.timingSafeEqual === "function"
  ) {
    try {
      return workerSubtle.timingSafeEqual(
        toArrayBuffer(firstBytes),
        toArrayBuffer(secondBytes),
      );
    } catch {
      // Continue with the portable implementation.
    }
  }

  const iterations = Math.max(firstBytes.byteLength, secondBytes.byteLength, 1);
  let difference = firstBytes.byteLength ^ secondBytes.byteLength;
  for (let index = 0; index < iterations; index += 1) {
    difference |= (firstBytes[index] ?? 0) ^ (secondBytes[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Sign an opaque compact value. `expiresAt` is an absolute Unix timestamp in
 * milliseconds and is part of the authenticated message.
 */
export async function signCompactValue(
  payload: string,
  expiresAt: number,
  serverSecret: string | Uint8Array,
): Promise<string> {
  assertUnicodeScalarString(payload);
  assertExpiry(expiresAt);
  const payloadEncoded = encodeBase64UrlUtf8(payload);
  const authenticated = compactAuthenticatedValue(payloadEncoded, expiresAt);
  const signature = await hmacSha256(serverSecret, authenticated);

  return [COMPACT_VERSION, payloadEncoded, String(expiresAt), signature].join(
    ".",
  );
}

/** Verify a signed value without distinguishing malformed, tampered, or expired. */
export async function verifyCompactValue(
  compactValue: string,
  serverSecret: string | Uint8Array,
  now = Date.now(),
): Promise<CompactValueVerification> {
  try {
    if (!Number.isSafeInteger(now) || now < 0 || compactValue.length > 16_384) {
      return INVALID_COMPACT_VALUE;
    }

    const parts = compactValue.split(".");
    if (parts.length !== 4 || parts[0] !== COMPACT_VERSION) {
      return INVALID_COMPACT_VALUE;
    }

    const payloadEncoded = parts[1];
    const expiryEncoded = parts[2];
    const signatureEncoded = parts[3];
    if (
      payloadEncoded === undefined ||
      expiryEncoded === undefined ||
      signatureEncoded === undefined ||
      !/^(0|[1-9][0-9]*)$/u.test(expiryEncoded)
    ) {
      return INVALID_COMPACT_VALUE;
    }

    const expiresAt = Number(expiryEncoded);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      return INVALID_COMPACT_VALUE;
    }

    const suppliedSignature = decodeBase64Url(signatureEncoded);
    if (suppliedSignature.byteLength !== 32) {
      return INVALID_COMPACT_VALUE;
    }

    const expectedSignature = decodeBase64Url(
      await hmacSha256(
        serverSecret,
        compactAuthenticatedValue(payloadEncoded, expiresAt),
      ),
    );
    if (!timingResistantEqual(suppliedSignature, expectedSignature)) {
      return INVALID_COMPACT_VALUE;
    }

    const payload = decodeBase64UrlUtf8(payloadEncoded);
    if (expiresAt <= now) {
      return INVALID_COMPACT_VALUE;
    }

    return { valid: true, payload, expiresAt };
  } catch {
    return INVALID_COMPACT_VALUE;
  }
}

/** Seal a PKCE verifier for short-lived callback storage. */
export async function sealPkceVerifier(
  verifier: string,
  serverSecret: string | Uint8Array,
  additionalAuthenticatedData: string,
): Promise<string> {
  try {
    assertPkceVerifier(verifier);
    assertUnicodeScalarString(additionalAuthenticatedData);
    const key = await derivePkceSealKey(serverSecret);
    const initializationVector = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(initializationVector),
        additionalData: toArrayBuffer(pkceSealAad(additionalAuthenticatedData)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(encodeUtf8(verifier)),
    );

    return [
      PKCE_SEAL_VERSION,
      encodeBase64Url(initializationVector),
      encodeBase64Url(new Uint8Array(encrypted)),
    ].join(".");
  } catch {
    throw new Error("Unable to seal PKCE verifier");
  }
}

/** Unseal a PKCE verifier; all format/authentication failures collapse to null. */
export async function unsealPkceVerifier(
  sealedValue: string,
  serverSecret: string | Uint8Array,
  additionalAuthenticatedData: string,
): Promise<string | null> {
  try {
    if (sealedValue.length > 2_048) return null;
    assertUnicodeScalarString(additionalAuthenticatedData);
    const parts = sealedValue.split(".");
    if (parts.length !== 3 || parts[0] !== PKCE_SEAL_VERSION) return null;

    const initializationVector = decodeBase64Url(parts[1] ?? "");
    const encrypted = decodeBase64Url(parts[2] ?? "");
    if (initializationVector.byteLength !== 12 || encrypted.byteLength < 16) {
      return null;
    }

    const key = await derivePkceSealKey(serverSecret);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(initializationVector),
        additionalData: toArrayBuffer(pkceSealAad(additionalAuthenticatedData)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(encrypted),
    );
    const verifier = decodeUtf8(new Uint8Array(plaintext));
    assertPkceVerifier(verifier);
    return verifier;
  } catch {
    return null;
  }
}

/** Import a public-only OKP/Ed25519 JWK for challenge verification. */
export async function importEd25519VerificationKey(
  publicJwk: JsonWebKey,
): Promise<CryptoKey> {
  try {
    assertEd25519PublicJwk(publicJwk);
    return await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new TypeError("Invalid Ed25519 public key");
  }
}

export function canonicalizeEd25519PublicJwk(
  publicJwk: JsonWebKey,
): JsonWebKey {
  try {
    assertEd25519PublicJwk(publicJwk);
    return {
      kty: "OKP",
      crv: "Ed25519",
      x: publicJwk.x,
      ext: true,
      key_ops: ["verify"],
    };
  } catch {
    throw new TypeError("Invalid Ed25519 public key");
  }
}

export async function deriveEd25519KeyId(
  source: "browser" | "guild-node" | "a2a",
  publicJwk: JsonWebKey,
): Promise<string> {
  const canonical = canonicalizeEd25519PublicJwk(publicJwk);
  const digest = decodeBase64Url(
    await sha256Base64Url(
      `${source}.${canonical.kty}.${canonical.crv}.${canonical.x}`,
    ),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Verify a signature over the exact UTF-8 bytes of a possession challenge. */
export async function verifyEd25519Challenge(
  publicJwk: JsonWebKey,
  challenge: string,
  signature: string,
): Promise<boolean> {
  try {
    const challengeBytes = encodeUtf8(challenge);
    const signatureBytes = decodeBase64Url(signature);
    if (signatureBytes.byteLength !== 64) return false;
    const key = await importEd25519VerificationKey(publicJwk);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(signatureBytes),
      toArrayBuffer(challengeBytes),
    );
  } catch {
    return false;
  }
}

function assertPkceVerifier(verifier: string): void {
  if (
    verifier.length < 43 ||
    verifier.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/u.test(verifier)
  ) {
    throw new TypeError("Invalid PKCE verifier");
  }
}

function assertExpiry(expiresAt: number): void {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new RangeError("Compact value expiry is invalid");
  }
}

function compactAuthenticatedValue(
  payloadEncoded: string,
  expiresAt: number,
): string {
  return `${COMPACT_HMAC_DOMAIN}\n${payloadEncoded}\n${expiresAt}`;
}

async function hmacSha256(
  serverSecret: string | Uint8Array,
  value: string,
): Promise<string> {
  const secretBytes = secretToBytes(serverSecret);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(encodeUtf8(value)),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function derivePkceSealKey(
  serverSecret: string | Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretToBytes(serverSecret)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(PKCE_SEAL_KDF_SALT),
      info: toArrayBuffer(PKCE_SEAL_KDF_INFO),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function pkceSealAad(additionalAuthenticatedData: string): Uint8Array {
  return encodeUtf8(`${PKCE_SEAL_DOMAIN}\u0000${additionalAuthenticatedData}`);
}

function secretToBytes(serverSecret: string | Uint8Array): Uint8Array {
  const bytes =
    typeof serverSecret === "string" ? encodeUtf8(serverSecret) : serverSecret;
  if (bytes.byteLength === 0) {
    throw new TypeError("Server secret is invalid");
  }
  return bytes;
}

function assertEd25519PublicJwk(
  jwk: JsonWebKey,
): asserts jwk is JsonWebKey & { crv: "Ed25519"; kty: "OKP"; x: string } {
  const keyOperations = jwk.key_ops;
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    jwk.d !== undefined ||
    decodeBase64Url(jwk.x).byteLength !== 32 ||
    (jwk.alg !== undefined && jwk.alg !== "EdDSA" && jwk.alg !== "Ed25519") ||
    (jwk.use !== undefined && jwk.use !== "sig") ||
    (keyOperations !== undefined &&
      keyOperations.length > 0 &&
      (keyOperations.length !== 1 || keyOperations[0] !== "verify"))
  ) {
    throw new TypeError("Invalid Ed25519 public key");
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Invalid Unicode string");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Invalid Unicode string");
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
