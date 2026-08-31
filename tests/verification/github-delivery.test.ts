import { describe, expect, it, vi } from "vitest";

import {
  PactSchema,
  type ArtifactMetadata,
  type Pact,
} from "../../packages/contracts/src/index.js";
import {
  canonicalJsonDigestSync,
  verifyGitHubPullRequestDelivery,
  type GitHubDeliveryVerificationInput,
  type VerificationArtifact,
} from "../../packages/trust-engine/src/index.js";

const MISSION_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTER_ID = "10000000-0000-4000-8000-000000000002";
const HELPER_ID = "10000000-0000-4000-8000-000000000003";
const SLOT_ID = "10000000-0000-4000-8000-000000000004";
const OUTPUT_ID = "10000000-0000-4000-8000-000000000005";
const CRITERION_ID = "10000000-0000-4000-8000-000000000006";
const ARTIFACT_ID = "10000000-0000-4000-8000-000000000007";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const SIGNATURE =
  "geeS8OfkZu58SbruseOyMNxOx99WeNxotlKprYIsx-wJumv1iMANhB8JidULFPmTjDs-wuATE4w6vJ0URig2IA";

describe("public GitHub pull-request verifier", () => {
  it("passes the signed PR, exact head SHA, base ref, and successful checks", async () => {
    const fetch = githubFetch();
    const result = await verifyGitHubPullRequestDelivery(validInput(), fetch);

    expect(result.status).toBe("passed");
    expect(result.verifier.verifierId).toBe("github-pull-request-v1");
    expect(result.criteria[0]?.status).toBe("passed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/kimetsu-ai/guildhall/pulls/42",
    );
  });

  it("rejects a public PR whose actual head does not match signed evidence", async () => {
    const result = await verifyGitHubPullRequestDelivery(
      validInput(),
      githubFetch({ actualHeadSha: "f".repeat(40) }),
    );

    expect(result.status).toBe("failed");
    expect(result.criteria[0]?.evidence).toContain("PR_HEAD_SHA_MISMATCH");
  });

  it("rejects unsuccessful repository check runs", async () => {
    const result = await verifyGitHubPullRequestDelivery(
      validInput(),
      githubFetch({ checkConclusion: "failure" }),
    );

    expect(result.status).toBe("failed");
    expect(result.criteria[0]?.evidence).toContain("CHECK_RUNS_NOT_SUCCESSFUL");
  });

  it("defers without consuming correction when GitHub is unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ message: "unavailable" }, { status: 503 }),
    );
    const result = await verifyGitHubPullRequestDelivery(validInput(2), fetch);

    expect(result.status).toBe("infrastructure-pending");
    expect(result.infrastructureStatus).toBe("unavailable");
    expect(result.correctionConsumed).toBe(false);
  });

  it("rejects an oversized streamed response without a content-length header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("x".repeat(513 * 1024), { status: 200 }),
    );
    const result = await verifyGitHubPullRequestDelivery(validInput(), fetch);

    expect(result.status).toBe("failed");
    expect(result.criteria[0]?.evidence).toContain("GITHUB_RESPONSE_TOO_LARGE");
  });
});

function validInput(attempt: 1 | 2 = 1): GitHubDeliveryVerificationInput {
  const pact = githubPact();
  return {
    verificationRunId: "10000000-0000-4000-8000-000000000008",
    pact,
    pactDigest: canonicalJsonDigestSync(pact),
    attempt,
    artifacts: [githubArtifact(pact, attempt)],
    infrastructureStatus: "available",
    startedAt: "2026-08-31T12:00:00.000Z",
    completedAt: "2026-08-31T12:00:01.000Z",
  };
}

