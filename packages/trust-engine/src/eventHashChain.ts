import { canonicalJson, type MissionEvent } from "@guildhall/contracts";

const textEncoder = new TextEncoder();

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export type UnhashedMissionEvent = Omit<
  MissionEvent,
  "contentDigest" | "eventHash" | "previousEventHash"
>;

export type MissionEventAppendInput = UnhashedMissionEvent & {
  readonly previousEventHash: string | null;
};

export interface EventChainHead {
  readonly eventHash: string;
  readonly sequence: number;
}

export type EventChainFailureCode =
  | "SEQUENCE_MISMATCH"
  | "PREVIOUS_HASH_MISMATCH"
  | "CONTENT_DIGEST_MISMATCH"
  | "EVENT_HASH_MISMATCH"
  | "CANONICALIZATION_FAILED";

export type EventChainVerificationResult =
  | {
      readonly valid: true;
      readonly eventCount: number;
      readonly finalSequence: number;
      readonly headHash: string | null;
    }
  | {
      readonly valid: false;
      readonly eventCount: number;
      readonly failure: EventChainVerificationFailure;
    };

export interface EventChainVerificationFailure {
  readonly code: EventChainFailureCode;
  readonly index: number;
  readonly eventId: string | null;
  readonly sequence: number | null;
  readonly field:
    "sequence" | "previousEventHash" | "contentDigest" | "eventHash" | "event";
  readonly expected: string | number | null;
  readonly actual: string | number | null;
  readonly message: string;
}

/** SHA-256 encoded as RFC 4648 base64url without padding. */
export function sha256Base64UrlSync(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  return encodeBase64Url(sha256(bytes));
}

/** RFC 8785 canonical JSON followed by synchronous SHA-256. */
export function canonicalJsonDigestSync(value: unknown): string {
  return sha256Base64UrlSync(canonicalJson(value));
}

/** Short Worker-facing name for the canonical digest operation. */
export const canonicalDigestSync = canonicalJsonDigestSync;

/**
 * Hash an already sequenced event for transactional persistence.
 * Sequence/link continuity is checked by `verifyEventChain`; callers that
 * have the prior head in memory can use `createChainedMissionEvent` instead.
 */
export function appendMissionEvent(
  input: MissionEventAppendInput,
): MissionEvent {
  const contentDigest = canonicalJsonDigestSync(input.payload);
  const eventWithoutHash = { ...input, contentDigest };

  return {
    ...eventWithoutHash,
    eventHash: canonicalJsonDigestSync(
      eventEnvelopeProjection(eventWithoutHash),
    ),
  };
}

/**
 * Create the next event in a complete mission chain.
 *
 * The content digest commits to the payload. The event hash commits to the
 * immutable envelope (including that digest and the previous event hash) but
 * deliberately excludes the separately stored visible payload. This permits
 * an audited safety marker to replace public content without rewriting links.
 */
export function createChainedMissionEvent(
  input: UnhashedMissionEvent,
  previous: EventChainHead | null,
): MissionEvent {
  const expectedSequence = previous === null ? 1 : previous.sequence + 1;
  if (input.sequence !== expectedSequence) {
    throw new RangeError(
      `Expected event sequence ${expectedSequence}, received ${input.sequence}`,
    );
  }

  return appendMissionEvent({
    ...input,
    previousEventHash: previous?.eventHash ?? null,
  });
}

