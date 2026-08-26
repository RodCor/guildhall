import { guildCapabilityManifest } from "./manifest.js";
import type { CapabilityDefinition, JsonSchema } from "./types.js";

export type CapabilitySurface = "canonical" | "webmcp" | "mcp" | "a2a";

export interface CapabilityParityEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly readOnlyHint: boolean;
  readonly untrustedContentHint: boolean;
  readonly authentication: string;
  readonly autonomousPolicyRequired: boolean;
  readonly canonicalHandlerId: string;
  readonly provenanceAssignedByAdapter: true;
}

export interface CapabilityParitySnapshot {
  readonly format: "guildhall/capability-parity/v1";
  readonly surface: CapabilitySurface;
  readonly actions: readonly CapabilityParityEntry[];
}

export function createCapabilityParitySnapshot(
  surface: CapabilitySurface,
  manifest: readonly CapabilityDefinition[] = guildCapabilityManifest,
): CapabilityParitySnapshot {
  return deepFreeze({
    format: "guildhall/capability-parity/v1" as const,
    surface,
    actions: manifest.map(toParityEntry),
  });
}

export function assertCapabilityParity(
  expected: CapabilityParitySnapshot,
  actual: CapabilityParitySnapshot,
): void {
  const expectedActions = stableJson(expected.actions);
  const actualActions = stableJson(actual.actions);
  if (expectedActions !== actualActions) {
    throw new TypeError(
      `Capability surface ${actual.surface} does not match ${expected.surface}.`,
    );
  }
}

function toParityEntry(
  capability: CapabilityDefinition,
): CapabilityParityEntry {
  return {
    name: capability.name,
    title: capability.title,
    description: capability.description,
    inputSchema: cloneJson(capability.inputSchema),
    outputSchema: cloneJson(capability.outputSchema),
    readOnlyHint: capability.readOnly,
    untrustedContentHint: capability.untrustedOutput,
    authentication: capability.authentication,
    autonomousPolicyRequired: capability.autonomousPolicyRequired,
    canonicalHandlerId: capability.canonicalHandlerId,
    provenanceAssignedByAdapter: capability.provenanceAssignedByAdapter,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
