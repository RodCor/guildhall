import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { projectReceipt } from "../../apps/guildhall/src/worker/repositories/receiptProjection";
import type { Receipt } from "../../packages/contracts/src";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "f0000000-0000-4000-8000-000000000001";
const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const CAPABILITY = "accessibility-audit";
const PROJECTED_AT = "2026-08-26T12:51:00.000Z";

describe("canonical receipt reputation projection", () => {
  it("creates a missing capability row and applies exact totals only once", async () => {
    await seedAgent(AGENT_ID);
    const receipt = completedReceipt();

    await expect(
      projectReceipt(env.GUILD_DB, receipt, 24, PROJECTED_AT),
    ).resolves.toEqual({ applied: true, receiptId: RECEIPT_ID });

    expect(await capabilityRow()).toEqual({
      declared_level: 0,
      verified_points: 100,
      verified_missions: 1,
      reliability: 0.02,
      timeliness: 0.01,
    });
    expect(await agentRow()).toEqual({
      total_points: 100,
      completed_missions: 1,
    });
    expect(await receiptCount(RECEIPT_ID)).toBe(1);
    expect(await deltaCount(RECEIPT_ID)).toBe(1);

    await expect(
      projectReceipt(env.GUILD_DB, structuredClone(receipt), 24, PROJECTED_AT),
    ).resolves.toEqual({ applied: false, receiptId: RECEIPT_ID });

    expect(await capabilityRow()).toEqual({
      declared_level: 0,
      verified_points: 100,
      verified_missions: 1,
      reliability: 0.02,
      timeliness: 0.01,
    });
    expect(await agentRow()).toEqual({
      total_points: 100,
      completed_missions: 1,
    });
    expect(await receiptCount(RECEIPT_ID)).toBe(1);
    expect(await deltaCount(RECEIPT_ID)).toBe(1);
  });

  it("rejects a different canonical payload for the same receipt id", async () => {
    const agentId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    await seedAgent(agentId);
    const receipt = completedReceipt(agentId, receiptId, crypto.randomUUID());
    await projectReceipt(env.GUILD_DB, receipt, 24, PROJECTED_AT);
    const conflict: Receipt = {
      ...structuredClone(receipt),
      missionId: "11111111-1111-4111-8111-111111111112",
    };

    await expect(
      projectReceipt(env.GUILD_DB, conflict, 25, PROJECTED_AT),
    ).rejects.toThrow(/identity conflicts/u);

    expect(await agentRow(agentId)).toEqual({
      total_points: 100,
      completed_missions: 1,
    });
    expect(await receiptCount(receiptId)).toBe(1);
    expect(await deltaCount(receiptId)).toBe(1);
  });

  it("rejects positive failed deltas and projects a valid failure without XP", async () => {
    const agentId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    await seedAgent(agentId);
    const failed = failedReceipt(agentId, receiptId, crypto.randomUUID());
    const positive: Receipt = {
      ...structuredClone(failed),
      reputationDeltas: [
        {
          ...failed.reputationDeltas[0]!,
          pointsDelta: 1,
          reliabilityDelta: 0.01,
        },
      ],
    };

    await expect(
      projectReceipt(env.GUILD_DB, positive, 24, PROJECTED_AT),
    ).rejects.toThrow(
      /non-completed receipt cannot carry positive reputation/u,
    );
    expect(await receiptCount(receiptId)).toBe(0);
    expect(await deltaCount(receiptId)).toBe(0);

    await expect(
      projectReceipt(env.GUILD_DB, failed, 24, PROJECTED_AT),
    ).resolves.toEqual({ applied: true, receiptId });

    expect(await capabilityRow(agentId)).toEqual({
      declared_level: 0,
      verified_points: 0,
      verified_missions: 0,
      reliability: 0,
      timeliness: 0,
    });
    expect(await agentRow(agentId)).toEqual({
      total_points: 0,
      completed_missions: 0,
    });
    expect(await receiptCount(receiptId)).toBe(1);
    expect(await deltaCount(receiptId)).toBe(1);
  });
});

