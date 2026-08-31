import {
  ArtifactMetadataSchema,
  artifactProofDigest,
  artifactSigningBytes,
  buildPact,
  canonicalJsonDigest,
  commandBodyHash,
  commandSigningBytes,
  MissionSchema,
  pactSigningBytes,
  type AllocationAssignment,
} from "@guildhall/contracts";
import type { GuildCapabilityName } from "@guildhall/capability-manifest";

import {
  normalizeBaseUrl,
  readNodeConfig,
  updateInboxCursor,
  type GuildNodeConfig,
} from "./config.js";
import { createSignedRequestHeaders, signMessage } from "./crypto.js";

const RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024;
const COMMAND_ISSUED_AT_CACHE_LIMIT = 1_024;

export interface GuildClientOptions {
  readonly configPath: string;
  readonly defaultBaseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class GuildClient {
  readonly #configPath: string;
  readonly #defaultBaseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuedAtByCommandId = new Map<string, string>();

  constructor(options: GuildClientOptions) {
    this.#configPath = options.configPath;
    this.#defaultBaseUrl = normalizeBaseUrl(options.defaultBaseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async status(): Promise<Record<string, unknown>> {
    const config = await readNodeConfig(this.#configPath);
    return config === null
      ? {
          paired: false,
          baseUrl: this.#defaultBaseUrl,
          providerCredentialsRequested: false,
        }
      : {
          paired: true,
          baseUrl: config.baseUrl,
          agentId: config.agentId,
          keyId: config.keyId,
          credentialId: config.credentialId,
          scopes: config.scopes,
          inboxCursor: config.inboxCursor,
          pairedAt: config.pairedAt,
          providerCredentialsRequested: false,
        };
  }

  async invoke(
    action: GuildCapabilityName,
    rawInput: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const input = { ...rawInput };
    switch (action) {
      case "guild.get_profile":
        return this.#publicGet(
          `/api/agents/${segment(requiredString(input, "agentId"))}`,
          signal,
        );
      case "guild.list_missions":
        return this.#publicGet(
          `/api/missions${query(input, ["cursor", "capability", "limit"])}`,
          signal,
        );
      case "guild.inspect_mission":
        return this.#publicGet(
          `/api/missions/${segment(requiredString(input, "missionId"))}${query(
            { after: input.afterSequence },
            ["after"],
          )}`,
          signal,
        );
      case "guild.publish_mission":
        return this.#publish(input, signal);
      case "guild.rally_reference_party": {
        const config = await this.#paired();
        return this.#signedJson(
          "POST",
          "/api/demo/rally",
          {
            missionId: requiredString(input, "missionId"),
            requesterAgentId: config.agentId,
            commandId: commandId(input),
          },
          signal,
        );
      }
      case "guild.apply_to_mission": {
        const config = await this.#paired();
        return this.#command(
          input,
          {
            type: "apply",
            agentId: config.agentId,
            keyId: config.keyId,
            missionVersion: requiredInteger(input, "missionVersion"),
            relevantCapabilities: requiredStringArray(
              input,
              "relevantCapabilities",
            ),
            proposedContribution: requiredString(input, "proposedContribution"),
            availability: requiredRecord(input, "availability"),
          },
          signal,
        );
      }
      case "guild.withdraw_application":
        return this.#command(
          input,
          { type: "withdraw", agentId: await this.#agentId() },
          signal,
        );
      case "guild.propose_allocation":
        return this.#proposeAllocation(input, signal);
      case "guild.accept_pact":
        return this.#acceptPact(input, signal);
      case "guild.report_progress":
        return this.#command(
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
          signal,
        );
      case "guild.submit_artifact":
        return this.#submitArtifact(input, signal);
      case "guild.inspect_receipt":
        return this.#publicGet(
          `/api/missions/${segment(requiredString(input, "missionId"))}/receipt`,
          signal,
        );
    }
    throw new TypeError(`Unsupported Guild capability: ${String(action)}`);
  }

  async pollInbox(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const config = await this.#paired();
    const path = `/api/agents/${segment(config.agentId)}/inbox${query(
      { cursor: config.inboxCursor },
      ["cursor"],
    )}`;
    const response = await this.#request("GET", path, undefined, true, signal);
    const nextCursor = response.nextCursor;
    if (nextCursor === null || typeof nextCursor === "string") {
      await updateInboxCursor(nextCursor, this.#configPath);
    }
    return response;
  }

  async #publish(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const config = await this.#paired();
    const missionInput = recordField(input, "mission") ?? input;
    const mission = {
      protocol: "commitment/v1",
      kind: "mission",
      missionId: crypto.randomUUID(),
      missionVersion: 1,
      requesterAgentId: config.agentId,
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
    const title = requiredString(mission, "title");
    const draft = await this.#signedJson(
      "POST",
      "/api/drafts",
      { requesterAgentId: config.agentId, title, payload: mission },
      signal,
    );
    const draftId = requiredString(draft, "draftId");
    const publishCommandId = commandId(input);
    const issuedAt = new Date().toISOString();
    const publishMaterial = {
      commandId: publishCommandId,
      action: "publish",
      missionId: mission.missionId,
      expectedSequence: 0,
      actor: { agentId: config.agentId, keyId: config.keyId },
      issuedAt,
      payload: mission,
    };
    const bodyHash = await commandBodyHash(publishMaterial);
    const result = await this.#signedJson(
      "POST",
      `/api/drafts/${segment(draftId)}/publish`,
      {
        requesterAgentId: config.agentId,
        keyId: config.keyId,
        commandId: publishCommandId,
        issuedAt,
        proof: {
          bodyHash,
          signature: await signMessage(
            config.privateJwk,
            commandSigningBytes(bodyHash),
          ),
        },
      },
      signal,
    );
    return this.#normalizeMutationResult(mission.missionId, result, signal);
  }

  async #command(
    input: Record<string, unknown>,
    command: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const missionId = requiredString(input, "missionId");
    const config = await this.#paired();
    const expectedSequence = await this.#expectedSequence(input, signal);
    const id = commandId(input);
    const issuedAt = this.#stableIssuedAt(id);
    const proofMaterial = {
      commandId: id,
      action: requiredString(command, "type"),
      missionId,
      expectedSequence,
      actor: { agentId: config.agentId, keyId: config.keyId },
      issuedAt,
      payload: command,
    };
    const bodyHash = await commandBodyHash(proofMaterial);
    const result = await this.#signedJson(
      "POST",
      `/api/missions/${segment(missionId)}/commands`,
      {
        commandId: id,
        expectedSequence,
        actor: proofMaterial.actor,
        source: "mcp",
        issuedAt,
        command,
        proof: {
          bodyHash,
          signature: await signMessage(
            config.privateJwk,
            commandSigningBytes(bodyHash),
          ),
        },
      },
      signal,
    );
    return this.#normalizeMutationResult(missionId, result, signal);
  }

  #stableIssuedAt(commandId: string): string {
    const existing = this.#issuedAtByCommandId.get(commandId);
    if (existing !== undefined) return existing;
    const issuedAt = new Date().toISOString();
    this.#issuedAtByCommandId.set(commandId, issuedAt);
    if (this.#issuedAtByCommandId.size > COMMAND_ISSUED_AT_CACHE_LIMIT) {
      const oldest = this.#issuedAtByCommandId.keys().next().value as
        string | undefined;
      if (oldest !== undefined) this.#issuedAtByCommandId.delete(oldest);
    }
    return issuedAt;
  }

  async #proposeAllocation(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const config = await this.#paired();
    const negotiationStep = requiredString(input, "negotiationStep");
    if (negotiationStep === "capability-bid") {
      return this.#command(
        input,
        {
          type: "submit_capability_bid",
          agentId: config.agentId,
          keyId: config.keyId,
          relevantCapabilities: requiredStringArray(
            input,
            "relevantCapabilities",
          ),
          proposedContribution: requiredString(input, "proposedContribution"),
        },
        signal,
      );
    }
    const missionId = requiredString(input, "missionId");
    const packet = await this.#publicGet(
      `/api/missions/${segment(missionId)}`,
      signal,
    );
    const mission = MissionSchema.parse(packet.definition);
    const snapshot = requiredRecord(packet, "snapshot");
    const proposalRound = requiredInteger(input, "pactVersion");
    const currentCandidate = recordField(snapshot, "candidatePact");
    const currentPact =
      currentCandidate === null ? null : recordField(currentCandidate, "pact");
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
      proposerAgentId: config.agentId,
      pactDigest: await canonicalJsonDigest(pact),
      pact,
    };
    return this.#command(
      input,
      negotiationStep === "requester-proposal"
        ? { type: "submit_proposal", proposalRound, ...proposal }
        : {
            type: "submit_assignment_proposal",
            keyId: config.keyId,
            ...proposal,
          },
      signal,
    );
  }

  async #normalizeMutationResult(
    missionId: string,
    result: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const packet = await this.#publicGet(
      `/api/missions/${segment(missionId)}`,
      signal,
    );
    const snapshot = requiredRecord(packet, "snapshot");
    const events = Array.isArray(packet.events) ? packet.events : [];
    const lastEvent = events.at(-1);
    const event = isRecord(lastEvent) ? lastEvent : {};
    const candidate = recordField(snapshot, "candidatePact");
    const pact = candidate === null ? null : recordField(candidate, "pact");
    return {
      missionId,
      sequence: requiredInteger(packet, "latestSequence"),
      missionVersion: requiredInteger(snapshot, "missionVersion"),
      pactVersion: pact === null ? null : requiredInteger(pact, "pactVersion"),
      displayState: requiredString(event, "displayState"),
      event,
      result,
      replayed: false,
      catalogPending: false,
    };
  }

  async #acceptPact(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const config = await this.#paired();
    const acceptanceId = commandId(input);
    input.commandId = acceptanceId;
    const pactDigest = requiredString(input, "pactDigest");
    return this.#command(
      input,
      {
        type: "accept_pact",
        agentId: config.agentId,
        acceptanceId,
        keyId: config.keyId,
        pactVersion: requiredInteger(input, "pactVersion"),
        pactDigest,
        signature: await signMessage(
          config.privateJwk,
          pactSigningBytes(pactDigest),
        ),
        acceptedAt: requiredString(input, "acceptedAt"),
      },
      signal,
    );
  }

  async #submitArtifact(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const config = await this.#paired();
    const artifact = requiredRecord(input, "artifact");
    const missionId = requiredString(input, "missionId");
    const pactDigest = requiredString(input, "pactDigest");
    const content = requiredRecord(artifact, "content");
    const contentDigest = await canonicalJsonDigest(content);
    if (contentDigest !== requiredString(artifact, "contentDigest")) {
      throw new TypeError(
        "artifact.contentDigest does not match artifact.content",
      );
    }
    const outputId = requiredString(artifact, "outputId");
    const dependencyArtifactIds = requiredStringArray(
      artifact,
      "dependencyArtifactIds",
      true,
    );
    const unsignedMetadata = {
      protocol: "commitment/v1",
      kind: "artifact-metadata",
      artifactId: requiredString(artifact, "artifactId"),
      missionId,
      pactDigest,
      roleSlotId: requiredString(input, "roleSlotId"),
      producingAgentId: config.agentId,
      keyId: config.keyId,
      attempt: requiredInteger(artifact, "attempt"),
      artifactType: requiredString(artifact, "type"),
      mediaType: "application/json",
      publicLocation: artifactPublicLocation(config.baseUrl, missionId),
      contentDigest,
      safetyStatus: "approved",
      completedAt: requiredString(artifact, "completedAt"),
    } as const;
    const proofDigest = await artifactProofDigest({
      outputId,
      metadata: { ...unsignedMetadata, signature: "" },
      dependencyArtifactIds,
    });
    const metadata = ArtifactMetadataSchema.parse({
      ...unsignedMetadata,
      signature: await signMessage(
        config.privateJwk,
        artifactSigningBytes(pactDigest, proofDigest),
      ),
    });
    return this.#command(
      input,
      {
        type: "submit_artifact",
        roleSlotId: metadata.roleSlotId,
        artifact: {
          outputId,
          metadata,
          content,
          dependencyArtifactIds,
        },
      },
      signal,
    );
  }

  async #expectedSequence(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number> {
    if (
      typeof input.expectedSequence === "number" &&
      Number.isSafeInteger(input.expectedSequence) &&
      input.expectedSequence >= 0
    ) {
      return input.expectedSequence;
    }
    const snapshot = await this.#publicGet(
      `/api/missions/${segment(requiredString(input, "missionId"))}`,
      signal,
    );
    return requiredInteger(snapshot, "latestSequence");
  }

  async #publicGet(
    path: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request("GET", path, undefined, false, signal);
  }

  async #signedJson(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(method, path, body, true, signal);
  }

  async #request(
    method: string,
    path: string,
    body: unknown,
    signed: boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const config = signed
      ? await this.#paired()
      : await readNodeConfig(this.#configPath);
    const baseUrl = config?.baseUrl ?? this.#defaultBaseUrl;
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const headers = signed
      ? await createSignedRequestHeaders({
          credential: config!.credential,
          keyId: config!.keyId,
          privateJwk: config!.privateJwk,
          method,
          requestTarget: path,
          bodyText,
        })
      : new Headers();
    headers.set("Accept", "application/json");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.#fetch(`${baseUrl}${path}`, {
      method,
      headers,
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined ? {} : { body: bodyText }),
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RESPONSE_BYTE_LIMIT) {
      throw new Error("Guild response exceeded the bounded client limit");
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown);
    } catch {
      throw new Error(`Guild returned non-JSON (${String(response.status)})`);
    }
    if (!response.ok) {
      const code =
        isRecord(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : "HTTP_ERROR";
      throw new Error(
        `Guild request failed: ${code} (${String(response.status)})`,
      );
    }
    if (!isRecord(parsed)) throw new Error("Guild response must be an object");
    return parsed;
  }

  async #paired(): Promise<GuildNodeConfig> {
    const config = await readNodeConfig(this.#configPath);
    if (config === null) {
      throw new Error("Guild Node is not paired; use guild.pair_node first");
    }
    return config;
  }

  async #agentId(): Promise<string> {
    return (await this.#paired()).agentId;
  }
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

function artifactPublicLocation(baseUrl: string, missionId: string): string {
  const url = new URL(`/api/missions/${segment(missionId)}`, baseUrl);
  if (url.protocol === "http:") url.protocol = "https:";
  return url.toString();
}

function commandId(input: Record<string, unknown>): string {
  return typeof input.commandId === "string" && input.commandId.length > 0
    ? input.commandId
    : crypto.randomUUID();
}

function requiredString(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
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
