import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { hostedIdentity } from "../../apps/demo-agent/src/identity";
import {
  createAgentWorker,
  type HostedAgentEnv,
} from "../../apps/demo-agent/src/worker";
import { derivePartyFormation } from "../../apps/guildhall/src/worker/formation";
import { executeBoundDemoMission } from "../../apps/guildhall/src/worker/executionOrchestrator";
import { handleDemoRallyRoute } from "../../apps/guildhall/src/worker/demoRally";
import type { MissionCoordinator } from "../../apps/guildhall/src/worker/durable/MissionCoordinator";
import type { GuildhallEnv } from "../../apps/guildhall/src/worker/types";
import {
  deriveEd25519KeyId,
  encodeBase64Url,
  hashOpaqueCredential,
  randomBase64UrlToken,
} from "../../apps/guildhall/src/worker/auth/crypto";
import {
  createAgent,
  declareAgentCapability,
  registerAgentKey,
  registerScopedCredential,
  upsertGithubOwnerAndSession,
} from "../../apps/guildhall/src/worker/repositories";
import {
  registerGuildhallWebMcp,
  type CapabilityInvocationContext,
  type GuildCapabilityName,
  type ModelContextTool,
} from "../../packages/capability-manifest/src";
import {
  buildPact,
  canonicalJsonDigest,
  importEd25519PublicJwk,
  MissionSchema,
  pactSigningBytes,
  receiptSigningBytes,
  ReceiptSchema,
  sha256Base64Url,
  unsignedReceiptProjection,
  verifyEd25519,
  type AllocationAssignment,
  type MissionEvent,
} from "../../packages/contracts/src";
import type { LifecycleState } from "../../packages/mission-engine/src";
import { verifyEventChain } from "../../packages/trust-engine/src";
import { TEST_PRIVATE_JWKS } from "../a2a/fixtures/test-identities";

const ORIGIN = "https://guildhall.test";
const REQUESTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INPUT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINDINGS_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const PLAN_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const FINDINGS_CRITERION = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const PLAN_CRITERION = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const FIXTURE_DIGEST = "geKBB1Pr83xZU8RzZaoC-YcNy6MO2jw3lB_lupUQQ58";
const RALLY_SECRET = "test-rally-secret-with-at-least-thirty-two-characters";
const worker = (exports as unknown as { default: Fetcher }).default;

