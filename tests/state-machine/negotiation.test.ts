import { describe, expect, it } from "vitest";

import {
  acceptPactCandidate,
  applyPreBindChange,
  bindPactCandidate,
  classifyPactChange,
  MATERIAL_PACT_FIELDS,
  NegotiationError,
  proposePactCandidate,
  type MaterialPactTerms,
  type PactAcceptance,
  type PactCandidate,
  type PactTerms,
} from "../../packages/mission-engine/src/negotiation.js";

const DIGEST_A = "A".repeat(43);
const DIGEST_B = "B".repeat(43);
const DIGEST_C = "C".repeat(43);

function materialTerms(
  overrides: Partial<MaterialPactTerms> = {},
): MaterialPactTerms {
  return {
    goal: "Audit the fixture",
    publicInputs: [{ inputId: "fixture", location: "/fixtures/a11y.html" }],
    requiredCapabilities: ["accessibility-audit"],
    partyBounds: { minimum: 1, preferred: 2, maximum: 2 },
    participants: ["requester", "scout", "scribe"],
    roleSlots: ["findings", "remediation"],
    assignments: {
      findings: "Find accessibility violations",
      remediation: "Prepare remediation steps",
    },
    dependencies: { remediation: ["findings"] },
    requiredOutputs: ["findings.json", "remediation.json"],
    formationDeadline: "2026-08-26T16:00:00.000Z",
    deliveryDeadline: "2026-08-26T17:00:00.000Z",
    verification: ["fixture-hash", "rule-coverage"],
    reward: { totalPoints: 100, recoveryBonus: 10 },
    failureBehavior: { participantDefault: "replace-exact-slot" },
    ...overrides,
  };
}

function pactTerms(
  overrides: Partial<MaterialPactTerms> = {},
  title = "The Lighthouse Vault",
): PactTerms {
  return {
    material: materialTerms(overrides),
    presentation: { title, labels: ["featured"] },
  };
}

function firstCandidate(terms = pactTerms()): PactCandidate {
  return proposePactCandidate({
    missionId: "mission-1",
    missionVersion: 1,
    pactDigest: DIGEST_A,
    requesterAgentId: "requester",
    selectedHelperAgentIds: ["scout", "scribe"],
    terms,
  });
}

function acceptance(
  agentId: string,
  candidate: PactCandidate,
  overrides: Partial<PactAcceptance> = {},
): PactAcceptance {
  return {
    agentId,
    pactVersion: candidate.pactVersion,
    pactDigest: candidate.pactDigest,
    signature: `signed-by-${agentId}`,
    ...overrides,
  };
}

