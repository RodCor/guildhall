import { DurableObject } from "cloudflare:workers";
import type {
  A2AIdempotencyRecord,
  A2ATask,
  A2ATaskListOptions,
  A2ATaskState,
} from "@guildhall/a2a-worker";

import type { HostedAgentTaskStoreRpc } from "./durable-task-store-proxy";

const MAX_STORED_TASKS = 512;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_LIST_LIMIT = 100;

interface TaskJsonRow {
  readonly [column: string]: SqlStorageValue;
  readonly task_json: string;
}

interface RecordJsonRow {
  readonly [column: string]: SqlStorageValue;
  readonly record_json: string;
}

interface SequenceRow {
  readonly [column: string]: SqlStorageValue;
  readonly value: number;
}

const TASK_STATES = new Set<A2ATaskState>([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

/**
 * One instance is addressed by hosted-agent kind in each deployment. SQLite is
 * the durable, strongly consistent source of truth for A2A task/idempotency state.
 */
export class HostedAgentTaskStore
  extends DurableObject
  implements HostedAgentTaskStoreRpc
{
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Schema work is intentionally confined to construction, before RPC traffic.
    void ctx.blockConcurrencyWhile(() => {
      initializeSchema(ctx.storage.sql);
      return Promise.resolve();
    });
  }

  async getTask(taskId: string): Promise<A2ATask | undefined> {
    const row = this.ctx.storage.sql
      .exec<TaskJsonRow>(
        "SELECT task_json FROM tasks WHERE task_id = ? LIMIT 1",
        taskId,
      )
      .toArray()[0];
    return row === undefined ? undefined : decodeTask(row.task_json);
  }

  async getMessage(
    messageId: string,
  ): Promise<A2AIdempotencyRecord | undefined> {
    const row = this.ctx.storage.sql
      .exec<RecordJsonRow>(
        "SELECT record_json FROM messages WHERE message_id = ? LIMIT 1",
        messageId,
      )
      .toArray()[0];
    return row === undefined ? undefined : decodeRecord(row.record_json);
  }

  async beginMessage(
    task: A2ATask,
    record: A2AIdempotencyRecord,
  ): Promise<A2AIdempotencyRecord | undefined> {
    if (record.taskId !== task.id) {
      throw new TypeError("Idempotency record taskId must match the task id.");
    }
    const taskJson = encodeBounded(task, MAX_TASK_BYTES, "Task");
    const recordJson = encodeBounded(
      record,
      MAX_RECORD_BYTES,
      "Idempotency record",
    );

    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<RecordJsonRow>(
          "SELECT record_json FROM messages WHERE message_id = ? LIMIT 1",
          record.messageId,
        )
        .toArray()[0];
      if (existing !== undefined) return decodeRecord(existing.record_json);

      this.writeTask(task, taskJson);
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (message_id, task_id, request_hash, record_json)
         VALUES (?, ?, ?, ?)`,
        record.messageId,
        record.taskId,
        record.requestHash,
        recordJson,
      );
      this.prune();
      return undefined;
    });
  }

  async putTask(task: A2ATask): Promise<void> {
    const taskJson = encodeBounded(task, MAX_TASK_BYTES, "Task");
    this.ctx.storage.transactionSync(() => {
      this.writeTask(task, taskJson);
      this.prune();
    });
  }

  async listTasks(options: A2ATaskListOptions): Promise<readonly A2ATask[]> {
    validateListOptions(options);
    const filters: string[] = [];
    const bindings: (string | number)[] = [];
    if (options.contextId !== undefined) {
      filters.push("context_id = ?");
      bindings.push(options.contextId);
    }
    if (options.status !== undefined) {
      filters.push("status = ?");
      bindings.push(options.status);
    }
    bindings.push(options.limit);
    const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
    const rows = this.ctx.storage.sql
      .exec<TaskJsonRow>(
        `SELECT task_json FROM tasks${where}
         ORDER BY write_sequence DESC LIMIT ?`,
        ...bindings,
      )
      .toArray();
    return rows.map((row) => decodeTask(row.task_json));
  }

  private writeTask(task: A2ATask, taskJson: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE store_meta SET value = value + 1 WHERE name = 'write_sequence'`,
    );
    const sequence = this.ctx.storage.sql
      .exec<SequenceRow>(
        "SELECT value FROM store_meta WHERE name = 'write_sequence'",
      )
      .one().value;
    this.ctx.storage.sql.exec(
      `INSERT INTO tasks
         (task_id, context_id, status, task_json, write_sequence)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         context_id = excluded.context_id,
         status = excluded.status,
         task_json = excluded.task_json,
         write_sequence = excluded.write_sequence`,
      task.id,
      task.contextId,
      task.status.state,
      taskJson,
      sequence,
    );
  }

  private prune(): void {
    // Remove replay records first, then their tasks, as one SQLite transaction.
    this.ctx.storage.sql.exec(
      `DELETE FROM messages
       WHERE task_id IN (
         SELECT task_id FROM tasks
         ORDER BY write_sequence DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_STORED_TASKS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM tasks
       WHERE task_id IN (
         SELECT task_id FROM tasks
         ORDER BY write_sequence DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_STORED_TASKS,
    );
  }
}

function initializeSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS store_meta (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO store_meta (name, value)
      VALUES ('write_sequence', 0);
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      status TEXT NOT NULL,
      task_json TEXT NOT NULL,
      write_sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_context_sequence
      ON tasks (context_id, write_sequence DESC);
    CREATE INDEX IF NOT EXISTS tasks_status_sequence
      ON tasks (status, write_sequence DESC);
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_task
      ON messages (task_id);
  `);
}

function encodeBounded(
  value: A2ATask | A2AIdempotencyRecord,
  maximumBytes: number,
  label: string,
): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > maximumBytes) {
    throw new RangeError(`${label} exceeds the durable storage limit.`);
  }
  return json;
}

function decodeTask(json: string): A2ATask {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.contextId) ||
    !isRecord(value.status) ||
    typeof value.status.state !== "string" ||
    !TASK_STATES.has(value.status.state as A2ATaskState) ||
    typeof value.status.timestamp !== "string" ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.history) ||
    !isRecord(value.metadata)
  ) {
    throw new TypeError("Stored Task is malformed.");
  }
  return value as unknown as A2ATask;
}

function decodeRecord(json: string): A2AIdempotencyRecord {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.messageId) ||
    !isNonEmptyString(value.requestHash) ||
    !isNonEmptyString(value.taskId)
  ) {
    throw new TypeError("Stored idempotency record is malformed.");
  }
  return value as unknown as A2AIdempotencyRecord;
}

function validateListOptions(options: A2ATaskListOptions): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_LIST_LIMIT
  ) {
    throw new RangeError(
      `Task list limit must be between 1 and ${MAX_LIST_LIMIT}.`,
    );
  }
  if (options.contextId !== undefined && !isNonEmptyString(options.contextId)) {
    throw new TypeError("Task list contextId must be a non-empty string.");
  }
  if (options.status !== undefined && !TASK_STATES.has(options.status)) {
    throw new TypeError("Task list status is invalid.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
