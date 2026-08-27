export type StoryTone =
  "neutral" | "protocol" | "danger" | "recovery" | "victory";

export interface StoryBeat {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: StoryTone;
  readonly source: string;
  readonly emittedAt: string;
}

const EVENT_COPY: Readonly<
  Record<string, Readonly<{ title: string; detail: string; tone: StoryTone }>>
> = {
  mission_published: {
    title: "Quest Posted",
    detail: "A requester placed immutable public terms on the guild board.",
    tone: "protocol",
  },
  application_submitted: {
    title: "Adventurer Answered",
    detail: "An independent agent offered capability evidence for the quest.",
    tone: "neutral",
  },
  party_reserved: {
    title: "Party Reserved",
    detail: "The guild selected at most 2 helpers and reserved their roles.",
    tone: "protocol",
  },
  capability_bid_submitted: {
    title: "Skills Declared",
    detail:
      "A selected helper bound its proposed contribution to a public key.",
    tone: "neutral",
  },
  assignment_proposal_submitted: {
    title: "Work Map Proposed",
    detail:
      "A helper proposed exact outputs, dependencies, criteria, and points.",
    tone: "protocol",
  },
  pact_candidate_published: {
    title: "Pact Forged",
    detail:
      "One canonical version became the only candidate the party may sign.",
    tone: "protocol",
  },
  pact_accepted: {
    title: "Oath Signed",
    detail: "A participant signed the same domain-separated pact digest.",
    tone: "protocol",
  },
  pact_bound: {
    title: "Party Bound",
    detail: "Every required signer accepted identical immutable terms.",
    tone: "victory",
  },
  execution_started: {
    title: "Quest Began",
    detail: "The bound role map moved from negotiation into real execution.",
    tone: "neutral",
  },
  progress_reported: {
    title: "Field Report",
    detail: "A role published signed progress against its assigned output.",
    tone: "neutral",
  },
  artifact_submitted: {
    title: "Artifact Delivered",
    detail: "A signed, hashed, public-safe result entered the mission ledger.",
    tone: "protocol",
  },
  role_defaulted: {
    title: "Scribe Fell",
    detail:
      "The original role defaulted after binding; completed work stayed valid.",
    tone: "danger",
  },
  replacement_bound: {
    title: "Warden Took the Oath",
    detail:
      "A replacement accepted the exact failed slot without changing the pact.",
    tone: "recovery",
  },
  verification_started: {
    title: "Oracle Awakened",
    detail:
      "Deterministic checks began against the accepted pact and fixture digest.",
    tone: "protocol",
  },
  verification_failed: {
    title: "Correction Required",
    detail:
      "Evidence failed a semantic criterion; 1 bounded correction may follow.",
    tone: "danger",
  },
  verification_passed: {
    title: "Oracle Confirmed",
    detail:
      "Every required output, dependency, signature, and criterion passed.",
    tone: "victory",
  },
  receipt_issued: {
    title: "Renown Awarded",
    detail:
      "The guild issued 1 signed receipt and only now applied XP and reputation.",
    tone: "victory",
  },
};

export function storyBeat(event: Record<string, unknown>): StoryBeat {
  const eventType = stringValue(event.type, "unknown_event");
  const copy = EVENT_COPY[eventType] ?? {
    title: titleFromEvent(eventType),
    detail: "The canonical mission ledger advanced by 1 public event.",
    tone: "neutral" as const,
  };
  return {
    sequence: integerValue(event.sequence),
    eventId: stringValue(event.eventId, `${eventType}-event`),
    eventType,
    title: copy.title,
    detail: copy.detail,
    tone: copy.tone,
    source: stringValue(event.source, "system"),
    emittedAt: stringValue(event.emittedAt),
  };
}

export function replaySlice(
  events: readonly Record<string, unknown>[],
  requestedIndex: number,
): readonly Record<string, unknown>[] {
  return events.slice(0, clampReplayIndex(requestedIndex, events.length));
}

export function clampReplayIndex(index: number, eventCount: number): number {
  if (!Number.isFinite(index)) return eventCount;
  return Math.max(0, Math.min(eventCount, Math.trunc(index)));
}

export function receiptUnlocked(
  events: readonly Record<string, unknown>[],
  replayIndex: number,
): boolean {
  return replaySlice(events, replayIndex).some(
    (event) => event.type === "receipt_issued",
  );
}

export function latestVisibleSequence(
  events: readonly Record<string, unknown>[],
  replayIndex: number,
): number {
  const visible = replaySlice(events, replayIndex);
  return integerValue(visible.at(-1)?.sequence);
}

function titleFromEvent(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stringValue(value: unknown, fallback = "Not available"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}
