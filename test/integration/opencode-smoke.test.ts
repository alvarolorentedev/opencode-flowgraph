import { describe, expect, it } from "vitest"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { promises as fs } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const enabled = process.env.OPENCODE_SMOKE === "1"
const bin = process.env.OPENCODE_BIN ?? "opencode"
const repo = process.cwd()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(cwd: string, method: "get" | "post", route: string, data?: string): Promise<unknown> {
  const args = ["api", "--standalone", method, route]
  if (data !== undefined) args.push("--data", data)
  const { stdout } = await run(bin, args, { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout)
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("local server did not bind a TCP port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

type Server = {
  baseURL: string
  authorization: string
  logs: () => string
  stop: () => Promise<void>
}

async function serve(directory: string, home: string): Promise<Server> {
  const port = await freePort()
  const password = "flowgraph-smoke-password"
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  let logs = ""
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      logs = `${logs}${chunk.toString()}`.slice(-8_000)
    })
  }
  const baseURL = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (child.exitCode !== null) return
    child.kill("SIGTERM")
    await Promise.race([once(child, "exit"), wait(3_000)])
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited before startup: ${logs}`)
    try {
      const response = await fetch(`${baseURL}/global/health`, { headers: { authorization } })
      if (response.ok) return { baseURL, authorization, logs: () => logs, stop }
    } catch {
      // The listener is not ready yet.
    }
    await wait(250)
  }
  await stop()
  throw new Error(`OpenCode did not become ready: ${logs}`)
}

async function route(server: Server, method: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.baseURL}/api/rpc/flowgraph/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: server.authorization },
    body: JSON.stringify({ input }),
  })
  const result = (await response.json()) as { output?: Record<string, unknown>; message?: string }
  if (!response.ok || !result.output) throw new Error(`${method} failed (${response.status}): ${JSON.stringify(result)}`)
  return result.output
}

describe.skipIf(!enabled)("OpenCode V2 plugin loading and RPC smoke test", () => {
  it("loads the plugin and serves typed RPC without model calls", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-opencode-smoke-"))
    try {
      await fs.mkdir(path.join(dir, ".opencode", "agents"), { recursive: true })
      await fs.mkdir(path.join(dir, ".opencode", "workflows"), { recursive: true })
      await fs.writeFile(
        path.join(dir, "opencode.jsonc"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [repo] }, null, 2),
      )
      await fs.writeFile(
        path.join(dir, ".opencode", "agents", "developer.md"),
        "---\ndescription: Developer\nmode: primary\n---\nDo the work.\n",
      )
      await fs.writeFile(
        path.join(dir, ".opencode", "agents", "reviewer.md"),
        "---\ndescription: Reviewer\nmode: primary\n---\nReview the work.\n",
      )
      await fs.writeFile(
        path.join(dir, ".opencode", "workflows", "checks.yaml"),
        `version: 1
name: checks
entry: review
limits: { max_steps: 1 }
nodes:
  review: { agent: reviewer, routes: { approved: complete, blocked: pause } }
`,
      )
      await fs.writeFile(
        path.join(dir, ".opencode", "workflows", "sample.yaml"),
        `version: 1
name: sample
entry: dispatch
limits: { max_steps: 4, timeout_seconds: 60 }
nodes:
  dispatch: { fork: [developer, check], join: integrate }
  developer: { agent: developer, next: integrate }
  check: { workflow: checks, routes: { complete: integrate, pause: integrate } }
  integrate: { agent: reviewer, next: complete }
`,
      )

      const capabilities = (await api(dir, "post", "/api/rpc/flowgraph/capabilities", '{"input":{}}')) as {
        output: { rpc: { id: string }; features: { structuredResults: string; parallelBranches: boolean; nestedWorkflows: boolean } }
      }
      expect(capabilities.output.rpc.id).toBe("flowgraph")
      expect(capabilities.output.features).toMatchObject({
        structuredResults: "tool", parallelBranches: true, nestedWorkflows: true,
      })

      const workflows = (await api(dir, "post", "/api/rpc/flowgraph/listWorkflows", '{"input":{}}')) as {
        output: { workflows: Array<{ id: string; valid: boolean }> }
      }
      expect(workflows.output.workflows.find((workflow) => workflow.id === "sample")?.valid).toBe(true)

      const workflow = (await api(
        dir,
        "post",
        "/api/rpc/flowgraph/getWorkflow",
        JSON.stringify({ input: { workflowID: "sample" } }),
      )) as { output: { valid: boolean; mermaid: string; definition?: { name: string } } }
      expect(workflow.output.valid).toBe(true)
      expect(workflow.output.mermaid).toContain("flowchart TD")
      expect(workflow.output.mermaid).toContain("Check (checks)")
      expect(workflow.output.definition?.name).toBe("sample")

      const saved = (await api(
        dir,
        "post",
        "/api/rpc/flowgraph/saveWorkflow",
        JSON.stringify({
          input: {
            workflowID: "saved",
            yaml: `version: 1
name: saved
entry: developer
limits: { max_steps: 2 }
nodes:
  developer: { agent: developer, next: complete }
`,
            expectedHash: null,
          },
        }),
      )) as { output: { hash: string } }
      expect(saved.output.hash).toHaveLength(64)

      const deleted = (await api(
        dir,
        "post",
        "/api/rpc/flowgraph/deleteWorkflow",
        JSON.stringify({ input: { workflowID: "saved", expectedHash: saved.output.hash } }),
      )) as { output: { deleted: boolean } }
      expect(deleted.output.deleted).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("runs the human-only lifecycle, pause/resume, and cancel over RPC", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-opencode-lifecycle-"))
    const project = path.join(dir, "project")
    const home = path.join(dir, "home")
    await fs.mkdir(path.join(project, ".opencode", "workflows"), { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(
      path.join(project, "opencode.jsonc"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [repo] }, null, 2),
    )
    await fs.writeFile(
      path.join(project, ".opencode", "workflows", "human.yaml"),
      `version: 1
name: human
entry: approve
limits: { max_steps: 4, timeout_seconds: 60 }
nodes:
  approve: { human: true, routes: { approved: confirm } }
  confirm: { human: true, routes: { approved: complete, rejected: pause } }
`,
    )

    const server = await serve(project, home)
    type RunView = {
      run: {
        status: string
        revision: number
        harness?: { id: string }
        readOnly?: true
        blocker: null | { type: string; nodeID?: string; outcomes?: string[] }
      }
      resumable: boolean
    }
    const getRun = (runID: string) => route(server, "getRun", { runID }) as Promise<RunView>
    const until = async (
      runID: string,
      predicate: (run: RunView["run"]) => boolean,
    ): Promise<RunView["run"]> => {
      for (let attempt = 0; attempt < 240; attempt++) {
        const current = await getRun(runID)
        if (predicate(current.run)) return current.run
        await wait(250)
      }
      throw new Error(`run did not reach the expected state\n${server.logs()}`)
    }

    try {
      const harness = (await route(server, "harnessCapabilities", {})) as {
        id: string
        version: string
        security: { backgroundWork: string }
        permissions: { survivesRestart: boolean }
      }
      expect(harness.id).toBe("opencode")
      expect(typeof harness.version).toBe("string")
      // Defaults reject background work; the unobservable claim needs the opt-out.
      expect(harness.security.backgroundWork).toBe("blocked")
      expect(harness.permissions.survivesRestart).toBe(false)

      const started = await route(server, "startRun", {
        workflowID: "human",
        objective: "verify the human lifecycle",
        requestID: "lifecycle-start",
      })
      const runID = String(started.runID)
      const waiting = await until(runID, (run) => run.status === "blocked" && run.blocker?.nodeID === "approve")
      // The active harness owns the run, so no foreign identity and no read-only view.
      expect(waiting.harness).toBeUndefined()
      expect(waiting.readOnly).toBeUndefined()
      expect(waiting.blocker?.outcomes).toEqual(["approved"])
      const graph = (await route(server, "getRunGraph", { runID })) as {
        harness?: { id: string }
        readOnly?: true
        controls: { canRespond: boolean; canPause: boolean }
      }
      expect(graph.harness).toBeUndefined()
      expect(graph.readOnly).toBeUndefined()
      expect(graph.controls.canRespond).toBe(true)
      expect((await getRun(runID)).resumable).toBe(false)

      await route(server, "pauseRun", { runID, requestID: "lifecycle-pause", expectedRevision: waiting.revision })
      const paused = await until(runID, (run) => run.status === "paused")
      await route(server, "resumeRun", { runID, requestID: "lifecycle-resume", expectedRevision: paused.revision })
      const resumed = await until(runID, (run) => run.blocker?.nodeID === "approve" && run.status !== "paused")
      expect(resumed.blocker?.type).toBe("human_input")

      await route(server, "respondRun", {
        runID,
        requestID: "lifecycle-respond",
        expectedRevision: resumed.revision,
        nodeID: "approve",
        outcome: "approved",
        feedback: "ship it",
      })
      const second = await until(runID, (run) => run.blocker?.nodeID === "confirm")
      expect(second.blocker?.outcomes).toEqual(["approved", "rejected"])
      await route(server, "respondRun", {
        runID,
        requestID: "lifecycle-approve",
        expectedRevision: second.revision,
        nodeID: "confirm",
        outcome: "approved",
        feedback: "confirmed",
      })
      await until(runID, (run) => run.status === "completed")
      expect((await getRun(runID)).resumable).toBe(false)

      const cancelRun = await route(server, "startRun", {
        workflowID: "human",
        objective: "verify cancellation",
        requestID: "lifecycle-start-cancel",
      })
      const cancelID = String(cancelRun.runID)
      const cancelBlocker = await until(cancelID, (run) => run.status === "blocked" && run.blocker?.nodeID === "approve")
      await route(server, "cancelRun", {
        runID: cancelID,
        requestID: "lifecycle-cancel",
        expectedRevision: cancelBlocker.revision,
      })
      const cancelled = await until(cancelID, (run) => run.status === "cancelled")
      expect(cancelled.status).toBe("cancelled")
      expect((await getRun(cancelID)).resumable).toBe(false)
    } finally {
      await server.stop().catch(() => undefined)
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
