import { describe, expect, it } from "vitest";

import {
  createRedactedPublicPayload,
  PUBLIC_SAFETY_LIMITS,
  PUBLIC_SAFETY_RULESET_VERSION,
  PublicSafetyCategory,
  scanPublicPayload,
} from "../../packages/trust-engine/src/safetyScanner.js";
import dangerousHtml from "./fixtures/dangerous-html.json";
import privateUrl from "./fixtures/private-url.json";
import safeMission from "./fixtures/safe-accessibility-mission.json";
import syntheticPii from "./fixtures/synthetic-pii.json";
import syntheticProviderToken from "./fixtures/synthetic-provider-token.json";

function expectRejection(
  input: unknown,
  category: (typeof PublicSafetyCategory)[keyof typeof PublicSafetyCategory],
  fieldPath?: string,
) {
  const result = scanPublicPayload(input);
  expect(result).toEqual({
    safe: false,
    fieldPath: fieldPath ?? expect.any(String),
    category,
  });
  expect(Object.keys(result).sort()).toEqual(["category", "fieldPath", "safe"]);
  return result;
}

describe("scanPublicPayload", () => {
  it("never echoes a matched token used as an object key", () => {
    const syntheticToken = `sk-proj-${"K".repeat(28)}`;
    const result = scanPublicPayload({ [syntheticToken]: "value" });
    expect(result).toEqual({
      safe: false,
      fieldPath: "$[key:0]",
      category: "provider-token",
    });
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
  });

  it("passes the safe accessibility mission and known non-secret identifiers", () => {
    expect(scanPublicPayload(safeMission)).toEqual({ safe: true });
    expect(
      scanPublicPayload({
        uuid: "11111111-1111-4111-8111-111111111111",
        timestamp: "2026-08-26T15:30:00.000Z",
        prose: "Agents negotiate a pact and publish a deterministic receipt.",
        publicUrl: "https://www.w3.org/WAI/standards-guidelines/wcag/",
      }),
    ).toEqual({ safe: true });
  });

  it("returns a stable result and ruleset version across calls", () => {
    const first = scanPublicPayload(safeMission);
    const second = scanPublicPayload(safeMission);
    expect(first).toEqual(second);
    expect(PUBLIC_SAFETY_RULESET_VERSION).toBe("guildhall-public-safety/1.0.0");
  });

  it("rejects representative synthetic provider, GitHub, AWS, bearer, and PEM material", () => {
    expectRejection(
      syntheticProviderToken,
      PublicSafetyCategory.ProviderToken,
      "$.brief",
    );
    expectRejection(
      { note: "ghp_SYNTHETICPLACEHOLDER123456789" },
      PublicSafetyCategory.GithubToken,
      "$.note",
    );
    expectRejection(
      { note: "AKIASYNTHETICFIXTURE" },
      PublicSafetyCategory.AwsCredential,
      "$.note",
    );
    expectRejection(
      { note: "Bearer SYNTHETIC_PLACEHOLDER_TOKEN" },
      PublicSafetyCategory.BearerToken,
      "$.note",
    );
    expectRejection(
      {
        note: "-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----",
      },
      PublicSafetyCategory.PrivateKey,
      "$.note",
    );
  });

  it("rejects provider credential fields even when their value looks harmless", () => {
    const placeholder = "not-configured";
    const rejection = expectRejection(
      { openaiApiKey: placeholder },
      PublicSafetyCategory.CredentialField,
      "$.openaiApiKey",
    );
    expect(JSON.stringify(rejection)).not.toContain(placeholder);
  });

  it("rejects high-entropy strings only when they appear in secret-like contexts", () => {
    const syntheticEntropy = "A1b2C3d4E5f6G7h8I9j0KLMNOPqrstuv";
    expectRejection(
      { deploymentToken: syntheticEntropy },
      PublicSafetyCategory.HighEntropySecret,
      "$.deploymentToken",
    );
    expect(scanPublicPayload({ publicIdentifier: syntheticEntropy })).toEqual({
      safe: true,
    });
  });

  it("allows public JWK material but rejects private JWK components", () => {
    const publicJwk = {
      kty: "OKP",
      crv: "Ed25519",
      kid: "22222222-2222-4222-8222-222222222222",
      x: "11qYAYdk9Jqoz0CwJ09NbfHWlTW0Y8hbC4Z9tSDGKUE",
    };
    expect(scanPublicPayload(publicJwk)).toEqual({ safe: true });
    expectRejection(
      { ...publicJwk, d: "SYNTHETIC_PRIVATE_COMPONENT" },
      PublicSafetyCategory.PrivateKey,
      "$.d",
    );
  });

  it("rejects PII categories without echoing fixture values", () => {
    const emailRejection = expectRejection(
      { email: syntheticPii.email },
      PublicSafetyCategory.EmailAddress,
      "$.email",
    );
    expect(JSON.stringify(emailRejection)).not.toContain(syntheticPii.email);

    expectRejection(
      { contact: syntheticPii.phone },
      PublicSafetyCategory.PhoneNumber,
      "$.contact",
    );
    expectRejection(
      { phone: "555-010-9999" },
      PublicSafetyCategory.PhoneNumber,
      "$.phone",
    );
    expectRejection(
      { identifier: syntheticPii.governmentId },
      PublicSafetyCategory.GovernmentId,
      "$.identifier",
    );
  });

  it("rejects private locations and non-allowlisted URL protocols", () => {
    expectRejection(
      privateUrl,
      PublicSafetyCategory.PrivateNetwork,
      "$.publicInput",
    );
    expectRejection(
      { publicInput: "http://example.com/fixture" },
      PublicSafetyCategory.NonAllowlistedUrlProtocol,
      "$.publicInput",
    );
    expectRejection(
      { publicInput: "https://service.internal/fixture" },
      PublicSafetyCategory.PrivateNetwork,
      "$.publicInput",
    );
  });

  it("allows inert HTML and rejects executable HTML/script constraints", () => {
    expect(
      scanPublicPayload({ html: "<main><h1>Safe fixture</h1></main>" }),
    ).toEqual({ safe: true });
    expectRejection(
      dangerousHtml,
      PublicSafetyCategory.ExecutableContent,
      "$.publicInput",
    );
    expectRejection(
      { html: "<script>syntheticCall()</script>" },
      PublicSafetyCategory.ExecutableContent,
      "$.html",
    );
    expectRejection(
      { html: "javascript:syntheticCall()" },
      PublicSafetyCategory.ExecutableContent,
      "$.html",
    );
  });

  it("bounds aggregate bytes, depth, key count, and array items", () => {
    expectRejection(
      { text: "x".repeat(PUBLIC_SAFETY_LIMITS.maximumAggregateBytes) },
      PublicSafetyCategory.PayloadTooLarge,
      "$.text",
    );

    let deep: unknown = "leaf";
    for (
      let index = 0;
      index <= PUBLIC_SAFETY_LIMITS.maximumDepth;
      index += 1
    ) {
      deep = { nested: deep };
    }
    expectRejection(deep, PublicSafetyCategory.MaximumDepthExceeded);

    const tooManyKeys = Object.fromEntries(
      Array.from(
        { length: PUBLIC_SAFETY_LIMITS.maximumKeysPerObject + 1 },
        (_, index) => [`field${index}`, index],
      ),
    );
    expectRejection(tooManyKeys, PublicSafetyCategory.KeyLimitExceeded, "$");

    expectRejection(
      Array.from(
        { length: PUBLIC_SAFETY_LIMITS.maximumArrayItems + 1 },
        () => null,
      ),
      PublicSafetyCategory.ArrayLimitExceeded,
      "$",
    );
  });

  it("never exposes a matched value, excerpt, entropy sample, or hostile key", () => {
    const secret = "sk-test-SYNTHETIC_DO_NOT_ECHO_123456789";
    const result = scanPublicPayload({
      "not.safe/sk-test-SHOULD_NOT_ECHO_123456": secret,
    });
    const serialized = JSON.stringify(result);
    expect(result).toEqual({
      safe: false,
      fieldPath: "$[key:0]",
      category: PublicSafetyCategory.ProviderToken,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("SHOULD_NOT_ECHO");
  });

  it("rejects unsupported JSON shapes and cycles without throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectRejection(
      cyclic,
      PublicSafetyCategory.UnsupportedJsonValue,
      "$.self",
    );
    expectRejection(
      { value: Number.POSITIVE_INFINITY },
      PublicSafetyCategory.UnsupportedJsonValue,
      "$.value",
    );

    const arrayWithExtraPublicField: unknown[] & { openaiApiKey?: string } = [];
    arrayWithExtraPublicField.openaiApiKey = "not-configured";
    expectRejection(
      arrayWithExtraPublicField,
      PublicSafetyCategory.UnsupportedJsonValue,
      "$",
    );
  });
});

describe("createRedactedPublicPayload", () => {
  it("returns an immutable marker without caller-owned IDs or digests", () => {
    const marker = createRedactedPublicPayload();
    expect(marker).toEqual({
      kind: "redacted-public-payload",
      rulesetVersion: PUBLIC_SAFETY_RULESET_VERSION,
    });
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Object.keys(marker).sort()).toEqual(["kind", "rulesetVersion"]);
  });
});
