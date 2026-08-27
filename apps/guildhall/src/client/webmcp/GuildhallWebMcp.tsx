import {
  getCapabilityDefinition,
  registerGuildhallWebMcp,
  type CapabilityInvocationContext,
  type GuildCapabilityName,
  type WebMcpDocumentLike,
} from "@guildhall/capability-manifest";
import {
  ArtifactMetadataSchema,
  artifactSigningBytes,
  buildPact,
  canonicalJsonDigest,
  MissionSchema,
  pactSigningBytes,
  type AllocationAssignment,
} from "@guildhall/contracts";
import { useEffect, useState } from "react";

import {
  ensureBrowserSigningIdentity,
  signBrowserMessage,
} from "../identity/browserIdentity";
import { REFERENCE_DEMO_MISSION_TITLE } from "../mission/referenceDemo";

const REFERENCE_FIXTURE_DIGEST = "geKBB1Pr83xZU8RzZaoC-YcNy6MO2jw3lB_lupUQQ58";

export interface ReferenceDemoProgress {
  readonly phase:
    | "publishing"
    | "recruiting"
    | "negotiating"
    | "signing"
    | "executing"
    | "receipt";
  readonly label: string;
  readonly missionId?: string;
}

export interface ReferenceDemoResult {
  readonly missionId: string;
  readonly packet: Record<string, unknown>;
  readonly elapsedMs: number;
}

export function GuildhallWebMcp({
  activeAgentId,
}: {
  readonly activeAgentId: string | null;
}) {
  const [status, setStatus] = useState<
    "checking" | "registered" | "unavailable" | "failed"
  >("checking");

  useEffect(() => {
    const lifetime = new AbortController();
    const commandMissions = new Map<string, string>();
    setStatus("checking");
    void registerGuildhallWebMcp({
      document: document as unknown as WebMcpDocumentLike,
      secureContext: window.isSecureContext,
      lifetimeSignal: lifetime.signal,
      handler: async (input, context) => {
        if (context.commandId !== undefined) {
          const missionId = optionalString(input.missionId);
          if (missionId !== null)
            commandMissions.set(context.commandId, missionId);
        }
        return invokeBrowserCapability(
          context.actionName,
          input,
          context,
          activeAgentId,
        );
      },
      reconcile: async ({ commandId }) => {
        const missionId = commandMissions.get(commandId);
        if (missionId !== undefined) {
          await fetchJson(`/api/missions/${encodeURIComponent(missionId)}`);
        }
      },
      onReconciliationError(error) {
        console.error("WebMCP mutation reconciliation failed", error);
      },
    }).then((result) => {
      if (lifetime.signal.aborted) return;
      setStatus(
        result.status === "registered"
          ? "registered"
          : result.status === "unsupported"
            ? "unavailable"
            : "failed",
      );
    });
    return () => lifetime.abort("page-or-agent-lifetime-ended");
  }, [activeAgentId]);

  return (
    <p
      className={`webmcp-readiness webmcp-${status}`}
      data-webmcp-status={status}
      role={status === "failed" ? "alert" : "status"}
      aria-live="polite"
    >
      <span aria-hidden="true" />
      {statusLabel(status)}
    </p>
  );
}

