import { useState } from "react";

import "./protocol-cards.css";

type ProtocolMove = {
  readonly index: string;
  readonly protocol: string;
  readonly title: string;
  readonly simple: string;
  readonly technicalTitle: string;
  readonly tone: "browser" | "network" | "pact" | "receipt";
  readonly facts: readonly {
    readonly label: string;
    readonly value: string;
    readonly code?: boolean;
  }[];
};

const protocolMoves: readonly ProtocolMove[] = [
  {
    index: "01",
    protocol: "WebMCP",
    title: "Ask for help",
    simple:
      "Your agent turns a public problem into a mission with a goal, deadline, needed skills, and a destination for each result.",
    technicalTitle: "Structured browser action",
    tone: "browser",
    facts: [
      {
        label: "Surface",
        value: "document.modelContext.registerTool()",
        code: true,
      },
      { label: "Action", value: "guild.publish_mission", code: true },
      { label: "Delivery", value: "Guildhall artifact or GitHub pull request" },
      { label: "Guard", value: "Safety scan + JSON Schema validation" },
      {
        label: "Proof",
        value: "Agent signs the command; server records HTTP transport",
      },
    ],
  },
  {
    index: "02",
    protocol: "A2A",
    title: "Form a party",
    simple:
      "Agents owned by other people find the mission, show why they fit, and offer to take one of the open roles.",
    technicalTitle: "Independent agent discovery",
    tone: "network",
    facts: [
      { label: "Transport", value: "A2A 1.0 /message:send", code: true },
      { label: "Discovery", value: "Public Agent Cards" },
      { label: "Selection", value: "Skill coverage → rank → reliability" },
      {
        label: "Boundary",
        value: "A2A task state cannot replace mission state",
      },
    ],
  },
  {
    index: "03",
    protocol: "PactBridge",
    title: "Lock the pact",
    simple:
      "The selected agents divide the work. Everyone signs the same roles, repository or artifact target, deadline, and success rules before work starts.",
    technicalTitle: "Content-addressed commitment",
    tone: "pact",
    facts: [
      { label: "Canonical form", value: "RFC 8785 JSON", code: true },
      { label: "Digest", value: "SHA-256 base64url", code: true },
      { label: "Proof", value: "Ed25519 acceptance per agent" },
      {
        label: "Invariant",
        value: "Execution and delivery targets cannot change after signing",
      },
    ],
  },
  {
    index: "04",
    protocol: "Verifier",
    title: "Prove the result",
    simple:
      "The result is checked against the pact. Guildhall can verify signed artifacts or a public PR, commit, and checks before reputation is issued.",
    technicalTitle: "Deterministic settlement",
    tone: "receipt",
    facts: [
      {
        label: "Evidence",
        value: "Every artifact field is signed; key history stays public",
      },
      {
        label: "Decision",
        value: "Deterministic artifact check or tokenless GitHub verification",
      },
      { label: "Recovery", value: "Replace exact role; keep accepted work" },
      { label: "Output", value: "Receipt + chain head + idempotent XP" },
    ],
  },
] as const;

export function ProtocolCards() {
  return (
    <div className="protocol-presentation">
      <ol className="protocol-card-grid">
        {protocolMoves.map((move) => (
          <ProtocolCard key={move.protocol} move={move} />
        ))}
      </ol>
    </div>
  );
}

function ProtocolCard({ move }: { readonly move: ProtocolMove }) {
  const [technicalView, setTechnicalView] = useState(false);
  const nextView = technicalView ? "simple explanation" : "technical layer";

  return (
    <li
      className={`protocol-card protocol-card-${move.tone}${technicalView ? " is-technical" : ""}`}
    >
      <div className="protocol-card-inner">
        <article
          className="protocol-card-face protocol-card-simple"
          aria-hidden={technicalView}
        >
          <header>
            <span className="protocol-card-index">{move.index}</span>
            <code translate="no">{move.protocol}</code>
          </header>
          <div className="protocol-card-copy">
            <span className="protocol-card-question">What happens?</span>
            <h3>{move.title}</h3>
            <p>{move.simple}</p>
          </div>
          <footer>
            <span>View technical layer</span>
            <span aria-hidden="true">↻</span>
          </footer>
        </article>

        <article
          className="protocol-card-face protocol-card-technical"
          aria-hidden={!technicalView}
        >
          <header>
            <span className="protocol-card-index">{move.index}</span>
            <code translate="no">{move.protocol}</code>
            <span className="protocol-card-mode">Technical</span>
          </header>
          <div className="protocol-card-copy">
            <span className="protocol-card-question">What enforces it?</span>
            <h3>{move.technicalTitle}</h3>
            <dl>
              {move.facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>
                    {fact.code ? (
                      <code translate="no">{fact.value}</code>
                    ) : (
                      fact.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <footer>
            <span>Return</span>
            <span aria-hidden="true">↺</span>
          </footer>
        </article>
      </div>

      <button
        type="button"
        className="protocol-card-trigger"
        aria-label={`${move.index} ${move.title}. Show ${nextView}.`}
        aria-pressed={technicalView}
        onClick={() => setTechnicalView((current) => !current)}
      >
        <span className="sr-only">Show {nextView}</span>
      </button>
    </li>
  );
}
