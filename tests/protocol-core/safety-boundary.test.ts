import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  deriveEd25519KeyId,
  hashOpaqueCredential,
  randomBase64UrlToken,
} from "../../apps/guildhall/src/worker/auth/crypto";
import {
  createAgent,
  registerAgentKey,
  upsertGithubOwnerAndSession,
} from "../../apps/guildhall/src/worker/repositories";
import { verifyMissionEventChain } from "../../packages/trust-engine/src";

const worker = (exports as unknown as { default: Fetcher }).default;

describe("private draft and public safety boundary", () => {
  it("keeps rejected content private and never echoes the match", async () => {
    const identity = await seedOwnerAgent("unsafe");
    const syntheticMatch = `sk-proj-${"Z".repeat(28)}`;
    const created = await worker.fetch("https://guildhall.test/api/drafts", {
      method: "POST",
      headers: ownerHeaders(identity),
      body: JSON.stringify({
        requesterAgentId: identity.agentId,
        title: `Private investigation ${syntheticMatch}`,
        payload: { goal: "Inspect a bounded public output." },
      }),
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(syntheticMatch);
    const createdBody = JSON.parse(createdText) as {
      draftId: string;
      publicationEligible: boolean;
      safety: { safe: false; category: string; fieldPath: string };
    };
    expect(createdBody).toMatchObject({
      publicationEligible: false,
      safety: { safe: false, category: "provider-token" },
    });

    const publishBody = JSON.stringify({ requesterAgentId: identity.agentId });
    const published = await worker.fetch(
      `https://guildhall.test/api/drafts/${createdBody.draftId}/publish`,
      {
        method: "POST",
        headers: ownerHeaders(identity),
        body: publishBody,
      },
    );
    expect(published.status).toBe(422);
    const rejection = await published.text();
    expect(rejection).not.toContain(syntheticMatch);
    expect(rejection).toContain("PUBLIC_SAFETY_REJECTED");

    const privateRow = await env.GUILD_DB.prepare(
      `SELECT safety_status, sealed_payload
       FROM private_mission_drafts WHERE draft_id = ?`,
    )
      .bind(createdBody.draftId)
      .first<{ safety_status: string; sealed_payload: string }>();
    expect(privateRow?.safety_status).toBe("unsafe");
    expect(privateRow?.sealed_payload).not.toContain(syntheticMatch);
    const draftColumns = await env.GUILD_DB.prepare(
      "PRAGMA table_info(private_mission_drafts)",
    ).all<{ name: string }>();
    expect(draftColumns.results.map((column) => column.name)).not.toContain(
      "title",
    );
    const publicCount = await env.GUILD_DB.prepare(
      "SELECT COUNT(*) AS count FROM mission_catalog",
    ).first<{ count: number }>();
    expect(publicCount?.count).toBe(0);
  });

  it("publishes a safe mission and records marker-only emergency redaction", async () => {
    const identity = await seedOwnerAgent("redaction");
    const missionId = crypto.randomUUID();
    const now = Date.now();
    const mission = {
      protocol: "commitment/v1",
      kind: "mission",
      missionId,
      missionVersion: 1,
      requesterAgentId: identity.agentId,
      title: "Audit the guild quest board",
      goal: "Return structured accessibility findings for the public quest board.",
      publicInputs: [
        {
          inputId: crypto.randomUUID(),
          type: "url",
          location: "https://guildhall.test/quests/demo",
          mediaType: "text/html",
        },
      ],
      requiredCapabilities: ["accessibility-audit"],
      minimumPartySize: 1,
      preferredPartySize: 2,
      maximumPartySize: 2,
      formationDeadline: new Date(now + 60_000).toISOString(),
      deliveryDeadline: new Date(now + 120_000).toISOString(),
      requiredOutputs: [
        {
          outputId: crypto.randomUUID(),
          type: "accessibility-findings",
          description: "Structured deterministic findings",
          mediaType: "application/json",
          publicLocation: "mission-artifact",
        },
      ],
      verificationCriteria: [
        {
          criterionId: crypto.randomUUID(),
          description: "Every finding names a deterministic check.",
          required: true,
          method: "deterministic",
        },
      ],
      difficulty: "adept",
      pointReward: 240,
      failureBehavior: {
        negotiationTimeout: "reopen-recruitment",
        participantDefault: "recruit-exact-slot-replacement",
        replacementAuthorized: true,
        verificationCorrectionLimit: 1,
      },
      publishedAt: new Date(now).toISOString(),
    };

    const draftResponse = await worker.fetch(
      "https://guildhall.test/api/drafts",
      {
        method: "POST",
        headers: ownerHeaders(identity),
        body: JSON.stringify({
          requesterAgentId: identity.agentId,
          title: mission.title,
          payload: mission,
        }),
      },
    );
    const draft = (await draftResponse.json()) as {
      draftId: string;
      publicationEligible: boolean;
    };
    expect(draftResponse.status).toBe(201);
    expect(draft.publicationEligible).toBe(true);

    const publication = await worker.fetch(
      `https://guildhall.test/api/drafts/${draft.draftId}/publish`,
      {
        method: "POST",
        headers: ownerHeaders(identity),
        body: JSON.stringify({ requesterAgentId: identity.agentId }),
      },
    );
    expect(publication.status).toBe(201);

    const beforeRedaction = await worker.fetch(
      `https://guildhall.test/api/missions/${missionId}`,
    );
    const beforeSnapshot = (await beforeRedaction.json()) as {
      events: Array<{ eventId: string; payload: Record<string, unknown> }>;
    };
    const targetEvent = beforeSnapshot.events[0]!;
    expect(targetEvent.payload).toHaveProperty("command");

    const redaction = await worker.fetch(
      `https://guildhall.test/api/missions/${missionId}/redactions`,
      {
        method: "POST",
        headers: ownerHeaders(identity),
        body: JSON.stringify({
          eventId: targetEvent.eventId,
          reason: "Public payload requires an emergency safety pause.",
          category: "unsafe",
        }),
      },
    );
    expect(redaction.status).toBe(200);
    expect(await redaction.json()).toMatchObject({
      redaction: {
        missionId,
        eventId: targetEvent.eventId,
        marker: { kind: "redacted-public-payload" },
      },
      missionPaused: false,
      missionCanceled: true,
    });
    const afterRedaction = await worker.fetch(
      `https://guildhall.test/api/missions/${missionId}`,
    );
    const afterSnapshot = (await afterRedaction.json()) as {
      events: Array<{
        eventId: string;
        type: string;
        payload: Record<string, unknown>;
      }>;
    };
    const masked = afterSnapshot.events.find(
      (event) => event.eventId === targetEvent.eventId,
    );
    expect(masked?.payload).toEqual({
      kind: "redacted-public-payload",
      rulesetVersion: "guildhall-public-safety/1.0.0",
    });
    expect(masked?.payload).not.toHaveProperty("command");
    const declarationEvent = afterSnapshot.events.find(
      (event) => event.type === "safety_redacted",
    );
    expect(declarationEvent).toBeDefined();
    expect(
      verifyMissionEventChain(afterSnapshot.events as never),
    ).toMatchObject({
      valid: true,
    });
    const marker = await env.GUILD_DB.prepare(
      `SELECT marker, mission_id, event_id
       FROM public_redactions WHERE mission_id = ?`,
    )
      .bind(missionId)
      .first<{ marker: string; mission_id: string; event_id: string }>();
    expect(marker).toEqual({
      marker: "[REDACTED]",
      mission_id: missionId,
      event_id: targetEvent.eventId,
    });
    const declarationRedaction = await worker.fetch(
      `https://guildhall.test/api/missions/${missionId}/redactions`,
      {
        method: "POST",
        headers: ownerHeaders(identity),
        body: JSON.stringify({
          eventId: declarationEvent!.eventId,
          reason: "Redaction declarations must remain publicly auditable.",
          category: "other",
        }),
      },
    );
    expect(declarationRedaction.status).toBe(409);
    expect(await declarationRedaction.json()).toMatchObject({
      error: "EVENT_NOT_REDACTABLE",
    });
  });
});

interface SeededIdentity {
  readonly ownerId: string;
  readonly agentId: string;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

async function seedOwnerAgent(label: string): Promise<SeededIdentity> {
  const proposedOwnerId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionToken = randomBase64UrlToken();
  const csrfToken = randomBase64UrlToken();
  const now = new Date().toISOString();
  const principal = await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId,
    githubUserId: label === "unsafe" ? 8101 : 8102,
    githubLogin: `safety-${label}`,
    githubAvatarUrl: null,
    sessionHash: await hashOpaqueCredential(sessionToken),
    csrfHash: await hashOpaqueCredential(csrfToken),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
  });
  await createAgent(env.GUILD_DB, {
    agentId,
    ownerId: principal.ownerId,
    slug: `safety-${label}-${agentId.slice(0, 8)}`,
    characterName: "Safety Warden",
    characterClass: "Paladin",
    technicalName: "Safety Boundary Test",
    guildName: "Guildhall Tests",
    publicBio: "Protects the public mission boundary.",
    createdAt: now,
  });
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  await registerAgentKey(env.GUILD_DB, {
    keyId: await deriveEd25519KeyId("browser", publicJwk),
    ownerId: principal.ownerId,
    agentId,
    publicJwk,
    source: "browser",
    createdAt: now,
  });
  return {
    ownerId: principal.ownerId,
    agentId,
    sessionToken,
    csrfToken,
  };
}

function ownerHeaders(identity: SeededIdentity): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `__Host-guild_session=${identity.sessionToken}; __Host-guild_csrf=${identity.csrfToken}`,
    Origin: "https://guildhall.test",
    "X-Guild-CSRF": identity.csrfToken,
  };
}
