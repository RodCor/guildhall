import type {
  A2AIdempotencyRecord,
  A2ATask,
  A2ATaskListOptions,
  A2ATaskStore,
} from "./types.js";

/** Single-isolate/test store. Production Workers should inject durable storage. */
export class InMemoryA2ATaskStore implements A2ATaskStore {
  readonly #tasks = new Map<string, A2ATask>();
  readonly #messages = new Map<string, A2AIdempotencyRecord>();

  async get(taskId: string): Promise<A2ATask | undefined> {
    const task = this.#tasks.get(taskId);
    return task === undefined ? undefined : structuredClone(task);
  }

  async put(task: A2ATask): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
  }

  async getMessage(
    messageId: string,
  ): Promise<A2AIdempotencyRecord | undefined> {
    const record = this.#messages.get(messageId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async beginMessage(
    task: A2ATask,
    record: A2AIdempotencyRecord,
  ): Promise<A2AIdempotencyRecord | undefined> {
    const existing = this.#messages.get(record.messageId);
    if (existing !== undefined) return structuredClone(existing);
    this.#messages.set(record.messageId, structuredClone(record));
    this.#tasks.set(task.id, structuredClone(task));
    return undefined;
  }

  async list(options: A2ATaskListOptions): Promise<readonly A2ATask[]> {
    return [...this.#tasks.values()]
      .filter(
        (task) =>
          (options.contextId === undefined ||
            task.contextId === options.contextId) &&
          (options.status === undefined ||
            task.status.state === options.status),
      )
      .slice(-options.limit)
      .reverse()
      .map((task) => structuredClone(task));
  }
}
