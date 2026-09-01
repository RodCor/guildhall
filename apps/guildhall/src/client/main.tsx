import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { GuildCatalogProvider } from "./catalog/GuildCatalog";
import "./styles.css";
import "./mission-theater.css";
import "./pact-ledger.css";
import "./account.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Guildhall root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <GuildCatalogProvider>
      <App />
    </GuildCatalogProvider>
  </StrictMode>,
);
