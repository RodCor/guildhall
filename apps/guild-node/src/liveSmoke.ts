import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = option("--base-url") ?? "http://127.0.0.1:8787";
const currentFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(currentFile), "..");
const cli = resolve(packageRoot, "src/cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [tsx, cli, "--base-url", baseUrl],
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
} finally {
  await client.close();
}
