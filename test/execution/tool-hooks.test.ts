import { describe, expect, it } from "vitest"
import { registerToolHooks } from "../../src/execution/tool-hooks.js"
import { createInvocationRegistry } from "../../src/execution/report-tool.js"

type Hook = (event: {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
}) => void

async function setup(protectedPaths: string[] = []) {
  let hook: Hook | undefined
  const ctx = {
    location: { project: { directory: "/project" } },
    tool: {
      hook: async (_name: string, callback: Hook) => {
        hook = callback
        return () => undefined
      },
    },
  } as never
  const invocations = createInvocationRegistry()
  invocations.register({
    runID: "run_1",
    projectID: "project_1",
    stepID: "step_1",
    sessionID: "session_1",
    nodeID: "developer",
    allowedOutcomes: [],
    attempt: 1,
    reported: 0,
  })
  await registerToolHooks(ctx, invocations, { allowBackgroundWork: false, protectedPaths })
  if (!hook) throw new Error("hook was not registered")
  return hook
}

function event(tool: string, input: unknown, sessionID = "session_1") {
  return { tool, sessionID, agent: "developer", messageID: "message_1", id: "call_1", input }
}

describe("workflow tool hooks", () => {
  it("blocks edits to OpenCode configuration", async () => {
    const hook = await setup()
    expect(() => hook(event("edit", { path: ".opencode/agents/po.md", oldString: "a", newString: "b" }))).toThrow(
      /protected configuration path "\.opencode"/,
    )
    expect(() => hook(event("write", { path: "opencode.json", content: "{}" }))).toThrow(/protected configuration path/)
  })

  it("blocks patches that delete a workflow", async () => {
    const hook = await setup()
    expect(() =>
      hook(
        event("patch", {
          patchText: "*** Begin Patch\n*** Delete File: .opencode/workflows/product-delivery.yaml\n*** End Patch",
        }),
      ),
    ).toThrow(/protected configuration path "\.opencode"/)
  })

  it("blocks destructive shell commands against configuration", async () => {
    const hook = await setup()
    expect(() => hook(event("shell", { command: "rm -rf .opencode" }))).toThrow(/protected configuration path "\.opencode"/)
    expect(() => hook(event("shell", { command: "git clean -fd" }))).toThrow(/protected configuration path/)
    expect(() => hook(event("shell", { command: "echo x > opencode.json" }))).toThrow(/protected configuration path "opencode\.json"/)
  })

  it("allows normal edits and read-only access", async () => {
    const hook = await setup()
    expect(() => hook(event("edit", { path: "src/app.ts", oldString: "a", newString: "b" }))).not.toThrow()
    expect(() => hook(event("shell", { command: "cat .opencode/workflows/product-delivery.yaml" }))).not.toThrow()
    expect(() => hook(event("shell", { command: "git status" }))).not.toThrow()
  })

  it("ignores non-workflow sessions", async () => {
    const hook = await setup()
    expect(() => hook(event("edit", { path: ".opencode/agents/po.md" }, "other_session"))).not.toThrow()
  })

  it("accepts extra protected paths", async () => {
    const hook = await setup(["infra"])
    expect(() => hook(event("write", { path: "infra/main.tf", content: "" }))).toThrow(
      /protected configuration path "infra"/,
    )
  })
})
