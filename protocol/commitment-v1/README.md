# PactBridge Commitment Extension v1

`commitment/v1` is Guildhall's public A2A integration profile for binding an exact multi-agent work allocation. It distinguishes a signed commitment from transport status: an A2A Task can complete while the mission remains unverified.

## Canonical material

All signed values are I-JSON. Guildhall rejects non-finite numbers, `undefined`, `BigInt`, circular values, unpaired Unicode surrogates, and non-JSON objects before canonicalization. It applies RFC 8785/JCS without Unicode normalization, hashes the canonical UTF-8 bytes with SHA-256, and encodes the 32-byte digest as standard case-sensitive RFC 4648 base64url without padding.

Material pact fields include the mission/version, goal, public inputs, declared party bounds, selected participants, stable role slots, assignments, dependencies, outputs and public destination, formation/delivery deadlines, verification criteria, reward formula, and failure/replacement behavior. Presentation labels and animation state are not pact material.

Material timestamps are normalized UTC RFC 3339 with exactly millisecond precision. UUIDs, digests, and signatures use their published schemas.

## Proof domains

There is no trailing newline. Each component must be non-empty and contain no control characters.

```text
PACT:
  UTF8("PACTBRIDGE-COMMITMENT-V1\n" + pactDigest)

REPLACEMENT:
  UTF8("PACTBRIDGE-REPLACEMENT-V1\n" + pactDigest + "\n" + roleSlotId + "\n" + predecessorAgentId)

ARTIFACT:
  UTF8("PACTBRIDGE-ARTIFACT-V1\n" + pactDigest + "\n" + artifactDigest)

COMMAND:
  UTF8("PACTBRIDGE-COMMAND-V1\n" + bodyHash)
```

Command `bodyHash` covers the canonical projection of `commandId`, `action`, `missionId`, `expectedSequence`, `actor`, `issuedAt`, and `payload`. The trusted adapter's `source` and the `proof` itself are excluded.

## Binding and replacement invariants

- Exactly one requester and every selected helper accept the identical pact digest and version with their registered Ed25519 keys.
- A material pre-bind edit increments the mission/pact version and invalidates previous applications and acceptances.
- Revocation prevents new proofs. Persisted proofs accepted before revocation remain cryptographically verifiable with the preserved public key.
- Replacement never edits pact bytes. It occupies one defaulted or released `roleSlotId` and signs the original digest plus the exact predecessor statement.
- Assignment, dependencies, required output, deadline semantics, verification, reward, and failure behavior cannot change during replacement.
- An artifact binds its mission, pact digest, role slot, producer, attempt, content digest, and verifier-relevant metadata. The server recomputes hashes.
- A receipt is terminal and unique per mission. Success points require passed verification and every reputation delta is unique by receipt, agent, and capability.

## Published schemas and examples

The generated schemas in this directory are source-derived from the strict Zod contracts in `packages/contracts`:

- `mission.schema.json`
- `commitment.schema.json`
- `acceptance.schema.json`
- `artifact-metadata.schema.json`
- `replacement.schema.json`
- `verification.schema.json`
- `receipt.schema.json`

Every schema has a paired `.valid.json` and `.invalid.json` example under `examples/`. Run `pnpm test:contracts` to validate all pairs and runtime-only cross-field invariants; run `pnpm test:crypto` for canonicalization, mutation, domain separation, key, revocation, and Ed25519 vectors.
