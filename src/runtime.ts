import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AgentRegistry, createWorkflowChain, Memory, VoltAgentObservability, WorkflowRegistry } from "@voltagent/core";
import { LibSQLMemoryAdapter } from "@voltagent/libsql";
import { createPinoLogger } from "@voltagent/logger";
import { persistedJobSchema, resultSchema } from "./schema.ts";
import type { Callback, Job } from "./schema.ts";

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function openRuntime(dbPath: string) {
  const storage = new LibSQLMemoryAdapter({ url: pathToFileURL(dbPath).href });
  const logger = createPinoLogger({ format: "json", pinoOptions: { level: "silent" } });
  AgentRegistry.getInstance().setGlobalLogger(logger);
  const observability = new VoltAgentObservability({
    logger,
    voltOpsSync: { sampling: { strategy: "never" } },
  });
  const memory = new Memory({ storage });
  const workflow = createWorkflowChain({
    id: "carrier-callback",
    name: "Wait for carrier delivery",
    memory,
    logger,
    observability,
    input: persistedJobSchema,
    result: resultSchema,
  }).andThen({
    id: "wait-for-carrier",
    resumeSchema: resultSchema,
    execute: async ({ data, suspend, resumeData }) => {
      if (!resumeData) {
        await suspend("Waiting for a terminal carrier event");
        throw new Error("The workflow did not suspend.");
      }
      if (resumeData.jobId !== data.jobId) {
        throw new Error("Callback belongs to a different job.");
      }
      return resumeData;
    },
  }).toWorkflow();

  // Register directly with the workflow registry to run without a server.
  const registry = WorkflowRegistry.getInstance();
  registry.registerWorkflow(workflow);

  async function load(executionId: string) {
    const state = await workflow.memory.getWorkflowState(executionId);
    if (!state || state.workflowId !== workflow.id) return null;
    return state;
  }

  return {
    async start({ jobId, token }: Job) {
      const execution = await workflow.run({ jobId, tokenDigest: digest(token) });
      if (execution.status !== "suspended") throw new Error("The workflow did not suspend.");
      const state = await load(execution.executionId);
      if (state?.status !== "suspended") throw new Error("The suspension was not persisted.");
      return { status: state.status, executionId: state.id, jobId };
    },

    async inspect(executionId: string) {
      const state = await load(executionId);
      if (!state) return { status: "not_found" };
      const { jobId } = persistedJobSchema.parse(state.input);
      const result = state.status === "completed" ? resultSchema.parse(state.output) : undefined;
      return { status: state.status, executionId, jobId, result };
    },

    async accept(executionId: string, callback: Callback) {
      const state = await load(executionId);
      if (!state) return { status: "ignored", reason: "unknown_execution" };
      const job = persistedJobSchema.parse(state.input);
      if (callback.jobId !== job.jobId) return { status: "ignored", reason: "wrong_job" };
      if (!timingSafeEqual(Buffer.from(digest(callback.token), "hex"), Buffer.from(job.tokenDigest, "hex"))) {
        return { status: "ignored", reason: "wrong_token" };
      }

      if (state.status === "completed") {
        const result = resultSchema.parse(state.output);
        if (callback.eventId !== result.eventId) return { status: "ignored", reason: "already_terminal" };
        if (callback.carrierStatus !== result.carrierStatus) return { status: "ignored", reason: "conflicting_replay" };
        return { status: "duplicate", executionId, result };
      }
      if (state.status !== "suspended") return { status: "ignored", reason: "not_waiting" };

      const { jobId, eventId, carrierStatus } = callback;
      const execution = await registry.resumeSuspendedWorkflow(workflow.id, executionId, {
        jobId, eventId, carrierStatus,
      });
      if (execution?.status !== "completed") throw new Error("The workflow did not complete.");
      const completed = await load(executionId);
      if (completed?.status !== "completed") throw new Error("Completion was not persisted.");
      return { status: completed.status, executionId, result: resultSchema.parse(completed.output) };
    },

    async close() {
      registry.unregisterWorkflow(workflow.id);
      try {
        await storage.close();
      } finally {
        await observability.shutdown();
      }
    },
  };
}
