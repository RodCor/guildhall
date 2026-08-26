import { describe, expect, it } from "vitest";

import { decideIdempotency } from "../../packages/mission-engine/src/index.js";

describe("command idempotency decisions", () => {
  it("accepts a new command ID", () => {
    expect(decideIdempotency(undefined, "command-1", "hash-1")).toEqual({
      kind: "new",
    });
  });

  it("replays the exact stored result for the same command and request hash", () => {
    expect(
      decideIdempotency(
        {
          commandId: "command-1",
          requestHash: "hash-1",
          result: { sequence: 4 },
        },
        "command-1",
        "hash-1",
      ),
    ).toEqual({ kind: "replay", result: { sequence: 4 } });
  });

  it("rejects a reused command ID with a different request hash", () => {
    expect(
      decideIdempotency(
        {
          commandId: "command-1",
          requestHash: "hash-1",
          result: { sequence: 4 },
        },
        "command-1",
        "hash-2",
      ),
    ).toEqual({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
  });
});
