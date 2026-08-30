import { describe, expect, it } from "vitest";

import {
  artifactSigningBytes,
  artifactProofDigest,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
  commandBodyHash,
  commandSigningBytes,
  ed25519PublicJwkThumbprint,
  generateEd25519KeyPair,
  importEd25519PrivateJwk,
  importEd25519PublicJwk,
  pactSigningBytes,
  replacementSigningBytes,
  signEd25519,
  sha256Base64Url,
  verifyEd25519,
  verifyRegisteredEd25519Proof,
  type RegisteredEd25519Key,
} from "../../packages/contracts/src/signatures";

const decoder = new TextDecoder();

describe("RFC 8785 canonicalization and SHA-256", () => {
  it("canonicalizes semantically identical objects to identical bytes and digests", async () => {
    const first = { z: [3, { b: true, a: null }], a: "guild" };
    const second = { a: "guild", z: [3, { a: null, b: true }] };

    expect(canonicalJson(first)).toBe(
      '{"a":"guild","z":[3,{"a":null,"b":true}]}',
    );
    expect(canonicalJsonBytes(first)).toEqual(canonicalJsonBytes(second));
    await expect(canonicalJsonDigest(first)).resolves.toBe(
      await canonicalJsonDigest(second),
    );
  });

  it("changes the digest after a one-byte material mutation", async () => {
    const original = { assignment: "audit-a" };
    const mutated = { assignment: "audit-b" };

    expect(canonicalJsonBytes(original).byteLength).toBe(
      canonicalJsonBytes(mutated).byteLength,
    );
    await expect(canonicalJsonDigest(original)).resolves.not.toBe(
      await canonicalJsonDigest(mutated),
    );
  });

  it("uses standard unpadded base64url digest encoding", async () => {
    await expect(sha256Base64Url("abc")).resolves.toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });

  it("rejects values outside the I-JSON data model", () => {
    expect(() => canonicalJson({ hidden: undefined })).toThrow(/I-JSON/u);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalJson("\ud800")).toThrow(/Unicode surrogate/u);
  });
});

describe("commitment/v1 signature domains", () => {
  it("builds the exact pact, replacement, and artifact messages", () => {
    expect(decoder.decode(pactSigningBytes("pact-digest"))).toBe(
      "PACTBRIDGE-COMMITMENT-V1\npact-digest",
    );
    expect(
      decoder.decode(
        replacementSigningBytes("pact-digest", "slot-scribe", "agent-scribe"),
      ),
    ).toBe("PACTBRIDGE-REPLACEMENT-V1\npact-digest\nslot-scribe\nagent-scribe");
    expect(
      decoder.decode(artifactSigningBytes("pact-digest", "artifact-digest")),
    ).toBe("PACTBRIDGE-ARTIFACT-V1\npact-digest\nartifact-digest");
    expect(decoder.decode(commandSigningBytes("body-digest"))).toBe(
      "PACTBRIDGE-COMMAND-V1\nbody-digest",
    );
  });

  it("excludes trusted source and proof from the signed command projection", async () => {
    const command = {
      commandId: "command-1",
      action: "accept_pact",
      missionId: "mission-1",
      expectedSequence: 18,
      actor: { agentId: "agent-1" },
      issuedAt: "2026-08-26T15:00:00.000Z",
      payload: { pactDigest: "digest-1" },
      source: "mcp",
      proof: { signature: "ignored" },
    };
    await expect(commandBodyHash(command)).resolves.toBe(
      await commandBodyHash({
        ...command,
        source: "a2a",
        proof: { signature: "other" },
      }),
    );
    await expect(commandBodyHash(command)).resolves.not.toBe(
      await commandBodyHash({
        ...command,
        payload: { pactDigest: "digest-2" },
      }),
    );
  });

  it("does not allow an ambiguous line-delimited domain component", () => {
    expect(() => pactSigningBytes("digest\nother-domain-data")).toThrow(
      /control characters/u,
    );
  });

  it("rejects control characters in every line-delimited domain component", () => {
    expect(() =>
      replacementSigningBytes(
        "pact-digest",
        "slot\u0000scribe",
        "agent-scribe",
      ),
    ).toThrow(/control characters/u);
  });
});

describe("complete artifact commitment", () => {
  it("changes the proof digest when any public artifact field changes", async () => {
    const base = {
      outputId: "10000000-0000-4000-8000-000000000001",
      metadata: {
        protocol: "commitment/v1",
        kind: "artifact-metadata",
        artifactId: "10000000-0000-4000-8000-000000000002",
        missionId: "10000000-0000-4000-8000-000000000003",
        pactDigest: "P".repeat(43),
        roleSlotId: "10000000-0000-4000-8000-000000000004",
        producingAgentId: "10000000-0000-4000-8000-000000000005",
        keyId: "10000000-0000-4000-8000-000000000006",
        attempt: 1,
        artifactType: "accessibility-findings",
        mediaType: "application/json",
        publicLocation: "https://guildhall.test/artifacts/one",
        contentDigest: "C".repeat(43),
        signature: "S".repeat(86),
        safetyStatus: "approved",
        completedAt: "2026-08-28T12:00:00.000Z",
      },
      dependencyArtifactIds: ["10000000-0000-4000-8000-000000000007"],
    };
    const expected = await artifactProofDigest(base);
    const mutations = [
      { ...base, outputId: "10000000-0000-4000-8000-000000000008" },
      { ...base, dependencyArtifactIds: [] },
      ...Object.keys(base.metadata)
        .filter((key) => key !== "signature")
        .map((key) => ({
          ...base,
          metadata: {
            ...base.metadata,
            [key]: `${String(base.metadata[key as keyof typeof base.metadata])}-changed`,
          },
        })),
    ];
    for (const mutation of mutations) {
      await expect(artifactProofDigest(mutation)).resolves.not.toBe(expected);
    }
    await expect(
      artifactProofDigest({
        ...base,
        metadata: { ...base.metadata, signature: "T".repeat(86) },
      }),
    ).resolves.toBe(expected);
  });
});

