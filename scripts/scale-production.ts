import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  findingsArtifactContent,
  parseApprovedFixture,
  remediationArtifactContent,
} from "../apps/demo-agent/src/fixtures.js";
import { GuildClient } from "../apps/guild-node/src/guildClient.js";
import { writeNodeConfig } from "../apps/guild-node/src/config.js";
import {
  createSignedRequestHeaders,
  signMessage,
} from "../apps/guild-node/src/crypto.js";
import {
  ReceiptSchema,
  canonicalJsonDigest,
  commandBodyHash,
  commandSigningBytes,
  importEd25519PublicJwk,
  receiptSigningBytes,
  unsignedReceiptProjection,
  verifyEd25519,
} from "../packages/contracts/src/index.js";
import { verifyEventChain } from "../packages/trust-engine/src/index.js";

const DEFAULT_BASE_URL = "https://guildhall.kimetsu-dev.workers.dev";
const DATABASE_NAME = "guildhall";
const GUILDHALL_CONFIG = "apps/guildhall/wrangler.jsonc";
const FIXTURE_DIGEST = "geKBB1Pr83xZU8RzZaoC-YcNy6MO2jw3lB_lupUQQ58";
const CAPABILITIES = ["accessibility-audit", "remediation-planning"] as const;
const FAILURE_BEHAVIOR = {
  negotiationTimeout: "reopen-recruitment",
  participantDefault: "recruit-exact-slot-replacement",
  replacementAuthorized: true,
  verificationCorrectionLimit: 1,
} as const;

interface ScaleAgent {
  readonly role: "requester" | "helper";
  readonly ordinal: number;
  readonly agentId: string;
  readonly keyId: string;
  readonly credentialId: string;
  readonly credential: string;
  readonly credentialHash: string;
  readonly publicJwk: JsonWebKey;
  readonly privateJwk: JsonWebKey;
  readonly slug: string;
  readonly characterName: string;
  readonly characterClass: string;
  readonly configPath: string;
  readonly client: GuildClient;
}

interface MissionPacket {
  readonly missionId: string;
  readonly definition: Record<string, unknown> | null;
  readonly snapshot: Record<string, unknown>;
  readonly events: readonly Record<string, unknown>[];
  readonly latestSequence: number;
  readonly artifacts: readonly Record<string, unknown>[];
  readonly receipt: unknown;
}

interface MissionSpec {
  readonly index: number;
  readonly requester: ScaleAgent;
  readonly helpers: readonly ScaleAgent[];
  readonly difficulty: "novice" | "adept" | "expert";
  readonly pointReward: number;
}

interface MissionResult {
  readonly missionId: string;
  readonly title: string;
  readonly requesterAgentId: string;
  readonly helperAgentIds: readonly string[];
  readonly difficulty: MissionSpec["difficulty"];
  readonly pointReward: number;
  readonly eventCount: number;
  readonly receiptId: string;
  readonly elapsedMs: number;
}

interface IssuerKey {
  readonly keyId: string;
  readonly publicJwk: JsonWebKey;
}

const options = parseOptions(process.argv.slice(2));
if (!options.confirmProduction) {
  throw new Error(
    "Production writes require --confirm-production. The run creates public missions and persistent receipt evidence.",
  );
}
const baseUrl = exactHttpsOrigin(options.baseUrl);
const runTag = scaleRunTag();
const temporaryDirectory = await safeTemporaryDirectory();
const createdAgents: ScaleAgent[] = [];
let identitiesSeeded = false;
let scaleError: unknown = null;

