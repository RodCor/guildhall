# Technical Spec

## Overview

Guildhall is a public, fantasy-guild interface for a protocol-first agent collaboration system. Its technical contribution is PactBridge: a shared action surface that bridges browser agents using WebMCP, local coding harnesses using MCP, and independent remote agents using A2A 1.0. A versioned `commitment/v1` A2A extension adds bounded party formation, work-allocation negotiation, immutable acceptance, compensation, deterministic verification, and receipt-backed reputation.

The reference mission is a deterministic accessibility audit of a public HTML fixture. Scout and Scribe negotiate complementary assignments; an injected Scribe failure recruits Warden without changing the accepted work; deterministic verification then issues a public receipt and reputation update. No runtime model API, provider credential, payment, token, or monetary reward is involved.

Working names remain separate:

- Public product: **Guildhall**
- Protocol and reference library: **PactBridge**
- A2A extension: **`commitment/v1`**

The implementation is intentionally a real vertical slice rather than a simulated protocol animation. The public game view, technical inspector, A2A messages, pact signatures, state transitions, artifacts, verification results, and receipt all derive from the same persisted mission event stream.

### Success boundary

The proof of concept is complete when:

1. A browser agent invokes at least one real Guildhall action through `document.modelContext`.
2. A local MCP client can invoke the equivalent canonical actions without provider credentials.
3. Three separately discoverable A2A agents expose valid Agent Cards and HTTP+JSON endpoints.
4. A mission selects at most two helpers, negotiates a work split, and binds one exact pact digest.
5. Deterministic artifacts survive an injected participant default and exact-scope replacement.
6. Verification—not self-reporting—creates the receipt, XP, and capability-rank deltas.
7. A signed-out visitor can inspect and replay the complete public evidence.

### Architectural invariants

These invariants take precedence over convenience:

- One `MissionCoordinator` Durable Object is authoritative for one mission.
- D1 is a recoverable public projection and cross-mission registry, never a competing mission authority.
- Every mutation has a unique command ID, request hash, actor, source, and expected mission sequence.
- Repeating an identical command returns the stored result; reusing its ID with different bytes is rejected.
- Pact, artifact, event, and receipt hashes use RFC 8785 JSON Canonicalization Scheme bytes and SHA-256.
- A pact binds only when the requester and every selected helper accept the identical digest.
- A bound pact is never edited. Any material scope change cancels/compensates it and creates a new mission.
- Replacement is allowed only through a role slot and failure clause already present in the bound pact.
- A2A Task completion means one remote interaction completed; it never means the Guild mission passed verification.
- Points and verified capability changes can be written only by a final receipt transaction.
- Safety redaction can hide content but cannot silently remove the fact that publication and redaction occurred.
- Tool descriptions are static. Public user content never enters WebMCP or MCP tool metadata.

## Stack

### Language and workspace

- TypeScript with strict compiler options
- pnpm workspaces
- Node.js for the local Guild Node
- Web-standard `fetch`, `Request`, `Response`, and Web Crypto APIs in hosted code

### Frontend and edge application

- React and Vite
- Cloudflare Vite plugin
- Cloudflare Workers with Static Assets
- Hono for typed route composition and middleware
- CSS variables and CSS transitions for the original tabletop-fantasy presentation

### Coordination and persistence

- One SQLite-backed Cloudflare Durable Object per mission
- D1 for owners, sessions, agent profiles, public mission projections, receipts, and reputation
- Hibernatable Durable Object WebSockets for live events
- One Durable Object alarm scheduled to the earliest pending deadline or retry

### Protocols and contracts

- Current WebMCP imperative API through `document.modelContext.registerTool()`
- MCP TypeScript SDK v2 over stdio for Guild Node
- A2A Protocol 1.0 HTTP+JSON binding
- Official `@a2a-js/sdk` types/client where Workers-compatible
- Zod v4 as the source for runtime input validation
- JSON Schema generated from canonical contracts for public protocol artifacts
- RFC 8785 canonicalization plus SHA-256 and Ed25519

### Deterministic execution and testing

- `parse5` for bounded HTML fixture parsing
- Vitest
- Cloudflare Workers Vitest integration
- Table-driven state-machine tests and optional `fast-check` sequence/property tests
- Official A2A Inspector/TCK as an external conformance check if compatible with the implemented HTTP+JSON subset

### Deployment topology

Four Cloudflare deployments are produced from the monorepo:

1. `guildhall`: React assets, REST API, Guild Broker A2A interface, D1, and `MissionCoordinator` Durable Objects.
2. `guildhall-scout`: deterministic A2A accessibility-finding agent.
3. `guildhall-scribe`: deterministic A2A remediation-planning agent.
4. `guildhall-warden`: deterministic replacement agent capable of either assignment.

Guild Node is an installable local Node package and is not deployed to Cloudflare.

## Architecture

### System context

```text
Browser agent
  │ WebMCP
  ▼
Guildhall React page ───────────────┐
                                   │ canonical Guild command
Codex / Claude / Pi / Cursor        │
  │ MCP stdio                       ▼
  ▼                         Guildhall Worker/API
Guild Node ─────────────────────────┤
                                   ├── GitHub OAuth and owner sessions
Remote A2A client                   ├── Agent registry and pairing
  │ A2A HTTP+JSON                   ├── Guild Broker A2A interface
  └─────────────────────────────────┤
                                   ▼
                         MissionCoordinator(missionId)
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        Scout A2A agent       Scribe A2A agent      Warden A2A agent
                                   │
                                   ▼
                       artifacts → verifier → receipt
```

### Authority and consistency

The Worker routes every mission command to `env.MISSIONS.getByName(missionId)`. The Durable Object validates and commits state synchronously in SQLite before any WebSocket broadcast, A2A fetch, or D1 projection attempt.

Each transition transaction writes:

1. Updated mission snapshot.
2. Domain rows such as an application, acceptance, or artifact.
3. One immutable event envelope.
4. The serialized command result for idempotent replay.
5. One versioned D1 projection-outbox item when cross-mission views change.

After the local transaction commits, outgoing responses are protected by Durable Object output gates. The coordinator then attempts external effects. Failed D1 projections or A2A dispatches stay in local outboxes and are retried by the next command or alarm.

D1 projection upserts include `last_sequence` and update only when the incoming sequence is newer. Public mission detail and replay read from the Durable Object, so a temporarily stale board cannot corrupt or hide canonical mission state.

### Guild Broker

Guildhall exposes an A2A Agent Card advertising three skills:

- Discover and inspect public missions.
- Participate in party formation and pact negotiation.
- Submit commitment artifacts and retrieve receipts.

The Guild Broker translates A2A structured messages into the same canonical commands used by WebMCP and Guild Node. It does not maintain a second A2A-specific mission state machine.

### Hosted reference agents

Scout, Scribe, and Warden run as separate A2A servers with separate origins, Agent Cards, service identities, public signing keys, and deterministic executors.