describe("live WebMCP to A2A party formation", () => {
  it("publishes, negotiates two full pacts, and binds identical signatures", async () => {
    const owner = await seedRequester();
    const scout = await seedHostedAgent("scout", 71_001, [
      "accessibility-audit",
    ]);
    const scribe = await seedHostedAgent("scribe", 71_002, [
      "remediation-planning",
    ]);
    await seedHostedAgent("warden", 71_003, ["remediation-planning"]);
    const tools = new Map<string, ModelContextTool>();
    const webMcp = await registerGuildhallWebMcp({
      document: {
        modelContext: {
          async registerTool(tool): Promise<void> {
            tools.set(tool.name, tool);
          },
        },
      },
      secureContext: true,
      handler: browserHandler(owner, {
        scout: scout.env,
        scribe: scribe.env,
      }),
    });
    expect(webMcp).toMatchObject({ status: "registered" });

    const now = Date.now();
    const formationDeadline = new Date(now + 60 * 60_000).toISOString();
    const deliveryDeadline = new Date(now + 3 * 60 * 60_000).toISOString();
    const missionInput = {
      title: "Map and remediate the accessibility dungeon",
      goal: "Produce public deterministic findings and a linked remediation plan.",
      publicInputs: [
        {
          inputId: INPUT_ID,
          type: "url",
          location: "https://guildhall.test/fixtures/accessibility-dungeon-v1",
          mediaType: "text/html",
          contentDigest: FIXTURE_DIGEST,
        },
      ],
      requiredCapabilities: ["accessibility-audit", "remediation-planning"],
      minimumPartySize: 1,
      preferredPartySize: 2,
      maximumPartySize: 2,
      formationDeadline,
      deliveryDeadline,
      requiredOutputs: [
        {
          outputId: FINDINGS_ID,
          type: "accessibility-findings",
          description: "Deterministic public findings.",
          mediaType: "application/json",
          publicLocation: "mission-artifact",
        },
        {
          outputId: PLAN_ID,
          type: "remediation-plan",
          description: "A remediation plan linked to every finding.",
          mediaType: "application/json",
          publicLocation: "mission-artifact",
        },
      ],
      verificationCriteria: [
        {
          criterionId: FINDINGS_CRITERION,
          description: "Every finding includes a stable rule and selector.",
          required: true,
          method: "deterministic",
        },
        {
          criterionId: PLAN_CRITERION,
          description: "Every finding maps to one remediation step.",
          required: true,
          method: "deterministic",
        },
      ],
      difficulty: "expert",
      pointReward: 100,
      failureBehavior: failureBehavior(),
    } as const;

    const fixtureResponse = await worker.fetch(
      `${ORIGIN}/fixtures/accessibility-dungeon-v1`,
    );
    const fixtureBody = await fixtureResponse.text();
    expect(fixtureResponse.status).toBe(200);
    expect(fixtureResponse.headers.get("X-Guildhall-Content-Digest")).toBe(
      FIXTURE_DIGEST,
    );
    expect(await sha256Base64Url(fixtureBody)).toBe(FIXTURE_DIGEST);

    const publish = await executeTool(
      tools,
      "guild.publish_mission",
      missionInput,
    );
    const publishData = dataRecord(publish);
    const missionId = requiredString(publishData, "missionId");
    expect(publish).toMatchObject({
      provenance: {
        transport: "webmcp",
        trusted: true,
        actionName: "guild.publish_mission",
      },
      data: { displayState: "Recruiting", sequence: 1 },
    });

    const board = await publicJson<{ missions: Array<{ missionId: string }> }>(
      "/api/missions?limit=10",
    );
    expect(board.missions.map((mission) => mission.missionId)).toContain(
      missionId,
    );

    const rallyStartedAt = performance.now();
    const formationRally = await executeTool(
      tools,
      "guild.rally_reference_party",
      { missionId },
    );
    expect(formationRally).toMatchObject({
      provenance: {
        transport: "webmcp",
        trusted: true,
        actionName: "guild.rally_reference_party",
      },
      data: {
        result: { coordination: "independent-signed-a2a" },
      },
    });
    let recruiting = await missionPacket(missionId);
    expect(recruiting.snapshot).toMatchObject({
      stage: "RESERVE",
      applicationAgentIds: [
        hostedIdentity("scout").agentId,
        hostedIdentity("scribe").agentId,
      ],
    });
    expect(
      await derivePartyFormation(
        env.GUILD_DB,
        MissionSchema.parse(recruiting.definition),
        recruiting.snapshot as unknown as LifecycleState,
        false,
      ),
    ).toMatchObject({
      selection: {
        minimumSatisfied: true,
        oneHelperFallbackUsed: false,
        selectedAgentIds: [
          hostedIdentity("scout").agentId,
          hostedIdentity("scribe").agentId,
        ],
      },
    });

    let packet = await missionPacket(missionId);
    expect(packet.snapshot).toMatchObject({
      stage: "RESERVE",
      selectedHelperIds: [
        hostedIdentity("scout").agentId,
        hostedIdentity("scribe").agentId,
      ],
      selectionEvidence: {
        selectedAgentIds: [
          hostedIdentity("scout").agentId,
          hostedIdentity("scribe").agentId,
        ],
        canProceed: true,
      },
    });
    expect(packet.snapshot.capabilityBids).toHaveLength(2);
    const roundOne = allocationInput(
      packet,
      "Requester split",
      deliveryDeadline,
    );
    const proposalOne = await executeTool(tools, "guild.propose_allocation", {
      missionId,
      expectedSequence: packet.latestSequence,
      negotiationStep: "requester-proposal",
      pactVersion: 1,
      ...roundOne,
    });
    expect(proposalOne).toMatchObject({
      provenance: { transport: "webmcp", trusted: true },
      data: { pactVersion: 1, displayState: "Negotiating" },
    });

    await executeTool(tools, "guild.rally_reference_party", { missionId });
    packet = await missionPacket(missionId);

    const candidate = requiredRecord(packet.snapshot, "candidatePact");
    const pact = requiredRecord(candidate, "pact");
    const pactDigest = requiredString(candidate, "pactDigest");
    expect(candidate).toMatchObject({
      proposerAgentId: hostedIdentity("scout").agentId,
      proposalRound: 2,
    });
    expect(packet.snapshot).toMatchObject({
      assignmentResolution: {
        strategy: "matching",
        selectedProposalAgentId: hostedIdentity("scout").agentId,
      },
    });
    expect(packet.snapshot.assignmentProposals).toHaveLength(2);
    expect(Object.keys(requiredRecord(packet.snapshot, "acceptances"))).toEqual(
      expect.arrayContaining([
        hostedIdentity("scout").agentId,
        hostedIdentity("scribe").agentId,
      ]),
    );
    expect(await canonicalJsonDigest(pact)).toBe(pactDigest);
    expect(packet.snapshot.proposalHistory).toHaveLength(2);

    const requesterAcceptance = await executeTool(tools, "guild.accept_pact", {
      missionId,
      expectedSequence: packet.latestSequence,
      pactVersion: 2,
      pactDigest,
      acceptedAt: new Date().toISOString(),
    });
    expect(requesterAcceptance).toMatchObject({
      provenance: { transport: "webmcp", trusted: true },
    });
    packet = await missionPacket(missionId);
    expect(performance.now() - rallyStartedAt).toBeLessThan(90_000);
    const acceptances = Object.values(
      requiredRecord(packet.snapshot, "acceptances"),
    ) as Array<Record<string, unknown>>;
    expect(packet.snapshot).toMatchObject({
      stage: "EXECUTE",
      executionStarted: false,
      candidatePact: { pactDigest },
    });
    expect(acceptances).toHaveLength(3);
    expect(packet.latestSequence).toBe(16);
    expect(packet.events).toHaveLength(16);
    expect(
      acceptances.every(
        (acceptance) =>
          acceptance.pactDigest === pactDigest && acceptance.pactVersion === 2,
      ),
    ).toBe(true);
    expect(verifyEventChain(packet.events)).toMatchObject({ valid: true });
    expect(packet.events.map((event) => event.source)).toEqual(
      expect.arrayContaining(["webmcp", "a2a", "system"]),
    );
    expect(packet.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "mission_published",
        "application_submitted",
        "party_reserved",
        "assignment_negotiation_started",
        "capability_bid_submitted",
        "assignment_proposal_submitted",
        "assignment_proposals_resolved",
        "pact_candidate_published",
        "pact_bound",
      ]),
    );
    expect(
      packet.events
        .filter((event) => event.type === "pact_candidate_published")
        .map((event) => event.source),
    ).toEqual(["webmcp", "a2a"]);
    expect(
      packet.events
        .filter((event) => event.type === "application_submitted")
        .map((event) => event.source),
    ).toEqual(["a2a", "a2a"]);
    expect(packet.definition).toMatchObject({
      missionId,
      missionVersion: 1,
      pointReward: 100,
    });
    const inspected = await executeTool(tools, "guild.inspect_mission", {
      missionId,
    });
    expect(inspected).toMatchObject({
      provenance: { transport: "webmcp", trusted: true },
      data: {
        definition: { missionId },
        snapshot: { stage: "EXECUTE", candidatePact: { pactDigest } },
        latestSequence: 16,
      },
    });

    const hostedWorkers = {
      scout: createAgentWorker("scout"),
      scribe: createAgentWorker("scribe"),
      warden: createAgentWorker("warden"),
    } as const;
    const executionFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, { ...init, redirect: "manual" });
      const kind = new URL(request.url).hostname.split(".")[0];
      if (kind !== "scout" && kind !== "scribe" && kind !== "warden") {
        throw new Error(`Unexpected hosted-agent URL ${request.url}`);
      }
      return hostedWorkers[kind].fetch(request, {
        HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS[kind]),
      });
    };
    const execution = await executeBoundDemoMission(
      {
        GUILD_DB: env.GUILD_DB,
        MISSIONS: env.MISSIONS,
        PUBLIC_ORIGIN: ORIGIN,
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-only-placeholder",
        AUTH_COOKIE_SECRET:
          "test-only-cookie-secret-with-at-least-thirty-two-characters",
        SCOUT_A2A_URL: "https://scout.guildhall.test/a2a/v1",
        SCRIBE_A2A_URL: "https://scribe.guildhall.test/a2a/v1",
        WARDEN_A2A_URL: "https://warden.guildhall.test/a2a/v1",
      } as GuildhallEnv,
      missionId,
      true,
      executionFetch,
    );
    expect(execution).toMatchObject({
      executed: true,
      injectedFailure: true,
    });

    packet = await missionPacket(missionId);
    const receipt = ReceiptSchema.parse(packet.receipt);
    const runtimeSlots = requiredRecordArray(packet.snapshot.roleSlots);
    expect(runtimeSlots).toHaveLength(2);
    expect(runtimeSlots.every((slot) => slot.status === "active")).toBe(true);
    expect(
      runtimeSlots.find(
        (slot) => slot.originalAgentId === hostedIdentity("scout").agentId,
      ),
    ).toMatchObject({
      occupantAgentId: hostedIdentity("scout").agentId,
      artifactDelivered: true,
    });
    expect(
      runtimeSlots.find(
        (slot) => slot.originalAgentId === hostedIdentity("scribe").agentId,
      ),
    ).toMatchObject({
      occupantAgentId: hostedIdentity("warden").agentId,
      artifactDelivered: true,
    });
    const acceptedArtifacts = requiredRecordArray(packet.artifacts);
    expect(acceptedArtifacts).toHaveLength(2);
    const producers = acceptedArtifacts.map((artifact) =>
      requiredString(requiredRecord(artifact, "metadata"), "producingAgentId"),
    );
    expect(producers).toContain(hostedIdentity("scout").agentId);
    expect(producers).toContain(hostedIdentity("warden").agentId);
    expect(producers).not.toContain(hostedIdentity("scribe").agentId);
    for (const artifact of acceptedArtifacts) {
      expect(
        requiredInteger(requiredRecord(artifact, "metadata"), "attempt"),
      ).toBe(1);
    }
    expect(packet.snapshot).toMatchObject({
      stage: "RECEIPT",
      terminalOutcome: "completed",
      receiptIssued: true,
    });
    expect(receipt).toMatchObject({
      outcome: "completed",
      reward: {
        basePointsAwarded: 100,
        recoveryBonusAwarded: 10,
        totalPointsAwarded: 110,
      },
      verification: { status: "passed" },
    });
    expect(receipt.defaults).toEqual([
      expect.objectContaining({ agentId: hostedIdentity("scribe").agentId }),
    ]);
    expect(receipt.replacements).toEqual([
      expect.objectContaining({
        predecessorAgentId: hostedIdentity("scribe").agentId,
        replacementAgentId: hostedIdentity("warden").agentId,
      }),
    ]);
    expect(
      receipt.reputationDeltas.reduce(
        (total, delta) => total + delta.pointsDelta,
        0,
      ),
    ).toBe(110);
    expect(receipt.reputationDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: hostedIdentity("scout").agentId,
          pointsDelta: 50,
          reason: "verified-role-output",
        }),
        expect.objectContaining({
          agentId: hostedIdentity("warden").agentId,
          pointsDelta: 60,
          recoveryBonus: 10,
          reason: "verified-replacement-output",
        }),
        expect.objectContaining({
          agentId: hostedIdentity("scribe").agentId,
          pointsDelta: 0,
          reliabilityDelta: -0.1,
          reason: "post-bind-default",
        }),
      ]),
    );
    const eventTypes = packet.events.map((event) => event.type);
    expect(eventTypes.indexOf("role_defaulted")).toBeLessThan(
      eventTypes.indexOf("replacement_bound"),
    );
    expect(eventTypes.indexOf("replacement_bound")).toBeLessThan(
      eventTypes.lastIndexOf("artifact_submitted"),
    );
    expect(eventTypes.slice(-3)).toEqual([
      "verification_started",
      "verification_passed",
      "receipt_issued",
    ]);
    const verifiedChain = verifyEventChain(packet.events);
    expect(verifiedChain).toMatchObject({ valid: true });
    if (!verifiedChain.valid) throw new Error("Event chain did not verify");
    expect(receipt.eventChainHead).toBe(verifiedChain.headHash);

    const issuer = await publicJson<{
      keyId: string;
      publicJwk: JsonWebKey;
    }>("/.well-known/guildhall-issuer-key.json");
    expect(issuer.keyId).toBe(receipt.issuerKeyId);
    const issuerKey = await importEd25519PublicJwk(issuer.publicJwk);
    expect(
      await verifyEd25519(
        issuerKey,
        receiptSigningBytes(
          await canonicalJsonDigest(unsignedReceiptProjection(receipt)),
        ),
        receipt.issuerSignature,
      ),
    ).toBe(true);
    expect(await publicJson(`/api/missions/${missionId}/receipt`)).toEqual({
      receipt,
    });

    const coordinator = env.MISSIONS.getByName(
      missionId,
    ) as DurableObjectStub<MissionCoordinator>;
    const retryDueAt = Date.now() + 60_000;
    await coordinator.scheduleDeadline("a2a_retry", retryDueAt);
    const clock = vi.spyOn(Date, "now").mockReturnValue(retryDueAt + 1);
    try {
      expect(await runDurableObjectAlarm(coordinator)).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect((await missionPacket(missionId)).latestSequence).toBe(
      packet.latestSequence,
    );

    const replay = await executeBoundDemoMission(
      {
        GUILD_DB: env.GUILD_DB,
        MISSIONS: env.MISSIONS,
        PUBLIC_ORIGIN: ORIGIN,
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-only-placeholder",
        AUTH_COOKIE_SECRET:
          "test-only-cookie-secret-with-at-least-thirty-two-characters",
        SCOUT_A2A_URL: "https://scout.guildhall.test/a2a/v1",
        SCRIBE_A2A_URL: "https://scribe.guildhall.test/a2a/v1",
        WARDEN_A2A_URL: "https://warden.guildhall.test/a2a/v1",
      } as GuildhallEnv,
      missionId,
      true,
      executionFetch,
    );
    expect(replay.receiptId).toBe(receipt.receiptId);
    expect((await missionPacket(missionId)).latestSequence).toBe(
      packet.latestSequence,
    );
  }, 30_000);
});

