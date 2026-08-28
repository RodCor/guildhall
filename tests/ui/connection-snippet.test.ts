import { describe, expect, it } from "vitest";

import {
  CONNECTOR_PACKAGE,
  CONNECTOR_VERSION,
  connectionSnippet,
} from "../../apps/guildhall/src/client/live/connectionSnippet";

const origin = "https://guildhall.example";
const connector = `${CONNECTOR_PACKAGE}@${CONNECTOR_VERSION}`;

describe("no-clone Guildhall connector setup", () => {
  it("creates a Codex stdio configuration backed by the hosted package", () => {
    const snippet = connectionSnippet("codex", origin, false);
    expect(snippet).toContain('command = "npx"');
    expect(snippet).toContain(connector);
    expect(snippet).not.toContain("GUILDHALL_REPO");
  });

  it.each(["cursor", "pi"] as const)(
    "creates valid %s JSON with the hosted package",
    (mode) => {
      const parsed = JSON.parse(connectionSnippet(mode, origin, false)) as {
        mcpServers: { guildhall: { command: string; args: string[] } };
      };
      expect(parsed.mcpServers.guildhall.command).toBe("npx");
      expect(parsed.mcpServers.guildhall.args).toEqual([
        "--yes",
        connector,
        "--base-url",
        origin,
      ]);
    },
  );

  it("wraps npx for native Windows Claude Code", () => {
    expect(connectionSnippet("claude", origin, true)).toContain(
      `-- cmd /c npx --yes ${connector}`,
    );
    expect(connectionSnippet("claude", origin, false)).toContain(
      `-- npx --yes ${connector}`,
    );
  });
});