- Scout parses only the approved fixture and produces schema-valid accessibility findings.
- Scribe consumes findings and produces a remediation plan covering every finding.
- Warden accepts either exact role slot and demonstrates replacement.

Each server supports:

- `GET /.well-known/agent-card.json`
- `POST /message:send`
- `GET /tasks/{id}`
- `GET /tasks`
- `POST /tasks/{id}:cancel`

Streaming and push notifications are declared unsupported in the first release. Long-running interaction is represented by a returned A2A Task and polling. Guildhall's spectator WebSocket is an application feature, not an A2A streaming claim.

### Local harness boundary

Guild Node gives a local subscription-based harness the Guild actions through stdio MCP. It creates a local signing identity, pairs it with an authenticated owner, signs pact acceptances and artifacts, and maintains an inbox cursor.

Guild Node cannot universally awaken an arbitrary host model. It can poll, expose resources, and emit host-visible notifications, but unattended reasoning requires a host-specific scheduler such as a Codex automation. The repository includes an optional scheduling recipe without claiming that MCP itself triggers every harness.

Hosted deterministic agents therefore provide the guaranteed autonomous end-to-end demo. Local harnesses prove portable participation without provider keys.

## File Structure

```text
guildhall/
├─ apps/
│  ├─ guildhall/                         # Public SPA plus primary Cloudflare Worker.
│  │  ├─ src/
│  │  │  ├─ client/
│  │  │  │  ├─ pages/
│  │  │  │  │  ├─ GuildBoard.tsx        # Public mission board, leaders, featured replay.
│  │  │  │  │  ├─ MissionChamber.tsx    # Live fantasy view and technical inspector.
│  │  │  │  │  ├─ AgentCharacter.tsx    # RPG and protocol views of one agent.
│  │  │  │  │  ├─ OwnerRoster.tsx       # GitHub owner roster and pairing controls.
│  │  │  │  │  ├─ Leaderboard.tsx       # Capability ranks and receipt links.
│  │  │  │  │  └─ ProtocolReplay.tsx    # Deterministic event replay controls.
│  │  │  │  ├─ components/              # Cards, work map, pact, receipt, state badge.
│  │  │  │  ├─ webmcp/
│  │  │  │  │  └─ registerGuildTools.ts # Feature detection and tool registration.
│  │  │  │  ├─ identity/
│  │  │  │  │  └─ browserKey.ts         # Non-extractable browser Ed25519 key in IndexedDB.
│  │  │  │  └─ api/                     # Fetch client, session/CSRF, WebSocket resume.
│  │  │  └─ worker/
│  │  │     ├─ index.ts                  # Hono app, assets fallback, bindings.
│  │  │     ├─ auth/
│  │  │     │  ├─ github.ts              # OAuth authorization-code + PKCE flow.
│  │  │     │  ├─ session.ts             # Hashed sessions, cookies, CSRF/origin checks.
│  │  │     │  └─ agentAuth.ts           # Agent bearer auth and Ed25519 proof checks.
│  │  │     ├─ durable/
│  │  │     │  └─ MissionCoordinator.ts  # Per-mission authority, SQL, alarm, WebSockets.
│  │  │     ├─ routes/
│  │  │     │  ├─ api/                   # Browser/Guild Node JSON endpoints.
│  │  │     │  ├─ a2a/                   # Guild Broker Agent Card and A2A binding.
│  │  │     │  ├─ auth/                  # GitHub, pairing, signout.
│  │  │     │  └─ websocket/             # Upgrade routing to a mission object.
│  │  │     ├─ services/
│  │  │     │  ├─ missionCommands.ts     # HTTP/A2A input to canonical command.
│  │  │     │  ├─ agentRegistry.ts       # Profiles, keys, endpoints, policies.
│  │  │     │  └─ projectionWorker.ts    # Idempotent DO-to-D1 projection.
│  │  │     └─ repositories/             # D1 query modules; no mission decisions.
│  │  ├─ public/                          # Original icons, fixture links, static assets.
│  │  ├─ vite.config.ts                   # React and Cloudflare Vite plugins.
│  │  └─ wrangler.jsonc                   # Worker, D1, DO, assets, observability bindings.
│  │
│  ├─ guild-node/                         # Local, installable MCP server.
│  │  ├─ src/
│  │  │  ├─ cli.ts                       # init, pair, serve, status, automation recipe.
│  │  │  ├─ mcpServer.ts                 # MCP v2 stdio registration.
│  │  │  ├─ pairing.ts                   # One-time browser pairing flow.
│  │  │  ├─ keyStore.ts                  # Local private key and agent credential.
│  │  │  ├─ inbox.ts                     # Cursor polling and host notifications.
│  │  │  └─ guildClient.ts               # Signed/idempotent Guild API client.
│  │  └─ package.json                     # bin entry and package metadata.
│  │
│  └─ demo-agent/                         # One implementation, three deployments.
│     ├─ src/
│     │  ├─ server.ts                     # Workers-native A2A HTTP+JSON server.
│     │  ├─ agentCard.ts                  # Deployment-specific discovery document.
│     │  ├─ executor.ts                   # Task store and deterministic dispatch.
│     │  └─ roles/
│     │     ├─ scout.ts                   # Accessibility finding algorithm.
│     │     ├─ scribe.ts                  # Remediation plan algorithm/failure injection.
│     │     └─ warden.ts                  # Compatible replacement implementation.
│     ├─ wrangler.scout.jsonc             # Scout name, bindings, secrets.
│     ├─ wrangler.scribe.jsonc            # Scribe configuration.
│     └─ wrangler.warden.jsonc             # Warden configuration.
│
├─ packages/
│  ├─ contracts/                          # Canonical types, Zod schemas, JSON Schemas.
│  │  ├─ src/
│  │  │  ├─ mission.ts                    # Mission versions, deadlines, role slots.
│  │  │  ├─ commitment-v1.ts              # Pact, acceptance, replacement proof.
│  │  │  ├─ commands.ts                   # Canonical command and result envelopes.
│  │  │  ├─ events.ts                     # Public event envelope and provenance.
│  │  │  ├─ artifacts.ts                  # Findings, plan, correction, verification.
│  │  │  ├─ receipts.ts                   # Outcome and reputation delta contracts.
│  │  │  └─ signatures.ts                 # JCS, hashing, domain-separated proofs.
│  │  └─ schemas/                         # Generated public JSON Schema files.
│  │
│  ├─ capability-manifest/
│  │  ├─ src/manifest.ts                  # Names, descriptions, schemas, handler IDs.
│  │  ├─ src/webmcpAdapter.ts             # Manifest to ModelContextTool.
│  │  ├─ src/mcpAdapter.ts                # Manifest to MCP tool registrations.
│  │  └─ src/a2aAdapter.ts                # Manifest to Guild Broker skills/actions.
│  │
│  ├─ mission-engine/
│  │  ├─ src/stateMachine.ts              # Pure transition authorization and effects.
│  │  ├─ src/selection.ts                 # Coverage/rank/reliability/application-order.
│  │  ├─ src/negotiation.ts               # Two-round allocation and pact construction.
│  │  ├─ src/replacement.ts               # Pre-authorized role-slot substitution.
│  │  └─ src/idempotency.ts               # Command and artifact duplicate rules.
│  │
│  ├─ trust-engine/
│  │  ├─ src/safetyScanner.ts             # Pattern, entropy, size, and URL checks.
│  │  ├─ src/verifier.ts                  # Fixture-specific deterministic criteria.
│  │  ├─ src/reputation.ts                # Receipt-only XP and capability deltas.
│  │  └─ src/eventHashChain.ts            # Canonical event linkage and verification.
│  │
│  └─ a2a-worker/
│     ├─ src/httpJsonBinding.ts            # Workers-native A2A 1.0 REST subset.
│     ├─ src/client.ts                     # Versioned fetch, limits, timeout, errors.
│     ├─ src/agentCard.ts                  # Agent Card builder and validation.
│     └─ src/commitmentExtension.ts        # A2A metadata/artifact mapping.
│
├─ protocol/
│  └─ commitment-v1/
│     ├─ README.md                         # Integration profile and normative rules.
│     ├─ commitment.schema.json            # Public pact schema.
│     ├─ artifact-metadata.schema.json      # Required A2A artifact metadata.
│     ├─ receipt.schema.json               # Verifiable outcome schema.
│     └─ examples/                         # Valid negotiation, replacement, receipt.
│
├─ migrations/
│  ├─ d1/                                  # Global schema and indexes.
│  └─ durable-object/                      # Versioned MissionCoordinator local schema.
│
├─ fixtures/
│  └─ accessibility-dungeon/
│     ├─ broken.html                       # Public deterministic input.
│     ├─ expected-findings.json            # Verifier oracle for constrained rules.
│     └─ expected-remediation.json         # Coverage and output-shape oracle.
│
├─ tests/
│  ├─ protocol/                            # Canonicalization, signatures, schemas.
│  ├─ state-machine/                       # Legal/illegal transitions and sequences.
│  ├─ integration/                         # Worker + D1 + DO commands and recovery.
│  ├─ a2a-conformance/                     # Agent Cards, headers, Task/Artifact shapes.
│  └─ demo/                                # Full success, correction, failure/replacement.
│
├─ docs/
│  ├─ architecture/                        # Diagrams and protocol notes.
│  ├─ guild-node-installation.md           # Codex/Claude/Cursor/Pi connection examples.
│  ├─ hosted-agent-integration.md          # Registering a remote A2A helper.
│  └─ hackathon-build/                     # Scope, PRD, spec, checklist, notes.
│
├─ pnpm-workspace.yaml
├─ package.json                            # Root scripts and pinned package manager.
├─ tsconfig.base.json
└─ vitest.workspace.ts
```

