import { z } from "zod"

export const WORKFLOW_SCHEMA_VERSION = 1

export const HARD_LIMITS = {
  maxWorkflowBytes: 256 * 1024,
  maxWorkflowLines: 10_000,
  maxWorkflows: 200,
  maxNodes: 200,
  maxRoutesPerNode: 16,
  maxSteps: 500,
  maxTimeoutSeconds: 86_400,
  maxObjectiveBytes: 16 * 1024,
  maxTextResultBytes: 4 * 1024,
  maxEvidenceItems: 20,
  maxEvidenceValueBytes: 1024,
  maxPromptBytes: 32 * 1024,
  maxRuns: 500,
} as const

export const TERMINALS = ["complete", "pause"] as const
export type Terminal = (typeof TERMINALS)[number]

export const WorkflowIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, "must be a lowercase slug")
  .max(64)

export const NodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, "must be a lowercase slug")
  .max(64)

export const OutcomeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be a lowercase identifier")
  .max(32)

export const TargetSchema = z.string().min(1).max(64)

export const AgentRefSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters")

export const LimitsSchema = z
  .object({
    max_steps: z.number().int().min(1).max(HARD_LIMITS.maxSteps),
    timeout_seconds: z.number().int().min(1).max(HARD_LIMITS.maxTimeoutSeconds).default(3_600),
    node_timeout_seconds: z.number().int().min(1).max(HARD_LIMITS.maxTimeoutSeconds).optional(),
    max_result_retries: z.number().int().min(0).max(5).default(2),
    max_recovery_attempts: z.number().int().min(0).max(10).default(3),
    max_repeat_transitions: z.number().int().min(1).max(50).default(5),
  })
  .strict()

const AgentNodeSchema = z
  .object({
    agent: AgentRefSchema,
    label: z.string().min(1).max(80).optional(),
    next: TargetSchema.optional(),
    routes: z
      .record(OutcomeSchema, TargetSchema)
      .refine((routes) => {
        const count = Object.keys(routes).length
        return count >= 1 && count <= HARD_LIMITS.maxRoutesPerNode
      }, `routes must contain between 1 and ${HARD_LIMITS.maxRoutesPerNode} outcomes`)
      .optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    if ((node.next === undefined) === (node.routes === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "a node must define exactly one of `next` or `routes`",
        path: ["next"],
      })
    }
  })

const ForkNodeSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  fork: z.array(NodeIdSchema).min(2).max(HARD_LIMITS.maxRoutesPerNode)
    .refine((branches) => new Set(branches).size === branches.length, "fork branches must be distinct"),
  join: NodeIdSchema,
}).strict()

const CallNodeSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  workflow: WorkflowIdSchema,
  routes: z.object({ complete: TargetSchema, pause: TargetSchema }).strict(),
}).strict()

export const NodeSchema = z.union([AgentNodeSchema, ForkNodeSchema, CallNodeSchema])

export const WorkflowSchema = z
  .object({
    version: z.literal(WORKFLOW_SCHEMA_VERSION),
    name: WorkflowIdSchema,
    description: z.string().max(500).optional(),
    entry: NodeIdSchema,
    limits: LimitsSchema,
    nodes: z
      .record(NodeIdSchema, NodeSchema)
      .refine(
        (nodes) => Object.keys(nodes).length >= 1 && Object.keys(nodes).length <= HARD_LIMITS.maxNodes,
        `nodes must contain between 1 and ${HARD_LIMITS.maxNodes} entries`,
      ),
  })
  .strict()

export type WorkflowDefinition = z.infer<typeof WorkflowSchema>
export type WorkflowNode = z.infer<typeof NodeSchema>
export type WorkflowLimits = z.infer<typeof LimitsSchema>

export const EvidenceSchema = z
  .object({
    kind: z.enum(["file", "command", "url", "note"]),
    value: z.string().min(1).max(HARD_LIMITS.maxEvidenceValueBytes),
  })
  .strict()

export const NodeResultSchema = z
  .object({
    outcome: OutcomeSchema,
    summary: z.string().min(1).max(HARD_LIMITS.maxTextResultBytes),
    feedback: z.string().max(HARD_LIMITS.maxTextResultBytes).default(""),
    evidence: z.array(EvidenceSchema).max(HARD_LIMITS.maxEvidenceItems).default([]),
  })
  .strict()

export type NodeResult = z.infer<typeof NodeResultSchema>

export const ApprovalSchema = z
  .object({
    outcome: OutcomeSchema,
    summary: z.string().min(1).max(255),
    feedback: z.string().max(255).optional(),
  })
  .strict()

export function isTerminal(target: string): target is Terminal {
  return target === "complete" || target === "pause"
}

export function isReservedNodeId(id: string): boolean {
  return isTerminal(id)
}
