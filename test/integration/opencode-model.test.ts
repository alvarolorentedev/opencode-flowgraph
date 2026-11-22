import { once } from "node:events"
import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { promises as fs } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const enabled = process.env.OPENCODE_MODEL_INTEGRATION === "1"
const bin = process.env.OPENCODE_BIN ?? "opencode"
const repo = process.cwd()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ModelRequest = {
  model?: string
  temperature?: number
  stream?: boolean
  messages?: Array<{ role?: string }>
  tools?: Array<{ name?: string; function?: { name?: string } }>
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("local server did not bind a TCP port")
  return address.port
}

async function port(): Promise<number> {
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

async function body(request: IncomingMessage): Promise<ModelRequest> {
  let text = ""
  for await (const chunk of request) text += chunk
  return JSON.parse(text) as ModelRequest
}

function respond(request: ModelRequest, response: ServerResponse, modelRequests: ModelRequest[]) {
  const reportTool = request.tools?.find((tool) => (tool.function?.name ?? tool.name) === "flowgraph_report")
  const hasToolResult = request.messages?.some((message) => message.role === "tool") ?? false
  if (reportTool && !hasToolResult) modelRequests.push(request)

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-flowgraph-test",
        object: "chat.completion.chunk",
        created: 1,
        model: request.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    )

  if (reportTool && !hasToolResult) {
    const name = reportTool.function?.name ?? reportTool.name!
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_flowgraph_report",
          type: "function",
          function: { name, arguments: JSON.stringify({ outcome: "done", summary: "mock result", feedback: "", evidence: [] }) },
        },
      ],
    })
    chunk({}, "tool_calls")
  } else {
    chunk({ role: "assistant", content: "done" })
    chunk({}, "stop")
  }
  response.end("data: [DONE]\n\n")
}

async function route(server: string, method: string, input: Record<string, unknown>, authorization: string) {
  const response = await fetch(`${server}/api/rpc/flowgraph/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ input }),
  })
  const result = (await response.json()) as { output?: Record<string, unknown>; message?: string }
  if (!response.ok || !result.output) throw new Error(`${method} failed (${response.status}): ${JSON.stringify(result)}`)
  return result.output
}

async function serve(project: string, home: string) {
  const serverPort = await port()
  const password = "flowgraph-test-password"
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  let logs = ""
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
    cwd: project,
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
  const baseURL = `http://127.0.0.1:${serverPort}`
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
      if (response.ok) return { baseURL, authorization, stop, logs: () => logs }
    } catch {
      // The listener is not ready yet.
    }
    await wait(250)
  }
  await stop()
  throw new Error(`OpenCode did not become ready: ${logs}`)
}

