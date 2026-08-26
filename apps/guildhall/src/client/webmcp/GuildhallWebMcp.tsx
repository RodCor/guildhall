import {
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
    <p className="gateway-status" data-webmcp-status={status}>
      WebMCP: {statusLabel(status)}
    </p>
  );
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
      return "checking this browser";
    case "registered":
      return "canonical guild tools registered";
    case "unavailable":
      return "manual controls active (browser API unavailable)";
    case "failed":
      return "registration failed; manual controls remain available";
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
