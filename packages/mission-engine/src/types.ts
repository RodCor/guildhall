import type { DisplayState, MissionStage, Pact } from "@guildhall/contracts";

import type { HelperSelectionResult } from "./selection.js";

export type LifecycleStage = MissionStage | "DRAFT";
export type TerminalOutcome = "completed" | "failed" | "canceled" | "expired";
export type SafetyState = "none" | "paused" | "rejected";

export interface CandidatePact {
  readonly proposerAgentId: string;
  readonly proposalRound: number;
  readonly pactDigest: string;
  /** Exact public Pact JSON whose canonical bytes produce pactDigest. */
  readonly pact: Pact;
}

export interface ApplicationAvailability {
  readonly availableFrom: string;
  readonly availableUntil: string;
}

export interface MissionApplicationRecord {
  readonly agentId: string;
  readonly keyId: string;
  readonly missionVersion: number;
  readonly relevantCapabilities: readonly string[];
  readonly proposedContribution: string;
  readonly availability: ApplicationAvailability;
  /** Sequence of the application_submitted event assigned by this transition. */
  readonly applicationEventSequence: number;
}

export interface PactAcceptanceRecord {
  readonly acceptanceId: string;
  readonly agentId: string;
  readonly keyId: string;
  readonly pactVersion: number;
  readonly pactDigest: string;
  readonly signature: string;
  readonly acceptedAt: string;
}

export interface CapabilityBidRecord {
  readonly agentId: string;
  readonly keyId: string;
  readonly relevantCapabilities: readonly string[];
  readonly proposedContribution: string;
  readonly bidEventSequence: number;
}

export interface AssignmentProposalRecord extends CandidatePact {
  readonly keyId: string;
  readonly proposalEventSequence: number;
}

export interface AssignmentResolution {
  readonly strategy: "matching" | "selection-order";
  readonly selectedProposalAgentId: string;
  readonly consideredProposalAgentIds: readonly string[];
  readonly consideredPactDigests: readonly string[];
}

export interface RuntimeRoleSlot {
  readonly roleSlotId: string;
  readonly originalAgentId: string;
  readonly occupantAgentId: string;
  readonly status: "active" | "defaulted" | "released";
  readonly artifactRequired: boolean;
  readonly artifactDelivered: boolean;
}

export interface LifecycleState {
  readonly missionId: string;
  readonly stage: LifecycleStage;
  readonly sequence: number;
  readonly missionVersion: number;
  readonly requesterAgentId: string;
  readonly applicationAgentIds: readonly string[];
  readonly applications: readonly MissionApplicationRecord[];
  readonly selectedHelperIds: readonly string[];
  /** Frozen deterministic selection result shown on the public mission. */
  readonly selectionEvidence: HelperSelectionResult | null;
  readonly candidatePact: CandidatePact | null;
  /** Append-only within the active, at-most-two-round negotiation. */
  readonly proposalHistory: readonly CandidatePact[];
  readonly capabilityBids: readonly CapabilityBidRecord[];
  readonly assignmentProposals: readonly AssignmentProposalRecord[];
  readonly assignmentResolution: AssignmentResolution | null;
  readonly acceptances: Readonly<Record<string, PactAcceptanceRecord>>;
  readonly roleSlots: readonly RuntimeRoleSlot[];
  readonly correctionCount: 0 | 1;
  readonly correctionAvailable: boolean;
  readonly verificationPending: boolean;
  readonly executionStarted: boolean;
  readonly overdue: boolean;
  readonly safety: SafetyState;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly published: boolean;
}

export type LifecycleCommand =
  | { readonly type: "publish" }
  | {
      readonly type: "apply";
      readonly agentId: string;
      readonly keyId: string;
      readonly missionVersion: number;
      readonly relevantCapabilities: readonly string[];
      readonly proposedContribution: string;
      readonly availability: ApplicationAvailability;
    }
  | { readonly type: "withdraw"; readonly agentId: string }
  | {
      readonly type: "form_party";
      readonly helperIds: readonly string[];
      readonly roleSlots: readonly RuntimeRoleSlot[];
      readonly selectionEvidence: HelperSelectionResult;
      readonly minimumNotMet?: boolean;
    }
  | {
      readonly type: "submit_capability_bid";
      readonly agentId: string;
      readonly keyId: string;
      readonly relevantCapabilities: readonly string[];
      readonly proposedContribution: string;
    }
  | {
      readonly type: "submit_proposal";
      readonly proposerAgentId: string;
      readonly proposalRound: number;
      readonly pactDigest: string;
      readonly pact: Pact;
    }
  | {
      readonly type: "submit_assignment_proposal";
      readonly proposerAgentId: string;
      readonly keyId: string;
      readonly pactDigest: string;
      readonly pact: Pact;
    }
  | { readonly type: "negotiation_timeout" }
  | {
      readonly type: "accept_pact";
      readonly agentId: string;
      readonly acceptanceId: string;
      readonly keyId: string;
      readonly pactVersion: number;
      readonly pactDigest: string;
      readonly signature: string;
      readonly acceptedAt: string;
    }
  | { readonly type: "revise_mission" }
  | { readonly type: "start_execution" }
  | { readonly type: "submit_artifact"; readonly roleSlotId: string }
  | { readonly type: "mark_overdue" }
  | { readonly type: "default_role"; readonly roleSlotId: string }
  | { readonly type: "release_role"; readonly roleSlotId: string }
  | {
      readonly type: "fill_role_slot";
      readonly roleSlotId: string;
      readonly predecessorAgentId: string;
      readonly replacementAgentId: string;
      readonly pactDigest: string;
    }
  | { readonly type: "verify" }
  | { readonly type: "verifier_unavailable" }
  | {
      readonly type: "verification_failed";
      readonly failedRoleSlotIds?: readonly string[];
    }
  | { readonly type: "verification_passed" }
  | { readonly type: "safety_pause" }
  | { readonly type: "safety_redact"; readonly redactedEventId: string }
  | { readonly type: "safety_reject" }
  | { readonly type: "cancel" }
  | { readonly type: "expire" };

export type TransitionFailureCode =
  | "ILLEGAL_TRANSITION"
  | "INVALID_PARTY"
  | "INVALID_APPLICATION"
  | "APPLICATION_DUPLICATE"
  | "APPLICATION_NOT_FOUND"
  | "PACT_MISMATCH"
  | "INVALID_PROPOSAL"
  | "NEGOTIATION_ROUNDS_EXHAUSTED"
  | "SIGNER_NOT_REQUIRED"
  | "DUPLICATE_ACCEPTANCE"
  | "ROLE_SLOT_NOT_FOUND"
  | "ROLE_SLOT_NOT_REPLACEABLE"
  | "REPLACEMENT_CHANGES_PACT"
  | "ACTIVE_HELPER_LIMIT"
  | "ARTIFACT_ALREADY_DELIVERED"
  | "TERMINAL_MISSION";

export type TransitionResult =
  | {
      readonly ok: true;
      readonly state: LifecycleState;
      readonly events: readonly string[];
    }
  | {
      readonly ok: false;
      readonly state: LifecycleState;
      readonly code: TransitionFailureCode;
    };

export interface DisplayProjection {
  readonly stage: LifecycleStage;
  readonly displayState: DisplayState;
}
