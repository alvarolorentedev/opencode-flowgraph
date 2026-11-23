import { describe, expect, it } from "vitest"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const cli = path.resolve("dist/cli.js")

describe.skipIf(!existsSync(cli))("built flowgraph CLI", () => {
  it("executes help, version, inspection, and the missing-adapter path", async () => {
    expect((await exec(process.execPath, [cli, "--version"])).stdout.trim()).toBe("1.0.1")
    expect((await exec(process.execPath, [cli, "--help"])).stdout).toContain("Usage: flowgraph")

    const project = await fs.mkdtemp(path.join(os.tmpdir(), "awf-built-"))
    try {
      expect((await exec(process.execPath, [cli, "--project", project, "list"])).stdout)
        .toContain("No workflows found")
      await expect(exec(process.execPath, [cli, "--project", project, "run", "missing", "smoke"]))
        .rejects.toMatchObject({ code: 3 })
    } finally {
      await fs.rm(project, { recursive: true, force: true })
    }
  }, 20_000)

  it("exits on SIGTERM while a read-only command loads a slow adapter", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "awf-built-signal-"))
    try {
      const marker = path.join(project, "adapter-loaded")
      const adapter = path.join(project, "slow.mjs")
      await fs.writeFile(adapter, [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(marker)}, "loaded")`,
        "export async function createHarnessAdapter() { await new Promise((resolve) => setTimeout(resolve, 60_000)) }",
        "",
      ].join("\n"))
      const child = spawn(process.execPath, [cli, "--project", project, "--adapter-module", adapter, "list"], {
        stdio: "ignore",
      })
      const deadline = Date.now() + 10_000
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error("adapter module was not loaded")
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      child.kill("SIGTERM")
      const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null]
      expect(code).toBe(143)
    } finally {
      await fs.rm(project, { recursive: true, force: true })
    }
  }, 20_000)
})
