# Build Checklist

Status: **Locked**

## Build Preferences

- **Project container:** `E:\webmcp-challenge`
- **Git repository / application root:** `E:\webmcp-challenge\guildhall`
- **Repository strategy:** One pnpm monorepo. Guildhall, Guild Node, PactBridge libraries, and all A2A deployments are packages/apps in this repository; no nested repositories.
- **Plan design:** Handed off to Codex.
- **Build mode:** Autonomous. This choice locks when `$build-project` starts.
- **Comprehension checks:** N/A.
- **Git:** Initialize the repository in item 1. Commit after every completed checklist item; never commit a failing checkpoint. Tag the live-demo candidate after item 11.
- **Verification:** Automated acceptance check after every item plus three participant look-at-it pauses.
- **Verification pauses:** After item 4 (protocol core), item 8 (live WebMCP/A2A), and item 11 (full demo).
- **Check-in cadence:** Speed-run between the three pauses, with concise progress updates and immediate escalation only for a real blocker or scope-changing decision.
- **Item size:** Each item targets a 15–30 minute orchestrated implementation slice. Parallel packets must have non-overlapping file ownership. Failed verification extends the current item; it is never hidden by moving forward.
- **Runtime credential rule:** Never request or store OpenAI, Anthropic, Codex, Claude, or other model-provider credentials.
- **Model routing:** Terra High owns implementation/integration; Luna High owns bounded fixtures, isolated tests, docs, and small UI packets; Sol High is reserved for protocol/security/state-machine design review or complex cross-system debugging.
- **Wow moment:** Live work division → identical pact binding → injected Scribe failure → Warden replacement → deterministic receipt and XP.

## Checklist

