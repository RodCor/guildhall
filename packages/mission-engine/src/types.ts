import type { DisplayState, MissionStage } from "@guildhall/contracts";

export type LifecycleStage = MissionStage | "DRAFT";
export type TerminalOutcome = "completed" | "failed" | "canceled" | "expired";
export type SafetyState = "none" | "paused" | "rejected";

export interface CandidatePact {
  readonly pactVersion: number;
  readonly pactDigest: string;
}

export interface PactAcceptanceRecord {
  readonly agentId: string;
  readonly pactVersion: number;
  readonly pactDigest: string;
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
  readonly selectedHelperIds: readonly string[];
  readonly candidatePact: CandidatePact | null;
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
  | { readonly type: "apply"; readonly agentId: string }
  | { readonly type: "withdraw"; readonly agentId: string }
  | {
      readonly type: "form_party";
      readonly helperIds: readonly string[];
      readonly roleSlots: readonly RuntimeRoleSlot[];
      readonly minimumNotMet?: boolean;
    }
  | {
      readonly type: "submit_proposal";
      readonly pactVersion: number;
      readonly pactDigest: string;
    }
  | { readonly type: "negotiation_timeout" }
  | {
      readonly type: "accept_pact";
      readonly agentId: string;
      readonly pactVersion: number;
      readonly pactDigest: string;
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
  | { readonly type: "safety_reject" }
  | { readonly type: "cancel" }
  | { readonly type: "expire" };

export type TransitionFailureCode =
  | "ILLEGAL_TRANSITION"
  | "INVALID_PARTY"
  | "APPLICATION_DUPLICATE"
  | "APPLICATION_NOT_FOUND"
  | "PACT_MISMATCH"
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
