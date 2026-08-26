import { describe, expect, it } from "vitest";

import {
  assertCapabilityInput,
  createCapabilityResultEnvelope,
  getCapabilityDefinition,
} from "./capabilities.js";
import { CapabilitySchemaValidationError } from "./schema.js";

describe("canonical capability validation", () => {
  it("accepts bounded input and rejects undeclared transport metadata", () => {
    const capability = getCapabilityDefinition("guild.list_missions");

    expect(() =>
      assertCapabilityInput(capability, { limit: 25 }),
    ).not.toThrow();
    expect(() =>
      assertCapabilityInput(capability, {
        limit: 25,
        source: "webmcp",
      }),
    ).toThrow(CapabilitySchemaValidationError);
  });

  it("keeps private signing proof out of model-facing inputs", () => {
    for (const name of [
      "guild.accept_pact",
      "guild.submit_artifact",
    ] as const) {
      const properties = getCapabilityDefinition(name).inputSchema
        .properties as Readonly<Record<string, unknown>>;
      expect(properties).not.toHaveProperty("proof");
    }
  });

  it("separates capability bids from versioned assignment proposals", () => {
    const capability = getCapabilityDefinition("guild.propose_allocation");
    const base = {
      missionId: "00000000-0000-4000-8000-000000000001",
      expectedSequence: 5,
    };
    expect(() =>
      assertCapabilityInput(capability, {
        ...base,
        negotiationStep: "capability-bid",
        relevantCapabilities: ["accessibility-audit"],
        proposedContribution: "Inspect the public fixture.",
      }),
    ).not.toThrow();
    expect(() =>
      assertCapabilityInput(capability, {
        ...base,
        negotiationStep: "capability-bid",
        relevantCapabilities: ["accessibility-audit"],
        proposedContribution: "Inspect the public fixture.",
        pactVersion: 2,
      }),
    ).toThrow("fields from another negotiationStep");
  });

  it("validates domain output before assigning trusted provenance", () => {
    const capability = getCapabilityDefinition("guild.list_missions");

    expect(
      createCapabilityResultEnvelope(capability, "mcp", {
        missions: [],
        nextCursor: null,
      }),
    ).toEqual({
      data: { missions: [], nextCursor: null },
      provenance: {
        transport: "mcp",
        trusted: true,
        actionName: "guild.list_missions",
        canonicalHandlerId: "mission.list.v1",
      },
    });

    expect(() =>
      createCapabilityResultEnvelope(capability, "mcp", { missions: [] }),
    ).toThrow(CapabilitySchemaValidationError);
  });

  it("enforces cross-field mission party and deadline invariants", () => {
    const capability = getCapabilityDefinition("guild.publish_mission");
    const base = {
      commandId: "00000000-0000-4000-8000-000000000001",
      title: "Audit the dungeon",
      goal: "Find deterministic accessibility defects.",
      publicInputs: [
        {
          inputId: "input-1",
          type: "inline",
          location: "fixture:axe-demo-v1",
          mediaType: "application/json",
        },
      ],
      requiredCapabilities: ["accessibility"],
      minimumPartySize: 1,
      preferredPartySize: 2,
      maximumPartySize: 2,
      formationDeadline: "2026-08-27T12:00:00.000Z",
      deliveryDeadline: "2026-08-28T12:00:00.000Z",
      requiredOutputs: [
        {
          outputId: "findings",
          type: "accessibility-findings",
          mediaType: "application/json",
          publicLocation: "mission-artifact",
        },
      ],
      verificationCriteria: [
        {
          criterionId: "axe-rules",
          description: "Each finding includes its rule ID.",
          required: true,
          method: "deterministic",
        },
      ],
      difficulty: "adept",
      pointReward: 100,
      failureBehavior: {
        negotiationTimeout: "reopen-recruitment",
        participantDefault: "recruit-exact-slot-replacement",
        replacementAuthorized: true,
        verificationCorrectionLimit: 1,
      },
    };

    expect(() => assertCapabilityInput(capability, base)).not.toThrow();
    expect(() =>
      assertCapabilityInput(capability, {
        ...base,
        minimumPartySize: 2,
        preferredPartySize: 1,
      }),
    ).toThrow("minimum <= preferred <= maximum");
    expect(() =>
      assertCapabilityInput(capability, {
        ...base,
        formationDeadline: base.deliveryDeadline,
      }),
    ).toThrow("formationDeadline must precede deliveryDeadline");
  });
});
