import { guildCapabilityManifest } from "./manifest.js";
import { assertJsonSchemaValue } from "./schema.js";
import type {
  CapabilityDefinition,
  CapabilityResultEnvelope,
  CapabilityTransport,
  GuildCapabilityName,
} from "./types.js";

export interface CapabilityResultMetadata {
  readonly commandId?: string;
  readonly eventSequence?: number;
}

export function getCapabilityDefinition(
  name: GuildCapabilityName,
  manifest: readonly CapabilityDefinition[] = guildCapabilityManifest,
): CapabilityDefinition {
  const capability = manifest.find((candidate) => candidate.name === name);
  if (capability === undefined) {
    throw new RangeError(`Unknown Guild capability: ${name}`);
  }
  return capability;
}

export function assertCapabilityInput(
  capability: CapabilityDefinition,
  input: unknown,
): asserts input is Readonly<Record<string, unknown>> {
  assertJsonSchemaValue(
    capability.inputSchema,
    input,
    `${capability.name} input`,
  );
  assertSemanticInput(
    capability.name,
    input as Readonly<Record<string, unknown>>,
  );
}

export function assertCapabilityOutput(
  capability: CapabilityDefinition,
  output: unknown,
): asserts output is CapabilityResultEnvelope {
  assertJsonSchemaValue(
    capability.outputSchema,
    output,
    `${capability.name} output`,
  );
}

/** Build the provenance envelope in the trusted transport adapter. */
export function createCapabilityResultEnvelope(
  capability: CapabilityDefinition,
  transport: CapabilityTransport,
  data: unknown,
  metadata: CapabilityResultMetadata = {},
): CapabilityResultEnvelope {
  if (!capability.readOnly && metadata.commandId === undefined) {
    throw new TypeError(
      `${capability.name} mutation output requires trusted commandId provenance.`,
    );
  }
  const output: CapabilityResultEnvelope = {
    data,
    provenance: {
      transport,
      trusted: true,
      actionName: capability.name,
      canonicalHandlerId: capability.canonicalHandlerId,
      ...(metadata.commandId === undefined
        ? {}
        : { commandId: metadata.commandId }),
      ...(metadata.eventSequence === undefined
        ? {}
        : { eventSequence: metadata.eventSequence }),
    },
  };
  assertCapabilityOutput(capability, output);
  return output;
}

function assertSemanticInput(
  name: GuildCapabilityName,
  input: Readonly<Record<string, unknown>>,
): void {
  if (name === "guild.publish_mission") {
    const minimum = input.minimumPartySize as number;
    const preferred = input.preferredPartySize as number;
    const maximum = input.maximumPartySize as number;
    if (minimum > preferred || preferred > maximum) {
      throw new TypeError(
        "guild.publish_mission party sizes must satisfy minimum <= preferred <= maximum.",
      );
    }
    if (
      Date.parse(input.formationDeadline as string) >=
      Date.parse(input.deliveryDeadline as string)
    ) {
      throw new TypeError(
        "guild.publish_mission formationDeadline must precede deliveryDeadline.",
      );
    }
  }
  if (name === "guild.apply_to_mission") {
    const availability = input.availability as Readonly<
      Record<string, unknown>
    >;
    if (
      Date.parse(availability.availableFrom as string) >=
      Date.parse(availability.availableUntil as string)
    ) {
      throw new TypeError(
        "guild.apply_to_mission availableFrom must precede availableUntil.",
      );
    }
  }
  if (name === "guild.propose_allocation") {
    const step = input.negotiationStep;
    if (step === "capability-bid") {
      requireNegotiationFields(input, [
        "relevantCapabilities",
        "proposedContribution",
      ]);
      forbidNegotiationFields(input, [
        "pactVersion",
        "assignments",
        "deliveryDeadline",
        "verificationCriterionIds",
        "failureBehavior",
      ]);
      return;
    }
    requireNegotiationFields(input, [
      "pactVersion",
      "assignments",
      "deliveryDeadline",
      "verificationCriterionIds",
      "failureBehavior",
    ]);
    if (
      (step === "requester-proposal" && input.pactVersion !== 1) ||
      (step === "assignment-proposal" && input.pactVersion !== 2)
    ) {
      throw new TypeError(
        "guild.propose_allocation pactVersion does not match negotiationStep.",
      );
    }
    forbidNegotiationFields(input, [
      "relevantCapabilities",
      "proposedContribution",
    ]);
  }
}

function requireNegotiationFields(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): void {
  if (fields.some((field) => input[field] === undefined)) {
    throw new TypeError(
      "guild.propose_allocation is missing fields for its negotiationStep.",
    );
  }
}

function forbidNegotiationFields(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): void {
  if (fields.some((field) => input[field] !== undefined)) {
    throw new TypeError(
      "guild.propose_allocation contains fields from another negotiationStep.",
    );
  }
}
