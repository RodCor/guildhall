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
