import type { AgentSkill } from "@a2a-js/sdk";
import {
  COMMITMENT_V1_EXTENSION_URI,
  createA2AAgentCard,
  type A2AAgentCard,
  type A2AAgentSkill,
} from "@guildhall/a2a-worker";

import { hostedIdentity } from "./identity";

export type HostedAgentKind = "scout" | "scribe" | "warden";

interface HostedAgentProfile {
  readonly description: string;
  readonly displayName: string;
  readonly skill: AgentSkill;
}

const JSON_MODE = "application/json";

const profiles: Readonly<Record<HostedAgentKind, HostedAgentProfile>> = {
  scout: {
    displayName: "Guildhall Scout",
    description:
      "Deterministic parser for the allowlisted Accessibility Dungeon fixture; produces signed structured findings and never fetches arbitrary URLs.",
    skill: {
      id: "accessibility-findings",
      name: "Accessibility Findings",
      description:
        "Parses only accessibility-dungeon-v1 and returns deterministic structured findings.",
      tags: ["accessibility", "audit", "deterministic", "bounded-fixture"],
      examples: ["Inspect accessibility-dungeon-v1 as the bound scout role."],
      inputModes: [JSON_MODE],
      outputModes: [JSON_MODE],
      securityRequirements: [],
    },
  },
  scribe: {
    displayName: "Guildhall Scribe",
    description:
      "Deterministic remediation-template agent for supplied structured findings, including one explicit controlled-failure demo scenario.",
    skill: {
      id: "accessibility-remediation",
      name: "Accessibility Remediation Plan",
      description:
        "Produces one remediation step for every supplied finding; the named demo fixture may intentionally fail the remote task.",
      tags: [
        "accessibility",
        "remediation",
        "deterministic",
        "failure-fixture",
      ],
      examples: ["Plan remediations for Scout's structured findings."],
      inputModes: [JSON_MODE],
      outputModes: [JSON_MODE],
      securityRequirements: [],
    },
  },
  warden: {
    displayName: "Guildhall Warden",
    description:
      "Deterministic recovery agent that accepts Scout or Scribe work only when role, slot, pact, and assignment digest are unchanged.",
    skill: {
      id: "accessibility-exact-role-recovery",
      name: "Exact-role Accessibility Recovery",
      description:
        "Recovers an unchanged Scout or Scribe assignment after validating exact replacement invariants.",
      tags: ["accessibility", "replacement", "recovery", "exact-role"],
      examples: ["Inherit the unchanged role slot from a defaulted helper."],
      inputModes: [JSON_MODE],
      outputModes: [JSON_MODE],
      securityRequirements: [],
    },
  },
};

export function buildAgentCard(
  kind: HostedAgentKind,
  origin: string,
  publicKeyX?: string,
  keyId?: string,
): A2AAgentCard {
  const profile = profiles[kind];
  const identity = hostedIdentity(kind, publicKeyX, keyId);
  const base = createA2AAgentCard({
    name: profile.displayName,
    description: profile.description,
    version: "1.0.0",
    endpointUrl: `${origin}/a2a/v1`,
    provider: { organization: "Guildhall", url: origin },
    skills: [toAdapterSkill(profile.skill)],
  });
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      extensions: base.capabilities.extensions.map((extension) =>
        extension.uri === COMMITMENT_V1_EXTENSION_URI
          ? {
              ...extension,
              params: {
                agentId: identity.agentId,
                artifactSignatureDomain: "PACTBRIDGE-ARTIFACT-V1",
                keyId: identity.keyId,
                publicJwk: identity.publicJwk,
              },
            }
          : extension,
      ),
    },
  };
}

function toAdapterSkill(skill: AgentSkill): A2AAgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    examples: skill.examples,
    inputModes: skill.inputModes,
    outputModes: skill.outputModes,
    securityRequirements: [],
  };
}
