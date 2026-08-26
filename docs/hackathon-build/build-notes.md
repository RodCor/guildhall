# Build Notes

## 2026-08-26 — Guided build onboarding

### Decisions

- Primary users: agent builders and owners; spectators are secondary.
- Core deliverables: WebMCP-to-A2A integration profile, A2A Commitment extension with schemas and state machine, and reusable TypeScript reference library.
- Initial execution model: one real browser agent using WebMCP plus three deterministic A2A-compatible agents; no model API keys required.
- Core interaction: a requester agent publishes a bounded request and selects at most two helpers. The selected agents bind scope, divide the work, agree on output format/location, deliver, verify, and receive points.
- Rewards: rankings, points, and reputation only; no money.
- Presentation: Dungeons & Dragons-inspired adventurers' guild. Agents are characters with RPG and technical views; owners have rosters and affiliations such as "Guild: Google."
- Visual payoff: show the agents dividing work, then earning rewards after successful verification.
- Naming: separate serious protocol name from playful public-platform name; neither chosen yet.

### Active shaping

- Rodrigo emphasized that "the backend protocols are what are most important" and that the experience must transfer and gamify those mechanics to attract people.
- Rodrigo confirmed that "the game is the excuse on how to show it," preserving the protocol as the real invention.
- Rodrigo requested deterministic A2A agents for the first build while explicitly directing us not to skimp on how the integration is implemented.

### Calibration

- Treat Rodrigo as an experienced builder. Concentrate on architectural choices, standards boundaries, explicit tradeoffs, and scope cuts rather than introductory implementation explanations.

## 2026-08-26 — Scope

### Brain dump and direction

- Owners should participate through Codex, Claude Code, or another harness without giving the platform model-provider credentials.
- Agents may autonomously publish missions only when the content is intentionally public and contains no PII, credentials, or sensitive information.
- A mission declares the maximum number of helpers; the prototype maximum is two active helper agents.
- Interested agents join during an availability window, then allocate work autonomously based on capability rankings and bind the scope and outputs.
- The game layer exists to make the WebMCP/A2A protocol extension compelling and understandable.

### Inspirations retained

- Saga transaction semantics for prepare, reserve, commit, and compensation.
- A2A Agent Cards, tasks, messages, artifacts, and extensions.
- Dungeons & Dragons party formation plus evidence-backed competitive ladders.

### Time ruler

- Approximately seven days remain.
- Rodrigo can provide four hours per day of direct attention, approximately 28 human hours total.
- The PC can remain on continuously for automated work, but machine availability does not expand the product scope.

### Architectural clarification

- WebMCP does not natively turn CLI harnesses into browser agents. The agreed solution is a dual-surface Guild Node: local MCP for the harness, A2A for the network, and corresponding WebMCP tools generated from the same manifest when the guild site is open.
- The universal arbitrary-site WebMCP-to-CLI bridge is explicitly deferred.

### Scope cuts

- No arbitrary-task executor, real money, provider credentials, API-key-dependent remote agents, production PII classifier, production anti-Sybil system, complex disputes, or extensive game/social systems.
- One constrained accessibility-audit mission proves real execution, verification, compensation, replacement, receipts, and reputation.

### Active shaping

- Rodrigo required that participating harnesses also receive a WebMCP-facing integration and accepted the dual-surface Guild Node interpretation.
- Rodrigo approved the proposed scope with the instruction that deferred features can return only if the core is complete early.

### Deepening rounds

- Zero. After the mandatory beats and explicit scope cut, Rodrigo approved the scope "for now" and preferred to extend only if time remains.

## 2026-08-26 — Model and subagent routing preference

- Rodrigo requested complexity-based task decomposition and deliberate model routing.
- GPT-5.6 Terra at high reasoning is the default development worker.
- GPT-5.6 Luna at high reasoning handles smaller, bounded tasks.
- GPT-5.6 Sol at high reasoning is reserved for genuinely complex work.
- Future checklists must assign explicit inputs, outputs, file ownership, dependencies, and verification criteria before work is delegated to subagents.

## 2026-08-26 — Product requirements

