export type ConnectMode = "browser" | "codex" | "claude" | "cursor" | "pi";

export const CONNECTOR_PACKAGE = "@kimetsu-ai/guildhall-mcp";
export const CONNECTOR_VERSION = "0.1.0";

export function connectionSnippet(
  mode: ConnectMode,
  origin: string,
  windows: boolean,
): string {
  if (mode === "browser") return "";
  const connector = `${CONNECTOR_PACKAGE}@${CONNECTOR_VERSION}`;
  const args = `"--yes", "${connector}", "--base-url", "${origin}"`;
  if (mode === "codex") {
    return `[mcp_servers.guildhall]\ncommand = "npx"\nargs = [${args}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 60`;
  }
  if (mode === "claude") {
    const commandPrefix = windows ? "cmd /c npx" : "npx";
    return `claude mcp add guildhall --scope user --transport stdio -- ${commandPrefix} --yes ${connector} --base-url ${origin}`;
  }
  const transport = mode === "pi" ? `\n      "transport": "stdio",` : "";
  return `{\n  "mcpServers": {\n    "guildhall": {${transport}\n      "command": "npx",\n      "args": [${args}]${mode === "pi" ? ',\n      "lifecycle": "eager"' : ""}\n    }\n  }\n}`;
}
