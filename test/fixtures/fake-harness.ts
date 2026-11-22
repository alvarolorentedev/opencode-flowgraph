import type {
  ExecutionSnapshot,
  HarnessAdapter,
  HarnessCapabilities,
  PendingPermissions,
  SessionRef,
  SubmissionState,
} from "../../src/execution/harness.js"
import type { ReportIntake } from "../../src/execution/report-intake.js"
import type { AgentDescriptor } from "../../src/workflow/validator.js"
import type { NodeResult } from "../../src/workflow/schema.js"
import type { PermissionSummary, UsageEstimate } from "../../src/state/types.js"
import { zeroUsage } from "../../src/execution/results.js"

export type Behavior = {
  report?: NodeResult
  outcome?: "succeeded" | "failed" | "interrupted"
  pendingPermission?: boolean
  delayMs?: number
  /** Finish the session without a terminal outcome. */
  unknownTerminal?: boolean
}

export type PromptLog = {
  sessionID: string
  agent: string
  nodeID: string
  stepID: string
  text: string
}

export type FakeHarnessOptions = {
  id?: string
  displayName?: string
  version?: string
  runScope?: boolean
  adoptLegacyRuns?: boolean
  admission?: "confirmed" | "ambiguous"
  permissions?: "none" | "pending" | "unknown"
  permissionSurvivesRestart?: boolean
  resultsMechanism?: HarnessCapabilities["results"]["mechanism"]
  corrections?: boolean
  usage?: UsageEstimate
  security?: Partial<HarnessCapabilities["security"]>
}

type SessionState = {
  id: string
  parentID?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  outcome?: "succeeded" | "failed" | "interrupted"
  idle?: number
  created: number
  updated: number
  messages: { id: string; type: string; time: { created: number }; outcome?: "succeeded" | "failed" | "interrupted" }[]
  timer?: ReturnType<typeof setTimeout>
  behavior?: Behavior
  metadata?: Record<string, string>
}

export class FakeHarness implements HarnessAdapter {
  readonly agents: AgentDescriptor[] = [
    { id: "developer", name: "Developer", selectable: true, mode: "primary", hidden: false },
    { id: "reviewer", name: "Reviewer", selectable: true, mode: "all", hidden: false },
    {
      id: "opus-reviewer",
      name: "Opus Reviewer",
      selectable: true,
      mode: "all",
      hidden: false,
      model: { providerID: "anthropic", id: "claude-opus-4" },
    },
  ]

  readonly capabilities: HarnessCapabilities
  readonly prompts: PromptLog[] = []
  readonly sessions = new Map<string, SessionState>()
  private readonly permissions = new Map<string, PermissionSummary[]>()
  private counter = 0
  private now = 10_000

  constructor(
    private readonly intake: ReportIntake,
    private readonly scenario: (input: PromptLog, callIndex: number) => Behavior,
    private readonly options: FakeHarnessOptions = {},
  ) {
    this.capabilities = {
      id: options.id ?? "fake",
      displayName: options.displayName ?? "Fake Harness",
      ...(options.version === undefined ? {} : { version: options.version }),
      agents: { discovery: "configured" },
      sessions: {
        runScope: options.runScope ?? true,
        adoptLegacyRuns: options.adoptLegacyRuns ?? true,
      },
      results: {
        mechanism: options.resultsMechanism ?? "native_tool",
        corrections: options.corrections ?? true,
      },
      permissions: {
        survivesRestart: options.permissionSurvivesRestart ?? false,
        approval: "host",
      },
      security: {
        nativePermissions: true,
        protectedPaths: "none",
        backgroundWork: "unobservable",
        ...options.security,
      },
      usage: { tokens: true, cost: true },
      audit: true,
    }
  }

  private tick() {
    this.now += 1
    return this.now
  }

  async listAgents() {
    return this.agents
  }

  async resolveAgent(agentID: string) {
    return this.agents.find((agent) => agent.id === agentID)
  }

  async createRunScope(_input: { title: string; metadata: Record<string, string> }) {
    const id = `sess_run_${++this.counter}`
    this.sessions.set(id, { id, created: this.tick(), updated: this.now, messages: [] })
    return { ref: id }
  }

  async createSession(input: {
    agentRef: string
    title: string
    metadata: Record<string, string>
    parent?: string
  }) {
    const id = `sess_node_${++this.counter}`
    const agent = this.agents.find((candidate) => candidate.id === input.agentRef)
    const model = agent?.model ?? { providerID: "test", id: "model" }
    this.sessions.set(id, {
      id,
      ...(input.parent === undefined ? {} : { parentID: input.parent }),
      agent: input.agentRef,
      model,
      created: this.tick(),
      updated: this.now,
      messages: [],
    })
    return { ref: id }
  }