/** Verify a complete chain from its sequence-1 genesis event to its head. */
export function verifyMissionEventChain(
  events: readonly MissionEvent[],
): EventChainVerificationResult {
  const declaredRedactions = new Set(
    events.flatMap((event) => {
      const command = event.payload.command;
      return event.type === "safety_redacted" &&
        isRecord(command) &&
        command.type === "safety_redact" &&
        typeof command.redactedEventId === "string"
        ? [command.redactedEventId]
        : [];
    }),
  );
  let expectedPreviousHash: string | null = null;
  let expectedSequence = 1;

  for (const [index, event] of events.entries()) {
    const eventId = typeof event.eventId === "string" ? event.eventId : null;
    const sequence =
      typeof event.sequence === "number" && Number.isFinite(event.sequence)
        ? event.sequence
        : null;

    if (event.sequence !== expectedSequence) {
      return invalidChain(events.length, {
        code: "SEQUENCE_MISMATCH",
        index,
        eventId,
        sequence,
        field: "sequence",
        expected: expectedSequence,
        actual: sequence,
        message: `Event ${index} has sequence ${String(sequence)}; expected ${expectedSequence}`,
      });
    }

    if (event.previousEventHash !== expectedPreviousHash) {
      return invalidChain(events.length, {
        code: "PREVIOUS_HASH_MISMATCH",
        index,
        eventId,
        sequence,
        field: "previousEventHash",
        expected: expectedPreviousHash,
        actual: scalarOrNull(event.previousEventHash),
        message: `Event ${event.sequence} does not link to the verified previous event`,
      });
    }

    let expectedContentDigest: string;
    let expectedEventHash: string;
    try {
      expectedContentDigest = isAuthorizedRedaction(event, declaredRedactions)
        ? event.contentDigest
        : canonicalJsonDigestSync(event.payload);
      expectedEventHash = canonicalJsonDigestSync(
        eventEnvelopeProjection(event),
      );
    } catch (error) {
      return invalidChain(events.length, {
        code: "CANONICALIZATION_FAILED",
        index,
        eventId,
        sequence,
        field: "event",
        expected: "valid I-JSON event envelope",
        actual: error instanceof Error ? error.message : "unknown error",
        message: `Event ${event.sequence} cannot be canonically hashed`,
      });
    }

    if (event.contentDigest !== expectedContentDigest) {
      return invalidChain(events.length, {
        code: "CONTENT_DIGEST_MISMATCH",
        index,
        eventId,
        sequence,
        field: "contentDigest",
        expected: expectedContentDigest,
        actual: scalarOrNull(event.contentDigest),
        message: `Event ${event.sequence} payload does not match its content digest`,
      });
    }

    if (event.eventHash !== expectedEventHash) {
      return invalidChain(events.length, {
        code: "EVENT_HASH_MISMATCH",
        index,
        eventId,
        sequence,
        field: "eventHash",
        expected: expectedEventHash,
        actual: scalarOrNull(event.eventHash),
        message: `Event ${event.sequence} envelope does not match its event hash`,
      });
    }

    expectedPreviousHash = event.eventHash;
    expectedSequence += 1;
  }

  return {
    valid: true,
    eventCount: events.length,
    finalSequence: expectedSequence - 1,
    headHash: expectedPreviousHash,
  };
}

/** Worker-facing alias retained as the canonical public verifier name. */
export const verifyEventChain = verifyMissionEventChain;

function eventEnvelopeProjection(
  event: Omit<MissionEvent, "eventHash"> | MissionEvent,
): Omit<MissionEvent, "eventHash" | "payload"> {
  const {
    eventHash: _eventHash,
    payload: _payload,
    ...projection
  } = event as MissionEvent;
  return projection;
}

function isAuthorizedRedaction(
  event: MissionEvent,
  declaredRedactions: ReadonlySet<string>,
): boolean {
  return (
    declaredRedactions.has(event.eventId) &&
    event.payload.kind === "redacted-public-payload" &&
    typeof event.payload.rulesetVersion === "string" &&
    Object.keys(event.payload).length === 2
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidChain(
  eventCount: number,
  failure: EventChainVerificationFailure,
): EventChainVerificationResult {
  return { valid: false, eventCount, failure };
}

function scalarOrNull(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function sha256(message: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((message.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.byteLength] = 0x80;

  const bitLengthHigh = Math.floor(message.byteLength / 0x20000000);
  const bitLengthLow = (message.byteLength << 3) >>> 0;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, bitLengthHigh, false);
  paddedView.setUint32(paddedLength - 4, bitLengthLow, false);

  const state: number[] = [...SHA256_INITIAL_STATE];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15] ?? 0;
      const second = words[index - 2] ?? 0;
      const sigma0 =
        rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 =
        rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] =
        ((words[index - 16] ?? 0) +
          sigma0 +
          (words[index - 7] ?? 0) +
          sigma1) >>>
        0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          sum1 +
          choose +
          (SHA256_ROUND_CONSTANTS[index] ?? 0) +
          (words[index] ?? 0)) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (const [index, word] of state.entries()) {
    digestView.setUint32(index * 4, word, false);
  }
  return digest;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;

    encoded += alphabet[(block >>> 18) & 0x3f];
    encoded += alphabet[(block >>> 12) & 0x3f];
    if (hasSecond) encoded += alphabet[(block >>> 6) & 0x3f];
    if (hasThird) encoded += alphabet[block & 0x3f];
  }

  return encoded;
}
