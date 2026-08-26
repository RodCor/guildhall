import type {
  A2AIdempotencyRecord,
  A2ATask,
  A2ATaskListOptions,
  A2ATaskStore,
} from "@guildhall/a2a-worker";

const MAXIMUM_LIST_LIMIT = 50;

export class D1A2ATaskStore implements A2ATaskStore {
  constructor(private readonly database: D1Database) {}

  async get(taskId: string): Promise<A2ATask | undefined> {
    const row = await this.database
      .prepare("SELECT task_json FROM a2a_tasks WHERE task_id = ? LIMIT 1")
      .bind(taskId)
      .first<{ task_json: string }>();
    return row === null ? undefined : parseTask(row.task_json);
  }

  async getMessage(
    messageId: string,
  ): Promise<A2AIdempotencyRecord | undefined> {
    const row = await this.database
      .prepare(
        `SELECT message_id, request_hash, task_id
         FROM a2a_tasks WHERE message_id = ? LIMIT 1`,
      )
      .bind(messageId)
      .first<{
        message_id: string;
        request_hash: string;
        task_id: string;
      }>();
    return row === null
      ? undefined
      : {
          messageId: row.message_id,
          requestHash: row.request_hash,
          taskId: row.task_id,
        };
  }

  async beginMessage(
    task: A2ATask,
    record: A2AIdempotencyRecord,
  ): Promise<A2AIdempotencyRecord | undefined> {
    const serialized = serializeTask(task);
    const inserted = await this.database
      .prepare(
        `INSERT OR IGNORE INTO a2a_tasks(
           task_id, message_id, request_hash, context_id, status, task_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        task.id,
        record.messageId,
        record.requestHash,
        task.contextId,
        task.status.state,
        serialized,
        task.status.timestamp,
      )
      .run();
    if ((inserted.meta.changes ?? 0) === 1) return undefined;
    const existing = await this.getMessage(record.messageId);
    if (existing === undefined) {
      throw new Error("A2A idempotency claim could not be resolved");
    }
    return existing;
  }

  async put(task: A2ATask): Promise<void> {
    const serialized = serializeTask(task);
    const result = await this.database
      .prepare(
        `UPDATE a2a_tasks
         SET context_id = ?, status = ?, task_json = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .bind(
        task.contextId,
        task.status.state,
        serialized,
        task.status.timestamp,
        task.id,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error("A2A task update requires an existing idempotency claim");
    }
  }

  async list(options: A2ATaskListOptions): Promise<readonly A2ATask[]> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAXIMUM_LIST_LIMIT
    ) {
      throw new RangeError("A2A task list limit is invalid");
    }
    const clauses: string[] = [];
    const bindings: Array<string | number> = [];
    if (options.contextId !== undefined) {
      clauses.push("context_id = ?");
      bindings.push(options.contextId);
    }
    if (options.status !== undefined) {
      clauses.push("status = ?");
      bindings.push(options.status);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = await this.database
      .prepare(
        `SELECT task_json FROM a2a_tasks ${where}
         ORDER BY updated_at DESC, task_id ASC LIMIT ?`,
      )
      .bind(...bindings, options.limit)
      .all<{ task_json: string }>();
    return rows.results.map(({ task_json }) => parseTask(task_json));
  }
}

function serializeTask(task: A2ATask): string {
  const serialized = JSON.stringify(task);
  if (serialized.length > 256_000) {
    throw new RangeError("A2A task exceeds the Guild Broker storage limit");
  }
  return serialized;
}

function parseTask(serialized: string): A2ATask {
  const parsed: unknown = JSON.parse(serialized);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    throw new TypeError("Stored A2A task is malformed");
  }
  return parsed as A2ATask;
}
