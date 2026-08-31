import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  deriveEd25519KeyId,
  encodeBase64Url,
  hashOpaqueCredential,
  randomBase64UrlToken,
} from "../../apps/guildhall/src/worker/auth/crypto";
import {
  createAgent,
  registerAgentKey,
  registerScopedCredential,
  revokeAgentKey,
  upsertGithubOwnerAndSession,
} from "../../apps/guildhall/src/worker/repositories";
import {
  markReferenceMission,
  projectMissionCatalog,
} from "../../apps/guildhall/src/worker/repositories/missionCatalog";
import { createAgentRequestSignatureMessage } from "../../packages/trust-engine/src";
import { handlePublicApiRoute } from "../../apps/guildhall/src/worker/publicApi";
import type { GuildhallEnv } from "../../apps/guildhall/src/worker/types";

const ORIGIN = "https://guildhall.test";
const worker = (exports as unknown as { default: Fetcher }).default;
const encoder = new TextEncoder();

describe("bounded public REST projections", () => {
  it("publishes current and historical issuer verification keys", async () => {
    const first = await issuerFixture();
    const second = await issuerFixture();
    const baseEnv = env as unknown as GuildhallEnv;
    const firstEnv = {
      ...baseEnv,
      GUILD_ISSUER_KEY_ID: first.keyId,
      GUILD_ISSUER_PRIVATE_JWK: JSON.stringify(first.privateJwk),
    };
    const current = await handlePublicApiRoute(
      new Request(`${ORIGIN}/.well-known/guildhall-issuer-key.json`),
      firstEnv,
    );
    expect(current?.status).toBe(200);
    expect(await current!.json()).toMatchObject({
      keyId: first.keyId,
      publicJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: first.publicJwk.x,
      },
      keySetUrl: "/.well-known/guildhall-issuer-keys.json",
    });

    const secondEnv = {
      ...baseEnv,
      GUILD_ISSUER_KEY_ID: second.keyId,
      GUILD_ISSUER_PRIVATE_JWK: JSON.stringify(second.privateJwk),
    };
    const history = await handlePublicApiRoute(
      new Request(`${ORIGIN}/.well-known/guildhall-issuer-keys.json`),
      secondEnv,
    );
    expect(history?.status).toBe(200);
    const historyBody = (await history!.json()) as {
      keys: readonly Record<string, unknown>[];
    };
    expect(historyBody.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyId: first.keyId,
          status: "retired",
          publicJwk: expect.objectContaining({
            kty: "OKP",
            crv: "Ed25519",
            x: first.publicJwk.x,
          }),
        }),
        expect.objectContaining({
          keyId: second.keyId,
          status: "active",
          publicJwk: expect.objectContaining({
            kty: "OKP",
            crv: "Ed25519",
            x: second.publicJwk.x,
          }),
        }),
      ]),
    );
  });

  it("lists and reads public agent cards without owner, key, or credential data", async () => {
    const owner = await seedOwner("public-agents", 8_700_001);
    const first = await seedAgent(owner.ownerId, "public-one", {
      totalPoints: 900,
      completedMissions: 4,
      capability: "accessibility-audit",
    });
    const second = await seedAgent(owner.ownerId, "public-two", {
      totalPoints: 450,
      completedMissions: 2,
      capability: "remediation-planning",
    });
    const signingPair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicJwk = await crypto.subtle.exportKey(
      "jwk",
      signingPair.publicKey,
    );
    const keyId = await deriveEd25519KeyId("browser", publicJwk);
    const keyCreatedAt = new Date().toISOString();
    await registerAgentKey(env.GUILD_DB, {
      keyId,
      ownerId: owner.ownerId,
      agentId: first,
      publicJwk,
      source: "browser",
      createdAt: keyCreatedAt,
    });
    const revokedAt = new Date(Date.now() + 1_000).toISOString();
    await revokeAgentKey(env.GUILD_DB, owner.ownerId, first, keyId, revokedAt);

    const firstPage = await fetchApi("/api/agents?limit=1");
    expect(firstPage.status).toBe(200);
    const page = await json<{
      agents: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>(firstPage);
    expect(page.agents).toHaveLength(1);
    expect(page.agents[0]).toMatchObject({
      agentId: first,
      characterName: "Public One",
      totalPoints: 900,
      completedMissions: 4,
      capabilities: [
        {
          capability: "accessibility-audit",
          declaredLevel: 70,
          verifiedPoints: 600,
        },
      ],
    });
    expect(page.nextCursor).toBeTypeOf("string");

    const secondPage = await fetchApi(
      `/api/agents?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    expect(await json(secondPage)).toMatchObject({
      agents: [{ agentId: second }],
      nextCursor: null,
    });

    const profileResponse = await fetchApi(`/api/agents/${first}`);
    expect(profileResponse.status).toBe(200);
    const profileText = await profileResponse.text();
    expect(profileText).not.toContain(owner.ownerId);
    expect(profileText).not.toContain(owner.githubLogin);
    expect(profileText).not.toMatch(
      /ownerId|githubUserId|session|credential|publicJwk|keyId/iu,
    );
    expect(JSON.parse(profileText)).toMatchObject({
      profile: {
        agentId: first,
        technicalName: "Protocol Public One",
        keySetUrl: `/api/agents/${first}/keys`,
      },
    });
    expect(
      await json(await fetchApi(`/api/agents/${first}/keys`)),
    ).toMatchObject({
      protocol: "commitment/v1",
      agentId: first,
      algorithm: "Ed25519",
      keys: [
        {
          keyId,
          publicJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x },
          source: "browser",
          status: "revoked",
          revokedAt,
        },
      ],
    });

    expect(
      await json(
        await fetchApi(
          "/api/leaderboard?capability=accessibility-audit&limit=10",
        ),
      ),
    ).toMatchObject({
      capability: "accessibility-audit",
      rankings: [
        {
          rank: 1,
          profile: { agentId: first },
          verifiedPoints: 600,
          verifiedMissions: 3,
        },
      ],
    });
    expect(
      (await fetchApi("/api/leaderboard?capability=INVALID CAPABILITY")).status,
    ).toBe(400);

    expect((await fetchApi(`/api/agents/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    expect((await fetchApi("/api/agents?limit=51")).status).toBe(400);
  });

  it("paginates and filters only complete sequence-gated mission cards", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const incompleteId = crypto.randomUUID();
    const referenceId = crypto.randomUUID();
    await seedMission(firstId, {
      projectedAt: "2026-08-26T12:00:01.000Z",
      capability: "accessibility-audit",
      displayState: "Recruiting",
      sequence: 5,
      applicants: 2,
    });
    await seedMission(secondId, {
      projectedAt: "2026-08-26T12:00:02.000Z",
      capability: "remediation-planning",
      displayState: "Negotiating",
      sequence: 8,
      applicants: 1,
    });
    await projectMissionCatalog(env.GUILD_DB, {
      missionId: incompleteId,
      missionVersion: 1,
      requesterAgentId: crypto.randomUUID(),
      lifecycleState: "PREPARE",
      displayState: "Recruiting",
      projection: { applicationAgentIds: [] },
      lastSequence: 1,
      projectedAt: "2026-08-26T12:00:03.000Z",
    });
    await seedMission(referenceId, {
      projectedAt: "2026-08-26T12:00:04.000Z",
      capability: "accessibility-audit",
      displayState: "Completed",
      sequence: 14,
      applicants: 2,
    });
    expect(await markReferenceMission(env.GUILD_DB, referenceId)).toBe(true);

    const stale = await projectMissionCatalog(env.GUILD_DB, {
      ...missionProjection(firstId, {
        projectedAt: "2026-08-26T11:59:59.000Z",
        capability: "accessibility-audit",
        displayState: "Completed",
        sequence: 4,
        applicants: 0,
      }),
    });
    expect(stale.applied).toBe(false);

    const filtered = await fetchApi(
      "/api/missions?capability=accessibility-audit",
    );
    expect(filtered.status).toBe(200);
    const filteredBody = await json<Record<string, unknown>>(filtered);
    expect(filteredBody).toMatchObject({
      missions: [
        {
          missionId: firstId,
          requiredCapabilities: ["accessibility-audit"],
          applicantCount: 2,
          displayState: "Recruiting",
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(filteredBody)).not.toContain(referenceId);

    expect(
      await json(await fetchApi("/api/missions?catalogKind=reference")),
    ).toMatchObject({
      missions: [{ missionId: referenceId, catalogKind: "reference" }],
      nextCursor: null,
    });
    expect((await fetchApi("/api/missions?catalogKind=private")).status).toBe(
      400,
    );

    const firstPage = await json<{
      missions: Array<{ missionId: string }>;
      nextCursor: string | null;
    }>(await fetchApi("/api/missions?limit=1"));
    expect(firstPage.missions).toEqual([{ ...missionCardShape(secondId) }]);
    expect(firstPage.nextCursor).toBeTypeOf("string");
    expect(firstPage.nextCursor!.length).toBeLessThanOrEqual(256);
    expect(firstPage.nextCursor).not.toContain(secondId);

    const secondPage = await json<{
      missions: Array<{ missionId: string }>;
      nextCursor: string | null;
    }>(
      await fetchApi(
        `/api/missions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
    );
    expect(secondPage.missions.map((mission) => mission.missionId)).toEqual([
      firstId,
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const tamperedCursor = mutate(firstPage.nextCursor!);
    const invalid = await fetchApi(
      `/api/missions?limit=1&cursor=${encodeURIComponent(tamperedCursor)}`,
    );
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toContain("INVALID_CURSOR");
    expect(invalidText).not.toContain(tamperedCursor);

    const rebound = await fetchApi(
      `/api/missions?limit=1&capability=accessibility-audit&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(rebound.status).toBe(400);
    expect((await fetchApi("/api/missions?limit=100")).status).toBe(400);
    expect(
      (await fetchApi("/api/missions?capability=INVALID CAPABILITY")).status,
    ).toBe(400);
  });

  it("returns a schema-validated public receipt projection or null", async () => {
    const missionId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const issuedAt = "2026-08-26T12:01:00.000Z";
    const fullReceipt = {
      protocol: "commitment/v1",
      kind: "receipt",
      receiptId,
      missionId,
      outcome: "canceled",
      pactDigest: null,
      eventChainHead: "H".repeat(43),
      artifacts: [],
      verification: null,
      timeliness: {
        overdue: false,
        deliveryDeadline: "2026-08-26T12:00:00.000Z",
        completedAt: issuedAt,
      },
      defaults: [],
      replacements: [],
      reward: {
        basePointsAwarded: 0,
        recoveryBonusAwarded: 0,
        totalPointsAwarded: 0,
        transferable: false,
        redeemable: false,
        monetaryValue: false,
      },
      reputationDeltas: [],
      issuerKeyId: crypto.randomUUID(),
      issuerSignature: "S".repeat(86),
      issuedAt,
    };
    await env.GUILD_DB.prepare(
      `INSERT INTO receipts (
         receipt_id, mission_id, outcome, pact_digest, event_chain_head,
         receipt_json, last_sequence, issued_at, projected_at
       ) VALUES (?, ?, 'canceled', NULL, ?, ?, 12, ?, ?)`,
    )
      .bind(
        receiptId,
        missionId,
        fullReceipt.eventChainHead,
        JSON.stringify(fullReceipt),
        issuedAt,
        issuedAt,
      )
      .run();

    const response = await fetchApi(`/api/missions/${missionId}/receipt`);
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toContain("issuerSignature");
    expect(responseText).toContain("reputationDeltas");
    expect(JSON.parse(responseText)).toEqual({ receipt: fullReceipt });

    expect(
      await json(
        await fetchApi(`/api/missions/${crypto.randomUUID()}/receipt`),
      ),
    ).toEqual({ receipt: null });
  });
});

async function issuerFixture(): Promise<{
  readonly keyId: string;
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const { d: _private, ...publicJwk } = privateJwk;
  return { keyId: crypto.randomUUID(), privateJwk, publicJwk };
}

describe("signed Guild Node inbox", () => {
  it("authenticates an empty-body GET and advances an opaque forward cursor", async () => {
    const identity = await seedNodeIdentity();
    const existingMission = crypto.randomUUID();
    const ownMission = crypto.randomUUID();
    await seedMission(existingMission, {
      projectedAt: "2026-08-26T12:10:00.000Z",
      capability: "accessibility-audit",
      displayState: "Recruiting",
      sequence: 2,
      applicants: 0,
    });
    await seedMission(ownMission, {
      projectedAt: "2026-08-26T12:10:01.000Z",
      capability: "accessibility-audit",
      displayState: "Recruiting",
      sequence: 2,
      applicants: 0,
      requesterAgentId: identity.agentId,
    });

    const unsigned = await fetchApi(`/api/agents/${identity.agentId}/inbox`);
    expect(unsigned.status).toBe(403);

    const first = await signedInboxRequest(identity, null);
    expect(first.status).toBe(200);
    const firstBody = await json<{
      missions: Array<{ missionId: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    }>(first);
    const initialMissionIds = firstBody.missions.map(
      (mission) => mission.missionId,
    );
    expect(initialMissionIds).toContain(existingMission);
    expect(initialMissionIds).not.toContain(ownMission);
    expect(firstBody.nextCursor).toBeTypeOf("string");
    expect(firstBody.nextCursor).not.toContain(existingMission);
    expect(firstBody.hasMore).toBe(false);

    const emptyPoll = await json<{
      missions: unknown[];
      nextCursor: string | null;
    }>(await signedInboxRequest(identity, firstBody.nextCursor));
    expect(emptyPoll).toEqual({
      missions: [],
      nextCursor: firstBody.nextCursor,
      hasMore: false,
    });

    const newMission = crypto.randomUUID();
    await seedMission(newMission, {
      projectedAt: "2026-08-26T12:10:02.000Z",
      capability: "remediation-planning",
      displayState: "Replacement needed",
      sequence: 9,
      applicants: 1,
    });
    const advanced = await json<{
      missions: Array<{ missionId: string }>;
      nextCursor: string | null;
    }>(await signedInboxRequest(identity, firstBody.nextCursor));
    expect(advanced.missions.map((mission) => mission.missionId)).toEqual([
      newMission,
    ]);
    expect(advanced.nextCursor).not.toBe(firstBody.nextCursor);

    const tampered = mutate(firstBody.nextCursor!);
    const tamperedResponse = await signedInboxRequest(identity, tampered);
    expect(tamperedResponse.status).toBe(400);
    const tamperedText = await tamperedResponse.text();
    expect(tamperedText).toContain("INVALID_CURSOR");
    expect(tamperedText).not.toContain(tampered);
  });
});

interface SeededOwner {
  readonly ownerId: string;
  readonly githubLogin: string;
}

interface SeededNodeIdentity {
  readonly agentId: string;
  readonly credential: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

async function seedOwner(
  label: string,
  githubUserId: number,
): Promise<SeededOwner> {
  const sessionToken = randomBase64UrlToken();
  const csrfToken = randomBase64UrlToken();
  const githubLogin = `mcp-${label}`;
  const principal = await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId: crypto.randomUUID(),
    githubUserId,
    githubLogin,
    githubAvatarUrl: null,
    sessionHash: await hashOpaqueCredential(sessionToken),
    csrfHash: await hashOpaqueCredential(csrfToken),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return { ownerId: principal.ownerId, githubLogin };
}

async function seedAgent(
  ownerId: string,
  label: string,
  input: {
    totalPoints: number;
    completedMissions: number;
    capability: string;
  },
): Promise<string> {
  const agentId = crypto.randomUUID();
  const words = label.split("-").map(capitalize).join(" ");
  const createdAt = new Date().toISOString();
  await createAgent(env.GUILD_DB, {
    agentId,
    ownerId,
    slug: `${label}-${agentId.slice(0, 8)}`,
    characterName: words,
    characterClass: "Artificer",
    technicalName: `Protocol ${words}`,
    guildName: "Public Test Guild",
    publicBio: "A public projection fixture.",
    createdAt,
  });
  await env.GUILD_DB.batch([
    env.GUILD_DB.prepare(
      `UPDATE agents SET total_points = ?, completed_missions = ?
       WHERE agent_id = ?`,
    ).bind(input.totalPoints, input.completedMissions, agentId),
    env.GUILD_DB.prepare(
      `INSERT INTO agent_capabilities (
         agent_id, capability, declared_level, verified_points,
         verified_missions, reliability, timeliness, updated_at
       ) VALUES (?, ?, 70, 600, 3, 0.95, 0.9, ?)`,
    ).bind(agentId, input.capability, createdAt),
  ]);
  return agentId;
}

async function seedMission(
  missionId: string,
  input: {
    projectedAt: string;
    capability: string;
    displayState: string;
    sequence: number;
    applicants: number;
    requesterAgentId?: string;
  },
): Promise<void> {
  await projectMissionCatalog(
    env.GUILD_DB,
    missionProjection(missionId, input),
  );
}

function missionProjection(
  missionId: string,
  input: {
    projectedAt: string;
    capability: string;
    displayState: string;
    sequence: number;
    applicants: number;
    requesterAgentId?: string;
  },
) {
  return {
    missionId,
    missionVersion: 1,
    requesterAgentId: input.requesterAgentId ?? crypto.randomUUID(),
    lifecycleState: input.displayState === "Recruiting" ? "PREPARE" : "RESERVE",
    displayState: input.displayState,
    title: `Mission ${missionId.slice(0, 8)}`,
    summary: "Complete one bounded public guild assignment.",
    difficulty: "adept" as const,
    pointReward: 240,
    minimumPartySize: 1,
    preferredPartySize: 2,
    maximumPartySize: 2,
    requiredCapabilities: [input.capability],
    participantAgentIds: [],
    formationDeadline: "2026-08-27T12:00:00.000Z",
    deliveryDeadline: "2026-08-28T12:00:00.000Z",
    publishedAt: "2026-08-26T12:00:00.000Z",
    projection: {
      applicationAgentIds: Array.from({ length: input.applicants }, () =>
        crypto.randomUUID(),
      ),
    },
    lastSequence: input.sequence,
    projectedAt: input.projectedAt,
  };
}

function missionCardShape(missionId: string) {
  return {
    missionId,
    missionVersion: 1,
    requesterAgentId: expect.any(String),
    title: `Mission ${missionId.slice(0, 8)}`,
    goal: "Complete one bounded public guild assignment.",
    requiredCapabilities: ["remediation-planning"],
    minimumPartySize: 1,
    preferredPartySize: 2,
    maximumPartySize: 2,
    formationDeadline: "2026-08-27T12:00:00.000Z",
    deliveryDeadline: "2026-08-28T12:00:00.000Z",
    difficulty: "adept",
    pointReward: 240,
    applicantCount: 1,
    displayState: "Negotiating",
    catalogKind: "community",
  };
}

async function seedNodeIdentity(): Promise<SeededNodeIdentity> {
  const owner = await seedOwner("inbox", 8_700_101);
  const agentId = await seedAgent(owner.ownerId, "inbox-agent", {
    totalPoints: 100,
    completedMissions: 1,
    capability: "accessibility-audit",
  });
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const keyId = await deriveEd25519KeyId("guild-node", publicJwk);
  const createdAt = new Date().toISOString();
  await registerAgentKey(env.GUILD_DB, {
    keyId,
    ownerId: owner.ownerId,
    agentId,
    publicJwk,
    source: "guild-node",
    createdAt,
  });
  const credential = randomBase64UrlToken();
  const registered = await registerScopedCredential(env.GUILD_DB, {
    credentialId: crypto.randomUUID(),
    ownerId: owner.ownerId,
    agentId,
    keyId,
    credentialHash: await hashOpaqueCredential(credential),
    scopes: ["missions:read"],
    expiresAt: null,
    createdAt,
  });
  expect(registered).not.toBeNull();
  return { agentId, credential, keyId, privateKey: keyPair.privateKey };
}

async function signedInboxRequest(
  identity: SeededNodeIdentity,
  cursor: string | null,
): Promise<Response> {
  const parameters = new URLSearchParams();
  if (cursor !== null) parameters.set("cursor", cursor);
  const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
  const path = `/api/agents/${identity.agentId}/inbox${suffix}`;
  const issuedAt = new Date().toISOString();
  const nonce = randomBase64UrlToken();
  const message = createAgentRequestSignatureMessage({
    method: "GET",
    requestTarget: path,
    bodyText: "",
    issuedAt,
    nonce,
  });
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        identity.privateKey,
        encoder.encode(message),
      ),
    ),
  );
  return fetchApi(path, {
    headers: {
      Authorization: `GuildNode ${identity.credential}`,
      "X-Guild-Issued-At": issuedAt,
      "X-Guild-Key-Id": identity.keyId,
      "X-Guild-Nonce": nonce,
      "X-Guild-Signature": signature,
    },
  });
}

async function fetchApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return worker.fetch(new Request(new URL(path, ORIGIN), init));
}

async function json<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}

function mutate(value: string): string {
  const final = value.at(-1);
  return `${value.slice(0, -1)}${final === "A" ? "B" : "A"}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
