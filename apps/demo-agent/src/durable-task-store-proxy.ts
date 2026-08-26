import type {
  A2AIdempotencyRecord,
  A2ATask,
  A2ATaskListOptions,
  A2ATaskStore,
} from "@guildhall/a2a-worker";

/** Public RPC surface exposed by the hosted-agent Durable Object. */
export interface HostedAgentTaskStoreRpc {
  getTask(taskId: string): Promise<A2ATask | undefined>;
  getMessage(messageId: string): Promise<A2AIdempotencyRecord | undefined>;
  beginMessage(
    task: A2ATask,
    record: A2AIdempotencyRecord,
  ): Promise<A2AIdempotencyRecord | undefined>;
  putTask(task: A2ATask): Promise<void>;
  listTasks(options: A2ATaskListOptions): Promise<readonly A2ATask[]>;
}

/** Maps the shared A2ATaskStore contract onto Durable Object RPC methods. */
export class DurableObjectA2ATaskStore implements A2ATaskStore {
  readonly #rpc: HostedAgentTaskStoreRpc;

  constructor(rpc: HostedAgentTaskStoreRpc) {
    this.#rpc = rpc;
  }

  async get(taskId: string): Promise<A2ATask | undefined> {
    return await this.#rpc.getTask(taskId);
  }

  async getMessage(
    messageId: string,
  ): Promise<A2AIdempotencyRecord | undefined> {
    return await this.#rpc.getMessage(messageId);
  }

  async beginMessage(
    task: A2ATask,
    record: A2AIdempotencyRecord,
  ): Promise<A2AIdempotencyRecord | undefined> {
    return await this.#rpc.beginMessage(task, record);
  }

  async put(task: A2ATask): Promise<void> {
    await this.#rpc.putTask(task);
  }

  async list(options: A2ATaskListOptions): Promise<readonly A2ATask[]> {
    return await this.#rpc.listTasks(options);
  }
}
