# A2A SDK on Cloudflare Workers: compatibility spike

Date: 2026-08-26  
SDK under test: `@a2a-js/sdk@1.0.1` (the npm `latest` and `next` tag at test time)

## Decision

Use the official A2A JavaScript SDK for:

- A2A 1.0 protocol types and constants from `@a2a-js/sdk`;
- outbound A2A client calls through `ClientFactory` from `@a2a-js/sdk/client`;
- later validation and conformance fixtures where its public API fits.

Keep Guildhall's hosted A2A server adapter Fetch-native. Do not import
`@a2a-js/sdk/server/express`, Express, or the gRPC entry points into a Worker.
This preserves the architecture in the locked spec even though the narrow SDK
surface bundles successfully.

## What the spike proves

`apps/demo-agent` is one source package with three independent Worker
entrypoints and deployment configurations:

| Deployment         | Entrypoint      | Wrangler config         |
| ------------------ | --------------- | ----------------------- |
| `guildhall-scout`  | `src/scout.ts`  | `wrangler.scout.jsonc`  |
| `guildhall-scribe` | `src/scribe.ts` | `wrangler.scribe.jsonc` |
| `guildhall-warden` | `src/warden.ts` | `wrangler.warden.jsonc` |

Each Worker imports official runtime constants, constructs a typed A2A 1.0
Agent Card, and constructs the official `ClientFactory` on `/spike/sdk`. The
`POST /a2a` route deliberately returns `501 A2A_NOT_IMPLEMENTED`: checklist
item 1 proves runtime compatibility, while checklist item 7 implements the
normative HTTP+JSON server behavior and Task store.

The package itself declares Node.js 20 or later, depends only on `jose` and
`uuid` for its core/client surfaces, and publishes isolated Express and gRPC
entry points. Its own `test-build:workers-safe` script bundles the root,
client, server-core, and compatibility entry points with a neutral platform.
Guildhall nevertheless imports only root types/constants and the client entry
in this spike.

## Verification

From the monorepo root:

```powershell
pnpm --filter @guildhall/demo-agent typecheck
pnpm --filter @guildhall/demo-agent build
```

The build runs three `wrangler deploy --dry-run` bundles, one per hosted agent.
At spike completion, TypeScript 5.9 completed with no errors and Wrangler
4.126.0 produced all three bundles successfully with `nodejs_compat` enabled
and the current compatibility date. Scout uploaded 231.20 KiB (36.86 KiB
gzip); Scribe and Warden each uploaded 231.21 KiB (36.86 KiB gzip). No Express
or gRPC module appears in the demo-agent source imports.

## Guardrails for checklist item 7

- Keep protocol validation and mission decisions outside transport handlers.
- Require `A2A-Version: 1.0` and the stable
  `https://guildhall.kimetsu-dev.workers.dev/protocol/commitment/v1` extension on applicable
  calls.
- Treat A2A Task completion as remote-interaction state, never as Guildhall
  mission verification.
- Re-run all three dry-run bundles whenever the SDK version or import surface
  changes.
- If a future SDK version pulls Node-only modules into root or client imports,
  confine it to tests and Node clients; the Workers-native server adapter
  remains valid.
