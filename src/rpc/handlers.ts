import type { CapabilitiesOutput } from "../contract.js"
import type { WorkflowService } from "../service.js"
import { AgentWorkflowsRpc } from "../rpc.js"
import { toRpcError, type ErrorContext } from "./errors.js"

export function createRpcHandlers(service: WorkflowService, capabilities: CapabilitiesOutput) {
  return {
    capabilities: async () => capabilities,

    listWorkflows: async (_input: unknown, context: ErrorContext) => {
      try {
        return await service.listWorkflows()
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    getWorkflow: async (input: { workflowID: string }, context: ErrorContext) => {
      try {
        return await service.getWorkflow(input.workflowID)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    validateWorkflow: async (input: { workflowID?: string; yaml: string }, context: ErrorContext) => {
      try {
        return await service.validateWorkflowSource(input.yaml, input.workflowID)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    saveWorkflow: async (
      input: { workflowID: string; yaml: string; expectedHash: string | null },
      context: ErrorContext,
    ) => {
      try {
        return await service.saveWorkflow(input.workflowID, input.yaml, input.expectedHash)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    deleteWorkflow: async (input: { workflowID: string; expectedHash: string }, context: ErrorContext) => {
      try {
        return await service.deleteWorkflow(input.workflowID, input.expectedHash)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    startRun: async (input: { workflowID: string; objective: string; requestID: string }, context: ErrorContext) => {
      try {
        const run = await service.startRun(input.workflowID, input.objective, input.requestID)
        return { runID: run.runID, status: run.status, revision: run.revision }
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    listRuns: async (input: { status?: "running" | "pausing" | "paused" | "blocked" | "completed" | "failed" | "cancelled"; limit?: number }, context: ErrorContext) => {
      try {
        return { runs: await service.listRuns(input.status, input.limit ?? 50) }
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    getRun: async (input: { runID: string }, context: ErrorContext) => {
      try {
        return await service.getRun(input.runID)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    getRunGraph: async (input: { runID: string }, context: ErrorContext) => {
      try {
        return await service.getRunGraph(input.runID)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    getRunStep: async (input: { runID: string; stepID: string }, context: ErrorContext) => {
      try {
        return await service.getRunStep(input.runID, input.stepID)
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    pauseRun: async (
      input: { runID: string; requestID: string; expectedRevision: number },
      context: ErrorContext,
    ) => {
      try {
        return { run: await service.pauseRun(input.runID, input.requestID, input.expectedRevision) }
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    resumeRun: async (
      input: { runID: string; requestID: string; expectedRevision: number; confirmRetry?: boolean },
      context: ErrorContext,
    ) => {
      try {
        return {
          run: await service.resumeRun(input.runID, input.requestID, input.expectedRevision, input.confirmRetry ?? false),
        }
      } catch (error) {
        throw toRpcError(context, error)
      }
    },

    cancelRun: async (
      input: { runID: string; requestID: string; expectedRevision: number },
      context: ErrorContext,
    ) => {
      try {
        return { run: await service.cancelRun(input.runID, input.requestID, input.expectedRevision) }
      } catch (error) {
        throw toRpcError(context, error)
      }
    },
  } satisfies Record<keyof typeof AgentWorkflowsRpc.methods, unknown>
}
