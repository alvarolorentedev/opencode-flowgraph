import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorkflowRepository } from "../../src/workflow/loader.js"
import { resolveWorkflowRoot } from "../../src/workflow/root.js"

const dirs: string[] = []
async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-root-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function make(directory: string, relative: string): Promise<string> {
  const root = path.join(directory, relative)
  await fs.mkdir(root, { recursive: true })
  return root
}

describe("workflow root resolution", () => {
  it("creates the neutral directory for new installations", () => {
    const project = "/tmp/example-project"
    const resolved = resolveWorkflowRoot({ projectDirectory: project })
    expect(resolved.source).toBe("neutral")
    expect(resolved.relativeRoot).toBe(".flowgraph/workflows")
    expect(resolved.warning).toBeUndefined()
  })

  it("uses the neutral directory when it exists", async () => {
    const project = await tempProject()
    await make(project, ".flowgraph/workflows")
    const resolved = resolveWorkflowRoot({ projectDirectory: project })
    expect(resolved.source).toBe("neutral")
    expect(resolved.warning).toBeUndefined()
  })

  it("falls back to the legacy directory with one warning", async () => {
    const project = await tempProject()
    await make(project, ".opencode/workflows")
    const resolved = resolveWorkflowRoot({ projectDirectory: project })
    expect(resolved.source).toBe("legacy")
    expect(resolved.relativeRoot).toBe(".opencode/workflows")
    expect(resolved.warning).toContain(".flowgraph/workflows not found; using legacy .opencode/workflows")
    expect(resolved.warning).toContain("files are not merged")
  })

  it("prefers the neutral directory and warns when both exist", async () => {
    const project = await tempProject()
    await make(project, ".flowgraph/workflows")
    await make(project, ".opencode/workflows")
    const resolved = resolveWorkflowRoot({ projectDirectory: project })
    expect(resolved.source).toBe("neutral")
    expect(resolved.relativeRoot).toBe(".flowgraph/workflows")
    expect(resolved.warning).toBe("both dirs exist; using .flowgraph/workflows. .opencode/workflows is ignored, not merged.")
  })

  it("honors an explicit directory and never merges the legacy one", async () => {
    const project = await tempProject()
    await make(project, ".opencode/workflows")
    const explicit = resolveWorkflowRoot({ projectDirectory: project, workflowDir: "custom/flows" })
    expect(explicit.source).toBe("explicit")
    expect(explicit.warning).toBeUndefined()
    expect(explicit.relativeRoot).toBe("custom/flows")
  })

  it("keeps legacy workflows readable through the repository", async () => {
    const project = await tempProject()
    const root = await make(project, ".opencode/workflows")
    await fs.writeFile(path.join(root, "legacy.yaml"), [
      "version: 1",
      "name: legacy",
      "entry: a",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  a: { agent: developer, next: complete }",
      "",
    ].join("\n"))
    const repo = new WorkflowRepository(project)
    expect(repo.source).toBe("legacy")
    expect(repo.warning).toBeDefined()
    expect(await repo.listIDs()).toEqual(["legacy"])
    expect((await repo.read("legacy")).workflow?.name).toBe("legacy")
  })

  it("does not merge files from both directories", async () => {
    const project = await tempProject()
    const neutral = await make(project, ".flowgraph/workflows")
    const legacy = await make(project, ".opencode/workflows")
    const source = (name: string) => [
      "version: 1",
      `name: ${name}`,
      "entry: a",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  a: { agent: developer, next: complete }",
      "",
    ].join("\n")
    await fs.writeFile(path.join(neutral, "shared.yaml"), source("shared"))
    await fs.writeFile(path.join(legacy, "legacy-only.yaml"), source("legacy-only"))
    const repo = new WorkflowRepository(project)
    expect(await repo.listIDs()).toEqual(["shared"])
  })

  it("rejects explicit and neutral workflow roots that resolve outside the project", async () => {
    const project = await tempProject()
    const outside = await tempProject()
    await fs.writeFile(path.join(outside, "external.yaml"), [
      "version: 1",
      "name: external",
      "entry: a",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  a: { agent: developer, next: complete }",
      "",
    ].join("\n"))

    await fs.symlink(outside, path.join(project, "flows"))
    const explicit = new WorkflowRepository(project, { root: "flows" })
    await expect(explicit.listIDs()).rejects.toMatchObject({ code: "unsafe_path" })
    await expect(explicit.read("external")).rejects.toMatchObject({ code: "unsafe_path" })

    await make(project, ".flowgraph")
    await fs.symlink(outside, path.join(project, ".flowgraph", "workflows"))
    const neutral = new WorkflowRepository(project)
    await expect(neutral.listIDs()).rejects.toMatchObject({ code: "unsafe_path" })
    const source = [
      "version: 1",
      "name: new",
      "entry: a",
      "limits: { max_steps: 2 }",
      "nodes:",
      "  a: { agent: developer, next: complete }",
      "",
    ].join("\n")
    await expect(neutral.save("new", source, null)).rejects.toMatchObject({ code: "unsafe_path" })
    expect(await fs.readdir(outside)).toEqual(["external.yaml"])
  })

  it("the repository default matches the shared resolver (plugin and CLI share it)", async () => {
    for (const relative of [undefined, ".flowgraph/workflows", ".opencode/workflows"]) {
      const project = await tempProject()
      if (relative !== undefined) await make(project, relative)
      const resolved = resolveWorkflowRoot({ projectDirectory: project })
      const repo = new WorkflowRepository(project)
      expect(repo.root).toBe(resolved.root)
      expect(repo.relativeRoot).toBe(resolved.relativeRoot)
      expect(repo.source).toBe(resolved.source)
      expect(repo.warning).toBe(resolved.warning)
    }
  })
})
