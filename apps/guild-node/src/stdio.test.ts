import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { guildCapabilityManifest } from "@guildhall/capability-manifest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { writeNodeConfig } from "./config.js";
import { createGuildNodeIdentity, randomToken } from "./crypto.js";

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

  it("assigns trusted command provenance when a mutation omits commandId", async () => {
    const draftId = crypto.randomUUID();
    let createdMissionId: string | null = null;
    const publishedBodies: Record<string, unknown>[] = [];
    const http = createServer((request, response) => {
      void (async () => {
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST" && request.url === "/api/drafts") {
          const draft = await readJsonBody(request);
          const payload = draft.payload as Record<string, unknown> | undefined;
          createdMissionId =
            typeof payload?.missionId === "string" ? payload.missionId : null;
          response.end(JSON.stringify({ draftId }));
          return;
        }
        if (
          request.method === "POST" &&
          request.url === `/api/drafts/${draftId}/publish`
        ) {
          publishedBodies.push(await readJsonBody(request));
          response.end(JSON.stringify({ ok: true, resultingSequence: 1 }));
          return;
        }
        if (
          request.method === "GET" &&
          createdMissionId !== null &&
          request.url === `/api/missions/${createdMissionId}`
        ) {
          response.end(
            JSON.stringify({
              latestSequence: 1,
              snapshot: { missionVersion: 1, candidatePact: null },
              events: [{ displayState: "Recruiting" }],
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not-found" }));
      })().catch((error: unknown) => {
        response.statusCode = 500;
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
    await new Promise<void>((resolveListen) =>
      http.listen(0, "127.0.0.1", resolveListen),
    );
    const address = http.address();
    if (address === null || typeof address === "string") {
      throw new Error("Local test server did not bind a TCP port");
    }

    const temp = await mkdtemp(join(tmpdir(), "guildhall-node-mutation-test-"));
    temporaryDirectories.push(temp);
    const configPath = join(temp, "node.json");
    const identity = await createGuildNodeIdentity();
    await writeNodeConfig(
      {
        version: 1,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        agentId: crypto.randomUUID(),
        keyId: identity.keyId,
        credential: randomToken(),
        credentialId: crypto.randomUUID(),
        scopes: ["missions:read", "missions:write"],
        publicJwk: identity.publicJwk,
        privateJwk: identity.privateJwk,
        inboxCursor: null,
        pairedAt: new Date().toISOString(),
      },
      configPath,
    );
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = resolve(dirname(currentFile), "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(import.meta.resolve("tsx/cli")),
        resolve(packageRoot, "src/cli.ts"),
        "--base-url",
        `http://127.0.0.1:${String(address.port)}`,
        "--config",
        configPath,
      ],
      cwd: packageRoot,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const client = new Client({
      name: "guildhall-mutation-test-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "guild.publish_mission",
        arguments: {
          title: "Test trusted command provenance",
          goal: "Prove the MCP adapter assigns one command ID.",
          publicInputs: [
            {
              inputId: crypto.randomUUID(),
              type: "url",
              location: "https://example.com/public-fixture",
              mediaType: "text/html",
              contentDigest: "A".repeat(43),
            },
          ],
          requiredCapabilities: ["accessibility-audit"],
          minimumPartySize: 1,
          preferredPartySize: 1,
          maximumPartySize: 1,
          formationDeadline: "2026-09-01T12:00:00.000Z",
          deliveryDeadline: "2026-09-01T14:00:00.000Z",
          requiredOutputs: [
            {
              outputId: crypto.randomUUID(),
              type: "accessibility-findings",
              description: "Public findings.",
              mediaType: "application/json",
              publicLocation: "mission-artifact",
            },
          ],
          verificationCriteria: [
            {
              criterionId: crypto.randomUUID(),
              description: "Every finding has a stable rule.",
              required: true,
              method: "deterministic",
            },
          ],
          difficulty: "novice",
          pointReward: 10,
          failureBehavior: {
            negotiationTimeout: "reopen-recruitment",
            participantDefault: "recruit-exact-slot-replacement",
            replacementAuthorized: true,
            verificationCorrectionLimit: 1,
          },
        },
      });

      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        data: {
          missionId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          ),
          sequence: 1,
          displayState: "Recruiting",
        },
        provenance: {
          transport: "mcp",
          trusted: true,
          actionName: "guild.publish_mission",
          eventSequence: 1,
          commandId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          ),
        },
      });
      const structuredContent = response.structuredContent as Record<
        string,
        unknown
      >;
      const provenance = structuredContent.provenance as
        Record<string, unknown> | undefined;
      expect(publishedBodies).toHaveLength(1);
      expect(structuredContent.data).toMatchObject({
        missionId: createdMissionId,
      });
      expect(publishedBodies[0]?.commandId).toBe(provenance?.commandId);
      expect(stderr).toBe("");
    } finally {
      await client.close();
      await new Promise<void>((resolveClose, reject) =>
        http.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  }, 20_000);
});

async function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}
