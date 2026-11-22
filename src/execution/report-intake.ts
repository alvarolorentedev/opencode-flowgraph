import { NodeResultSchema, type NodeResult } from "../workflow/schema.js"
import type { WorkflowStore } from "../state/store.js"
import type { ReportRecord } from "../state/types.js"
import type { SessionRef } from "./harness.js"

export type ActiveInvocation = {
  runID: string
  projectID: string
  stepID: string
  sessionID: SessionRef
  nodeID: string
  allowedOutcomes: string[]
  attempt: number
  reported: number
  lastReport?: ReportRecord
}

export type InvocationRegistry = {
  register(invocation: ActiveInvocation): void
  unregister(sessionID: SessionRef): void
  get(sessionID: SessionRef): ActiveInvocation | undefined
  has(sessionID: SessionRef): boolean
  sessions(): SessionRef[]
}

export function createInvocationRegistry(): InvocationRegistry {
  const active = new Map<SessionRef, ActiveInvocation>()
  return {
    register(invocation) {
      active.set(invocation.sessionID, invocation)
    },
    unregister(sessionID) {
      active.delete(sessionID)
    },
    get(sessionID) {
      return active.get(sessionID)
    },
    has(sessionID) {
      return active.has(sessionID)
    },
    sessions() {
      return Array.from(active.keys())
    },
  }
}

export type ReportSubmission = {
  session: SessionRef
  messageRef: string
  toolCallRef: string
  result: NodeResult
  reportedAt?: number
}

export class ReportIntake {
  constructor(
    private readonly store: WorkflowStore,
    private readonly invocations: InvocationRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async submit(input: ReportSubmission): Promise<ReportRecord> {
    const invocation = this.invocations.get(input.session)
    if (!invocation) {
      throw new Error(
        "flowgraph_report is only available during an active workflow node session. " +
          "Finish the node normally or use the workflow RPC API to start a run.",
      )
    }
    if (invocation.reported >= 5) {
      throw new Error("too many workflow reports for this step; stop calling flowgraph_report")
    }
    if (invocation.allowedOutcomes.length > 0 && !invocation.allowedOutcomes.includes(input.result.outcome)) {
      throw new Error(
        `outcome "${input.result.outcome}" is not declared for node "${invocation.nodeID}". ` +
          `Allowed outcomes: ${invocation.allowedOutcomes.join(", ")}.`,
      )
    }

    const result = NodeResultSchema.parse(input.result)
    const existing = await this.store.getReport(invocation.projectID, invocation.runID, invocation.stepID)
    if (existing?.toolCallID === input.toolCallRef) {
      if (JSON.stringify(existing.result) === JSON.stringify(result)) return existing
      throw new Error("a different result was already reported for this workflow tool call")
    }

    invocation.reported += 1
    const report: ReportRecord = {
      schemaVersion: 1,
      runID: invocation.runID,
      stepID: invocation.stepID,
      sessionID: invocation.sessionID,
      messageID: input.messageRef,
      toolCallID: input.toolCallRef,
      result,
      reportedAt: input.reportedAt ?? this.now(),
      attempt: invocation.attempt,
    }
    invocation.lastReport = report
    await this.store.putReport(invocation.projectID, report)
    return report
  }
}
