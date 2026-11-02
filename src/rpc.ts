import { z } from "zod"
import { Rpc } from "@opencode/plugin/rpc"
import {
  CapabilitiesOutputSchema,
  ControlRunInputSchema,
  DeclaredErrorSchema,
  DeleteWorkflowInputSchema,
  DeleteWorkflowOutputSchema,
  GetRunGraphInputSchema,
  GetWorkflowInputSchema,
  ListRunsInputSchema,
  ListRunsOutputSchema,
  ListWorkflowsOutputSchema,
  ResumeRunInputSchema,
  RunControlOutputSchema,
  RunGraphOutputSchema,
  RunInputSchema,
  RunStepInputSchema,
  RunUpdatedEventSchema,
  SaveWorkflowInputSchema,
  SaveWorkflowOutputSchema,
  StartRunInputSchema,
  StartRunOutputSchema,
  ValidateWorkflowInputSchema,
  ValidationViewSchema,
  WorkflowViewSchema,
} from "./contract.js"
import { RunDetailSchema, StepRecordSchema } from "./state/types.js"

const errors = {
  not_found: DeclaredErrorSchema,
  invalid_input: DeclaredErrorSchema,
  invalid_workflow: DeclaredErrorSchema,
  unsafe_path: DeclaredErrorSchema,
  stale_revision: DeclaredErrorSchema,
  not_owner: DeclaredErrorSchema,
  project_busy: DeclaredErrorSchema,
  idempotency_conflict: DeclaredErrorSchema,
  too_many_runs: DeclaredErrorSchema,
  permission_pending: DeclaredErrorSchema,
  ambiguous_requires_confirmation: DeclaredErrorSchema,
  not_resumable: DeclaredErrorSchema,
  invalid_state: DeclaredErrorSchema,
  unavailable: DeclaredErrorSchema,
} as const

export const AgentWorkflowsRpc = Rpc.define({
  id: "agent_workflows",
  methods: {
    capabilities: {
      input: z.object({}).strict().optional(),
      output: CapabilitiesOutputSchema,
    },
    listWorkflows: {
      input: z.object({}).strict().optional(),
      output: ListWorkflowsOutputSchema,
      errors,
    },
    getWorkflow: {
      input: GetWorkflowInputSchema,
      output: WorkflowViewSchema,
      errors,
    },
    validateWorkflow: {
      input: ValidateWorkflowInputSchema,
      output: ValidationViewSchema,
      errors,
    },
    saveWorkflow: {
      input: SaveWorkflowInputSchema,
      output: SaveWorkflowOutputSchema,
      errors,
    },
    deleteWorkflow: {
      input: DeleteWorkflowInputSchema,
      output: DeleteWorkflowOutputSchema,
      errors,
    },
    startRun: {
      input: StartRunInputSchema,
      output: StartRunOutputSchema,
      errors,
    },
    listRuns: {
      input: ListRunsInputSchema,
      output: ListRunsOutputSchema,
      errors,
    },
    getRun: {
      input: RunInputSchema,
      output: RunDetailSchema,
      errors,
    },
    getRunGraph: {
      input: GetRunGraphInputSchema,
      output: RunGraphOutputSchema,
      errors,
    },
    getRunStep: {
      input: RunStepInputSchema,
      output: StepRecordSchema,
      errors,
    },
    pauseRun: {
      input: ControlRunInputSchema,
      output: RunControlOutputSchema,
      errors,
    },
    resumeRun: {
      input: ResumeRunInputSchema,
      output: RunControlOutputSchema,
      errors,
    },
    cancelRun: {
      input: ControlRunInputSchema,
      output: RunControlOutputSchema,
      errors,
    },
  },
  events: {
    runUpdated: { schema: RunUpdatedEventSchema },
  },
})

export type AgentWorkflowsRpcDefinition = typeof AgentWorkflowsRpc
export type { WorkflowView, ValidationView, CapabilitiesOutput, RunDetailView, StepView } from "./contract.js"
