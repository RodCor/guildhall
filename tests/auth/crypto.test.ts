import { describe, expect, it } from "vitest";

import {
  createPkceChallenge,
  decodeBase64Url,
  decodeBase64UrlUtf8,
  encodeBase64Url,
  encodeBase64UrlUtf8,
  generatePkcePair,
  hashOpaqueCredential,
  importEd25519VerificationKey,
  randomBase64UrlToken,
  sealPkceVerifier,
  sha256Base64Url,
  signCompactValue,
  timingResistantEqual,
  unsealPkceVerifier,
  verifyCompactValue,
  verifyEd25519Challenge,
} from "../../apps/guildhall/src/worker/auth/crypto";

describe("opaque values and strict encodings", () => {
  it("generates 256-bit random, canonical base64url tokens by default", () => {
    const first = randomBase64UrlToken();
    const second = randomBase64UrlToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(decodeBase64Url(first)).toHaveLength(32);
    expect(second).not.toBe(first);
    expect(decodeBase64Url(randomBase64UrlToken(48))).toHaveLength(48);
  });

  it("round-trips UTF-8 and rejects malformed or noncanonical input", () => {
    const message = "Guildhall 🐉";
    expect(decodeBase64UrlUtf8(encodeBase64UrlUtf8(message))).toBe(message);
    expect(() => decodeBase64Url("with=padding")).toThrow(
      "Invalid base64url value",
    );
    expect(() => decodeBase64Url("A")).toThrow("Invalid base64url value");
    expect(() => decodeBase64Url("Zh")).toThrow("Invalid base64url value");
    expect(() => decodeBase64UrlUtf8("_w")).toThrow(
      "Invalid base64url UTF-8 value",
    );
  });

  it("hashes credentials with SHA-256 without changing the public digest format", async () => {
    await expect(sha256Base64Url("abc")).resolves.toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
    await expect(hashOpaqueCredential("abc")).resolves.toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });
});

