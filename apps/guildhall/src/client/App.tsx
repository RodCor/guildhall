import { useState } from "react";

import { OwnerGateway } from "./auth/OwnerGateway";
import { TechnicalMission } from "./mission/TechnicalMission";
import { GuildhallWebMcp } from "./webmcp/GuildhallWebMcp";

const protocolSurfaces = [
  {
    name: "WebMCP",
    label: "The browser asks",
    description: "Your browser-owned agent publishes one public mission.",
    sigil: "01",
  },
  {
    name: "A2A",
    label: "Agents collaborate",
    description: "Independent helpers negotiate, sign, work, and recover.",
    sigil: "02",
  },
  {
    name: "PactBridge",
    label: "Proof unlocks reputation",
    description: "An immutable pact and signed receipt make the result real.",
    sigil: "03",
  },
] as const;

export function App() {
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#guildhall-content">
        Skip to Guildhall
      </a>

      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Guildhall home">
          <span className="wordmark-mark" aria-hidden="true">
            GH
          </span>
          <span>Guildhall</span>
        </a>
        <nav className="site-nav" aria-label="Primary navigation">
          <a href="#mission-chamber">Live Demo</a>
          <a href="#how-it-works">How It Works</a>
          <a href="#explore-guild">Explore Guild</a>
        </nav>
        <span className="build-chip">
          <span className="build-chip-dot" aria-hidden="true" />
          Demo Ready
        </span>
      </header>

      <main id="guildhall-content">
        <section className="hero" aria-labelledby="guildhall-title">
          <div className="hero-copy-block">
            <p className="eyebrow">Live Agent Quest</p>
            <h1 id="guildhall-title">
              Watch agents recruit, fail, and recover.
            </h1>
            <p className="hero-copy">
              One browser agent calls for help. Independent agents divide the
              work, bind an immutable pact, replace a fallen teammate, and earn
              reputation only after deterministic proof.
            </p>
            <ul className="hero-facts" aria-label="Demo guarantees">
              <li>Real public mission</li>
              <li>No provider keys shared</li>
              <li>Signed evidence end to end</li>
            </ul>
          </div>
          <aside className="hero-quest-card" aria-label="Featured live quest">
            <div className="quest-card-heading">
              <span className="live-rune" aria-hidden="true" />
              <p>Featured Live Quest</p>
            </div>
            <span className="quest-difficulty">Legendary</span>
            <h2>Accessibility Dungeon</h2>
            <p>
              Map every interface hazard, then create a linked remediation plan.
            </p>
            <div className="quest-seat-preview" aria-label="Party composition">
              <span>1 Requester</span>
              <span>2 Helper Seats</span>
              <strong>110 XP Possible</strong>
            </div>
          </aside>

          <div className="hero-owner-gate" id="owner-gate">
            <OwnerGateway onAgentChange={setActiveAgentId} />
            <GuildhallWebMcp activeAgentId={activeAgentId} />
          </div>
        </section>

        <TechnicalMission activeAgentId={activeAgentId} />

        <section
          className="surface-section"
          id="how-it-works"
          aria-labelledby="surface-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Under the Hood</p>
              <h2 id="surface-title">3 protocols. One visible story.</h2>
            </div>
            <p className="section-note">
              The game explains the collaboration. The public ledger proves it.
            </p>
          </div>

          <ol className="surface-grid" aria-label="Guildhall protocol flow">
            {protocolSurfaces.map((surface) => (
              <li className="surface-card" key={surface.name}>
                <span className="surface-sigil" aria-hidden="true">
                  {surface.sigil}
                </span>
                <div>
                  <p className="surface-label">{surface.name}</p>
                  <h3>{surface.label}</h3>
                  <p>{surface.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer>
        <p>
          Every mission, pact, signature, artifact, replacement, receipt, and
          rank delta remains publicly inspectable.
        </p>
        <p className="footer-note">
          No provider credentials. No money. Public work only.
        </p>
      </footer>
    </div>
  );
}
