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
})
