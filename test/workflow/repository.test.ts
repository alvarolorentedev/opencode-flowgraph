import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorkflowRepository } from "../../src/workflow/loader.js"

const valid = `version: 1
name: sample
entry: a
limits:
  max_steps: 3
nodes:
  a:
    agent: developer
    next: complete
`

const dirs: string[] = []
async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-repo-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("WorkflowRepository", () => {
  it("creates, reads, updates, lists, and deletes a workflow with hash preconditions", async () => {
    const project = await tempProject()
    const repo = new WorkflowRepository(project)
    const created = await repo.save("sample", valid, null)
    expect(created.id).toBe("sample")

    const read = await repo.read("sample")
    expect(read.hash).toBe(created.hash)
    expect(read.workflow?.name).toBe("sample")
    expect(await repo.listIDs()).toEqual(["sample"])

    await expect(repo.save("sample", valid, null)).rejects.toMatchObject({ code: "stale_revision" })
    await expect(repo.save("sample", valid, "0".repeat(64))).rejects.toMatchObject({ code: "stale_revision" })

    const updatedSource = valid.replace("max_steps: 3", "max_steps: 4")
    const updated = await repo.save("sample", updatedSource, created.hash)
    await expect(repo.delete("sample", created.hash)).rejects.toMatchObject({ code: "stale_revision" })
    await repo.delete("sample", updated.hash)
    await expect(repo.read("sample")).rejects.toMatchObject({ code: "not_found" })
  })

  it("rejects invalid IDs and symlinked workflow files", async () => {
    const project = await tempProject()
    const repo = new WorkflowRepository(project)
    await expect(repo.read("../escape")).rejects.toMatchObject({ code: "invalid_workflow_id" })

    const root = path.join(project, ".opencode", "workflows")
    await fs.mkdir(root, { recursive: true })
    const outside = path.join(project, "outside.yaml")
    await fs.writeFile(outside, valid)
    await fs.symlink(outside, path.join(root, "sample.yaml"))
    await expect(repo.read("sample")).rejects.toMatchObject({ code: "unsafe_path" })
  })
})
