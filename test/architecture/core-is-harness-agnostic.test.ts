import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const CORE_DIRECTORIES = ["src/execution", "src/workflow", "src/state", "src/util"]
const CORE_FILES = [
  "src/contract.ts",
  "src/service.ts",
  "src/command.ts",
  "src/server-command.ts",
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
  it("keeps the core free of OpenCode and adapter imports", () => {
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
})