function githubPact(): Pact {
  return PactSchema.parse({
    protocol: "commitment/v1",
    kind: "pact",
    pactId: "10000000-0000-4000-8000-000000000009",
    missionId: MISSION_ID,
    missionVersion: 1,
    pactVersion: 1,
    goal: "Deliver a tested code change through a public pull request.",
    publicInputs: [
      {
        inputId: "10000000-0000-4000-8000-000000000010",
        type: "url",
        location: "https://github.com/kimetsu-ai/guildhall/issues/1",
        mediaType: "text/html",
        contentDigest: "D".repeat(43),
      },
    ],
    executionTarget: {
      kind: "github",
      repository: "kimetsu-ai/guildhall",
      baseRef: "main",
      writeMode: "fork-pr",
      checkPolicy: "all-success",
    },
    minimumPartySize: 1,
    maximumPartySize: 1,
    participants: [
      { agentId: REQUESTER_ID, role: "requester" },
      { agentId: HELPER_ID, role: "helper" },
    ],
    roleSlots: [
      {
        roleSlotId: SLOT_ID,
        originalAgentId: HELPER_ID,
        assignment: "Implement the public issue and open a pull request.",
        requiredCapabilities: ["typescript"],
        dependencyRoleSlotIds: [],
        requiredOutputIds: [OUTPUT_ID],
        verificationCriterionIds: [CRITERION_ID],
        pointAllocation: 100,
      },
    ],
    requiredOutputs: [
      {
        outputId: OUTPUT_ID,
        type: "code-change",
        mediaType: "application/json",
        publicLocation: "mission-artifact",
        delivery: { kind: "github-pull-request" },
      },
    ],
    formationDeadline: "2026-08-31T13:00:00.000Z",
    deliveryDeadline: "2026-08-31T15:00:00.000Z",
    verificationCriteria: [
      {
        criterionId: CRITERION_ID,
        description:
          "The public PR head and repository checks match the delivery.",
        required: true,
        method: "public-github",
      },
    ],
    reward: {
      totalPoints: 100,
      replacementRecoveryBonus: 10,
      transferable: false,
      redeemable: false,
    },
    failureBehavior: {
      negotiationTimeout: "reopen-recruitment",
      participantDefault: "recruit-exact-slot-replacement",
      replacementAuthorized: true,
      verificationCorrectionLimit: 1,
    },
    createdAt: "2026-08-31T12:00:00.000Z",
  });
}

function githubArtifact(pact: Pact, attempt: 1 | 2): VerificationArtifact {
  const content = {
    protocol: "commitment/v1",
    kind: "code-change",
    summary: "Adds the requested delivery-target behavior.",
  };
  const metadata: ArtifactMetadata = {
    protocol: "commitment/v1",
    kind: "artifact-metadata",
    artifactId: ARTIFACT_ID,
    missionId: MISSION_ID,
    pactDigest: canonicalJsonDigestSync(pact),
    roleSlotId: SLOT_ID,
    producingAgentId: HELPER_ID,
    keyId: "10000000-0000-4000-8000-000000000011",
    attempt,
    artifactType: "code-change",
    mediaType: "application/json",
    publicLocation: `https://guildhall.example/artifacts/${ARTIFACT_ID}`,
    deliveryEvidence: {
      kind: "github-pull-request",
      repository: "kimetsu-ai/guildhall",
      pullRequestUrl: "https://github.com/kimetsu-ai/guildhall/pull/42",
      baseRef: "main",
      headSha: HEAD_SHA,
      checks: [
        {
          name: "test",
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.com/kimetsu-ai/guildhall/actions/runs/1",
        },
      ],
    },
    contentDigest: canonicalJsonDigestSync(content),
    signature: SIGNATURE,
    safetyStatus: "approved",
    completedAt: "2026-08-31T12:00:00.500Z",
  };
  return {
    outputId: OUTPUT_ID,
    metadata,
    content,
    dependencyArtifactIds: [],
  };
}

function githubFetch(
  options: {
    readonly actualHeadSha?: string;
    readonly checkConclusion?: string;
  } = {},
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async (resource) => {
    const url = typeof resource === "string" ? resource : resource.toString();
    if (url.includes("/pulls/42")) {
      return Response.json({
        html_url: "https://github.com/kimetsu-ai/guildhall/pull/42",
        state: "open",
        draft: false,
        merged: false,
        head: { sha: options.actualHeadSha ?? HEAD_SHA },
        base: { ref: "main", repo: { full_name: "kimetsu-ai/guildhall" } },
      });
    }
    return Response.json({
      check_runs: [
        {
          name: "test",
          status: "completed",
          conclusion: options.checkConclusion ?? "success",
          details_url: "https://github.com/kimetsu-ai/guildhall/actions/runs/1",
        },
      ],
    });
  });
}
