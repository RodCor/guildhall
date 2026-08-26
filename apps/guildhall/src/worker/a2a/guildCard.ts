import {
  A2A_PROTOCOL_VERSION,
  COMMITMENT_V1_EXTENSION_URI,
  type A2AAgentCard,
  type A2AAgentSkill,
} from "@guildhall/a2a-worker";

const JSON_MODE = "application/json";
const SIGNED_AGENT_REQUIREMENT = [
  {
    schemes: {
      guildCredential: { list: [] },
      guildKeyId: { list: [] },
      guildIssuedAt: { list: [] },
      guildNonce: { list: [] },
      guildSignature: { list: [] },
    },
  },
] as const;

const skills: readonly A2AAgentSkill[] = [
  {
    id: "guild-mission-discovery",
    name: "Discover Guild missions",
    description:
      "Lists and inspects public-safe Guild missions and their ordered public history.",
    tags: ["guildhall", "missions", "discovery"],
    examples: ["List open Guild missions matching accessibility-audit."],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    securityRequirements: [],
  },
  {
    id: "guild-party-formation",
    name: "Join a party and negotiate a pact",
    description:
      "Applies to a mission, participates in bounded work allocation, and accepts one immutable pact digest.",
    tags: ["guildhall", "party", "commitment", "negotiation"],
    examples: ["Apply to the mission and propose the findings role."],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    securityRequirements: [...SIGNED_AGENT_REQUIREMENT],
  },
  {
    id: "guild-artifact-and-receipt",
    name: "Deliver artifacts and inspect receipts",
    description:
      "Reports role progress, submits signed public artifacts, and retrieves deterministic verification receipts.",
    tags: ["guildhall", "artifact", "receipt", "verification"],
    examples: ["Submit the signed findings artifact for my bound role slot."],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE],
    securityRequirements: [...SIGNED_AGENT_REQUIREMENT],
  },
];

export function buildGuildBrokerCard(origin: string): A2AAgentCard {
  return {
    name: "Guildhall Guild Broker",
    description:
      "A2A gateway to Guildhall's canonical mission, party, pact, and public receipt timeline.",
    supportedInterfaces: [
      {
        url: `${origin}/a2a/guild/v1`,
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: "Guildhall", url: origin },
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: COMMITMENT_V1_EXTENSION_URI,
          description:
            "Maps A2A messages and artifacts to commitment/v1 missions, work allocation, proofs, and receipts.",
          required: true,
        },
      ],
      extendedAgentCard: false,
    },
    securitySchemes: {
      guildCredential: apiKeyHeader(
        "Authorization",
        "Scoped Guild credential using the GuildNode authorization scheme.",
      ),
      guildKeyId: apiKeyHeader(
        "X-Guild-Key-Id",
        "Registered Ed25519 key identifier.",
      ),
      guildIssuedAt: apiKeyHeader(
        "X-Guild-Issued-At",
        "Fresh request timestamp covered by the signature.",
      ),
      guildNonce: apiKeyHeader(
        "X-Guild-Nonce",
        "Single-use request nonce covered by the signature.",
      ),
      guildSignature: apiKeyHeader(
        "X-Guild-Signature",
        "Ed25519 signature over the canonical Guild request target and body.",
      ),
    },
    securityRequirements: [],
    defaultInputModes: [JSON_MODE],
    defaultOutputModes: [JSON_MODE],
    skills: [...skills],
    signatures: [],
  };
}

function apiKeyHeader(name: string, description: string) {
  return {
    apiKeySecurityScheme: { description, location: "header", name },
  } as const;
}
