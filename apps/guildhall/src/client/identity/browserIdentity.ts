const DATABASE_NAME = "guildhall-browser-identity";
const STORE_NAME = "signing-keys";
const PRIMARY_RECORD = "primary";

export interface BrowserSigningIdentity {
  readonly keyId: string;
  readonly publicJwk: JsonWebKey;
  readonly privateKey: CryptoKey;
}

interface StoredIdentity {
  readonly id: string;
  readonly keyId: string;
  readonly publicJwk: JsonWebKey;
  readonly privateKey: CryptoKey;
}

export async function ensureBrowserSigningIdentity(
  expectedKeyId?: string,
): Promise<BrowserSigningIdentity> {
  const database = await openIdentityDatabase();
  try {
    const recordId = expectedKeyId ?? PRIMARY_RECORD;
    const existing = await readIdentity(database, recordId);
    if (existing !== null) {
      return existing;
    }

    if (expectedKeyId !== undefined) {
      const legacy = await readIdentity(database, PRIMARY_RECORD);
      if (legacy?.keyId === expectedKeyId) {
        await writeIdentity(database, expectedKeyId, legacy);
        return legacy;
      }
      throw new Error("This browser does not hold the selected agent signer");
    }

    const identity = await generateIdentity();
    await writeIdentity(database, PRIMARY_RECORD, identity);
    return identity;
  } finally {
    database.close();
  }
}

export async function createBrowserSigningIdentity(): Promise<BrowserSigningIdentity> {
  const identity = await generateIdentity();
  const database = await openIdentityDatabase();
  try {
    await writeIdentity(database, identity.keyId, identity);
    return identity;
  } finally {
    database.close();
  }
}

export async function hasBrowserSigningIdentity(
  keyId: string,
): Promise<boolean> {
  try {
    await ensureBrowserSigningIdentity(keyId);
    return true;
  } catch {
    return false;
  }
}

export async function removeBrowserSigningIdentity(
  keyId: string,
): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await deleteIdentity(database, keyId);
  } finally {
    database.close();
  }
}

export async function signBrowserMessage(
  privateKey: CryptoKey,
  message: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof message === "string" ? new TextEncoder().encode(message) : message;
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    buffer,
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function deriveBrowserKeyId(
  publicJwk: JsonWebKey,
): Promise<string> {
  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string" ||
    publicJwk.x.length === 0 ||
    publicJwk.d !== undefined
  ) {
    throw new TypeError("A public Ed25519 JWK is required");
  }
  const material = new TextEncoder().encode(
    `browser.${publicJwk.kty}.${publicJwk.crv}.${publicJwk.x}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", material),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Browser identity storage is unavailable"));
    request.onblocked = () =>
      reject(new Error("Browser identity storage is blocked"));
  });
}

function readIdentity(
  database: IDBDatabase,
  recordId: string,
): Promise<BrowserSigningIdentity | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(recordId);
    request.onsuccess = () => {
      const value = request.result as StoredIdentity | undefined;
      resolve(
        value === undefined
          ? null
          : {
              keyId: value.keyId,
              publicJwk: value.publicJwk,
              privateKey: value.privateKey,
            },
      );
    };
    request.onerror = () =>
      reject(new Error("Browser identity could not be read"));
  });
}

function writeIdentity(
  database: IDBDatabase,
  recordId: string,
  identity: BrowserSigningIdentity,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      id: recordId,
      ...identity,
    } satisfies StoredIdentity);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(new Error("Browser identity could not be stored"));
    transaction.onabort = () =>
      reject(new Error("Browser identity storage was aborted"));
  });
}

function deleteIdentity(
  database: IDBDatabase,
  recordId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(recordId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(new Error("Browser identity could not be removed"));
    transaction.onabort = () =>
      reject(new Error("Browser identity removal was aborted"));
  });
}

async function generateIdentity(): Promise<BrowserSigningIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const keyId = await deriveBrowserKeyId(publicJwk);
  return { keyId, publicJwk, privateKey: pair.privateKey };
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
