export interface StoredCommandResult<TResult> {
  readonly commandId: string;
  readonly requestHash: string;
  readonly result: TResult;
}

export type IdempotencyDecision<TResult> =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly result: TResult }
  | { readonly kind: "conflict"; readonly code: "IDEMPOTENCY_KEY_REUSED" };

export function decideIdempotency<TResult>(
  stored: StoredCommandResult<TResult> | undefined,
  commandId: string,
  requestHash: string,
): IdempotencyDecision<TResult> {
  if (stored === undefined) return { kind: "new" };
  if (stored.commandId !== commandId) return { kind: "new" };
  if (stored.requestHash === requestHash)
    return { kind: "replay", result: stored.result };
  return { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" };
}