try {
  await assertProductionReady(baseUrl);
  const ownerId = await productionOwnerId(options.ownerId);
  const requesters = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      createScaleAgent({
        baseUrl,
        directory: temporaryDirectory,
        role: "requester",
        ordinal: index + 1,
        runTag,
      }),
    ),
  );
  const helpers = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createScaleAgent({
        baseUrl,
        directory: temporaryDirectory,
        role: "helper",
        ordinal: index + 1,
        runTag,
      }),
    ),
  );
  createdAgents.push(...requesters, ...helpers);
  identitiesSeeded = true;
  await seedScaleAgents(ownerId, createdAgents, runTag, temporaryDirectory);

  const issuer = await json<IssuerKey>(
    new URL("/.well-known/guildhall-issuer-key.json", baseUrl),
  );
  const specs = missionMatrix(options.missions, requesters, helpers);
  process.stdout.write(
    `Scale run ${runTag}: ${String(specs.length)} missions, ${String(createdAgents.length)} signed agents, concurrency ${String(options.concurrency)}.\n`,
  );

  const results: MissionResult[] = [];
  const failures: Array<{ readonly index: number; readonly error: unknown }> =
    [];

  // One sequential canary makes protocol-shape errors obvious before the
  // concurrent part creates more public state.
  try {
    const canary = await executeMission(specs[0]!, baseUrl, runTag, issuer);
    results.push(canary);
    printMissionResult(canary, true);
  } catch (error) {
    failures.push({ index: specs[0]!.index, error });
  }

  if (failures.length === 0) {
    const concurrent = await mapConcurrent(
      specs.slice(1),
      options.concurrency,
      async (spec) => {
        try {
          const result = await executeMission(spec, baseUrl, runTag, issuer);
          printMissionResult(result, false);
          return { result, error: null } as const;
        } catch (error) {
          return { result: null, error } as const;
        }
      },
    );
    concurrent.forEach((outcome, index) => {
      const spec = specs[index + 1]!;
      if (outcome.result === null) {
        failures.push({ index: spec.index, error: outcome.error });
      } else {
        results.push(outcome.result);
      }
    });
  }

  if (failures.length > 0) {
    failures.forEach(({ index, error }) => {
      process.stderr.write(
        `Mission ${String(index + 1).padStart(2, "0")} failed: ${errorMessage(error)}\n`,
      );
    });
    throw new Error(
      `Scale run stopped with ${String(failures.length)} failed mission(s).`,
    );
  }

  results.sort((left, right) => left.title.localeCompare(right.title));
  await reconcileRegistry(createdAgents, results);
  const elapsedValues = results.map(({ elapsedMs }) => elapsedMs);
  const totalEvents = results.reduce(
    (total, result) => total + result.eventCount,
    0,
  );
  process.stdout.write(
    [
      "",
      `SCALE_RESULT run=${runTag}`,
      `missions=${String(results.length)}`,
      `agents=${String(createdAgents.length)}`,
      `events=${String(totalEvents)}`,
      `receipts=${String(results.length)}`,
      `points=${String(results.reduce((total, item) => total + item.pointReward, 0))}`,
      `duration_ms_min=${String(Math.min(...elapsedValues))}`,
      `duration_ms_median=${String(median(elapsedValues))}`,
      `duration_ms_max=${String(Math.max(...elapsedValues))}`,
      `mission_ids=${results.map(({ missionId }) => missionId).join(",")}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  scaleError = error;
} finally {
  if (identitiesSeeded) {
    try {
      await retireScaleAgents(createdAgents, temporaryDirectory);
    } catch (retirementError) {
      scaleError ??= retirementError;
      process.stderr.write(
        `Scale identity retirement failed: ${errorMessage(retirementError)}\n`,
      );
    }
  }
  await removeTemporaryDirectory(temporaryDirectory);
}

if (scaleError !== null) throw scaleError;

async function executeMission(
  spec: MissionSpec,
  origin: string,
  tag: string,
  issuer: IssuerKey,
): Promise<MissionResult> {
  const startedAt = performance.now();
  const sequence = String(spec.index + 1).padStart(2, "0");
  const title = `Scale Run ${tag} Mission ${sequence}`;
  const now = Date.now();
  const formationDeadline = new Date(now + 30 * 60_000).toISOString();
  const deliveryDeadline = new Date(now + 3 * 60 * 60_000).toISOString();
  const inputId = randomUUID();
  const findingsOutputId = randomUUID();
  const remediationOutputId = randomUUID();
  const findingsCriterionId = randomUUID();
  const remediationCriterionId = randomUUID();
  const partySize = spec.helpers.length;

  const publish = await spec.requester.client.invoke("guild.publish_mission", {
    commandId: randomUUID(),
    title,
    goal: `Verify signed coordination for scale case ${sequence} using only the public deterministic fixture.`,
    publicInputs: [
      {
        inputId,
        type: "url",
        location: new URL(
          "/fixtures/accessibility-dungeon-v1",
          origin,
        ).toString(),
        mediaType: "text/html",
        contentDigest: FIXTURE_DIGEST,
      },
    ],
    requiredCapabilities: [...CAPABILITIES],
    minimumPartySize: partySize,
    preferredPartySize: partySize,
    maximumPartySize: 2,
    formationDeadline,
    deliveryDeadline,
    requiredOutputs: [
      {
        outputId: findingsOutputId,
        type: "accessibility-findings",
        description: "Deterministic findings from the public fixture.",
        mediaType: "application/json",
        publicLocation: "mission-artifact",
      },
      {
        outputId: remediationOutputId,
        type: "remediation-plan",
        description: "A deterministic repair plan linked to the findings.",
        mediaType: "application/json",
        publicLocation: "mission-artifact",
      },
    ],
    verificationCriteria: [
      {
        criterionId: findingsCriterionId,
        description:
          "Every public fixture finding matches the verifier oracle.",
        required: true,
        method: "deterministic",
      },
      {
        criterionId: remediationCriterionId,
        description: "Every finding maps to an exact deterministic repair.",
        required: true,
        method: "deterministic",
      },
    ],
    difficulty: spec.difficulty,
    pointReward: spec.pointReward,
    failureBehavior: FAILURE_BEHAVIOR,
  });
  const missionId = requiredString(publish, "missionId");

  for (const [helperIndex, helper] of spec.helpers.entries()) {
    const relevantCapabilities =
      partySize === 1
        ? [...CAPABILITIES]
        : [CAPABILITIES[helperIndex] ?? CAPABILITIES[0]];
    await helper.client.invoke("guild.apply_to_mission", {
      commandId: randomUUID(),
      missionId,
      missionVersion: 1,
      relevantCapabilities,
      proposedContribution:
        partySize === 1
          ? "Produce both deterministic outputs and preserve their dependency proof."
          : helperIndex === 0
            ? "Produce the signed accessibility findings."
            : "Produce the signed remediation plan from accepted findings.",
      availability: {
        availableFrom: new Date(now - 60_000).toISOString(),
        availableUntil: new Date(
          Date.parse(deliveryDeadline) + 30 * 60_000,
        ).toISOString(),
      },
    });
  }

  let packet = await missionPacket(origin, missionId);
  assert(
    packet.snapshot.stage === "RESERVE",
    `Mission ${missionId} did not reserve its party.`,
  );
  const selectedHelperIds = requiredStringArray(
    packet.snapshot,
    "selectedHelperIds",
  );
  assert(
    sameMembers(
      selectedHelperIds,
      spec.helpers.map(({ agentId }) => agentId),
    ),
    `Mission ${missionId} selected the wrong helpers.`,
  );

  for (const [helperIndex, helper] of spec.helpers.entries()) {
    await helper.client.invoke("guild.propose_allocation", {
      commandId: randomUUID(),
      missionId,
      negotiationStep: "capability-bid",
      relevantCapabilities:
        partySize === 1
          ? [...CAPABILITIES]
          : [CAPABILITIES[helperIndex] ?? CAPABILITIES[0]],
      proposedContribution:
        partySize === 1
          ? "Own both outputs in one inherited role."
          : helperIndex === 0
            ? "Own findings."
            : "Own remediation with findings dependency.",
    });
  }

  packet = await missionPacket(origin, missionId);
  const assignments = allocationAssignments({
    packet,
    helpers: spec.helpers,
    findingsOutputId,
    remediationOutputId,
    findingsCriterionId,
    remediationCriterionId,
    pointReward: spec.pointReward,
  });
  const proposal = {
    missionId,
    deliveryDeadline,
    assignments,
    verificationCriterionIds: [findingsCriterionId, remediationCriterionId],
    failureBehavior: FAILURE_BEHAVIOR,
  };

  await spec.requester.client.invoke("guild.propose_allocation", {
    commandId: randomUUID(),
    negotiationStep: "requester-proposal",
    pactVersion: 1,
    ...proposal,
  });
  for (const helper of spec.helpers) {
    await helper.client.invoke("guild.propose_allocation", {
      commandId: randomUUID(),
      negotiationStep: "assignment-proposal",
      pactVersion: 2,
      ...proposal,
    });
  }

  packet = await missionPacket(origin, missionId);
  const candidatePact = requiredRecord(packet.snapshot, "candidatePact");
  const pactDigest = requiredString(candidatePact, "pactDigest");
  assert(
    requiredInteger(requiredRecord(candidatePact, "pact"), "pactVersion") === 2,
    `Mission ${missionId} did not resolve pact version 2.`,
  );

  for (const helper of spec.helpers) {
    await helper.client.invoke("guild.accept_pact", {
      commandId: randomUUID(),
      missionId,
      pactVersion: 2,
      pactDigest,
      acceptedAt: new Date().toISOString(),
    });
  }
  await spec.requester.client.invoke("guild.accept_pact", {
    commandId: randomUUID(),
    missionId,
    pactVersion: 2,
    pactDigest,
    acceptedAt: new Date().toISOString(),
  });

  packet = await missionPacket(origin, missionId);
  assert(
    packet.snapshot.stage === "EXECUTE",
    `Mission ${missionId} did not bind into execution.`,
  );
  assertIdenticalAcceptances(packet, pactDigest, partySize + 1);
  await sendSignedCommand(
    origin,
    spec.requester,
    missionId,
    packet.latestSequence,
    {
      type: "start_execution",
    },
  );

  packet = await missionPacket(origin, missionId);
  const runtimeSlots = requiredRecordArray(packet.snapshot, "roleSlots");
  for (const helper of spec.helpers) {
    const slot = runtimeSlots.find(
      (candidate) =>
        requiredString(candidate, "occupantAgentId") === helper.agentId,
    );
    if (slot === undefined) {
      throw new Error(`Mission ${missionId} lost helper ${helper.agentId}.`);
    }
    await helper.client.invoke("guild.report_progress", {
      commandId: randomUUID(),
      missionId,
      roleSlotId: requiredString(slot, "roleSlotId"),
      status: "working",
      summary:
        "Reading the immutable public fixture and preparing signed output.",
      completedOutputIds: [],
      occurredAt: new Date().toISOString(),
    });
  }

  const findingsAssignment = assignments.find(({ outputIds }) =>
    outputIds.includes(findingsOutputId),
  );
  const remediationAssignment = assignments.find(({ outputIds }) =>
    outputIds.includes(remediationOutputId),
  );
  if (findingsAssignment === undefined || remediationAssignment === undefined) {
    throw new Error(`Mission ${missionId} has incomplete assignments.`);
  }
  const findingsAgent = requiredAgent(
    createdAgents,
    findingsAssignment.agentId,
  );
  const remediationAgent = requiredAgent(
    createdAgents,
    remediationAssignment.agentId,
  );
  const findings = parseApprovedFixture("accessibility-dungeon-v1");
  const findingsContent = findingsArtifactContent(findings);
  const findingsArtifactId = randomUUID();
  await findingsAgent.client.invoke("guild.submit_artifact", {
    commandId: randomUUID(),
    missionId,
    roleSlotId: findingsAssignment.roleSlotId,
    pactDigest,
    artifact: {
      artifactId: findingsArtifactId,
      outputId: findingsOutputId,
      type: "accessibility-findings",
      mediaType: "application/json",
      contentDigest: await canonicalJsonDigest(findingsContent),
      publicLocation: "mission-artifact",
      content: findingsContent,
      dependencyArtifactIds: [],
      attempt: 1,
      completedAt: new Date().toISOString(),
    },
  });

  const remediationContent = remediationArtifactContent(findings);
  await remediationAgent.client.invoke("guild.submit_artifact", {
    commandId: randomUUID(),
    missionId,
    roleSlotId: remediationAssignment.roleSlotId,
    pactDigest,
    artifact: {
      artifactId: randomUUID(),
      outputId: remediationOutputId,
      type: "remediation-plan",
      mediaType: "application/json",
      contentDigest: await canonicalJsonDigest(remediationContent),
      publicLocation: "mission-artifact",
      content: remediationContent,
      dependencyArtifactIds: [findingsArtifactId],
      attempt: 1,
      completedAt: new Date().toISOString(),
    },
  });

  packet = await missionPacket(origin, missionId);
  const receipt = ReceiptSchema.parse(packet.receipt);
  assert(
    packet.snapshot.stage === "RECEIPT" &&
      packet.snapshot.terminalOutcome === "completed" &&
      receipt.outcome === "completed",
    `Mission ${missionId} did not complete.`,
  );
  assert(
    receipt.reward.totalPointsAwarded === spec.pointReward &&
      receipt.reward.basePointsAwarded === spec.pointReward &&
      receipt.reward.recoveryBonusAwarded === 0,
    `Mission ${missionId} reward does not reconcile.`,
  );
  assert(
    receipt.reputationDeltas.reduce(
      (total, delta) => total + delta.pointsDelta,
      0,
    ) === spec.pointReward,
    `Mission ${missionId} reputation deltas do not reconcile.`,
  );
  assert(
    sameMembers(
      [
        ...new Set(
          receipt.artifacts.map(({ producingAgentId }) => producingAgentId),
        ),
      ],
      spec.helpers.map(({ agentId }) => agentId),
    ),
    `Mission ${missionId} receipt names the wrong producers.`,
  );
  const chain = verifyEventChain(
    packet.events as Parameters<typeof verifyEventChain>[0],
  );
  assert(chain.valid, `Mission ${missionId} event chain is invalid.`);
  if (!chain.valid) throw new Error(`Mission ${missionId} chain failed.`);
  assert(
    chain.headHash === receipt.eventChainHead,
    `Mission ${missionId} receipt is not bound to its event-chain head.`,
  );
  assert(
    receipt.issuerKeyId === issuer.keyId,
    `Mission ${missionId} used an unexpected issuer key.`,
  );
  const issuerKey = await importEd25519PublicJwk(issuer.publicJwk);
  const unsignedDigest = await canonicalJsonDigest(
    unsignedReceiptProjection(receipt),
  );
  assert(
    await verifyEd25519(
      issuerKey,
      receiptSigningBytes(unsignedDigest),
      receipt.issuerSignature,
    ),
    `Mission ${missionId} receipt signature is invalid.`,
  );
  assertRequiredEventOrder(packet, missionId);
  const publicReceipt = await json<{ readonly receipt: unknown }>(
    new URL(`/api/missions/${encodeURIComponent(missionId)}/receipt`, origin),
  );
  assert(
    (await canonicalJsonDigest(publicReceipt.receipt)) ===
      (await canonicalJsonDigest(receipt)),
    `Mission ${missionId} receipt endpoint diverges from its packet.`,
  );

  return {
    missionId,
    title,
    requesterAgentId: spec.requester.agentId,
    helperAgentIds: spec.helpers.map(({ agentId }) => agentId),
    difficulty: spec.difficulty,
    pointReward: spec.pointReward,
    eventCount: packet.events.length,
    receiptId: receipt.receiptId,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

function allocationAssignments(input: {
  readonly packet: MissionPacket;
  readonly helpers: readonly ScaleAgent[];
  readonly findingsOutputId: string;
  readonly remediationOutputId: string;
  readonly findingsCriterionId: string;
  readonly remediationCriterionId: string;
  readonly pointReward: number;
}): Array<{
  readonly roleSlotId: string;
  readonly agentId: string;
  readonly responsibilities: string[];
  readonly requiredCapabilities: string[];
  readonly dependencyRoleSlotIds: string[];
  readonly outputIds: string[];
  readonly verificationCriterionIds: string[];
  readonly pointAllocation: number;
}> {
  const runtimeSlots = requiredRecordArray(input.packet.snapshot, "roleSlots");
  const slotFor = (agentId: string): string => {
    const slot = runtimeSlots.find(
      (candidate) => requiredString(candidate, "originalAgentId") === agentId,
    );
    if (slot === undefined) throw new Error(`No role slot for ${agentId}.`);
    return requiredString(slot, "roleSlotId");
  };
  if (input.helpers.length === 1) {
    const agent = input.helpers[0]!;
    return [
      {
        roleSlotId: slotFor(agent.agentId),
        agentId: agent.agentId,
        responsibilities: [
          "Produce findings and the dependent remediation plan.",
        ],
        requiredCapabilities: [...CAPABILITIES],
        dependencyRoleSlotIds: [],
        outputIds: [input.findingsOutputId, input.remediationOutputId],
        verificationCriterionIds: [
          input.findingsCriterionId,
          input.remediationCriterionId,
        ],
        pointAllocation: input.pointReward,
      },
    ];
  }
  const findingsAgent = input.helpers[0]!;
  const remediationAgent = input.helpers[1]!;
  const findingsSlotId = slotFor(findingsAgent.agentId);
  const remediationSlotId = slotFor(remediationAgent.agentId);
  const findingsPoints = Math.floor(input.pointReward / 2);
  return [
    {
      roleSlotId: findingsSlotId,
      agentId: findingsAgent.agentId,
      responsibilities: ["Produce deterministic public findings."],
      requiredCapabilities: [CAPABILITIES[0]],
      dependencyRoleSlotIds: [],
      outputIds: [input.findingsOutputId],
      verificationCriterionIds: [input.findingsCriterionId],
      pointAllocation: findingsPoints,
    },
    {
      roleSlotId: remediationSlotId,
      agentId: remediationAgent.agentId,
      responsibilities: ["Produce a repair plan from accepted findings."],
      requiredCapabilities: [CAPABILITIES[1]],
      dependencyRoleSlotIds: [findingsSlotId],
      outputIds: [input.remediationOutputId],
      verificationCriterionIds: [input.remediationCriterionId],
      pointAllocation: input.pointReward - findingsPoints,
    },
  ];
}

async function sendSignedCommand(
  origin: string,
  agent: ScaleAgent,
  missionId: string,
  expectedSequence: number,
  command: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const commandId = randomUUID();
  const issuedAt = new Date().toISOString();
  const actor = { agentId: agent.agentId, keyId: agent.keyId };
  const material = {
    commandId,
    action: requiredString(command, "type"),
    missionId,
    expectedSequence,
    actor,
    issuedAt,
    payload: command,
  };
  const bodyHash = await commandBodyHash(material);
  const body = {
    commandId,
    expectedSequence,
    actor,
    source: "mcp",
    issuedAt,
    command,
    proof: {
      bodyHash,
      signature: await signMessage(
        agent.privateJwk,
        commandSigningBytes(bodyHash),
      ),
    },
  };
  const path = `/api/missions/${encodeURIComponent(missionId)}/commands`;
  const bodyText = JSON.stringify(body);
  const headers = await createSignedRequestHeaders({
    credential: agent.credential,
    keyId: agent.keyId,
    privateJwk: agent.privateJwk,
    method: "POST",
    requestTarget: path,
    bodyText,
  });
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers,
    body: bodyText,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value)) {
    throw new Error(
      `Signed ${requiredString(command, "type")} failed with ${String(response.status)}: ${canonicalString(value)}`,
    );
  }
  return value;
}

function missionMatrix(
  missionCount: number,
  requesters: readonly ScaleAgent[],
  helpers: readonly ScaleAgent[],
): MissionSpec[] {
  const difficulties: readonly MissionSpec["difficulty"][] = [
    "novice",
    "adept",
    "expert",
  ];
  const rewards = [30, 40, 50] as const;
  return Array.from({ length: missionCount }, (_, index) => {
    const singleParty = index % 3 === 0;
    const first = helpers[index % helpers.length]!;
    const second = helpers[(index + 3) % helpers.length]!;
    return {
      index,
      requester: requesters[index % requesters.length]!,
      helpers: singleParty ? [first] : [first, second],
      difficulty: difficulties[index % difficulties.length]!,
      pointReward: rewards[index % rewards.length]!,
    };
  });
}

async function createScaleAgent(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly role: ScaleAgent["role"];
  readonly ordinal: number;
  readonly runTag: string;
}): Promise<ScaleAgent> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateExport = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicExport = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (
    typeof privateExport.d !== "string" ||
    typeof privateExport.x !== "string" ||
    publicExport.x !== privateExport.x
  ) {
    throw new Error("Generated scale identity is malformed.");
  }
  const privateJwk = {
    crv: "Ed25519",
    d: privateExport.d,
    kty: "OKP",
    x: privateExport.x,
  } satisfies JsonWebKey;
  const publicJwk = {
    crv: "Ed25519",
    kty: "OKP",
    x: privateExport.x,
  } satisfies JsonWebKey;
  const names =
    input.role === "requester"
      ? ["Astra", "Cinder", "Lyra", "Orion"]
      : ["Vela", "Rune", "Mira", "Thorne", "Kael", "Nia", "Bram", "Iris"];
  const classes =
    input.role === "requester"
      ? ["Bard", "Wizard", "Cleric", "Paladin"]
      : [
          "Ranger",
          "Artificer",
          "Rogue",
          "Druid",
          "Fighter",
          "Monk",
          "Sorcerer",
          "Warlock",
        ];
  const agentId = randomUUID();
  const keyId = randomUUID();
  const credentialId = randomUUID();
  const credential = randomBytes(32).toString("base64url");
  const credentialHash = await sha256Base64Url(credential);
  const configPath = join(
    input.directory,
    `${input.role}-${String(input.ordinal)}.json`,
  );
  await writeNodeConfig(
    {
      version: 1,
      baseUrl: input.baseUrl,
      agentId,
      keyId,
      credential,
      credentialId,
      scopes: ["missions:write"],
      publicJwk,
      privateJwk,
      inboxCursor: null,
      pairedAt: new Date().toISOString(),
    },
    configPath,
  );
  return {
    role: input.role,
    ordinal: input.ordinal,
    agentId,
    keyId,
    credentialId,
    credential,
    credentialHash,
    publicJwk,
    privateJwk,
    slug: `${input.runTag}-${input.role}-${String(input.ordinal)}`,
    characterName: names[input.ordinal - 1]!,
    characterClass: classes[input.ordinal - 1]!,
    configPath,
    client: new GuildClient({
      configPath,
      defaultBaseUrl: input.baseUrl,
    }),
  };
}

async function seedScaleAgents(
  ownerId: string,
  agents: readonly ScaleAgent[],
  runTag: string,
  directory: string,
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
  const statements = ["PRAGMA foreign_keys = ON;"];
  for (const agent of agents) {
    statements.push(
      `INSERT INTO agents (agent_id, owner_id, slug, character_name, character_class, technical_name, guild_name, public_bio, transport_status, total_points, completed_missions, created_at, updated_at) VALUES (${sqlString(agent.agentId)}, ${sqlString(ownerId)}, ${sqlString(agent.slug)}, ${sqlString(agent.characterName)}, ${sqlString(agent.characterClass)}, ${sqlString(agent.role === "requester" ? "Independent signed scale requester" : "Independent signed scale helper")}, 'Guildhall Scale Party', ${sqlString(`Public ${runTag} scale certification identity. No private data or provider credentials.`)}, 'online', 0, 0, ${sqlString(now)}, ${sqlString(now)});`,
      `INSERT INTO autonomy_policies (agent_id, public_publication_enabled, policy_version, consented_at, revoked_at, updated_at) VALUES (${sqlString(agent.agentId)}, 1, 1, ${sqlString(now)}, NULL, ${sqlString(now)});`,
      `INSERT INTO autonomy_policy_history (agent_id, policy_version, public_publication_enabled, consented_at, revoked_at, recorded_at) VALUES (${sqlString(agent.agentId)}, 1, 1, ${sqlString(now)}, NULL, ${sqlString(now)});`,
      `INSERT INTO agent_keys (key_id, agent_id, public_jwk_json, source, status, created_at, retired_at, revoked_at) VALUES (${sqlString(agent.keyId)}, ${sqlString(agent.agentId)}, ${sqlString(JSON.stringify(agent.publicJwk))}, 'guild-node', 'active', ${sqlString(now)}, NULL, NULL);`,
      `INSERT INTO agent_credentials (credential_id, agent_id, key_id, credential_hash, scope_json, expires_at, revoked_at, created_at, last_used_at) VALUES (${sqlString(agent.credentialId)}, ${sqlString(agent.agentId)}, ${sqlString(agent.keyId)}, ${sqlString(agent.credentialHash)}, '["missions:write"]', ${sqlString(expiresAt)}, NULL, ${sqlString(now)}, NULL);`,
    );
    if (agent.role === "helper") {
      for (const capability of CAPABILITIES) {
        statements.push(
          `INSERT INTO agent_capabilities (agent_id, capability, declared_level, verified_points, verified_missions, reliability, timeliness, updated_at) VALUES (${sqlString(agent.agentId)}, ${sqlString(capability)}, 90, 0, 0, 0, 0, ${sqlString(now)});`,
        );
      }
    }
  }
  await executeD1File(
    directory,
    "seed-scale-agents.sql",
    statements.join("\n"),
  );
  const ids = agents.map(({ agentId }) => sqlString(agentId)).join(", ");
  const rows = await queryD1(
    `SELECT COUNT(*) AS count FROM agents WHERE agent_id IN (${ids});`,
  );
  assert(
    rows[0]?.count === agents.length,
    "Scale identities were not fully seeded.",
  );
}

async function retireScaleAgents(
  agents: readonly ScaleAgent[],
  directory: string,
): Promise<void> {
  if (agents.length === 0) return;
  const now = new Date().toISOString();
  const ids = agents.map(({ agentId }) => sqlString(agentId)).join(", ");
  await executeD1File(
    directory,
    "retire-scale-agents.sql",
    [
      "PRAGMA foreign_keys = ON;",
      `UPDATE agent_credentials SET revoked_at = ${sqlString(now)} WHERE agent_id IN (${ids}) AND revoked_at IS NULL;`,
      `UPDATE agent_keys SET status = 'retired', retired_at = ${sqlString(now)} WHERE agent_id IN (${ids}) AND status = 'active';`,
      `UPDATE autonomy_policies SET public_publication_enabled = 0, policy_version = policy_version + 1, revoked_at = ${sqlString(now)}, updated_at = ${sqlString(now)} WHERE agent_id IN (${ids});`,
      `INSERT OR REPLACE INTO autonomy_policy_history (agent_id, policy_version, public_publication_enabled, consented_at, revoked_at, recorded_at) SELECT agent_id, policy_version, 0, consented_at, revoked_at, ${sqlString(now)} FROM autonomy_policies WHERE agent_id IN (${ids});`,
      `UPDATE agents SET transport_status = 'offline', updated_at = ${sqlString(now)} WHERE agent_id IN (${ids});`,
    ].join("\n"),
  );
  const rows = await queryD1(
    `SELECT COUNT(*) AS unsafe_count FROM agents LEFT JOIN agent_keys ON agent_keys.agent_id = agents.agent_id LEFT JOIN agent_credentials ON agent_credentials.agent_id = agents.agent_id WHERE agents.agent_id IN (${ids}) AND (agents.transport_status <> 'offline' OR agent_keys.status = 'active' OR agent_credentials.revoked_at IS NULL);`,
  );
  assert(
    rows[0]?.unsafe_count === 0,
    "Scale identity retirement did not reconcile.",
  );
  process.stdout.write(
    `Retired ${String(agents.length)} scale keys and revoked their temporary credentials.\n`,
  );
}

async function reconcileRegistry(
  agents: readonly ScaleAgent[],
  results: readonly MissionResult[],
): Promise<void> {
  const helpers = agents.filter(({ role }) => role === "helper");
  const expected = new Map(
    helpers.map(({ agentId }) => [agentId, { points: 0, missions: 0 }]),
  );
  for (const result of results) {
    const allocation = Math.floor(
      result.pointReward / result.helperAgentIds.length,
    );
    result.helperAgentIds.forEach((agentId, index) => {
      const row = expected.get(agentId);
      if (row === undefined) throw new Error("Unexpected mission helper.");
      row.points +=
        index === result.helperAgentIds.length - 1
          ? result.pointReward - allocation * index
          : allocation;
      row.missions += 1;
    });
  }
  const ids = helpers.map(({ agentId }) => sqlString(agentId)).join(", ");
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const rows = await queryD1(
      `SELECT agent_id, total_points, completed_missions FROM agents WHERE agent_id IN (${ids}) ORDER BY agent_id;`,
    );
    const matches =
      rows.length === helpers.length &&
      rows.every((row) => {
        const target = expected.get(String(row.agent_id));
        return (
          target !== undefined &&
          row.total_points === target.points &&
          row.completed_missions === target.missions
        );
      });
    if (matches) return;
    if (attempt < 10) await delay(500);
  }
  throw new Error(
    "D1 reputation projection did not reconcile to the receipts.",
  );
}

function assertIdenticalAcceptances(
  packet: MissionPacket,
  pactDigest: string,
  expectedCount: number,
): void {
  const acceptances = Object.values(
    requiredRecord(packet.snapshot, "acceptances"),
  );
  assert(
    acceptances.length === expectedCount &&
      acceptances.every(
        (acceptance) =>
          isRecord(acceptance) &&
          acceptance.pactDigest === pactDigest &&
          acceptance.pactVersion === 2,
      ),
    `Mission ${packet.missionId} did not bind identical pact signatures.`,
  );
}

function assertRequiredEventOrder(
  packet: MissionPacket,
  missionId: string,
): void {
  const types = packet.events.map((event) => requiredString(event, "type"));
  const required = [
    "mission_published",
    "application_submitted",
    "party_reserved",
    "assignment_negotiation_started",
    "capability_bid_submitted",
    "pact_candidate_published",
    "assignment_proposal_submitted",
    "assignment_proposals_resolved",
    "pact_bound",
    "execution_started",
    "progress_reported",
    "artifact_submitted",
    "delivery_complete",
    "verification_started",
    "verification_passed",
    "receipt_issued",
  ];
  let cursor = -1;
  for (const type of required) {
    cursor = types.indexOf(type, cursor + 1);
    assert(
      cursor >= 0,
      `Mission ${missionId} is missing ordered event ${type}.`,
    );
  }
  assert(
    types.at(-1) === "receipt_issued",
    `Mission ${missionId} did not terminate with a receipt event.`,
  );
}

async function missionPacket(
  origin: string,
  missionId: string,
): Promise<MissionPacket> {
  return json<MissionPacket>(
    new URL(`/api/missions/${encodeURIComponent(missionId)}`, origin),
  );
}

async function assertProductionReady(origin: string): Promise<void> {
  const ready = await json<Record<string, unknown>>(
    new URL("/api/ready", origin),
  );
  assert(
    ready.status === "ok" &&
      ready.phase === "complete" &&
      ready.database === "reachable",
    "Guildhall production is not fully ready.",
  );
}

async function productionOwnerId(explicit: string | null): Promise<string> {
  const rows = await queryD1(
    "SELECT owner_id FROM owners ORDER BY created_at LIMIT 2;",
  );
  if (explicit !== null) {
    assert(
      rows.some((row) => row.owner_id === explicit),
      "--owner-id is not a production owner.",
    );
    return explicit;
  }
  assert(
    rows.length === 1 && typeof rows[0]?.owner_id === "string",
    "Production must have exactly one owner, or pass --owner-id.",
  );
  return rows[0]!.owner_id as string;
}

async function executeD1File(
  directory: string,
  name: string,
  sql: string,
): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `${sql}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  await runPnpm(
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      DATABASE_NAME,
      "--remote",
      "--yes",
      "--config",
      GUILDHALL_CONFIG,
      "--file",
      path,
    ],
    { quiet: true },
  );
}

