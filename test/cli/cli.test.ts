import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { main, parseArgs } from "../../src/cli.js"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-cli-"))
  dirs.push(dir)
  return dir
}

function workflow(name: string, next = "complete"): string {
  return [
    "version: 1",
    `name: ${name}`,
    "entry: developer",
    "limits: { max_steps: 3 }",
    "nodes:",
    `  developer: { agent: developer, next: ${next} }`,
    "",
  ].join("\n")
}

async function writeWorkflow(project: string, relative: string, name: string, source = workflow(name)): Promise<void> {
  const root = path.join(project, relative)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, `${name}.yaml`), source)
}

type Capture = { io: { stdout: (text: string) => void; stderr: (text: string) => void; isTTY: boolean }; out: () => string; err: () => string }

function capture(): Capture {
  let out = ""
  let err = ""
  return {
    io: { stdout: (text) => { out += text }, stderr: (text) => { err += text }, isTTY: false },
    out: () => out,
    err: () => err,
  }
}

async function run(args: string[], cwd: string, extra: { abortSignal?: AbortSignal } = {}) {
  const captured = capture()
  const code = await main(args, {
    cwd,
    io: captured.io,
    handleSignals: false,
    ...(extra.abortSignal === undefined ? {} : { abortSignal: extra.abortSignal }),
  })
  return { code, out: captured.out(), err: captured.err() }
}

const ADAPTER_CAPABILITIES = `{
  id: "test-cli",
  displayName: "Test CLI Adapter",
  agents: { discovery: "configured" },
  sessions: { runScope: false, adoptLegacyRuns: true },
  results: { mechanism: "native_tool", corrections: false },
  permissions: { survivesRestart: false, approval: "none" },
  security: { nativePermissions: false, protectedPaths: "none", backgroundWork: "blocked" },
  usage: { tokens: false, cost: false },
  audit: false
}`

async function adapterModule(
  project: string,
  mode: "complete" | "hang" | "running" | "wrong" | "permission" | "orphaned" | "unknown" | "fork" = "complete",
): Promise<string> {
  const file = path.join(project, `adapter-${randomUUID()}.mjs`)
  const outcome = mode === "wrong" ? "bogus" : "done"
  const submit = mode === "hang" || mode === "running" || mode === "permission" || mode === "orphaned" || mode === "unknown" || mode === "fork"
    ? "void 0"
    : `setTimeout(async () => {
        try {
          await context.intake.submit({
            session,
            messageRef: "msg_" + session,
            toolCallRef: "call_" + session,
            result: { outcome: "${outcome}", summary: "ok", feedback: "", evidence: [] },
          })
          sessions.get(session).reported = true
        } catch (error) {
          sessions.get(session).error = String(error)
        }
      }, 5)`
  await fs.writeFile(file, `export async function createHarnessAdapter(context) {
  const agents = [{ id: "developer", name: "Developer", selectable: true, mode: "primary", hidden: false }, { id: "reviewer", name: "Reviewer", selectable: true, mode: "primary", hidden: false }]
  const sessions = new Map()
  let counter = 0
  return {
    capabilities: ${ADAPTER_CAPABILITIES},
    async listAgents() { return agents },
    async resolveAgent(id) { return agents.find((agent) => agent.id === id) },
    async createSession(input) {
      const ref = "sess_" + (++counter)
      sessions.set(ref, { reported: false, node: input.metadata?.nodeID })
      return { ref }
    },
    async submit({ session }) {
      ${submit}
    },
    async inspect(session) {
      ${mode === "running"
        ? 'return { sessionRef: session, state: "running" }'
        : mode === "fork"
        ? 'const node = sessions.get(session)?.node; return { sessionRef: session, state: node === "left" ? "unknown" : "running" }'
        : mode === "orphaned"
        ? 'return { sessionRef: session, state: "interrupted" }'
        : mode === "unknown"
          ? 'return { sessionRef: session, state: "unknown" }'
          : `const state = sessions.get(session)
      return { sessionRef: session, state: state.reported ? "succeeded" : state.error ? "failed" : "running" }`}
    },
    async pendingPermissions(session) {
      ${mode === "fork"
        ? 'const node = sessions.get(session)?.node; return node === "right" ? { state: "pending", items: [{ requestID: "perm_1", action: "shell", resources: ["git status"] }] } : { state: "none" }'
        : mode === "permission"
        ? 'return { state: "pending", items: [{ requestID: "perm_1", action: "shell", resources: ["git status"] }] }'
        : 'return { state: "none" }'}
    },
    async cancel() { return true }
  }
}
`)
  return file
}

