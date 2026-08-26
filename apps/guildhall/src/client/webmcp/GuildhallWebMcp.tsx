import {
  registerGuildhallWebMcp,
  type CapabilityInvocationContext,
  type GuildCapabilityName,
  type WebMcpDocumentLike,
} from "@guildhall/capability-manifest";
import {
  artifactSigningBytes,
  canonicalJsonDigest,
  pactSigningBytes,
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
    case "guild.apply_to_mission":
      return sendCommand(
        input,
        { type: "apply", agentId: requireActiveAgent(activeAgentId) },
        context,
        activeAgentId,
      );
    case "guild.withdraw_application":
      return sendCommand(
        input,
        { type: "withdraw", agentId: requireActiveAgent(activeAgentId) },
        context,
        activeAgentId,
      );
    case "guild.propose_allocation":
      return sendCommand(
        input,
        {
          type: "submit_proposal",
          pactVersion: requiredInteger(input, "pactVersion"),
          pactDigest: await canonicalJsonDigest({
            protocol: "commitment/v1",
            kind: "allocation-proposal",
            ...copyFields(input, [
              "missionId",
              "pactVersion",
              "assignments",
              "deliveryDeadline",
              "verificationCriterionIds",
              "failureBehavior",
            ]),
          }),
        },
        context,
        activeAgentId,
      );
    case "guild.accept_pact": {
      const identity = await ensureBrowserSigningIdentity();
      const pactDigest = requiredString(input, "pactDigest");
      return sendCommand(
        input,
        {
          type: "accept_pact",
          agentId: requireActiveAgent(activeAgentId),
          acceptanceId: crypto.randomUUID(),
          keyId: identity.keyId,
          pactVersion: requiredInteger(input, "pactVersion"),
          pactDigest,
          signature: await signBrowserMessage(
            identity.privateKey,
            pactSigningBytes(pactDigest),
          ),
          acceptedAt: new Date().toISOString(),
        },
        context,
        activeAgentId,
      );
    }
    case "guild.report_progress":
      return ownerJson(
        `/api/missions/${segment(requiredString(input, "missionId"))}/progress`,
        {
          commandId: context.commandId,
          expectedSequence: await expectedSequence(input, context.signal),
          roleSlotId: requiredString(input, "roleSlotId"),
          status: requiredString(input, "status"),
          summary: requiredString(input, "summary"),
          completedOutputIds: input.completedOutputIds,
          occurredAt: requiredString(input, "occurredAt"),
        },
        context.signal,
      );
    case "guild.submit_artifact": {
      const identity = await ensureBrowserSigningIdentity();
      const artifact = requiredRecord(input, "artifact");
      const pactDigest = requiredString(input, "pactDigest");
      const contentDigest = requiredString(artifact, "contentDigest");
      return ownerJson(
        `/api/missions/${segment(requiredString(input, "missionId"))}/artifacts`,
        {
          commandId: context.commandId,
          expectedSequence: await expectedSequence(input, context.signal),
          roleSlotId: requiredString(input, "roleSlotId"),
          pactDigest,
          artifact,
          contentDigest,
          keyId: identity.keyId,
          signature: await signBrowserMessage(
            identity.privateKey,
            artifactSigningBytes(pactDigest, contentDigest),
          ),
        },
        context.signal,
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
  return ownerJson(
    `/api/drafts/${segment(requiredString(draft, "draftId"))}/publish`,
    { requesterAgentId },
    context.signal,
  );
}

async function sendCommand(
  input: Readonly<Record<string, unknown>>,
  command: Readonly<Record<string, unknown>>,
  context: CapabilityInvocationContext,
  activeAgentId: string | null,
): Promise<Record<string, unknown>> {
  const missionId = requiredString(input, "missionId");
  return ownerJson(
    `/api/missions/${segment(missionId)}/commands`,
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
