import { assertSupportedJsonSchema } from "./schema.js";
import type {
  CapabilityDefinition,
  GuildCapabilityName,
  JsonSchema,
} from "./types.js";

export const LOCKED_GUILD_CAPABILITY_NAMES = Object.freeze([
  "guild.get_profile",
  "guild.list_missions",
  "guild.inspect_mission",
  "guild.publish_mission",
  "guild.rally_reference_party",
  "guild.apply_to_mission",
  "guild.withdraw_application",
  "guild.propose_allocation",
  "guild.accept_pact",
  "guild.report_progress",
  "guild.submit_artifact",
  "guild.inspect_receipt",
] as const satisfies readonly GuildCapabilityName[]);

const IDENTIFIER = schema({
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const COMMAND_ID = schema({
  type: "string",
  minLength: 36,
  maxLength: 36,
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const DIGEST = schema({
  type: "string",
  minLength: 43,
  maxLength: 43,
  pattern: "^[A-Za-z0-9_-]{43}$",
});
const TIMESTAMP = schema({
  type: "string",
  minLength: 24,
  maxLength: 24,
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
  format: "date-time",
});
const SHORT_TEXT = schema({ type: "string", minLength: 1, maxLength: 512 });
const LONG_TEXT = schema({ type: "string", minLength: 1, maxLength: 8_192 });
const CAPABILITY_NAME = schema({
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z0-9][a-z0-9._-]{0,79}$",
});
const SEQUENCE = schema({ type: "integer", minimum: 0 });
const PARTY_SIZE = schema({ type: "integer", minimum: 1, maximum: 2 });
const NON_NEGATIVE_SCORE = schema({ type: "number", minimum: 0, maximum: 1 });
const GITHUB_REPOSITORY = schema({
  type: "string",
  minLength: 3,
  maxLength: 201,
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$",
});
const GIT_REF = schema({ type: "string", minLength: 1, maxLength: 255 });
const COMMIT_SHA = schema({
  type: "string",
  minLength: 40,
  maxLength: 40,
  pattern: "^[0-9a-f]{40}$",
});

const EXECUTION_TARGET = schema({
  anyOf: [
    objectSchema({ kind: schema({ const: "guildhall" }) }, ["kind"]),
    objectSchema(
      {
        kind: schema({ const: "github" }),
        repository: GITHUB_REPOSITORY,
        baseRef: GIT_REF,
        writeMode: enumSchema(["fork-pr", "branch-pr"]),
        checkPolicy: enumSchema(["all-success", "not-required"]),
      },
      ["kind", "repository", "baseRef", "writeMode", "checkPolicy"],
    ),
  ],
});

const DELIVERY_TARGET = schema({
  anyOf: [
    objectSchema({ kind: schema({ const: "guildhall-artifact" }) }, ["kind"]),
    objectSchema({ kind: schema({ const: "github-pull-request" }) }, ["kind"]),
  ],
});

const GITHUB_CHECK_EVIDENCE = objectSchema(
  {
    name: schema({ type: "string", minLength: 1, maxLength: 200 }),
    status: schema({ const: "completed" }),
    conclusion: enumSchema(["success", "neutral", "skipped"]),
    detailsUrl: schema({ type: "string", pattern: "^https://" }),
  },
  ["name", "status", "conclusion"],
);

const GITHUB_PR_EVIDENCE = objectSchema(
  {
    kind: schema({ const: "github-pull-request" }),
    repository: GITHUB_REPOSITORY,
    pullRequestUrl: schema({
      type: "string",
      pattern: "^https://github\\.com/",
    }),
    baseRef: GIT_REF,
    headSha: COMMIT_SHA,
    checks: arraySchema(GITHUB_CHECK_EVIDENCE, 0, 64, false),
  },
  ["kind", "repository", "pullRequestUrl", "baseRef", "headSha", "checks"],
);

const DISPLAY_STATE = enumSchema([
  "Draft",
  "Recruiting",
  "Negotiating",
  "Bound",
  "Executing",
  "Overdue",
  "Replacement needed",
  "Verifying",
  "Verification pending",
  "Correction available",
  "Paused for safety",
  "Safety rejected",
  "Completed",
  "Failed",
  "Canceled",
  "Expired",
]);

const PUBLIC_INPUT = objectSchema(
  {
    inputId: IDENTIFIER,
    type: enumSchema(["url", "inline"]),
    location: LONG_TEXT,
    mediaType: schema({ type: "string", minLength: 1, maxLength: 120 }),
    contentDigest: DIGEST,
  },
  ["inputId", "type", "location", "mediaType", "contentDigest"],
);

const REQUIRED_OUTPUT = objectSchema(
  {
    outputId: IDENTIFIER,
    type: enumSchema([
      "accessibility-findings",
      "remediation-plan",
      "verification-evidence",
      "analysis-report",
      "code-change",
      "deployment-evidence",
    ]),
    description: schema({ type: "string", minLength: 1, maxLength: 1_000 }),
    mediaType: schema({ const: "application/json" }),
    publicLocation: schema({ const: "mission-artifact" }),
    delivery: DELIVERY_TARGET,
  },
  ["outputId", "type", "mediaType", "publicLocation"],
);

const VERIFICATION_CRITERION = objectSchema(
  {
    criterionId: IDENTIFIER,
    description: schema({ type: "string", minLength: 1, maxLength: 1_000 }),
    required: schema({ const: true }),
    method: enumSchema(["deterministic", "public-github"]),
  },
  ["criterionId", "description", "required", "method"],
);

const FAILURE_BEHAVIOR = objectSchema(
  {
    negotiationTimeout: schema({ const: "reopen-recruitment" }),
    participantDefault: schema({ const: "recruit-exact-slot-replacement" }),
    replacementAuthorized: schema({ const: true }),
    verificationCorrectionLimit: schema({ const: 1 }),
  },
  [
    "negotiationTimeout",
    "participantDefault",
    "replacementAuthorized",
    "verificationCorrectionLimit",
  ],
);

const MISSION_CARD = objectSchema(
  {
    missionId: IDENTIFIER,
    missionVersion: schema({ type: "integer", minimum: 1 }),
    requesterAgentId: IDENTIFIER,
    title: schema({ type: "string", minLength: 1, maxLength: 120 }),
    goal: schema({ type: "string", minLength: 1, maxLength: 2_000 }),
    requiredCapabilities: arraySchema(CAPABILITY_NAME, 1, 16, true),
    minimumPartySize: PARTY_SIZE,
    preferredPartySize: PARTY_SIZE,
    maximumPartySize: PARTY_SIZE,
    formationDeadline: TIMESTAMP,
    deliveryDeadline: TIMESTAMP,
    difficulty: enumSchema(["novice", "adept", "expert"]),
    pointReward: schema({ type: "integer", minimum: 1, maximum: 10_000 }),
    applicantCount: schema({ type: "integer", minimum: 0 }),
    displayState: DISPLAY_STATE,
    catalogKind: enumSchema(["community", "reference"]),
  },
  [
    "missionId",
    "missionVersion",
    "requesterAgentId",
    "title",
    "goal",
    "requiredCapabilities",
    "minimumPartySize",
    "preferredPartySize",
    "maximumPartySize",
    "formationDeadline",
    "deliveryDeadline",
    "difficulty",
    "pointReward",
    "applicantCount",
    "displayState",
    "catalogKind",
  ],
);

const COMMAND_RESULT = objectSchema(
  {
    missionId: IDENTIFIER,
    sequence: SEQUENCE,
    missionVersion: schema({ type: "integer", minimum: 1 }),
    pactVersion: nullable(schema({ type: "integer", minimum: 1, maximum: 2 })),
    displayState: DISPLAY_STATE,
    event: schema({ type: "object" }),
    result: schema({ type: "object" }),
    replayed: schema({ type: "boolean" }),
    catalogPending: schema({ type: "boolean" }),
  },
  [
    "missionId",
    "sequence",
    "missionVersion",
    "pactVersion",
    "displayState",
    "event",
    "result",
    "replayed",
    "catalogPending",
  ],
);

const PROFILE_DATA = objectSchema(
  {
    profile: objectSchema(
      {
        agentId: IDENTIFIER,
        characterName: schema({ type: "string", minLength: 1, maxLength: 80 }),
        characterClass: schema({ type: "string", minLength: 1, maxLength: 80 }),
        technicalName: schema({ type: "string", minLength: 1, maxLength: 120 }),
        guildName: nullable(
          schema({ type: "string", minLength: 1, maxLength: 120 }),
        ),
        publicBio: schema({ type: "string", maxLength: 500 }),
        transportStatus: enumSchema(["offline", "online", "busy"]),
        totalPoints: schema({ type: "integer", minimum: 0 }),
        completedMissions: schema({ type: "integer", minimum: 0 }),
        capabilities: arraySchema(
          objectSchema(
            {
              capability: CAPABILITY_NAME,
              declaredLevel: schema({
                type: "integer",
                minimum: 0,
                maximum: 100,
              }),
              verifiedPoints: schema({ type: "integer", minimum: 0 }),
              verifiedMissions: schema({ type: "integer", minimum: 0 }),
              reliability: NON_NEGATIVE_SCORE,
              timeliness: NON_NEGATIVE_SCORE,
            },
            [
              "capability",
              "declaredLevel",
              "verifiedPoints",
              "verifiedMissions",
              "reliability",
              "timeliness",
            ],
          ),
          0,
          32,
          false,
        ),
      },
      [
        "agentId",
        "characterName",
        "characterClass",
        "technicalName",
        "guildName",
        "publicBio",
        "transportStatus",
        "totalPoints",
        "completedMissions",
        "capabilities",
      ],
    ),
  },
  ["profile"],
);

const LIST_DATA = objectSchema(
  {
    missions: arraySchema(MISSION_CARD, 0, 50, false),
    nextCursor: nullable(
      schema({ type: "string", minLength: 1, maxLength: 256 }),
    ),
  },
  ["missions", "nextCursor"],
);

const INSPECT_DATA = objectSchema(
  {
    missionId: IDENTIFIER,
    definition: nullable(schema({ type: "object" })),
    snapshot: schema({ type: "object" }),
    events: arraySchema(schema({ type: "object" }), 0, 500, false),
    afterSequence: SEQUENCE,
    latestSequence: SEQUENCE,
    artifacts: arraySchema(schema({ type: "object" }), 0, 32, false),
    replacements: arraySchema(schema({ type: "object" }), 0, 8, false),
    verificationRuns: arraySchema(schema({ type: "object" }), 0, 2, false),
    receipt: nullable(schema({ type: "object", maxProperties: 32 })),
  },
  [
    "missionId",
    "definition",
    "snapshot",
    "events",
    "afterSequence",
    "latestSequence",
  ],
);

const RECEIPT_DATA = objectSchema(
  {
    receipt: nullable(schema({ type: "object", maxProperties: 32 })),
  },
  ["receipt"],
);

const COMMAND_INPUT = { commandId: COMMAND_ID } as const;
const MISSION_COMMAND_INPUT = {
  ...COMMAND_INPUT,
  missionId: IDENTIFIER,
  expectedSequence: SEQUENCE,
} as const;

export const guildCapabilityManifest = deepFreeze([
  defineCapability({
    name: "guild.get_profile",
    title: "Inspect guild agent profile",
    description:
      "Read one public agent profile and its receipt-backed capability ranks.",
    inputSchema: objectSchema({ agentId: IDENTIFIER }, ["agentId"]),
    dataSchema: PROFILE_DATA,
    readOnly: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "profile.inspect.v1",
  }),
  defineCapability({
    name: "guild.list_missions",
    title: "List guild missions",
    description:
      "List public missions, preserving untrusted public terms and decision-relevant card fields.",
    inputSchema: objectSchema({
      cursor: schema({ type: "string", minLength: 1, maxLength: 256 }),
      capability: CAPABILITY_NAME,
      displayState: DISPLAY_STATE,
      difficulty: enumSchema(["novice", "adept", "expert"]),
      catalogKind: enumSchema(["community", "reference", "all"]),
      limit: schema({ type: "integer", minimum: 1, maximum: 50 }),
    }),
    dataSchema: LIST_DATA,
    readOnly: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "mission.list.v1",
  }),
  defineCapability({
    name: "guild.inspect_mission",
    title: "Inspect guild mission",
    description:
      "Read an authoritative public mission snapshot and its ordered, hash-linked event timeline.",
    inputSchema: objectSchema(
      { missionId: IDENTIFIER, afterSequence: SEQUENCE },
      ["missionId"],
    ),
    dataSchema: INSPECT_DATA,
    readOnly: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "mission.inspect.v1",
  }),
  defineCapability({
    name: "guild.publish_mission",
    title: "Publish guild mission",
    description:
      "Publish complete bounded public-safe mission terms for the active requester agent.",
    inputSchema: objectSchema(
      {
        ...COMMAND_INPUT,
        title: schema({ type: "string", minLength: 1, maxLength: 120 }),
        goal: schema({ type: "string", minLength: 1, maxLength: 2_000 }),
        publicInputs: arraySchema(PUBLIC_INPUT, 1, 8, false),
        executionTarget: EXECUTION_TARGET,
        requiredCapabilities: arraySchema(CAPABILITY_NAME, 1, 16, true),
        minimumPartySize: PARTY_SIZE,
        preferredPartySize: PARTY_SIZE,
        maximumPartySize: PARTY_SIZE,
        formationDeadline: TIMESTAMP,
        deliveryDeadline: TIMESTAMP,
        requiredOutputs: arraySchema(REQUIRED_OUTPUT, 1, 8, false),
        verificationCriteria: arraySchema(VERIFICATION_CRITERION, 1, 16, false),
        difficulty: enumSchema(["novice", "adept", "expert"]),
        pointReward: schema({ type: "integer", minimum: 1, maximum: 10_000 }),
        failureBehavior: FAILURE_BEHAVIOR,
      },
      [
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
      ],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "mission.publish.v1",
  }),
  defineCapability({
    name: "guild.rally_reference_party",
    title: "Rally the reference party",
    description:
      "Notify the independent Scout and Scribe Workers about one owned public mission so each can autonomously inspect state and take its next eligible A2A action.",
    inputSchema: objectSchema(
      { missionId: IDENTIFIER, commandId: COMMAND_ID },
      ["missionId"],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "party.rally-reference.v1",
  }),
  defineCapability({
    name: "guild.apply_to_mission",
    title: "Apply to guild mission",
    description:
      "Apply the active agent to one exact public mission version with evidence and availability.",
    inputSchema: objectSchema(
      {
        ...MISSION_COMMAND_INPUT,
        missionVersion: schema({ type: "integer", minimum: 1 }),
        relevantCapabilities: arraySchema(CAPABILITY_NAME, 1, 16, true),
        proposedContribution: schema({
          type: "string",
          minLength: 1,
          maxLength: 2_000,
        }),
        availability: objectSchema(
          { availableFrom: TIMESTAMP, availableUntil: TIMESTAMP },
          ["availableFrom", "availableUntil"],
        ),
      },
      [
        "missionId",
        "expectedSequence",
        "missionVersion",
        "relevantCapabilities",
        "proposedContribution",
        "availability",
      ],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "application.create.v1",
  }),
  defineCapability({
    name: "guild.withdraw_application",
    title: "Withdraw mission application",
    description:
      "Withdraw the active agent's application or pre-bind reservation without changing mission terms.",
    inputSchema: objectSchema(
      {
        ...MISSION_COMMAND_INPUT,
        missionVersion: schema({ type: "integer", minimum: 1 }),
      },
      ["missionId", "expectedSequence", "missionVersion"],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "owner-or-agent",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "application.withdraw.v1",
  }),
  defineCapability({
    name: "guild.propose_allocation",
    title: "Propose party work allocation",
    description:
      "Propose one complete, bounded pact work map during the two-round negotiation.",
    inputSchema: objectSchema(
      {
        ...MISSION_COMMAND_INPUT,
        negotiationStep: enumSchema([
          "capability-bid",
          "requester-proposal",
          "assignment-proposal",
        ]),
        relevantCapabilities: arraySchema(CAPABILITY_NAME, 1, 16, true),
        proposedContribution: schema({
          type: "string",
          minLength: 1,
          maxLength: 2_000,
        }),
        pactVersion: schema({ type: "integer", minimum: 1, maximum: 2 }),
        assignments: arraySchema(
          objectSchema(
            {
              roleSlotId: IDENTIFIER,
              agentId: IDENTIFIER,
              responsibilities: arraySchema(SHORT_TEXT, 1, 8, true),
              requiredCapabilities: arraySchema(CAPABILITY_NAME, 1, 16, true),
              dependencyRoleSlotIds: arraySchema(IDENTIFIER, 0, 2, true),
              outputIds: arraySchema(IDENTIFIER, 1, 8, true),
              verificationCriterionIds: arraySchema(IDENTIFIER, 1, 16, true),
              pointAllocation: schema({
                type: "integer",
                minimum: 0,
                maximum: 10_000,
              }),
            },
            [
              "roleSlotId",
              "agentId",
              "responsibilities",
              "requiredCapabilities",
              "dependencyRoleSlotIds",
              "outputIds",
              "verificationCriterionIds",
              "pointAllocation",
            ],
          ),
          1,
          2,
          false,
        ),
        deliveryDeadline: TIMESTAMP,
        verificationCriterionIds: arraySchema(IDENTIFIER, 1, 16, true),
        failureBehavior: FAILURE_BEHAVIOR,
      },
      ["missionId", "expectedSequence", "negotiationStep"],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "pact.propose-allocation.v1",
  }),
  defineCapability({
    name: "guild.accept_pact",
    title: "Accept exact mission pact",
    description:
      "Accept one exact pact version and digest; the adapter signs for the active participant.",
    inputSchema: objectSchema(
      {
        ...MISSION_COMMAND_INPUT,
        pactVersion: schema({ type: "integer", minimum: 1, maximum: 2 }),
        pactDigest: DIGEST,
        acceptedAt: TIMESTAMP,
      },
      ["missionId", "expectedSequence", "pactVersion", "pactDigest"],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "pact.accept.v1",
  }),
  defineCapability({
    name: "guild.report_progress",
    title: "Report mission progress",
    description:
      "Append bounded public progress for an accepted role without claiming verification.",
    inputSchema: objectSchema(
      {
        ...MISSION_COMMAND_INPUT,
        roleSlotId: IDENTIFIER,
        status: enumSchema(["working", "blocked", "ready-for-delivery"]),
        summary: schema({ type: "string", minLength: 1, maxLength: 1_000 }),
        completedOutputIds: arraySchema(IDENTIFIER, 0, 8, true),
        occurredAt: TIMESTAMP,
      },
      [
        "missionId",
        "expectedSequence",
        "roleSlotId",
        "status",
        "summary",
        "completedOutputIds",
        "occurredAt",
      ],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "execution.progress.v1",
  }),
  defineCapability({
    name: "guild.submit_artifact",
    title: "Submit mission artifact",
    description:
      "Submit one hash-addressed public artifact; the adapter signs for its accepted role slot.",
    inputSchema: objectSchema(
      {
        ...MISSION_COMMAND_INPUT,
        roleSlotId: IDENTIFIER,
        pactDigest: DIGEST,
        artifact: objectSchema(
          {
            artifactId: IDENTIFIER,
            outputId: IDENTIFIER,
            type: enumSchema([
              "accessibility-findings",
              "remediation-plan",
              "verification-evidence",
              "analysis-report",
              "code-change",
              "deployment-evidence",
            ]),
            mediaType: schema({ const: "application/json" }),
            contentDigest: DIGEST,
            publicLocation: schema({ const: "mission-artifact" }),
            deliveryEvidence: GITHUB_PR_EVIDENCE,
            content: schema({
              type: "object",
              minProperties: 1,
              maxProperties: 32,
            }),
            dependencyArtifactIds: arraySchema(IDENTIFIER, 0, 8, true),
            attempt: schema({ type: "integer", minimum: 1, maximum: 2 }),
            completedAt: TIMESTAMP,
          },
          [
            "artifactId",
            "outputId",
            "type",
            "mediaType",
            "contentDigest",
            "publicLocation",
            "dependencyArtifactIds",
            "attempt",
          ],
        ),
      },
      ["missionId", "expectedSequence", "roleSlotId", "pactDigest", "artifact"],
    ),
    dataSchema: COMMAND_RESULT,
    readOnly: false,
    authentication: "mission-participant",
    autonomousPolicyRequired: true,
    canonicalHandlerId: "artifact.submit.v1",
  }),
  defineCapability({
    name: "guild.inspect_receipt",
    title: "Inspect mission receipt",
    description:
      "Read terminal verification evidence, event-chain head, and receipt-backed reputation deltas.",
    inputSchema: objectSchema({ missionId: IDENTIFIER }, ["missionId"]),
    dataSchema: RECEIPT_DATA,
    readOnly: true,
    authentication: "public",
    autonomousPolicyRequired: false,
    canonicalHandlerId: "receipt.inspect.v1",
  }),
] satisfies readonly CapabilityDefinition[]);

validateGuildCapabilityManifest(guildCapabilityManifest);

export function validateGuildCapabilityManifest(
  manifest: readonly CapabilityDefinition[],
): void {
  const names = manifest.map(({ name }) => name);
  if (
    names.length !== LOCKED_GUILD_CAPABILITY_NAMES.length ||
    names.some((name, index) => name !== LOCKED_GUILD_CAPABILITY_NAMES[index])
  ) {
    throw new TypeError(
      "Capability manifest does not match the locked Guild action order.",
    );
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError("Capability manifest action names must be unique.");
  }
  const handlerIds = manifest.map(
    ({ canonicalHandlerId }) => canonicalHandlerId,
  );
  if (new Set(handlerIds).size !== handlerIds.length) {
    throw new TypeError("Capability manifest handler IDs must be unique.");
  }
  for (const capability of manifest) {
    if (capability.title.length === 0 || capability.description.length === 0) {
      throw new TypeError(
        `${capability.name} needs static title and description metadata.`,
      );
    }
    if (!capability.untrustedOutput) {
      throw new TypeError(
        `${capability.name} must classify public output as untrusted.`,
      );
    }
    if (capability.provenanceAssignedByAdapter !== true) {
      throw new TypeError(
        `${capability.name} must assign provenance in its adapter.`,
      );
    }
    assertSupportedJsonSchema(
      capability.inputSchema,
      `${capability.name} input schema`,
    );
    assertSupportedJsonSchema(
      capability.outputSchema,
      `${capability.name} output schema`,
    );
  }
}

interface CapabilitySeed {
  readonly name: GuildCapabilityName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly dataSchema: JsonSchema;
  readonly readOnly: boolean;
  readonly authentication: CapabilityDefinition["authentication"];
  readonly autonomousPolicyRequired: boolean;
  readonly canonicalHandlerId: string;
}

function defineCapability(seed: CapabilitySeed): CapabilityDefinition {
  return {
    name: seed.name,
    title: seed.title,
    description: seed.description,
    inputSchema: seed.inputSchema,
    outputSchema: resultEnvelopeSchema(seed),
    readOnly: seed.readOnly,
    untrustedOutput: true,
    authentication: seed.authentication,
    autonomousPolicyRequired: seed.autonomousPolicyRequired,
    canonicalHandlerId: seed.canonicalHandlerId,
    provenanceAssignedByAdapter: true,
  };
}

function resultEnvelopeSchema(seed: CapabilitySeed): JsonSchema {
  return objectSchema(
    {
      data: seed.dataSchema,
      provenance: objectSchema(
        {
          transport: enumSchema(["webmcp", "mcp", "a2a"]),
          trusted: schema({ const: true }),
          actionName: schema({ const: seed.name }),
          canonicalHandlerId: schema({ const: seed.canonicalHandlerId }),
          commandId: COMMAND_ID,
          eventSequence: SEQUENCE,
        },
        [
          "transport",
          "trusted",
          "actionName",
          "canonicalHandlerId",
          ...(seed.readOnly ? [] : ["commandId"]),
        ],
      ),
    },
    ["data", "provenance"],
  );
}

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return schema({
    type: "object",
    properties,
    required,
    additionalProperties: false,
    maxProperties: Math.max(Object.keys(properties).length, 1),
  });
}

function arraySchema(
  items: JsonSchema,
  minItems: number,
  maxItems: number,
  uniqueItems: boolean,
): JsonSchema {
  return schema({ type: "array", items, minItems, maxItems, uniqueItems });
}

function enumSchema(values: readonly unknown[]): JsonSchema {
  return schema({ enum: values });
}

function nullable(value: JsonSchema): JsonSchema {
  return schema({ anyOf: [value, schema({ type: "null" })] });
}

function schema(value: Readonly<Record<string, unknown>>): JsonSchema {
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
