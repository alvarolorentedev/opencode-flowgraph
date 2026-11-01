import { NodeResultSchema, type NodeResult } from "../workflow/schema.js"
import type { WorkflowStore } from "../state/store.js"
import type { ReportRecord } from "../state/types.js"
import type { OpenCodePluginContext } from "./native-agents.js"

export type ActiveInvocation = {
  runID: string
  projectID: string
  stepID: string
  sessionID: string
  nodeID: string
  allowedOutcomes: string[]
  attempt: number
  reported: number
  lastReport?: ReportRecord
}

export type InvocationRegistry = {
  register(invocation: ActiveInvocation): void
  unregister(sessionID: string): void
  get(sessionID: string): ActiveInvocation | undefined
  has(sessionID: string): boolean
  sessions(): string[]
}

export function createInvocationRegistry(): InvocationRegistry {
  const active = new Map<string, ActiveInvocation>()
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

export class ReportTool {
  constructor(
    private readonly ctx: OpenCodePluginContext,
    private readonly store: WorkflowStore,
    private readonly invocations: InvocationRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async register(): Promise<void> {
    await this.ctx.tool.transform((editor) => {
      editor.namespace({
        name: "agent_workflows",
        description: "Structured reporting for OpenCode agent workflow nodes.",
      })
      editor.add({
        name: "report",
        description:
          "Report the structured result of the current agent workflow node. " +
          "Only available inside sessions started by the OpenCode agent workflows plugin. " +
          "Call this exactly once when the node is finished. The orchestrator, not the agent, chooses the next node.",
        input: NodeResultSchema,
        options: { namespace: "agent_workflows", codemode: false },
        execute: async (input: NodeResult, context) => {
          const invocation = this.invocations.get(context.sessionID)
          if (!invocation) {
            throw new Error(
              "agent_workflows_report is only available during an active workflow node session. " +
                "Finish the node normally or use the workflow RPC API to start a run.",
            )
          }
          if (context.signal.aborted) throw new Error("workflow node was cancelled")
          if (invocation.reported >= 5) {
            throw new Error("too many workflow reports for this step; stop calling agent_workflows_report")
          }
          if (invocation.allowedOutcomes.length > 0 && !invocation.allowedOutcomes.includes(input.outcome)) {
            throw new Error(
              `outcome "${input.outcome}" is not declared for node "${invocation.nodeID}". ` +
                `Allowed outcomes: ${invocation.allowedOutcomes.join(", ")}.`,
            )
          }
          invocation.reported += 1
          const report: ReportRecord = {
            schemaVersion: 1,
            runID: invocation.runID,
            stepID: invocation.stepID,
            sessionID: context.sessionID,
            messageID: context.messageID,
            toolCallID: context.id,
            result: input,
            reportedAt: this.now(),
            attempt: invocation.attempt,
          }
          invocation.lastReport = report
          await this.store.putReport(invocation.projectID, report)
          return { content: "Workflow outcome recorded. Finish your response without repeating completed work." }
        },
      })
    })
  }

  async requireTool(): Promise<void> {
    const tools = await this.ctx.tool.list()
    if (!tools.some((tool) => tool.id === "agent_workflows_report")) {
      throw new Error("agent_workflows_report tool was not registered")
    }
  }
}
