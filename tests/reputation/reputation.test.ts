import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ReceiptSchema,
  type Receipt,
} from "../../packages/contracts/src/index.js";
import {
  deriveReceiptReputation,
  OVERDUE_TIMELINESS_DELTA,
} from "../../packages/trust-engine/src/index.js";

describe("receipt-only reputation projection", () => {
  let receipt: Receipt;

  beforeAll(async () => {
    receipt = ReceiptSchema.parse(
      JSON.parse(
        await readFile(
          resolve("protocol/commitment-v1/examples/receipt.valid.json"),
          "utf8",
        ),
      ) as unknown,
    );
  });

  it("derives capability XP, reliability, timeliness, default, and recovery", () => {
    const projection = deriveReceiptReputation(receipt);

    expect(projection.totals).toEqual({
      pointsDelta: 625,
      recoveryBonus: 25,
    });
    expect(projection.capabilityUpdates).toEqual([
      expect.objectContaining({
        agentId: "33333333-3333-4333-8333-333333333333",
        capability: "accessibility-audit",
        pointsDelta: 300,
        reliabilityDelta: 0.02,
        timelinessDelta: 0.01,
        recoveryBonus: 0,
        verifiedMissionsDelta: 1,
        provisionalCleared: true,
        reason: "verified-role-output",
      }),
      expect.objectContaining({
        agentId: "44444444-4444-4444-8444-444444444444",
        pointsDelta: 0,
        reliabilityDelta: -0.1,
        timelinessDelta: 0,
        verifiedMissionsDelta: 0,
        provisionalCleared: false,
        reason: "post-bind-default",
      }),
      expect.objectContaining({
        agentId: "55555555-5555-4555-8555-555555555555",
        capability: "remediation-planning",
        pointsDelta: 325,
        reliabilityDelta: 0.03,
        recoveryBonus: 25,
        verifiedMissionsDelta: 1,
        reason: "verified-replacement-output",
      }),
    ]);
    expect(projection.agentUpdates).toEqual([
      {
        agentId: "33333333-3333-4333-8333-333333333333",
        pointsDelta: 300,
        completedMissionsDelta: 1,
        recoveredMission: false,
      },
      {
        agentId: "44444444-4444-4444-8444-444444444444",
        pointsDelta: 0,
        completedMissionsDelta: 0,
        recoveredMission: false,
      },
      {
        agentId: "55555555-5555-4555-8555-555555555555",
        pointsDelta: 325,
        completedMissionsDelta: 1,
        recoveredMission: true,
      },
    ]);
  });

  it("accepts overdue completion but applies reduced timeliness", () => {
    const overdue = cloneReceipt(receipt);
    overdue.timeliness = {
      ...overdue.timeliness,
      overdue: true,
      completedAt: "2026-08-26T13:00:01.000Z",
    };
    overdue.reputationDeltas = overdue.reputationDeltas.map((delta) =>
      delta.reason === "post-bind-default"
        ? delta
        : { ...delta, timelinessDelta: OVERDUE_TIMELINESS_DELTA },
    );

    const projection = deriveReceiptReputation(overdue);

    expect(
      projection.capabilityUpdates
        .filter((delta) => delta.reason !== "post-bind-default")
        .every((delta) => delta.timelinessDelta === OVERDUE_TIMELINESS_DELTA),
    ).toBe(true);
  });

  it("keeps capability ranks isolated and agent mission counts unique", () => {
    const isolated = cloneReceipt(receipt);
    const producingAgentId = isolated.artifacts[0]?.producingAgentId;
    if (producingAgentId === undefined)
      throw new Error("Missing producer fixture");
    isolated.defaults = [];
    isolated.replacements = [];
    isolated.artifacts = isolated.artifacts.map((artifact) => ({
      ...artifact,
      producingAgentId,
    }));
    isolated.reward = {
      ...isolated.reward,
      basePointsAwarded: 600,
      recoveryBonusAwarded: 0,
      totalPointsAwarded: 600,
    };
    isolated.reputationDeltas = [
      {
        agentId: producingAgentId,
        capability: "accessibility-audit",
        pointsDelta: 300,
        reliabilityDelta: 0.02,
        timelinessDelta: 0.01,
        recoveryBonus: 0,
        reason: "verified-role-output",
      },
      {
        agentId: producingAgentId,
        capability: "remediation-planning",
        pointsDelta: 300,
        reliabilityDelta: 0.02,
        timelinessDelta: 0.01,
        recoveryBonus: 0,
        reason: "verified-role-output",
      },
    ];

    const projection = deriveReceiptReputation(isolated);

    expect(
      projection.capabilityUpdates.map((update) => update.applicationKey),
    ).toHaveLength(2);
    expect(
      new Set(projection.capabilityUpdates.map((update) => update.capability)),
    ).toEqual(new Set(["accessibility-audit", "remediation-planning"]));
    expect(
      projection.capabilityUpdates.every(
        (update) => update.verifiedMissionsDelta === 1,
      ),
    ).toBe(true);
    expect(projection.agentUpdates).toEqual([
      {
        agentId: producingAgentId,
        pointsDelta: 600,
        completedMissionsDelta: 1,
        recoveredMission: false,
      },
    ]);
  });

  it("projects a failed terminal receipt with zero success XP", () => {
    const failed = failedReceipt(receipt);

    const projection = deriveReceiptReputation(failed);

    expect(projection.outcome).toBe("failed");
    expect(projection.totals).toEqual({ pointsDelta: 0, recoveryBonus: 0 });
    expect(
      projection.capabilityUpdates.every(
        (update) =>
          update.pointsDelta === 0 &&
          update.recoveryBonus === 0 &&
          update.verifiedMissionsDelta === 0 &&
          !update.provisionalCleared,
      ),
    ).toBe(true);
    expect(
      projection.agentUpdates.every(
        (update) => update.completedMissionsDelta === 0,
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "positive XP",
      mutate(failed: Receipt) {
        const delta = requireDelta(failed, 0);
        failed.reputationDeltas[0] = { ...delta, pointsDelta: 1 };
      },
    },
    {
      name: "recovery bonus",
      mutate(failed: Receipt) {
        const delta = requireDelta(failed, 2);
        failed.reputationDeltas[2] = { ...delta, recoveryBonus: 1 };
      },
    },
    {
      name: "positive reliability",
      mutate(failed: Receipt) {
        const delta = requireDelta(failed, 0);
        failed.reputationDeltas[0] = { ...delta, reliabilityDelta: 0.01 };
      },
    },
  ])("rejects $name on a failed receipt", ({ mutate }) => {
    const failed = failedReceipt(receipt);
    mutate(failed);

    expect(() => deriveReceiptReputation(failed)).toThrow(/non-completed/u);
  });

  it("rejects completed status when any criterion failed", () => {
    const inconsistent = cloneReceipt(receipt);
    const verification = inconsistent.verification;
    if (verification === null) throw new Error("Missing verification fixture");
    const criterion = verification.criterionResults[0];
    if (criterion === undefined) throw new Error("Missing criterion fixture");
    verification.criterionResults[0] = { ...criterion, status: "failed" };

    expect(() => deriveReceiptReputation(inconsistent)).toThrow(
      /criteria must all pass/u,
    );
  });

  it("cannot derive manual or pre-receipt reputation", () => {
    expect(() => deriveReceiptReputation(null)).toThrow();
    expect(() =>
      deriveReceiptReputation({
        agentId: "33333333-3333-4333-8333-333333333333",
        pointsDelta: 100,
      }),
    ).toThrow();
  });
});

function failedReceipt(source: Receipt): Receipt {
  const failed = cloneReceipt(source);
  failed.outcome = "failed";
  if (failed.verification === null)
    throw new Error("Missing verification fixture");
  failed.verification.status = "failed";
  failed.verification.criterionResults =
    failed.verification.criterionResults.map((criterion) => ({
      ...criterion,
      status: "failed",
    }));
  failed.reward = {
    ...failed.reward,
    basePointsAwarded: 0,
    recoveryBonusAwarded: 0,
    totalPointsAwarded: 0,
  };
  failed.reputationDeltas = failed.reputationDeltas.map((delta) => {
    if (delta.reason === "post-bind-default") return delta;
    return {
      ...delta,
      pointsDelta: 0,
      reliabilityDelta: -0.02,
      timelinessDelta: -0.01,
      recoveryBonus: 0,
    };
  });
  return failed;
}

function cloneReceipt(source: Receipt): Receipt {
  return structuredClone(source);
}

function requireDelta(receipt: Receipt, index: number) {
  const delta = receipt.reputationDeltas[index];
  if (delta === undefined) throw new Error(`Missing reputation delta ${index}`);
  return delta;
}
