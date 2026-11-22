import { Agent, Plugin } from "@opencode/plugin"
import type { AgentDescriptor } from "../../workflow/validator.js"
import type {
  ExecutionSnapshot,
  HarnessAdapter,
  HarnessCapabilities,
  PendingPermissions,
  SessionRef,
  SubmissionState,
} from "../../execution/harness.js"
import { auditFromMessages, latestIdle, usageFromSession } from "./results.js"
import type { SessionMessage } from "./types.js"

export type OpenCodePluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function epoch(value: unknown): number {
  if (typeof value === "number") return value
  if (value && typeof value === "object" && "epochMilliseconds" in value) {
    const millis = (value as { epochMilliseconds: unknown }).epochMilliseconds
    if (typeof millis === "number") return millis
  }
  return 0
}

function descriptor(
  agent: {
    id: string
    name: string
    mode: "subagent" | "primary" | "all"
    hidden: boolean
    model?: { providerID: string; id: string; variant?: string }
    description?: string
  },
  hasDefaultModel: boolean,
): AgentDescriptor {
  const selectable = !agent.hidden && agent.mode !== "subagent" && (agent.model !== undefined || hasDefaultModel)
  const reason = agent.hidden
    ? {
        code: "hidden_agent",
        message: `agent "${agent.id}" is hidden and cannot be selected by workflows`,
      }
    : agent.mode === "subagent"
      ? {
          code: "subagent_agent_not_selectable",
          message:
            `agent "${agent.id}" is mode "subagent". Workflow nodes select agents directly; ` +
            `change the native agent to mode "all" or "primary" to use it in a workflow.`,
        }
      : agent.model === undefined && !hasDefaultModel
        ? {
            code: "agent_missing_model",
            message:
              `agent "${agent.id}" has no model and no default model is configured; ` +
              `set a model on the agent or set "model" in opencode.json(c).`,
          }
        : undefined

  return {
    id: agent.id,
    name: agent.name,
    selectable,
    ...(reason === undefined ? {} : { reason }),
    mode: agent.mode,
    hidden: agent.hidden,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.description === undefined ? {} : { description: agent.description }),
  }
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities

  constructor(private readonly ctx: OpenCodePluginContext) {
    this.capabilities = {
      id: "opencode",
      displayName: "OpenCode",
      version: ctx.app.version,
      agents: { discovery: "native" },
      sessions: { runScope: true, adoptLegacyRuns: true },
      results: { mechanism: "native_tool", corrections: true },
      permissions: { survivesRestart: true, approval: "native" },
      security: { nativePermissions: true, protectedPaths: "tool_hook", backgroundWork: "blocked" },
      usage: { tokens: true, cost: true },
      audit: true,
    }
  }

  private async getDefaultModel(): Promise<{ providerID: string; id: string } | undefined> {
    const result = (await this.ctx.model.default()) as unknown
    const model = result && typeof result === "object" && "data" in result ? result.data : result
    if (!model || typeof model !== "object") return undefined
    const record = model as { providerID?: unknown; id?: unknown; modelID?: unknown }
    const id = typeof record.id === "string" ? record.id : typeof record.modelID === "string" ? record.modelID : undefined
    if (typeof record.providerID !== "string" || id === undefined) return undefined
    return { providerID: record.providerID, id }
  }

  async listAgents(): Promise<AgentDescriptor[]> {
    const [result, defaultModel] = await Promise.all([
      this.ctx.agent.list(),
      this.getDefaultModel().catch(() => undefined),
    ])
    return result.data.map((agent) => descriptor(agent, defaultModel !== undefined))
  }

  async resolveAgent(agentID: string): Promise<AgentDescriptor | undefined> {
    return (await this.listAgents()).find((agent) => agent.id === agentID)
  }

  async createRunScope(input: {
    title: string
    metadata: Record<string, string>
  }): Promise<{ ref: SessionRef }> {
    const session = await this.ctx.session.create({
      title: input.title,
      metadata: input.metadata,
    })
    return { ref: session.id }
  }

  async createSession(input: {
    agentRef: string
    title: string
    metadata: Record<string, string>
    parent?: SessionRef
  }): Promise<{ ref: SessionRef }> {
    const agent = await this.resolveAgent(input.agentRef)
    if (!agent) throw new Error(`agent "${input.agentRef}" is unavailable`)
    if (agent.selectable === false) {
      throw new Error(agent.reason?.message ?? `agent "${input.agentRef}" is not selectable`)
    }
    const model = agent.model ?? (await this.getDefaultModel())
    const available =
      model !== undefined &&
      (await this.ctx.model.list()).data.some(
        (candidate) => candidate.providerID === model.providerID && candidate.id === model.id,
      )
    const session = await this.ctx.session.create({
      ...(input.parent === undefined ? {} : { parentID: input.parent as never }),
      agent: Agent.ID.make(input.agentRef),
      title: input.title,
      metadata: input.metadata,
      // Leave unavailable models unset so OpenCode can use its normal model fallback.
      ...(available && model !== undefined ? { model } : {}),
    })
    return { ref: session.id }
  }

  async submit(input: {
    session: SessionRef
    submission: string
    text: string
    metadata?: Record<string, string>
  }): Promise<void> {
    await this.ctx.session.prompt({
      sessionID: input.session as never,
      id: input.submission as never,
      text: input.text,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
  }

  async inspect(sessionID: SessionRef): Promise<ExecutionSnapshot> {
    const session = await this.ctx.session.get({ sessionID: sessionID as never })
    const idle = session.time.idle === undefined ? undefined : epoch(session.time.idle)
    const state =
      idle === undefined
        ? "running"
        : session.outcome === "succeeded"
          ? "succeeded"
          : session.outcome === "failed"
            ? "failed"
            : session.outcome === "interrupted"
              ? "interrupted"
              : "unknown"

    const snapshot: ExecutionSnapshot = {
      sessionRef: sessionID,
      state,
      usage: usageFromSession(session),
      ...(idle === undefined ? {} : { finishedAt: idle }),
    }
    if (idle === undefined) return snapshot

    const messages = await this.ctx.session.context({ sessionID: sessionID as never }).catch(() => [])
    const normalized = (messages as unknown as SessionMessage[]).map((message) => ({
      ...message,
      time: { ...message.time, created: epoch(message.time?.created) },
    }))
    const error = session.outcome === "failed" ? latestIdle(normalized)?.error : undefined
    return {
      ...snapshot,
      audit: auditFromMessages(normalized),
      ...(error === undefined ? {} : { error: { message: error.message, type: error.type } }),
    }
  }

  async pendingPermissions(sessionID: SessionRef): Promise<PendingPermissions> {
    try {
      const requests = await this.ctx.permission.list({ sessionID: sessionID as never })
      const items = requests.map((request) => ({
        requestID: request.id,
        action: request.action,
        resources: request.resources,
        ...(request.message === undefined ? {} : { message: request.message }),
      }))
      return items.length === 0 ? { state: "none" } : { state: "pending", items }
    } catch {
      return { state: "unknown" }
    }
  }

  async cancel(sessionID: SessionRef): Promise<boolean> {
    const result = await this.ctx.session.interrupt({ sessionID: sessionID as never, resume: false })
    return result.interrupted
  }

  async submissionState(sessionID: SessionRef, submission: string): Promise<SubmissionState> {
    const messages = await this.ctx.session.context({ sessionID: sessionID as never }).catch(() => undefined)
    if (messages === undefined) return "unknown"
    if (messages.some((message) => message.type === "user" && message.id === submission)) return "admitted"
    return messages.length === 0 ? "not_admitted" : "unknown"
  }

  completionInstruction(): string {
    return [
      "When you are finished, call the `flowgraph_report` tool exactly once with:",
      "   {",
      '     "outcome": "<outcome>",',
      '     "summary": "<concise summary of what you did or found>",',
      '     "feedback": "<actionable feedback for the next node, or empty>",',
      '     "evidence": [{ "kind": "file|command|url|note", "value": "<short reference>" }]',
      "   }",
    ].join("\n")
  }

}