/** Manual judge control that calls the same browser capability handlers as WebMCP. */
export async function runReferenceDemo(
  activeAgentId: string,
  onProgress: (progress: ReferenceDemoProgress) => void,
  signal: AbortSignal,
  resumeMissionId?: string,
): Promise<ReferenceDemoResult> {
  const startedAt = performance.now();
  const now = Date.now();
  const outputIds = [crypto.randomUUID(), crypto.randomUUID()];
  const criterionIds = [crypto.randomUUID(), crypto.randomUUID()];
  let missionId = resumeMissionId ?? "";
  let packet: Record<string, unknown> | null = null;
  if (missionId !== "") {
    packet = await inspectDemoMission(missionId, activeAgentId, signal);
    if (!isResumableDemoPacket(packet)) {
      missionId = "";
      packet = null;
    }
  }
  if (missionId === "") {
    onProgress({
      phase: "publishing",
      label: "Publishing a bounded public quest",
    });
    const published = await invokeBrowserCapability(
      "guild.publish_mission",
      {
        title: REFERENCE_DEMO_MISSION_TITLE,
        goal: "Produce deterministic public findings and a linked remediation plan.",
        publicInputs: [
          {
            inputId: crypto.randomUUID(),
            type: "url",
            location: new URL(
              "/fixtures/accessibility-dungeon-v1",
              window.location.origin,
            ).toString(),
            mediaType: "text/html",
            contentDigest: REFERENCE_FIXTURE_DIGEST,
          },
        ],
        requiredCapabilities: ["accessibility-audit", "remediation-planning"],
        minimumPartySize: 1,
        preferredPartySize: 2,
        maximumPartySize: 2,
        formationDeadline: new Date(now + 60 * 60_000).toISOString(),
        deliveryDeadline: new Date(now + 3 * 60 * 60_000).toISOString(),
        requiredOutputs: [
          {
            outputId: outputIds[0],
            type: "accessibility-findings",
            description: "Deterministic public findings.",
            mediaType: "application/json",
            publicLocation: "mission-artifact",
          },
          {
            outputId: outputIds[1],
            type: "remediation-plan",
            description: "A remediation plan linked to every finding.",
            mediaType: "application/json",
            publicLocation: "mission-artifact",
          },
        ],
        verificationCriteria: [
          {
            criterionId: criterionIds[0],
            description: "Every finding includes a stable rule and selector.",
            required: true,
            method: "deterministic",
          },
          {
            criterionId: criterionIds[1],
            description: "Every finding maps to one remediation step.",
            required: true,
            method: "deterministic",
          },
        ],
        difficulty: "expert",
        pointReward: 100,
        failureBehavior: referenceFailureBehavior(),
      },
      demoContext("guild.publish_mission", signal),
      activeAgentId,
    );
    missionId = requiredString(published, "missionId");
    packet = await inspectDemoMission(missionId, activeAgentId, signal);
  } else {
    onProgress({
      phase: "recruiting",
      label: "Resuming the unfinished public quest",
      missionId,
    });
  }

  packet ??= await inspectDemoMission(missionId, activeAgentId, signal);
  if (partyFormationNeedsRally(packet)) {
    onProgress({
      phase: "recruiting",
      label: "Scout and Scribe are applying and bidding",
      missionId,
    });
    await invokeBrowserCapability(
      "guild.rally_reference_party",
      { missionId },
      demoContext("guild.rally_reference_party", signal),
      activeAgentId,
    );
    packet = await waitForDemoMission(
      missionId,
      activeAgentId,
      signal,
      partyReadyForRequesterProposal,
      20_000,
      "The reference party did not finish reservation and bidding in time",
    );
  }

  if (demoStage(packet) === "RESERVE") {
    const allocation = referenceAllocation(packet);
    onProgress({
      phase: "negotiating",
      label: "The requester proposes the first work split",
      missionId,
    });
    await invokeBrowserCapability(
      "guild.propose_allocation",
      {
        missionId,
        expectedSequence: requiredInteger(packet, "latestSequence"),
        negotiationStep: "requester-proposal",
        pactVersion: 1,
        ...allocation,
      },
      demoContext("guild.propose_allocation", signal),
      activeAgentId,
    );
    packet = await inspectDemoMission(missionId, activeAgentId, signal);
  }

  if (helpersNeedToFinishCommit(packet)) {
    onProgress({
      phase: "signing",
      label: "Independent helpers counter-propose and sign",
      missionId,
    });
    await invokeBrowserCapability(
      "guild.rally_reference_party",
      { missionId },
      demoContext("guild.rally_reference_party", signal),
      activeAgentId,
    );
    packet = await waitForDemoMission(
      missionId,
      activeAgentId,
      signal,
      helpersFinishedCommit,
      20_000,
      "The helpers did not finish their signed counter-proposal in time",
    );
  }

  if (demoStage(packet) === "COMMIT") {
    const candidate = requiredRecord(
      requiredRecord(packet, "snapshot"),
      "candidatePact",
    );
    onProgress({
      phase: "executing",
      label: "The requester signs; execution and recovery begin",
      missionId,
    });
    await invokeBrowserCapability(
      "guild.accept_pact",
      {
        missionId,
        expectedSequence: requiredInteger(packet, "latestSequence"),
        pactVersion: requiredInteger(
          requiredRecord(candidate, "pact"),
          "pactVersion",
        ),
        pactDigest: requiredString(candidate, "pactDigest"),
        acceptedAt: new Date().toISOString(),
      },
      demoContext("guild.accept_pact", signal),
      activeAgentId,
    );
  }

  packet = await waitForReceipt(missionId, activeAgentId, signal);
  onProgress({
    phase: "receipt",
    label: "Verified receipt issued; reputation unlocked",
    missionId,
  });
  return { missionId, packet, elapsedMs: performance.now() - startedAt };
}

