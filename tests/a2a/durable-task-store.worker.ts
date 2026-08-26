import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  A2AIdempotencyRecord,
  A2ATask,
} from "../../packages/a2a-worker/src";
import type { HostedAgentTaskStoreRpc } from "../../apps/demo-agent/src/durable-task-store-proxy";
import type { HostedAgentTaskStore } from "../../apps/demo-agent/src/durable-task-store";

describe("SQLite hosted-agent task store", () => {
  it("atomically preserves the first message claim and persists task updates", async () => {
    const stub = env.HOSTED_AGENT_TASKS.getByName("atomic-claim");
    const rpc = asRpc(stub);
    const firstTask = createTask(1);
    const firstRecord = createRecord(1, firstTask.id);

    await expect(
      rpc.beginMessage(firstTask, firstRecord),
    ).resolves.toBeUndefined();

    const competingTask = createTask(2);
    await expect(
      rpc.beginMessage(competingTask, {
        ...createRecord(2, competingTask.id),
        messageId: firstRecord.messageId,
      }),
    ).resolves.toEqual(firstRecord);
    await expect(rpc.getTask(competingTask.id)).resolves.toBeUndefined();

    const completedTask: A2ATask = {
      ...firstTask,
      status: {
        state: "TASK_STATE_COMPLETED",
        timestamp: "2026-08-26T15:01:00.000Z",
      },
    };
    await rpc.putTask(completedTask);
    await expect(rpc.getTask(firstTask.id)).resolves.toEqual(completedTask);
    await expect(
      rpc.listTasks({
        contextId: firstTask.contextId,
        limit: 10,
        status: "TASK_STATE_COMPLETED",
      }),
    ).resolves.toEqual([completedTask]);

    await evictDurableObject(stub);
    const restoredRpc = asRpc(env.HOSTED_AGENT_TASKS.getByName("atomic-claim"));
    await expect(restoredRpc.getTask(firstTask.id)).resolves.toEqual(
      completedTask,
    );
  });

  it("bounds both tasks and message claims to the newest 512 rows", async () => {
    const stub = env.HOSTED_AGENT_TASKS.getByName("bounded-retention");
    await runInDurableObject<HostedAgentTaskStore, void>(
      stub as DurableObjectStub<HostedAgentTaskStore>,
      async (instance, state) => {
        for (let index = 0; index < 513; index += 1) {
          const task = createTask(index);
          await instance.beginMessage(task, createRecord(index, task.id));
        }
        await expect(instance.getTask("task-0000")).resolves.toBeUndefined();
        await expect(instance.getTask("task-0512")).resolves.toEqual(
          createTask(512),
        );
        const counts = state.storage.sql
          .exec<{
            [column: string]: SqlStorageValue;
            messages: number;
            tasks: number;
          }>(
            `SELECT
               (SELECT COUNT(*) FROM tasks) AS tasks,
               (SELECT COUNT(*) FROM messages) AS messages`,
          )
          .one();
        expect(counts).toEqual({ messages: 512, tasks: 512 });
      },
    );
  });
});

function asRpc(stub: DurableObjectStub): HostedAgentTaskStoreRpc {
  return stub as unknown as HostedAgentTaskStoreRpc;
}

function createTask(index: number): A2ATask {
  const suffix = index.toString().padStart(4, "0");
  return {
    artifacts: [],
    contextId: `context-${suffix}`,
    history: [],
    id: `task-${suffix}`,
    metadata: {},
    status: {
      state: "TASK_STATE_SUBMITTED",
      timestamp: "2026-08-26T15:00:00.000Z",
    },
  };
}

function createRecord(index: number, taskId: string): A2AIdempotencyRecord {
  const suffix = index.toString().padStart(4, "0");
  return {
    messageId: `message-${suffix}`,
    requestHash: `request-hash-${suffix}`,
    taskId,
  };
}
