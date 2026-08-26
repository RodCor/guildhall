import {
  COMMITMENT_V1_EXTENSION_URI,
  createA2AHttpJsonClient,
  type A2ASendMessageResponse,
  type JsonObject,
} from "@guildhall/a2a-worker";
import {
  PactSchema,
  canonicalJsonDigest,
  pactSigningBytes,
} from "@guildhall/contracts";
import { createAgentRequestSignatureMessage } from "@guildhall/trust-engine";

import type { HostedAgentKind } from "./agent-card";
import { hostedIdentity, parseHostedPrivateJwk } from "./identity";

export interface GuildConnection {
  readonly brokerBaseUrl: string;
  readonly credential: string;
  readonly privateJwk: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowInsecureHttp?: boolean;
  readonly now?: () => Date;
}

export interface GuildApplication {
  readonly missionId: string;
  readonly expectedSequence: number;
  readonly missionVersion: number;
  readonly relevantCapabilities: readonly string[];
  readonly proposedContribution: string;
  readonly availability: {
    readonly availableFrom: string;
    readonly availableUntil: string;
  };
}

export interface AutonomousRecruitmentResult {
  readonly joined: boolean;
  readonly missionId?: string;
  readonly action?:
    | "application"
    | "capability-bid"
    | "assignment-proposal"
    | "pact-acceptance";
  readonly reason?: "no-matching-mission" | "already-applied";
}

const INTERESTS: Readonly<Record<HostedAgentKind, readonly string[]>> = {
  scout: ["accessibility-audit"],
  scribe: ["remediation-planning"],
  warden: ["deterministic-verification"],
};

/** Polls public state and signs one autonomous application/negotiation step. */
export async function autonomouslyJoinGuildMission(
  kind: HostedAgentKind,
  connection: GuildConnection,
): Promise<AutonomousRecruitmentResult> {
  const fetchImpl = connection.fetch ?? globalThis.fetch;
  const broker = new URL(connection.brokerBaseUrl);
  const interests = INTERESTS[kind];
  const negotiation = await advanceNegotiatingMission(
    kind,
    connection,
    fetchImpl,
    broker.origin,
    interests,
  );
  if (negotiation !== null) return negotiation;
  for (const capability of interests) {
    const catalogUrl = new URL("/api/missions", broker.origin);
    catalogUrl.searchParams.set("capability", capability);
    catalogUrl.searchParams.set("displayState", "Recruiting");
    catalogUrl.searchParams.set("limit", "10");
    const catalog = await publicRecord(fetchImpl, catalogUrl);
    const missions = Array.isArray(catalog.missions) ? catalog.missions : [];
    for (const cardValue of missions) {
      const card = record(cardValue);
      if (card === null || typeof card.missionId !== "string") continue;
      const packet = await publicRecord(
        fetchImpl,
        new URL(
          `/api/missions/${encodeURIComponent(card.missionId)}`,
          broker.origin,
        ),
      );
      const snapshot = record(packet.snapshot);
      const definition = record(packet.definition);
      const identity = hostedIdentity(kind);
      if (snapshot === null || definition === null) continue;
      const applications = Array.isArray(snapshot.applicationAgentIds)
        ? snapshot.applicationAgentIds
        : [];
      if (applications.includes(identity.agentId)) {
        return {
          joined: false,
          missionId: card.missionId,
          reason: "already-applied",
        };
      }
      const latestSequence = packet.latestSequence;
      const missionVersion = definition.missionVersion;
      const deliveryDeadline = definition.deliveryDeadline;
      if (
        typeof latestSequence !== "number" ||
        !Number.isSafeInteger(latestSequence) ||
        typeof missionVersion !== "number" ||
        !Number.isSafeInteger(missionVersion) ||
        typeof deliveryDeadline !== "string" ||
        !Number.isFinite(Date.parse(deliveryDeadline))
      ) {
        continue;
      }
      const now = connection.now?.() ?? new Date();
      const response = await applyToGuildMission(kind, connection, {
        missionId: card.missionId,
        expectedSequence: latestSequence,
        missionVersion,
        relevantCapabilities: [capability],
        proposedContribution: contribution(kind),
        availability: {
          availableFrom: new Date(now.getTime() - 60_000).toISOString(),
          availableUntil: new Date(
            Date.parse(deliveryDeadline) + 60 * 60_000,
          ).toISOString(),
        },
      });
      if (
        "task" in response &&
        response.task.status.state === "TASK_STATE_COMPLETED"
      ) {
        return {
          joined: true,
          missionId: card.missionId,
          action: "application",
        };
      }
    }
  }
  return { joined: false, reason: "no-matching-mission" };
}

