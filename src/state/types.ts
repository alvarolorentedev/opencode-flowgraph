import { z } from "zod"
import { NodeResultSchema, WorkflowSchema } from "../workflow/schema.js"

export const RUN_STATUSES = [
  "running",
  "pausing",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const

export const RunStatusSchema = z.enum(RUN_STATUSES)
export type RunStatus = z.infer<typeof RunStatusSchema>

export const STEP_STATUSES = ["running", "completed", "failed", "interrupted", "ambiguous", "abandoned"] as const
export const StepStatusSchema = z.enum(STEP_STATUSES)
export type StepStatus = z.infer<typeof StepStatusSchema>

export const FailureInfoSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1_000),
    nodeID: z.string().max(64).optional(),
    stepID: z.string().max(64).optional(),
    nativeErrorType: z.string().max(120).optional(),
  })
  .strict()
export type FailureInfo = z.infer<typeof FailureInfoSchema>

export const BlockerSchema = z
  .object({
    type: z.enum([
      "permission",
      "ambiguous_node",
      "node_interrupted",
      "missing_report",
      "host_unloaded",
      "recovery",
    ]),
    message: z.string().min(1).max(1_000),
    since: z.number().int().nonnegative(),
    nodeID: z.string().max(64).optional(),
    stepID: z.string().max(64).optional(),
  })
  .strict()
export type Blocker = z.infer<typeof BlockerSchema>

export const PermissionSummarySchema = z
  .object({
    requestID: z.string().min(1).max(128),
    action: z.string().min(1).max(120),
    resources: z.array(z.string().max(500)).max(20),
    message: z.string().max(500).optional(),
  })
  .strict()
export type PermissionSummary = z.infer<typeof PermissionSummarySchema>

export const UsageEstimateSchema = z
  .object({
    input: z.number().nonnegative().default(0),
    output: z.number().nonnegative().default(0),
    reasoning: z.number().nonnegative().default(0),
    cacheRead: z.number().nonnegative().default(0),
    cacheWrite: z.number().nonnegative().default(0),
    costUSD: z.number().nonnegative().default(0),
    estimated: z.literal(true).default(true),
    enforced: z.literal(false).default(false),
    source: z.literal("provider_reported").default("provider_reported"),
  })
  .strict()
export type UsageEstimate = z.infer<typeof UsageEstimateSchema>

export const ToolAuditEntrySchema = z
  .object({
    name: z.string().min(1).max(120),
    status: z.enum(["completed", "error", "running"]),
    at: z.number().int().nonnegative(),
    mutating: z.boolean().default(false),
  })
  .strict()
export type ToolAuditEntry = z.infer<typeof ToolAuditEntrySchema>

export const ToolAuditSchema = z
  .object({
    toolCalls: z.array(ToolAuditEntrySchema).max(200).default([]),
    mutatingToolCalls: z.number().int().nonnegative().default(0),
  })
  .strict()
export type ToolAudit = z.infer<typeof ToolAuditSchema>