describe("flowgraph CLI", () => {
  it("prints help and version", async () => {
    const cwd = await tempProject()
    const help = await run(["--help"], cwd)
    expect(help.code).toBe(0)
    expect(help.out).toContain("Usage: flowgraph")
    expect(help.out).toContain("respond <run-id> --outcome <outcome>")
    const version = await run(["--version"], cwd)
    expect(version.code).toBe(0)
    expect(version.out.trim()).toBe("1.0.1")
  })

  it("rejects unknown commands and options as usage errors", async () => {
    const cwd = await tempProject()
    expect((await run(["nope"], cwd)).code).toBe(2)
    expect((await run(["--nope"], cwd)).code).toBe(2)
    expect(() => parseArgs(["--json=yes"])).toThrow(/does not take a value/)
  })

  it("lists workflows with structural validation only", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const result = await run(["list"], project)
    expect(result.code).toBe(0)
    expect(result.out).toContain("Workflows (1) — .flowgraph/workflows")
    expect(result.out).toContain("- sample (structurally valid; agents unchecked)")
    expect(result.err).toBe("")
  })

  it("reports an empty workflow directory", async () => {
    const project = await tempProject()
    const result = await run(["list"], project)
    expect(result.code).toBe(0)
    expect(result.out).toBe("No workflows found in .flowgraph/workflows.\n")
  })

  it("validates structurally without claiming agent compatibility", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const result = await run(["validate", "sample"], project)
    expect(result.code).toBe(0)
    expect(result.out).toBe("Structurally valid; agent compatibility not checked (no execution adapter).\n")

    const json = await run(["--json", "validate", "sample"], project)
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out.trim())).toMatchObject({ valid: true, agentsChecked: false, errors: [], warnings: [] })
  })

  it("reports structural errors with a nonzero exit", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "broken", workflow("broken", "missing"))
    const result = await run(["validate", "broken"], project)
    expect(result.code).toBe(1)
    expect(result.out).toContain('Invalid workflow "broken":')
    expect(result.out).toContain("missing")
  })

  it("checks missing and recursive referenced workflows without an adapter", async () => {
    const missingProject = await tempProject()
    await writeWorkflow(missingProject, ".flowgraph/workflows", "parent", [
      "version: 1",
      "name: parent",
      "entry: start",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  start: { workflow: missing, routes: { complete: complete, pause: complete } }",
      "",
    ].join("\n"))
    const missing = await run(["validate", "parent"], missingProject)
    expect(missing.code).toBe(1)
    expect(missing.out).toContain("workflows.parent.nodes.start.workflow")
    expect(missing.out).toContain("workflow not found")
    const listed = await run(["list"], missingProject)
    expect(listed.out).toContain("- parent (invalid:")

    const recursiveProject = await tempProject()
    await writeWorkflow(recursiveProject, ".flowgraph/workflows", "parent", [
      "version: 1",
      "name: parent",
      "entry: check",
      "limits: { max_steps: 3 }",
      "nodes:",
      "  check: { workflow: child, routes: { complete: complete, pause: complete } }",
      "",
    ].join("\n"))
    await writeWorkflow(recursiveProject, ".flowgraph/workflows", "child", [
      "version: 1",
      "name: child",
      "entry: loop",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  loop: { workflow: parent, routes: { complete: complete, pause: complete } }",
      "",
    ].join("\n"))
    const recursive = await run(["validate", "parent"], recursiveProject)
    expect(recursive.code).toBe(1)
    expect(recursive.out).toContain('recursive workflow call to "parent"')
    const json = await run(["--json", "validate", "parent"], recursiveProject)
    expect(JSON.parse(json.out.trim())).toMatchObject({ valid: false, agentsChecked: false })
  })

  it("shows the workflow YAML", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const result = await run(["show", "sample"], project)
    expect(result.code).toBe(0)
    expect(result.out).toContain("name: sample")
    expect((await run(["show", "missing"], project)).code).toBe(1)
  })

  it("warns once about the legacy workflow directory", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".opencode/workflows", "legacy")
    const result = await run(["list"], project)
    expect(result.code).toBe(0)
    expect(result.err).toContain(".flowgraph/workflows not found; using legacy .opencode/workflows")
    expect(result.out).toContain("Workflows (1) — .opencode/workflows")
    expect(result.out).toContain("- legacy (structurally valid; agents unchecked)")
  })

  it("prefers the neutral directory and warns when both exist", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "shared")
    await writeWorkflow(project, ".opencode/workflows", "legacy-only")
    const result = await run(["list"], project)
    expect(result.code).toBe(0)
    expect(result.err).toContain("both dirs exist; using .flowgraph/workflows")
    expect(result.out).toContain("- shared")
    expect(result.out).not.toContain("legacy-only")
  })

  it("rejects an explicit workflow or state directory outside the project", async () => {
    const project = await tempProject()
    const workflow = await run(["--workflow-dir", "../outside", "list"], project)
    expect(workflow.code).toBe(2)
    expect(workflow.err).toContain("outside the project")
    const state = await run(["--state-dir", "../outside", "runs"], project)
    expect(state.code).toBe(2)
    expect(state.err).toContain("State directory resolves outside the project")
    const root = await run(["--state-dir", ".", "runs"], project)
    expect(root.code).toBe(2)
    expect(root.err).toContain("not the project root")
  })

  it("rejects state directories whose path components are symlinks outside the project", async () => {
    const project = await tempProject()
    const outside = await tempProject()

    await fs.symlink(outside, path.join(project, ".flowgraph"))
    const whole = await run(["runs"], project)
    expect(whole.code).toBe(2)
    expect(whole.err).toContain("State directory resolves outside the project")
    expect(await fs.readdir(outside)).toEqual([])

    await fs.unlink(path.join(project, ".flowgraph"))
    await fs.mkdir(path.join(project, ".flowgraph"))
    await fs.symlink(outside, path.join(project, ".flowgraph", "state"))
    const state = await run(["runs"], project)
    expect(state.code).toBe(2)
    expect(await fs.readdir(outside)).toEqual([])

    await fs.unlink(path.join(project, ".flowgraph", "state"))
    await fs.symlink(outside, path.join(project, "state-link"))
    const flag = await run(["--state-dir", "state-link", "runs"], project)
    expect(flag.code).toBe(2)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it("rejects dangling .flowgraph symlinks in the state path", async () => {
    const project = await tempProject()
    await fs.symlink(path.join(project, "no-such-target"), path.join(project, ".flowgraph"))
    const runs = await run(["runs"], project)
    expect(runs.code).toBe(2)
    expect(runs.err).toContain("dangling symlink")
    const listed = await run(["list"], project)
    expect(listed.code).toBe(2)
  })

  it("rejects workflow directories that reach outside the project through a symlink", async () => {
    const project = await tempProject()
    const outside = await tempProject()
    await writeWorkflow(outside, ".", "external")

    await fs.symlink(outside, path.join(project, "flows"))
    const explicit = await run(["--workflow-dir", "flows", "list"], project)
    expect(explicit.code).toBe(2)
    expect(explicit.err).toContain("outside the project")

    await fs.mkdir(path.join(project, ".flowgraph"))
    await fs.symlink(outside, path.join(project, ".flowgraph", "workflows"))
    const neutral = await run(["list"], project)
    expect(neutral.code).toBe(2)
    expect(neutral.out).not.toContain("external")
  })

  it("fails clearly when execution needs an adapter", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const result = await run(["run", "sample", "do it"], project)
    expect(result.code).toBe(3)
    expect(result.err).toContain("No execution adapter configured")
    expect(result.err).toContain("--adapter-module")
    expect(result.err).toContain("Inspection commands work without an adapter")

    const pause = await run(["pause", "run_unknown"], project)
    expect(pause.code).toBe(3)
  })

  it("emits JSON errors with stable codes", async () => {
    const project = await tempProject()
    const result = await run(["--json", "run", "sample", "do it"], project)
    expect(result.code).toBe(3)
    expect(JSON.parse(result.out.trim())).toMatchObject({ error: { code: "adapter" } })
  })

  it("rejects an invalid adapter module without executing it as a run", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const empty = path.join(project, "empty.mjs")
    await fs.writeFile(empty, "export const nope = 1\n")
    const result = await run(["--adapter-module", empty, "run", "sample", "do it"], project)
    expect(result.code).toBe(3)
    expect(result.err).toContain("Adapter module rejected")
    expect(result.err).toContain("createHarnessAdapter")
  })

  it("validates agent resolution when an adapter is supplied", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project)
    const result = await run(["--adapter-module", module, "validate", "sample"], project)
    expect(result.code).toBe(0)
    expect(result.out).toBe("Valid; agents resolved (1).\n")
  })

  it("runs a workflow in the foreground and persists inspectable state", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project)
    const result = await run(["--adapter-module", module, "run", "sample", "implement it"], project)
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/Run run_[^\s]+ started · sample · running/)
    expect(result.out).toMatch(/Run run_[^\s]+ completed\./)

    const runs = await run(["runs"], project)
    expect(runs.code).toBe(0)
    expect(runs.out).toContain("Runs (1):")
    expect(runs.out).toContain("sample · completed · [test-cli] · implement it")

    const runID = /Run (run_[^\s]+) started/u.exec(result.out)![1]!
    const graph = await run(["graph", runID], project)
    expect(graph.code).toBe(0)
    expect(graph.out).toContain("Workflow sample · completed · 1/1 nodes")
    expect(graph.out).toContain("Harness: test-cli")
    expect(graph.out).not.toContain("read-only")

    const json = await run(["--json", "graph", runID], project)
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.out.trim())
    expect(parsed).toMatchObject({ runID, workflowID: "sample", status: "completed" })
    expect(json.out).not.toContain("sess_")
    expect(json.out).not.toContain("runSessionID")
    expect(json.out).not.toContain("promptMessageID")
  })

  it("reports a failed run with a nonzero exit", async () => {
    const project = await tempProject()
    const routed = [
      "version: 1",
      "name: routed",
      "entry: developer",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  developer:",
      "    agent: developer",
      "    routes:",
      "      approved: complete",
      "",
    ].join("\n")
    await writeWorkflow(project, ".flowgraph/workflows", "routed", routed)
    const module = await adapterModule(project, "wrong")
    const result = await run(["--adapter-module", module, "run", "routed", "fail it"], project)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/Run run_[^\s]+ failed: native_failure — /)
  })

  it("prints workflow diagnostics when a run fails validation", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "ghost", [
      "version: 1",
      "name: ghost",
      "entry: developer",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  developer: { agent: ghost, next: complete }",
      "",
    ].join("\n"))
    const module = await adapterModule(project)
    const result = await run(["--adapter-module", module, "run", "ghost", "do it"], project)
    expect(result.code).toBe(1)
    expect(result.err).toContain("flowgraph: workflow validation failed")
    expect(result.err).toContain("nodes.developer.agent")
    expect(result.err).toContain('agent "ghost" was not found')
  })

  it("reports a blocked human step with the respond command", async () => {
    const project = await tempProject()
    const human = [
      "version: 1",
      "name: approval",
      "entry: approve",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  approve:",
      "    human: true",
      "    label: Approve the release",
      "    routes:",
      "      approved: complete",
      "      rejected: complete",
      "",
    ].join("\n")
    await writeWorkflow(project, ".flowgraph/workflows", "approval", human)
    const module = await adapterModule(project)
    const result = await run(["--adapter-module", module, "run", "approval", "ship it"], project)
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/Blocked at approve: /)
    expect(result.out).toMatch(/Answer: flowgraph respond run_[^\s]+ --outcome <outcome> --node approve/)
    expect(result.out).toContain(`--adapter-module ${module}`)
  })

  it("prints NDJSON for a JSON run without native session references", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project)
    const result = await run(["--json", "--adapter-module", module, "run", "sample", "implement it"], project)
    expect(result.code).toBe(0)
    const events = result.out.trim().split("\n").map((line) => JSON.parse(line))
    expect(events[0]).toMatchObject({ type: "started", workflowID: "sample", status: "running" })
    expect(events.at(-1)).toMatchObject({ type: "result", run: { workflowID: "sample", status: "completed" }, exitCode: 0 })
    expect(result.out).not.toContain("sess_")
    expect(result.out).not.toContain("runSessionID")
    expect(result.out).not.toContain("promptMessageID")
  })

  it("reports no CLI runs and keeps OpenCode runs out of CLI state", async () => {
    const project = await tempProject()
    const result = await run(["runs"], project)
    expect(result.code).toBe(0)
    expect(result.out).toBe(
      "No workflow runs in CLI state. Runs started in OpenCode are managed by the plugin; use /flowgraph runs or RPC.\n",
    )
  })

  it("explains that runs from another harness are not in CLI state", async () => {
    const project = await tempProject()
    const module = await adapterModule(project)
    const result = await run(["--adapter-module", module, "pause", "run_foreign"], project)
    expect(result.code).toBe(1)
    expect(result.err).toContain("workflow run not found in CLI state: run_foreign")
    expect(result.err).toContain("Runs started by another harness are not visible to the CLI")
  })

  it("treats a closed output pipe as normal termination", async () => {
    const project = await tempProject()
    const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" })
    let writes = 0
    const code = await main(["runs"], {
      cwd: project,
      io: {
        stdout: () => { writes += 1; throw epipe },
        stderr: () => { throw epipe },
        isTTY: false,
      },
      handleSignals: false,
    })
    expect(code).toBe(0)
    expect(writes).toBeGreaterThan(0)
  })

  it("answers a human step through respond", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "humanflow", [
      "version: 1",
      "name: humanflow",
      "entry: approve",
      "limits: { max_steps: 3 }",
      "nodes:",
      "  approve:",
      "    human: true",
      "    label: Approve the release",
      "    routes: { approved: complete }",
      "",
    ].join("\n"))
    const module = await adapterModule(project)
    const started = await run(["--adapter-module", module, "run", "humanflow", "wait"], project)
    expect(started.code).toBe(0)
    expect(started.out).toContain("Blocked at approve")
    const runID = /Run (run_[^\s]+) started/u.exec(started.out)![1]!

    const respond = await run(["respond", runID, "--outcome", "approved", "--adapter-module", module], project)
    expect(respond.code).toBe(0)
    expect(respond.out).toMatch(/Run run_[^\s]+ completed\./)
    const after = await run(["runs", "--json"], project)
    expect(JSON.parse(after.out.trim()).runs).toHaveLength(1)
    expect(JSON.parse(after.out.trim()).runs[0]).toMatchObject({ workflowID: "humanflow", status: "completed" })
  })

  it("pauses an interrupted run whose owning process is gone", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const hanging = await adapterModule(project, "hang")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 400)
    const started = await run(["--adapter-module", hanging, "run", "sample", "pause me"], project, {
      abortSignal: controller.signal,
    }).finally(() => clearTimeout(timer))
    expect(started.code).toBe(130)
    const runID = /Run (run_[^\s]+) started/u.exec(started.out)![1]!

    const orphaned = await adapterModule(project, "orphaned")
    const paused = await run(["--adapter-module", orphaned, "pause", runID], project)
    expect(paused.code).toBe(0)
    expect(paused.out).toContain(`Run ${runID} paused.`)
    expect((await run(["--json", "runs"], project)).out).toContain('"status":"paused"')
  }, 20_000)

  it("prints the resume confirmation hint for an ambiguous node", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project, "unknown")
    const result = await run(["--adapter-module", module, "run", "sample", "ambiguous"], project)
    expect(result.code).toBe(0)
    expect(result.out).toContain("Blocked at developer:")
    expect(result.out).toMatch(/Resume: flowgraph resume run_\S+ --confirm-retry --adapter-module \S+/)
  })

  it("refuses to pause a run waiting for a native permission decision", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project, "permission")
    const started = await run(["--adapter-module", module, "run", "sample", "needs permission"], project)
    expect(started.code).toBe(0)
    expect(started.out).toContain("Resolve the pending native permission, then: flowgraph resume")
    const runID = /Run (run_[^\s]+) started/u.exec(started.out)![1]!

    const paused = await run(["--adapter-module", module, "pause", runID], project)
    expect(paused.code).toBe(1)
    expect(paused.err).toContain("waiting for a native permission decision")
  })

  it("refuses to pause a fork while any branch waits for a native permission", async () => {
    const project = await tempProject()
    const fork = [
      "version: 1",
      "name: fork",
      "entry: dispatch",
      "limits: { max_steps: 6 }",
      "nodes:",
      "  dispatch: { fork: [left, right], join: merge }",
      "  left: { agent: developer, next: merge }",
      "  right: { agent: reviewer, next: merge }",
      "  merge: { agent: developer, routes: { done: complete } }",
      "",
    ].join("\n")
    await writeWorkflow(project, ".flowgraph/workflows", "fork", fork)
    const module = await adapterModule(project, "fork")
    const started = await run(["--adapter-module", module, "run", "fork", "split"], project)
    expect(started.code).toBe(0)
    expect(started.out).toContain("Resolve the pending native permission, then: flowgraph resume")
    const runID = /Run (run_[^\s]+) started/u.exec(started.out)![1]!

    const paused = await run(["--adapter-module", module, "pause", runID], project)
    expect(paused.code).toBe(1)
    expect(paused.err).toContain("waiting for a native permission decision")
  }, 20_000)

  it("stops a pause drain when a native permission appears after the request", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const hanging = await adapterModule(project, "hang")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 400)
    const started = await run(["--adapter-module", hanging, "run", "sample", "pause me"], project, {
      abortSignal: controller.signal,
    }).finally(() => clearTimeout(timer))
    expect(started.code).toBe(130)
    const runID = /Run (run_[^\s]+) started/u.exec(started.out)![1]!

    // The orphaned run has an active step but no recorded permission; the new
    // adapter reports one only once the pause drain observes the session.
    const permission = await adapterModule(project, "permission")
    const stop = new AbortController()
    const stopTimer = setTimeout(() => stop.abort(), 4_000)
    const paused = await run(["--adapter-module", permission, "pause", runID], project, {
      abortSignal: stop.signal,
    }).finally(() => clearTimeout(stopTimer))
    expect(paused.code).toBe(1)
    expect(paused.out).toContain("Pause stopped")
    expect(paused.out).toContain("Resolve the pending native permission, then: flowgraph resume")
    const state = JSON.parse((await run(["--json", "runs"], project)).out.trim())
    expect(state.runs[0]).toMatchObject({ runID, status: "pausing" })
  }, 20_000)

  it("keeps an interrupted pause resumable across repeated attempts", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project, "running")
    const first = new AbortController()
    const firstTimer = setTimeout(() => first.abort(), 400)
    const started = await run(["--adapter-module", module, "run", "sample", "pause me"], project, {
      abortSignal: first.signal,
    }).finally(() => clearTimeout(firstTimer))
    expect(started.code).toBe(130)
    const runID = /Run (run_[^\s]+) started/u.exec(started.out)![1]!

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 300)
      const paused = await run(["--adapter-module", module, "pause", runID], project, {
        abortSignal: controller.signal,
      }).finally(() => clearTimeout(timer))
      expect(paused.code).toBe(130)
    }
    const state = JSON.parse((await run(["--json", "runs"], project)).out.trim())
    expect(state.runs[0]).toMatchObject({ runID, status: "pausing" })
    expect(state.runs[0].failure).toBeNull()
  }, 30_000)

  it("does not claim a checkpoint when interrupted before the run or action starts", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project)
    const controller = new AbortController()
    controller.abort()
    const runStart = await run(["--adapter-module", module, "run", "sample", "do it"], project, {
      abortSignal: controller.signal,
    })
    expect(runStart.code).toBe(130)
    expect(runStart.out).toContain("Interrupted before the run started; no checkpoint was saved.")
    expect(runStart.out).not.toContain("checkpoint saved.")

    const control = await run(["--adapter-module", module, "pause", "run_missing"], project, {
      abortSignal: controller.signal,
    })
    expect(control.code).toBe(130)
    expect(control.out).toContain("Interrupted before the action was applied; the run was not changed.")
  })

  it("interrupts a foreground run through runtime shutdown", async () => {
    const project = await tempProject()
    await writeWorkflow(project, ".flowgraph/workflows", "sample")
    const module = await adapterModule(project, "hang")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 400)
    try {
      const result = await run(["--adapter-module", module, "run", "sample", "hang"], project, {
        abortSignal: controller.signal,
      })
      expect(result.code).toBe(130)
      expect(result.out).toMatch(/Run run_[^\s]+ started/)
      expect(result.out).toContain("Interrupted; checkpoint saved.")
      expect(result.out).toMatch(/Resume with flowgraph resume run_/)
    } finally {
      clearTimeout(timer)
    }
  }, 20_000)
})