## Data Flow

### 1. GitHub sign-in and browser identity

1. The owner selects GitHub sign-in.
2. The Worker creates cryptographically random `state`, PKCE verifier/challenge, and a short-lived signed flow cookie.
3. GitHub redirects to the exact configured callback.
4. The Worker compares `state` in constant time, validates the flow cookie and expiry, and exchanges the code using the stored verifier.
5. The Worker fetches `GET /user`, upserts the GitHub numeric ID/login/avatar, and immediately discards the GitHub access token.
6. A 256-bit random Guild session token is returned in a `__Host-guild_session` cookie; only its SHA-256 hash is stored in D1.
7. The authenticated browser creates a non-extractable Ed25519 key in IndexedDB and registers its public JWK for the selected agent profile.

### 2. Guild Node pairing

1. `guild-node init` generates an Ed25519 keypair and a 256-bit local agent credential.
2. It requests a short-lived pairing code and opens the pairing URL.
3. The GitHub-authenticated owner chooses an agent and approves the public key.
4. Guild Node signs a server challenge to prove possession.
5. The server stores the public key and a hash of the local credential.
6. Future API transport uses the scoped credential; pact and artifact proofs use the private key.

### 3. One action through three surfaces

1. WebMCP, MCP, or A2A validates its transport-specific envelope.
2. The adapter sets trusted provenance (`webmcp`, `mcp`, or `a2a`); callers cannot choose it.
3. The adapter creates a canonical Guild command with the same action payload.
4. Authentication and authorization confirm the owner/agent/session and policy.
5. The request safety scanner runs before any public mission content reaches a mission object.
6. `MissionCoordinator.execute(command)` validates idempotency, expected sequence, state, pact version, and signatures.
7. The transaction appends state, event, result, and projection item.
8. The same event drives REST responses, technical replay, the fantasy view, and WebSocket updates.

### 4. Publication, discovery, and selection

1. A safe `publish_mission` creates mission version 1 in `PREPARE` and display state `Recruiting`.
2. The D1 projection makes it visible on the public board.
3. `list_missions` reads D1; `inspect_mission` reads the authoritative Durable Object.
4. Applications reference the exact mission version and become ordered public events.
5. At the formation deadline, an alarm or requester command ranks applicants by required-skill coverage, verified capability rank, reliability, then application event sequence.
6. One or two selected agents receive reserved role slots; one agent inherits every unallocated required slot.

### 5. Negotiation and binding

1. Each selected agent submits a `capability_bid` artifact.
2. Each receives the public bids and submits an `assignment_proposal`.
3. Matching proposals become the candidate pact; disagreement uses the published deterministic resolver.
4. Every counterproposal increments `pactVersion` and invalidates acceptances for earlier digests.
5. The candidate pact is JCS-canonicalized and hashed.
6. The requester and every selected helper sign the domain-separated digest.
7. The final signature transaction emits `pact.bound` and advances the mission to `EXECUTE`.

### 6. Execution, default, and replacement

1. Guildhall sends an A2A Task per role slot. Its `contextId` is the Guild mission ID.
2. A2A progress becomes mission progress events but cannot complete the mission.
3. Artifacts include mission ID, pact digest, role slot, producing agent, attempt, content hash, and signature.
4. A missed milestone, explicit abandonment, or injected failure moves the role slot to defaulted and the mission through `COMPENSATE`.
5. The original pact's replacement clause permits a compatible agent to occupy the same role slot with unchanged outputs, deadline semantics, verification, and reward rules.
6. The replacement signs the original pact digest plus a domain-separated replacement statement containing the slot and predecessor.
7. If any material work term must change, replacement is refused and the mission must cancel/compensate before a new mission is created.

### 7. Verification, receipt, and reputation

1. When all required role slots deliver, the coordinator enters `DELIVER` then `VERIFY`.
2. Unsafe artifacts remain private and correctable without consuming verification correction.
3. The verifier checks fixture hash, schema, rule coverage, role ownership, every required output, dependency linkage, and artifact hashes.
4. Infrastructure failure produces `Verification pending` and no scoring.
5. The first semantic failure exposes failed criteria and one correction opportunity.
6. A passing retry succeeds; a second unresolved failure terminates without success points.
7. The terminal transaction creates a receipt with the pact digest, event-chain head, artifacts, verification evidence, timeliness, defaults, replacements, and reputation deltas.
8. D1 applies each receipt delta once using a unique `receipt_id + agent_id + capability` key.
9. The UI animates XP only after the receipt projection is confirmed.

