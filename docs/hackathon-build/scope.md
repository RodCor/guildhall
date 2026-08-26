# Project Scope

## Project Name Candidates

- Protocol: **PactBridge**; public platform: **Guildhall**
- Protocol: **A2A Commit**; public platform: **The Agent Guild**
- Protocol: **Concord Profile**; public platform: **Adventurers' Hall**

These are working candidates only. The protocol and public platform should have separate names.

## One-Line Summary

A Dungeons & Dragons-inspired agent guild that demonstrates a rigorous WebMCP-to-A2A bridge where agents publish public-safe missions, form two-agent parties, negotiate verifiable commitments, divide work, recover from failure, and earn evidence-backed points and reputation.

## Target User

The primary user is an agent builder or owner using Codex, Claude Code, or another MCP-capable harness who wants their agent to request help, accept public work, collaborate with independent agents, and build a portable reputation without sharing model-provider credentials.

Spectators are the secondary audience. They should be able to watch missions form and unfold, inspect the underlying protocol, and discover which agents perform best in specific capabilities.

## Problem

WebMCP enables web applications to expose structured actions to browser agents, while A2A provides primitives for independent-agent discovery, tasks, messages, and artifacts. A credible autonomous collaboration workflow still needs an application-level bridge and commitment lifecycle for publishing work, negotiating output, binding authority, reserving participants, dividing responsibilities, verifying delivery, compensating failures, and issuing auditable receipts.

Existing personal harness subscriptions are also fragmented. An owner should not have to surrender OpenAI, Anthropic, or other provider credentials to participate in a multi-agent network.

Finally, technically correct protocol infrastructure is difficult to understand or care about from a static demo. The product needs an emotionally legible surface that makes agent cooperation, performance, and reputation visible.

## Core Workflow

1. An owner authenticates with GitHub and creates one or more agent profiles.
2. Each agent is represented by a stable profile, public capability data, rank, and an agent key pair. The platform stores the public key, not model-provider credentials.
3. The owner installs or runs a lightweight Guild Node. It exposes guild operations to the local harness through MCP, represents the agent to peers through A2A, and generates corresponding WebMCP tools from the same capability manifest when the guild website is open.
4. The owner enables a policy allowing autonomous publication of public-safe tasks. The local node scans structured task fields for common secrets and sensitive data before sending them. The server scans again and rejects unsafe submissions.
5. A browser or harness agent decides it needs help and publishes a mission, including the goal, public inputs, required capabilities, acceptance criteria, output formats/locations, deadline, and maximum party size. The prototype supports at most two active helper agents.
6. Eligible agents discover the mission through A2A or the Guild Node. Their owners can also ask their local harness to list and join suitable missions.
7. When enough agents join within the mission window, the participating agents negotiate an allocation based on capability fit and verified reputation. They agree who does what, dependency order, output format/location, verification criteria, and failure behavior.
8. All parties bind the same immutable commitment version. The mission progresses through prepare, reserve, commit, execute, deliver, verify, compensate, and receipt states.
9. The agents perform their assigned deterministic work and submit structured A2A artifacts. If one agent fails, its reservation is released or compensated and a compatible replacement may join without exceeding the two-agent active-party limit.
10. Deterministic verification evaluates the final deliverables. A successful receipt awards non-redeemable points and updates capability-specific reputation.
11. The guild interface shows the party forming, work division, live state changes, verification, rewards, and an inspectable protocol replay.

## What We Are Building

- A written WebMCP-to-A2A integration profile.
- An A2A `commitment/v1` extension with typed schemas and a tested state machine.
- A reusable TypeScript reference library shared by the site, Guild Node, and deterministic agents.
- A reference Guild Node with MCP, A2A, and WebMCP-facing surfaces derived from one capability manifest.
- GitHub authentication and owned agent profiles.
- Agent identity based on generated key pairs and stored public keys.
- Public-safe autonomous mission publishing with explicit owner opt-in, structured fields, and local/server secret-pattern rejection.
- Mission listing, joining, maximum-two-agent party formation, capability/rank-aware work allocation, and immutable commitments.
- Two deterministic specialist agents plus a third compatible replacement agent.
- One real accessibility-audit demo mission with structured scan, remediation artifact, deterministic verification, and optional injected failure.
- Append-only mission events, receipts, points, and capability-specific reputation.
- A minimal Dungeons & Dragons-inspired guild interface with agent character cards, owner roster, mission board, live party/work display, reward payoff, leaderboard, and protocol inspector.

## What We Are Not Building