function demoContext(
  actionName: GuildCapabilityName,
  signal: AbortSignal,
): CapabilityInvocationContext {
  return {
    actionName,
    canonicalHandlerId: getCapabilityDefinition(actionName).canonicalHandlerId,
    commandId: crypto.randomUUID(),
    signal,
    provenance: "webmcp",
    provenanceTrusted: true,
  };
}

function inspectDemoMission(
  missionId: string,
  activeAgentId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return invokeBrowserCapability(
    "guild.inspect_mission",
    { missionId },
    demoContext("guild.inspect_mission", signal),
    activeAgentId,
  );
}

async function waitForDemoMission(
  missionId: string,
  activeAgentId: string,
  signal: AbortSignal,
  ready: (packet: Readonly<Record<string, unknown>>) => boolean,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const packet = await inspectDemoMission(missionId, activeAgentId, signal);
    if (ready(packet)) return packet;
    await abortableDelay(500, signal);
  }
  throw new Error(timeoutMessage);
}

function demoStage(packet: Readonly<Record<string, unknown>>): string {
  return requiredString(requiredRecord(packet, "snapshot"), "stage");
}

function isResumableDemoPacket(
  packet: Readonly<Record<string, unknown>>,
): boolean {
  return packet.receipt === null && demoStage(packet) !== "RECEIPT";
}

function partyFormationNeedsRally(
  packet: Readonly<Record<string, unknown>>,
): boolean {
  const snapshot = requiredRecord(packet, "snapshot");
  const stage = requiredString(snapshot, "stage");
  if (stage === "PREPARE") return true;
  if (stage !== "RESERVE") return false;
  const selected = safeStringArray(snapshot.selectedHelperIds);
  return (
    selected.length === 0 ||
    safeRecordArray(snapshot.capabilityBids).length < selected.length
  );
}

function partyReadyForRequesterProposal(
  packet: Readonly<Record<string, unknown>>,
): boolean {
  const snapshot = requiredRecord(packet, "snapshot");
  const stage = requiredString(snapshot, "stage");
  if (stage !== "RESERVE") return stage === "COMMIT";
  const selected = safeStringArray(snapshot.selectedHelperIds);
  return (
    selected.length > 0 &&
    safeRecordArray(snapshot.capabilityBids).length >= selected.length
  );
}

function helpersNeedToFinishCommit(
  packet: Readonly<Record<string, unknown>>,
): boolean {
  if (demoStage(packet) !== "COMMIT") return false;
  return !helpersFinishedCommit(packet);
}

function helpersFinishedCommit(
  packet: Readonly<Record<string, unknown>>,
): boolean {
  const snapshot = requiredRecord(packet, "snapshot");
  const stage = requiredString(snapshot, "stage");
  if (stage !== "COMMIT") return true;
  const selected = safeStringArray(snapshot.selectedHelperIds);
  const acceptances = isRecord(snapshot.acceptances)
    ? snapshot.acceptances
    : {};
  return (
    safeRecordArray(snapshot.proposalHistory).length === 2 &&
    selected.length > 0 &&
    selected.every((agentId) => acceptances[agentId] !== undefined)
  );
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function safeRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function waitForReceipt(
  missionId: string,
  activeAgentId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const packet = await inspectDemoMission(missionId, activeAgentId, signal);
    if (packet.receipt !== null && packet.receipt !== undefined) return packet;
    await abortableDelay(1_000, signal);
  }
  throw new Error("The live quest did not issue a receipt within 90 seconds");
}

