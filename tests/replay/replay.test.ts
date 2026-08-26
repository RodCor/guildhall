import { describe, expect, it } from "vitest";

import {
  clampReplayIndex,
  latestVisibleSequence,
  receiptUnlocked,
  replaySlice,
  storyBeat,
} from "../../apps/guildhall/src/client/mission/replay";

const events = [
  event(1, "mission_published", "webmcp"),
  event(2, "role_defaulted", "a2a"),
  event(3, "replacement_bound", "a2a"),
  event(4, "verification_passed", "system"),
  event(5, "receipt_issued", "system"),
];

describe("deterministic mission replay", () => {
  it("clamps every control position and reveals events in sequence", () => {
    expect(clampReplayIndex(-10, events.length)).toBe(0);
    expect(clampReplayIndex(2.8, events.length)).toBe(2);
    expect(clampReplayIndex(99, events.length)).toBe(events.length);
    expect(replaySlice(events, 3).map((entry) => entry.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(latestVisibleSequence(events, 3)).toBe(3);
  });

  it("never unlocks XP before the receipt event", () => {
    expect(receiptUnlocked(events, 4)).toBe(false);
    expect(receiptUnlocked(events, 5)).toBe(true);
  });

  it("translates failure and exact-slot recovery without hiding provenance", () => {
    expect(storyBeat(events[1]!)).toMatchObject({
      title: "Scribe Fell",
      tone: "danger",
      source: "a2a",
      eventType: "role_defaulted",
    });
    expect(storyBeat(events[2]!)).toMatchObject({
      title: "Warden Took the Oath",
      tone: "recovery",
      eventType: "replacement_bound",
    });
  });
});

function event(sequence: number, type: string, source: string) {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence,
    type,
    source,
    emittedAt: `2026-08-26T12:00:0${sequence}.000Z`,
  };
}