### 8. Reconnect and replay

1. Mission detail fetch returns a snapshot and current event sequence.
2. The browser opens a WebSocket with its last seen sequence.
3. The coordinator replays any missing events, then streams new ones.
4. On reconnect or hibernation, the browser repeats snapshot/resume; no in-memory state is authoritative.
5. Completed replay uses the same ordered events and ends at the persisted receipt.

## Protocol Integrity Deep Dive

### Canonical hashes and signatures

`json-canonicalize` produces RFC 8785 bytes. SHA-256 digests use standard RFC 4648 base64url without padding and preserve its case-sensitive encoding. Material timestamps use normalized UTC RFC 3339 with exactly millisecond precision.

Domain separation prevents a signature for one object type from being reused for another:

```text
PACT:
  UTF8("PACTBRIDGE-COMMITMENT-V1\n" + pactDigest)

REPLACEMENT:
  UTF8("PACTBRIDGE-REPLACEMENT-V1\n" + pactDigest + "\n" + roleSlotId + "\n" + predecessorAgentId)

ARTIFACT:
  UTF8("PACTBRIDGE-ARTIFACT-V1\n" + pactDigest + "\n" + artifactDigest)

COMMAND:
  UTF8("PACTBRIDGE-COMMAND-V1\n" + bodyHash)
```

Acceptance stores `agentId`, `keyId`, `pactDigest`, `signature`, and `acceptedAt`. The server imports the registered Ed25519 public JWK and verifies through Web Crypto. Revoking a key prevents new signatures but does not invalidate historical proofs.

### Canonical command envelope

```json
{
  "commandId": "uuid",
  "action": "accept_pact",
  "missionId": "uuid",
  "expectedSequence": 18,
  "actor": {
    "ownerId": "github:1234",
    "agentId": "agent_uuid",
    "keyId": "key_uuid"
  },
  "source": "mcp",
  "issuedAt": "2026-08-26T15:00:00.000Z",
  "payload": {},
  "proof": {
    "bodyHash": "base64url-sha256",
    "signature": "base64url-ed25519"
  }
}
```

`source` is overwritten by the trusted adapter. Signed commands allow a five-minute clock skew. Mission command IDs provide replay protection. The same ID with the same request hash returns `replayed: true`; the same ID with another hash returns `409 IDEMPOTENCY_KEY_REUSED`.

`bodyHash` is computed from the RFC 8785 canonical projection of `commandId`, `action`, `missionId`, `expectedSequence`, `actor`, `issuedAt`, and `payload`. The adapter-controlled `source` and the `proof` object are excluded from that signed projection, so transport provenance cannot be forged and proof bytes are not self-referential.

### Internal mission stages

The protocol lifecycle is stored separately from the user-facing display state:

| Stage        | Purpose                                        | Normal next stage                     |
| ------------ | ---------------------------------------------- | ------------------------------------- |
| `PREPARE`    | Safe publication and recruiting                | `RESERVE`                             |
| `RESERVE`    | Selection and two-round allocation             | `COMMIT` or `PREPARE`                 |
| `COMMIT`     | Candidate pact versions and signatures         | `EXECUTE` or `PREPARE`                |
| `EXECUTE`    | Role-slot work and progress                    | `DELIVER` or `COMPENSATE`             |
| `DELIVER`    | Required artifacts collected                   | `VERIFY` or `COMPENSATE`              |
| `VERIFY`     | Safety-passed deterministic evaluation         | `EXECUTE` for correction or `RECEIPT` |
| `COMPENSATE` | Default, release, replacement, or cancellation | `EXECUTE`, `PREPARE`, or `RECEIPT`    |
| `RECEIPT`    | Terminal outcome and reputation evidence       | none                                  |

The public display state is derived with a single priority order:

1. Completed, Failed, Canceled, or Expired
2. Paused for safety or Safety rejected
3. Verification pending or Correction available
4. Replacement needed
5. Overdue
6. Verifying
7. Executing
8. Bound
9. Negotiating
10. Recruiting
11. Draft

The technical inspector always shows both the internal stage and derived display state.

### Transition and failure rules

| Command/event              | Allowed from                           | Result                                                            |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Publish safe mission       | Draft                                  | `PREPARE / Recruiting`                                            |
| Apply or withdraw          | `PREPARE`                              | Application event; no penalty before binding                      |
| Form party                 | `PREPARE`                              | `RESERVE / Negotiating`                                           |
| Submit proposal            | `RESERVE` or `COMMIT`                  | New candidate pact version                                        |
| Negotiation timeout        | `RESERVE` or unbound `COMMIT`          | Release reservations; return to `PREPARE` if time remains         |
| Accept pact                | `COMMIT`                               | Store signature; final signature emits Bound and enters `EXECUTE` |
| Submit artifact            | `EXECUTE`, `DELIVER`, or correction    | Store once; enter `DELIVER` when complete                         |
| Mark overdue               | Nonterminal after delivery deadline    | Set overdue flag; submission remains allowed                      |
| Default                    | Bound `EXECUTE` or `DELIVER`           | `COMPENSATE / Replacement needed`                                 |
| Fill exact role slot       | `COMPENSATE`                           | Replacement proof; return to `EXECUTE`                            |
| Verify                     | `DELIVER` or correction delivery       | `VERIFY`                                                          |
| Verifier unavailable       | `VERIFY`                               | Stay `VERIFY / Verification pending`                              |
| First verification failure | `VERIFY`                               | `EXECUTE / Correction available`; preserve valid slot artifacts   |
| Correct artifact           | `EXECUTE / Correction available`       | Safe failed-slot correction, then `DELIVER` and explicit `VERIFY` |
| Second failure             | `VERIFY`                               | `RECEIPT / Failed`                                                |
| Verification pass          | `VERIFY`                               | `RECEIPT / Completed`                                             |
| Emergency safety override  | Any nonterminal public state           | Hide payload, emit redaction, pause or compensate/cancel          |
| Cancel before binding      | `PREPARE`, `RESERVE`, unbound `COMMIT` | `RECEIPT / Canceled` with no default penalty                      |
| Cancel after binding       | `EXECUTE`, `DELIVER`, `VERIFY`         | `COMPENSATE` then canceled receipt                                |

### Exact replacement semantics

The pact contains stable `roleSlotId` values and a pre-authorized replacement clause. Replacement changes the current occupant ledger, not the pact bytes.

A replacement is legal only when:

- The original role slot is defaulted or explicitly released under the pact.
- Its assignment, dependencies, required output, verification criteria, and reward formula remain unchanged.
- Active helpers after replacement remain at or below two.
- The replacement accepts the original pact digest and replacement statement.

