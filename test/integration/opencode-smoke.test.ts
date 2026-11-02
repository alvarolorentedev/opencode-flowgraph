import { describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const enabled = process.env.OPENCODE_SMOKE === "1"
const bin = process.env.OPENCODE_BIN ?? "opencode"
const repo = process.cwd()

async function api(cwd: string, method: "get" | "post", route: string, data?: string): Promise<unknown> {
  const args = ["api", "--standalone", method, route]
  if (data !== undefined) args.push("--data", data)
  const { stdout } = await run(bin, args, { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout)
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
        path.join(dir, ".opencode", "workflows", "sample.yaml"),
        `version: 1
name: sample
entry: developer
limits: { max_steps: 4, timeout_seconds: 60 }
nodes:
  developer: { agent: developer, next: reviewer }
  reviewer:
    agent: reviewer
    routes: { approved: complete, changes_requested: developer, blocked: pause }
`,
      )

      const capabilities = (await api(dir, "post", "/api/rpc/flowgraph/capabilities", '{"input":{}}')) as {
        output: { rpc: { id: string }; features: { structuredResults: string } }
      }
      expect(capabilities.output.rpc.id).toBe("flowgraph")
      expect(capabilities.output.features.structuredResults).toBe("tool")

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
})
