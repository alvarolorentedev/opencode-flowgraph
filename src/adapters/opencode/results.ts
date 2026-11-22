import type { ToolAudit, UsageEstimate } from "../../state/types.js"
import type { SessionMessage } from "./types.js"

const MUTATING_TOOLS = new Set(["edit", "write", "patch", "shell"])

export function auditFromMessages(messages: readonly SessionMessage[]): ToolAudit {
  const toolCalls: ToolAudit["toolCalls"] = []
  let mutatingToolCalls = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue
      const tool = part
      if (tool.name === undefined) continue
      const raw = tool.state?.status
      const status = raw === "completed" || raw === "error" || raw === "running" ? raw : "completed"
      const mutating =
        MUTATING_TOOLS.has(tool.name) &&
        (tool.executed === true || raw === "completed" || raw === "error" || raw === "running")
      if (mutating) mutatingToolCalls += 1
      toolCalls.push({
        name: tool.name,
        status,
        at: message.time?.created ?? 0,
        mutating,
      })
    }
  }
  return { toolCalls, mutatingToolCalls }
}

export function usageFromSession(session: {
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}): UsageEstimate {
  return {
    input: session.tokens.input ?? 0,
    output: session.tokens.output ?? 0,
    reasoning: session.tokens.reasoning ?? 0,
    cacheRead: session.tokens.cache.read ?? 0,
    cacheWrite: session.tokens.cache.write ?? 0,
    costUSD: session.cost ?? 0,
    estimated: true,
    enforced: false,
    source: "provider_reported",
  }
}

export function addUsage(base: UsageEstimate, session: Parameters<typeof usageFromSession>[0]): UsageEstimate {
  const extra = usageFromSession(session)
  return {
    ...base,
    input: base.input + extra.input,
    output: base.output + extra.output,
    reasoning: base.reasoning + extra.reasoning,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    costUSD: base.costUSD + extra.costUSD,
  }
}

export function latestIdle(messages: readonly SessionMessage[]): SessionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.type === "idle") return messages[index]
  }
  return undefined
}
