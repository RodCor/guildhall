import type {
  A2AIdempotencyRecord,
  A2ATask,
  A2ATaskListOptions,
} from "../../packages/a2a-worker/src";
import { describe, expect, it, vi } from "vitest";

import {
  DurableObjectA2ATaskStore,
  type HostedAgentTaskStoreRpc,
} from "../../apps/demo-agent/src/durable-task-store-proxy";
import { createAgentWorker } from "../../apps/demo-agent/src/worker";

const task: A2ATask = {
  artifacts: [],
  contextId: "context-1",
  history: [],
  id: "task-1",
  metadata: {},
  status: {
    state: "TASK_STATE_SUBMITTED",
    timestamp: "2026-08-26T15:00:00.000Z",
  },
};
const record: A2AIdempotencyRecord = {
  messageId: "message-1",
  requestHash: "request-hash-1",
  taskId: task.id,
};
const listOptions: A2ATaskListOptions = {
  contextId: task.contextId,
  limit: 10,
  status: task.status.state,
};

describe("Durable Object A2A task-store proxy", () => {
  it("delegates the complete shared store contract over RPC", async () => {
    const rpc = createRpc();
    const store = new DurableObjectA2ATaskStore(rpc);

    await expect(store.get(task.id)).resolves.toEqual(task);
    await expect(store.getMessage(record.messageId)).resolves.toEqual(record);
    await expect(store.beginMessage(task, record)).resolves.toBeUndefined();
    await expect(store.put(task)).resolves.toBeUndefined();
    await expect(store.list(listOptions)).resolves.toEqual([task]);

    expect(rpc.getTask).toHaveBeenCalledWith(task.id);
    expect(rpc.getMessage).toHaveBeenCalledWith(record.messageId);
    expect(rpc.beginMessage).toHaveBeenCalledWith(task, record);
    expect(rpc.putTask).toHaveBeenCalledWith(task);
    expect(rpc.listTasks).toHaveBeenCalledWith(listOptions);
  });

  it("addresses exactly one named Durable Object atom for the hosted agent", async () => {
    const rpc = createRpc();
    const getByName = vi.fn((_name: string) => rpc);
    const worker = createAgentWorker("scout");

    const response = await worker.fetch(
      new Request("https://scout.guildhall.test/.well-known/agent-card.json"),
      { HOSTED_AGENT_TASKS: { getByName } },
    );

    expect(response.status).toBe(200);
    expect(getByName).toHaveBeenCalledOnce();
    expect(getByName).toHaveBeenCalledWith("scout");
  });
});

function createRpc(): HostedAgentTaskStoreRpc & {
  getTask: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  beginMessage: ReturnType<typeof vi.fn>;
  putTask: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
} {
  return {
    beginMessage: vi.fn(async () => undefined),
    getMessage: vi.fn(async () => record),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async () => [task]),
    putTask: vi.fn(async () => undefined),
  };
}