function completedReceipt(
  agentId = AGENT_ID,
  receiptId = RECEIPT_ID,
  missionId = MISSION_ID,
): Receipt {
  return {
    protocol: "commitment/v1",
    kind: "receipt",
    receiptId,
    missionId,
    outcome: "completed",
    pactDigest: "P".repeat(43),
    eventChainHead: "H".repeat(43),
    artifacts: [
      {
        artifactId: "c0000000-0000-4000-8000-000000000001",
        roleSlotId: "66666666-6666-4666-8666-666666666666",
        producingAgentId: agentId,
        contentDigest: "C".repeat(43),
      },
    ],
    verification: {
      verificationRunId: "e0000000-0000-4000-8000-000000000001",
      status: "passed",
      criterionResults: [
        {
          criterionId: "a0000000-0000-4000-8000-000000000004",
          status: "passed",
        },
      ],
    },
    timeliness: {
      overdue: false,
      deliveryDeadline: "2026-08-26T13:00:00.000Z",
      completedAt: "2026-08-26T12:50:00.000Z",
    },
    defaults: [],
    replacements: [],
    reward: {
      basePointsAwarded: 100,
      recoveryBonusAwarded: 0,
      totalPointsAwarded: 100,
      transferable: false,
      redeemable: false,
      monetaryValue: false,
    },
    reputationDeltas: [
      {
        agentId,
        capability: CAPABILITY,
        pointsDelta: 100,
        reliabilityDelta: 0.02,
        timelinessDelta: 0.01,
        recoveryBonus: 0,
        reason: "verified-role-output",
      },
    ],
    issuerKeyId: "f0000000-0000-4000-8000-000000000002",
    issuerSignature: "S".repeat(86),
    issuedAt: "2026-08-26T12:50:01.000Z",
  };
}

function failedReceipt(
  agentId = AGENT_ID,
  receiptId = RECEIPT_ID,
  missionId = MISSION_ID,
): Receipt {
  const failed = completedReceipt(agentId, receiptId, missionId);
  return {
    ...failed,
    outcome: "failed",
    verification: {
      ...failed.verification!,
      status: "failed",
      criterionResults: failed.verification!.criterionResults.map(
        (criterion) => ({ ...criterion, status: "failed" }),
      ),
    },
    reward: {
      ...failed.reward,
      basePointsAwarded: 0,
      totalPointsAwarded: 0,
    },
    reputationDeltas: [
      {
        ...failed.reputationDeltas[0]!,
        pointsDelta: 0,
        reliabilityDelta: -0.02,
        timelinessDelta: -0.01,
      },
    ],
  };
}

async function seedAgent(agentId: string): Promise<void> {
  const ownerId = crypto.randomUUID();
  const suffix = agentId.slice(0, 8);
  await env.GUILD_DB.batch([
    env.GUILD_DB.prepare(
      `INSERT INTO owners(
         owner_id, github_user_id, github_login, github_avatar_url,
         created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(
      ownerId,
      nextGithubUserId(),
      `receipt-projection-${suffix}`,
      PROJECTED_AT,
      PROJECTED_AT,
    ),
    env.GUILD_DB.prepare(
      `INSERT INTO agents(
         agent_id, owner_id, slug, character_name, character_class,
         technical_name, guild_name, public_bio, transport_status,
         total_points, completed_missions, created_at, updated_at
       ) VALUES (
         ?, ?, ?, 'Ledger Knight', 'Paladin',
         'Receipt Projection Agent', 'Guildhall', 'Projection test agent.',
         'offline', 0, 0, ?, ?
       )`,
    ).bind(
      agentId,
      ownerId,
      `receipt-projection-agent-${suffix}`,
      PROJECTED_AT,
      PROJECTED_AT,
    ),
  ]);
}

async function capabilityRow(agentId = AGENT_ID): Promise<{
  declared_level: number;
  verified_points: number;
  verified_missions: number;
  reliability: number;
  timeliness: number;
} | null> {
  return env.GUILD_DB.prepare(
    `SELECT declared_level, verified_points, verified_missions,
            reliability, timeliness
     FROM agent_capabilities
     WHERE agent_id = ? AND capability = ?`,
  )
    .bind(agentId, CAPABILITY)
    .first();
}

async function agentRow(agentId = AGENT_ID): Promise<{
  total_points: number;
  completed_missions: number;
} | null> {
  return env.GUILD_DB.prepare(
    `SELECT total_points, completed_missions
     FROM agents WHERE agent_id = ?`,
  )
    .bind(agentId)
    .first();
}

let githubUserId = 990_000;

function nextGithubUserId(): number {
  githubUserId += 1;
  return githubUserId;
}

async function receiptCount(receiptId: string): Promise<number> {
  const row = await env.GUILD_DB.prepare(
    "SELECT COUNT(*) AS count FROM receipts WHERE receipt_id = ?",
  )
    .bind(receiptId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function deltaCount(receiptId: string): Promise<number> {
  const row = await env.GUILD_DB.prepare(
    "SELECT COUNT(*) AS count FROM receipt_deltas WHERE receipt_id = ?",
  )
    .bind(receiptId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
