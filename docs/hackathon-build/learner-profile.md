# Learner Profile

## Participant

- Name: Rodrigo Cordoba
- Background: Software engineer with more than 15 years of coding experience and broad language and framework experience.
- What brought them to the hackathon: Interest in pushing WebMCP beyond page-local actions into ambitious, interoperable agent collaboration.

## Project Idea

- Initial idea: Build a technically serious WebMCP-to-A2A integration profile, an A2A Commitment extension, and a reusable TypeScript reference library. A browser agent publishes a bounded request and selects at most two A2A-compatible agents. Those agents negotiate and bind the scope, divide the work, agree where and how results will be delivered, complete and verify the task, then earn non-monetary points and reputation.
- Product surface: A Dungeons & Dragons-inspired adventurers' guild that makes the protocol legible and attractive. Agents appear as characters and collectible profiles; owners receive an RPG-style roster that also exposes technical capabilities, provenance, reliability, and affiliation such as "Guild: Google."
- Core priority: The backend protocols and rigorous implementation matter most. The game is the public demonstration layer, not the primary invention.

## Technical Experience

- Experience level: Advanced/expert; 15+ years.
- Languages/frameworks known: Broad and flexible; no language or framework constraint stated.
- AI coding tools used before: Codex, Claude Code, Pi.dev, and most other major AI coding agents.
- Prior experience planning before coding: Not explicitly stated; calibrate as an experienced builder and focus on architecture, tradeoffs, and delivery speed.

## Build Preferences

- Preferred pace: Fast, ambitious, and architecture-first.
- Likely support needs: Protocol design, scope discipline, interoperability boundaries, verification strategy, and translating backend mechanics into a memorable demo.
- Notes for downstream commands: Do not dilute the WebMCP/A2A implementation. Use one real browser agent through WebMCP and three deterministic A2A-compatible agents to avoid API-key dependencies while still implementing the protocol seriously. The primary users are agent builders and owners; spectators are the attraction layer. The most satisfying visual moment should be agents dividing the work and receiving rewards. The protocol and public game should have separate names.
- Execution policy: Decompose implementation into independently verifiable tasks with explicit file ownership, inputs, outputs, and acceptance checks. Use GPT-5.6 Terra at high reasoning as the default development model; GPT-5.6 Luna at high reasoning for small, bounded, repetitive, documentation, fixture, and isolated-test tasks; and GPT-5.6 Sol at high reasoning only for genuinely complex architecture, protocol correctness, security-sensitive design, cross-system integration, or debugging that fails the lower-tier acceptance checks. Escalate by evidence rather than by default.
