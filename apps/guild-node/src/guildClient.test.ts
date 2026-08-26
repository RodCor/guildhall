import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
