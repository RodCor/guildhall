import { describe, expect, it, vi } from "vitest";

import { CapabilitySchemaValidationError } from "./schema.js";
import { guildCapabilityManifest } from "./manifest.js";
import { registerGuildhallWebMcp, type ModelContextTool } from "./webmcp.js";

const COMMAND_ID = "00000000-0000-4000-8000-000000000001";

const validPublishInput = {
  title: "Audit the dungeon",
  goal: "Find deterministic accessibility defects in the public fixture.",
  publicInputs: [
    {
      inputId: "input-1",
      type: "inline",
      location: "fixture:axe-demo-v1",
      mediaType: "application/json",
      contentDigest: "D".repeat(43),
    },
  ],
  requiredCapabilities: ["accessibility"],
  minimumPartySize: 1,
  preferredPartySize: 2,
  maximumPartySize: 2,
  formationDeadline: "2026-08-27T12:00:00.000Z",
  deliveryDeadline: "2026-08-28T12:00:00.000Z",
  requiredOutputs: [
    {
      outputId: "findings",
      type: "accessibility-findings",
      description: "Machine-readable accessibility findings.",
      mediaType: "application/json",
      publicLocation: "mission-artifact",
    },
  ],
  verificationCriteria: [
    {
      criterionId: "axe-rules",
      description: "Every finding includes a deterministic axe rule ID.",
      required: true,
      method: "deterministic",
    },
  ],
  difficulty: "adept",
  pointReward: 100,
  failureBehavior: {
    negotiationTimeout: "reopen-recruitment",
    participantDefault: "recruit-exact-slot-replacement",
    replacementAuthorized: true,
    verificationCorrectionLimit: 1,
  },
} as const;

function registrationDocument(registrations: ModelContextTool[]) {
  return {
    modelContext: {
      async registerTool(tool: ModelContextTool): Promise<void> {
        registrations.push(tool);
      },
    },
  };
}

