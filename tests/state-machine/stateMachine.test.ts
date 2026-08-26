import { describe, expect, it } from "vitest";

import {
  deriveDisplayState,
  initialLifecycleState,
  transition,
  type LifecycleCommand,
  type LifecycleState,
  type RuntimeRoleSlot,
} from "../../packages/mission-engine/src/index.js";

const requester = "agent-requester";
const scout = "agent-scout";
const scribe = "agent-scribe";
const warden = "agent-warden";
const pactDigest = "pact-digest-v1";
const acceptanceKeyId = "70000000-0000-4000-8000-000000000001";
const acceptedAt = "2026-08-26T12:00:00.000Z";

const scoutSlot: RuntimeRoleSlot = {
  roleSlotId: "slot-scout",
  originalAgentId: scout,
  occupantAgentId: scout,
  status: "active",
  artifactRequired: true,
  artifactDelivered: false,
};
const scribeSlot: RuntimeRoleSlot = {
  roleSlotId: "slot-scribe",
  originalAgentId: scribe,
  occupantAgentId: scribe,
  status: "active",
  artifactRequired: true,
  artifactDelivered: false,
};

function apply(
  state: LifecycleState,
  command: LifecycleCommand,
): LifecycleState {
  const result = transition(state, command);
  expect(result.ok, result.ok ? undefined : result.code).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

function acceptPact(
  agentId: string,
  digest = pactDigest,
): Extract<LifecycleCommand, { type: "accept_pact" }> {
  return {
    type: "accept_pact",
    acceptanceId: crypto.randomUUID(),
    agentId,
    keyId: acceptanceKeyId,
    pactVersion: 1,
    pactDigest: digest,
    signature: "S".repeat(86),
    acceptedAt,
  };
}

function boundParty(
  helperIds = [scout, scribe],
  slots = [scoutSlot, scribeSlot],
): LifecycleState {
  let state = initialLifecycleState({
    missionId: "mission-1",
    requesterAgentId: requester,
  });
  state = apply(state, { type: "publish" });
  for (const agentId of helperIds)
    state = apply(state, { type: "apply", agentId });
  state = apply(state, {
    type: "form_party",
    helperIds,
    roleSlots: slots,
    minimumNotMet: helperIds.length === 1,
  });
  state = apply(state, { type: "submit_proposal", pactVersion: 1, pactDigest });
  for (const agentId of [requester, ...helperIds]) {
    state = apply(state, acceptPact(agentId));
  }
  return state;
}

describe("pure mission lifecycle", () => {
  it("executes the complete legal success path", () => {
    let state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    expect(deriveDisplayState(state)).toBe("Draft");
    state = apply(state, { type: "publish" });
    state = apply(state, { type: "apply", agentId: scout });
    state = apply(state, { type: "apply", agentId: scribe });
    expect(deriveDisplayState(state)).toBe("Recruiting");
    state = apply(state, {
      type: "form_party",
      helperIds: [scout, scribe],
      roleSlots: [scoutSlot, scribeSlot],
    });
    expect(deriveDisplayState(state)).toBe("Negotiating");
    state = apply(state, {
      type: "submit_proposal",
      pactVersion: 1,
      pactDigest,
    });
    for (const agentId of [requester, scout, scribe]) {
      state = apply(state, acceptPact(agentId));
    }
    expect(state.stage).toBe("EXECUTE");
    expect(deriveDisplayState(state)).toBe("Bound");
    state = apply(state, { type: "start_execution" });
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scoutSlot.roleSlotId,
    });
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scribeSlot.roleSlotId,
    });
    expect(state.stage).toBe("DELIVER");
    state = apply(state, { type: "verify" });
    expect(deriveDisplayState(state)).toBe("Verifying");
    state = apply(state, { type: "verification_passed" });
    expect(state.stage).toBe("RECEIPT");
    expect(deriveDisplayState(state)).toBe("Completed");
  });

  it("allows the one-helper fallback even when two were preferred", () => {
    let state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, { type: "apply", agentId: scout });
    const formed = transition(state, {
      type: "form_party",
      helperIds: [scout],
      roleSlots: [scoutSlot],
      minimumNotMet: true,
    });
    expect(formed.ok).toBe(true);
    if (!formed.ok) throw new Error(formed.code);
    expect(formed.events).toContain("party_minimum_not_met");
    state = formed.state;
    state = apply(state, {
      type: "submit_proposal",
      pactVersion: 1,
      pactDigest,
    });
    for (const agentId of [requester, scout]) {
      state = apply(state, acceptPact(agentId));
    }
    expect(state.selectedHelperIds).toEqual([scout]);
    expect(deriveDisplayState(state)).toBe("Bound");
  });

  it("does not bind mixed pact digests or non-party signatures", () => {
    let state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, { type: "apply", agentId: scout });
    state = apply(state, {
      type: "form_party",
      helperIds: [scout],
      roleSlots: [scoutSlot],
    });
    state = apply(state, {
      type: "submit_proposal",
      pactVersion: 1,
      pactDigest,
    });

    const mixed = transition(state, acceptPact(scout, "different-digest"));
    expect(mixed).toMatchObject({ ok: false, code: "PACT_MISMATCH" });
    const outsider = transition(state, acceptPact(warden));
    expect(outsider).toMatchObject({ ok: false, code: "SIGNER_NOT_REQUIRED" });
  });

  it("invalidates applications, reservations, and acceptances after a material pre-bind edit", () => {
    let state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, { type: "apply", agentId: scout });
    state = apply(state, {
      type: "form_party",
      helperIds: [scout],
      roleSlots: [scoutSlot],
    });
    state = apply(state, {
      type: "submit_proposal",
      pactVersion: 1,
      pactDigest,
    });
    state = apply(state, acceptPact(requester));
    const priorVersion = state.missionVersion;
    state = apply(state, { type: "revise_mission" });
    expect(state).toMatchObject({
      stage: "PREPARE",
      missionVersion: priorVersion + 1,
      applicationAgentIds: [],
      selectedHelperIds: [],
      candidatePact: null,
      acceptances: {},
    });
  });

  it("releases reservations without penalty when a selected helper withdraws pre-bind", () => {
    let state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    state = apply(state, { type: "apply", agentId: scout });
    state = apply(state, {
      type: "form_party",
      helperIds: [scout],
      roleSlots: [scoutSlot],
    });
    state = apply(state, { type: "withdraw", agentId: scout });
    expect(state).toMatchObject({
      stage: "PREPARE",
      applicationAgentIds: [],
      selectedHelperIds: [],
      roleSlots: [],
      candidatePact: null,
      acceptances: {},
    });
  });

  it("replaces only the defaulted exact slot without changing the pact", () => {
    let state = boundParty();
    state = apply(state, {
      type: "default_role",
      roleSlotId: scribeSlot.roleSlotId,
    });
    expect(state.stage).toBe("COMPENSATE");
    expect(deriveDisplayState(state)).toBe("Replacement needed");

    const changedPact = transition(state, {
      type: "fill_role_slot",
      roleSlotId: scribeSlot.roleSlotId,
      predecessorAgentId: scribe,
      replacementAgentId: warden,
      pactDigest: "changed-pact",
    });
    expect(changedPact).toMatchObject({
      ok: false,
      code: "REPLACEMENT_CHANGES_PACT",
    });

    state = apply(state, {
      type: "fill_role_slot",
      roleSlotId: scribeSlot.roleSlotId,
      predecessorAgentId: scribe,
      replacementAgentId: warden,
      pactDigest,
    });
    expect(state.stage).toBe("EXECUTE");
    expect(state.roleSlots[1]).toMatchObject({
      roleSlotId: scribeSlot.roleSlotId,
      originalAgentId: scribe,
      occupantAgentId: warden,
      status: "active",
    });
  });

  it("separates safety rejection from the single semantic correction", () => {
    let state = boundParty([scout], [scoutSlot]);
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scoutSlot.roleSlotId,
    });
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "safety_reject" });
    expect(state.correctionCount).toBe(0);
    state = apply(state, {
      type: "verification_failed",
      failedRoleSlotIds: [scoutSlot.roleSlotId],
    });
    expect(state.correctionCount).toBe(1);
    expect(state.correctionAvailable).toBe(true);
  });

  it("opens one correction and makes the second semantic failure terminal", () => {
    let state = boundParty([scout], [scoutSlot]);
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scoutSlot.roleSlotId,
    });
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "verification_failed" });
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scoutSlot.roleSlotId,
    });
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "verification_failed" });
    expect(deriveDisplayState(state)).toBe("Failed");
  });

  it("preserves a valid artifact when another role slot needs correction", () => {
    let state = boundParty();
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scoutSlot.roleSlotId,
    });
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scribeSlot.roleSlotId,
    });
    state = apply(state, { type: "verify" });
    state = apply(state, {
      type: "verification_failed",
      failedRoleSlotIds: [scribeSlot.roleSlotId],
    });
    expect(
      state.roleSlots.find((slot) => slot.roleSlotId === scoutSlot.roleSlotId),
    ).toMatchObject({
      artifactDelivered: true,
    });
    expect(
      state.roleSlots.find((slot) => slot.roleSlotId === scribeSlot.roleSlotId),
    ).toMatchObject({
      artifactDelivered: false,
    });
  });

  it("keeps overdue missions completable while giving overdue display priority", () => {
    let state = boundParty([scout], [scoutSlot]);
    state = apply(state, { type: "mark_overdue" });
    expect(deriveDisplayState(state)).toBe("Overdue");
    state = apply(state, {
      type: "submit_artifact",
      roleSlotId: scoutSlot.roleSlotId,
    });
    state = apply(state, { type: "verify" });
    state = apply(state, { type: "verification_passed" });
    expect(deriveDisplayState(state)).toBe("Completed");
  });

  it("cancels an unbound mission when public content is redacted", () => {
    let state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    state = apply(state, { type: "publish" });
    const redacted = transition(state, {
      type: "safety_redact",
      redactedEventId: "event-1",
    });
    expect(redacted).toMatchObject({
      ok: true,
      state: { safety: "paused", terminalOutcome: "canceled" },
      events: ["safety_redacted", "mission_canceled", "receipt_issued"],
    });
  });

  it("freezes normal completion after a bound-mission redaction", () => {
    const bound = boundParty([scout], [scoutSlot]);
    const redacted = transition(bound, {
      type: "safety_redact",
      redactedEventId: "event-1",
    });
    if (!redacted.ok) throw new Error(redacted.code);
    expect(deriveDisplayState(redacted.state)).toBe("Paused for safety");
    expect(
      transition(redacted.state, {
        type: "submit_artifact",
        roleSlotId: scoutSlot.roleSlotId,
      }),
    ).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(transition(redacted.state, { type: "cancel" })).toMatchObject({
      ok: true,
      state: { terminalOutcome: "canceled" },
      events: ["compensation_started", "mission_canceled", "receipt_issued"],
    });
  });

  it("returns illegal transitions without mutating the original state", () => {
    const state = initialLifecycleState({
      missionId: "mission-1",
      requesterAgentId: requester,
    });
    const result = transition(state, { type: "verify" });
    expect(result).toEqual({ ok: false, state, code: "ILLEGAL_TRANSITION" });
    expect(result.state).toBe(state);
  });
});
