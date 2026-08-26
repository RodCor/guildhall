import {
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
} from "./crypto.js";

const VERSION = "v1";
const KDF_SALT = encodeUtf8("guildhall/private-draft/hkdf-sha256/v1");
const KDF_INFO = encodeUtf8("guildhall/private-draft/aes-256-gcm/v1");

export async function sealPrivateDraft(
  plaintext: string,
  serverSecret: string,
  binding: string,
): Promise<string> {
  const key = await deriveKey(serverSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(
        encodeUtf8(`GUILDHALL-PRIVATE-DRAFT-V1\n${binding}`),
      ),
      tagLength: 128,
    },
    key,
    toArrayBuffer(encodeUtf8(plaintext)),
  );
  return `${VERSION}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

export async function unsealPrivateDraft(
  sealed: string,
  serverSecret: string,
  binding: string,
): Promise<string | null> {
  try {
    if (sealed.length > 100_000) return null;
    const [version, ivEncoded, ciphertextEncoded, ...rest] = sealed.split(".");
    if (
      version !== VERSION ||
      ivEncoded === undefined ||
      ciphertextEncoded === undefined ||
      rest.length > 0
    ) {
      return null;
    }
    const iv = decodeBase64Url(ivEncoded);
    const ciphertext = decodeBase64Url(ciphertextEncoded);
    if (iv.length !== 12 || ciphertext.length < 16) return null;
    const key = await deriveKey(serverSecret);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(
          encodeUtf8(`GUILDHALL-PRIVATE-DRAFT-V1\n${binding}`),
        ),
        tagLength: 128,
      },
      key,
      toArrayBuffer(ciphertext),
    );
    return decodeUtf8(new Uint8Array(plaintext));
  } catch {
    return null;
  }
}

function deriveKey(serverSecret: string): Promise<CryptoKey> {
  if (serverSecret.length === 0)
    throw new TypeError("Draft cipher is unavailable");
  return crypto.subtle
    .importKey("raw", toArrayBuffer(encodeUtf8(serverSecret)), "HKDF", false, [
      "deriveKey",
    ])
    .then((material) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: toArrayBuffer(KDF_SALT),
          info: toArrayBuffer(KDF_INFO),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}