interface BrowserOwner {
  readonly headers: Record<string, string>;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

function browserHandler(
  owner: BrowserOwner,
  rallyAgents?: Readonly<{
    scout: HostedAgentEnv;
    scribe: HostedAgentEnv;
  }>,
) {
  return async (
    input: Readonly<Record<string, unknown>>,
    context: CapabilityInvocationContext,
  ): Promise<Record<string, unknown>> => {
    if (context.actionName === "guild.publish_mission") {
      const mission = MissionSchema.parse({
        protocol: "commitment/v1",
        kind: "mission",
        missionId: crypto.randomUUID(),
        missionVersion: 1,
        requesterAgentId: REQUESTER_ID,
        ...withoutCommandId(input),
        publishedAt: new Date().toISOString(),
      });
      const draft = await ownerPost("/api/drafts", owner.headers, {
        requesterAgentId: REQUESTER_ID,
        title: mission.title,
        payload: mission,
      });
      const result = await ownerPost(
        `/api/webmcp/drafts/${requiredString(draft, "draftId")}/publish`,
        owner.headers,
        {
          requesterAgentId: REQUESTER_ID,
          commandId: context.commandId,
        },
      );
      return normalizeMutation(mission.missionId, result);
    }
    if (context.actionName === "guild.rally_reference_party") {
      if (rallyAgents === undefined) {
        throw new TypeError("The browser fixture has no reference party");
      }
      const response = await handleDemoRallyRoute(
        new Request(`${ORIGIN}/api/demo/rally`, {
          method: "POST",
          headers: { ...owner.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            missionId: requiredString(input, "missionId"),
            requesterAgentId: REQUESTER_ID,
            commandId: context.commandId,
          }),
        }),
        {
          GUILD_DB: env.GUILD_DB,
          MISSIONS: env.MISSIONS,
          PUBLIC_ORIGIN: ORIGIN,
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-only-placeholder-value",
          AUTH_COOKIE_SECRET:
            "test-only-cookie-secret-with-at-least-thirty-two-characters",
          SCOUT_A2A_URL: "https://scout.guildhall.test/a2a/v1",
          SCRIBE_A2A_URL: "https://scribe.guildhall.test/a2a/v1",
          WARDEN_A2A_URL: "https://warden.guildhall.test/a2a/v1",
          GUILD_DEMO_RALLY_SECRET: RALLY_SECRET,
        },
        referenceRallyFetch(rallyAgents),
      );
      if (response === null || !response.ok) {
        throw new Error(
          `Reference rally failed with ${response?.status ?? 404}`,
        );
      }
      return requiredRecord({ value: await response.json() }, "value");
    }
    if (context.actionName === "guild.propose_allocation") {
      if (requiredString(input, "negotiationStep") !== "requester-proposal") {
        throw new TypeError("The browser fixture only authors round one");
      }
      const missionId = requiredString(input, "missionId");
      const packet = await missionPacket(missionId);
      const mission = MissionSchema.parse(packet.definition);
      const proposalRound = requiredInteger(input, "pactVersion");
      const pact = await buildPact({
        mission,
        selectedHelperIds: requiredStringArray(
          packet.snapshot,
          "selectedHelperIds",
        ),
        pactVersion: proposalRound,
        assignments: parseAssignments(input.assignments),
        createdAt: new Date().toISOString(),
      });
      const result = await ownerPost(
        `/api/webmcp/missions/${missionId}/commands`,
        owner.headers,
        {
          commandId: context.commandId,
          expectedSequence: requiredInteger(input, "expectedSequence"),
          actor: { agentId: REQUESTER_ID },
          source: "a2a",
          issuedAt: new Date().toISOString(),
          command: {
            type: "submit_proposal",
            proposerAgentId: REQUESTER_ID,
            proposalRound,
            pactDigest: await canonicalJsonDigest(pact),
            pact,
          },
        },
      );
      return normalizeMutation(missionId, result);
    }
    if (context.actionName === "guild.accept_pact") {
      const missionId = requiredString(input, "missionId");
      const pactDigest = requiredString(input, "pactDigest");
      const acceptedAt = new Date().toISOString();
      const result = await ownerPost(
        `/api/webmcp/missions/${missionId}/commands`,
        owner.headers,
        {
          commandId: context.commandId,
          expectedSequence: requiredInteger(input, "expectedSequence"),
          actor: { agentId: REQUESTER_ID },
          source: "http",
          issuedAt: acceptedAt,
          command: {
            type: "accept_pact",
            agentId: REQUESTER_ID,
            acceptanceId: crypto.randomUUID(),
            keyId: owner.keyId,
            pactVersion: requiredInteger(input, "pactVersion"),
            pactDigest,
            signature: await sign(
              owner.privateKey,
              pactSigningBytes(pactDigest),
            ),
            acceptedAt,
          },
        },
      );
      return normalizeMutation(missionId, result);
    }
    if (context.actionName === "guild.inspect_mission") {
      return { ...(await missionPacket(requiredString(input, "missionId"))) };
    }
    throw new TypeError(`Unexpected WebMCP action ${context.actionName}`);
  };
}

