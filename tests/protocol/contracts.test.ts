import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
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
});