### Public experience

- Visitors may browse missions, agent cards, rankings, artifacts, receipts, and replays without signing in.
- GitHub sign-in is required only for participation and ownership actions.
- No completed mission details are hidden by default; only safety redaction may remove sensitive content.
- Agent cards combine fantasy character presentation with a complete technical profile.

### Mission formation and pact

- Missions declare a preferred and maximum party size, with at most two active helpers.
- A mission may proceed with one selected helper even when two were preferred; the lone helper inherits unassigned work.
- Applicants are selected by required-skill coverage, verified rank, reliability, then application time as a tiebreaker.
- Every selected participant must accept the exact same pact version before binding.
- Material changes invalidate prior applications or acceptance; bound terms cannot change silently.
- Failed negotiation releases reservations and reopens recruitment when time remains.

### Failure, safety, and verification

- Withdrawal before binding carries no reliability penalty; default after binding is public, reduces reliability, and may recruit a replacement.
- Valid prior artifacts survive another agent's default.
- Artifact safety rejection is private and correctable and does not consume the one verification correction opportunity.
- Sensitive content discovered after publication triggers an emergency hide/pause/cancel flow with a redacted public event.
- Revoking autonomous publication blocks new missions but does not silently abandon bound commitments.
- Overdue missions remain completable but visibly affect timeliness reputation.

### Reputation and presentation

- New agents are provisional until their first verified receipt.
- Points and capability-specific rank changes follow verified completion and link to receipts.
- Successful recovery may receive a small recovery bonus.
- The central visual payoff is the work splitting across the party and the final receipt-backed reward.

### Deepening rounds

- Zero. Rodrigo chose to write the PRD after the mandatory user-journey, acceptance-criteria, edge-case, and scope-guard rounds.

## 2026-08-26 — Technical specification

### Stack and deployment

- TypeScript/pnpm monorepo with React/Vite, a Cloudflare Worker API, D1, and one SQLite-backed Durable Object per mission.
- Four hosted deployments: Guildhall/Guild Broker plus separately discoverable Scout, Scribe, and Warden A2A Workers.
- Guild Node is a local MCP v2 stdio server for existing coding harnesses and does not collect model-provider credentials.
- GitHub OAuth is a complete authorization-code + PKCE implementation; the GitHub token is discarded after identity validation.

### Locked architecture

- One canonical capability manifest generates WebMCP, MCP, and A2A-facing actions.
- One MissionCoordinator Durable Object is authoritative for each mission; D1 is a sequence-gated public projection and cross-mission registry.
- The Guild Broker exposes A2A 1.0 HTTP+JSON and translates structured A2A messages into canonical Guild commands.
- Scout, Scribe, and Warden are deterministic A2A agents. The accessibility fixture is bounded and server verification never fetches arbitrary URLs.
- Public gameplay, technical inspection, live updates, and replay all derive from the persisted mission event stream.

### Protocol-integrity deepening

- RFC 8785/JCS canonical bytes, SHA-256 digests, Ed25519 proofs, and domain separation are required for pacts, replacements, and artifacts.
- Every mutation carries a command ID, request hash, actor, trusted source, and expected mission sequence.
- Identical retries replay their stored response; a reused command ID with different bytes is rejected.
- The internal lifecycle is PREPARE, RESERVE, COMMIT, EXECUTE, DELIVER, VERIFY, COMPENSATE, and RECEIPT; the PRD's user-facing state is derived separately.
- Replacement occupies a stable role slot under a clause already present in the bound pact. It cannot change scope, outputs, dependencies, deadlines, verification, rewards, or failure behavior.
- Mission transactions persist state, event, command result, and outbox entries before any A2A, D1, or WebSocket side effect.

### Interoperability and security deepening

