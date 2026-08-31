import {
  createCapabilityResultEnvelope,
  guildCapabilityManifest,
  type CapabilityDefinition,
} from "@guildhall/capability-manifest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { defaultConfigPath, normalizeBaseUrl } from "./config.js";
import { GuildClient } from "./guildClient.js";
import { pairGuildNode } from "./pairing.js";

export interface GuildNodeServerOptions {
  readonly configPath?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createGuildNodeServer(
  options: GuildNodeServerOptions = {},
): McpServer {
  const configPath = options.configPath ?? defaultConfigPath();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ??
      process.env.GUILDHALL_BASE_URL ??
      "http://127.0.0.1:5173",
  );
  const client = new GuildClient({
    configPath,
    defaultBaseUrl: baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const server = new McpServer(
    { name: "guildhall-node", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "guild.node_status",
    {
      title: "Inspect Guild Node status",
      description:
        "Show pairing, agent identity, scopes, and inbox cursor without exposing secrets.",
      inputSchema: z.object({}).strict(),
      outputSchema: z
        .object({ status: z.record(z.string(), z.unknown()) })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "guildhall/provenance": "local-node" },
    },
    async () => result({ status: await client.status() }),
  );

  server.registerTool(
    "guild.pair_node",
    {
      title: "Pair this Guild Node",
      description:
        "Bind a one-time Guildhall pairing challenge to a new local signing identity.",
      inputSchema: z
        .object({
          code: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
          challenge: z.string().max(512),
          baseUrl: z.url().optional(),
        })
        .strict(),
      outputSchema: z.object({
        paired: z.literal(true),
        agentId: z.uuid(),
        keyId: z.uuid(),
        credentialId: z.uuid(),
        scopes: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { "guildhall/provenance": "local-node" },
    },
    async ({ code, challenge, baseUrl: suppliedBaseUrl }) =>
      result(
        await pairGuildNode({
          code,
          challenge,
          baseUrl: suppliedBaseUrl ?? baseUrl,
          configPath,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      ),
  );

  server.registerTool(
    "guild.poll_inbox",
    {
      title: "Poll the active agent inbox",
      description:
        "Read newly projected mission work and advance the local cursor only after success.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.record(z.string(), z.unknown()),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        "guildhall/provenance": "mcp",
        "guildhall/untrusted-output": true,
      },
    },
    async (_input, context) =>
      result(await client.pollInbox(context.mcpReq.signal)),
  );

  for (const capability of guildCapabilityManifest) {
    registerCanonicalTool(server, client, capability);
  }
  return server;
}

function registerCanonicalTool(
  server: McpServer,
  client: GuildClient,
  capability: CapabilityDefinition,
): void {
  const inputSchema = z.fromJSONSchema(capability.inputSchema);
  const outputSchema = z.fromJSONSchema(capability.outputSchema);
  server.registerTool(
    capability.name,
    {
      title: capability.title,
      description: capability.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: capability.readOnly,
        destructiveHint: false,
        idempotentHint: capability.readOnly,
        openWorldHint: true,
      },
      _meta: {
        "guildhall/canonical-handler": capability.canonicalHandlerId,
        "guildhall/provenance": "mcp",
        "guildhall/untrusted-output": capability.untrustedOutput,
        "guildhall/autonomous-policy-required":
          capability.autonomousPolicyRequired,
      },
    },
    async (input, context) => {
      const inputRecord = input as Readonly<Record<string, unknown>>;
      const trustedCommandId = capability.readOnly
        ? undefined
        : typeof inputRecord.commandId === "string"
          ? inputRecord.commandId
          : crypto.randomUUID();
      const invocationInput =
        trustedCommandId === undefined ||
        inputRecord.commandId === trustedCommandId
          ? inputRecord
          : { ...inputRecord, commandId: trustedCommandId };
      const data = await client.invoke(
        capability.name,
        invocationInput,
        context.mcpReq.signal,
      );
      const eventSequence = sequenceFrom(data);
      return result(
        createCapabilityResultEnvelope(capability, "mcp", data, {
          ...(trustedCommandId === undefined
            ? {}
            : { commandId: trustedCommandId }),
          ...(eventSequence === undefined ? {} : { eventSequence }),
        }) as unknown as Record<string, unknown>,
      );
    },
  );
}

function result(structuredContent: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}

function sequenceFrom(
  data: Readonly<Record<string, unknown>>,
): number | undefined {
  for (const key of ["sequence", "resultingSequence", "latestSequence"]) {
    const value = data[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  return undefined;
}