export const EvidenceReportSchema = z
  .object({
    outcome: z.string().min(1).max(32),
    summary: z.string().min(1).max(4_000),
    feedback: z.string().max(4_000).default(""),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["file", "command", "url", "note"]),
            value: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>

export const StepSummarySchema = z
  .object({
    stepID: z.string().min(1).max(64),
    seq: z.number().int().positive(),
    nodeID: z.string().min(1).max(64),
    outcome: z.string().max(32).optional(),
    status: StepStatusSchema,
    sessionID: z.string().min(1).max(128),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
export type StepSummary = z.infer<typeof StepSummarySchema>

export const ActiveStepSchema = z
  .object({
    stepID: z.string().min(1).max(64),
    stepIndex: z.number().int().positive(),
    attempt: z.number().int().positive(),
    nodeID: z.string().min(1).max(64),
    agentID: z.string().min(1).max(128),
    sessionID: z.string().min(1).max(128),
    promptMessageID: z.string().min(1).max(128),
    phase: z.enum(["prepared", "session_created", "prompting", "prompted", "completed", "failed", "ambiguous"]),
    startedAt: z.number().int().nonnegative(),
    promptedAt: z.number().int().nonnegative().optional(),
    resultAttempts: z.number().int().nonnegative().default(0),
  })
  .strict()
export type ActiveStep = z.infer<typeof ActiveStepSchema>

export const ProjectIdentitySchema = z
  .object({
    id: z.string().min(1).max(128),
    canonical: z.string().min(1).max(4_096),
    directory: z.string().min(1).max(4_096),
  })
  .strict()
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>

export const OwnerSchema = z
  .object({
    instanceID: z.string().min(1).max(128),
    hostname: z.string().min(1).max(255),
    pid: z.number().int().positive(),
  })
  .strict()
export type Owner = z.infer<typeof OwnerSchema>

export const RecoveryInfoSchema = z
  .object({
    attempts: z.number().int().nonnegative().default(0),
    lastAttemptAt: z.number().int().nonnegative().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
export type RecoveryInfo = z.infer<typeof RecoveryInfoSchema>

export const RunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runID: z.string().min(1).max(64),
    workflowID: z.string().min(1).max(64),
    requestID: z.string().min(1).max(128),
    requestHash: z.string().length(64),

    project: ProjectIdentitySchema,
    workflowHash: z.string().length(64),
    workflowSnapshot: WorkflowSchema,
    sourceYamlKey: z.string().min(1).max(512),

    objective: z.string().min(1).max(16 * 1024),
    status: RunStatusSchema,
    revision: z.number().int().nonnegative(),

    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
    deadlineAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),

    runSessionID: z.string().min(1).max(128).nullable(),
    currentNode: z.string().max(64).nullable(),
    nextNode: z.string().max(64).nullable(),
    stepCount: z.number().int().nonnegative(),
    maxSteps: z.number().int().positive(),

    activeStep: ActiveStepSchema.nullable(),
    lastStep: StepSummarySchema.nullable(),
    steps: z.array(StepSummarySchema).max(500),

    blocker: BlockerSchema.nullable(),
    pendingPermissions: z.array(PermissionSummarySchema).max(50).default([]),
    failure: FailureInfoSchema.nullable(),
    pause: z
      .object({
        reason: z.enum(["user", "route", "no_progress"]),
        requestedAt: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    cancel: z
      .object({
        requestedAt: z.number().int().nonnegative(),
        interruptAccepted: z.boolean(),
      })
      .strict()
      .nullable(),

    usage: UsageEstimateSchema,
    audit: ToolAuditSchema,

    owner: OwnerSchema,
    recovery: RecoveryInfoSchema,
    recentControlRequests: z.record(z.string(), z.object({
      operation: z.string().max(32),
      at: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
    }).strict()).default({}),
  })
  .strict()
export type RunRecord = z.infer<typeof RunRecordSchema>

export const StepRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runID: z.string().min(1).max(64),
    stepID: z.string().min(1).max(64),
    seq: z.number().int().positive(),
    nodeID: z.string().min(1).max(64),
    agentID: z.string().min(1).max(128),
    sessionID: z.string().min(1).max(128),
    promptMessageID: z.string().min(1).max(128),
    attempt: z.number().int().positive(),
    status: StepStatusSchema,
    nativeOutcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
    result: NodeResultSchema.optional(),
    audit: ToolAuditSchema,
    usage: UsageEstimateSchema,
    error: FailureInfoSchema.optional(),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
export type StepRecord = z.infer<typeof StepRecordSchema>

export const ReportRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runID: z.string().min(1).max(64),
    stepID: z.string().min(1).max(64),
    sessionID: z.string().min(1).max(128),
    messageID: z.string().min(1).max(128),
    toolCallID: z.string().min(1).max(128),
    result: NodeResultSchema,
    reportedAt: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
  })
  .strict()
export type ReportRecord = z.infer<typeof ReportRecordSchema>

export const RunSummarySchema = z
  .object({
    runID: z.string().min(1).max(64),
    workflowID: z.string().min(1).max(64),
    project: ProjectIdentitySchema,
    objective: z.string().min(1).max(16 * 1024),
    status: RunStatusSchema,
    revision: z.number().int().nonnegative(),
    currentNode: z.string().max(64).nullable(),
    nextNode: z.string().max(64).nullable(),
    stepCount: z.number().int().nonnegative(),
    maxSteps: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    blocker: BlockerSchema.nullable(),
    failure: FailureInfoSchema.nullable(),
    usage: UsageEstimateSchema,
  })
  .strict()
export type RunSummary = z.infer<typeof RunSummarySchema>

export const RunDetailSchema = z
  .object({
    run: RunRecordSchema,
    currentStep: StepRecordSchema.nullable(),
    pendingPermissions: z.array(PermissionSummarySchema),
    mermaid: z.string(),
    resumable: z.boolean(),
  })
  .strict()
export type RunDetail = z.infer<typeof RunDetailSchema>

export function summaryOf(run: RunRecord): RunSummary {
  return {
    runID: run.runID,
    workflowID: run.workflowID,
    project: run.project,
    objective: run.objective,
    status: run.status,
    revision: run.revision,
    currentNode: run.currentNode,
    nextNode: run.nextNode,
    stepCount: run.stepCount,
    maxSteps: run.maxSteps,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    blocker: run.blocker,
    failure: run.failure,
    usage: run.usage,
  }
}
