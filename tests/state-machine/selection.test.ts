import { describe, expect, it } from "vitest";

import {
  selectHelpers,
  type HelperApplication,
} from "../../packages/mission-engine/src/selection";

const constraints = {
  minimumHelpers: 1,
  preferredHelpers: 2,
  maximumHelpers: 2,
} as const;

function application(
  agentId: string,
  overrides: Partial<HelperApplication> = {},
): HelperApplication {
  return {
    agentId,
    skills: ["typescript"],
    verifiedCapabilityRank: 1,
    reliability: 0.9,
    applicationEventSequence: 1,
    ...overrides,
  };
}

describe("deterministic helper selection", () => {
  it("orders by coverage, capability rank, reliability, then application sequence", () => {
    const result = selectHelpers(
      ["typescript", "workers"],
      [
        application("late", {
          skills: ["typescript", "workers"],
          verifiedCapabilityRank: 4,
          reliability: 0.95,
          applicationEventSequence: 20,
        }),
        application("lower-reliability", {
          skills: ["typescript", "workers"],
          verifiedCapabilityRank: 5,
          reliability: 0.8,
          applicationEventSequence: 1,
        }),
        application("winner", {
          skills: ["typescript", "workers"],
          verifiedCapabilityRank: 5,
          reliability: 0.95,
          applicationEventSequence: 10,
        }),
      ],
      { ...constraints, preferredHelpers: 1 },
    );

    expect(result.selectedAgentIds).toEqual(["winner"]);
    expect(result.evidence.map(({ agentId }) => agentId)).toEqual([
      "winner",
      "lower-reliability",
      "late",
    ]);
  });

  it("lets required-skill coverage dominate every later signal", () => {
    const result = selectHelpers(
      ["typescript", "workers"],
      [
        application("veteran", {
          skills: ["typescript"],
          verifiedCapabilityRank: 999,
          reliability: 1,
          applicationEventSequence: 1,
        }),
        application("specialist", {
          skills: ["typescript", "workers", "unrelated"],
          verifiedCapabilityRank: 0,
          reliability: 0,
          applicationEventSequence: 99,
        }),
      ],
      { ...constraints, preferredHelpers: 1 },
    );

    expect(result.selectedAgentIds).toEqual(["specialist"]);
    expect(result.evidence[0]).toMatchObject({
      matchedSkills: ["typescript", "workers"],
      skillCoverageCount: 2,
      skillCoverageRatio: 1,
    });
  });

  it("uses agent id only as a stable final tie breaker", () => {
    const candidates = [application("zeta"), application("alpha")];

    expect(
      selectHelpers(["typescript"], candidates, constraints).selectedAgentIds,
    ).toEqual(["alpha", "zeta"]);
    expect(
      selectHelpers(["typescript"], [...candidates].reverse(), constraints)
        .selectedAgentIds,
    ).toEqual(["alpha", "zeta"]);
  });

  it("never selects more than two helpers", () => {
    const result = selectHelpers(
      ["typescript"],
      [application("a"), application("b"), application("c")],
      { minimumHelpers: 1, preferredHelpers: 3, maximumHelpers: 3 },
    );

    expect(result.targetHelperCount).toBe(2);
    expect(result.selectedAgentIds).toHaveLength(2);
  });

  it("excludes withdrawn and ineligible applications with public evidence", () => {
    const result = selectHelpers(
      ["typescript"],
      [
        application("active", { applicationEventSequence: 3 }),
        application("withdrawn", {
          withdrawn: true,
          applicationEventSequence: 1,
        }),
        application("ineligible", {
          eligible: false,
          applicationEventSequence: 2,
        }),
      ],
      constraints,
    );

    expect(result.selectedAgentIds).toEqual(["active"]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "withdrawn",
          eligible: false,
          selected: false,
          exclusionReason: "withdrawn",
        }),
        expect.objectContaining({
          agentId: "ineligible",
          eligible: false,
          selected: false,
          exclusionReason: "ineligible",
        }),
      ]),
    );
  });

  it("allows one eligible helper to proceed below a declared minimum of two", () => {
    const result = selectHelpers(
      ["typescript"],
      [application("solo"), application("declined", { eligible: false })],
      { minimumHelpers: 2, preferredHelpers: 2, maximumHelpers: 2 },
    );

    expect(result.selectedAgentIds).toEqual(["solo"]);
    expect(result.minimumSatisfied).toBe(false);
    expect(result.oneHelperFallbackUsed).toBe(true);
    expect(result.canProceed).toBe(true);
  });
});