describe("two-round candidate construction", () => {
  it("creates one candidate and one counterproposal with monotonic versions", () => {
    const first = firstCandidate();
    const second = proposePactCandidate({
      missionId: first.missionId,
      missionVersion: first.missionVersion,
      pactDigest: DIGEST_B,
      requesterAgentId: first.requesterAgentId,
      selectedHelperAgentIds: first.selectedHelperAgentIds,
      terms: pactTerms({ assignments: { all: "Resolved round two map" } }),
      previous: first,
    });

    expect(first).toMatchObject({ pactVersion: 1, proposalRound: 1 });
    expect(second).toMatchObject({ pactVersion: 2, proposalRound: 2 });
    expect(() =>
      proposePactCandidate({
        missionId: second.missionId,
        missionVersion: second.missionVersion,
        pactDigest: DIGEST_C,
        requesterAgentId: second.requesterAgentId,
        selectedHelperAgentIds: second.selectedHelperAgentIds,
        terms: second.terms,
        previous: second,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "NEGOTIATION_ROUND_LIMIT" }),
    );
  });

  it("does not create a counterproposal for identical bytes or a changed party", () => {
    const first = firstCandidate();
    expect(() =>
      proposePactCandidate({
        missionId: first.missionId,
        missionVersion: first.missionVersion,
        pactDigest: first.pactDigest,
        requesterAgentId: first.requesterAgentId,
        selectedHelperAgentIds: first.selectedHelperAgentIds,
        terms: first.terms,
        previous: first,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UNCHANGED_CANDIDATE_DIGEST" }),
    );
    expect(() =>
      proposePactCandidate({
        missionId: first.missionId,
        missionVersion: first.missionVersion,
        pactDigest: DIGEST_B,
        requesterAgentId: first.requesterAgentId,
        selectedHelperAgentIds: ["scout"],
        terms: first.terms,
        previous: first,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CANDIDATE" }));
  });
});

describe("exact candidate acceptance and binding", () => {
  it("accepts only one exact version and digest per unique agent", () => {
    const candidate = firstCandidate();
    const requesterAcceptance = acceptance("requester", candidate);
    const accepted = acceptPactCandidate(candidate, [], requesterAcceptance);

    expect(() =>
      acceptPactCandidate(candidate, accepted, requesterAcceptance),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ACCEPTANCE" }));
    expect(() =>
      acceptPactCandidate(
        candidate,
        accepted,
        acceptance("scout", candidate, { pactDigest: DIGEST_B }),
      ),
    ).toThrowError(expect.objectContaining({ code: "ACCEPTANCE_MISMATCH" }));
  });

  it("binds exactly the requester and every selected helper", () => {
    const candidate = firstCandidate();
    const acceptances = [
      acceptance("scribe", candidate),
      acceptance("requester", candidate),
      acceptance("scout", candidate),
    ];

    const bound = bindPactCandidate(candidate, acceptances);
    expect(new Set(bound.participantAgentIds)).toEqual(
      new Set(["requester", "scout", "scribe"]),
    );
    expect(bound.candidate.pactDigest).toBe(DIGEST_A);

    expect(() =>
      bindPactCandidate(candidate, acceptances.slice(0, 2)),
    ).toThrowError(
      expect.objectContaining({ code: "PARTICIPANT_SET_MISMATCH" }),
    );
    expect(() =>
      bindPactCandidate(candidate, [
        ...acceptances,
        acceptance("spectator", candidate),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "PARTICIPANT_SET_MISMATCH" }),
    );
  });

  it("rejects mixed digests even when every participant signed something", () => {
    const candidate = firstCandidate();
    expect(() =>
      bindPactCandidate(candidate, [
        acceptance("requester", candidate),
        acceptance("scout", candidate),
        acceptance("scribe", candidate, { pactDigest: DIGEST_B }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "ACCEPTANCE_MISMATCH" }));
  });
});

describe("material pact boundaries", () => {
  it.each(MATERIAL_PACT_FIELDS)("classifies %s as material", (field) => {
    const before = pactTerms();
    const after: PactTerms = {
      material: { ...before.material, [field]: { changed: field } },
      presentation: before.presentation,
    };

    expect(classifyPactChange(before, after)).toEqual({
      material: true,
      changedMaterialFields: [field],
      cosmetic: false,
    });
  });

  it("classifies presentation-only corrections as nonmaterial", () => {
    const before = pactTerms();
    const after = pactTerms({}, "The Lighthouse Vault — corrected spelling");

    expect(classifyPactChange(before, after)).toEqual({
      material: false,
      changedMaterialFields: [],
      cosmetic: true,
    });
  });

  it("invalidates applications and acceptances only for material pre-bind edits", () => {
    const candidate = firstCandidate();
    const records = {
      terms: candidate.terms,
      applications: [
        { applicationId: "application-1", agentId: "scout", missionVersion: 1 },
      ],
      acceptances: [acceptance("requester", candidate)],
    };

    const cosmetic = applyPreBindChange(
      records,
      pactTerms({}, "Corrected display title"),
    );
    expect(cosmetic).toMatchObject({
      requiresNewVersion: false,
      applications: records.applications,
      acceptances: records.acceptances,
      invalidatedApplicationIds: [],
      invalidatedAcceptanceAgentIds: [],
    });

    const material = applyPreBindChange(
      records,
      pactTerms({ deliveryDeadline: "2026-08-26T18:00:00.000Z" }),
    );
    expect(material).toMatchObject({
      requiresNewVersion: true,
      applications: [],
      acceptances: [],
      invalidatedApplicationIds: ["application-1"],
      invalidatedAcceptanceAgentIds: ["requester"],
    });
  });
});

it("exposes stable domain errors", () => {
  expect(new NegotiationError("INVALID_CANDIDATE", "invalid").code).toBe(
    "INVALID_CANDIDATE",
  );
});