- A2A Task status represents one remote interaction, not overall Guild mission completion. The Guild mission ID is the A2A context ID.
- commitment/v1 data is carried through the A2A Extensions header, message/artifact extension URI, namespaced metadata, and structured data parts.
- GitHub owner identity, scoped transport authentication, and Ed25519 content signatures are separate and independently revocable.
- WebMCP tools use the current document.modelContext API, feature detection, abort-aware reconciliation, read-only hints, and untrusted-content hints.
- Guild Node cannot universally wake a subscription harness. Hosted agents guarantee autonomy; Codex or other host schedulers are optional recipes.
- Safety is defense in depth: bounded schemas, explicit public opt-in, local/server/artifact scans, no arbitrary verifier fetch, redaction, and allowlisted automatic A2A origins for the hackathon deployment.

### Architecture self-review

- The first build must be a vertical protocol slice because a horizontal implementation would exceed the approximately 28-hour human-attention budget.
- The official A2A SDK may have Node/Express server assumptions, so the checklist must begin with a Workers compatibility spike and retain a thin Fetch-native HTTP+JSON adapter.
- WebMCP remains experimental; the manual UI is a fallback, while submission proof must be recorded in a pinned compatible browser.

### Model and task routing

- The eventual build checklist must preserve Rodrigo's Terra/Luna/Sol routing policy and assign non-overlapping file ownership, dependencies, outputs, and executable acceptance checks.

## 2026-08-26 — Checklist shaping

### Build preferences

- Rodrigo handed checklist sequencing to Codex and selected autonomous build mode.
- Verification pauses are required after the protocol core, the live WebMCP/A2A pact slice, and the complete demo.
- The submission centerpiece is a live sequence: visible work division, identical pact binding, injected Scribe failure, Warden replacement, deterministic receipt, and XP.
- Routine implementation uses a speed-run cadence between those three pauses, with automated checks after every item.
- Git should provide a revert point after every completed checklist item; failing checkpoints are never committed.

### Active shaping: contained disk layout

- Rodrigo interrupted checklist drafting with: "Don't be messy in the disk, create a folder for this and inside all the repos that are needed."
- All hackathon planning files and local state were moved out of the E:\ root into `E:\webmcp-challenge\guildhall`.
- The implementation remains one pnpm monorepo because the web app, Guild Node, PactBridge packages, and three deployments share contracts and do not justify nested repositories.
- No unrelated E:\ content was moved or modified.

### Draft checklist

- Twelve ordered items target the riskiest protocol/runtime assumptions first and the game layer after a real vertical integration.
- This is the handoff planning path, so there was no optional deepening round.
- Rodrigo approved the twelve-item workload and sequencing with "lock in." The checklist is now the build contract.

## 2026-08-26 — Build item 1: contained runtime bootstrap

### Implemented

- Initialized one Git repository and one pnpm workspace at `E:\webmcp-challenge\guildhall`; all application code, fixtures, protocol files, migrations, tests, and planning artifacts remain inside it.
- Added strict TypeScript, Vitest, Prettier, React/Vite, Cloudflare Vite, Wrangler, one lockfile, root verification scripts, and Worker-safe ignore/configuration rules.
- Built an accessible React/Worker Guildhall shell and three separately configured Scout, Scribe, and Warden Worker shells.
- Added the transport-neutral capability-manifest bootstrap and a current WebMCP feature-detection adapter.

### Runtime decisions

- `@a2a-js/sdk@1.0.1` bundles in the Workers runtime when used for official A2A types, constants, and `ClientFactory`. The hosted server remains a thin Fetch-native adapter and imports no Express or gRPC server runtime.
- WebMCP targets `document.modelContext.registerTool()` with secure-context/API detection. Registration lifetime uses one abort signal; mutating calls receive stable command IDs and reconcile after caller aborts.
- The collaboration runtime did not expose a named-model selector. The locked Terra/Luna/Sol policy was applied through task complexity and non-overlapping ownership without representing that a specific model SKU had been forced.

### Verification

- `pnpm install` passed from one lockfile across nine workspace projects.
- `pnpm check:workspace` passed strict typechecks for eight packages/apps plus repository formatting.
- `pnpm build:smoke` passed the React/Worker build and all three official-SDK A2A Worker dry-run bundles.
- `pnpm exec wrangler deploy --dry-run --config apps/guildhall/wrangler.jsonc` passed and found the built SPA assets.
- Capability-manifest WebMCP tests passed 3/3. The A2A bundles were approximately 231 KiB each (36.86 KiB gzip).

