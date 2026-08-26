declare global {
  namespace Cloudflare {
    interface Env {
      HOSTED_AGENT_TASKS: DurableObjectNamespace;
    }
  }
}

export {};
