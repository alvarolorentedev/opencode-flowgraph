import { describe, expect, it } from "vitest"
import { OpenCodeAdapter, type OpenCodePluginContext } from "../../../src/adapters/opencode/runtime.js"

type Calls = {
  create?: Record<string, unknown>
  prompt?: Record<string, unknown>
  interrupt?: Record<string, unknown>
}

function context(options: {
  defaultModel?: { providerID: string; id: string } | undefined
  session?: Record<string, unknown>
  messages?: unknown[]
  permissions?: unknown[]
  calls?: Calls
  options?: Record<string, unknown>
} = {}): OpenCodePluginContext {
  const calls = options.calls ?? {}
  return {
    app: { version: "2.2.5" },
    options: options.options ?? {},
    agent: {
      list: async () => ({
        data: [
          { id: "primary", name: "Primary", mode: "primary", hidden: false },
          { id: "hidden", name: "Hidden", mode: "primary", hidden: true },
          { id: "sub", name: "Sub", mode: "subagent", hidden: false },
          { id: "modeled", name: "Modeled", mode: "all", hidden: false, model: { providerID: "test", id: "model" } },
        ],
      }),
    },
    model: {
      default: async () => options.defaultModel,
      list: async () => ({ data: [{ providerID: "test", id: "model" }] }),
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        calls.create = input
        return { id: "sess_node_1" }
      },
      prompt: async (input: Record<string, unknown>) => {
        calls.prompt = input
        return { id: String(input.id) }
      },
      interrupt: async (input: Record<string, unknown>) => {
        calls.interrupt = input
        return { interrupted: true }
      },
      get: async () => options.session ?? {
        id: "sess_1",
        time: { created: 1, updated: 2, idle: 3 },
        outcome: "succeeded",
        cost: 0.5,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
      },
      context: async () => options.messages ?? [],
    },
    permission: {
      list: async () => options.permissions ?? [],
    },
  } as unknown as OpenCodePluginContext
}

describe("OpenCodeAdapter", () => {
  it("reports background work as blocked unless the option opts out", () => {
    expect(new OpenCodeAdapter(context()).capabilities.security.backgroundWork).toBe("blocked")
    expect(
      new OpenCodeAdapter(context({ options: { allowBackgroundWork: true } })).capabilities.security.backgroundWork,
    ).toBe("unobservable")
  })

  it("reports protected paths as best-effort, not a full interception guarantee", () => {
    const capabilities = new OpenCodeAdapter(context()).capabilities
    expect(capabilities.security.protectedPaths).toBe("best_effort")
    expect(capabilities.security.nativePermissions).toBe(true)
  })

  it("maps native agents to selectable descriptors", async () => {
    const adapter = new OpenCodeAdapter(context({ defaultModel: { providerID: "test", id: "model" } }))
    const agents = await adapter.listAgents()
    expect(agents.find((agent) => agent.id === "primary")).toMatchObject({ selectable: true, mode: "primary" })
    expect(agents.find((agent) => agent.id === "hidden")).toMatchObject({
      selectable: false,
      reason: { code: "hidden_agent" },
    })
    expect(agents.find((agent) => agent.id === "sub")).toMatchObject({
      selectable: false,
      reason: { code: "subagent_agent_not_selectable" },
    })
    expect(agents.find((agent) => agent.id === "modeled")).toMatchObject({
      selectable: true,
      model: { providerID: "test", id: "model" },
    })
  })

  it("rejects an agent with no model when there is no default", async () => {
    const adapter = new OpenCodeAdapter(context({ defaultModel: undefined }))
    const agents = await adapter.listAgents()
    expect(agents.find((agent) => agent.id === "primary")).toMatchObject({
      selectable: false,
      reason: { code: "agent_missing_model" },
    })
  })

  it("creates, submits, inspects, and cancels native work", async () => {
    const calls: Calls = {}
    const adapter = new OpenCodeAdapter(context({
      defaultModel: { providerID: "test", id: "model" },
      calls,
      messages: [
        { id: "msg_1", type: "user", time: { created: 1 } },
        {
          id: "msg_2",
          type: "assistant",
          time: { created: 2 },
          content: [{ type: "tool", name: "edit", executed: true, state: { status: "completed" } }],
        },
      ],
    }))

    const scope = await adapter.createRunScope!({ title: "run", metadata: { runID: "run_1" } })
    expect(scope.ref).toBe("sess_node_1")
    const session = await adapter.createSession({
      parent: scope.ref,
      agentRef: "primary",
      title: "node",
      metadata: {},
    })
    expect(session.ref).toBe("sess_node_1")
    expect(calls.create).toMatchObject({
      parentID: "sess_node_1",
      title: "node",
      model: { providerID: "test", id: "model" },
    })

    await adapter.submit({ session: session.ref, submission: "msg_1", text: "do it" })
    expect(calls.prompt).toMatchObject({ sessionID: "sess_node_1", id: "msg_1", text: "do it" })

    const snapshot = await adapter.inspect(session.ref)
    expect(snapshot).toMatchObject({
      state: "succeeded",
      finishedAt: 3,
      usage: { input: 10, output: 20, costUSD: 0.5 },
      audit: { mutatingToolCalls: 1 },
    })
    expect(snapshot.audit?.toolCalls[0]).toMatchObject({ name: "edit", mutating: true })

    expect(await adapter.pendingPermissions(session.ref)).toEqual({ state: "none" })
    expect(await adapter.submissionState!(session.ref, "msg_1")).toBe("admitted")
    expect(await adapter.cancel(session.ref)).toBe(true)
    expect(calls.interrupt).toMatchObject({ sessionID: "sess_node_1", resume: false })
  })

  it("maps pending permissions and returns unknown when the permission query fails", async () => {
    const adapter = new OpenCodeAdapter(context({
      defaultModel: { providerID: "test", id: "model" },
      permissions: [{ id: "perm_1", action: "shell", resources: ["git status"] }],
    }))
    expect(await adapter.pendingPermissions("sess_1")).toEqual({
      state: "pending",
      items: [{ requestID: "perm_1", action: "shell", resources: ["git status"] }],
    })

    const failing = new OpenCodeAdapter({
      ...context({ defaultModel: { providerID: "test", id: "model" } }),
      permission: { list: async () => { throw new Error("unavailable") } },
    } as unknown as OpenCodePluginContext)
    expect(await failing.pendingPermissions("sess_1")).toEqual({ state: "unknown" })
  })
})