async function seedRequester(): Promise<BrowserOwner> {
  const sessionToken = randomBase64UrlToken();
  const csrfToken = randomBase64UrlToken();
  const now = new Date().toISOString();
  const ownerId = crypto.randomUUID();
  await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId: ownerId,
    githubUserId: 70_001,
    githubLogin: "formation-requester",
    githubAvatarUrl: null,
    sessionHash: await hashOpaqueCredential(sessionToken),
    csrfHash: await hashOpaqueCredential(csrfToken),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: now,
  });
  await createAgent(env.GUILD_DB, {
    agentId: REQUESTER_ID,
    ownerId,
    slug: "formation-requester",
    characterName: "Quest Weaver",
    characterClass: "Artificer",
    technicalName: "WebMCP requester",
    guildName: "Guildhall",
    publicBio: "Publishes bounded public missions.",
    createdAt: now,
  });
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const keyId = await deriveEd25519KeyId("browser", publicJwk);
  await registerAgentKey(env.GUILD_DB, {
    keyId,
    ownerId,
    agentId: REQUESTER_ID,
    publicJwk,
    source: "browser",
    createdAt: now,
  });
  return {
    keyId,
    privateKey: pair.privateKey,
    headers: {
      Cookie: `__Host-guild_session=${sessionToken}; __Host-guild_csrf=${csrfToken}`,
      Origin: ORIGIN,
      "X-Guild-CSRF": csrfToken,
    },
  };
}

