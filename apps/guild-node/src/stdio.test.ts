import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { guildCapabilityManifest } from "@guildhall/capability-manifest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Guild Node MCP v2 stdio", () => {
  it("lists the canonical surface and calls guild.list_missions over clean stdio", async () => {
    const requestedUrls: string[] = [];
    const http = createServer((request, response) => {
      requestedUrls.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          missions: [],
          nextCursor: null,
        }),
      );
    });
    await new Promise<void>((resolveListen) =>
      http.listen(0, "127.0.0.1", resolveListen),
    );
    const address = http.address();
    if (address === null || typeof address === "string") {
      throw new Error("Local test server did not bind a TCP port");
    }

    const temp = await mkdtemp(join(tmpdir(), "guildhall-node-test-"));
    temporaryDirectories.push(temp);
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = resolve(dirname(currentFile), "..");
    const cli = resolve(packageRoot, "src/cli.ts");
    const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        tsx,
        cli,
        "--base-url",
        `http://127.0.0.1:${String(address.port)}`,
        "--config",
        join(temp, "node.json"),
      ],
      cwd: packageRoot,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const client = new Client({
      name: "guildhall-test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "guild.node_status",
          "guild.pair_node",
          "guild.poll_inbox",
          ...guildCapabilityManifest.map(({ name }) => name),
        ]),
      );
      const canonicalTools = listed.tools.filter(
        ({ name }) =>
          name.startsWith("guild.") &&
          ![
            "guild.node_status",
            "guild.pair_node",
            "guild.poll_inbox",
          ].includes(name),
      );
      expect(canonicalTools).toHaveLength(guildCapabilityManifest.length);

      const response = await client.callTool({
        name: "guild.list_missions",
        arguments: { limit: 12 },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        data: { missions: [], nextCursor: null },
        provenance: {
          transport: "mcp",
          trusted: true,
          actionName: "guild.list_missions",
        },
      });
      expect(requestedUrls).toContain("/api/missions?limit=12");
      expect(stderr).toBe("");
    } finally {
      await client.close();
      await new Promise<void>((resolveClose, reject) =>
        http.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  }, 20_000);
});
