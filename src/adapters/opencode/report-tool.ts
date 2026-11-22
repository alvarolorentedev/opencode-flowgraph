import { NodeResultSchema, type NodeResult } from "../../workflow/schema.js"
import type { ReportIntake } from "../../execution/report-intake.js"
import type { OpenCodePluginContext } from "./runtime.js"

export class ReportTool {
  constructor(
    private readonly ctx: OpenCodePluginContext,
    private readonly intake: ReportIntake,
  ) {}

  async register(): Promise<void> {
    await this.ctx.tool.transform((editor) => {
      editor.namespace({
        name: "flowgraph",
        description: "Structured reporting for OpenCode agent workflow nodes.",
      })
      editor.add({
        name: "report",
        description:
          "Report the structured result of the current agent workflow node. " +
          "Only available inside sessions started by the OpenCode flowgraph plugin. " +
          "Call this exactly once when the node is finished. The orchestrator, not the agent, chooses the next node.",
        input: NodeResultSchema,
        options: { namespace: "flowgraph", codemode: false },
        execute: async (input: NodeResult, context) => {
          if (context.signal.aborted) throw new Error("workflow node was cancelled")
          await this.intake.submit({
            session: context.sessionID,
            messageRef: context.messageID,
            toolCallRef: context.id,
            result: input,
          })
          return { content: "Workflow outcome recorded. Finish your response without repeating completed work." }
        },
      })
    })
  }

  async requireTool(): Promise<void> {
    const tools = await this.ctx.tool.list()
    if (!tools.some((tool) => tool.id === "flowgraph_report")) {
      throw new Error("flowgraph_report tool was not registered")
    }
  }
}