describe("Ed25519 proofs", () => {
  it("imports public and private JWKs for a signing round trip", async () => {
    const generated = await generateEd25519KeyPair();
    const [privateJwk, publicJwk] = await Promise.all([
      crypto.subtle.exportKey("jwk", generated.privateKey),
      crypto.subtle.exportKey("jwk", generated.publicKey),
    ]);
    const [privateKey, publicKey] = await Promise.all([
      importEd25519PrivateJwk(privateJwk),
      importEd25519PublicJwk(publicJwk),
    ]);
    const message = pactSigningBytes("pact-digest");
    const signature = await signEd25519(privateKey, message);

    await expect(verifyEd25519(publicKey, message, signature)).resolves.toBe(
      true,
    );
  });

  it("verifies the right domain/key and rejects wrong-domain, wrong-key, and altered payload", async () => {
    const signer = await generateEd25519KeyPair();
    const other = await generateEd25519KeyPair();
    const pactDigest = await canonicalJsonDigest({ missionId: "mission-1" });
    const pactMessage = pactSigningBytes(pactDigest);
    const signature = await signEd25519(signer.privateKey, pactMessage);

    await expect(
      verifyEd25519(signer.publicKey, pactMessage, signature),
    ).resolves.toBe(true);
    await expect(
      verifyEd25519(
        signer.publicKey,
        artifactSigningBytes(pactDigest, pactDigest),
        signature,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519(other.publicKey, pactMessage, signature),
    ).resolves.toBe(false);
    await expect(
      verifyEd25519(
        signer.publicKey,
        pactSigningBytes(await canonicalJsonDigest({ missionId: "mission-2" })),
        signature,
      ),
    ).resolves.toBe(false);
  });

  it("derives stable RFC 7638 public-key thumbprints", async () => {
    const signer = await generateEd25519KeyPair();
    const publicJwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
    const reorderedJwk: JsonWebKey = {
      x: publicJwk.x,
      crv: publicJwk.crv,
      kty: publicJwk.kty,
      key_ops: publicJwk.key_ops,
      ext: publicJwk.ext,
    };

    await expect(ed25519PublicJwkThumbprint(publicJwk)).resolves.toBe(
      await ed25519PublicJwkThumbprint(reorderedJwk),
    );
  });

  it("does not accept a private JWK where a public verification key is required", async () => {
    const signer = await generateEd25519KeyPair();
    const privateJwk = await crypto.subtle.exportKey("jwk", signer.privateKey);
    await expect(ed25519PublicJwkThumbprint(privateJwk)).rejects.toThrow(
      /public JWK/u,
    );
  });

  it("rejects a revoked key for a new proof", async () => {
    const fixture = await proofFixture({
      status: "revoked",
      revokedAt: "2026-08-26T12:00:00.000Z",
    });

    await expect(
      verifyRegisteredEd25519Proof({
        ...fixture,
        policy: { kind: "new-proof" },
      }),
    ).resolves.toEqual({ valid: false, reason: "KEY_REVOKED" });
  });

  it("preserves valid historical proofs made before revocation", async () => {
    const fixture = await proofFixture({
      status: "revoked",
      revokedAt: "2026-08-26T12:00:00.000Z",
    });

    const result = await verifyRegisteredEd25519Proof({
      ...fixture,
      policy: {
        kind: "historical-proof",
        acceptedAt: "2026-08-26T11:59:59.000Z",
      },
    });

    expect(result).toMatchObject({
      valid: true,
      keyId: fixture.key.keyId,
    });
  });

  it("does not treat a proof made after revocation as historical", async () => {
    const fixture = await proofFixture({
      status: "revoked",
      revokedAt: "2026-08-26T12:00:00.000Z",
    });

    await expect(
      verifyRegisteredEd25519Proof({
        ...fixture,
        policy: {
          kind: "historical-proof",
          acceptedAt: "2026-08-26T12:00:00.001Z",
        },
      }),
    ).resolves.toEqual({
      valid: false,
      reason: "PROOF_ACCEPTED_AFTER_REVOCATION",
    });
  });

  it("verifies pre-rotation history but rejects new proofs from retired keys", async () => {
    const fixture = await proofFixture({
      status: "retired",
      retiredAt: "2026-08-26T12:00:00.000Z",
    });
    await expect(
      verifyRegisteredEd25519Proof({
        ...fixture,
        policy: { kind: "new-proof" },
      }),
    ).resolves.toEqual({ valid: false, reason: "KEY_RETIRED" });
    await expect(
      verifyRegisteredEd25519Proof({
        ...fixture,
        policy: {
          kind: "historical-proof",
          acceptedAt: "2026-08-26T11:59:59.999Z",
        },
      }),
    ).resolves.toMatchObject({ valid: true });
  });
});

async function proofFixture(
  keyStatus: Pick<RegisteredEd25519Key, "status" | "retiredAt" | "revokedAt">,
) {
  const pair = await generateEd25519KeyPair();
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const message = pactSigningBytes(
    await canonicalJsonDigest({ missionId: "mission-proof-fixture" }),
  );
  const signature = await signEd25519(pair.privateKey, message);
  const key: RegisteredEd25519Key = {
    keyId: "key-ed25519-1",
    publicJwk,
    ...keyStatus,
  };

  return {
    key,
    message,
    proof: { keyId: key.keyId, signature },
  };
}
