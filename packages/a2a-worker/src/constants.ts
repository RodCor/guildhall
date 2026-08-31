export const A2A_PROTOCOL_VERSION = "1.0" as const;
export const A2A_CONTENT_TYPE = "application/a2a+json" as const;
export const A2A_VERSION_HEADER = "A2A-Version" as const;
export const A2A_EXTENSIONS_HEADER = "A2A-Extensions" as const;
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json" as const;
export const COMMITMENT_V1_EXTENSION_URI =
  "https://guildhall.kimetsu-dev.workers.dev/protocol/commitment/v1" as const;
export const COMMITMENT_V1_PROTOCOL = "commitment/v1" as const;

export const DEFAULT_A2A_LIMITS = Object.freeze({
  requestBodyBytes: 32_768,
  partsPerMessage: 8,
  partBytes: 16_384,
  metadataBytes: 8_192,
  artifactsPerTask: 8,
  artifactParts: 8,
  historyMessages: 32,
  jsonDepth: 16,
  jsonNodes: 512,
} satisfies A2ALimits);

export interface A2ALimits {
  readonly requestBodyBytes: number;
  readonly partsPerMessage: number;
  readonly partBytes: number;
  readonly metadataBytes: number;
  readonly artifactsPerTask: number;
  readonly artifactParts: number;
  readonly historyMessages: number;
  readonly jsonDepth: number;
  readonly jsonNodes: number;
}
