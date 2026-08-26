import { createAgentRequestSignatureMessage } from "@guildhall/trust-engine";

const encoder = new TextEncoder();

export async function createGuildNodeIdentity(): Promise<{
  readonly keyId: string;
  readonly publicJwk: JsonWebKey;
  readonly privateJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return {
    keyId: await deriveGuildNodeKeyId(publicJwk),
    publicJwk,
    privateJwk,
  };
}

export async function deriveGuildNodeKeyId(
  publicJwk: JsonWebKey,
): Promise<string> {
  assertPublicJwk(publicJwk);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(
        `guild-node.${publicJwk.kty}.${publicJwk.crv}.${publicJwk.x}`,
      ),
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

export async function signMessage(
  privateJwk: JsonWebKey,
  message: string | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const bytes = typeof message === "string" ? encoder.encode(message) : message;
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", key, buffer)),
  );
}

export async function createSignedRequestHeaders(input: {
  readonly credential: string;
  readonly keyId: string;
  readonly privateJwk: JsonWebKey;
  readonly method: string;
  readonly requestTarget: string;
  readonly bodyText: string;
}): Promise<Headers> {
  const issuedAt = new Date().toISOString();
  const nonce = randomToken();
  const signature = await signMessage(
    input.privateJwk,
    createAgentRequestSignatureMessage({
      method: input.method,
      requestTarget: input.requestTarget,
      bodyText: input.bodyText,
      issuedAt,
      nonce,
    }),
  );
  return new Headers({
    Authorization: `GuildNode ${input.credential}`,
    "X-Guild-Key-Id": input.keyId,
    "X-Guild-Issued-At": issuedAt,
    "X-Guild-Nonce": nonce,
    "X-Guild-Signature": signature,
  });
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function assertPublicJwk(value: JsonWebKey): void {
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    value.x.length === 0 ||
    value.d !== undefined
  ) {
    throw new TypeError("A public Ed25519 JWK is required");
  }
}
