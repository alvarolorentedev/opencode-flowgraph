import { describe, expect, it } from "vitest"
import { registerToolHooks } from "../../src/adapters/opencode/tool-hooks.js"
import { createInvocationRegistry } from "../../src/execution/report-intake.js"

type Hook = (event: {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
}) => void

async function setup(protectedPaths: string[] = [], allowBackgroundWork = false) {
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
  await registerToolHooks(ctx, invocations, { allowBackgroundWork, protectedPaths })
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

  it("blocks every known file tool on an add, update, delete, or move", async () => {
    const hook = await setup()
    for (const tool of ["edit", "write"]) {
      expect(() => hook(event(tool, { path: ".opencode/agents/po.md" }))).toThrow(/protected configuration path/)
    }
    for (const patchText of [
      "*** Begin Patch\n*** Add File: .opencode/agents/new.md\n*** End Patch",
      "*** Begin Patch\n*** Update File: opencode.json\n*** End Patch",
      "*** Begin Patch\n*** Delete File: .opencode/workflows/development.yaml\n*** End Patch",
      "*** Begin Patch\n*** Update File: src/app.ts\n*** Move to: AGENTS.md\n*** End Patch",
    ]) {
      expect(() => hook(event("patch", { patchText }))).toThrow(/protected configuration path/)
    }
  })

  it("normalizes relative, absolute, and traversal paths before matching", async () => {
    const hook = await setup()
    expect(() => hook(event("write", { path: "/project/.opencode/agents/po.md", content: "" }))).toThrow(
      /protected configuration path "\.opencode"/,
    )
    expect(() => hook(event("write", { path: "./.github/workflows/release.yml", content: "" }))).toThrow(
      /protected configuration path "\.github"/,
    )
    expect(() => hook(event("write", { path: "src/../opencode.jsonc", content: "" }))).toThrow(
      /protected configuration path "opencode\.jsonc"/,
    )
    expect(() => hook(event("write", { path: "../outside/opencode.json", content: "" }))).not.toThrow()
    expect(() => hook(event("write", { path: "/tmp/opencode.json", content: "" }))).not.toThrow()
  })

  it("blocks destructive shell commands against configuration", async () => {
    const hook = await setup()
    for (const command of [
      "rm -rf .opencode",
      "rmdir .opencode",
      "mv build .opencode/agents",
      "cp secret opencode.json",
      "install -m 644 x .github/workflows/x.yml",
      "truncate -s 0 AGENTS.md",
      "shred -u .git/config",
      "echo x | tee .opencode/workflows/x.yaml",
      "sed -i s/reviewer/review/ .opencode/agents/po.md",
      "perl -i -pe s/a/b/ opencode.json",
      "find .opencode -delete",
      "git rm -r .opencode/workflows",
      "git clean -fd",
      "git reset --hard .opencode",
      "git restore .github",
      "git checkout -- .opencode/agents",
      "echo x > opencode.json",
      "echo x >> AGENTS.md",
    ]) {
      expect(() => hook(event("shell", { command })), command).toThrow(/protected configuration path/)
    }
  })

  it("blocks a mutation from a protected working directory", async () => {
    const hook = await setup()
    expect(() => hook(event("shell", { command: "rm -rf build", workdir: ".opencode" }))).toThrow(
      /protected configuration path "\.opencode"/,
    )
    expect(() => hook(event("shell", { command: "rm -rf build", workdir: "/project/.git" }))).toThrow(
      /protected configuration path "\.git"/,
    )
    expect(() => hook(event("shell", { command: "rm -rf build", workdir: "src" }))).not.toThrow()
  })

  it("allows normal edits and read-only access", async () => {
    const hook = await setup()
    expect(() => hook(event("edit", { path: "src/app.ts", oldString: "a", newString: "b" }))).not.toThrow()
    expect(() => hook(event("shell", { command: "cat .opencode/workflows/product-delivery.yaml" }))).not.toThrow()
    expect(() => hook(event("shell", { command: "git status" }))).not.toThrow()
  })

  it("blocks background execution unless allowBackgroundWork opts out", async () => {
    const hook = await setup()
    expect(() => hook(event("shell", { command: "sleep 1", background: true }))).toThrow(/background shell execution is disabled/)
    expect(() => hook(event("subagent", { background: true }))).toThrow(/background subagent execution is disabled/)

    const optedOut = await setup([], true)
    expect(() => optedOut(event("shell", { command: "sleep 1", background: true }))).not.toThrow()
  })

  // Heuristic only: these commands can modify protected paths, but the guard does not
  // parse interpreters. Native permissions remain the security boundary.
  it("does not classify interpreter commands or symlink targets", async () => {
    const hook = await setup()
    expect(() =>
      hook(event("shell", { command: "python -c \"open('.opencode/agents/po.md','w').write('x')\"" })),
    ).not.toThrow()
    expect(() =>
      hook(event("shell", { command: "node -e \"require('fs').rmSync('.git',{recursive:true})\"" })),
    ).not.toThrow()
    expect(() => hook(event("shell", { command: 'bash -c "rm -rf .opencode"' }))).not.toThrow()
    expect(() => hook(event("write", { path: "config-link/agents/po.md", content: "" }))).not.toThrow()
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