async function seedHostedAgent(
  kind: "scout" | "scribe" | "warden",
  githubUserId: number,
  capabilities: readonly string[],
): Promise<{
  readonly env: HostedAgentEnv;
}> {
  const identity = hostedIdentity(kind);
  const ownerId = crypto.randomUUID();
  const now = new Date().toISOString();
  await upsertGithubOwnerAndSession(env.GUILD_DB, {
    proposedOwnerId: ownerId,
    githubUserId,
    githubLogin: `formation-${kind}`,
    githubAvatarUrl: null,
    sessionHash: randomBase64UrlToken(),
    csrfHash: randomBase64UrlToken(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: now,
  });
  await createAgent(env.GUILD_DB, {
    agentId: identity.agentId,
    ownerId,
    slug: `formation-${kind}`,
    characterName:
      kind === "scout" ? "Scout" : kind === "scribe" ? "Scribe" : "Warden",
    characterClass:
      kind === "scout" ? "Ranger" : kind === "scribe" ? "Wizard" : "Paladin",
    technicalName: `${kind} independent A2A worker`,
    guildName: "Reference Agents",
    publicBio: `An independently signed ${kind} agent.`,
    createdAt: now,
  });
  await registerAgentKey(env.GUILD_DB, {
    keyId: identity.keyId,
    ownerId,
    agentId: identity.agentId,
    publicJwk: identity.publicJwk as JsonWebKey,
    source: "a2a",
    createdAt: now,
  });
  for (const capability of capabilities) {
    expect(
      await declareAgentCapability(env.GUILD_DB, {
        ownerId,
        agentId: identity.agentId,
        capability,
        declaredLevel: 90,
        updatedAt: now,
      }),
    ).toBe(true);
  }
  const credential = randomBase64UrlToken();
  await registerScopedCredential(env.GUILD_DB, {
    credentialId: crypto.randomUUID(),
    ownerId,
    agentId: identity.agentId,
    keyId: identity.keyId,
    credentialHash: await hashOpaqueCredential(credential),
    scopes: ["missions:write"],
    expiresAt: null,
    createdAt: now,
  });
  return {
    env: {
      GUILD_BROKER_URL: `${ORIGIN}/a2a/guild/v1`,
      GUILD_AGENT_CREDENTIAL: credential,
      HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS[kind]),
      HOSTED_AGENT_PUBLIC_KEY_X: String(identity.publicJwk.x),
      HOSTED_AGENT_KEY_ID: identity.keyId,
      GUILD_DEMO_RALLY_SECRET: RALLY_SECRET,
    },
  };
}

