import { describe, expect, it, vi } from "vitest";

import { hostedIdentity } from "../../apps/demo-agent/src/identity";
import {
  createAgentWorker,
  type HostedAgentEnv,
} from "../../apps/demo-agent/src/worker";
import { TEST_PRIVATE_JWKS } from "./fixtures/test-identities";

const MISSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RALLY_SECRET = "rally-secret-that-is-at-least-thirty-two-characters";

describe("hosted-agent rally boundary", () => {
  it("rejects an unauthenticated pulse without exposing its secret", async () => {
    const response = await createAgentWorker("scout").fetch(
      new Request("https://scout.guildhall.test/internal/guildhall/rally", {
        method: "POST",
        headers: { Authorization: "GuildhallRally wrong" },
        body: JSON.stringify({ missionId: MISSION_ID }),
      }),
      configuredEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain(RALLY_SECRET);
  });

  it("runs one mission-scoped autonomous decision when Guildhall rallies it", async () => {
    const recruitmentFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      expect(url.pathname).toBe(`/api/missions/${MISSION_ID}`);
      expect(url.search).toBe("");
      return Response.json({
        definition: { requiredCapabilities: ["unrelated-capability"] },
        events: [{ displayState: "Recruiting" }],
      });
    });
    const response = await createAgentWorker("scout", {
      fetch: recruitmentFetch,
    }).fetch(
      new Request("https://scout.guildhall.test/internal/guildhall/rally", {
        method: "POST",
        headers: {
          Authorization: `GuildhallRally ${RALLY_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ missionId: MISSION_ID }),
      }),
      configuredEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      agent: "scout",
      missionId: MISSION_ID,
      result: { joined: false, reason: "no-matching-mission" },
    });
    expect(recruitmentFetch).toHaveBeenCalledTimes(2);
  });

  it("proves the signing and autonomous bindings at readiness", async () => {
    const response = await createAgentWorker("scout").fetch(
      new Request("https://scout.guildhall.test/ready"),
      configuredEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "guildhall-scout",
      status: "ok",
      protocolCore: "commitment/v1",
      autonomousRecruitmentConfigured: true,
      brokerTransport: "public-http",
    });
  });
});

function configuredEnv(): HostedAgentEnv {
  const identity = hostedIdentity("scout");
  return {
    HOSTED_AGENT_PRIVATE_JWK: JSON.stringify(TEST_PRIVATE_JWKS.scout),
    HOSTED_AGENT_PUBLIC_KEY_X: String(identity.publicJwk.x),
    HOSTED_AGENT_KEY_ID: identity.keyId,
    GUILD_BROKER_URL: "https://guildhall.test/a2a/guild/v1",
    GUILD_AGENT_CREDENTIAL: "credential-with-no-provider-access",
    GUILD_DEMO_RALLY_SECRET: RALLY_SECRET,
  };
}
