import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ArtifactMetadataSchema,
  MissionSchema,
  PactSchema,
  ReceiptSchema,
  ReplacementProofSchema,
} from "../../packages/contracts/src/index.js";

const examplesDirectory = resolve("protocol/commitment-v1/examples");

async function example(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(examplesDirectory, name), "utf8"),
  ) as unknown;
}

describe("commitment/v1 runtime contracts", () => {
  let missionFixture: unknown;
  let pactFixture: unknown;
  let replacementFixture: unknown;
  let receiptFixture: unknown;

  beforeAll(async () => {
    [missionFixture, pactFixture, replacementFixture, receiptFixture] =
      await Promise.all([
        example("mission.valid.json"),
        example("pact.valid.json"),
        example("replacement.valid.json"),
        example("receipt.valid.json"),
      ]);
  });

  it("accepts the normative mission, pact, replacement, and receipt", () => {
    expect(MissionSchema.safeParse(missionFixture).success).toBe(true);
    expect(PactSchema.safeParse(pactFixture).success).toBe(true);
    expect(ReplacementProofSchema.safeParse(replacementFixture).success).toBe(
      true,
    );
    expect(ReceiptSchema.safeParse(receiptFixture).success).toBe(true);
  });

  it("rejects party preferences outside the declared mission bounds", () => {
    const mission = MissionSchema.parse(missionFixture);
    expect(
      MissionSchema.safeParse({
        ...mission,
        minimumPartySize: 2,
        preferredPartySize: 1,
      }).success,
    ).toBe(false);
  });

  it("binds GitHub execution, pull-request delivery, and public verification", () => {
    const mission = MissionSchema.parse(missionFixture);
    const githubMission = MissionSchema.parse({
      ...mission,
      executionTarget: {
        kind: "github",
        repository: "kimetsu-ai/guildhall",
        baseRef: "main",
        writeMode: "fork-pr",
        checkPolicy: "all-success",
      },
      requiredOutputs: [
        {
          ...mission.requiredOutputs[0],
          type: "code-change",
          delivery: { kind: "github-pull-request" },
        },
      ],
      verificationCriteria: mission.verificationCriteria.map((criterion) => ({
        ...criterion,
        method: "public-github",
      })),
    });

    expect(githubMission.executionTarget?.kind).toBe("github");
    expect(
      MissionSchema.safeParse({
        ...githubMission,
        executionTarget: { kind: "guildhall" },
      }).success,
    ).toBe(false);
  });

  it("rejects non-canonical GitHub pull-request evidence", () => {
    expect(
      ArtifactMetadataSchema.safeParse({
        protocol: "commitment/v1",
        kind: "artifact-metadata",
        artifactId: "10000000-0000-4000-8000-000000000001",
        missionId: "10000000-0000-4000-8000-000000000002",
        pactDigest: "D".repeat(43),
        roleSlotId: "10000000-0000-4000-8000-000000000003",
        producingAgentId: "10000000-0000-4000-8000-000000000004",
        keyId: "10000000-0000-4000-8000-000000000005",
        attempt: 1,
        artifactType: "code-change",
        mediaType: "application/json",
        publicLocation: "https://guildhall.example/artifact/1",
        deliveryEvidence: {
          kind: "github-pull-request",
          repository: "kimetsu-ai/guildhall",
          pullRequestUrl: "https://example.com/kimetsu-ai/guildhall/pull/1",
          baseRef: "main",
          headSha: "a".repeat(40),
          checks: [],
        },
        contentDigest: "E".repeat(43),
        signature: "F".repeat(86),
        safetyStatus: "approved",
        completedAt: "2026-08-31T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects role occupants who are not selected helpers", () => {
    const pact = PactSchema.parse(pactFixture);
    const firstSlot = pact.roleSlots[0];
    if (firstSlot === undefined) throw new Error("Missing role-slot fixture");

    expect(
      PactSchema.safeParse({
        ...pact,
        roleSlots: [
          {
            ...firstSlot,
            originalAgentId: "99999999-9999-4999-8999-999999999999",
          },
          ...pact.roleSlots.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects replacement by the same role-slot occupant", () => {
    const replacement = ReplacementProofSchema.parse(replacementFixture);
    expect(
      ReplacementProofSchema.safeParse({
        ...replacement,
        replacementAgentId: replacement.predecessorAgentId,
      }).success,
    ).toBe(false);
  });

  it("rejects success points on a non-completed receipt", () => {
    const receipt = ReceiptSchema.parse(receiptFixture);
    expect(
      ReceiptSchema.safeParse({ ...receipt, outcome: "failed" }).success,
    ).toBe(false);
  });

  it("rejects duplicate receipt deltas for one agent capability", () => {
    const receipt = ReceiptSchema.parse(receiptFixture);
    const firstDelta = receipt.reputationDeltas[0];
    if (firstDelta === undefined) throw new Error("Missing reputation fixture");

    expect(
      ReceiptSchema.safeParse({
        ...receipt,
        reputationDeltas: [...receipt.reputationDeltas, firstDelta],
      }).success,
    ).toBe(false);
  });

  it("permits a zero-reward pre-bind cancellation receipt without a pact", () => {
    const receipt = ReceiptSchema.parse(receiptFixture);
    expect(
      ReceiptSchema.safeParse({
        ...receipt,
        outcome: "canceled",
        pactDigest: null,
        artifacts: [],
        verification: null,
        defaults: [],
        replacements: [],
        reward: {
          ...receipt.reward,
          basePointsAwarded: 0,
          recoveryBonusAwarded: 0,
          totalPointsAwarded: 0,
        },
        reputationDeltas: [],
      }).success,
    ).toBe(true);
  });
});