  async submit(input: {
    session: string
    submission: string
    text: string
    metadata?: Record<string, string>
  }) {
    const session = this.sessions.get(input.session)
    if (!session) throw new Error("session not found")
    const log: PromptLog = {
      sessionID: input.session,
      agent: session.agent ?? "unknown",
      nodeID: input.metadata?.nodeID ?? "unknown",
      stepID: input.metadata?.stepID ?? "unknown",
      text: input.text,
    }
    this.prompts.push(log)
    session.messages.push({ id: input.submission, type: "user", time: { created: this.tick() } })
    const callIndex = this.prompts.filter((item) => item.nodeID === log.nodeID).length
    const behavior = this.scenario(log, callIndex)
    session.behavior = behavior
    session.metadata = input.metadata
    session.updated = this.now

    if (behavior.pendingPermission === true || this.options.permissions === "pending") {
      this.permissions.set(input.session, [
        { requestID: `perm_${this.counter}`, action: "shell", resources: ["git status"] },
      ])
      return
    }

    const delay = behavior.delayMs ?? 0
    if (delay === 0) void this.finish(input.session, input.metadata ?? {})
    else session.timer = setTimeout(() => void this.finish(input.session, input.metadata ?? {}), delay)
  }

  private async finish(sessionID: string, metadata: Record<string, string>) {
    const session = this.sessions.get(sessionID)
    if (!session) return
    clearTimeout(session.timer)
    const meta = { ...(session.metadata ?? {}), ...metadata }
    const behavior = session.behavior ?? {}
    const outcome = behavior.outcome ?? "succeeded"

    if (behavior.report) {
      try {
        await this.intake.submit({
          session: sessionID,
          messageRef: session.messages[0]?.id ?? "msg",
          toolCallRef: `call_${this.tick()}`,
          result: behavior.report,
          reportedAt: this.now,
        })
      } catch {
        // Simulate a harness whose report did not reach the intake.
      }
    }

    session.outcome = behavior.unknownTerminal ? undefined : outcome
    session.idle = this.tick()
    session.updated = this.now
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
    void this.finish(sessionID, session?.metadata ?? {})
  }

  async inspect(sessionID: SessionRef): Promise<ExecutionSnapshot> {
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error("session not found")
    const state =
      session.idle === undefined
        ? "running"
        : session.outcome === "succeeded"
          ? "succeeded"
          : session.outcome === "failed"
            ? "failed"
            : session.outcome === "interrupted"
              ? "interrupted"
              : "unknown"
    return {
      sessionRef: sessionID,
      state,
      ...(session.idle === undefined ? {} : { finishedAt: session.idle }),
      usage: this.options.usage ?? { ...zeroUsage(), costUSD: 0.01, input: 10, output: 5 },
      audit: { toolCalls: [], mutatingToolCalls: 0 },
    }
  }

  async pendingPermissions(sessionID: SessionRef): Promise<PendingPermissions> {
    if (this.options.permissions === "unknown") return { state: "unknown" }
    const items = this.permissions.get(sessionID) ?? []
    return items.length === 0 ? { state: "none" } : { state: "pending", items }
  }

  async cancel(sessionID: SessionRef): Promise<boolean> {
    const session = this.sessions.get(sessionID)
    if (!session || session.idle !== undefined) return false
    clearTimeout(session.timer)
    session.outcome = "interrupted"
    session.idle = this.tick()
    this.permissions.delete(sessionID)
    session.messages.push({
      id: `msg_idle_${this.counter}`,
      type: "idle",
      time: { created: session.idle },
      outcome: "interrupted",
    })
    return true
  }

  async submissionState(_sessionID: SessionRef, _submission: string): Promise<SubmissionState> {
    if (this.options.admission === "ambiguous") return "unknown"
    const session = this.sessions.get(_sessionID)
    if (!session) return "unknown"
    if (session.messages.some((message) => message.type === "user" && message.id === _submission)) return "admitted"
    return session.messages.length === 0 ? "not_admitted" : "unknown"
  }

  completionInstruction(): string {
    return "Call the `flowgraph_report` tool exactly once."
  }

  async getSession(sessionID: string) {
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

  async getContext(sessionID: string) {
    return this.sessions.get(sessionID)?.messages ?? []
  }
}
