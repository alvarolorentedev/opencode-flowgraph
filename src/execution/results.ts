import type { NodeResult } from "../workflow/schema.js"
import { validOutcomes, type WorkflowGraph } from "../workflow/graph.js"
import type { SessionMessage } from "./native-agents.js"
import type { ToolAudit, UsageEstimate } from "../state/types.js"

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

export function zeroUsage(): UsageEstimate {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUSD: 0,
    estimated: true,
    enforced: false,
    source: "provider_reported",
  }
}

export function addUsage(
  base: UsageEstimate,
  session: {
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  },
): UsageEstimate {
  return {
    input: base.input + (session.tokens.input ?? 0),
    output: base.output + (session.tokens.output ?? 0),
    reasoning: base.reasoning + (session.tokens.reasoning ?? 0),
    cacheRead: base.cacheRead + (session.tokens.cache.read ?? 0),
    cacheWrite: base.cacheWrite + (session.tokens.cache.write ?? 0),
    costUSD: base.costUSD + (session.cost ?? 0),
    estimated: true,
    enforced: false,
    source: "provider_reported",
  }
}

export function usageFromSession(session: {
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}): UsageEstimate {
  return addUsage(zeroUsage(), session)
}

export function assertValidOutcome(graph: WorkflowGraph, nodeID: string, result: NodeResult): void {
  const outcomes = validOutcomes(graph, nodeID)
  if (outcomes.length === 0) return
  if (!outcomes.includes(result.outcome)) {
    throw new Error(`outcome "${result.outcome}" is not valid for node "${nodeID}"; allowed: ${outcomes.join(", ")}`)
  }
}

export function latestIdle(messages: readonly SessionMessage[]): SessionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.type === "idle") return messages[index]
  }
  return undefined
}

export function latestAssistant(messages: readonly SessionMessage[]): SessionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.type === "assistant") return messages[index]
  }
  return undefined
}
