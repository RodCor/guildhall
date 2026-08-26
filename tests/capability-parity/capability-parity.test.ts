import { describe, expect, it } from "vitest";

import {
  LOCKED_GUILD_CAPABILITY_NAMES,
  assertCapabilityParity,
  createCapabilityParitySnapshot,
  guildCapabilityManifest,
  type CapabilityParitySnapshot,
} from "../../packages/capability-manifest/src/index.js";

describe("canonical capability parity", () => {
  it("keeps every transport on the same stable action semantics", () => {
    const canonical = createCapabilityParitySnapshot("canonical");

    for (const surface of ["webmcp", "mcp", "a2a"] as const) {
      expect(() =>
        assertCapabilityParity(
          canonical,
          createCapabilityParitySnapshot(surface),
        ),
      ).not.toThrow();
    }
  });

  it("snapshots the locked classifications and canonical handlers", () => {
    const snapshot = createCapabilityParitySnapshot("canonical");
    const signatures = Object.fromEntries(
      snapshot.actions.map((action) => [
        action.name,
        [
          action.readOnlyHint ? "read" : "mutate",
          action.untrustedContentHint ? "untrusted" : "trusted-content",
          action.authentication,
          action.autonomousPolicyRequired ? "policy" : "no-policy",
          action.canonicalHandlerId,
        ].join(" | "),
      ]),
    );

    expect(signatures).toMatchInlineSnapshot(`
      {
        "guild.accept_pact": "mutate | untrusted | mission-participant | policy | pact.accept.v1",
        "guild.apply_to_mission": "mutate | untrusted | owner-or-agent | policy | application.create.v1",
        "guild.get_profile": "read | untrusted | public | no-policy | profile.inspect.v1",
        "guild.inspect_mission": "read | untrusted | public | no-policy | mission.inspect.v1",
        "guild.inspect_receipt": "read | untrusted | public | no-policy | receipt.inspect.v1",
        "guild.list_missions": "read | untrusted | public | no-policy | mission.list.v1",
        "guild.propose_allocation": "mutate | untrusted | mission-participant | policy | pact.propose-allocation.v1",
        "guild.publish_mission": "mutate | untrusted | owner-or-agent | policy | mission.publish.v1",
        "guild.rally_reference_party": "mutate | untrusted | owner-or-agent | no-policy | party.rally-reference.v1",
        "guild.report_progress": "mutate | untrusted | mission-participant | policy | execution.progress.v1",
        "guild.submit_artifact": "mutate | untrusted | mission-participant | policy | artifact.submit.v1",
        "guild.withdraw_application": "mutate | untrusted | owner-or-agent | policy | application.withdraw.v1",
      }
    `);
  });

  it("detects schema drift even when names and handler IDs still match", () => {
    const expected = createCapabilityParitySnapshot("canonical");
    const actual: CapabilityParitySnapshot = {
      ...createCapabilityParitySnapshot("webmcp"),
      actions: guildCapabilityManifest.map((capability, index) => ({
        ...createCapabilityParitySnapshot("webmcp").actions[index]!,
        ...(index === 0 ? { inputSchema: { type: "null" } } : {}),
        name: capability.name,
      })),
    };

    expect(() => assertCapabilityParity(expected, actual)).toThrow(
      "Capability surface webmcp does not match canonical.",
    );
  });

  it("preserves the locked action order", () => {
    expect(guildCapabilityManifest.map(({ name }) => name)).toEqual(
      LOCKED_GUILD_CAPABILITY_NAMES,
    );
  });
});