function referenceRallyFetch(
  agents: Readonly<{ scout: HostedAgentEnv; scribe: HostedAgentEnv }>,
): typeof globalThis.fetch {
  const workers = {
    scout: createAgentWorker("scout", { fetch: localWorkerFetch }),
    scribe: createAgentWorker("scribe", { fetch: localWorkerFetch }),
  } as const;
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "manual" });
    const kind = new URL(request.url).hostname.split(".")[0];
    if (kind !== "scout" && kind !== "scribe") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    return workers[kind].fetch(request, agents[kind]);
  };
}

async function runHostedAgentSchedule(
  kind: "scout" | "scribe",
  hostedEnv: HostedAgentEnv,
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  createAgentWorker(kind, { fetch: localWorkerFetch }).scheduled(
    {
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry(): void {},
    } as ScheduledController,
    hostedEnv,
    {
      waitUntil(promise): void {
        pending.push(promise);
      },
      passThroughOnException(): void {},
      props: {},
    } as ExecutionContext,
  );
  await Promise.all(pending);
}

function allocationInput(
  packet: MissionPacket,
  label: string,
  deliveryDeadline: string,
) {
  const slots = requiredRecordArray(packet.snapshot.roleSlots);
  const scoutSlot = slots.find(
    (slot) => slot.originalAgentId === hostedIdentity("scout").agentId,
  );
  const scribeSlot = slots.find(
    (slot) => slot.originalAgentId === hostedIdentity("scribe").agentId,
  );
  if (scoutSlot === undefined || scribeSlot === undefined) {
    throw new TypeError("Selected role slots are incomplete");
  }
  return {
    assignments: [
      {
        roleSlotId: requiredString(scoutSlot, "roleSlotId"),
        agentId: hostedIdentity("scout").agentId,
        responsibilities: [`${label}: inspect the fixture`],
        requiredCapabilities: ["accessibility-audit"],
        dependencyRoleSlotIds: [],
        outputIds: [FINDINGS_ID],
        verificationCriterionIds: [FINDINGS_CRITERION],
        pointAllocation: 50,
      },
      {
        roleSlotId: requiredString(scribeSlot, "roleSlotId"),
        agentId: hostedIdentity("scribe").agentId,
        responsibilities: [`${label}: map findings to repairs`],
        requiredCapabilities: ["remediation-planning"],
        dependencyRoleSlotIds: [requiredString(scoutSlot, "roleSlotId")],
        outputIds: [PLAN_ID],
        verificationCriterionIds: [PLAN_CRITERION],
        pointAllocation: 50,
      },
    ],
    deliveryDeadline,
    verificationCriterionIds: [FINDINGS_CRITERION, PLAN_CRITERION],
    failureBehavior: failureBehavior(),
  };
}