async function advanceNegotiatingMission(
  kind: HostedAgentKind,
  connection: GuildConnection,
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  interests: readonly string[],
): Promise<AutonomousRecruitmentResult | null> {
  for (const capability of interests) {
    const catalogUrl = new URL("/api/missions", origin);
    catalogUrl.searchParams.set("capability", capability);
    catalogUrl.searchParams.set("displayState", "Negotiating");
    catalogUrl.searchParams.set("limit", "10");
    const catalog = await publicRecord(fetchImpl, catalogUrl);
    const missions = Array.isArray(catalog.missions) ? catalog.missions : [];
    for (const cardValue of missions) {
      const card = record(cardValue);
      if (card === null || typeof card.missionId !== "string") continue;
      const packet = await publicRecord(
        fetchImpl,
        new URL(`/api/missions/${encodeURIComponent(card.missionId)}`, origin),
      );
      const snapshot = record(packet.snapshot);
      const definition = record(packet.definition);
      const identity = hostedIdentity(kind);
      if (snapshot === null || definition === null) continue;
      const selectedHelperIds = stringValues(snapshot.selectedHelperIds);
      if (!selectedHelperIds.includes(identity.agentId)) continue;
      const latestSequence = safeInteger(packet.latestSequence);
      if (latestSequence === null) continue;
      const capabilityBids = records(snapshot.capabilityBids);
      if (
        snapshot.stage === "RESERVE" &&
        !capabilityBids.some((bid) => bid.agentId === identity.agentId)
      ) {
        const relevantCapabilities = interests.filter((interest) =>
          stringValues(definition.requiredCapabilities).includes(interest),
        );
        if (relevantCapabilities.length === 0) continue;
        const response = await sendGuildAction(kind, connection, {
          action: "guild.propose_allocation",
          missionId: card.missionId,
          input: {
            missionId: card.missionId,
            expectedSequence: latestSequence,
            negotiationStep: "capability-bid",
            relevantCapabilities,
            proposedContribution: contribution(kind),
          },
        });
        if (completed(response)) {
          return {
            joined: true,
            missionId: card.missionId,
            action: "capability-bid",
          };
        }
      }
      const candidate = record(snapshot.candidatePact);
      const assignmentProposals = records(snapshot.assignmentProposals);
      if (
        snapshot.stage === "COMMIT" &&
        record(candidate?.pact)?.pactVersion === 1 &&
        capabilityBids.length === selectedHelperIds.length &&
        !assignmentProposals.some(
          (proposal) => proposal.proposerAgentId === identity.agentId,
        )
      ) {
        const allocation = autonomousAllocation(
          definition,
          snapshot,
          selectedHelperIds,
          capabilityBids,
        );
        if (allocation === null) continue;
        const response = await sendGuildAction(kind, connection, {
          action: "guild.propose_allocation",
          missionId: card.missionId,
          input: {
            missionId: card.missionId,
            expectedSequence: latestSequence,
            negotiationStep: "assignment-proposal",
            pactVersion: 2,
            ...allocation,
          },
        });
        if (completed(response)) {
          return {
            joined: true,
            missionId: card.missionId,
            action: "assignment-proposal",
          };
        }
      }
      const acceptance = await stableAutonomousAcceptance({
        missionId: card.missionId,
        agentId: identity.agentId,
        keyId: identity.keyId,
        snapshot,
        selectedHelperIds,
        capabilityBids,
        assignmentProposals,
      });
      if (acceptance !== null) {
        const response = await acceptGuildPact(kind, connection, {
          missionId: card.missionId,
          expectedSequence: latestSequence,
          pactVersion: 2,
          pactDigest: acceptance.pactDigest,
        });
        if (completed(response)) {
          return {
            joined: true,
            missionId: card.missionId,
            action: "pact-acceptance",
          };
        }
      }
    }
  }
  return null;
}

