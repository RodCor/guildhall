export const MAX_NEGOTIATION_ROUNDS = 2 as const;
export const MAX_SELECTED_HELPERS = 2 as const;

export const MATERIAL_PACT_FIELDS = [
  "goal",
  "publicInputs",
  "requiredCapabilities",
  "partyBounds",
  "participants",
  "roleSlots",
  "assignments",
  "dependencies",
  "requiredOutputs",
  "formationDeadline",
  "deliveryDeadline",
  "verification",
  "reward",
  "failureBehavior",
] as const;

export type MaterialPactField = (typeof MATERIAL_PACT_FIELDS)[number];

/**
 * The engine intentionally treats material values as JSON-shaped unknowns. Contract
 * validation owns their detailed schemas; this module owns exact change semantics.
 */
export interface MaterialPactTerms {
  readonly goal: unknown;
  readonly publicInputs: unknown;
  readonly requiredCapabilities: unknown;
  readonly partyBounds: unknown;
  readonly participants: unknown;
  readonly roleSlots: unknown;
  readonly assignments: unknown;
  readonly dependencies: unknown;
  readonly requiredOutputs: unknown;
  readonly formationDeadline: unknown;
  readonly deliveryDeadline: unknown;
  readonly verification: unknown;
  readonly reward: unknown;
  readonly failureBehavior: unknown;
}

export interface CosmeticPactPresentation {
  readonly title?: string;
  readonly summary?: string;
  readonly labels?: readonly string[];
  readonly displayNotes?: string;
}

export interface PactTerms {
  readonly material: MaterialPactTerms;
  readonly presentation?: CosmeticPactPresentation;
}

export interface PactChangeClassification {
  readonly material: boolean;
  readonly changedMaterialFields: readonly MaterialPactField[];
  readonly cosmetic: boolean;
}

export interface PactCandidate {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly pactVersion: number;
  readonly proposalRound: number;
  readonly pactDigest: string;
  readonly requesterAgentId: string;
  readonly selectedHelperAgentIds: readonly string[];
  readonly terms: PactTerms;
}

export interface CandidateProposal {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly pactDigest: string;
  readonly requesterAgentId: string;
  readonly selectedHelperAgentIds: readonly string[];
  readonly terms: PactTerms;
  readonly previous?: PactCandidate;
}

export interface PactAcceptance {
  readonly agentId: string;
  readonly pactVersion: number;
  readonly pactDigest: string;
  readonly signature: string;
}

export interface BoundPact {
  readonly candidate: PactCandidate;
  readonly participantAgentIds: readonly string[];
  readonly acceptances: readonly PactAcceptance[];
}

export interface MissionApplicationRef {
  readonly applicationId: string;
  readonly agentId: string;
  readonly missionVersion: number;
}

export interface PreBindRecords {
  readonly terms: PactTerms;
  readonly applications: readonly MissionApplicationRef[];
  readonly acceptances: readonly PactAcceptance[];
}

export interface PreBindChangeResult extends PreBindRecords {
  readonly classification: PactChangeClassification;
  readonly requiresNewVersion: boolean;
  readonly invalidatedApplicationIds: readonly string[];
  readonly invalidatedAcceptanceAgentIds: readonly string[];
}

export type NegotiationErrorCode =
  | "INVALID_CANDIDATE"
  | "NEGOTIATION_ROUND_LIMIT"
  | "UNCHANGED_CANDIDATE_DIGEST"
  | "ACCEPTANCE_MISMATCH"
  | "DUPLICATE_ACCEPTANCE"
  | "PARTICIPANT_SET_MISMATCH";

export class NegotiationError extends Error {
  readonly code: NegotiationErrorCode;

  constructor(code: NegotiationErrorCode, message: string) {
    super(message);
    this.name = "NegotiationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    return (
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    !leftKeys.every((key, index) => key === rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) => structurallyEqual(left[key], right[key]));
}

function assertIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new NegotiationError(
      "INVALID_CANDIDATE",
      `${label} must not be empty`,
    );
  }
}

function assertSha256Digest(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new NegotiationError(
      "INVALID_CANDIDATE",
      "pactDigest must be an unpadded base64url SHA-256 digest",
    );
  }
}

