import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@guildhall/contracts";

import { readNodeConfig, writeNodeConfig } from "./config.js";
import { createGuildNodeIdentity, randomToken } from "./crypto.js";
import { GuildClient } from "./guildClient.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GuildClient", () => {
  it("signs inbox polling and advances its cursor only after success", async () => {
    const temp = await mkdtemp(join(tmpdir(), "guild-client-test-"));
    temporaryDirectories.push(temp);
    const configPath = join(temp, "node.json");
    const identity = await createGuildNodeIdentity();
    const agentId = crypto.randomUUID();
    await writeNodeConfig(
      {
        version: 1,
        baseUrl: "https://guildhall.example",
        agentId,
        keyId: identity.keyId,
        credential: randomToken(),
        credentialId: crypto.randomUUID(),
        scopes: ["missions:read"],
        publicJwk: identity.publicJwk,
        privateJwk: identity.privateJwk,
        inboxCursor: null,
        pairedAt: new Date().toISOString(),
      },
      configPath,
    );
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          `https://guildhall.example/api/agents/${agentId}/inbox`,
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toMatch(
          /^GuildNode [A-Za-z0-9_-]{43}$/u,
        );
        expect(headers.get("X-Guild-Key-Id")).toBe(identity.keyId);
        expect(headers.get("X-Guild-Nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(headers.get("X-Guild-Signature")).toMatch(
          /^[A-Za-z0-9_-]{86}$/u,
        );
        return Response.json({ missions: [], nextCursor: "cursor-1" });
      },
    );
    const client = new GuildClient({
      configPath,
      defaultBaseUrl: "https://guildhall.example",
      fetch: fetchMock,
    });

    await expect(client.pollInbox()).resolves.toEqual({
      missions: [],
      nextCursor: "cursor-1",
    });
    await expect(readNodeConfig(configPath)).resolves.toMatchObject({
      inboxCursor: "cursor-1",
    });
  });

  it("routes progress and complete signed artifacts through canonical commands", async () => {
    const temp = await mkdtemp(join(tmpdir(), "guild-client-command-test-"));
    temporaryDirectories.push(temp);
    const configPath = join(temp, "node.json");
    const identity = await createGuildNodeIdentity();
    const agentId = crypto.randomUUID();
    const missionId = crypto.randomUUID();
    const roleSlotId = crypto.randomUUID();
    const outputId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    const pactDigest = "P".repeat(43);
    const content = { findings: [{ ruleId: "button-name" }] };
    const contentDigest = await canonicalJsonDigest(content);
    await writeNodeConfig(
      {
        version: 1,
        baseUrl: "https://guildhall.example",
        agentId,
        keyId: identity.keyId,
        credential: randomToken(),
        credentialId: crypto.randomUUID(),
        scopes: ["missions:write"],
        publicJwk: identity.publicJwk,
        privateJwk: identity.privateJwk,
        inboxCursor: null,
        pairedAt: new Date().toISOString(),
      },
      configPath,
    );
    const postedCommands: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          expect(String(url)).toBe(
            `https://guildhall.example/api/missions/${missionId}/commands`,
          );
          postedCommands.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          return Response.json({ ok: true, resultingSequence: 8 });
        }
        return Response.json({
          latestSequence: 8,
          snapshot: { missionVersion: 1, candidatePact: null },
          events: [{ displayState: "Executing" }],
        });
      },
    );
    const client = new GuildClient({
      configPath,
      defaultBaseUrl: "https://guildhall.example",
      fetch: fetchMock,
    });

    await client.invoke("guild.report_progress", {
      commandId: crypto.randomUUID(),
      missionId,
      expectedSequence: 7,
      roleSlotId,
      status: "working",
      summary: "Mapping the dungeon.",
      completedOutputIds: [],
      occurredAt: "2026-08-26T14:00:00.000Z",
    });
    const artifactCommandId = crypto.randomUUID();
    const artifactInput = {
      commandId: artifactCommandId,
      missionId,
      expectedSequence: 7,
      roleSlotId,
      pactDigest,
      artifact: {
        artifactId,
        outputId,
        type: "accessibility-findings",
        mediaType: "application/json",
        contentDigest,
        publicLocation: "mission-artifact",
        content,
        dependencyArtifactIds: [],
        attempt: 1,
        completedAt: "2026-08-26T14:01:00.000Z",
      },
    };
    await client.invoke("guild.submit_artifact", artifactInput);
    await client.invoke("guild.submit_artifact", artifactInput);

    expect(postedCommands[0]).toMatchObject({
      command: { type: "report_progress", roleSlotId },
    });
    expect(postedCommands[1]).toMatchObject({
      commandId: artifactCommandId,
      command: {
        type: "submit_artifact",
        roleSlotId,
        artifact: {
          outputId,
          content,
          metadata: {
            artifactId,
            missionId,
            pactDigest,
            roleSlotId,
            producingAgentId: agentId,
            contentDigest,
            completedAt: "2026-08-26T14:01:00.000Z",
          },
        },
      },
    });
    const { issuedAt: firstIssuedAt, ...firstSemanticCommand } =
      postedCommands[1]!;
    const { issuedAt: retryIssuedAt, ...retrySemanticCommand } =
      postedCommands[2]!;
    expect(retrySemanticCommand).toEqual(firstSemanticCommand);
    expect(typeof firstIssuedAt).toBe("string");
    expect(typeof retryIssuedAt).toBe("string");
  });
});
