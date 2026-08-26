import { describe, expect, it } from "vitest";

import { sha256Base64Url } from "../../packages/contracts/src/signatures";
import type { UnhashedMissionEvent } from "../../packages/trust-engine/src";
import {
  appendMissionEvent,
  canonicalDigestSync,
  canonicalJsonDigestSync,
  createChainedMissionEvent,
  sha256Base64UrlSync,
  verifyMissionEventChain,
  verifyEventChain,
} from "../../packages/trust-engine/src";

describe("synchronous event hashing", () => {
  it("matches the standard SHA-256 vector and canonical JSON ordering", () => {
    expect(sha256Base64UrlSync("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
    expect(canonicalJsonDigestSync({ b: 2, a: 1 })).toBe(
      canonicalJsonDigestSync({ a: 1, b: 2 }),
    );
    expect(canonicalDigestSync({ b: 2, a: 1 })).toBe(
      canonicalJsonDigestSync({ a: 1, b: 2 }),
    );
  });

  it("matches Web Crypto across SHA-256 padding boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1_000]) {
      const message = "g".repeat(length);
      expect(sha256Base64UrlSync(message), `length ${length}`).toBe(
        await sha256Base64Url(message),
      );
    }
  });

  it("appends a contract-shaped event from an explicit persisted head hash", () => {
    const event = appendMissionEvent({
      ...eventInput(7, "artifact_submitted"),
      previousEventHash: "A".repeat(43),
    });

    expect(event).toMatchObject({
      sequence: 7,
      type: "artifact_submitted",
      previousEventHash: "A".repeat(43),
    });
    expect(event.contentDigest).toHaveLength(43);
    expect(event.eventHash).toHaveLength(43);
  });

  it("constructs and verifies a deterministic three-event chain", () => {
    const chain = completedMissionChain();

    expect(chain[0]?.previousEventHash).toBeNull();
    expect(chain[1]?.previousEventHash).toBe(chain[0]?.eventHash);
    expect(chain[2]?.previousEventHash).toBe(chain[1]?.eventHash);
    expect(verifyMissionEventChain(chain)).toEqual({
      valid: true,
      eventCount: 3,
      finalSequence: 3,
      headHash: chain[2]?.eventHash,
    });
    expect(verifyEventChain(chain)).toEqual(verifyMissionEventChain(chain));
  });

  it("rejects an invalid sequence while constructing the next event", () => {
    const first = createChainedMissionEvent(
      eventInput(1, "mission_published"),
      null,
    );

    expect(() =>
      createChainedMissionEvent(eventInput(3, "party_formed"), first),
    ).toThrow(/Expected event sequence 2, received 3/u);
  });
});

describe("event-chain tamper detection", () => {
  it("identifies the exact payload content-digest failure", () => {
    const chain = completedMissionChain();
    const tampered = chain.map((event) => ({ ...event }));
    tampered[1] = {
      ...tampered[1]!,
      payload: { helpers: ["agent-red", "agent-rogue"] },
    };

    expect(verifyMissionEventChain(tampered)).toMatchObject({
      valid: false,
      eventCount: 3,
      failure: {
        code: "CONTENT_DIGEST_MISMATCH",
        index: 1,
        sequence: 2,
        field: "contentDigest",
        actual: chain[1]?.contentDigest,
        message: "Event 2 payload does not match its content digest",
      },
    });
  });

  it("detects envelope metadata changes even when the payload is untouched", () => {
    const chain = completedMissionChain();
    const tampered = chain.map((event) => ({ ...event }));
    tampered[1] = { ...tampered[1]!, stage: "DELIVER" };

    expect(verifyMissionEventChain(tampered)).toMatchObject({
      valid: false,
      failure: {
        code: "EVENT_HASH_MISMATCH",
        index: 1,
        sequence: 2,
        field: "eventHash",
      },
    });
  });

  it("reports a broken link before trusting the remainder of the chain", () => {
    const chain = completedMissionChain();
    const tampered = chain.map((event) => ({ ...event }));
    tampered[2] = { ...tampered[2]!, previousEventHash: chain[0]!.eventHash };

    expect(verifyMissionEventChain(tampered)).toMatchObject({
      valid: false,
      failure: {
        code: "PREVIOUS_HASH_MISMATCH",
        index: 2,
        sequence: 3,
        field: "previousEventHash",
        expected: chain[1]?.eventHash,
        actual: chain[0]?.eventHash,
      },
    });
  });

  it("reports missing, duplicate, and reordered sequence positions", () => {
    const chain = completedMissionChain();

    expect(verifyMissionEventChain([chain[0]!, chain[2]!])).toMatchObject({
      valid: false,
      failure: { code: "SEQUENCE_MISMATCH", index: 1, expected: 2, actual: 3 },
    });
    expect(verifyMissionEventChain([chain[0]!, chain[0]!])).toMatchObject({
      valid: false,
      failure: { code: "SEQUENCE_MISMATCH", index: 1, expected: 2, actual: 1 },
    });
    expect(verifyMissionEventChain([chain[1]!, chain[0]!])).toMatchObject({
      valid: false,
      failure: { code: "SEQUENCE_MISMATCH", index: 0, expected: 1, actual: 2 },
    });
  });

  it("returns a structured canonicalization failure instead of throwing", () => {
    const chain = completedMissionChain();
    const tampered = chain.map((event) => ({ ...event }));
    tampered[0] = { ...tampered[0]!, payload: { secret: undefined } };

    expect(verifyMissionEventChain(tampered)).toMatchObject({
      valid: false,
      failure: {
        code: "CANONICALIZATION_FAILED",
        index: 0,
        sequence: 1,
        field: "event",
        expected: "valid I-JSON event envelope",
      },
    });
  });

  it("treats the empty chain as a valid genesis state", () => {
    expect(verifyMissionEventChain([])).toEqual({
      valid: true,
      eventCount: 0,
      finalSequence: 0,
      headHash: null,
    });
  });
});

function completedMissionChain() {
  const first = createChainedMissionEvent(
    eventInput(1, "mission_published"),
    null,
  );
  const second = createChainedMissionEvent(
    eventInput(2, "party_formed", {
      helpers: ["agent-red", "agent-blue"],
    }),
    first,
  );
  const third = createChainedMissionEvent(
    eventInput(3, "mission_completed", { reward: 120 }),
    second,
  );
  return [first, second, third];
}

function eventInput(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): UnhashedMissionEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    missionId: "10000000-0000-4000-8000-000000000001",
    sequence,
    type,
    stage: sequence === 3 ? "RECEIPT" : "PREPARE",
    displayState: sequence === 3 ? "Completed" : "Recruiting",
    emittedAt: `2026-08-26T12:00:0${sequence}.000Z`,
    source: "system",
    actor: null,
    payload,
  };
}