async function queryD1(command: string): Promise<Record<string, unknown>[]> {
  const output = await runPnpm(
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      DATABASE_NAME,
      "--remote",
      "--json",
      "--config",
      GUILDHALL_CONFIG,
      "--command",
      command,
    ],
    { quiet: true },
  );
  const parsed: unknown = JSON.parse(stripAnsi(output));
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("Unexpected D1 response.");
  }
  const rows = parsed[0].results;
  if (!Array.isArray(rows)) throw new Error("D1 rows are missing.");
  return rows.filter(isRecord);
}

function runPnpm(
  args: readonly string[],
  options: { readonly quiet?: boolean } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const npmExecPath = process.env.npm_execpath;
    const executable = npmExecPath === undefined ? "pnpm" : process.execPath;
    const commandArgs =
      npmExecPath === undefined ? args : [npmExecPath, ...args];
    const child = spawn(executable, commandArgs, {
      cwd: resolve(import.meta.dirname, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (!options.quiet) process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      code === 0
        ? resolvePromise(output)
        : reject(
            new Error(`pnpm ${args.join(" ")} exited with ${String(code)}.`),
          );
    });
  });
}

async function json<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url.pathname} returned ${String(response.status)}.`);
  }
  return JSON.parse(text) as T;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

function printMissionResult(result: MissionResult, canary: boolean): void {
  process.stdout.write(
    `${canary ? "CANARY" : "PASS"} ${result.title}: ${String(result.helperAgentIds.length)} helper(s), ${String(result.eventCount)} events, ${String(result.pointReward)} points, ${String(result.elapsedMs)} ms, ${result.missionId}\n`,
  );
}

async function safeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "guildhall-scale-"));
  assertSafeTemporaryDirectory(directory);
  return directory;
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  assertSafeTemporaryDirectory(directory);
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    await rm(join(directory, entry), { force: true, recursive: false });
  }
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function assertSafeTemporaryDirectory(directory: string): void {
  const resolvedTemp = resolve(tmpdir()) + sep;
  const resolvedDirectory = resolve(directory);
  if (
    !resolvedDirectory.startsWith(resolvedTemp) ||
    !basename(resolvedDirectory).startsWith("guildhall-scale-")
  ) {
    throw new Error(`Refusing unsafe temporary path: ${resolvedDirectory}`);
  }
}

function parseOptions(args: readonly string[]): {
  readonly baseUrl: string;
  readonly missions: number;
  readonly concurrency: number;
  readonly ownerId: string | null;
  readonly confirmProduction: boolean;
} {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const missions = Number(value("--missions") ?? 12);
  const concurrency = Number(value("--concurrency") ?? 3);
  assert(
    Number.isSafeInteger(missions) && missions >= 10 && missions <= 30,
    "--missions must be an integer from 10 to 30.",
  );
  assert(
    Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 5,
    "--concurrency must be an integer from 1 to 5.",
  );
  return {
    baseUrl: value("--base-url") ?? DEFAULT_BASE_URL,
    missions,
    concurrency,
    ownerId: value("--owner-id") ?? null,
    confirmProduction: args.includes("--confirm-production"),
  };
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Scale target must be an exact credential-free HTTPS origin.",
    );
  }
  return url.origin;
}

function scaleRunTag(): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "z")
    .toLowerCase();
  return `scale-${timestamp}-${randomBytes(3).toString("hex")}`;
}

function requiredAgent(
  agents: readonly ScaleAgent[],
  agentId: string,
): ScaleAgent {
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  if (agent === undefined) throw new Error(`Agent ${agentId} is unavailable.`);
  return agent;
}

function requiredRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const candidate = value[key];
  if (!isRecord(candidate)) throw new Error(`${key} must be an object.`);
  return candidate;
}

function requiredRecordArray(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown>[] {
  const candidate = value[key];
  if (!Array.isArray(candidate) || !candidate.every(isRecord)) {
    throw new Error(`${key} must be an object array.`);
  }
  return candidate;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${key} must be a string.`);
  }
  return candidate;
}

function requiredStringArray(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string[] {
  const candidate = value[key];
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${key} must be a string array.`);
  }
  return candidate as string[];
}

function requiredInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate))
    throw new Error(`${key} must be an integer.`);
  return candidate as number;
}

function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(value);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("base64url");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
