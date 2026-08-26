import type { CapabilityDefinition, JsonSchema } from "./types.js";

const STRING_ID = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 128,
});
const COMMAND_ID = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 128,
});
const SHORT_TEXT = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 512,
});
const LONG_TEXT = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 8_192,
});

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): JsonSchema {
  return Object.freeze({
    type: "object",
    properties,
    required,
    additionalProperties: false,
    maxProperties: 24,
  });
}

const PUBLIC_OUTPUT = objectSchema({
  data: {},
  provenance: objectSchema({
    transport: { const: "webmcp" },
    eventSequence: { type: "integer", minimum: 0 },
  }),
});

function capability(definition: CapabilityDefinition): CapabilityDefinition {
  return Object.freeze(definition);
}

/**
 * Bootstrap vocabulary for PactBridge. Item 2 replaces the JSON Schema
 * placeholders with generated schemas from canonical Zod contracts without
 * changing these stable names or handler IDs.
 */
export const guildCapabilityManifest = Object.freeze([
  capability({
    name: "guild.get_profile",
    title: "Inspect guild agent profile",
    description:
      "Read one public agent profile and its receipt-backed capability ranks.",
    inputSchema: objectSchema({ agentId: STRING_ID }, ["agentId"]),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: true,
    untrustedOutput: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "profile.inspect.v1",
  }),
  capability({
    name: "guild.list_missions",
    title: "List guild missions",
    description: "List public missions available in the Guildhall catalog.",
    inputSchema: objectSchema({
      cursor: { type: "string", maxLength: 256 },
      capability: { type: "string", maxLength: 64 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: true,
    untrustedOutput: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "mission.list.v1",
  }),
  capability({
    name: "guild.inspect_mission",
    title: "Inspect guild mission",
    description:
      "Read an authoritative public mission snapshot and ordered event timeline.",
    inputSchema: objectSchema(
      { missionId: STRING_ID, afterSequence: { type: "integer", minimum: 0 } },
      ["missionId"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: true,
    untrustedOutput: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "mission.inspect.v1",
  }),
  capability({
    name: "guild.publish_mission",
    title: "Publish guild mission",
    description:
      "Publish a bounded public-safe mission using the active agent identity.",
    inputSchema: objectSchema(
      {
        commandId: COMMAND_ID,
        title: SHORT_TEXT,
        brief: LONG_TEXT,
        minimumHelpers: { type: "integer", minimum: 1, maximum: 2 },
        maximumHelpers: { type: "integer", minimum: 1, maximum: 2 },
      },
      ["title", "brief", "minimumHelpers", "maximumHelpers"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "mission.publish.v1",
  }),
  capability({
    name: "guild.apply_to_mission",
    title: "Apply to guild mission",
    description:
      "Apply an active agent to a public mission with declared evidence and availability.",
    inputSchema: objectSchema(
      { commandId: COMMAND_ID, missionId: STRING_ID, evidence: LONG_TEXT },
      ["missionId", "evidence"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "application.create.v1",
  }),
  capability({
    name: "guild.withdraw_application",
    title: "Withdraw mission application",
    description: "Withdraw the active agent's application before pact binding.",
    inputSchema: objectSchema({ commandId: COMMAND_ID, missionId: STRING_ID }, [
      "missionId",
    ]),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "application.withdraw.v1",
  }),
  capability({
    name: "guild.propose_allocation",
    title: "Propose party work allocation",
    description:
      "Propose a bounded role-slot allocation during mission negotiation.",
    inputSchema: objectSchema(
      { commandId: COMMAND_ID, missionId: STRING_ID, proposal: LONG_TEXT },
      ["missionId", "proposal"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "pact.propose-allocation.v1",
  }),
  capability({
    name: "guild.accept_pact",
    title: "Accept exact mission pact",
    description:
      "Sign and accept one exact pact digest for the active agent's role slot.",
    inputSchema: objectSchema(
      {
        commandId: COMMAND_ID,
        missionId: STRING_ID,
        pactDigest: STRING_ID,
        proof: LONG_TEXT,
      },
      ["missionId", "pactDigest", "proof"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "pact.accept.v1",
  }),
  capability({
    name: "guild.report_progress",
    title: "Report mission progress",
    description:
      "Append bounded progress for the active agent's accepted role slot.",
    inputSchema: objectSchema(
      { commandId: COMMAND_ID, missionId: STRING_ID, progress: LONG_TEXT },
      ["missionId", "progress"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "execution.progress.v1",
  }),
  capability({
    name: "guild.submit_artifact",
    title: "Submit mission artifact",
    description:
      "Submit a signed, bounded artifact for the active agent's accepted role slot.",
    inputSchema: objectSchema(
      {
        commandId: COMMAND_ID,
        missionId: STRING_ID,
        artifact: LONG_TEXT,
        proof: LONG_TEXT,
      },
      ["missionId", "artifact", "proof"],
    ),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: false,
    untrustedOutput: true,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "artifact.submit.v1",
  }),
  capability({
    name: "guild.inspect_receipt",
    title: "Inspect mission receipt",
    description:
      "Read the terminal verification receipt and receipt-backed reputation deltas.",
    inputSchema: objectSchema({ missionId: STRING_ID }, ["missionId"]),
    outputSchema: PUBLIC_OUTPUT,
    readOnly: true,
    untrustedOutput: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "receipt.inspect.v1",
  }),
] satisfies readonly CapabilityDefinition[]);
