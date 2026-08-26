import {
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  type AgentSkill,
} from "@a2a-js/sdk";

export const COMMITMENT_EXTENSION_URI =
  "https://guildhall.example/extensions/commitment/v1";

export type HostedAgentKind = "scout" | "scribe" | "warden";

type HostedAgentProfile = Readonly<{
  description: string;
  displayName: string;
  skill: AgentSkill;
}>;

const JSON_MODE = "application/json";

const profiles: Readonly<Record<HostedAgentKind, HostedAgentProfile>> = {
  scout: {
    displayName: "Guildhall Scout",
    description:
      "Deterministic accessibility-finding agent for Guildhall reference missions.",
    skill: {
      id: "accessibility-findings",
      name: "Accessibility Findings",
      description:
        "Inspects the public fixture and returns protocol-shaped accessibility findings.",
      tags: ["accessibility", "audit", "deterministic"],
      examples: [
        "Find accessibility issues in the Guildhall reference fixture.",
      ],
      inputModes: [JSON_MODE],
      outputModes: [JSON_MODE],
      securityRequirements: [],
    },
  },
  scribe: {
    displayName: "Guildhall Scribe",
    description:
      "Deterministic remediation-planning agent with a controlled failure fixture.",
    skill: {
      id: "accessibility-remediation",
      name: "Accessibility Remediation Plan",
      description:
        "Turns accessibility findings into a structured remediation plan.",
      tags: ["accessibility", "remediation", "deterministic"],
      examples: ["Plan remediations for the Guildhall reference findings."],
      inputModes: [JSON_MODE],
      outputModes: [JSON_MODE],
      securityRequirements: [],
    },
  },
  warden: {
    displayName: "Guildhall Warden",
    description:
      "Deterministic replacement agent able to inherit either reference assignment.",
    skill: {
      id: "accessibility-recovery",
      name: "Accessibility Mission Recovery",
      description:
        "Continues an unchanged finding or remediation role after a helper defaults.",
      tags: ["accessibility", "replacement", "recovery", "deterministic"],
      examples: [
        "Inherit the exact role slot from a defaulted Guildhall helper.",
      ],
      inputModes: [JSON_MODE],
      outputModes: [JSON_MODE],
      securityRequirements: [],
    },
  },
};

export function buildAgentCard(
  kind: HostedAgentKind,
  origin: string,
): AgentCard {
  const profile = profiles[kind];

  return {
    name: profile.displayName,
    description: profile.description,
    supportedInterfaces: [
      {
        url: `${origin}/a2a`,
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: "Guildhall",
      url: origin,
    },
    version: "0.0.0-spike",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: COMMITMENT_EXTENSION_URI,
          description:
            "Bounded party formation, immutable pact acceptance, replacement, and receipts.",
          required: true,
          params: undefined,
        },
      ],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [JSON_MODE],
    defaultOutputModes: [JSON_MODE],
    skills: [profile.skill],
    signatures: [],
  };
}
