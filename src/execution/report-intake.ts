import { NodeResultSchema, type NodeResult } from "../workflow/schema.js"
import type { WorkflowStore } from "../state/store.js"
import type { ReportRecord } from "../state/types.js"
import type { SessionRef } from "./harness.js"
import { sha256 } from "../util/hash.js"

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

/**
 * Deterministic report reference for transports without a native tool-call ID.
 * Namespaced so it cannot collide with a native ID, and bounded to the
 * 128-character `ReportRecord.toolCallID` field.
 */
export function syntheticReportRef(
  runID: string,
  stepID: string,
  sessionID: SessionRef,
  attempt: number,
): string {
  return `flowgraph:synthetic:${sha256(`${runID}\u0000${stepID}\u0000${sessionID}\u0000${attempt}`)}`
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
    if (invocation.allowedOutcomes.length > 0 && !invocation.allowedOutcomes.includes(input.result.outcome)) {
      throw new Error(
        `outcome "${input.result.outcome}" is not declared for node "${invocation.nodeID}". ` +
          `Allowed outcomes: ${invocation.allowedOutcomes.join(", ")}.`,
      )
    }

    const result = NodeResultSchema.parse(input.result)
    if (invocation.reported >= 5) {
      // An exact duplicate cannot change the canonical report, so keep it idempotent after the cap.
      const canonical = await this.store.getReport(invocation.projectID, invocation.runID, invocation.stepID)
      if (canonical?.toolCallID === input.toolCallRef && JSON.stringify(canonical.result) === JSON.stringify(result)) {
        invocation.lastReport = canonical
        return canonical
      }
      throw new Error("too many workflow reports for this step; stop calling flowgraph_report")
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
    const { report: stored, created } = await this.store.putReportOnce(invocation.projectID, report)
    if (!created) {
      if (stored.toolCallID !== input.toolCallRef) {
        throw new Error("a report already exists for this workflow step; the first valid report is canonical")
      }
      if (JSON.stringify(stored.result) !== JSON.stringify(result)) {
        throw new Error("a different result was already reported for this workflow tool call")
      }
      invocation.lastReport = stored
      return stored
    }

    invocation.lastReport = stored
    return stored
  }
}