export async function stableAutonomousAcceptance(input: {
  readonly missionId: string;
  readonly agentId: string;
  readonly keyId: string;
  readonly snapshot: Record<string, unknown>;
  readonly selectedHelperIds: readonly string[];
  readonly capabilityBids: readonly Record<string, unknown>[];
  readonly assignmentProposals: readonly Record<string, unknown>[];
}): Promise<{ readonly pactDigest: string } | null> {
  if (
    input.snapshot.stage !== "COMMIT" ||
    input.selectedHelperIds.length === 0 ||
    new Set(input.selectedHelperIds).size !== input.selectedHelperIds.length
  ) {
    return null;
  }
  const candidate = record(input.snapshot.candidatePact);
  const resolution = record(input.snapshot.assignmentResolution);
  const acceptances = record(input.snapshot.acceptances);
  const proposalHistory = records(input.snapshot.proposalHistory);
  if (
    candidate === null ||
    resolution === null ||
    acceptances === null ||
    acceptances[input.agentId] !== undefined ||
    candidate.proposalRound !== 2 ||
    proposalHistory.length !== 2
  ) {
    return null;
  }
  const pactResult = PactSchema.safeParse(candidate.pact);
  if (!pactResult.success) return null;
  const pact = pactResult.data;
  const pactDigest = candidate.pactDigest;
  if (
    pact.pactVersion !== 2 ||
    pact.missionId !== input.missionId ||
    typeof pactDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(pactDigest) ||
    (await canonicalJsonDigest(pact)) !== pactDigest ||
    record(proposalHistory[1])?.pactDigest !== pactDigest ||
    resolution.selectedProposalAgentId !== candidate.proposerAgentId
  ) {
    return null;
  }

  const helperParticipantIds = pact.participants.flatMap((participant) =>
    participant.role === "helper" ? [participant.agentId] : [],
  );
  const slotAgentIds = pact.roleSlots.map((slot) => slot.originalAgentId);
  const reservedSlots = records(input.snapshot.roleSlots);
  if (
    !sameStringSet(helperParticipantIds, input.selectedHelperIds) ||
    !sameStringSet(slotAgentIds, input.selectedHelperIds) ||
    reservedSlots.length !== pact.roleSlots.length ||
    pact.roleSlots.some(
      (slot) =>
        !reservedSlots.some(
          (reserved) =>
            reserved.roleSlotId === slot.roleSlotId &&
            reserved.originalAgentId === slot.originalAgentId,
        ),
    )
  ) {
    return null;
  }
  const ownSlots = pact.roleSlots.filter(
    (slot) => slot.originalAgentId === input.agentId,
  );
  const ownBid = input.capabilityBids.find(
    (bid) => bid.agentId === input.agentId && bid.keyId === input.keyId,
  );
  if (
    ownSlots.length !== 1 ||
    ownBid === undefined ||
    !ownSlots[0]!.requiredCapabilities.every((capability) =>
      stringValues(ownBid.relevantCapabilities).includes(capability),
    )
  ) {
    return null;
  }

  const orderedProposals = input.selectedHelperIds.map((agentId) =>
    input.assignmentProposals.find(
      (proposal) => proposal.proposerAgentId === agentId,
    ),
  );
  if (orderedProposals.some((proposal) => proposal === undefined)) return null;
  const consideredAgentIds = stringValues(
    resolution.consideredProposalAgentIds,
  );
  const consideredPactDigests = stringValues(resolution.consideredPactDigests);
  if (!sameStrings(consideredAgentIds, input.selectedHelperIds)) return null;

  const proposalDigests: string[] = [];
  for (const proposal of orderedProposals) {
    if (
      proposal === undefined ||
      proposal.proposalRound !== 2 ||
      typeof proposal.pactDigest !== "string"
    ) {
      return null;
    }
    const proposalPact = PactSchema.safeParse(proposal.pact);
    if (
      !proposalPact.success ||
      proposalPact.data.missionId !== input.missionId ||
      proposalPact.data.pactVersion !== 2 ||
      (await canonicalJsonDigest(proposalPact.data)) !== proposal.pactDigest
    ) {
      return null;
    }
    proposalDigests.push(proposal.pactDigest);
  }
  const ownProposal = orderedProposals.find(
    (proposal) => proposal?.proposerAgentId === input.agentId,
  );
  const selectedProposal = orderedProposals.find(
    (proposal) =>
      proposal?.proposerAgentId === resolution.selectedProposalAgentId,
  );
  if (
    ownProposal?.keyId !== input.keyId ||
    ownProposal.pactDigest !== pactDigest ||
    selectedProposal?.pactDigest !== pactDigest ||
    !sameStrings(consideredPactDigests, proposalDigests)
  ) {
    return null;
  }
  return { pactDigest };
}

