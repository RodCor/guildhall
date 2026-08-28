import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = option("--base-url") ?? "http://127.0.0.1:8787";
const connector = option("--connector");
const currentFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(currentFile), "..");
const cli = resolve(packageRoot, "src/cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const connectorArguments = [
  "--yes",
  "--package",
  connector ?? "",
  "--",
  "guildhall-mcp",
  "--base-url",
  baseUrl,
];
const command =
  connector === undefined
    ? process.execPath
    : process.platform === "win32"
      ? "cmd.exe"
      : "npx";
const arguments_ =
  connector === undefined
    ? [tsx, cli, "--base-url", baseUrl]
    : process.platform === "win32"
      ? ["/d", "/s", "/c", "npx", ...connectorArguments]
      : connectorArguments;
const transport = new StdioClientTransport({
  command,
  args: arguments_,
  cwd: packageRoot,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk: Buffer) => {
  stderr += chunk.toString("utf8");
});

const client = new Client({
  name: "guildhall-live-smoke",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "guild.list_missions",
    arguments: { limit: 3 },
  });
  if (response.isError === true) {
    throw new Error(
      `guild.list_missions failed: ${JSON.stringify(response.content)}`,
    );
  }
  if (stderr.length > 0) {
    throw new Error(`Guild Node wrote to stderr: ${stderr}`);
  }
  process.stdout.write(
    `${JSON.stringify(response.structuredContent, null, 2)}\n`,
  );
} catch (error) {
  if (stderr.length > 0) process.stderr.write(stderr);
  throw error;
} finally {
  await client.close();
}
