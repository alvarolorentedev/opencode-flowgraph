import type {
  NativeRuntime,
  SessionMessage,
  SessionSnapshot,
} from "../../src/execution/native-agents.js"
import type { PermissionSummary, ReportRecord } from "../../src/state/types.js"
import type { NodeResult } from "../../src/workflow/schema.js"
import type { AgentDescriptor } from "../../src/workflow/validator.js"
import type { WorkflowStore } from "../../src/state/store.js"

export type Behavior = {
  report?: NodeResult
  outcome?: "succeeded" | "failed" | "interrupted"
  pendingPermission?: boolean
  delayMs?: number
}

export type PromptLog = {
  sessionID: string
  agent: string
  nodeID: string
  stepID: string
  text: string
}

type SessionState = {
  id: string
  parentID?: string
  agent?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  idle?: number
  created: number
  updated: number
  messages: SessionMessage[]
  behavior?: Behavior
  metadata?: Record<string, string>
}

export class FakeNative implements NativeRuntime {
  readonly agents: AgentDescriptor[] = [
    { id: "developer", name: "Developer", mode: "primary", hidden: false },
    { id: "reviewer", name: "Reviewer", mode: "all", hidden: false },
  ]
  readonly prompts: PromptLog[] = []
  readonly sessions = new Map<string, SessionState>()
  private readonly permissions = new Map<string, PermissionSummary[]>()
  private counter = 0
  private now = 10_000

  constructor(
    private readonly store: WorkflowStore,
    private readonly projectID: string,
    private readonly scenario: (input: PromptLog, callIndex: number) => Behavior,
  ) {}

  private tick() {
    this.now += 1
    return this.now
  }

  async listAgents() {
    return this.agents
  }

  async getAgent(agentID: string) {
    return this.agents.find((agent) => agent.id === agentID)
  }

  async getDefaultModel() {
    return { providerID: "test", id: "model" }
  }

  async createRootSession(_input: { title: string; metadata: Record<string, string> }) {
    const id = `sess_run_${++this.counter}`
    this.sessions.set(id, { id, created: this.tick(), updated: this.now, messages: [] })
    return { id }
  }

  async createSession(input: { parentID: string; agent: string; title: string; metadata: Record<string, string> }) {
    const id = `sess_node_${++this.counter}`
    this.sessions.set(id, {
      id,
      parentID: input.parentID,
      agent: input.agent,
      created: this.tick(),
      updated: this.now,
      messages: [],
    })
    return { id }
  }

  async prompt(input: { sessionID: string; messageID: string; text: string; metadata?: Record<string, string> }) {
    const session = this.sessions.get(input.sessionID)
    if (!session) throw new Error("session not found")
    const log: PromptLog = {
      sessionID: input.sessionID,
      agent: session.agent ?? "unknown",
      nodeID: input.metadata?.nodeID ?? "unknown",
      stepID: input.metadata?.stepID ?? "unknown",
      text: input.text,
    }
    this.prompts.push(log)
    session.messages.push({ id: input.messageID, type: "user", time: { created: this.tick() } })
    const callIndex = this.prompts.filter((item) => item.nodeID === log.nodeID).length
    const behavior = this.scenario(log, callIndex)
    session.behavior = behavior
    session.metadata = input.metadata
    session.updated = this.now
    if (behavior.pendingPermission) {
      this.permissions.set(input.sessionID, [
        { requestID: `perm_${this.counter}`, action: "shell", resources: ["git status"] },
      ])
      return { id: input.messageID }
    }
    const delay = behavior.delayMs ?? 0
    if (delay === 0) this.finish(input.sessionID, input.metadata ?? {})
    else setTimeout(() => this.finish(input.sessionID, input.metadata ?? {}), delay)
    return { id: input.messageID }
  }

  private finish(sessionID: string, metadata: Record<string, string>) {
    const session = this.sessions.get(sessionID)
    if (!session) return
    const meta = { ...(session.metadata ?? {}), ...metadata }
    const behavior = session.behavior ?? {}
    const outcome = behavior.outcome ?? "succeeded"
    session.outcome = outcome
    session.idle = this.tick()
    session.updated = this.now
    if (behavior.report) {
      const report: ReportRecord = {
        schemaVersion: 1,
        runID: meta.runID ?? "run",
        stepID: meta.stepID ?? "step",
        sessionID,
        messageID: session.messages[0]?.id ?? "msg",
        toolCallID: `call_${this.counter}`,
        result: behavior.report,
        reportedAt: this.now,
        attempt: 1,
      }
      void this.store.putReport(this.projectID, report)
    }
    session.messages.push({
      id: `msg_idle_${this.counter}`,
      type: "idle",
      time: { created: session.idle },
      outcome,
    })
  }

  release(sessionID: string) {
    this.permissions.delete(sessionID)
    const session = this.sessions.get(sessionID)
    this.finish(sessionID, session?.metadata ?? {})
  }

  async wait() {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  async interrupt(sessionID: string) {
    const session = this.sessions.get(sessionID)
    if (!session) return false
    session.outcome = "interrupted"
    session.idle = this.tick()
    this.permissions.delete(sessionID)
    session.messages.push({ id: `msg_idle_${this.counter}`, type: "idle", time: { created: session.idle }, outcome: "interrupted" })
    return true
  }

  async getSession(sessionID: string): Promise<SessionSnapshot> {
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error("session not found")
    return {
      id: session.id,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
      ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
      time: {
        created: session.created,
        updated: session.updated,
        ...(session.idle === undefined ? {} : { idle: session.idle }),
      },
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  }

  async getContext(sessionID: string): Promise<SessionMessage[]> {
    return this.sessions.get(sessionID)?.messages ?? []
  }

  async listPermissions(sessionID: string): Promise<PermissionSummary[]> {
    return this.permissions.get(sessionID) ?? []
  }
}