async function onceProject(providerPort: number, prefix: string, options: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const project = path.join(directory, "project")
  const home = path.join(directory, "home")
  await fs.mkdir(path.join(project, ".opencode", "workflows"), { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(
    path.join(project, "opencode.jsonc"),
    JSON.stringify(
      {
        plugins: [Object.keys(options).length === 0 ? repo : { package: repo, options }],
        providers: {
          local: {
            name: "Local test provider",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test" },
            models: { alpha: { name: "Alpha", capabilities: { tools: true, input: ["text"], output: ["text"] } } },
          },
        },
        agents: { alpha: { description: "Alpha", mode: "primary", model: "local/alpha" } },
      },
      null,
      2,
    ),
  )
  await fs.writeFile(
    path.join(project, ".opencode", "workflows", "once.yaml"),
    `version: 1
name: once
entry: alpha
limits: { max_steps: 2, timeout_seconds: 120 }
nodes:
  alpha: { agent: alpha, next: complete }
`,
  )
  return { directory, project, home }
}

describe.skipIf(!enabled)("OpenCode model inference integration", () => {
  it("uses configured models, the default, variants, and the default for an unavailable model", async () => {
    const modelRequests: ModelRequest[] = []
    const mockProvider = createServer(async (request, response) => {
      try {
        respond(await body(request), response, modelRequests)
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : "mock provider error")
      }
    })
    const providerPort = await listen(mockProvider)
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-model-integration-"))
    const project = path.join(directory, "project")
    const home = path.join(directory, "home")
    await fs.mkdir(path.join(project, ".opencode", "workflows"), { recursive: true })
    await fs.mkdir(home, { recursive: true })

    const model = (name: string) => ({ name, capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true } })
    await fs.writeFile(
      path.join(project, "opencode.jsonc"),
      JSON.stringify(
        {
          plugins: [repo],
          model: "local/default",
          providers: {
            local: {
              name: "Local test provider",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test" },
              models: {
                alpha: model("Alpha"),
                beta: model("Beta"),
                default: model("Default"),
                gamma: { ...model("Variant"), variants: [{ id: "low", body: { temperature: 0.17 } }] },
              },
            },
          },
          agents: {
            alpha: { description: "Alpha", mode: "primary", model: "local/alpha" },
            beta: { description: "Beta", mode: "primary", model: "local/beta" },
            fallback: { description: "Default fallback", mode: "primary" },
            variant: {
              description: "Variant",
              mode: "primary",
              model: { providerID: "local", model: "gamma", variant: "low" },
            },
            unavailable: { description: "Unavailable", mode: "primary", model: "local/missing" },
          },
        },
        null,
        2,
      ),
    )
    await fs.writeFile(
      path.join(project, ".opencode", "workflows", "models.yaml"),
      `version: 1
name: models
entry: alpha
limits: { max_steps: 5, timeout_seconds: 120 }
nodes:
  alpha: { agent: alpha, next: beta }
  beta: { agent: beta, next: fallback }
  fallback: { agent: fallback, next: variant }
  variant: { agent: variant, next: unavailable }
  unavailable: { agent: unavailable, next: complete }
`,
    )

    const serverPort = await port()
    const password = "flowgraph-test-password"
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    let logs = ""
    const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    for (const stream of [server.stdout, server.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        logs = `${logs}${chunk.toString()}`.slice(-8_000)
      })
    }

    try {
      const baseURL = `http://127.0.0.1:${serverPort}`
      let ready = false
      for (let attempt = 0; attempt < 120; attempt++) {
        if (server.exitCode !== null) throw new Error(`OpenCode exited before startup: ${logs}`)
        try {
          const response = await fetch(`${baseURL}/global/health`, { headers: { authorization } })
          if (response.ok) {
            ready = true
            break
          }
        } catch {
          // The listener is not ready yet.
        }
        await wait(250)
      }
      if (!ready) throw new Error(`OpenCode did not become ready: ${logs}`)

      const started = await route(baseURL, "startRun", {
        workflowID: "models",
        objective: "verify model routing",
        requestID: "model-routing-integration",
      }, authorization)
      const runID = started.runID
      if (typeof runID !== "string") throw new Error("startRun did not return a run ID")

      let run: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 240; attempt++) {
        const response = await route(baseURL, "getRun", { runID }, authorization)
        run = response.run as Record<string, unknown>
        if (["completed", "failed", "blocked", "cancelled"].includes(String(run.status))) break
        await wait(250)
      }
      expect(run?.status, `${JSON.stringify(run?.failure)}\n${logs}`).toBe("completed")
      expect(modelRequests.map((request) => request.model)).toEqual(["alpha", "beta", "default", "gamma", "default"])
      expect(modelRequests.find((request) => request.model === "gamma")?.temperature).toBe(0.17)
    } finally {
      if (server.exitCode === null) {
        server.kill("SIGTERM")
        await Promise.race([once(server, "exit"), wait(3_000)])
        if (server.exitCode === null) server.kill("SIGKILL")
      }
      await new Promise<void>((resolve) => mockProvider.close(() => resolve()))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it("blocks after a server restart mid-agent-step without re-prompting", async () => {
    let requests = 0
    let announced!: () => void
    const firstPrompt = new Promise<void>((resolve) => {
      announced = resolve
    })
    const mockProvider = createServer(async (request, response) => {
      try {
        const parsed = await body(request)
        const reportTool = parsed.tools?.find((tool) => (tool.function?.name ?? tool.name) === "flowgraph_report")
        if (reportTool) {
          requests += 1
          announced()
          // Hold the turn open; the server is killed before it terminates.
          return
        }
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end("data: [DONE]\n\n")
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : "mock provider error")
      }
    })
    const providerPort = await listen(mockProvider)
    const { directory, project, home } = await onceProject(providerPort, "flowgraph-restart-integration-")

    let server = await serve(project, home)
    try {
      const started = await route(server.baseURL, "startRun", {
        workflowID: "once",
        objective: "verify restart recovery",
        requestID: "restart-start",
      }, server.authorization)
      const runID = String(started.runID)
      await Promise.race([
        firstPrompt,
        wait(60_000).then(() => {
          throw new Error(`the mock provider never received a prompt\n${server.logs()}`)
        }),
      ])
      expect(requests).toBe(1)

      const before = (await route(server.baseURL, "getRun", { runID }, server.authorization)) as {
        run: { stepCount: number }
        currentStep: { stepID: string; sessionID: string } | null
      }
      expect(before.currentStep).not.toBeNull()

      await server.stop()
      await wait(500)
      server = await serve(project, home)

      let run: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 240; attempt++) {
        const response = await route(server.baseURL, "getRun", { runID }, server.authorization)
        run = response.run as Record<string, unknown>
        if (["blocked", "failed", "completed", "cancelled"].includes(String(run.status))) break
        await wait(250)
      }
      expect(["blocked", "failed"]).toContain(String(run?.status))
      // A conservative recovery blocks; it never re-sends the prompt.
      expect(requests).toBe(1)
      // Durable proof, not just request counts: the same step and session remain.
      expect(run?.stepCount).toBe(before.run.stepCount)
      const step = (await route(
        server.baseURL,
        "getRunStep",
        { runID, stepID: before.currentStep!.stepID },
        server.authorization,
      )) as { sessionID: string }
      expect(step.sessionID).toBe(before.currentStep!.sessionID)
      const harness = await route(server.baseURL, "harnessCapabilities", {}, server.authorization)
      expect(harness.id).toBe("opencode")
    } finally {
      await server.stop().catch(() => undefined)
      mockProvider.closeAllConnections()
      await new Promise<void>((resolve) => mockProvider.close(() => resolve()))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it("completes from a persisted report after a server restart", async () => {
    let reports = 0
    let followUpReached = false
    let announced!: () => void
    const followUp = new Promise<void>((resolve) => {
      announced = resolve
    })
    const mockProvider = createServer(async (request, response) => {
      try {
        const parsed = await body(request)
        const reportTool = parsed.tools?.find((tool) => (tool.function?.name ?? tool.name) === "flowgraph_report")
        const hasToolResult = parsed.messages?.some((message) => message.role === "tool") ?? false
        if (reportTool && !hasToolResult) reports += 1
        if (reportTool && hasToolResult) {
          followUpReached = true
          announced()
        }
        // Let every turn reach a terminal state; the kill happens after this turn ends.
        respond(parsed, response, [])
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : "mock provider error")
      }
    })
    const providerPort = await listen(mockProvider)
    // A long poll interval keeps the runner from routing the finished step before the kill,
    // so restart recovery must reconcile the persisted report itself.
    const { directory, project, home } = await onceProject(providerPort, "flowgraph-report-restart-integration-", {
      pollIntervalMs: 60_000,
      allowBackgroundWork: true,
    })

    let server = await serve(project, home)
    try {
      const harness = (await route(server.baseURL, "harnessCapabilities", {}, server.authorization)) as {
        security: { backgroundWork: string }
      }
      // The reported capability follows the plugin option end to end.
      expect(harness.security.backgroundWork).toBe("unobservable")

      const started = await route(server.baseURL, "startRun", {
        workflowID: "once",
        objective: "verify durable report recovery",
        requestID: "report-restart-start",
      }, server.authorization)
      const runID = String(started.runID)
      await Promise.race([
        followUp,
        wait(60_000).then(() => {
          throw new Error(`the mock provider never received the post-report turn\n${server.logs()}`)
        }),
      ])
      expect(reports).toBe(1)
      expect(followUpReached).toBe(true)

      // The turn and its report are durable before the kill; only the routing is lost.
      await wait(2_000)
      await server.stop()
      await wait(500)
      server = await serve(project, home)

      let run: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 240; attempt++) {
        const response = await route(server.baseURL, "getRun", { runID }, server.authorization)
        run = response.run as Record<string, unknown>
        if (["blocked", "failed", "completed", "cancelled"].includes(String(run.status))) break
        await wait(250)
      }
      expect(String(run?.status), `${JSON.stringify(run)}\n${server.logs()}`).toBe("completed")
      expect((run?.lastStep as { outcome?: string } | null)?.outcome).toBe("done")
      // The persisted report is reconciled; the prompt is never re-sent.
      expect(reports).toBe(1)
    } finally {
      await server.stop().catch(() => undefined)
      mockProvider.closeAllConnections()
      await new Promise<void>((resolve) => mockProvider.close(() => resolve()))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
