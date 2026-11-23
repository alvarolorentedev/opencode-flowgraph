import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const CORE_DIRECTORIES = [
  "src/execution",
  "src/workflow",
  "src/state",
  "src/storage",
  "src/runtime",
  "src/util",
]
const CORE_FILES = [
  "src/contract.ts",
  "src/service.ts",
  "src/command.ts",
  "src/server-command.ts",
  "src/core.ts",
  "src/cli.ts",
]

const FORBIDDEN_IMPORT = /(?:from|import)\s*\(?\s*["'][^"']*(?:@opencode\/|adapters\/)[^"']*["']/u

function sourceFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const item = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(item)
    return entry.isFile() && entry.name.endsWith(".ts") ? [item] : []
  })
}

describe("core / adapter boundary", () => {
  it("keeps the core, runtime, storage, and CLI free of OpenCode and adapter imports", () => {
    const files = [...CORE_DIRECTORIES.flatMap(sourceFiles), ...CORE_FILES]
    const violations = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/u)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => FORBIDDEN_IMPORT.test(line))
        .map(({ line, number }) => `${file}:${number}: ${line.trim()}`),
    )
    expect(violations).toEqual([])
  })

  it("keeps the OpenCode plugin composition rooted in the portable runtime", () => {
    const source = readFileSync("src/index.ts", "utf8")
    expect(source).toContain("./runtime/create.js")
    expect(source).not.toContain("new WorkflowRunner(")
    expect(source).not.toContain("new RunLockManager(")
  })

  it("preserves the plugin exports and adds the portable entry points", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports: Record<string, string>
      bin: Record<string, string>
      files: string[]
    }
    expect(pkg.exports["."]).toBe("./src/index.ts")
    expect(pkg.exports["./rpc"]).toBe("./src/rpc.ts")
    expect(pkg.exports["./server"]).toBe("./src/index.ts")
    expect(pkg.exports["./workflow"]).toBe("./src/workflow/index.ts")
    expect(pkg.exports["./core"]).toBe("./dist/core.js")
    expect(pkg.exports["./runtime"]).toBe("./dist/runtime.js")
    expect(pkg.exports["./storage"]).toBe("./dist/storage.js")
    expect(pkg.bin.flowgraph).toBe("./dist/cli.js")
    expect(pkg.files).toContain("dist")
  })

  it("keeps built portable entries free of OpenCode imports", () => {
    for (const file of ["dist/cli.js", "dist/core.js", "dist/runtime.js", "dist/storage.js"]) {
      if (!existsSync(file)) continue
      const source = readFileSync(file, "utf8")
      expect(source).not.toContain("@opencode/")
      expect(source).not.toContain("adapters/opencode")
      if (file === "dist/cli.js") expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true)
    }
  })
})
