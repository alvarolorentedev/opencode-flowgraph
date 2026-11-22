import { z } from "zod"
import type { PermissionSummary, ToolAudit, UsageEstimate } from "../state/types.js"
import type { AgentDescriptor } from "../workflow/validator.js"

export type SessionRef = string
export type SubmissionRef = string

export type ExecutionState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "unknown"

export type ExecutionSnapshot = {
  sessionRef: SessionRef
  state: ExecutionState
  /** Epoch ms when the harness observed the terminal state, if known. */
  finishedAt?: number
  usage?: UsageEstimate
  audit?: ToolAudit
  error?: { message: string; type?: string }
}

export type PendingPermissions =
  | { state: "none" }
  | { state: "pending"; items: PermissionSummary[] }
  /** The adapter cannot prove absence; the engine must block, never retry. */
  | { state: "unknown" }

export type SubmissionState = "admitted" | "not_admitted" | "unknown"

export const HarnessCapabilitiesSchema = z
  .object({
    id: z.string().min(1).max(64),
    displayName: z.string().min(1).max(128),
    version: z.string().min(1).max(64).optional(),

    agents: z
      .object({
        discovery: z.enum(["native", "configured"]),
      })
      .strict(),

    sessions: z
      .object({
        /** Can create a grouping/root session that is not a node. */
        runScope: z.boolean(),
        /** May adopt runs stored before harness identity existed. Only OpenCode. */
        adoptLegacyRuns: z.boolean(),
      })
      .strict(),

    results: z
      .object({
        mechanism: z.enum(["native_tool", "structured_output", "mcp_tool", "none"]),
        /** Can ask the same native session for a corrected result. */
        corrections: z.boolean(),
      })
      .strict(),

    permissions: z
      .object({
        /** Pending requests remain queryable after a process restart. */
        survivesRestart: z.boolean(),
        /** Who answers approval prompts: the harness UI, the host, or nobody. */
        approval: z.enum(["native", "host", "none"]),
      })
      .strict(),

    security: z
      .object({
        nativePermissions: z.boolean(),
        protectedPaths: z.enum(["tool_hook", "approval_hook", "best_effort", "none"]),
        backgroundWork: z.enum(["blocked", "unobservable"]),
      })
      .strict(),

    usage: z.object({ tokens: z.boolean(), cost: z.boolean() }).strict(),
    audit: z.boolean(),
  })
  .strict()
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>


export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities

  listAgents(): Promise<AgentDescriptor[]>
  /** Re-resolve at admission time; return selectable=false with a reason if unusable. */
  resolveAgent(agentRef: string): Promise<AgentDescriptor | undefined>

  /** Optional grouping session; no node work. */
  createRunScope?(input: {
    title: string
    metadata: Record<string, string>
  }): Promise<{ ref: SessionRef }>

  createSession(input: {
    agentRef: string
    title: string
    metadata: Record<string, string>
    parent?: SessionRef
  }): Promise<{ ref: SessionRef }>

  /**
   * Submit one node prompt. Must resolve once the harness has accepted the
   * submission (admission proof), not when the work completes. Must throw
   * if admission cannot be confirmed.
   */
  submit(input: {
    session: SessionRef
    submission: SubmissionRef
    text: string
    metadata?: Record<string, string>
  }): Promise<void>

  /**
   * Cheap, repeatable. Must not block on completion. May lazily reattach or
   * read the native session after a restart, but must never submit work.
   */
  inspect(session: SessionRef): Promise<ExecutionSnapshot>

  /** Never return "none" if absence cannot be proven. */
  pendingPermissions(session: SessionRef): Promise<PendingPermissions>

  /** True only if the harness confirmed the stop. */
  cancel(session: SessionRef): Promise<boolean>

  /** Optional text that tells the agent how to return a structured result. */
  completionInstruction?(input: { nodeID: string; allowedOutcomes: string[] }): string

  /** Optional; used only after a restart to reconcile a prompt. */
  submissionState?(session: SessionRef, submission: SubmissionRef): Promise<SubmissionState>
}