function autonomousAllocation(
  definition: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  selectedHelperIds: readonly string[],
  capabilityBids: readonly Record<string, unknown>[],
): JsonObject | null {
  const slots = records(snapshot.roleSlots);
  const outputs = records(definition.requiredOutputs);
  const criteria = records(definition.verificationCriteria);
  const totalPoints = safeInteger(definition.pointReward);
  const deliveryDeadline = definition.deliveryDeadline;
  const failureBehavior = record(definition.failureBehavior);
  if (
    slots.length !== selectedHelperIds.length ||
    outputs.length === 0 ||
    criteria.length === 0 ||
    totalPoints === null ||
    totalPoints < selectedHelperIds.length ||
    typeof deliveryDeadline !== "string" ||
    failureBehavior === null
  ) {
    return null;
  }
  const basePoints = Math.floor(totalPoints / selectedHelperIds.length);
  const assignments: JsonObject[] = [];
  for (const [index, agentId] of selectedHelperIds.entries()) {
    const slot = slots.find((item) => item.originalAgentId === agentId);
    const bid = capabilityBids.find((item) => item.agentId === agentId);
    const priorSlot =
      index === 0
        ? undefined
        : slots.find(
            (item) => item.originalAgentId === selectedHelperIds[index - 1],
          );
    const assignedOutputs = outputs.filter(
      (_output, outputIndex) =>
        outputIndex % selectedHelperIds.length === index,
    );
    const assignedCriteria = criteria.filter(
      (_criterion, criterionIndex) =>
        criterionIndex % selectedHelperIds.length === index,
    );
    const outputIds = (
      assignedOutputs.length === 0 ? [outputs[0]!] : assignedOutputs
    ).flatMap((output) =>
      typeof output.outputId === "string" ? [output.outputId] : [],
    );
    const criterionIds = (
      assignedCriteria.length === 0 ? [criteria[0]!] : assignedCriteria
    ).flatMap((criterion) =>
      typeof criterion.criterionId === "string" ? [criterion.criterionId] : [],
    );
    if (
      slot === undefined ||
      bid === undefined ||
      typeof slot.roleSlotId !== "string" ||
      outputIds.length === 0 ||
      criterionIds.length === 0
    ) {
      return null;
    }
    const requiredCapabilities = stringValues(bid.relevantCapabilities);
    if (requiredCapabilities.length === 0) return null;
    assignments.push({
      roleSlotId: slot.roleSlotId,
      agentId,
      responsibilities: [
        typeof bid.proposedContribution === "string"
          ? bid.proposedContribution
          : `Complete selected role ${index + 1}.`,
      ],
      requiredCapabilities,
      dependencyRoleSlotIds:
        typeof priorSlot?.roleSlotId === "string" ? [priorSlot.roleSlotId] : [],
      outputIds,
      verificationCriterionIds: criterionIds,
      pointAllocation:
        index === 0
          ? totalPoints - basePoints * (selectedHelperIds.length - 1)
          : basePoints,
    });
  }
  const verificationCriterionIds = criteria.flatMap((criterion) =>
    typeof criterion.criterionId === "string" ? [criterion.criterionId] : [],
  );
  if (verificationCriterionIds.length !== criteria.length) return null;
  return {
    assignments,
    deliveryDeadline,
    verificationCriterionIds,
    failureBehavior: failureBehavior as JsonObject,
  };
}

/** A hosted agent independently signs and sends its own A2A application. */
export async function applyToGuildMission(
  kind: HostedAgentKind,
  connection: GuildConnection,
  application: GuildApplication,
): Promise<A2ASendMessageResponse> {
  return sendGuildAction(kind, connection, {
    action: "guild.apply_to_mission",
    missionId: application.missionId,
    input: application as unknown as JsonObject,
  });
}

