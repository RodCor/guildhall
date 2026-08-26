import { describe, expect, it, vi } from "vitest";

import { guildCapabilityManifest } from "./manifest.js";
import { registerGuildhallWebMcp } from "./webmcp.js";

describe("registerGuildhallWebMcp", () => {
  it("returns an explicit unsupported result outside a secure context", async () => {
    const result = await registerGuildhallWebMcp({
      document: {},
      secureContext: false,
      handler: vi.fn(),
    });

    expect(result).toEqual({
      status: "unsupported",
      reason: "insecure-context",
      registrationCount: 0,
    });
  });

  it("registers current WebMCP names and aborts the shared registration signal", async () => {
    const registrations: Array<{
      tool: { name: string };
      signal?: AbortSignal;
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
            });
          },
        },
      },
      secureContext: true,
      handler: vi.fn(),
    });

    expect(result.status).toBe("registered");
    expect(registrations.map(({ tool }) => tool.name)).toEqual(
      guildCapabilityManifest.map(({ name }) => name),
    );
    expect(registrations.every(({ signal }) => signal?.aborted === false)).toBe(
      true,
    );

    if (result.status === "registered") {
      result.abort("agent-switch");
    }

    expect(registrations.every(({ signal }) => signal?.aborted === true)).toBe(
      true,
    );
  });

  it("reconciles an aborted mutation by its stable command id", async () => {
    let execute:
      | ((
          input: Readonly<Record<string, unknown>>,
          options: { signal: AbortSignal },
        ) => Promise<unknown>)
      | undefined;
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
    const publishOnly = guildCapabilityManifest.filter(
      ({ name }) => name === "guild.publish_mission",
    );

    await registerGuildhallWebMcp({
      document: {
        modelContext: {
          async registerTool(tool): Promise<void> {
            execute = tool.execute;
          },
        },
      },
      secureContext: true,
      manifest: publishOnly,
      createCommandId: () => "command-stable-1",
      handler,
      reconcile,
    });

    expect(execute).toBeTypeOf("function");
    const pending = execute?.(
      {
        title: "Audit the dungeon",
        brief: "Find deterministic accessibility defects.",
        minimumHelpers: 1,
        maximumHelpers: 2,
      },
      { signal: executionController.signal },
    );
    executionController.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "command-stable-1" }),
      expect.objectContaining({
        commandId: "command-stable-1",
        provenance: "webmcp",
      }),
    );
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: "guild.publish_mission",
        commandId: "command-stable-1",
      }),
    );
  });
});