function assertSelectedParty(
  requesterAgentId: string,
  selectedHelperAgentIds: readonly string[],
): void {
  assertIdentifier(requesterAgentId, "requesterAgentId");
  if (
    selectedHelperAgentIds.length < 1 ||
    selectedHelperAgentIds.length > MAX_SELECTED_HELPERS
  ) {
    throw new NegotiationError(
      "INVALID_CANDIDATE",
      "A candidate requires one or two selected helpers",
    );
  }

  const helpers = new Set(selectedHelperAgentIds);
  if (
    helpers.size !== selectedHelperAgentIds.length ||
    helpers.has(requesterAgentId)
  ) {
    throw new NegotiationError(
      "INVALID_CANDIDATE",
      "Requester and selected helper identities must be unique",
    );
  }
  for (const helperAgentId of selectedHelperAgentIds) {
    assertIdentifier(helperAgentId, "selectedHelperAgentId");
  }
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

export function classifyPactChange(
  before: PactTerms,
  after: PactTerms,
): PactChangeClassification {
  const changedMaterialFields = MATERIAL_PACT_FIELDS.filter(
    (field) =>
      !structurallyEqual(before.material[field], after.material[field]),
  );

  return {
    material: changedMaterialFields.length > 0,
    changedMaterialFields,
    cosmetic: !structurallyEqual(before.presentation, after.presentation),
  };
}

/**
 * Creates an initial candidate or its sole counterproposal. A negotiation may
 * therefore expose at most two candidate versions.
 */
export function proposePactCandidate(
  proposal: CandidateProposal,
): PactCandidate {
  assertIdentifier(proposal.missionId, "missionId");
  assertSha256Digest(proposal.pactDigest);
  assertSelectedParty(
    proposal.requesterAgentId,
    proposal.selectedHelperAgentIds,
  );
  if (
    !Number.isSafeInteger(proposal.missionVersion) ||
    proposal.missionVersion < 1
  ) {
    throw new NegotiationError(
      "INVALID_CANDIDATE",
      "missionVersion must be a positive safe integer",
    );
  }

  const previous = proposal.previous;
  if (previous === undefined) {
    return {
      missionId: proposal.missionId,
      missionVersion: proposal.missionVersion,
      pactVersion: 1,
      proposalRound: 1,
      pactDigest: proposal.pactDigest,
      requesterAgentId: proposal.requesterAgentId,
      selectedHelperAgentIds: [...proposal.selectedHelperAgentIds],
      terms: proposal.terms,
    };
  }

  if (previous.proposalRound >= MAX_NEGOTIATION_ROUNDS) {
    throw new NegotiationError(
      "NEGOTIATION_ROUND_LIMIT",
      "Negotiation permits at most two proposal rounds",
    );
  }
  if (
    previous.missionId !== proposal.missionId ||
    previous.missionVersion !== proposal.missionVersion ||
    previous.requesterAgentId !== proposal.requesterAgentId ||
    !sameStringSet(
      previous.selectedHelperAgentIds,
      proposal.selectedHelperAgentIds,
    )
  ) {
    throw new NegotiationError(
      "INVALID_CANDIDATE",
      "A counterproposal cannot change the mission version or selected party",
    );
  }
  if (previous.pactDigest === proposal.pactDigest) {
    throw new NegotiationError(
      "UNCHANGED_CANDIDATE_DIGEST",
      "A counterproposal must produce a new pact digest",
    );
  }

  return {
    missionId: proposal.missionId,
    missionVersion: proposal.missionVersion,
    pactVersion: previous.pactVersion + 1,
    proposalRound: previous.proposalRound + 1,
    pactDigest: proposal.pactDigest,
    requesterAgentId: proposal.requesterAgentId,
    selectedHelperAgentIds: [...proposal.selectedHelperAgentIds],
    terms: proposal.terms,
  };
}

export function acceptPactCandidate(
  candidate: PactCandidate,
  existing: readonly PactAcceptance[],
  acceptance: PactAcceptance,
): readonly PactAcceptance[] {
  assertIdentifier(acceptance.agentId, "acceptance.agentId");
  if (acceptance.signature.trim().length === 0) {
    throw new NegotiationError(
      "ACCEPTANCE_MISMATCH",
      "An acceptance must include a signature",
    );
  }

  const allAcceptances = [...existing, acceptance];
  if (
    allAcceptances.some(
      (entry) =>
        entry.pactVersion !== candidate.pactVersion ||
        entry.pactDigest !== candidate.pactDigest,
    )
  ) {
    throw new NegotiationError(
      "ACCEPTANCE_MISMATCH",
      "Every acceptance must target the exact candidate version and digest",
    );
  }
  if (existing.some((entry) => entry.agentId === acceptance.agentId)) {
    throw new NegotiationError(
      "DUPLICATE_ACCEPTANCE",
      "An agent can accept a candidate only once",
    );
  }

  return allAcceptances;
}

export function bindPactCandidate(
  candidate: PactCandidate,
  acceptances: readonly PactAcceptance[],
): BoundPact {
  const participantAgentIds = [
    candidate.requesterAgentId,
    ...candidate.selectedHelperAgentIds,
  ];
  const acceptedAgentIds = acceptances.map((acceptance) => acceptance.agentId);
  const uniqueAcceptedAgentIds = new Set(acceptedAgentIds);

  if (
    acceptances.some(
      (acceptance) =>
        acceptance.pactVersion !== candidate.pactVersion ||
        acceptance.pactDigest !== candidate.pactDigest,
    )
  ) {
    throw new NegotiationError(
      "ACCEPTANCE_MISMATCH",
      "Mixed pact versions or digests cannot bind",
    );
  }
  if (uniqueAcceptedAgentIds.size !== acceptances.length) {
    throw new NegotiationError(
      "DUPLICATE_ACCEPTANCE",
      "Binding requires unique agent acceptances",
    );
  }
  if (!sameStringSet(participantAgentIds, acceptedAgentIds)) {
    throw new NegotiationError(
      "PARTICIPANT_SET_MISMATCH",
      "Binding requires exactly the requester and every selected helper",
    );
  }

  return {
    candidate,
    participantAgentIds,
    acceptances: [...acceptances],
  };
}

/**
 * Material pre-bind edits invalidate both applications tied to the previous
 * mission version and acceptances tied to the previous candidate. Cosmetic
 * presentation edits preserve both sets.
 */
export function applyPreBindChange(
  records: PreBindRecords,
  nextTerms: PactTerms,
): PreBindChangeResult {
  const classification = classifyPactChange(records.terms, nextTerms);
  if (!classification.material) {
    return {
      terms: nextTerms,
      applications: [...records.applications],
      acceptances: [...records.acceptances],
      classification,
      requiresNewVersion: false,
      invalidatedApplicationIds: [],
      invalidatedAcceptanceAgentIds: [],
    };
  }

  return {
    terms: nextTerms,
    applications: [],
    acceptances: [],
    classification,
    requiresNewVersion: true,
    invalidatedApplicationIds: records.applications.map(
      (application) => application.applicationId,
    ),
    invalidatedAcceptanceAgentIds: records.acceptances.map(
      (acceptance) => acceptance.agentId,
    ),
  };
}
