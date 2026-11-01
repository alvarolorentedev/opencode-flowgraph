import type { OpenCodePluginContext } from "./native-agents.js"
import type { InvocationRegistry } from "./report-tool.js"

export type ToolHookOptions = {
  allowBackgroundWork: boolean
}

export async function registerToolHooks(
  ctx: OpenCodePluginContext,
  invocations: InvocationRegistry,
  options: ToolHookOptions,
): Promise<void> {
  await ctx.tool.hook("execute.before", (event) => {
    if (!invocations.has(event.sessionID)) return
    if (options.allowBackgroundWork) return
    if (event.tool !== "subagent" && event.tool !== "shell") return
    const input = event.input as { background?: unknown } | undefined
    if (input?.background === true) {
      throw new Error(
        `background ${event.tool} execution is disabled inside workflow nodes because it would outlive the sequential node. ` +
          `Use foreground execution or set the plugin option allowBackgroundWork=true.`,
      )
    }
  })
}
