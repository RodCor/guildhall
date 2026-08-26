import {
  artifactSigningBytes,
  canonicalJsonDigest,
  pactSigningBytes,
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

export interface GuildClientOptions {
  readonly configPath: string;
  readonly defaultBaseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class GuildClient {
  readonly #configPath: string;
  readonly #defaultBaseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

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
      case "guild.apply_to_mission":
        return this.#command(
          input,
          { type: "apply", agentId: await this.#agentId() },
          signal,
        );
      case "guild.withdraw_application":
        return this.#command(
          input,
          { type: "withdraw", agentId: await this.#agentId() },
          signal,
        );
      case "guild.propose_allocation":
        return this.#command(
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
          signal,
        );
      case "guild.accept_pact":
        return this.#acceptPact(input, signal);
      case "guild.report_progress":
        return this.#signedJson(
          "POST",
          `/api/missions/${segment(requiredString(input, "missionId"))}/progress`,
          {
            commandId: commandId(input),
            expectedSequence: await this.#expectedSequence(input, signal),
            roleSlotId: requiredString(input, "roleSlotId"),
            status: requiredString(input, "status"),
            summary: requiredString(input, "summary"),
            completedOutputIds: input.completedOutputIds,
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
    return this.#signedJson(
      "POST",
      `/api/drafts/${segment(draftId)}/publish`,
      { requesterAgentId: config.agentId },
      signal,
    );
  }

  async #command(
    input: Record<string, unknown>,
    command: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const missionId = requiredString(input, "missionId");
    return this.#signedJson(
      "POST",
      `/api/missions/${segment(missionId)}/commands`,
      {
        commandId: commandId(input),
        expectedSequence: await this.#expectedSequence(input, signal),
        actor: { agentId: await this.#agentId() },
        source: "mcp",
        issuedAt: new Date().toISOString(),
        command,
      },
      signal,
    );
  }

  async #acceptPact(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const config = await this.#paired();
    const pactDigest = requiredString(input, "pactDigest");
    return this.#command(
      input,
      {
        type: "accept_pact",
        agentId: config.agentId,
        acceptanceId: crypto.randomUUID(),
        keyId: config.keyId,
        pactVersion: requiredInteger(input, "pactVersion"),
        pactDigest,
        signature: await signMessage(
          config.privateJwk,
          pactSigningBytes(pactDigest),
        ),
        acceptedAt: new Date().toISOString(),
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
    const pactDigest = requiredString(input, "pactDigest");
    const contentDigest = requiredString(artifact, "contentDigest");
    return this.#signedJson(
      "POST",
      `/api/missions/${segment(requiredString(input, "missionId"))}/artifacts`,
      {
        commandId: commandId(input),
        expectedSequence: await this.#expectedSequence(input, signal),
        roleSlotId: requiredString(input, "roleSlotId"),
        pactDigest,
        artifact,
        contentDigest,
        keyId: config.keyId,
        signature: await signMessage(
          config.privateJwk,
          artifactSigningBytes(pactDigest, contentDigest),
        ),
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
