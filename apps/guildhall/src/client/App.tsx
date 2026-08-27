import { useState } from "react";

import { OwnerGateway } from "./auth/OwnerGateway";
import { TechnicalMission } from "./mission/TechnicalMission";
import { GuildhallWebMcp } from "./webmcp/GuildhallWebMcp";

export function App() {
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#mission-chamber">
        Skip to live mission
      </a>
      <main>
        <TechnicalMission
          activeAgentId={activeAgentId}
          ownerControls={
            <div className="hud-owner-controls">
              <OwnerGateway onAgentChange={setActiveAgentId} />
              <GuildhallWebMcp activeAgentId={activeAgentId} />
            </div>
          }
        />
      </main>
    </div>
  );
}