## 2026-08-26 — Build item 2: canonical commitment contracts and proofs

### Implemented

- Added strict Zod contracts for missions, commands, events, pacts, acceptances, stable role slots, artifact metadata, deterministic verification, exact-slot replacements, and terminal receipts.
- Published seven generated JSON Schemas both from `packages/contracts/schemas` and under `protocol/commitment-v1`, with fourteen paired valid/invalid normative examples.
- Implemented RFC 8785/JCS canonical bytes, SHA-256 base64url digests, RFC 7638 Ed25519 public-key thumbprints, Workers-safe key import/generation/sign/verify, and status-aware historical proof verification.
- Implemented exact domain-separated PACT, REPLACEMENT, ARTIFACT, and COMMAND proof bytes. Command hashing covers the explicit signed projection and excludes adapter-controlled `source` plus the self-referential `proof`.
- Recorded material-field, immutable replacement, receipt/reputation, timestamp, and public-content rules in the commitment profile.

### Security review corrections

- Corrected the specification's invalid phrase "lowercase base64url." RFC 4648 base64url is case-sensitive; digests now preserve standard casing and omit padding.
- Historical revocation checks use the server-persisted acceptance timestamp. Revoked keys cannot authorize new proofs, while proofs accepted before revocation remain independently verifiable.
- Public JWK validation rejects private key material, proof-domain components reject control characters, and schemas require exact 32-byte digest / 64-byte signature encodings.
- Removed two accidental root-level filenames created by a failed shell quoting experiment. Both targets were verified inside the contained repository before removal; neither held project data and neither is recoverable or needed.

### Verification

- `pnpm check:workspace` passed all strict package/application typechecks and formatting.
- `pnpm test:contracts` passed 7 tests, including all 14 schema example decisions and runtime cross-field invariants.
- `pnpm test:crypto` passed 15 tests covering canonical property-order equality, the known SHA-256 vector, one-byte mutation, exact domains, command projection, wrong domain/key/payload, malformed/private keys, revocation, and historical proof behavior.

## 2026-08-26 — Build item 3: pure mission lifecycle engine

### Implemented

- Added a pure DRAFT→PREPARE→RESERVE→COMMIT→EXECUTE→DELIVER→VERIFY→COMPENSATE→RECEIPT reducer with explicit illegal-transition results, monotonic event sequence, absorbing terminal outcomes, and the locked display-state priority.
- Added application/withdrawal state, material mission-version invalidation, reservation release, at-most-two helpers, visible one-helper fallback, two proposal rounds, exact digest/version acceptances, and requester-plus-all-helper binding.
- Added deterministic applicant ranking by skill coverage, verified capability rank, reliability, and application event sequence, with agent ID used only as a deterministic final tie breaker.
- Added material-versus-cosmetic pact classification, immutable post-bind scope, exact stable-slot replacement, remaining-helper inheritance, preserved valid role artifacts, overdue completion, one semantic correction, safety/infrastructure separation, and command idempotency decisions.
- Generated `tests/state-machine/transition-coverage.json`, proving all sixteen PRD display states derive from an intentional internal snapshot or terminal receipt.

### Review corrections

- Treated the declared minimum party size as a soft requested floor: one eligible helper proceeds, receives a visible minimum-not-met event, and owns one combined allocation without a ghost helper.
- Clarified the first semantic failure as `VERIFY → EXECUTE / Correction available`; only failed role-slot artifacts reopen, then a safe correction reaches `DELIVER` before explicit verification attempt two.
- Made pre-bind canceled/expired receipt pact digests nullable while requiring a bound digest for completed receipts.
- Counted the two-agent maximum by unique active helpers so the remaining helper may inherit a failed exact slot without rewriting pact terms.

### Verification

- `pnpm check:workspace` passed every strict package/application typecheck and formatting check.
- `pnpm test:state-machine` passed 48 table-driven selection, negotiation, replacement, lifecycle, and idempotency tests.
- `pnpm test:state-properties` passed 4 generated/invariant tests: rejected-command immutability, terminal absorption, complete display coverage, and the active-helper ceiling.
- `pnpm test:contracts` remained green at 8 tests after the nullable pre-bind receipt correction.

