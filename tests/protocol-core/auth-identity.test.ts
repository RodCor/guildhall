import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  deriveEd25519KeyId,
  encodeBase64Url,
  randomBase64UrlToken,
} from "../../apps/guildhall/src/worker/auth/crypto";
import { handleOAuthRoute } from "../../apps/guildhall/src/worker/auth/oauth";
import { getHistoricalPairingProof } from "../../apps/guildhall/src/worker/repositories";
import { createAgentRequestSignatureMessage } from "../../packages/trust-engine/src";
import {
  commandBodyHash,
  commandSigningBytes,
  pactSigningBytes,
} from "../../packages/contracts/src";

const worker = (exports as unknown as { default: Fetcher }).default;

describe("GitHub ownership and Guild Node identity", () => {
  it("completes mocked PKCE login and rejects a tampered state generically", async () => {
    const started = await startOAuth();
    const authorization = new URL(started.headers.get("Location")!);
    const state = authorization.searchParams.get("state")!;
    const challenge = authorization.searchParams.get("code_challenge")!;
    expect(authorization.origin).toBe("https://github.test");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(challenge).toHaveLength(43);
    const flowCookie = setCookieLines(started).join("\n");
    expect(flowCookie).toContain("__Host-guild_flow=");
    expect(flowCookie).toContain("HttpOnly");
    expect(flowCookie).toContain("Secure");
    expect(flowCookie).toContain("SameSite=Lax");

    let exchangeInput:
      { code: string; codeVerifier: string; redirectUri: string } | undefined;
    const callback = await handleOAuthRoute(
      new Request(
        `https://guildhall.test/api/auth/github/callback?code=mock-code&state=${state}`,
        { headers: { Cookie: cookieHeader(started, "__Host-guild_flow") } },
      ),
      env,
      {
        exchangeCode: async (_runtime, input) => {
          exchangeInput = input;
          return {
            githubUserId: 7301,
            login: "oauth-test-owner",
            avatarUrl: "https://avatars.example.test/owner.png",
          };
        },
      },
    );
    expect(callback?.status).toBe(302);
    expect(exchangeInput).toMatchObject({
      code: "mock-code",
      redirectUri: "https://guildhall.test/api/auth/github/callback",
    });
    expect(exchangeInput?.codeVerifier).toHaveLength(43);
    const sessionToken = cookieValue(callback!, "__Host-guild_session");
    const csrfToken = cookieValue(callback!, "__Host-guild_csrf");
    expect(sessionToken).toHaveLength(43);
    expect(csrfToken).toHaveLength(43);

    const session = await worker.fetch("https://guildhall.test/api/session", {
      headers: {
        Cookie: `__Host-guild_session=${sessionToken}; __Host-guild_csrf=${csrfToken}`,
      },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      owner: { githubUserId: 7301, login: "oauth-test-owner" },
    });
    const owner = await env.GUILD_DB.prepare(
      "SELECT github_user_id, github_login, github_avatar_url FROM owners",
    ).first<{
      github_user_id: number;
      github_login: string;
      github_avatar_url: string;
    }>();
    expect(owner).toEqual({
      github_user_id: 7301,
      github_login: "oauth-test-owner",
      github_avatar_url: "https://avatars.example.test/owner.png",
    });
    const columns = await env.GUILD_DB.prepare(
      "PRAGMA table_info(owners)",
    ).all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      "owner_id",
      "github_user_id",
      "github_login",
      "github_avatar_url",
      "created_at",
      "updated_at",
    ]);

    const tamperedStart = await startOAuth();
    const tamperedLocation = new URL(tamperedStart.headers.get("Location")!);
    const suppliedState = `${tamperedLocation.searchParams.get("state")}tampered`;
    let exchangeCalled = false;
    const failed = await handleOAuthRoute(
      new Request(
        `https://guildhall.test/api/auth/github/callback?code=visible-code&state=${suppliedState}`,
        {
          headers: {
            Cookie: cookieHeader(tamperedStart, "__Host-guild_flow"),
          },
        },
      ),
      env,
      {
        exchangeCode: async () => {
          exchangeCalled = true;
          throw new Error("must not run");
        },
      },
    );
    expect(failed?.status).toBe(400);
    const failureText = await failed!.text();
    expect(failureText).toContain("OAUTH_FLOW_FAILED");
    expect(failureText).not.toContain(suppliedState);
    expect(failureText).not.toContain("visible-code");
    expect(exchangeCalled).toBe(false);
  });

  it("enforces CSRF, one-time pairing, autonomy, revocation, and signout", async () => {
    const owner = await loginOwner(7302, "identity-owner");
    const browserPair = await ed25519Pair();
    const browserJwk = await crypto.subtle.exportKey(
      "jwk",
      browserPair.publicKey,
    );
    const browserKeyId = await deriveEd25519KeyId("browser", browserJwk);
    const agentBody = JSON.stringify({
      slug: "identity-ranger",
      characterName: "Identity Ranger",
      characterClass: "Ranger",
      technicalName: "Guild Node Test Harness",
      guildName: "Guildhall Tests",
      publicBio: "Proves scoped transport and signing identities.",
      key: {
        keyId: browserKeyId,
        publicJwk: browserJwk,
        source: "browser",
      },
    });

    const missingOrigin = await worker.fetch(
      "https://guildhall.test/api/agents",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "X-Guild-CSRF": owner.csrfToken,
        },
        body: agentBody,
      },
    );
    expect(missingOrigin.status).toBe(403);

    const metadataMatch = `sk-proj-${"M".repeat(28)}`;
    const unsafeMetadata = await worker.fetch(
      "https://guildhall.test/api/agents",
      {
        method: "POST",
        headers: owner.headers,
        body: JSON.stringify({
          slug: "unsafe-key-metadata",
          characterName: "Unsafe Key",
          characterClass: "Rogue",
          technicalName: "Metadata Boundary Test",
          guildName: "Guildhall Tests",
          publicBio: "Must never cross the safety gate.",
          key: {
            keyId: browserKeyId,
            publicJwk: { ...browserJwk, kid: metadataMatch },
            source: "browser",
          },
        }),
      },
    );
    expect(unsafeMetadata.status).toBe(422);
    expect(await unsafeMetadata.text()).not.toContain(metadataMatch);

    const created = await worker.fetch("https://guildhall.test/api/agents", {
      method: "POST",
      headers: owner.headers,
      body: agentBody,
    });
    expect(created.status).toBe(201);
    const agent = (await created.json()) as {
      agentId: string;
      autonomy: { enabled: boolean; version: number };
    };
    expect(agent.autonomy).toEqual({ enabled: false, version: 1 });

    const secondBrowserPair = await ed25519Pair();
    const secondBrowserJwk = await crypto.subtle.exportKey(
      "jwk",
      secondBrowserPair.publicKey,
    );
    const secondBrowserKeyId = await deriveEd25519KeyId(
      "browser",
      secondBrowserJwk,
    );
    const secondAgentCreated = await worker.fetch(
      "https://guildhall.test/api/agents",
      {
        method: "POST",
        headers: owner.headers,
        body: JSON.stringify({
          slug: "protocol-scribe",
          characterName: "Protocol Scribe",
          characterClass: "Artificer",
          technicalName: "Second Browser Agent",
          guildName: "Guildhall Tests",
          publicBio: "A distinct browser-owned signing identity.",
          key: {
            keyId: secondBrowserKeyId,
            publicJwk: secondBrowserJwk,
            source: "browser",
          },
        }),
      },
    );
    expect(secondAgentCreated.status).toBe(201);
    const secondAgent = (await secondAgentCreated.json()) as {
      agentId: string;
      keyId: string;
    };
    expect(secondAgent.agentId).not.toBe(agent.agentId);
    expect(secondAgent.keyId).toBe(secondBrowserKeyId);

    const twoAgentSession = await worker.fetch(
      "https://guildhall.test/api/session",
      { headers: { Cookie: owner.cookie } },
    );
    expect(twoAgentSession.status).toBe(200);
    expect(await twoAgentSession.json()).toMatchObject({
      authenticated: true,
      agents: [
        {
          agentId: agent.agentId,
          slug: "identity-ranger",
          characterName: "Identity Ranger",
          characterClass: "Ranger",
          technicalName: "Guild Node Test Harness",
          keyId: browserKeyId,
        },
        {
          agentId: secondAgent.agentId,
          slug: "protocol-scribe",
          characterName: "Protocol Scribe",
          keyId: secondBrowserKeyId,
        },
      ],
    });

    const updatedProfile = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}`,
      {
        method: "PATCH",
        headers: owner.headers,
        body: JSON.stringify({
          slug: "identity-ranger-edited",
          characterName: "Identity Ranger Prime",
          characterClass: "Ranger",
          technicalName: "Edited Browser Agent",
          guildName: "Guildhall Tests",
          publicBio: "An owner-edited public agent profile.",
        }),
      },
    );
    expect(updatedProfile.status).toBe(200);
    expect(await updatedProfile.json()).toMatchObject({
      agentId: agent.agentId,
      slug: "identity-ranger-edited",
      characterName: "Identity Ranger Prime",
      technicalName: "Edited Browser Agent",
      keyId: browserKeyId,
    });

    const duplicateHandle = await worker.fetch(
      `https://guildhall.test/api/agents/${secondAgent.agentId}`,
      {
        method: "PATCH",
        headers: owner.headers,
        body: JSON.stringify({
          slug: "identity-ranger-edited",
          characterName: "Protocol Scribe",
          characterClass: "Artificer",
          technicalName: "Second Browser Agent",
          guildName: "Guildhall Tests",
          publicBio: "A distinct browser-owned signing identity.",
        }),
      },
    );
    expect(duplicateHandle.status).toBe(409);
    expect(await duplicateHandle.json()).toMatchObject({
      error: "PROFILE_HANDLE_TAKEN",
    });

    const otherOwner = await loginOwner(7303, "other-profile-owner");
    const crossOwnerEdit = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}`,
      {
        method: "PATCH",
        headers: otherOwner.headers,
        body: JSON.stringify({
          slug: "stolen-profile",
          characterName: "Stolen Profile",
          characterClass: "Rogue",
          technicalName: "Unauthorized Browser Agent",
          guildName: "Other Guild",
          publicBio: "This mutation must not cross the owner boundary.",
        }),
      },
    );
    expect(crossOwnerEdit.status).toBe(404);

    const pairingStart = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}/pairing`,
      { method: "POST", headers: owner.headers, body: "{}" },
    );
    expect(pairingStart.status).toBe(201);
    const pairing = (await pairingStart.json()) as {
      code: string;
      challenge: string;
    };
    const nodePair = await ed25519Pair();
    const nodeJwk = await crypto.subtle.exportKey("jwk", nodePair.publicKey);
    const nodeKeyId = await deriveEd25519KeyId("guild-node", nodeJwk);
    const nodeCredential = randomBase64UrlToken();
    const possessionSignature = await sign(
      nodePair.privateKey,
      pairing.challenge,
    );
    const pairingBody = JSON.stringify({
      code: pairing.code,
      credential: nodeCredential,
      signature: possessionSignature,
      key: { keyId: nodeKeyId, publicJwk: nodeJwk, source: "guild-node" },
    });
    const paired = await worker.fetch(
      "https://guildhall.test/api/pairings/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pairingBody,
      },
    );
    expect(paired.status).toBe(201);
    expect(await paired.json()).toMatchObject({
      paired: true,
      agentId: agent.agentId,
      keyId: nodeKeyId,
      scopes: ["missions:read", "missions:write", "artifacts:write"],
    });
    const replay = await worker.fetch(
      "https://guildhall.test/api/pairings/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pairingBody,
      },
    );
    expect(replay.status).toBe(403);
    expect(await replay.text()).toContain("PAIRING_FAILED");
    const historicalBefore = await getHistoricalPairingProof(
      env.GUILD_DB,
      nodeKeyId,
    );
    expect(historicalBefore).toMatchObject({
      agentId: agent.agentId,
      keyId: nodeKeyId,
      challenge: pairing.challenge,
      signature: possessionSignature,
    });
    expect(historicalBefore?.proofDigest).toHaveLength(43);

    const firstMissionId = crypto.randomUUID();
    expect(
      await signedNodeRequest({
        url: `/api/missions/${firstMissionId}`,
        body: { requesterAgentId: agent.agentId },
        credential: nodeCredential,
        keyId: nodeKeyId,
        privateKey: nodePair.privateKey,
      }),
    ).toHaveProperty("status", 201);
    const replayedMutation = {
      url: `/api/missions/${crypto.randomUUID()}`,
      body: { requesterAgentId: agent.agentId },
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
      nonce: randomBase64UrlToken(),
      issuedAt: new Date().toISOString(),
    } as const;
    expect((await signedNodeRequest(replayedMutation)).status).toBe(201);
    expect((await signedNodeRequest(replayedMutation)).status).toBe(403);
    const blockedWithOtherActiveKey = await signedNodeRequest({
      url: `/api/missions/${crypto.randomUUID()}`,
      body: { requesterAgentId: agent.agentId },
      credential: nodeCredential,
      keyId: browserKeyId,
      privateKey: browserPair.privateKey,
    });
    expect(blockedWithOtherActiveKey.status).toBe(403);
    const disabledPublish = await publishFromNode(
      firstMissionId,
      agent.agentId,
      nodeCredential,
      nodeKeyId,
      nodePair.privateKey,
    );
    expect(disabledPublish.status).toBe(403);

    const enable = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}/autonomy`,
      {
        method: "PUT",
        headers: owner.headers,
        body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
      },
    );
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({
      policy: { enabled: true, version: 2 },
    });
    const enabledPublish = await publishFromNode(
      firstMissionId,
      agent.agentId,
      nodeCredential,
      nodeKeyId,
      nodePair.privateKey,
    );
    expect(enabledPublish.status).toBe(200);
    const publicMission = await worker.fetch(
      `https://guildhall.test/api/missions/${firstMissionId}`,
    );
    const publicSnapshot = (await publicMission.json()) as {
      events: Array<{
        actor: { ownerId: string; agentId: string; keyId: string } | null;
        source: string;
      }>;
    };
    expect(publicSnapshot.events[0]?.actor).toEqual({
      ownerId: "github:7302",
      agentId: agent.agentId,
      keyId: nodeKeyId,
    });
    expect(publicSnapshot.events[0]?.source).toBe("mcp");
    const proofDigest = "Q".repeat(43);
    const pactSignature = await sign(
      nodePair.privateKey,
      pactSigningBytes(proofDigest),
    );
    const acceptanceBody = await withNodeCommandProof(
      firstMissionId,
      nodeKeyId,
      nodePair.privateKey,
      {
        commandId: crypto.randomUUID(),
        expectedSequence: 1,
        actor: { agentId: agent.agentId, keyId: nodeKeyId },
        source: "mcp",
        issuedAt: new Date().toISOString(),
        command: {
          type: "accept_pact",
          acceptanceId: crypto.randomUUID(),
          agentId: agent.agentId,
          keyId: nodeKeyId,
          pactVersion: 1,
          pactDigest: proofDigest,
          signature: pactSignature,
          acceptedAt: new Date().toISOString(),
        },
      } as const,
    );
    const validProofWrongStage = await signedNodeRequest({
      url: `/api/missions/${firstMissionId}/commands`,
      body: acceptanceBody,
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(validProofWrongStage.status).toBe(422);
    const tamperedProof = await signedNodeRequest({
      url: `/api/missions/${firstMissionId}/commands`,
      body: {
        ...acceptanceBody,
        commandId: crypto.randomUUID(),
        command: {
          ...acceptanceBody.command,
          acceptanceId: crypto.randomUUID(),
          signature: `${pactSignature.slice(0, -1)}${pactSignature.endsWith("A") ? "B" : "A"}`,
        },
      },
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(tamperedProof.status).toBe(403);

    const staleIssuedAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    const staleProof = await signedNodeRequest({
      url: `/api/missions/${firstMissionId}/commands`,
      body: await withNodeCommandProof(
        firstMissionId,
        nodeKeyId,
        nodePair.privateKey,
        {
          ...acceptanceBody,
          commandId: crypto.randomUUID(),
          issuedAt: staleIssuedAt,
        },
      ),
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(staleProof.status).toBe(403);

    const victimAgentId = crypto.randomUUID();
    const deputyAttempt = await signedNodeRequest({
      url: `/api/missions/${firstMissionId}/commands`,
      body: await withNodeCommandProof(
        firstMissionId,
        nodeKeyId,
        nodePair.privateKey,
        {
          commandId: crypto.randomUUID(),
          expectedSequence: 1,
          actor: { agentId: agent.agentId, keyId: nodeKeyId },
          source: "mcp",
          issuedAt: new Date().toISOString(),
          command: {
            type: "apply",
            agentId: victimAgentId,
            keyId: nodeKeyId,
            missionVersion: 1,
            relevantCapabilities: ["accessibility-audit"],
            proposedContribution: "Attempt to act as another agent.",
            availability: {
              availableFrom: "2026-08-26T12:00:00.000Z",
              availableUntil: "2026-08-27T12:00:00.000Z",
            },
          },
        },
      ),
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(deputyAttempt.status).toBe(403);
    const publicCommandMatch = `sk-proj-${"P".repeat(28)}`;
    const unsafeCommand = await signedNodeRequest({
      url: `/api/missions/${firstMissionId}/commands`,
      body: await withNodeCommandProof(
        firstMissionId,
        nodeKeyId,
        nodePair.privateKey,
        {
          commandId: crypto.randomUUID(),
          expectedSequence: 1,
          actor: { agentId: agent.agentId, keyId: nodeKeyId },
          source: "mcp",
          issuedAt: new Date().toISOString(),
          command: {
            type: "apply",
            agentId: agent.agentId,
            keyId: nodeKeyId,
            missionVersion: 1,
            relevantCapabilities: ["accessibility-audit"],
            proposedContribution: publicCommandMatch,
            availability: {
              availableFrom: "2026-08-26T12:00:00.000Z",
              availableUntil: "2026-08-27T12:00:00.000Z",
            },
          },
        },
      ),
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(unsafeCommand.status).toBe(422);
    expect(await unsafeCommand.text()).not.toContain(publicCommandMatch);

    const disable = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}/autonomy`,
      {
        method: "PUT",
        headers: owner.headers,
        body: JSON.stringify({ enabled: false, expectedVersion: 2 }),
      },
    );
    expect(await disable.json()).toMatchObject({
      policy: { enabled: false, version: 3 },
    });
    const secondMissionId = crypto.randomUUID();
    const secondCreated = await signedNodeRequest({
      url: `/api/missions/${secondMissionId}`,
      body: { requesterAgentId: agent.agentId },
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(secondCreated.status).toBe(201);
    expect(
      (
        await publishFromNode(
          secondMissionId,
          agent.agentId,
          nodeCredential,
          nodeKeyId,
          nodePair.privateKey,
        )
      ).status,
    ).toBe(403);

    const revoke = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}/keys/${encodeURIComponent(nodeKeyId)}/revoke`,
      { method: "POST", headers: owner.headers, body: "{}" },
    );
    expect(revoke.status).toBe(200);
    const historicalAfter = await getHistoricalPairingProof(
      env.GUILD_DB,
      nodeKeyId,
    );
    expect(historicalAfter).toEqual(historicalBefore);
    const blockedAfterRevocation = await signedNodeRequest({
      url: `/api/missions/${crypto.randomUUID()}`,
      body: { requesterAgentId: agent.agentId },
      credential: nodeCredential,
      keyId: nodeKeyId,
      privateKey: nodePair.privateKey,
    });
    expect(blockedAfterRevocation.status).toBe(403);

    const logout = await worker.fetch(
      "https://guildhall.test/api/auth/logout",
      {
        method: "POST",
        headers: owner.headers,
        body: "{}",
      },
    );
    expect(logout.status).toBe(200);
    const endedSession = await worker.fetch(
      "https://guildhall.test/api/session",
      {
        headers: { Cookie: owner.cookie },
      },
    );
    expect(endedSession.status).toBe(200);
    expect(await endedSession.json()).toEqual({ authenticated: false });
    const blockedOwnerMutation = await worker.fetch(
      `https://guildhall.test/api/agents/${agent.agentId}/pairing`,
      { method: "POST", headers: owner.headers, body: "{}" },
    );
    expect(blockedOwnerMutation.status).toBe(401);
  });
});

async function startOAuth(): Promise<Response> {
  const response = await handleOAuthRoute(
    new Request("https://guildhall.test/api/auth/github/start"),
    env,
  );
  if (response === null) throw new Error("OAuth start route was not handled");
  return response;
}

async function loginOwner(githubUserId: number, login: string) {
  const started = await startOAuth();
  const authorization = new URL(started.headers.get("Location")!);
  const callback = await handleOAuthRoute(
    new Request(
      `https://guildhall.test/api/auth/github/callback?code=mock-code&state=${authorization.searchParams.get("state")}`,
      { headers: { Cookie: cookieHeader(started, "__Host-guild_flow") } },
    ),
    env,
    {
      exchangeCode: async () => ({ githubUserId, login, avatarUrl: null }),
    },
  );
  if (callback === null || callback.status !== 302) {
    throw new Error("Mock owner login failed");
  }
  const sessionToken = cookieValue(callback, "__Host-guild_session");
  const csrfToken = cookieValue(callback, "__Host-guild_csrf");
  const cookie = `__Host-guild_session=${sessionToken}; __Host-guild_csrf=${csrfToken}`;
  return {
    sessionToken,
    csrfToken,
    cookie,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: "https://guildhall.test",
      "X-Guild-CSRF": csrfToken,
    },
  };
}

async function ed25519Pair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function sign(
  privateKey: CryptoKey,
  value: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    bytes.slice().buffer as ArrayBuffer,
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function signedNodeRequest(input: {
  readonly url: string;
  readonly body: unknown;
  readonly credential: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly nonce?: string;
  readonly issuedAt?: string;
}): Promise<Response> {
  const bodyText = JSON.stringify(input.body);
  const requestTarget = input.url;
  const nonce = input.nonce ?? randomBase64UrlToken();
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  return worker.fetch(`https://guildhall.test${input.url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `GuildNode ${input.credential}`,
      "X-Guild-Key-Id": input.keyId,
      "X-Guild-Issued-At": issuedAt,
      "X-Guild-Nonce": nonce,
      "X-Guild-Signature": await sign(
        input.privateKey,
        createAgentRequestSignatureMessage({
          method: "POST",
          requestTarget,
          bodyText,
          issuedAt,
          nonce,
        }),
      ),
    },
    body: bodyText,
  });
}

async function publishFromNode(
  missionId: string,
  agentId: string,
  credential: string,
  keyId: string,
  privateKey: CryptoKey,
): Promise<Response> {
  const commandId = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const command = { type: "publish" } as const;
  const bodyHash = await commandBodyHash({
    commandId,
    action: command.type,
    missionId,
    expectedSequence: 0,
    actor: { agentId, keyId },
    issuedAt,
    payload: command,
  });
  return signedNodeRequest({
    url: `/api/missions/${missionId}/commands`,
    body: {
      commandId,
      expectedSequence: 0,
      actor: { agentId, keyId },
      source: "mcp",
      issuedAt,
      command,
      proof: {
        bodyHash,
        signature: await sign(privateKey, commandSigningBytes(bodyHash)),
      },
    },
    credential,
    keyId,
    privateKey,
  });
}

async function withNodeCommandProof<
  T extends {
    readonly commandId: string;
    readonly expectedSequence: number;
    readonly actor: { readonly agentId: string; readonly keyId: string };
    readonly issuedAt: string;
    readonly command: Readonly<Record<string, unknown>>;
  },
>(
  missionId: string,
  keyId: string,
  privateKey: CryptoKey,
  body: T,
): Promise<T & { readonly proof: { bodyHash: string; signature: string } }> {
  const bodyHash = await commandBodyHash({
    commandId: body.commandId,
    action: String(body.command.type),
    missionId,
    expectedSequence: body.expectedSequence,
    actor: { agentId: body.actor.agentId, keyId },
    issuedAt: body.issuedAt,
    payload: body.command,
  });
  return {
    ...body,
    proof: {
      bodyHash,
      signature: await sign(privateKey, commandSigningBytes(bodyHash)),
    },
  };
}

function setCookieLines(response: Response): readonly string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return headers.getSetCookie?.() ?? [headers.get("Set-Cookie") ?? ""];
}

function cookieHeader(response: Response, name: string): string {
  return `${name}=${cookieValue(response, name)}`;
}

function cookieValue(response: Response, name: string): string {
  for (const line of setCookieLines(response)) {
    const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`, "u").exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`Cookie ${name} was not set`);
}
