import { z } from "zod"
import { WorkflowIdSchema, WorkflowSchema } from "./workflow/schema.js"
import type { WorkflowDefinition } from "./workflow/schema.js"
import type { WorkflowGraph } from "./workflow/graph.js"
import type { AgentResolution } from "./workflow/validator.js"
import {
  PermissionSummarySchema,
  RunDetailSchema,
  RunStatusSchema,
  RunSummarySchema,
  StepRecordSchema,
} from "./state/types.js"

export const DiagnosticSchema = z
  .object({
    path: z.string().max(500),
    message: z.string().max(2_000),
    code: z.string().max(80).optional(),
  })
  .strict()

export const AgentResolutionSchema = z.custom<AgentResolution>(
  (value) => typeof value === "object" && value !== null && "agentID" in value,
)

export const WorkflowSchemaView = z.custom<WorkflowDefinition>(
  (value) => typeof value === "object" && value !== null && "version" in value,
)

export const GraphSchemaView = z.custom<WorkflowGraph>(
  (value) => typeof value === "object" && value !== null && "nodes" in value,
)

export const WorkflowSummarySchema = z
  .object({
    id: WorkflowIdSchema,
    name: z.string().max(64).optional(),
    description: z.string().max(500).optional(),
    valid: z.boolean(),
    errors: z.array(DiagnosticSchema),
    warnings: z.array(z.string().max(1_000)),
    hash: z.string().length(64).optional(),
  })
  .strict()

export const WorkflowViewSchema = z
  .object({
    id: WorkflowIdSchema,
    hash: z.string().length(64),
    source: z.string().max(256 * 1024),
    valid: z.boolean(),
    errors: z.array(DiagnosticSchema),
    warnings: z.array(z.string().max(1_000)),
    definition: WorkflowSchema.optional(),
    graph: GraphSchemaView.optional(),
    mermaid: z.string().max(1_000_000).optional(),
    agents: z.array(AgentResolutionSchema).optional(),
  })
  .strict()

export const ValidationViewSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(DiagnosticSchema),
    warnings: z.array(z.string().max(1_000)),
    definition: WorkflowSchema.optional(),
    graph: GraphSchemaView.optional(),
    mermaid: z.string().max(1_000_000).optional(),
    agents: z.array(AgentResolutionSchema).optional(),
  })
  .strict()

export const ListWorkflowsOutputSchema = z
  .object({
    workflows: z.array(WorkflowSummarySchema),
    directory: z.string().max(500),
  })
  .strict()

export const GetWorkflowInputSchema = z.object({ workflowID: WorkflowIdSchema }).strict()
export const ValidateWorkflowInputSchema = z
  .object({
    workflowID: WorkflowIdSchema.optional(),
    yaml: z.string().min(1).max(256 * 1024),
  })
  .strict()
export const SaveWorkflowInputSchema = z
  .object({
    workflowID: WorkflowIdSchema,
    yaml: z.string().min(1).max(256 * 1024),
    expectedHash: z.string().length(64).nullable(),
  })
  .strict()
export const SaveWorkflowOutputSchema = z
  .object({
    id: WorkflowIdSchema,
    hash: z.string().length(64),
    bytes: z.number().int().nonnegative(),
  })
  .strict()
export const DeleteWorkflowInputSchema = z
  .object({
    workflowID: WorkflowIdSchema,
    expectedHash: z.string().length(64),
  })
  .strict()
export const DeleteWorkflowOutputSchema = z.object({ deleted: z.literal(true) }).strict()

export const RunGraphNodeStateSchema = z.enum(["pending", "active", "completed", "failed", "paused"])
export const RunGraphNodeSchema = z
  .object({
    nodeID: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    agent: z.string().min(1).max(128),
    state: RunGraphNodeStateSchema,
    sessionIDs: z.array(z.string().min(1).max(128)).max(500),
    stepCount: z.number().int().nonnegative(),
  })
  .strict()
export const RunGraphEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    outcome: z.string().min(1).max(32).optional(),
    kind: z.enum(["next", "route"]),
    terminal: z.boolean(),
  })
  .strict()
export const RunGraphOutputSchema = z
  .object({
    runID: z.string().min(1).max(64),
    workflowID: WorkflowIdSchema,
    revision: z.number().int().nonnegative(),
    status: RunStatusSchema,
    activeNode: z.string().max(64).nullable(),
    currentNode: z.string().max(64).nullable(),
    nodes: z.array(RunGraphNodeSchema).max(200),
    edges: z.array(RunGraphEdgeSchema).max(3200),
    mermaid: z.string().max(1_000_000),
    mermaidNodes: z.array(z.object({ nodeID: z.string().max(64), mermaidID: z.string().max(64) }).strict()).max(200),
    activeMermaidID: z.string().max(64).nullable(),
    controls: z.object({ canPause: z.boolean(), canResume: z.boolean(), canCancel: z.boolean() }).strict(),
    pendingPermissions: z.array(PermissionSummarySchema).max(50),
    blocker: z
      .object({ type: z.string().max(80), message: z.string().max(1_000) })
      .strict()
      .nullable(),
  })
  .strict()