describe("registerGuildhallWebMcp", () => {
  it("returns explicit unsupported results when the WebMCP surface is unavailable", async () => {
    await expect(
      registerGuildhallWebMcp({
        document: {},
        secureContext: false,
        handler: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "unsupported",
      reason: "insecure-context",
      registrationCount: 0,
    });

    await expect(
      registerGuildhallWebMcp({
        document: {},
        secureContext: true,
        handler: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "unsupported",
      reason: "api-unavailable",
      registrationCount: 0,
    });
  });

  it("registers all locked actions with canonical schemas and annotations", async () => {
    const registrations: Array<{
      tool: ModelContextTool;
      signal?: AbortSignal;
      exposedTo?: readonly string[];
    }> = [];
    const result = await registerGuildhallWebMcp({
      document: {
        modelContext: {
          async registerTool(tool, options): Promise<void> {
            registrations.push({
              tool,
              ...(options?.signal === undefined
                ? {}
                : { signal: options.signal }),
              ...(options?.exposedTo === undefined
                ? {}
                : { exposedTo: options.exposedTo }),
            });
          },
        },
      },
      secureContext: true,
      exposedTo: ["assistant"],
      handler: vi.fn(),
    });

    expect(result.status).toBe("registered");
    expect(registrations).toHaveLength(guildCapabilityManifest.length);
    registrations.forEach((registration, index) => {
      const capability = guildCapabilityManifest[index];
      expect(registration.tool).toMatchObject({
        name: capability?.name,
        title: capability?.title,
        description: capability?.description,
        inputSchema: capability?.inputSchema,
        annotations: {
          readOnlyHint: capability?.readOnly,
          untrustedContentHint: true,
        },
      });
      expect(registration.exposedTo).toEqual(["assistant"]);
      expect(registration.signal?.aborted).toBe(false);
    });

    if (result.status === "registered") result.abort("agent-switch");
    expect(registrations.every(({ signal }) => signal?.aborted)).toBe(true);
  });

  it("returns a validated envelope with adapter-owned trusted provenance", async () => {
    const registrations: ModelContextTool[] = [];
    const handler = vi.fn(async () => ({ missions: [], nextCursor: null }));
    await registerGuildhallWebMcp({
      document: registrationDocument(registrations),
      secureContext: true,
      handler,
    });

    const tool = registrations.find(
      ({ name }) => name === "guild.list_missions",
    );
    const output = await tool?.execute(
      { limit: 10 },
      { signal: new AbortController().signal },
    );

    expect(handler).toHaveBeenCalledWith(
      { limit: 10 },
      expect.objectContaining({
        actionName: "guild.list_missions",
        canonicalHandlerId: "mission.list.v1",
        provenance: "webmcp",
        provenanceTrusted: true,
      }),
    );
    expect(output).toEqual({
      data: { missions: [], nextCursor: null },
      provenance: {
        transport: "webmcp",
        trusted: true,
        actionName: "guild.list_missions",
        canonicalHandlerId: "mission.list.v1",
      },
    });
  });

  it("rejects invalid and caller-injected provenance before dispatch", async () => {
    const registrations: ModelContextTool[] = [];
    const handler = vi.fn(async () => ({ missions: [], nextCursor: null }));
    await registerGuildhallWebMcp({
      document: registrationDocument(registrations),
      secureContext: true,
      handler,
    });
    const tool = registrations.find(
      ({ name }) => name === "guild.list_missions",
    );

    await expect(
      tool?.execute(
        { limit: 10, provenance: "mcp" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(CapabilitySchemaValidationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reconciles an aborted mutation once by its stable command id", async () => {
    const registrations: ModelContextTool[] = [];
    const executionController = new AbortController();
    const handler = vi.fn(async (): Promise<never> => {
      await new Promise<void>((_resolve, reject) => {
        executionController.signal.addEventListener(
          "abort",
          () => reject(executionController.signal.reason),
          { once: true },
        );
      });
      throw new Error("unreachable");
    });
    const reconcile = vi.fn(async (): Promise<void> => undefined);

    await registerGuildhallWebMcp({
      document: registrationDocument(registrations),
      secureContext: true,
      createCommandId: () => COMMAND_ID,
      handler,
      reconcile,
    });

    const tool = registrations.find(
      ({ name }) => name === "guild.publish_mission",
    );
    const pending = tool?.execute(validPublishInput, {
      signal: executionController.signal,
    });
    executionController.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: COMMAND_ID }),
      expect.objectContaining({
        commandId: COMMAND_ID,
        provenance: "webmcp",
        provenanceTrusted: true,
      }),
    );
    expect(reconcile).toHaveBeenCalledWith({
      actionName: "guild.publish_mission",
      canonicalHandlerId: "mission.publish.v1",
      commandId: COMMAND_ID,
    });
  });

  it("aborts every prior registration if one registration fails", async () => {
    const signals: AbortSignal[] = [];
    const error = new Error("registration denied");
    const result = await registerGuildhallWebMcp({
      document: {
        modelContext: {
          async registerTool(_tool, options): Promise<void> {
            if (options?.signal !== undefined) signals.push(options.signal);
            if (signals.length === 3) throw error;
          },
        },
      },
      secureContext: true,
      handler: vi.fn(),
    });

    expect(result).toEqual({
      status: "failed",
      error,
      registrationCount: 0,
    });
    expect(signals).toHaveLength(3);
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("does not expose tools for an already-ended lifetime", async () => {
    const lifetime = new AbortController();
    lifetime.abort("logout");
    const registerTool = vi.fn(async (): Promise<void> => undefined);

    const result = await registerGuildhallWebMcp({
      document: { modelContext: { registerTool } },
      secureContext: true,
      lifetimeSignal: lifetime.signal,
      handler: vi.fn(),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "logout",
      registrationCount: 0,
    });
    expect(registerTool).not.toHaveBeenCalled();
  });
});
