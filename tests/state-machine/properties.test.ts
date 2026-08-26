import { describe, expect, it } from "vitest";

import {
  deriveDisplayState,
  initialLifecycleState,
  transition,
  type LifecycleCommand,
  type LifecycleState,
} from "../../packages/mission-engine/src/index.js";
import {
  applyToMission,
  formParty,
  submitAssignmentProposal,
  submitCapabilityBid,
  submitProposal,
} from "./fixtures.js";

const probeSlot = {
  roleSlotId: "slot",
  originalAgentId: "agent",
  occupantAgentId: "agent",
  status: "active" as const,
  artifactRequired: true,
  artifactDelivered: false,
};

const probeCommands: readonly LifecycleCommand[] = [
  { type: "publish" },
  applyToMission("agent"),
  { type: "withdraw", agentId: "agent" },
  formParty([], []),
  submitCapabilityBid("agent"),
  submitProposal(1, "digest", "agent", [probeSlot]),
  submitAssignmentProposal("digest", "agent", [probeSlot]),
  { type: "negotiation_timeout" },
  {
    type: "accept_pact",
    acceptanceId: "70000000-0000-4000-8000-000000000001",
    agentId: "agent",
    keyId: "70000000-0000-4000-8000-000000000002",
    pactVersion: 1,
    pactDigest: "digest",
    signature: "S".repeat(86),
    acceptedAt: "2026-08-26T12:00:00.000Z",
  },
  { type: "revise_mission" },
  { type: "start_execution" },
  { type: "submit_artifact", roleSlotId: "slot" },
  { type: "mark_overdue" },
  { type: "default_role", roleSlotId: "slot" },
  { type: "release_role", roleSlotId: "slot" },
  {
    type: "fill_role_slot",
    roleSlotId: "slot",
    predecessorAgentId: "before",
    replacementAgentId: "after",
    pactDigest: "digest",
  },
  { type: "verify" },
  { type: "verifier_unavailable" },
  { type: "verification_failed" },
  { type: "verification_passed" },
  { type: "safety_pause" },
  { type: "safety_reject" },
  { type: "cancel" },
  { type: "expire" },
];

describe("mission state properties", () => {
  it("never mutates state when a command is rejected", () => {
    const state = initialLifecycleState({
      missionId: "mission",
      requesterAgentId: "requester",
    });
    for (const command of probeCommands) {
      const before = structuredClone(state);
      const result = transition(state, command);
      if (!result.ok) {
        expect(result.state).toBe(state);
        expect(state).toEqual(before);
      }
    }
  });

  it("makes every terminal outcome immutable", () => {
    const initial = initialLifecycleState({
      missionId: "mission",
      requesterAgentId: "requester",
    });
    const canceled = transition(initial, { type: "cancel" });
    if (!canceled.ok) throw new Error(canceled.code);
    for (const command of probeCommands) {
      expect(transition(canceled.state, command)).toMatchObject({
        ok: false,
        code: "TERMINAL_MISSION",
      });
    }
  });

  it("derives every PRD display state or identifies its internal source", () => {
    const base = initialLifecycleState({
      missionId: "mission",
      requesterAgentId: "requester",
    });
    const variants: Record<string, LifecycleState> = {
      Draft: base,
      Recruiting: { ...base, stage: "PREPARE", published: true },
      Negotiating: { ...base, stage: "RESERVE", published: true },
      Bound: { ...base, stage: "EXECUTE", published: true },
      Executing: {
        ...base,
        stage: "EXECUTE",
        executionStarted: true,
        published: true,
      },
      Verifying: { ...base, stage: "VERIFY", published: true },
      Overdue: { ...base, stage: "EXECUTE", overdue: true, published: true },
      "Replacement needed": {
        ...base,
        stage: "COMPENSATE",
        published: true,
        roleSlots: [
          {
            roleSlotId: "slot",
            originalAgentId: "helper",
            occupantAgentId: "helper",
            status: "defaulted",
            artifactRequired: true,
            artifactDelivered: false,
          },
        ],
      },
      "Verification pending": {
        ...base,
        stage: "VERIFY",
        verificationPending: true,
      },
      "Correction available": {
        ...base,
        stage: "EXECUTE",
        correctionAvailable: true,
      },
      "Paused for safety": { ...base, stage: "EXECUTE", safety: "paused" },
      "Safety rejected": { ...base, stage: "EXECUTE", safety: "rejected" },
      Completed: { ...base, stage: "RECEIPT", terminalOutcome: "completed" },
      Failed: { ...base, stage: "RECEIPT", terminalOutcome: "failed" },
      Canceled: { ...base, stage: "RECEIPT", terminalOutcome: "canceled" },
      Expired: { ...base, stage: "RECEIPT", terminalOutcome: "expired" },
    };
    expect(
      Object.entries(variants).map(([expected, state]) => [
        expected,
        deriveDisplayState(state),
      ]),
    ).toEqual(Object.keys(variants).map((display) => [display, display]));
  });

  it("never derives more than two active helpers in legal formation", () => {
    const state = initialLifecycleState({
      missionId: "mission",
      requesterAgentId: "requester",
    });
    const published = transition(state, { type: "publish" });
    if (!published.ok) throw new Error(published.code);
    for (let helperCount = 0; helperCount <= 4; helperCount += 1) {
      const helperIds = Array.from(
        { length: helperCount },
        (_, index) => `helper-${index}`,
      );
      const roleSlots = helperIds.map((helper, index) => ({
        roleSlotId: `slot-${index}`,
        originalAgentId: helper,
        occupantAgentId: helper,
        status: "active" as const,
        artifactRequired: true,
        artifactDelivered: false,
      }));
      let recruiting = published.state;
      for (const agentId of helperIds) {
        const applied = transition(recruiting, applyToMission(agentId));
        if (applied.ok) recruiting = applied.state;
      }
      const result = transition(recruiting, formParty(helperIds, roleSlots));
      if (result.ok) {
        expect(
          result.state.roleSlots.filter((slot) => slot.status === "active")
            .length,
        ).toBeLessThanOrEqual(2);
      }
    }
  });
});
