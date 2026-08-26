import {
  A2A_PROTOCOL_VERSION,
  COMMITMENT_V1_EXTENSION_URI,
} from "./constants.js";
import type { A2AAgentCard, A2AAgentSkill, JsonObject } from "./types.js";
import { validateA2AAgentCard } from "./validation.js";

export interface CreateA2AAgentCardOptions {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly endpointUrl: string;
  readonly skills: readonly A2AAgentSkill[];
  readonly provider?: {
    readonly organization: string;
    readonly url: string;
  };
  readonly documentationUrl?: string;
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  readonly securitySchemes?: JsonObject;
  readonly securityRequirements?: readonly JsonObject[];
  readonly requiredExtensionUri?: string;
}

export function createA2AAgentCard(
  options: CreateA2AAgentCardOptions,
): A2AAgentCard {
  const extensionUri =
    options.requiredExtensionUri ?? COMMITMENT_V1_EXTENSION_URI;
  const card: A2AAgentCard = {
    name: options.name,
    description: options.description,
    supportedInterfaces: [
      {
        url: options.endpointUrl.replace(/\/$/u, ""),
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    version: options.version,
    ...(options.documentationUrl === undefined
      ? {}
      : { documentationUrl: options.documentationUrl }),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: extensionUri,
          description:
            "Bounded Guildhall party formation, pact acceptance, artifact delivery, and receipts.",
          required: true,
        },
      ],
    },
    securitySchemes: options.securitySchemes ?? {},
    securityRequirements: options.securityRequirements ?? [],
    defaultInputModes: options.defaultInputModes ?? ["application/json"],
    defaultOutputModes: options.defaultOutputModes ?? ["application/json"],
    skills: options.skills,
    signatures: [],
  };
  validateA2AAgentCard(card, extensionUri);
  return Object.freeze(card);
}