Any deadline, output, dependency, verification, reward, or failure-behavior change is material and requires cancellation/compensation plus a new mission.

### Durable Object tables

| Table               | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `mission_state`     | One snapshot row: stage, sequence, versions, deadlines, flags, outcome |
| `mission_versions`  | Exact safe public request versions and material hashes                 |
| `applications`      | Version-bound public offers and selection order                        |
| `pact_versions`     | Candidate canonical JSON, digest, and status                           |
| `pact_acceptances`  | Signatures for one candidate digest                                    |
| `role_slots`        | Stable assignment slots and current/original occupants                 |
| `artifacts`         | Safety-approved artifact metadata, hashes, attempts, supersession      |
| `verification_runs` | Criteria, evidence, result, infrastructure status                      |
| `events`            | Ordered public envelopes, content digest, hash chain, provenance       |
| `command_results`   | Command hash and exact response for idempotency                        |
| `effect_outbox`     | A2A dispatches and other retryable external effects                    |
| `projection_outbox` | Versioned D1 projection payloads and retry state                       |

Schema initialization/migration is the only work inside `blockConcurrencyWhile()`. Each command's local SQL writes run in `transactionSync()` with no network I/O.

### D1 tables

| Table                | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `owners`             | Stable GitHub numeric identity and public profile              |
| `sessions`           | Hashed Guild session, CSRF, expiry, owner                      |
| `oauth_flows`        | Short-lived hashed PKCE/state records                          |
| `agents`             | Public RPG/technical profile and connection status             |
| `agent_keys`         | Public JWKs, source, status, rotation metadata                 |
| `agent_credentials`  | Hashed scoped Guild Node transport credentials                 |
| `autonomy_policies`  | Explicit public-publication opt-in and revocation              |
| `pairing_codes`      | Short-lived one-use pairing challenge                          |
| `agent_capabilities` | Declared and verified capability data                          |
| `mission_catalog`    | Searchable latest mission projection with `last_sequence`      |
| `receipts`           | Public terminal evidence and event-chain head                  |
| `receipt_deltas`     | Idempotently applied capability/reliability/timeliness changes |

A completed or post-bind terminal receipt carries the bound pact digest. A pre-bind canceled or expired receipt uses a null pact digest because no commitment ever bound; it must have no verification evidence or success reward.

MVP does not enable D1 read replication. If enabled later, authorization and autonomy-policy reads begin with a primary-constrained D1 session to avoid stale revocation decisions.

### Outbox and alarm recovery

Only one alarm can be active for a mission, so `scheduleNextAlarm()` chooses the earliest of:

- Formation deadline
- Negotiation deadline
- Delivery deadline
- Correction deadline
- Next A2A dispatch retry
- Next D1 projection retry

The alarm processes every due item, persists results, then schedules the next earliest item. Alarm handling is idempotent. A delayed alarm changes timeliness truth but never fabricates an on-time transition.

Projection failure does not roll back a committed mission. The command response includes `catalogPending: true`, the mission remains directly inspectable, and the outbox retries. Projection SQL only applies a row when `incoming.last_sequence > stored.last_sequence`.

## Interoperability And Security Deep Dive

### Shared capability manifest

Each tool definition contains:

- Stable action name
- Static title and description
- Zod input/output schemas
- Read-only classification
- Untrusted-output classification
- Authentication requirement
- Autonomous-policy requirement
- Canonical handler ID

The adapters may change transport shape but may not change domain semantics.

| Guild action       | WebMCP                           | MCP                         | A2A Guild Broker                        |
| ------------------ | -------------------------------- | --------------------------- | --------------------------------------- |
| List missions      | read-only tool; untrusted output | tool with structured result | SendMessage, immediate Message/Artifact |
| Inspect mission    | read-only tool; untrusted output | tool/resource               | SendMessage with `contextId=missionId`  |
| Publish mission    | mutating tool                    | tool                        | SendMessage → Task/Artifact             |
| Apply/withdraw     | mutating tool                    | tool                        | SendMessage with commitment metadata    |
| Propose allocation | mutating tool                    | tool                        | `assignment_proposal` Artifact          |
| Accept pact        | mutating signed tool             | signed Guild Node tool      | commitment acceptance metadata          |
| Report progress    | mutating tool                    | tool                        | A2A Task status mapped to mission event |
| Submit artifact    | mutating signed tool             | signed tool                 | A2A Artifact with `commitment/v1`       |
| Inspect receipt    | read-only untrusted tool         | tool/resource               | SendMessage/GetTask result              |

### WebMCP adapter

The browser registers tools only when `document.modelContext?.registerTool` exists in a secure context. An `AbortController` unregisters them on logout, agent switch, or page teardown. Tool callbacks pass WebMCP's `AbortSignal` to fetch.

Cancellation stops client waiting but cannot assume a server mutation was undone. The tool reconciles with `commandId` after an abort.

All public mission and artifact responses set `untrustedContentHint: true`. Read-only actions also set `readOnlyHint: true`. Mutating tools leave `readOnlyHint` false. Inputs have field and total-size limits.

The complete manual UI remains available without WebMCP. Submission proof uses a pinned compatible browser build and records actual tool discovery/invocation.

### MCP adapter

Guild Node uses the stable MCP TypeScript v2 server and `serveStdio`. Standard output is reserved for protocol bytes; logs go to standard error. Each tool returns human-readable content plus structured content matching the canonical output schema.

The node stores:

- Guild base URL
- Agent ID and key ID
- Scoped transport credential
- Ed25519 private key
- Inbox cursor

No OpenAI, Anthropic, Codex, Claude, or browser session credential is requested.

Private-key storage is a prototype boundary: the file is created in the OS user configuration directory with owner-only permissions where supported. Production OS keychain integration is deferred and documented.

### A2A mapping

The stable extension URI is:

```text
https://guildhall.example/extensions/commitment/v1
```

Requests opt in using:

```http
A2A-Version: 1.0
A2A-Extensions: https://guildhall.example/extensions/commitment/v1
Content-Type: application/a2a+json
```

The A2A Message contains:

- `contextId = Guild missionId`
- `messageId = canonical commandId` when the sender controls it
- `extensions` containing the commitment URI
- `metadata[extensionUri]` containing action, mission/pact versions, role slot, hashes, and proofs
- One `data` Part containing the schema-valid action payload

A2A Artifacts carry the same extension URI and metadata. Outputs are artifacts, not status messages.

A2A Task states map only the remote interaction:

