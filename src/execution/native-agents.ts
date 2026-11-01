import { Agent, Plugin } from "@opencode/plugin"
import type { PermissionSummary } from "../state/types.js"
import type { AgentDescriptor } from "../workflow/validator.js"

export type OpenCodePluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export type SessionSnapshot = {
  id: string
  parentID?: string
  agent?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  time: {
    created: number
    updated: number
    idle?: number
  }
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type SessionContentPart = {
  type: string
  text?: string
  name?: string
  executed?: boolean
  state?: { status?: "streaming" | "running" | "completed" | "error" }
}

export type SessionMessage = {
  id: string
  type: string
  time: { created: number }
  outcome?: "succeeded" | "failed" | "interrupted"
  error?: { type: string; message: string }
  agent?: string
  content?: SessionContentPart[]
}

export interface NativeRuntime {
  listAgents(): Promise<AgentDescriptor[]>
  getAgent(agentID: string): Promise<AgentDescriptor | undefined>
  getDefaultModel(): Promise<{ providerID: string; id: string } | undefined>
  createRootSession(input: { title: string; metadata: Record<string, string> }): Promise<{ id: string }>
  createSession(input: {
    parentID: string
    agent: string
    title: string
    metadata: Record<string, string>
  }): Promise<{ id: string }>
  prompt(input: {
    sessionID: string
    messageID: string
    text: string
    metadata?: Record<string, string>
  }): Promise<{ id: string }>
  wait(sessionID: string, signal: AbortSignal): Promise<void>
  interrupt(sessionID: string): Promise<boolean>
  getSession(sessionID: string): Promise<SessionSnapshot>
  getContext(sessionID: string): Promise<SessionMessage[]>
  listPermissions(sessionID: string): Promise<PermissionSummary[]>
}

function epoch(value: unknown): number {
  if (typeof value === "number") return value
  if (value && typeof value === "object" && "epochMilliseconds" in value) {
    const millis = (value as { epochMilliseconds: unknown }).epochMilliseconds
    if (typeof millis === "number") return millis
  }
  return 0
}

function descriptor(agent: { id: string; name: string; mode: "subagent" | "primary" | "all"; hidden: boolean; model?: { providerID: string; id: string; variant?: string }; description?: string }): AgentDescriptor {
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.description === undefined ? {} : { description: agent.description }),
  }
}

export class OpenCodeNativeRuntime implements NativeRuntime {
  constructor(private readonly ctx: OpenCodePluginContext) {}

  async listAgents(): Promise<AgentDescriptor[]> {
    const result = await this.ctx.agent.list()
    return result.data.map(descriptor)
  }

  async getAgent(agentID: string): Promise<AgentDescriptor | undefined> {
    const result = await this.ctx.agent.list()
    const found = result.data.find((agent) => agent.id === agentID)
    return found ? descriptor(found) : undefined
  }

  async getDefaultModel(): Promise<{ providerID: string; id: string } | undefined> {
    const model = (await this.ctx.model.default()) as unknown
    if (!model || typeof model !== "object") return undefined
    const record = model as { providerID?: unknown; id?: unknown; modelID?: unknown }
    const id = typeof record.id === "string" ? record.id : typeof record.modelID === "string" ? record.modelID : undefined
    if (typeof record.providerID !== "string" || id === undefined) return undefined
    return { providerID: record.providerID, id }
  }

  async createRootSession(input: { title: string; metadata: Record<string, string> }): Promise<{ id: string }> {
    const session = await this.ctx.session.create({
      title: input.title,
      metadata: input.metadata,
    })
    return { id: session.id }
  }

  async createSession(input: {
    parentID: string
    agent: string
    title: string
    metadata: Record<string, string>
  }): Promise<{ id: string }> {
    const session = await this.ctx.session.create({
      parentID: input.parentID as never,
      agent: Agent.ID.make(input.agent),
      title: input.title,
      metadata: input.metadata,
    })
    return { id: session.id }
  }

  async prompt(input: {
    sessionID: string
    messageID: string
    text: string
    metadata?: Record<string, string>
  }): Promise<{ id: string }> {
    const admitted = await this.ctx.session.prompt({
      sessionID: input.sessionID as never,
      id: input.messageID as never,
      text: input.text,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
    return { id: admitted.id }
  }

  async wait(sessionID: string, signal: AbortSignal): Promise<void> {
    await this.ctx.session.wait({ sessionID: sessionID as never }, { signal })
  }

  async interrupt(sessionID: string): Promise<boolean> {
    const result = await this.ctx.session.interrupt({ sessionID: sessionID as never, resume: false })
    return result.interrupted
  }

  async getSession(sessionID: string): Promise<SessionSnapshot> {
    const session = await this.ctx.session.get({ sessionID: sessionID as never })
    return {
      id: session.id,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
      ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
      time: {
        created: epoch(session.time.created),
        updated: epoch(session.time.updated),
        ...(session.time.idle === undefined ? {} : { idle: epoch(session.time.idle) }),
      },
      cost: session.cost,
      tokens: {
        input: session.tokens.input,
        output: session.tokens.output,
        reasoning: session.tokens.reasoning,
        cache: { read: session.tokens.cache.read, write: session.tokens.cache.write },
      },
    }
  }

  async getContext(sessionID: string): Promise<SessionMessage[]> {
    const messages = await this.ctx.session.context({ sessionID: sessionID as never })
    return messages as unknown as SessionMessage[]
  }

  async listPermissions(sessionID: string): Promise<PermissionSummary[]> {
    const requests = await this.ctx.permission.list({ sessionID: sessionID as never })
    return requests.map((request) => ({
      requestID: request.id,
      action: request.action,
      resources: request.resources,
      ...(request.message === undefined ? {} : { message: request.message }),
    }))
  }
}