export const StartRunInputSchema = z
  .object({
    workflowID: WorkflowIdSchema,
    objective: z.string().min(1).max(16 * 1024),
    requestID: z.string().min(1).max(128),
  })
  .strict()
export const StartRunOutputSchema = z
  .object({
    runID: z.string().min(1).max(64),
    status: RunStatusSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict()
export const ListRunsInputSchema = z
  .object({
    status: RunStatusSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()
export const ListRunsOutputSchema = z.object({ runs: z.array(RunSummarySchema) }).strict()
export const RunInputSchema = z.object({ runID: z.string().min(1).max(64) }).strict()
export const GetRunGraphInputSchema = RunInputSchema
export const RunStepInputSchema = z
  .object({
    runID: z.string().min(1).max(64),
    stepID: z.string().min(1).max(64),
  })
  .strict()
export const ControlRunInputSchema = z
  .object({
    runID: z.string().min(1).max(64),
    requestID: z.string().min(1).max(128),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
export const ResumeRunInputSchema = ControlRunInputSchema.extend({
  confirmRetry: z.boolean().optional(),
}).strict()
export const RunControlOutputSchema = z.object({ run: RunSummarySchema }).strict()

export const CapabilitiesOutputSchema = z
  .object({
    plugin: z.object({ name: z.string(), version: z.string() }).strict(),
    rpc: z.object({ id: z.literal("agent_workflows"), version: z.literal(1) }).strict(),
    workflowSchemaVersion: z.literal(1),
    openCodeVersion: z.string(),
    features: z
      .object({
        conditionalRoutes: z.literal(true),
        cycles: z.literal(true),
        pause: z.literal(true),
        structuredResults: z.literal("tool"),
        conservativeRecovery: z.literal(true),
        runGraph: z.literal(true),
        parallelBranches: z.literal(false),
        nestedWorkflows: z.literal(false),
        backgroundNativeWork: z.literal(false),
      })
      .strict(),
    limits: z
      .object({
        maxWorkflowBytes: z.number().int().positive(),
        maxNodes: z.number().int().positive(),
        maxSteps: z.number().int().positive(),
        maxObjectiveBytes: z.number().int().positive(),
        maxRuns: z.number().int().positive(),
      })
      .strict(),
    storage: z
      .object({
        durable: z.literal(true),
        transactional: z.literal(false),
        compareAndSwap: z.literal(false),
        projectScopedKeys: z.literal(true),
      })
      .strict(),
  })
  .strict()

export const RunUpdatedEventSchema = z
  .object({
    projectID: z.string().min(1).max(128),
    projectCanonical: z.string().min(1).max(4_096),
    directory: z.string().min(1).max(4_096),
    runID: z.string().min(1).max(64),
    workflowID: WorkflowIdSchema,
    status: RunStatusSchema,
    currentNode: z.string().max(64).nullable(),
    revision: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    blocker: z
      .object({
        type: z.string().min(1).max(80),
        message: z.string().min(1).max(1_000),
      })
      .strict()
      .optional(),
  })
  .strict()

export const DeclaredErrorSchema = z
  .object({
    message: z.string().max(2_000).optional(),
    workflowID: z.string().max(64).optional(),
    runID: z.string().max(64).optional(),
    currentRevision: z.number().int().nonnegative().optional(),
    diagnostics: z.array(DiagnosticSchema).optional(),
    permissions: z.array(PermissionSummarySchema).optional(),
  })
  .strict()

export type CapabilitiesOutput = z.infer<typeof CapabilitiesOutputSchema>
export type ListWorkflowsOutput = z.infer<typeof ListWorkflowsOutputSchema>
export type WorkflowSummaryView = z.infer<typeof WorkflowSummarySchema>
export type WorkflowView = z.infer<typeof WorkflowViewSchema>
export type ValidationView = z.infer<typeof ValidationViewSchema>
export type StartRunOutput = z.infer<typeof StartRunOutputSchema>
export type RunGraphOutput = z.infer<typeof RunGraphOutputSchema>
export type RunGraphNode = z.infer<typeof RunGraphNodeSchema>
export type RunGraphEdge = z.infer<typeof RunGraphEdgeSchema>
export type RunDetailView = z.infer<typeof RunDetailSchema>
export type StepView = z.infer<typeof StepRecordSchema>
export type RunControlOutput = z.infer<typeof RunControlOutputSchema>
