import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pairGuildNode } from "./pairing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Guild Node pairing", () => {
  it("binds proof to the server challenge and persists no provider credential", async () => {
    const temp = await mkdtemp(join(tmpdir(), "guildhall-pairing-test-"));
    temporaryDirectories.push(temp);
    const configPath = join(temp, "guild-node.json");
    const agentId = crypto.randomUUID();
    const challenge = `GUILDHALL-PAIRING-V1\n${agentId}\n${"n".repeat(43)}`;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.code).toBe("c".repeat(43));
        expect(body.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(body.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
        expect(body).not.toHaveProperty("openaiApiKey");
        expect(body).not.toHaveProperty("anthropicApiKey");
        const key = body.key as { keyId: string };
        return Response.json(
          {
            paired: true,
            agentId,
            keyId: key.keyId,
            credentialId: crypto.randomUUID(),
            scopes: ["missions:read", "missions:write", "artifacts:write"],
          },
          { status: 201 },
        );
      },
    );

    const result = await pairGuildNode({
      baseUrl: "https://guildhall.example",
      code: "c".repeat(43),
      challenge,
      configPath,
      fetch: fetchMock,
    });
    expect(result).toMatchObject({ paired: true, agentId });
    const persisted = await readFile(configPath, "utf8");
    expect(persisted).toContain('"privateJwk"');
    expect(persisted).not.toMatch(/openai|anthropic|claude|codex/iu);
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });
});