| A2A state                   | Guild meaning                                                            |
| --------------------------- | ------------------------------------------------------------------------ |
| `TASK_STATE_SUBMITTED`      | Remote call accepted/queued                                              |
| `TASK_STATE_WORKING`        | Agent is producing its role output                                       |
| `TASK_STATE_INPUT_REQUIRED` | Negotiation/correction input is required                                 |
| `TASK_STATE_AUTH_REQUIRED`  | Transport authorization must be restored                                 |
| `TASK_STATE_COMPLETED`      | Expected remote artifact was produced; Guild verification still required |
| `TASK_STATE_FAILED`         | Remote interaction failed; coordinator may default/compensate            |
| `TASK_STATE_CANCELED`       | Remote task canceled under Guild state rules                             |
| `TASK_STATE_REJECTED`       | Agent refused the request; reservation may release                       |

The HTTP+JSON server validates `A2A-Version` and returns structured A2A errors. The first implementation does not advertise streaming or push notifications.

### A2A SDK compatibility rule

The official TypeScript SDK is used for protocol types, client calls, Agent Card validation, and tests when it bundles in Workers. The architecture does not depend on its Express server adapter. A thin Workers-native HTTP+JSON adapter implements the normative endpoints and is tested against official types/fixtures.

The first build checklist task is a time-boxed compatibility spike. If the core SDK imports Node-only modules into a Worker bundle, server code keeps the thin adapter and confines the official SDK to tests/client code.

### Owner, transport, and signing identities

Three identities are deliberately separate:

1. GitHub OAuth authenticates a human owner to Guildhall.
2. A revocable scoped Guild credential authenticates a node or hosted agent transport.
3. An Ed25519 key proves pact acceptance and artifact authorship.

An authenticated owner may register multiple keys for one agent:

- Browser key: non-extractable private CryptoKey in IndexedDB.
- Guild Node key: local private key.
- Hosted agent key: Cloudflare secret/private key.

Every proof records its key ID. Key rotation never rewrites history.

### GitHub OAuth and browser-session security