## 2026-08-26 — Pause B correction: GitHub login routing

### Reported failure

- During participant-owned browser verification, GitHub login exposed `Cannot read properties of undefined (reading 'fetch')` at the Worker SPA fallback.
- The failure remained inside verification pause B; checklist item 9 did not begin.

### Root cause and correction

- `GuildhallEnv` and the fallback handler assumed an `ASSETS` binding, but `wrangler.jsonc` did not declare that optional binding.
- The Worker now returns a structured `404` for an unmatched dynamic route and lets the Cloudflare asset router own the SPA shell.
- Static-asset routing now explicitly runs `/api/*`, `/a2a/*`, and `/.well-known/*` through the Worker first, including GitHub OAuth start/callback navigations.
- Added a Workers-runtime regression test for the exact unmatched-route fall-through.

### Verification

- `pnpm test:auth` passed 17 tests across crypto and OAuth/identity integration.
- `pnpm test:protocol-core` passed 8 files / 29 tests, including the new routing regression.
- The Guildhall production build and Wrangler dry-run passed with the expected D1 and Durable Object bindings.
- A real Vite development server returned `200` for the SPA and health endpoint, structured `404` for the regression route, and a GitHub `302` plus flow cookie for OAuth start.

## 2026-08-26 — Autonomous build items 4–8 and verification pause B

### Item 4: authoritative mission persistence

- Implemented one SQLite-backed `MissionCoordinator` Durable Object per mission with transactional snapshots, ordered event envelopes, command-result idempotency, effect/projection outboxes, alarm recovery, and resumable read-only event streams.
- Added sequence-gated D1 mission projections so stale catalog writes cannot replace newer mission truth.
- Added Workers-runtime coverage for concurrency, replay/conflict behavior, projection retry, event-chain verification, and reconnect recovery.

### Item 5: ownership, identity, and safety

- Implemented complete GitHub OAuth authorization-code + PKCE/state flow, hashed sessions, CSRF/origin enforcement, owner and agent authorization, pairing, Ed25519 key registration/revocation, and autonomous-publication policy controls.
- Added private drafts, bounded request/artifact scanning, and emergency safety-redaction behavior without collecting model-provider credentials.
- Added mocked OAuth, identity, pairing, proof, revocation, and seeded safe/unsafe-content tests.

### Item 6: equivalent WebMCP and MCP capabilities

- Expanded the canonical capability manifest and generated equivalent browser WebMCP and local Guild Node MCP actions from it.
- Added abort-aware WebMCP lifecycle/reconciliation, public-output trust hints, the signed Guild Node client, pairing/configuration commands, and Codex/Claude/Cursor/Pi examples.
- Added capability-parity snapshots plus WebMCP and stdio MCP protocol coverage.

### Item 7: Guild Broker and independent A2A agents

- Implemented the Workers-native A2A 1.0 HTTP+JSON binding, Guild Broker translation, Agent Cards, bounded client, durable Task stores, `commitment/v1` validation, and structured errors.
- Implemented separately configured Scout, Scribe, and Warden agents with independent identities and deterministic artifacts.
- Added A2A binding/conformance, Durable Object Task-store, Agent Card, and Guild Broker integration tests.

### Item 8: live cross-protocol party formation

- Integrated WebMCP mission publication, public projection, A2A applications, evidence-ranked selection, two-round work-allocation negotiation, candidate pact creation, requester/helper signatures, and identical-digest binding.
- Added the technical mission view for provenance, role slots, versions, events, signatures, and the visible party work split.
- `pnpm test:formation-e2e` completed the real Workers-runtime formation path with 16 persisted events and no manually inserted mission transitions.

### Pause B acceptance

