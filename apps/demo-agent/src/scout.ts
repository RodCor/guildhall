import { createAgentWorker } from "./worker";

export { HostedAgentTaskStore } from "./durable-task-store";

export default createAgentWorker("scout");
