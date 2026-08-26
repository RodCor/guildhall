import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveDisplayState,
  initialLifecycleState,
} from "../src/stateMachine.js";
import type { LifecycleState } from "../src/types.js";

const base = initialLifecycleState({
  missionId: "coverage",
  requesterAgentId: "requester",
});
const replacementSlot = {
  roleSlotId: "slot",
  originalAgentId: "helper",
  occupantAgentId: "helper",
  status: "defaulted" as const,
  artifactRequired: true,
  artifactDelivered: false,
};

const sources: Readonly<Record<string, LifecycleState>> = {
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
  Overdue: { ...base, stage: "VERIFY", overdue: true, published: true },
  "Replacement needed": {
    ...base,
    stage: "COMPENSATE",
    roleSlots: [replacementSlot],
    published: true,
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

const coverage = Object.entries(sources).map(
  ([expectedDisplayState, state]) => ({
    expectedDisplayState,
    derivedDisplayState: deriveDisplayState(state),
    internalStage: state.stage,
    source:
      state.terminalOutcome === null ? "derived snapshot" : "terminal receipt",
  }),
);

if (
  coverage.some(
    (entry) => entry.expectedDisplayState !== entry.derivedDisplayState,
  )
) {
  throw new Error("Display-state transition coverage is incomplete");
}

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const outputDirectory = resolve(
  scriptDirectory,
  "../../../tests/state-machine",
);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, "transition-coverage.json"),
  `${JSON.stringify({ generatedFrom: "deriveDisplayState", coverage }, null, 2)}\n`,
  "utf8",
);