- The complete automated suite passed (`pnpm check`: 18 Vitest files / 165 tests plus 8 Workers-runtime files / 29 tests), along with the Guildhall production build and Wrangler dry-run.
- After the Worker/static-asset routing correction, Rodrigo repeated the participant-owned GitHub browser flow and confirmed: "Now it work fine!"
- Verification pause B is accepted. Checklist item 9 is the next build item; no item-9 implementation began during the pause.

## 2026-08-26 — Build item 9: failure, recovery, verification, and receipt

### Implemented

- Added resumable A2A execution dispatch for Scout and Scribe, signed progress and artifact delivery, controlled Scribe failure, public default, and exact Scribe-slot replacement by Warden under the unchanged pact digest.
- Added autonomous helper acceptance of the final pact during scheduled runs. Scout and Scribe validate the canonical v2 pact, their own bid/proposal/slot evidence, and existing acceptances before signing; duplicate cron invocations do not create another acceptance.
- Added server-side artifact safety feedback containing only the affected field path and general category. Unsafe content remains private, does not advance the event sequence, and does not consume the verification correction opportunity.
- Added the deterministic Accessibility Dungeon verifier, infrastructure-pending behavior, one semantic correction, immutable accepted artifacts, terminal signed receipts, and exact-once D1 reputation projection.
- Added public receipt and issuer-key projections, complete reward evidence, recovery bonus allocation, reliability/timeliness deltas, and independent event-chain plus receipt-signature verification.
- Made every public mission input commit to a SHA-256 digest. Guildhall serves the immutable fixture bytes at the pact URL, and the contract, orchestrator, and verifier all require the exact bundled digest without fetching arbitrary URLs.
- Added a Durable Object retry deadline when a pact binds. Alarm re-entry resumes incomplete execution, reschedules transiently incomplete work, and consumes the retry after receipt issuance without duplicating events.

### Protocol and security review corrections

- Command idempotency hashes semantic evidence while excluding only the outer transport retry timestamp. Exact replay is checked before sequence- or state-dependent authorization so a valid retry survives later mission progress.
- Autonomous helpers refuse a candidate whose digest differs from their own signed proposal, including the protocol's deterministic selection-order resolution of divergent proposals.
- Only the exact public fixture URL, media type, and content digest may schedule autonomous demo execution; wrong-digest pacts bind normally but never enter an infinite runner retry loop.
- Replacement is two-phase: Warden first returns a signed exact-slot replacement proof; the coordinator binds it before Warden receives or completes the inherited work.
- Receipt issuance is atomic with its final event, and the receipt commits to the resulting event-chain head. Failed missions cannot receive positive success XP.
- The safety rejection is deliberately private and correctable rather than a public lifecycle mutation; only the sanitized field path and category are returned to the submitting agent/owner.
- A compromised local GitHub OAuth client secret was detected in the ignored `.dev.vars` during diagnostics. It is not tracked or documented and must be rotated before deployment.

### Verification

- `pnpm test:execution-e2e` passed the live WebMCP publication, autonomous A2A applications/negotiation/acceptance, two active slots, Scout artifact preservation, Scribe default, Warden replacement, verification, signed receipt, exact 100 + 10 reward, and replay idempotency.
- `pnpm test:verification` passed 12 deterministic verifier tests, including fixture-digest substitution rejection.
- `pnpm test:reputation` passed 9 pure scoring tests and 3 Workers/D1 projection tests.
- `pnpm check` passed every strict workspace typecheck and formatting check. The final scoped gates include 31 standard plus 2 Durable A2A tests and 9 Workers-runtime files / 36 protocol tests.

## 2026-08-26 — Build item 10: public guild and live mission chamber

### Implemented

- Rebuilt the signed-out Guildhall as an original tabletop-fantasy public experience: a quest board, ranked adventurer roster, owner gate, character/technical profile lens, protocol legend, and live mission chamber without proprietary game assets.
- Added public mission and agent catalog loading, deep-linkable mission/lens/replay state, resumable WebSocket event streaming, ordered event merge/deduplication, automatic reconnect, and polling fallback.
- Added deterministic replay controls, replay-gated work-slot transitions, explicit default-to-replacement storytelling, preserved Scout evidence, an inspectable technical ledger, and a reward chest that cannot unlock before the receipt event.
- Added a clearly labeled reference rehearsal for an empty deployment. It introduces Scout, Scribe, Warden, and the complete narrative while explicitly stating that it is not live ledger proof.
- Added responsive layouts, visible keyboard focus, semantic controls, reduced-motion behavior, public error recovery, compact numeric formatting, and mobile-safe mission/profile inspectors.

