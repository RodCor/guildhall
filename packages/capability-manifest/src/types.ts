export type JsonSchema = Readonly<Record<string, unknown>>;

export type GuildCapabilityName =
  | "guild.get_profile"
  | "guild.list_missions"
  | "guild.inspect_mission"
  | "guild.publish_mission"
  | "guild.apply_to_mission"
  | "guild.withdraw_application"
  | "guild.propose_allocation"
  | "guild.accept_pact"
  | "guild.report_progress"
  | "guild.submit_artifact"
  | "guild.inspect_receipt";

export type AuthenticationRequirement =
  "public" | "owner-or-agent" | "mission-participant";

export type CapabilityTransport = "webmcp" | "mcp" | "a2a";

/**
 * Transport-neutral metadata. Adapters may reshape this object, but they must
 * not change the action name, handler, schemas, or behavioral classifications.
 */
export interface CapabilityDefinition {
  readonly name: GuildCapabilityName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly readOnly: boolean;
  readonly untrustedOutput: boolean;
  readonly authentication: AuthenticationRequirement;
  readonly autonomousPolicyRequired: boolean;
  readonly canonicalHandlerId: string;
  /** Transport provenance is assigned by an adapter, never accepted as input. */
  readonly provenanceAssignedByAdapter: true;
}

export interface CapabilityInvocationContext {
  readonly actionName: GuildCapabilityName;
  readonly canonicalHandlerId: string;
  readonly commandId?: string;
  readonly signal: AbortSignal;
  readonly provenance: CapabilityTransport;
  readonly provenanceTrusted: true;
}

export type CapabilityHandler = (
  input: Readonly<Record<string, unknown>>,
  context: CapabilityInvocationContext,
) => Promise<unknown>;

export interface ReconciliationRequest {
  readonly actionName: GuildCapabilityName;
  readonly canonicalHandlerId: string;
  readonly commandId: string;
}

export type CapabilityReconciler = (
  request: ReconciliationRequest,
) => Promise<void>;

export interface CapabilityResultProvenance {
  readonly transport: CapabilityTransport;
  readonly trusted: true;
  readonly actionName: GuildCapabilityName;
  readonly canonicalHandlerId: string;
  readonly commandId?: string;
  readonly eventSequence?: number;
}

export interface CapabilityResultEnvelope {
  readonly data: unknown;
  readonly provenance: CapabilityResultProvenance;
}