describe("GitHub S256 PKCE", () => {
  it("matches the RFC 7636 deterministic verifier/challenge vector", async () => {
    await expect(
      createPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a valid 43-character verifier and S256 challenge", async () => {
    const pair = await generatePkcePair();

    expect(pair).toMatchObject({ method: "S256" });
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(createPkceChallenge(pair.verifier)).resolves.toBe(
      pair.challenge,
    );
  });
});

describe("timing-resistant equality", () => {
  it("handles equal, unequal, empty, and different-length byte strings", () => {
    expect(timingResistantEqual("same", "same")).toBe(true);
    expect(timingResistantEqual("same", "tame")).toBe(false);
    expect(timingResistantEqual("short", "shorter")).toBe(false);
    expect(timingResistantEqual(new Uint8Array(), new Uint8Array())).toBe(true);
    expect(
      timingResistantEqual(
        new Uint8Array([0, 1, 2]),
        new Uint8Array([0, 1, 3]),
      ),
    ).toBe(false);
  });
});

describe("HMAC compact values", () => {
  const secret = "server-cookie-secret-with-enough-entropy";
  const expiresAt = 2_000_000;

  it("authenticates the payload and absolute expiry", async () => {
    const compact = await signCompactValue(
      "flow-state-hash",
      expiresAt,
      secret,
    );

    await expect(
      verifyCompactValue(compact, secret, expiresAt - 1),
    ).resolves.toEqual({ valid: true, payload: "flow-state-hash", expiresAt });
  });

  it("collapses payload, expiry, signature, secret, and expiry failures", async () => {
    const compact = await signCompactValue(
      "flow-state-hash",
      expiresAt,
      secret,
    );
    const [version, payload, expiry, signature] = compact.split(".") as [
      string,
      string,
      string,
      string,
    ];
    const invalid = { valid: false, reason: "invalid_or_expired" };

    await expect(
      verifyCompactValue(
        [version, `${payload}A`, expiry, signature].join("."),
        secret,
        expiresAt - 1,
      ),
    ).resolves.toEqual(invalid);
    await expect(
      verifyCompactValue(
        [version, payload, String(expiresAt + 1), signature].join("."),
        secret,
        expiresAt - 1,
      ),
    ).resolves.toEqual(invalid);
    await expect(
      verifyCompactValue(
        [version, payload, expiry, mutateBase64Url(signature)].join("."),
        secret,
        expiresAt - 1,
      ),
    ).resolves.toEqual(invalid);
    await expect(
      verifyCompactValue(compact, "wrong-secret-marker", expiresAt - 1),
    ).resolves.toEqual(invalid);
    await expect(
      verifyCompactValue(compact, secret, expiresAt),
    ).resolves.toEqual(invalid);
  });

  it("does not echo malformed compact input in generic failures", async () => {
    const marker = "do-not-echo-this-cookie";
    const result = await verifyCompactValue(marker, secret, 0);

    expect(result).toEqual({ valid: false, reason: "invalid_or_expired" });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

describe("AES-GCM sealed PKCE verifiers", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const secret = "pkce-seal-secret-with-enough-entropy";
  const aad = "oauth-flow:flow-id-7";

  it("round-trips with explicit AAD and a fresh IV", async () => {
    const first = await sealPkceVerifier(verifier, secret, aad);
    const second = await sealPkceVerifier(verifier, secret, aad);

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
    expect(second).not.toBe(first);
    await expect(unsealPkceVerifier(first, secret, aad)).resolves.toBe(
      verifier,
    );
  });

  it("returns only null for tamper, wrong-secret, wrong-AAD, and malformed values", async () => {
    const sealed = await sealPkceVerifier(verifier, secret, aad);
    const [version, initializationVector, ciphertext] = sealed.split(".") as [
      string,
      string,
      string,
    ];
    const tampered = [
      version,
      initializationVector,
      mutateBase64Url(ciphertext),
    ].join(".");

    await expect(unsealPkceVerifier(tampered, secret, aad)).resolves.toBeNull();
    await expect(
      unsealPkceVerifier(sealed, "wrong-secret-marker", aad),
    ).resolves.toBeNull();
    await expect(
      unsealPkceVerifier(sealed, secret, "wrong-aad-marker"),
    ).resolves.toBeNull();
    await expect(
      unsealPkceVerifier("sealed-marker-not-valid", secret, aad),
    ).resolves.toBeNull();
  });

  it("uses a generic sealing error without verifier or secret contents", async () => {
    const badVerifier = "sensitive-but-invalid";
    const secretMarker = "server-secret-marker";

    await expect(
      sealPkceVerifier(badVerifier, secretMarker, aad),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message === "Unable to seal PKCE verifier" &&
        !message.includes(badVerifier) &&
        !message.includes(secretMarker)
      );
    });
  });
});

describe("Ed25519 possession challenges", () => {
  it("accepts the right public key and exact UTF-8 challenge", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const challenge = "pairing-challenge-🐲";
    const signature = await crypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      new TextEncoder().encode(challenge),
    );

    await expect(
      importEd25519VerificationKey(publicJwk),
    ).resolves.toMatchObject({ type: "public" });
    await expect(
      verifyEd25519Challenge(
        publicJwk,
        challenge,
        encodeBase64Url(new Uint8Array(signature)),
      ),
    ).resolves.toBe(true);
  });

  it("rejects the wrong challenge, wrong key, and malformed signature", async () => {
    const signer = await ed25519Fixture("exact-challenge");
    const other = await ed25519Fixture("exact-challenge");

    await expect(
      verifyEd25519Challenge(
        signer.publicJwk,
        "wrong-challenge",
        signer.signature,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Challenge(
        other.publicJwk,
        signer.challenge,
        signer.signature,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519Challenge(
        signer.publicJwk,
        signer.challenge,
        "not-a-signature",
      ),
    ).resolves.toBe(false);
  });

  it("rejects private JWKs and incompatible public-key metadata", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const [publicJwk, privateJwk] = await Promise.all([
      crypto.subtle.exportKey("jwk", pair.publicKey),
      crypto.subtle.exportKey("jwk", pair.privateKey),
    ]);

    await expect(importEd25519VerificationKey(privateJwk)).rejects.toThrow(
      "Invalid Ed25519 public key",
    );
    await expect(
      importEd25519VerificationKey({ ...publicJwk, crv: "X25519" }),
    ).rejects.toThrow("Invalid Ed25519 public key");
    await expect(
      importEd25519VerificationKey({ ...publicJwk, alg: "ES256" }),
    ).rejects.toThrow("Invalid Ed25519 public key");
    await expect(
      importEd25519VerificationKey({ ...publicJwk, key_ops: ["sign"] }),
    ).rejects.toThrow("Invalid Ed25519 public key");
  });
});

function mutateBase64Url(value: string): string {
  const finalCharacter = value.at(-1);
  return `${value.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
}

async function ed25519Fixture(challenge: string) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    pair.privateKey,
    new TextEncoder().encode(challenge),
  );
  return {
    challenge,
    publicJwk,
    signature: encodeBase64Url(new Uint8Array(signature)),
  };
}