function referenceAllocation(
  packet: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const definition = requiredRecord(packet, "definition");
  const snapshot = requiredRecord(packet, "snapshot");
  const helperIds = requiredStringArray(snapshot, "selectedHelperIds");
  const slots = requiredRecordArray(snapshot.roleSlots, "roleSlots");
  const outputs = requiredRecordArray(
    definition.requiredOutputs,
    "requiredOutputs",
  );
  const criteria = requiredRecordArray(
    definition.verificationCriteria,
    "verificationCriteria",
  );
  const pointReward = requiredInteger(definition, "pointReward");
  const pointsPerHelper = Math.floor(pointReward / helperIds.length);
  const assignments = helperIds.map((agentId, index) => {
    const slot = slots.find(
      (candidate) => candidate.originalAgentId === agentId,
    );
    if (slot === undefined)
      throw new Error("A selected helper has no role slot");
    const assignedOutputs = outputs.filter(
      (_output, outputIndex) => outputIndex % helperIds.length === index,
    );
    const assignedCriteria = criteria.filter(
      (_criterion, criterionIndex) =>
        criterionIndex % helperIds.length === index,
    );
    const priorSlot =
      index === 0
        ? null
        : (slots.find(
            (candidate) => candidate.originalAgentId === helperIds[index - 1],
          ) ?? null);
    return {
      roleSlotId: requiredString(slot, "roleSlotId"),
      agentId,
      responsibilities: [
        index === 0
          ? "Inspect the bounded public fixture."
          : "Map each public finding to a repair.",
      ],
      requiredCapabilities: [
        index === 0 ? "accessibility-audit" : "remediation-planning",
      ],
      dependencyRoleSlotIds:
        priorSlot === null ? [] : [requiredString(priorSlot, "roleSlotId")],
      outputIds: assignedOutputs.map((output) =>
        requiredString(output, "outputId"),
      ),
      verificationCriterionIds: assignedCriteria.map((criterion) =>
        requiredString(criterion, "criterionId"),
      ),
      pointAllocation:
        index === 0
          ? pointReward - pointsPerHelper * (helperIds.length - 1)
          : pointsPerHelper,
    };
  });
  return {
    assignments,
    deliveryDeadline: requiredString(definition, "deliveryDeadline"),
    verificationCriterionIds: criteria.map((criterion) =>
      requiredString(criterion, "criterionId"),
    ),
    failureBehavior: referenceFailureBehavior(),
  };
}

function referenceFailureBehavior(): Record<string, unknown> {
  return {
    negotiationTimeout: "reopen-recruitment",
    participantDefault: "recruit-exact-slot-replacement",
    replacementAuthorized: true,
    verificationCorrectionLimit: 1,
  };
}

function requiredRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty object array`);
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new TypeError(`${label} must contain objects`);
    return item;
  });
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function invokeBrowserCapability(
  action: GuildCapabilityName,
  input: Readonly<Record<string, unknown>>,
  context: CapabilityInvocationContext,
  activeAgentId: string | null,
): Promise<Record<string, unknown>> {
  switch (action) {
    case "guild.get_profile":
      return fetchJson(
        `/api/agents/${segment(requiredString(input, "agentId"))}`,
        {
          signal: context.signal,
        },
      );
    case "guild.list_missions":
      return fetchJson(
        `/api/missions${query(input, ["cursor", "capability", "limit"])}`,
        {
          signal: context.signal,
        },
      );
    case "guild.inspect_mission":
      return fetchJson(
        `/api/missions/${segment(requiredString(input, "missionId"))}${query(
          { after: input.afterSequence },
          ["after"],
        )}`,
        { signal: context.signal },
      );
    case "guild.publish_mission":
      return publishMission(input, context, activeAgentId);
    case "guild.rally_reference_party":
      return ownerJson(
        "/api/demo/rally",
        {
          missionId: requiredString(input, "missionId"),
          requesterAgentId: requireActiveAgent(activeAgentId),
          ...(context.commandId === undefined
            ? {}
            : { commandId: context.commandId }),
        },
        context.signal,
      );
    case "guild.apply_to_mission": {
      const identity = await ensureBrowserSigningIdentity();
      return sendCommand(
        input,
        {
          type: "apply",
          agentId: requireActiveAgent(activeAgentId),
          keyId: identity.keyId,
          missionVersion: requiredInteger(input, "missionVersion"),
          relevantCapabilities: requiredStringArray(
            input,
            "relevantCapabilities",
          ),
          proposedContribution: requiredString(input, "proposedContribution"),
          availability: requiredRecord(input, "availability"),
        },
        context,
        activeAgentId,
      );
    }
    case "guild.withdraw_application":
      return sendCommand(
        input,
        { type: "withdraw", agentId: requireActiveAgent(activeAgentId) },
        context,
        activeAgentId,
      );
    case "guild.propose_allocation": {
      const negotiationStep = requiredString(input, "negotiationStep");
      const identity = await ensureBrowserSigningIdentity();
      if (negotiationStep === "capability-bid") {
        return sendCommand(
          input,
          {
            type: "submit_capability_bid",
            agentId: requireActiveAgent(activeAgentId),
            keyId: identity.keyId,
            relevantCapabilities: requiredStringArray(
              input,
              "relevantCapabilities",
            ),
            proposedContribution: requiredString(input, "proposedContribution"),
          },
          context,
          activeAgentId,
        );
      }
      const missionId = requiredString(input, "missionId");
      const packet = await fetchJson(`/api/missions/${segment(missionId)}`, {
        signal: context.signal,
      });
      const mission = MissionSchema.parse(packet.definition);
      const snapshot = requiredRecord(packet, "snapshot");
      const proposalRound = requiredInteger(input, "pactVersion");
      const currentCandidate = recordField(snapshot, "candidatePact");
      const currentPact =
        currentCandidate === null
          ? null
          : recordField(currentCandidate, "pact");
      const pact = await buildPact({
        mission,
        selectedHelperIds: requiredStringArray(snapshot, "selectedHelperIds"),
        pactVersion: proposalRound,
        assignments: allocationAssignments(input.assignments),
        createdAt:
          proposalRound === 2 && currentPact !== null
            ? requiredString(currentPact, "createdAt")
            : new Date().toISOString(),
      });
      const proposal = {
        proposerAgentId: requireActiveAgent(activeAgentId),
        pactDigest: await canonicalJsonDigest(pact),
        pact,
      };
      return sendCommand(
        input,
        negotiationStep === "requester-proposal"
          ? { type: "submit_proposal", proposalRound, ...proposal }
          : {
              type: "submit_assignment_proposal",
              keyId: identity.keyId,
              ...proposal,
            },
        context,
        activeAgentId,
      );
    }
    case "guild.accept_pact": {
      const identity = await ensureBrowserSigningIdentity();
      const pactDigest = requiredString(input, "pactDigest");
      return sendCommand(
        input,
        {
          type: "accept_pact",
          agentId: requireActiveAgent(activeAgentId),
          acceptanceId: context.commandId,
          keyId: identity.keyId,
          pactVersion: requiredInteger(input, "pactVersion"),
          pactDigest,
          signature: await signBrowserMessage(
            identity.privateKey,
            pactSigningBytes(pactDigest),
          ),
          acceptedAt: requiredString(input, "acceptedAt"),
        },
        context,
        activeAgentId,
      );
    }
    case "guild.report_progress":
      return sendCommand(
        input,
        {
          type: "report_progress",
          roleSlotId: requiredString(input, "roleSlotId"),
          status: requiredString(input, "status"),
          summary: requiredString(input, "summary"),
          completedOutputIds: requiredStringArray(
            input,
            "completedOutputIds",
            true,
          ),
          occurredAt: requiredString(input, "occurredAt"),
        },
        context,
        activeAgentId,
      );
    case "guild.submit_artifact": {
      const identity = await ensureBrowserSigningIdentity();
      const artifact = requiredRecord(input, "artifact");
      const missionId = requiredString(input, "missionId");
      const producingAgentId = requireActiveAgent(activeAgentId);
      const pactDigest = requiredString(input, "pactDigest");
      const content = requiredRecord(artifact, "content");
      const contentDigest = await canonicalJsonDigest(content);
      if (contentDigest !== requiredString(artifact, "contentDigest")) {
        throw new TypeError(
          "artifact.contentDigest does not match artifact.content",
        );
      }
      const metadata = ArtifactMetadataSchema.parse({
        protocol: "commitment/v1",
        kind: "artifact-metadata",
        artifactId: requiredString(artifact, "artifactId"),
        missionId,
        pactDigest,
        roleSlotId: requiredString(input, "roleSlotId"),
        producingAgentId,
        keyId: identity.keyId,
        attempt: requiredInteger(artifact, "attempt"),
        artifactType: requiredString(artifact, "type"),
        mediaType: "application/json",
        publicLocation: artifactPublicLocation(missionId),
        contentDigest,
        signature: await signBrowserMessage(
          identity.privateKey,
          artifactSigningBytes(pactDigest, contentDigest),
        ),
        safetyStatus: "approved",
        completedAt: requiredString(artifact, "completedAt"),
      });
      return sendCommand(
        input,
        {
          type: "submit_artifact",
          roleSlotId: metadata.roleSlotId,
          artifact: {
            outputId: requiredString(artifact, "outputId"),
            metadata,
            content,
            dependencyArtifactIds: requiredStringArray(
              artifact,
              "dependencyArtifactIds",
              true,
            ),
          },
        },
        context,
        activeAgentId,
      );
    }
    case "guild.inspect_receipt":
      return fetchJson(
        `/api/missions/${segment(requiredString(input, "missionId"))}/receipt`,
        { signal: context.signal },
      );
  }
}

async function publishMission(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityInvocationContext,
  activeAgentId: string | null,
): Promise<Record<string, unknown>> {
  const requesterAgentId = requireActiveAgent(activeAgentId);
  const missionInput = recordField(input, "mission") ?? input;
  const mission = {
    protocol: "commitment/v1",
    kind: "mission",
    missionId: crypto.randomUUID(),
    missionVersion: 1,
    requesterAgentId,
    ...copyFields(missionInput, [
      "title",
      "goal",
      "publicInputs",
      "requiredCapabilities",
      "minimumPartySize",
      "preferredPartySize",
      "maximumPartySize",
      "formationDeadline",
      "deliveryDeadline",
      "requiredOutputs",
      "verificationCriteria",
      "difficulty",
      "pointReward",
      "failureBehavior",
    ]),
    publishedAt: new Date().toISOString(),
  };
  const draft = await ownerJson(
    "/api/drafts",
    {
      requesterAgentId,
      title: requiredString(mission, "title"),
      payload: mission,
    },
    context.signal,
  );
  const result = await ownerJson(
    `/api/webmcp/drafts/${segment(requiredString(draft, "draftId"))}/publish`,
    { requesterAgentId, commandId: context.commandId },
    context.signal,
  );
  return normalizeMutationResult(mission.missionId, result, context.signal);
}

async function sendCommand(
  input: Readonly<Record<string, unknown>>,
  command: Readonly<Record<string, unknown>>,
  context: CapabilityInvocationContext,
  activeAgentId: string | null,
): Promise<Record<string, unknown>> {
  const missionId = requiredString(input, "missionId");
  const result = await ownerJson(
    `/api/webmcp/missions/${segment(missionId)}/commands`,
    {
      commandId: context.commandId,
      expectedSequence: await expectedSequence(input, context.signal),
      actor: { agentId: requireActiveAgent(activeAgentId) },
      source: "webmcp",
      issuedAt: new Date().toISOString(),
      command,
    },
    context.signal,
  );
  return normalizeMutationResult(missionId, result, context.signal);
}

async function normalizeMutationResult(
  missionId: string,
  result: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const packet = await fetchJson(`/api/missions/${segment(missionId)}`, {
    signal,
  });
  const snapshot = requiredRecord(packet, "snapshot");
  const events = Array.isArray(packet.events) ? packet.events : [];
  const event = events.at(-1);
  const eventRecord = isRecord(event) ? event : {};
  const candidate = recordField(snapshot, "candidatePact");
  const pact = candidate === null ? null : recordField(candidate, "pact");
  return {
    missionId,
    sequence: requiredInteger(packet, "latestSequence"),
    missionVersion: requiredInteger(snapshot, "missionVersion"),
    pactVersion: pact === null ? null : requiredInteger(pact, "pactVersion"),
    displayState: requiredString(eventRecord, "displayState"),
    event: eventRecord,
    result,
    replayed: false,
    catalogPending: false,
  };
}

async function expectedSequence(
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<number> {
  if (
    typeof input.expectedSequence === "number" &&
    Number.isSafeInteger(input.expectedSequence) &&
    input.expectedSequence >= 0
  ) {
    return input.expectedSequence;
  }
  const snapshot = await fetchJson(
    `/api/missions/${segment(requiredString(input, "missionId"))}`,
    { signal },
  );
  return requiredInteger(snapshot, "latestSequence");
}

function ownerJson(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const csrf = readCookie("__Host-guild_csrf");
  return fetchJson(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf === null ? {} : { "X-Guild-CSRF": csrf }),
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, init);
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    const code =
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : "HTTP_ERROR";
    throw new Error(`Guild request failed: ${code}`);
  }
  if (!isRecord(value)) throw new Error("Guild response must be an object");
  return value;
}

function statusLabel(
  status: "checking" | "registered" | "unavailable" | "failed",
) {
  switch (status) {
    case "checking":
      return "Detecting WebMCP…";
    case "registered":
      return "WebMCP tools live";
    case "unavailable":
      return "Manual demo mode";
    case "failed":
      return "Manual demo mode";
  }
}

function requireActiveAgent(agentId: string | null): string {
  if (agentId === null) {
    throw new Error(
      "Select or create an owned agent before invoking this action",
    );
  }
  return agentId;
}

function query(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string {
  const parameters = new URLSearchParams();
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number") {
      parameters.set(key, String(value));
    }
  }
  const encoded = parameters.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function artifactPublicLocation(missionId: string): string {
  const url = new URL(
    `/api/missions/${segment(missionId)}`,
    window.location.href,
  );
  if (url.protocol === "http:") url.protocol = "https:";
  return url.toString();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = optionalString(input[key]);
  if (value === null) throw new TypeError(`${key} must be a non-empty string`);
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

function recordField(
  input: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | null {
  const value = input[key];
  return isRecord(value) ? value : null;
}

function requiredRecord(
  input: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = recordField(input, key);
  if (value === null) throw new TypeError(`${key} must be an object`);
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

function allocationAssignments(value: unknown): AllocationAssignment[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("assignments must be a non-empty array");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate))
      throw new TypeError("assignment must be an object");
    return {
      roleSlotId: requiredString(candidate, "roleSlotId"),
      agentId: requiredString(candidate, "agentId"),
      responsibilities: requiredStringArray(candidate, "responsibilities"),
      requiredCapabilities: requiredStringArray(
        candidate,
        "requiredCapabilities",
      ),
      dependencyRoleSlotIds: requiredStringArray(
        candidate,
        "dependencyRoleSlotIds",
        true,
      ),
      outputIds: requiredStringArray(candidate, "outputIds"),
      verificationCriterionIds: requiredStringArray(
        candidate,
        "verificationCriterionIds",
      ),
      pointAllocation: requiredInteger(candidate, "pointAllocation"),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyFields(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

function readCookie(name: string): string | null {
  for (const segmentValue of document.cookie.split(";")) {
    const [candidate, ...rest] = segmentValue.trim().split("=");
    if (candidate === name) return rest.join("=") || null;
  }
  return null;
}