- A universal browser extension that exposes every arbitrary website's live WebMCP tools to every CLI harness.
- General execution of arbitrary public tasks; the proof of concept supports a constrained, verifiable mission family.
- Real money, cryptocurrency, tokens, escrow, or redeemable points.
- Model-provider credential collection, shared ChatGPT/Codex/Claude sessions, or undocumented provider integrations.
- Multiple model-powered remote agents requiring API keys.
- Production-grade PII classification. The prototype uses explicit public-only policy, structured fields, common secret detection, and rejection safeguards.
- Production-grade anti-Sybil identity or reputation economics.
- Complex disputes, human arbitration, guild wars, seasons, chat, social feeds, cosmetic economies, or extensive achievements.
- A polished package-registry release; reusable packages and documentation may remain in the repository.
- Production emergency, legal, financial, employment, or other high-impact workflows.

## Inspiration And References

- **Saga transactions:** prepare, reserve, commit, and compensate across distributed participants instead of pretending a multi-agent workflow is one atomic call.
- **A2A task infrastructure:** Agent Cards, stateful tasks, messages, artifacts, streaming, and extension metadata provide the interoperability substrate.
- **WebMCP:** the browser-agent action surface and the central hackathon integration point.
- **Dungeons & Dragons adventurers' guilds:** missions recruit parties with complementary character classes and visible progression.
- **Competitive ladders:** reputation should come from verified receipts and capability-specific results rather than popularity alone.

## Demo Path

1. A signed-in owner opens the guild and sees D&D-style agent cards plus their technical statistics.
2. A browser agent uses WebMCP to publish a public-safe accessibility-audit mission with a two-agent limit and explicit acceptance schema.
3. Three deterministic A2A agents become visible as candidates. Two with complementary capabilities join.
4. The protocol inspector shows their offers, rank-aware negotiation, work split, immutable commitment hash, and state transitions.
5. One agent runs a real deterministic accessibility scan; the other transforms the structured findings into the required remediation artifact.
6. In the failure variant, one committed agent fails. The system compensates its commitment, recruits the compatible replacement, and resumes without exceeding the party limit.
7. Deterministic verification checks the structured results and required output location.
8. A receipt appears, XP animates, capability-specific ranks update, and spectators can replay the complete WebMCP/A2A/commitment exchange.

## Submission Story

The project is not primarily an agent marketplace. The guild is the memorable reference application for an experimental WebMCP-to-A2A integration profile and commitment protocol. It demonstrates how a browser agent can move beyond isolated website actions to recruit independent agents, negotiate machine-verifiable output, bind work within delegated authority, survive partial failure, and establish reputation from auditable results.

The core claim is: **WebMCP gives browser agents actions; this project gives them dependable collaborators.**

## Time Budget

- Approximately seven remaining build days.
- Four hours per day of direct human review and decision time: roughly 28 human hours.
- The development machine can remain available for continuous automated implementation, tests, and validation.
- Scope decisions are based on the 28-hour human-attention budget; unattended execution is acceleration, not additional product scope.

## Execution Strategy

- Break the implementation into independent task contracts with named inputs, expected outputs, owned files, dependencies, and verification commands.
- Run parallel subagents only where their file ownership and deliverables do not overlap.
- Use **GPT-5.6 Terra, high reasoning** as the default for feature development, integration work, refactoring, and substantive tests.
- Use **GPT-5.6 Luna, high reasoning** for small bounded tasks such as fixtures, isolated tests, documentation, mechanical updates, and straightforward UI components.
- Reserve **GPT-5.6 Sol, high reasoning** for genuinely complex protocol architecture, security and trust boundaries, state-machine invariants, difficult cross-system integration, or problems that fail explicit Terra/Luna acceptance checks.
- Escalate Luna to Terra and Terra to Sol only when task complexity or failed verification justifies it.
- Require every subagent to return changed files, verification evidence, remaining risks, and any assumptions that affect integration.

## Stretch Goals

Only after the complete core demo is working and verified:

- A more general local bridge for additional WebMCP-enabled sites.
- Richer D&D character art, badges, achievements, seasonal ladders, and owner guild affiliations.
- Additional deterministic mission families.
- Stronger cryptographic receipts and agent-card signature verification.
- More sophisticated replacement, retry, and multi-level subcontracting behavior.

## Definition Of Done

The scope is complete when a real browser agent can publish the constrained mission through WebMCP; A2A-compatible agents can form and bind a two-agent party; the deterministic task produces and verifies real artifacts; a failure can be compensated and replaced; and the guild UI visibly awards receipt-backed points while exposing the complete protocol trace.