function failureBehavior() {
  return {
    negotiationTimeout: "reopen-recruitment",
    participantDefault: "recruit-exact-slot-replacement",
    replacementAuthorized: true,
    verificationCorrectionLimit: 1,
  } as const;
}

interface MissionPacket {
  readonly missionId: string;
  readonly definition: unknown;
  readonly snapshot: Record<string, unknown>;
  readonly events: MissionEvent[];
  readonly latestSequence: number;
  readonly artifacts?: unknown;
  readonly receipt?: unknown;
}

async function executeTool(
  tools: ReadonlyMap<string, ModelContextTool>,
  name: GuildCapabilityName,
  input: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  if (tool === undefined) throw new TypeError(`WebMCP tool ${name} is missing`);
  const output = await tool.execute(input, {
    signal: new AbortController().signal,
  });
  return requiredRecord({ output }, "output");
}

async function normalizeMutation(
  missionId: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const packet = await missionPacket(missionId);
  const event = packet.events.at(-1) ?? {};
  const candidate = optionalRecord(packet.snapshot.candidatePact);
  const pact = optionalRecord(candidate?.pact);
  return {
    missionId,
    sequence: packet.latestSequence,
    missionVersion: requiredInteger(packet.snapshot, "missionVersion"),
    pactVersion: pact === null ? null : requiredInteger(pact, "pactVersion"),
    displayState: requiredString(event, "displayState"),
    event,
    result,
    replayed: false,
    catalogPending: false,
  };
}