- [x] **1. Bootstrap the contained monorepo and retire runtime uncertainty**
      Spec ref: `spec.md > Stack > Deployment topology` and `spec.md > Risks And Verification > Architecture self-review`
      What to build: In `E:\webmcp-challenge\guildhall`, Terra High initializes Git and the pnpm workspace; creates the annotated `apps/*`, `packages/*`, `protocol/*`, `fixtures/*`, `migrations/*`, and `tests/*` skeletons; configures strict TypeScript, Vitest, Vite, Wrangler, root scripts, formatting, and ignore rules; and copies no files outside this repository. Time-box two spikes: bundle the official A2A SDK in a minimal Worker and compile a feature-detected `document.modelContext` adapter. Record whether the hosted A2A server uses SDK internals or the Fetch-native adapter. Luna High may own empty package manifests and smoke fixtures without editing root configs.
      Acceptance: The workspace installs from one lockfile; a React/Worker shell and one demo-agent shell build; the A2A compatibility decision is recorded; current WebMCP names are used; no product code or state remains at `E:\` root.
      Verify: Run `pnpm install`, `pnpm check:workspace`, `pnpm build:smoke`, and `pnpm exec wrangler deploy --dry-run --config apps/guildhall/wrangler.jsonc`; confirm `git status --short` contains only intentional repository files.

- [x] **2. Implement canonical contracts, hashes, keys, and proofs**
      Spec ref: `spec.md > Protocol Integrity Deep Dive > Canonical hashes and signatures` and `spec.md > File Structure > packages/contracts`
      What to build: Sol High reviews the exact `commitment/v1` invariants and signature domains; Terra High implements Zod contracts for missions, commands, events, pacts, acceptances, role slots, artifacts, verification, replacements, and receipts; RFC 8785 canonicalization; SHA-256 base64url digests; Ed25519 sign/verify helpers; generated JSON Schemas; and normative protocol examples. Luna High owns invalid/valid contract fixtures and signature test vectors.
      Acceptance: Semantically identical objects with different property order hash identically; a one-byte material change changes the digest; wrong-domain, wrong-key, revoked-key, and altered-payload proofs fail; every published schema has a passing example and a failing example.
      Verify: Run `pnpm test:contracts` and `pnpm test:crypto`; validate every file under `protocol/commitment-v1/examples` against its published schema.

- [x] **3. Build the pure mission lifecycle, selection, negotiation, and replacement engine**
      Spec ref: `spec.md > Protocol Integrity Deep Dive > Internal mission stages` through `Exact replacement semantics`
      What to build: Sol High reviews transition completeness and material-change boundaries; Terra High implements the pure PREPARE→RESERVE→COMMIT→EXECUTE→DELIVER→VERIFY→COMPENSATE→RECEIPT engine, display-state derivation, applicant ordering, maximum-two-helper enforcement, one-helper inheritance, two-round assignment negotiation, pact-version invalidation, identical-digest binding, overdue behavior, correction accounting, and exact role-slot replacement. Luna High owns table-driven illegal-transition and edge-case fixtures.
      Acceptance: Selection uses skill coverage, verified rank, reliability, then application event sequence; one helper may proceed when two were preferred; mixed pact digests cannot bind; a material pre-bind edit invalidates prior applications/acceptances; post-bind changed scope cannot masquerade as replacement; safety rejection does not consume the one verification correction.
      Verify: Run `pnpm test:state-machine` and `pnpm test:state-properties`; inspect generated transition coverage to confirm every PRD display state is reachable or intentionally derived.

- [x] **4. Persist one authoritative mission with recoverable projections**
      Spec ref: `spec.md > Architecture > Authority and consistency`, `spec.md > Protocol Integrity Deep Dive > Durable Object tables`, and `D1 tables`
      What to build: Terra High implements `MissionCoordinator` with SQLite migrations, synchronous command transactions, event hash chain, command-result idempotency, effect/projection outboxes, one earliest-deadline alarm, hibernatable read-only WebSockets, and RPC methods. A separate Terra packet owns D1 migrations and sequence-gated repositories; Luna High owns concurrency, duplicate-command, stale-projection, alarm, and reconnect fixtures. Wire the minimal canonical command API but no polished UI.
      Acceptance: Concurrent applications and final acceptances serialize; same command ID/same request hash replays one result; reused ID/different hash conflicts; local mission truth survives a failed D1 write; stale projection cannot overwrite a newer one; snapshot plus event sequence restores after reconnect.
      Verify: Run `pnpm test:protocol-core` inside the Workers runtime, including D1/DO bindings; run the event-chain verifier against a completed synthetic mission; inspect one mission's SQLite snapshot, event order, and pending/cleared outbox rows.

  **Verification pause A — protocol core:** Stop and show Rodrigo the contract examples, a bound pact digest/signatures, legal/illegal transition results, the canonical event stream, and a forced D1 projection retry. Do not continue until this checkpoint is acknowledged.

- [x] **5. Implement GitHub ownership, agent identities, pairing, policies, and safety**
      Spec ref: `spec.md > Interoperability And Security Deep Dive > Owner, transport, and signing identities` through `Public-content safety boundary`
      What to build: Terra High implements GitHub authorization-code + PKCE/state endpoints, hashed `__Host-` sessions, CSRF/origin checks, owner/agent authorization, browser-key registration, scoped Guild Node credentials, one-time possession-proven pairing, key revocation, autonomy-policy enable/revoke, private drafts, dual local/server safety scanning, and emergency redaction commands. Luna High owns seeded secret/PII/safe-content fixtures and mocked GitHub-flow tests.
      Acceptance: GitHub is the only required account; no provider credential appears in UI/schema/logs; signout/revocation blocks new protected actions; autonomous publication is disabled by default and revokes immediately; unsafe content never reaches the public mission object and errors do not echo the match; historical proofs survive key revocation.
      Verify: Run `pnpm test:auth` and `pnpm test:safety`; complete local mocked login, pairing challenge, signed command, revocation, and redaction flows; grep built assets/log fixtures for prohibited provider-credential fields.

- [x] **6. Generate equivalent WebMCP and MCP capabilities**
      Spec ref: `spec.md > Interoperability And Security Deep Dive > Shared capability manifest` through `MCP adapter`
      What to build: Terra High implements the canonical capability manifest and browser WebMCP adapter with secure-context feature detection, `document.modelContext.registerTool()`, abort-driven unregister/reconciliation, browser signing key, correct read-only/untrusted annotations, and trusted provenance. In a non-overlapping packet, Terra High implements Guild Node MCP v2 stdio, pairing/status commands, signed Guild client, inbox cursor, and the full canonical tool set. Luna High owns adapter parity snapshots, stdio protocol tests, and Codex/Claude/Cursor/Pi configuration examples.
      Acceptance: Browser and harness surfaces expose equivalent profile, mission, application, negotiation, monitoring, artifact, and receipt actions; all actions hit one public timeline; public outputs are marked untrusted; stdout contains only MCP protocol bytes; no harness credentials are requested.
      Verify: Run `pnpm test:capability-parity`, `pnpm test:webmcp`, and `pnpm test:mcp`; connect a real local MCP client and execute `guild.list_missions` against the development Worker.

- [x] **7. Expose the Guild Broker and three independent A2A agents**
      Spec ref: `spec.md > Architecture > Guild Broker`, `Hosted reference agents`, and `Interoperability And Security Deep Dive > A2A mapping`
      What to build: Terra High implements the Workers-native A2A 1.0 HTTP+JSON endpoints, Agent Card builder, version/extension/error validation, bounded client, Task store, and Guild Broker translation to canonical commands. Separate Terra ownership implements Scout's parser/executor; Luna High implements deterministic Scribe/Warden templates, failure fixture, and Agent Card fixtures. Deploy configuration produces three distinct origins and identities. Use the official SDK client/types where the item-1 spike proved safe.
      Acceptance: Guild Broker, Scout, Scribe, and Warden expose valid public Agent Cards; each declares honest capabilities; `A2A-Version: 1.0` and `commitment/v1` metadata are enforced; A2A Task completion remains distinct from mission verification; artifacts contain structured data and signatures.
      Verify: Run `pnpm test:a2a` and `pnpm test:a2a-conformance`; call each `/.well-known/agent-card.json` and `POST /message:send` locally; verify unsupported versions, malformed parts, and missing required extension paths return structured A2A errors.

- [x] **8. Complete the live WebMCP→party formation→A2A pact slice**
      Spec ref: `spec.md > Data Flow > One action through three surfaces` through `Negotiation and binding`
      What to build: Sol High reviews cross-protocol identity/version integrity; Terra High integrates browser publication, public catalog projection, A2A applications, evidence-ranked party selection, two negotiation rounds, visible assignment proposal events, requester/helper signatures, and final identical-digest binding. Luna High owns the constrained mission seed and browser/A2A integration fixtures. Add a minimal technical mission page sufficient to inspect provenance, versions, role slots, and signatures.
      Acceptance: A real browser agent publishes a public-safe mission through WebMCP; Scout and Scribe apply over A2A; no more than two helpers reserve slots; the work split is visible; every signer accepts one digest; the mission reaches Bound without any simulated event or manually edited database row.
      Verify: Run `pnpm test:formation-e2e`, then perform the development-environment live flow while capturing WebMCP tool invocation, A2A requests, candidate pact JSON, signatures, and the ordered public events.

  **Verification pause B — live WebMCP/A2A:** Stop and show Rodrigo the browser agent's real tool call, four Agent Cards, A2A tasks/artifacts, selection evidence, animated/technical work split, and identical pact binding. Do not continue until this checkpoint is acknowledged.

- [x] **9. Execute, fail, replace, verify, and award from one receipt**
      Spec ref: `spec.md > Data Flow > Execution, default, and replacement` and `Verification, receipt, and reputation`
      What to build: Terra High integrates role-task dispatch, progress, signed/hashed artifacts, safety-gated publication, delivery, overdue flag, deterministic fixture verifier, infrastructure-pending state, one semantic correction, Scribe failure injection, public default/compensation, exact-slot Warden replacement, terminal receipts, and idempotent capability/reliability/timeliness deltas. Sol High reviews that replacement and scoring cannot bypass the bound pact. Luna High owns success, correction, verifier-unavailable, second-failure, overdue, duplicate-artifact, and replacement fixtures.
      Acceptance: Valid Scout output survives Scribe's default; Warden accepts unchanged work without a silent pact edit; active helpers never exceed two; points appear only after all required criteria pass; a failed mission gets no success XP; every rank delta links to one receipt and applies once.
      Verify: Run `pnpm test:execution-e2e`, `pnpm test:verification`, and `pnpm test:reputation`; replay the injected-failure event stream and verify its receipt/event-chain head independently.

- [x] **10. Build the public guild, live mission chamber, and replay payoff**
      Spec ref: `spec.md > Components And Responsibilities > Guildhall React Client` and `spec.md > Demo And Submission Flow > Live demo`
      What to build: Terra High owns route/data architecture for signed-out Guild Board, owner roster, character/technical agent profile, mission chamber, leaderboards, receipts, snapshot/WebSocket resume, and deterministic replay controls. Luna High owns original fantasy visual tokens, responsive cards, empty states, state badges, work-map transitions, failure/replacement presentation, XP/rank animation, and accessibility checks without proprietary Dungeons & Dragons assets.
      Acceptance: Signed-out visitors can understand and inspect the network; empty state includes reference agents and replay; fantasy labels reveal technical meaning; live state restores after reopening; the visual emphasis is work division and the reward animation never precedes verified receipt creation.
      Verify: Run `pnpm test:ui`, `pnpm test:replay`, and `pnpm build`; manually check desktop/mobile keyboard navigation, signed-out browsing, empty state, live work split, reconnect, failure/replacement, receipt, and reduced reliability/timeliness visibility.

- [ ] **11. Deploy, harden, and rehearse the complete live wow moment**
      Spec ref: `spec.md > Deployment topology`, `Risks And Verification > Main demo failure points`, and `Demo And Submission Flow`
      What to build: Terra High creates production D1/DO migrations and Cloudflare configuration; stores GitHub/A2A secrets correctly; deploys Guildhall, Scout, Scribe, and Warden; configures the exact GitHub OAuth callback with wildcard matching disabled; runs live migrations; seeds only the public deterministic fixture/reference replay; enables observability without sensitive payload logging; and fixes integration/runtime defects. Luna High prepares the one-command demo reset/seed and rehearsal checklist.
      Acceptance: Public HTTPS URLs work; GitHub OAuth/signout are fully functional; a compatible browser discovers WebMCP tools; Guild Node connects without provider credentials; all A2A Agent Cards/tasks work across deployed origins; the entire live failure/replacement/receipt arc is repeatable from clean seed; no manual database intervention is needed.
      Verify: Run `pnpm check`, `pnpm test`, `pnpm build`, `pnpm deploy:check`, and the deployed `pnpm demo:smoke`; execute two complete live rehearsals, one from a signed-out spectator and one from the authenticated requester/browser-agent view.

  **Verification pause C — full demo:** Stop and let Rodrigo run/watch the complete live wow moment. Capture required corrections and repeat until he explicitly accepts the demo candidate. Tag the accepted commit as the demo candidate.

- [ ] **12. Prepare the Devpost handoff**
      Spec ref: `prd.md > Submission Proof Points` and `spec.md > Demo And Submission Flow > Evidence captured for Devpost`
      What to build: Luna High assembles a concise README, architecture/protocol explanation, setup and Guild Node instructions, tested demo script, public deployment/Agent Card/replay/receipt URLs, screenshot plan, and a short video shot list centered on the live work split and recovery arc. Terra High supplies exact test/deployment evidence, repository status, limitations, security boundaries, and reproducibility commands. Do not submit to Devpost in this item.
      Acceptance: The handoff proves real WebMCP invocation, independent A2A interaction, identical pact binding, deterministic artifacts, visible failure/compensation/replacement, verification-gated receipt/XP, public replay, and absence of model-provider credentials or money.
      Verify: Review every PRD Submission Proof Point against an existing URL, captured asset, command output, or explicit demo-script step; confirm `$prepare-submission` can proceed without inventing missing evidence.