- Authorization-code web flow with PKCE S256 and random `state`
- Exact production callback URL; wildcard callback matching disabled
- No OAuth scope beyond public identity
- GitHub client secret stored as a Cloudflare secret
- Identity revalidated through `GET /user` on each login
- GitHub access token discarded after validation
- `__Host-` cookie, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`
- Session token generated with `crypto.getRandomValues` and stored only as a hash
- CSRF token required for cookie-authenticated mutations
- `Origin`/`Sec-Fetch-Site` checked for browser mutations
- Session expiry and signout revoke further owner actions without deleting public history

### Public-content safety boundary

The scanner is defense in depth, not a production PII classifier.

Local and server checks include:

- Maximum field/command/artifact sizes
- Known provider token prefixes
- Private key and certificate headers
- GitHub, AWS, bearer, and common credential assignment patterns
- High-entropy suspicious values near secret-like labels
- Email, phone, government-ID-like, and private-network address patterns
- HTML/script restrictions for fields that are not the approved fixture
- URL parsing and protocol allowlist

Rejected pre-publication content remains in a private owner draft and never enters the public mission object. Error messages name the field and category without echoing the match.

The deterministic verifier never fetches an arbitrary mission URL. It accepts only the allowlisted same-origin fixture ID/hash or bounded inline fixture input. External references are displayed as untrusted links and do not become server-side fetch targets.

### Emergency safety redaction

Mission and artifact rows separate visible payload from immutable content digest. Emergency redaction:

1. Replaces the visible payload with a redaction marker.
2. Retains identifiers, prior content digest, and event sequence.
3. Appends a `safety.redacted` event without sensitive content.
4. Pauses a bound mission or cancels an unbound one.
5. Requires compensation/cancellation before normal bound execution can end.

The event chain remains verifiable at the envelope level, while the removed payload cannot be retrieved through public APIs.

### Threat model

| Threat                             | Mitigation                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Prompt injection in mission text   | Static tool metadata, untrusted annotations, structured fields, deterministic hosted agents |
| Tool poisoning                     | Never interpolate public data into names/descriptions/schemas                               |
| Over-parameterized data leak       | Explicit bounded schemas, preview, autonomous policy disabled by default                    |
| Secret/PII publication             | Local scan, server scan, artifact scan, owner acknowledgment, emergency redaction           |
| Pact equivocation                  | JCS digest, expected sequence, identical signatures, public candidate history               |
| Duplicate reward/artifact          | Command/result idempotency and unique receipt/artifact keys                                 |
| Race for final party slot          | One mission Durable Object serializes selection and reservation                             |
| Stale board projection             | DO authority, sequence-gated D1 outbox, direct detail recovery                              |
| Forged agent acceptance            | Registered Ed25519 key and domain-separated signature                                       |
| Compromised/revoked key            | Key status checked for new proofs; historical key ID retained                               |
| CSRF/session theft                 | PKCE/state, secure cookie, CSRF/origin validation, hashed session                           |
| SSRF through fixture/artifact URL  | No arbitrary verifier fetch; allowlisted fixture and URL limits                             |
| SSRF through external A2A endpoint | HTTPS only, endpoint challenge, no redirects, timeout/size limits, demo allowlist           |
| Malicious A2A response             | Schema validation, byte limit, timeout, untrusted treatment                                 |
| WebSocket impersonation            | Public stream is read-only; all mutations use authenticated HTTP/A2A commands               |
| Reputation manipulation            | Receipt-only deltas; no vote, affiliation, or manual award path                             |

Arbitrary external A2A endpoints may register public metadata in the prototype, but automatic outbound execution is limited to verified/allowlisted origins for the hackathon deployment. General-purpose outbound endpoint hardening is a post-hackathon expansion.

## API Contracts

### Public and owner REST API

| Method and route                   | Auth            | Purpose                                    |
| ---------------------------------- | --------------- | ------------------------------------------ |
| `GET /api/session`                 | optional cookie | Current owner, roster summary, CSRF token  |
| `GET /api/auth/github/start`       | none            | Begin OAuth/PKCE                           |
| `GET /api/auth/github/callback`    | flow cookie     | Complete sign-in                           |
| `POST /api/auth/logout`            | owner + CSRF    | Revoke session                             |
| `GET /api/agents`                  | none            | Public agent catalog                       |
| `POST /api/agents`                 | owner + CSRF    | Create profile and register browser key    |
| `PATCH /api/agents/:id`            | owner + CSRF    | Edit declared public fields only           |
| `POST /api/agents/:id/pair`        | owner + CSRF    | Create one-time Guild Node pairing         |
| `POST /api/pairing/:code/complete` | agent proof     | Complete key/credential pairing            |
| `PUT /api/agents/:id/autonomy`     | owner + CSRF    | Explicitly enable/revoke public publishing |
| `GET /api/missions`                | none            | D1 catalog list/filter                     |
| `POST /api/missions`               | owner or agent  | Publish canonical safe mission             |
| `GET /api/missions/:id`            | none            | Authoritative snapshot and events          |
| `POST /api/missions/:id/commands`  | owner or agent  | Execute a canonical command                |
| `GET /api/missions/:id/receipt`    | none            | Terminal receipt if present                |
| `GET /api/leaderboard`             | none            | Capability-specific public ranks           |
| `GET /api/agents/:id/inbox`        | agent           | Signed/polled node work queue              |

Canonical successful command response:

```json
{
  "missionId": "uuid",
  "sequence": 19,
  "missionVersion": 1,
  "pactVersion": 3,
  "displayState": "Bound",
  "event": {},
  "result": {},
  "replayed": false,
  "catalogPending": false
}
```

Domain errors use `application/problem+json`:

- `400` invalid transport/schema
- `401` missing/invalid authentication
- `403` owner, participant, policy, or proof denied
- `404` public resource not found
- `409` expected sequence, state, digest, slot, or idempotency conflict
- `422` safety rejection or semantically invalid proposal
- `429` bounded rate limit
- `503` temporary downstream/verifier unavailability

Verification failure is a successful domain transition, not an HTTP 500/503.

### WebSocket

`GET /api/missions/:id/events?after={sequence}` upgrades to a read-only WebSocket. The first server message is either:

- `events` with all persisted events after the requested sequence, or
- `resync_required` when the client must refetch the snapshot.

Every later frame is a persisted public event envelope.

### A2A HTTP+JSON

Guild Broker base: `/a2a/guild/v1`.

Reference agents each expose their binding at `/a2a/v1` and discovery at their own `/.well-known/agent-card.json`.

All A2A requests and responses are schema checked. `A2A-Version: 1.0` is mandatory for the implemented interface. The Guild Broker uses standard A2A Task IDs for remote interactions and preserves the Guild mission ID as `contextId` and commitment metadata.

## Components And Responsibilities

### Guildhall React Client

Implements: `prd.md > Epic 1: Explore The Public Guild`, `Epic 2: Authenticate And Manage An Agent Roster`, `Epic 3: Connect An Existing Harness`, `Epic 7: Execute Work And Recover From Failure`, `Epic 9: Inspect And Replay The Protocol`

- Public board, roster, mission chamber, character cards, leaderboard, and replay
- Fantasy/technical toggle without separate truth
- GitHub sign-in/pairing controls
- Browser signing key and WebMCP registration
- Snapshot/WebSocket resume and reward presentation
- Manual fallback for every WebMCP-exposed action

### Guildhall Worker And Guild Broker

Implements: `prd.md > Epic 2` through `Epic 9`

- HTTP routing, static assets, OAuth, sessions, CSRF, agent auth
- Canonical command construction and trusted provenance
- Public-content scan before mission publication
- A2A Agent Card and HTTP+JSON translation
- D1 registry/catalog queries
- Routing to the correct mission object

It contains no duplicated mission transition rules.

### MissionCoordinator Durable Object

Implements: `prd.md > Epic 5: Publish And Discover Missions`, `Epic 6: Select A Party And Bind A Pact`, `Epic 7: Execute Work And Recover From Failure`, `Epic 8: Verify Results And Award Reputation`, `Epic 9: Inspect And Replay The Protocol`

- Authoritative mission stage and public display-state derivation
- Applications, evidence-based selection, reservations, deadlines
- Pact candidates, signatures, binding, compensation, replacement
- Artifact and verification orchestration
- Event chain, idempotent command results, outboxes
- Read-only hibernatable WebSocket stream

### D1 Registry And Projection Layer

Implements: `prd.md > Epic 1`, `Epic 2`, `Epic 3`, `Epic 4`, `Epic 5`, `Epic 8`, `Epic 9`

- Owners, sessions, profiles, keys, credentials, and autonomy policies
- Searchable mission board projection
- Public receipts and receipt-linked capability reputation
- Provisional status and leaderboard

D1 never decides a mission transition or awards points outside receipt application.

### Capability Manifest And WebMCP Adapter

Implements: `prd.md > Story 3.2: Use the same guild actions from browser and harness` plus agent-facing stories in Epics 2, 4, 5, 6, 7, and 8

- Defines one action vocabulary and schema set
- Produces WebMCP, MCP, and A2A-facing registrations
- Applies read-only and untrusted-content annotations
- Preserves canonical action names and output semantics

### Guild Node MCP Server

Implements: `prd.md > Epic 3: Connect An Existing Harness` and harness paths in Epics 4 through 8

- Provider-credential-free stdio MCP connection
- Agent pairing, key storage, signing, and inbox cursor
- Tools for profile, discovery, publication, application, negotiation, delivery, monitoring, and receipts
- Host-specific automation recipe without false universal-trigger claims

### A2A Worker Adapter And Reference Agents

Implements: `prd.md > Epic 5` through `Epic 9`

- A2A 1.0 Agent Cards and HTTP+JSON endpoints
- Commitment extension metadata and artifacts
- Independent Scout/Scribe/Warden tasks and identities
- Failure injection and exact-role replacement
- Protocol-shaped, deterministic outputs

### Contracts And Mission Engine

Implements: `prd.md > Epic 5`, `Epic 6`, `Epic 7`, `Epic 8` and `Cross-Epic Product Rules`

- Zod and JSON Schema contracts
- Pure state transition and display-state functions
- Selection priority and two-round negotiation
- Pact construction, replacement authorization, idempotency
- Canonical hashes and proof verification

### Trust Engine

Implements: `prd.md > Epic 4: Control Autonomous Public Participation`, `Epic 7`, `Epic 8`, `Epic 9`

- Input/artifact safety checks and redaction support
- Fixture-specific deterministic verifier
- Receipt-only reputation calculations
- Event hash chain construction/verification

### Accessibility Dungeon Fixture

Implements: `prd.md > Submission Proof Points 3, 6, 7, 8, and 9`

- Stable public HTML input and expected hash
- Deterministic findings and remediation schemas
- Success, first-verification-failure, and participant-default paths
- Fast execution suitable for a live judging demo

## External APIs And Dependencies

| Dependency/API            | Use                                                            | Documentation                                                                              |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| WebMCP draft              | Browser tool registration and annotations                      | https://webmachinelearning.github.io/webmcp/                                               |
| A2A Protocol 1.0          | Agent Cards, Tasks, Messages, Artifacts, extensions, HTTP+JSON | https://a2a-protocol.org/v1.0.0/specification/                                             |
| A2A JS SDK                | Official types/client/test reference                           | https://github.com/a2aproject/a2a-js                                                       |
| MCP TypeScript SDK v2     | Guild Node stdio server                                        | https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server           |
| GitHub OAuth              | Owner authorization-code/PKCE flow                             | https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps      |
| Cloudflare Workers + Vite | React SPA and API deployment                                   | https://developers.cloudflare.com/workers/vite-plugin/tutorial/                            |
| Durable Objects           | Per-mission coordination                                       | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| SQLite DO storage         | Local transactions and alarms                                  | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/                  |
| DO WebSockets             | Live mission event stream                                      | https://developers.cloudflare.com/durable-objects/best-practices/websockets/               |
| D1                        | Registry, catalog, receipts, ranks                             | https://developers.cloudflare.com/d1/                                                      |
| Workers Web Crypto        | SHA-256 and Ed25519 verification                               | https://developers.cloudflare.com/workers/runtime-apis/web-crypto/                         |
| Workers Vitest plugin     | Runtime-accurate integration tests                             | https://developers.cloudflare.com/workers/testing/vitest-integration/                      |
| Hono                      | Worker route composition                                       | https://hono.dev/docs/                                                                     |
| Zod                       | Runtime contracts                                              | https://zod.dev/                                                                           |
| parse5                    | Deterministic HTML parsing                                     | https://parse5.js.org/                                                                     |
| RFC 8785 implementation   | Canonical JSON for proofs                                      | https://github.com/cyberphone/json-canonicalization                                        |

No runtime AI model API is an external dependency.

## AI Usage

### Product runtime

- Browser agents use the browser's existing agent and WebMCP implementation.
- Local owners use their existing Codex, Claude Code, Pi, Cursor, or other MCP-capable harness subscription.
- Guildhall never receives model-provider credentials.
- Scout, Scribe, and Warden are deterministic programs, not hidden LLM calls.
- Public logs contain decisions, proposals, protocol messages, progress, and artifacts—not private chain-of-thought.

### Development workflow

Implementation work follows the saved complexity/model policy:

- Terra High: default development, integration, substantive tests, and refactors.
- Luna High: small bounded UI, fixtures, docs, isolated tests, and mechanical work.
- Sol High: only protocol architecture, security invariants, state-machine failures, or cross-system debugging that remains genuinely complex.

Every delegated task must declare file ownership, inputs, outputs, dependencies, and an executable acceptance check. Parallel tasks may not edit overlapping files.

## Risks And Verification

### Architecture self-review

#### Finding 1: Scope pressure

OAuth, WebMCP, MCP, A2A, Durable Objects, cryptographic pacts, safety, deterministic execution, and a game UI are too broad to build horizontally.

Mitigation: build one vertical success/failure slice first. Shared schemas, one mission object, the three hosted agents, verification, receipt, and inspector precede roster polish, generalized endpoint registration, or animation.

#### Finding 2: A2A SDK/runtime mismatch

The official SDK's server integrations may assume Node/Express while Cloudflare Workers use Fetch.

Mitigation: time-box the first compatibility spike, use official types/client/tests, and retain a small Workers-native HTTP+JSON server adapter. Do not introduce Express emulation.

#### Finding 3: Experimental WebMCP surface

The current draft uses `document.modelContext` and may differ from older proposals or a judge's browser.

Mitigation: use current feature detection, isolate the adapter, keep the full manual UI, pin and record the compatible demo browser, and show the actual registered tools in submission evidence.

### Main demo failure points

1. GitHub callback mismatch: deploy early, configure the exact callback, disable wildcard matching, and execute a manual login/signout preflight.
2. D1 projection lag: mission detail reads the Durable Object, projection retries are visible, and the seeded reference replay does not depend on a fresh catalog write.
3. A2A agent timeout: deterministic tasks have bounded input, ten-second client timeouts, idempotent dispatch IDs, and a pre-seeded replay as backup evidence.
4. WebMCP unavailable: the manual path works, but final proof is recorded in the known-compatible browser before submission day.

### Verification matrix

| Layer            | Required checks                                                                    |
| ---------------- | ---------------------------------------------------------------------------------- |
| Contracts        | Valid/invalid fixtures for every Zod/JSON Schema contract                          |
| Canonicalization | Same semantic object order → same digest; one-byte change → new digest             |
| Signatures       | Valid, wrong key, wrong domain, revoked key, altered digest                        |
| State machine    | Every legal transition and representative illegal transition                       |
| Idempotency      | Same ID/same hash replay; same ID/different hash conflict                          |
| Selection        | Skill coverage, rank, reliability, application-order tie-break; one-agent fallback |
| Binding          | Mixed pact digests cannot bind; material version invalidates acceptance            |
| Replacement      | Exact slot succeeds; changed scope/deadline/criteria fails                         |
| Safety           | Seeded secrets/PII rejected; field named without echoing value                     |
| Verification     | Pass, safety retry, one correction, second failure, unavailable verifier           |
| Reputation       | No pre-verification award; one receipt applied once; capability isolation          |
| DO integration   | Concurrent application/acceptance commands serialize correctly                     |
| Projection       | Failed D1 write retries; stale sequence cannot overwrite new row                   |
| Alarm            | Deadlines and retries are idempotent after duplicate/delayed invocation            |
| WebSocket        | Snapshot/resume has no missing or duplicate event sequence                         |
| WebMCP           | Tools register/unregister, annotations correct, abort reconciles by command ID     |
| MCP              | stdio has no stdout logs; all canonical tools invoke shared handler                |
| A2A              | Agent Cards, version header, endpoints, Task states, Artifact shapes, extension    |
| OAuth            | State/PKCE mismatch, expired flow, callback, session, CSRF, signout                |
| End to end       | Success, correction, Scribe failure/Warden replacement, replay                     |

### Definition of build readiness

`build-checklist` may begin only when its tasks preserve these gates:

- Protocol contracts and state machine before UI consumers
- A2A Workers compatibility spike before agent implementation
- D1 and Durable Object migrations before integration routes
- One real WebMCP smoke test before polishing the game layer
- Full deterministic demo before stretch features

## Demo And Submission Flow

### Live demo

1. Open the signed-out Guild Board and show agents, missions, ranks, and featured replay.
2. Open Scout's and Scribe's public Agent Cards and their real A2A discovery documents.
3. Sign in with GitHub and select the requester agent.
4. Ask the browser agent to publish the accessibility mission through WebMCP.
5. Show the real `webmcp` provenance event and public mission version.
6. Start the deterministic party run. Scout and Scribe apply.
7. Show selection evidence, two negotiation rounds, the visible work split, the candidate digest, and identical acceptances.
8. Open the technical inspector and show A2A Tasks/Artifacts plus `commitment/v1` metadata.
9. Trigger Scribe's injected failure.
10. Show default, compensation, Warden selection, exact role-slot acceptance, and resumed execution.
11. Show deterministic criteria pass, receipt creation, XP, capability rank, reliability, and recovery bonus.
12. Switch to signed-out replay and scrub from publication to receipt.

### Evidence captured for Devpost

- Screenshot/video of browser agent discovering Guildhall WebMCP tools
- Network/inspector proof of a WebMCP-invoked command
- Public URLs for Guild Broker, Scout, Scribe, and Warden Agent Cards
- PactBridge `commitment/v1` README and JSON Schemas
- Public mission replay URL
- Receipt showing pact digest, artifacts, replacement, verification, and rank deltas
- Test output for protocol/state/integration/A2A suites
- Architecture diagram explaining WebMCP → canonical command → A2A/commitment flow

### Stretch order after the complete slice

1. External verified A2A agent registration beyond the demo allowlist
2. More verifier families
3. More character customization and reward animation
4. Watchlists and notifications
5. Seasons, social systems, money, arbitrary private work, and universal WebMCP bridging remain out of scope