### Verification

- `pnpm test:ui` passed 2 tests covering the live work split, exact-slot replacement, preserved Scout artifact, and reconnect event deduplication.
- `pnpm test:replay` passed 3 tests covering deterministic slicing, narrative state, and receipt-gated reward visibility.
- The complete `pnpm check` gate passed 23 standard files / 196 tests and 9 Workers-runtime files / 36 tests, with all workspace typechecks and formatting checks green.
- `pnpm build` completed all Guildhall and independent Scout/Scribe/Warden production bundles.
- Chrome renders were inspected at 1440 px and an emulated 390 px touch viewport. The hero, empty quest board, reference party, chronicle, owner gate, navigation, and live chamber remained readable without horizontal clipping.

## 2026-08-26 — Build item 11: deployed live wow moment

### Production hardening

- Deployed Guildhall, Scout, Scribe, and Warden as independent Cloudflare Workers with production-only Ed25519 identities, scoped Guild Node credentials, D1 projections, Durable Object state, and Worker service bindings for same-zone traffic.
- Completed the exact GitHub OAuth callback flow and restored the authenticated browser-agent session without collecting model-provider credentials. The exposed OAuth secret found during local diagnostics was rotated before the accepted production run.
- Added safe, stage-specific autonomous-agent diagnostics; bounded same-zone A2A transport; explicit redirect rejection; repeat-safe rallying; and state-driven browser resume so a refresh continues an unfinished mission instead of publishing a duplicate.
- Added guarded production bootstrap, deployment doctor/preflight, deployed smoke test, environment template, and deployment runbook. Production private keys and OAuth credentials remain in Worker secrets or ignored local environment files.

### Live production proof

- Rodrigo launched the authenticated browser-agent flow for mission `53c86271-abe8-4352-a9f5-530927cc5aed` at `https://guildhall.kimetsu-dev.workers.dev/?mission=53c86271-abe8-4352-a9f5-530927cc5aed`.
- Scout and Scribe independently discovered the Guild Broker, applied over A2A, submitted capability bids, negotiated a two-round allocation, and signed the identical immutable pact digest `RchXRgWhZTq7az-ejYqjRR8cuaDLIsCLEU9yiKnnm0g` with the requester.
- Scout delivered the signed deterministic accessibility findings. Scribe then executed the planned post-bind default; Warden supplied a signed exact-slot replacement proof and completed the inherited remediation role without changing the pact digest or Scout's accepted artifact.
- Both verification criteria passed. Guildhall issued receipt `b895c8b6-1fd7-4ce9-9a10-26f65e96c849`, awarding 100 base points plus the 10-point recovery bonus. The receipt commits to the 27-event chain head and both signed artifact digests.
- The same completed chamber, technical ledger, artifacts, verification, replacement proof, and receipt are readable without authentication, supplying the signed-out spectator replay of the authenticated live run.

### Final gate

- `pnpm check` passed every workspace typecheck and formatting check, 25 standard test files / 201 tests, and 9 Workers-runtime protocol files / 36 tests.
- `pnpm build` produced the Guildhall client/Worker and all three independent agent bundles; every Wrangler dry-run included the expected D1, Durable Object, and Worker service bindings.
- `pnpm deploy:check` reported no pending production migrations and passed preflight for all four Workers.
- The deployed `pnpm demo:smoke` passed the public Guildhall shell/readiness, immutable fixture digest, issuer key, exact GitHub OAuth redirect, all three Agent Cards/readiness endpoints, and the provider-credential-free Guild Node MCP mission listing.
- Rodrigo explicitly accepted the completed live chamber and receipt. Verification pause C is accepted, and commit `d152888` is tagged `live-demo-candidate-v1` as the demo candidate.
