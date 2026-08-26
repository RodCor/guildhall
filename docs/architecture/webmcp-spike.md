# WebMCP Compatibility Spike

Date checked: 2026-08-26

## Decision

Guildhall targets the current imperative WebMCP draft surface:

```ts
await document.modelContext.registerTool(tool, { signal });
```

The adapter is isolated in `packages/capability-manifest/src/webmcp.ts`. It performs both secure-context and API feature detection; unsupported browsers receive an explicit result and retain the complete manual Guildhall UI. No legacy `navigator.modelContext`, `provideContext`, or `addTool` names are used.

The draft API currently accepts `name`, `title`, `description`, `inputSchema`, `execute(input, { signal })`, and the `readOnlyHint` / `untrustedContentHint` annotations. Registration is promise-based. Aborting the registration signal unregisters the tool, so one shared `AbortController` handles logout, agent switch, and page teardown.

Source checked: <https://webmachinelearning.github.io/webmcp/>

## Cancellation and reconciliation

An execution abort only cancels the browser caller's wait; it does not prove that a server mutation rolled back. The adapter therefore gives every mutating invocation a stable `commandId`, forwards the execution `AbortSignal` to the canonical handler, and asynchronously reconciles the command after an abort. The server-side command API remains idempotent by that ID.

Read-only calls do not reconcile. Reconciliation errors are reported only through the adapter callback and must not include public payloads or credentials.

## Manifest boundary

`guildCapabilityManifest` is the transport-neutral vocabulary. The bootstrap manifest records stable action names, static metadata, JSON Schema-shaped inputs and outputs, read-only/untrusted classifications, authentication and autonomy requirements, and canonical handler IDs.

The schema objects in checklist item 1 are deliberately dependency-free placeholders. Checklist item 2/6 will generate the normative JSON Schemas from shared Zod contracts and add parity snapshots for WebMCP, MCP, and the A2A Guild Broker without changing domain semantics.

## Spike outcome

- Compile target: strict TypeScript with DOM libraries.
- Browser runtime dependency: none.
- Unsupported behavior: explicit `insecure-context` or `api-unavailable` result.
- Tool removal: abort-driven, with one signal shared by the registered set.
- Execution cancellation: passed through to the handler; mutating commands reconcile by `commandId`.
- Security posture: bounded schemas, a 16 KiB serialized input ceiling, static descriptions, and untrusted output annotations on public data.

The implementation is suitable for the React/Worker shell. A real compatible-browser discovery and invocation remains an explicit live verification in checklist item 8.