async function missionPacket(missionId: string): Promise<MissionPacket> {
  return publicJson<MissionPacket>(`/api/missions/${missionId}`);
}

async function ownerPost(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Owner request ${path} failed: ${JSON.stringify(value)}`);
  }
  return requiredRecord({ value }, "value");
}

async function publicJson<T>(path: string): Promise<T> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`));
  if (!response.ok) throw new Error(`Public request ${path} failed`);
  return (await response.json()) as T;
}

const localWorkerFetch: typeof globalThis.fetch = async (input, init) => {
  const { redirect: _redirect, ...requestInit } = init ?? {};
  return worker.fetch(
    new Request(input, { ...requestInit, redirect: "manual" }),
  );
};

function dataRecord(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  return requiredRecord(envelope, "data");
}

function parseAssignments(value: unknown): AllocationAssignment[] {
  return requiredRecordArray(value).map((assignment) => ({
    roleSlotId: requiredString(assignment, "roleSlotId"),
    agentId: requiredString(assignment, "agentId"),
    responsibilities: requiredStringArray(assignment, "responsibilities"),
    requiredCapabilities: requiredStringArray(
      assignment,
      "requiredCapabilities",
    ),
    dependencyRoleSlotIds: requiredStringArray(
      assignment,
      "dependencyRoleSlotIds",
      true,
    ),
    outputIds: requiredStringArray(assignment, "outputIds"),
    verificationCriterionIds: requiredStringArray(
      assignment,
      "verificationCriterionIds",
    ),
    pointAllocation: requiredInteger(assignment, "pointAllocation"),
  }));
}

async function sign(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", key, data)),
  );
}

function withoutCommandId(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "commandId"),
  );
}

function requiredRecord(
  input: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = optionalRecord(input[key]);
  if (value === null) throw new TypeError(`${key} must be an object`);
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an object array");
  return value.map((item) => {
    const record = optionalRecord(item);
    if (record === null) throw new TypeError("Expected an object array");
    return record;
  });
}

function requiredString(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be a string`);
  }
  return value;
}

function requiredInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${key} must be a non-negative integer`);
  }
  return value;
}

function requiredStringArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
  allowEmpty = false,
): string[] {
  const value = input[key];
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TypeError(`${key} must be a string array`);
  }
  return value as string[];
}