/** A hosted agent independently signs the current pact digest and accepts it. */
export async function acceptGuildPact(
  kind: HostedAgentKind,
  connection: GuildConnection,
  input: {
    readonly missionId: string;
    readonly expectedSequence: number;
    readonly pactVersion: number;
    readonly pactDigest: string;
  },
): Promise<A2ASendMessageResponse> {
  const privateJwk = parseHostedPrivateJwk(kind, connection.privateJwk);
  const acceptedAt = (connection.now?.() ?? new Date()).toISOString();
  return sendGuildAction(kind, connection, {
    action: "guild.accept_pact",
    missionId: input.missionId,
    input: input as unknown as JsonObject,
    commitment: {
      acceptanceId: crypto.randomUUID(),
      acceptedAt,
      pactSignature: await sign(privateJwk, pactSigningBytes(input.pactDigest)),
    },
  });
}

export async function sendGuildAction(
  kind: HostedAgentKind,
  connection: GuildConnection,
  request: {
    readonly action: string;
    readonly missionId: string;
    readonly input: JsonObject;
    readonly commitment?: JsonObject;
  },
): Promise<A2ASendMessageResponse> {
  const identity = hostedIdentity(kind);
  const privateJwk = parseHostedPrivateJwk(kind, connection.privateJwk);
  const messageId = crypto.randomUUID();
  const input = { ...request.input, commandId: messageId };
  const client = createA2AHttpJsonClient({
    baseUrl: connection.brokerBaseUrl,
    ...(connection.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: connection.allowInsecureHttp }),
    fetch: signedGuildFetch({
      credential: connection.credential,
      keyId: identity.keyId,
      privateJwk,
      fetch: connection.fetch ?? globalThis.fetch,
      ...(connection.now === undefined ? {} : { now: connection.now }),
    }),
  });
  return client.sendMessage({
    message: {
      messageId,
      contextId: request.missionId,
      role: "ROLE_USER",
      parts: [{ data: input, mediaType: "application/json" }],
      metadata: {
        [COMMITMENT_V1_EXTENSION_URI]: {
          protocol: "commitment/v1",
          action: request.action,
          missionId: request.missionId,
          agentId: identity.agentId,
          ...(request.commitment ?? {}),
        },
      },
      extensions: [COMMITMENT_V1_EXTENSION_URI],
    },
  });
}

function signedGuildFetch(input: {
  readonly credential: string;
  readonly keyId: string;
  readonly privateJwk: JsonWebKey;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}): typeof globalThis.fetch {
  return async (resource, init) => {
    const url = new URL(
      typeof resource === "string" || resource instanceof URL
        ? resource.toString()
        : resource.url,
    );
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const issuedAt = (input.now?.() ?? new Date()).toISOString();
    const nonce = randomNonce();
    const message = new TextEncoder().encode(
      createAgentRequestSignatureMessage({
        method,
        requestTarget: `${url.pathname}${url.search}`,
        bodyText,
        issuedAt,
        nonce,
      }),
    );
    const signature = await sign(input.privateJwk, message);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `GuildNode ${input.credential}`);
    headers.set("X-Guild-Key-Id", input.keyId);
    headers.set("X-Guild-Issued-At", issuedAt);
    headers.set("X-Guild-Nonce", nonce);
    headers.set("X-Guild-Signature", signature);
    return input.fetch(resource, { ...init, headers });
  };
}

async function sign(
  privateJwk: JsonWebKey,
  message: Uint8Array,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const data = new ArrayBuffer(message.byteLength);
  new Uint8Array(data).set(message);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, data)),
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function publicRecord(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(`Guild discovery failed with ${response.status}`);
  }
  const value = (await response.json()) as unknown;
  const parsed = record(value);
  if (parsed === null) throw new Error("Guild discovery must return an object");
  return parsed;
}

function contribution(kind: HostedAgentKind): string {
  if (kind === "scout") return "Inspect the bounded public fixture.";
  if (kind === "scribe") return "Map each public finding to a repair.";
  return "Verify the public artifacts deterministically.";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item);
        return parsed === null ? [] : [parsed];
      })
    : [];
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function completed(response: A2ASendMessageResponse): boolean {
  return (
    "task" in response && response.task.status.state === "TASK_STATE_COMPLETED"
  );
}
