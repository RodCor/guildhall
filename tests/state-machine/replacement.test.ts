import { describe, expect, it } from "vitest";

import type {
  MaterialPactTerms,
  PactTerms,
} from "../../packages/mission-engine/src/negotiation.js";
import {
  replaceStableRoleSlot,
  type ReplacementAcceptance,
  type ReplacementAttempt,
  type StableRoleSlotOccupancy,
} from "../../packages/mission-engine/src/replacement.js";

const BOUND_DIGEST = "D".repeat(43);
const OTHER_DIGEST = "E".repeat(43);

function terms(
  overrides: Partial<MaterialPactTerms> = {},
  title = "The Lighthouse Vault",
): PactTerms {
  return {
    material: {
      goal: "Audit the fixture",
      publicInputs: [{ location: "/fixtures/a11y.html" }],
      requiredCapabilities: ["accessibility-audit"],
      partyBounds: { minimum: 1, preferred: 2, maximum: 2 },
      participants: ["requester", "scout", "scribe"],
      roleSlots: ["findings", "remediation"],
      assignments: { findings: "audit", remediation: "fix plan" },
      dependencies: { remediation: ["findings"] },
      requiredOutputs: ["findings.json", "remediation.json"],
      formationDeadline: "2026-08-26T16:00:00.000Z",
      deliveryDeadline: "2026-08-26T17:00:00.000Z",
      verification: ["fixture-hash", "rule-coverage"],
      reward: { totalPoints: 100, recoveryBonus: 10 },
      failureBehavior: { participantDefault: "replace-exact-slot" },
      ...overrides,
    },
    presentation: { title },
  };
}

function slots(): readonly StableRoleSlotOccupancy[] {
  return [
    {
      roleSlotId: "findings",
      originalAgentId: "scout",
      occupantAgentId: "scout",
      status: "active",
    },
    {
      roleSlotId: "remediation",
      originalAgentId: "scribe",
      occupantAgentId: "scribe",
      status: "defaulted",
    },
  ];
}

function acceptance(
  overrides: Partial<ReplacementAcceptance> = {},
): ReplacementAcceptance {
  return {
    roleSlotId: "remediation",
    predecessorAgentId: "scribe",
    replacementAgentId: "warden",
    pactDigest: BOUND_DIGEST,
    keyId: "warden-key",
    signature: "warden-signed-original-pact-and-replacement-statement",
    reason: "participant-defaulted",
    preservesPactDigest: true,
    ...overrides,
  };
}

function attempt(
  overrides: Partial<ReplacementAttempt> = {},
): ReplacementAttempt {
  const boundTerms = terms();
  return {
    boundPactDigest: BOUND_DIGEST,
    boundTerms,
    proposedPactDigest: BOUND_DIGEST,
    proposedTerms: boundTerms,
    slots: slots(),
    acceptance: acceptance(),
    ...overrides,
  };
}

describe("exact stable-slot replacement", () => {
  it("changes only the occupant ledger and preserves pact bytes", () => {
    const input = attempt();
    const result = replaceStableRoleSlot(input);

    expect(result.pactDigest).toBe(input.boundPactDigest);
    expect(result.terms).toBe(input.boundTerms);
    expect(result.slots).toEqual([
      input.slots[0],
      {
        roleSlotId: "remediation",
        originalAgentId: "scribe",
        occupantAgentId: "warden",
        status: "active",
      },
    ]);
    expect(input.slots[1]).toMatchObject({
      occupantAgentId: "scribe",
      status: "defaulted",
    });
  });

  it("allows a cosmetic display correction without treating it as scope", () => {
    const input = attempt({
      proposedTerms: terms({}, "The Lighthouse Vault — corrected spelling"),
    });
    expect(replaceStableRoleSlot(input).slots[1]).toMatchObject({
      occupantAgentId: "warden",
    });
  });

  it("requires a defaulted or explicitly released exact slot", () => {
    const activeSlots = slots().map((slot) => ({
      ...slot,
      status: "active" as const,
    }));
    expect(() =>
      replaceStableRoleSlot(attempt({ slots: activeSlots })),
    ).toThrowError(expect.objectContaining({ code: "SLOT_NOT_REPLACEABLE" }));
    expect(() =>
      replaceStableRoleSlot(
        attempt({ acceptance: acceptance({ roleSlotId: "unknown-slot" }) }),
      ),
    ).toThrowError(expect.objectContaining({ code: "SLOT_NOT_FOUND" }));
  });

  it("requires the original predecessor and matching failure reason", () => {
    expect(() =>
      replaceStableRoleSlot(
        attempt({
          acceptance: acceptance({ predecessorAgentId: "someone-else" }),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "PREDECESSOR_MISMATCH" }));
    expect(() =>
      replaceStableRoleSlot(
        attempt({ acceptance: acceptance({ reason: "participant-released" }) }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REPLACEMENT_ACCEPTANCE" }),
    );
  });

  it("rejects every silent material scope or digest change", () => {
    expect(() =>
      replaceStableRoleSlot(
        attempt({
          proposedTerms: terms({
            deliveryDeadline: "2026-08-26T18:00:00.000Z",
          }),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "MATERIAL_PACT_CHANGE" }));

    expect(() =>
      replaceStableRoleSlot(
        attempt({
          proposedPactDigest: OTHER_DIGEST,
          acceptance: acceptance({ pactDigest: OTHER_DIGEST }),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "PACT_DIGEST_MISMATCH" }));
  });

  it("allows one remaining helper to inherit the slot and caps unique active helpers at two", () => {
    expect(
      replaceStableRoleSlot(
        attempt({ acceptance: acceptance({ replacementAgentId: "scout" }) }),
      ).slots[1],
    ).toMatchObject({
      roleSlotId: "remediation",
      originalAgentId: "scribe",
      occupantAgentId: "scout",
      status: "active",
    });
    expect(() =>
      replaceStableRoleSlot(
        attempt({ acceptance: acceptance({ signature: "" }) }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REPLACEMENT_ACCEPTANCE" }),
    );

    const overfullSlots: readonly StableRoleSlotOccupancy[] = [
      ...slots(),
      {
        roleSlotId: "extra-active-slot",
        originalAgentId: "ranger",
        occupantAgentId: "ranger",
        status: "active",
      },
    ];
    expect(() =>
      replaceStableRoleSlot(attempt({ slots: overfullSlots })),
    ).toThrowError(expect.objectContaining({ code: "ACTIVE_HELPER_LIMIT" }));
  });
});
