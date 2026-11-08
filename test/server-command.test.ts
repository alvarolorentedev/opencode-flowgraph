import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorkflowService } from "../src/service.js"
import { runServerCommand } from "../src/server-command.js"
import { WorkflowRunner } from "../src/execution/runner.js"
import { RunLockManager } from "../src/state/concurrency.js"
import { WorkflowStore } from "../src/state/store.js"
import { createInvocationRegistry } from "../src/execution/report-tool.js"
import { FakeNative } from "./fixtures/fake-native.js"
import { MemoryStorage, source } from "./fixtures/memory.js"
import { WorkflowRepository } from "../src/workflow/loader.js"

const dirs: string[] = []
async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-server-command-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const directory = await tempProject()
  const project = { id: "prj_1", canonical: directory, directory }
  const storage = new MemoryStorage()
  const store = new WorkflowStore(storage)
  const native = new FakeNative(store, project.id, () => ({
    report: { outcome: "done", summary: "ok", feedback: "", evidence: [] },
  }))
  const locks = new RunLockManager()
  const invocations = createInvocationRegistry()
  const runner = new WorkflowRunner({
    store,
    native,
    locks,
    invocations,
    emit: async () => undefined,
    now: () => 2_000,
    options: { pollIntervalMs: 5, recoveryGraceMs: 50 },
  })
  const repo = new WorkflowRepository(directory)
  const service = new WorkflowService({
    project,
    store,
    runner,
    native,
    repo,
    instanceID: "inst_test",
    emit: async () => undefined,
    now: () => 2_000,
  })
  return { service }
}

describe("runServerCommand", () => {
  it("lists workflows", async () => {
    const { service } = await setup()
    await service.saveWorkflow("sample", source, null)
    const text = await runServerCommand(service, "list")
    expect(text).toContain("sample")
    expect(text).toContain("valid")
  })

  it("reports usage when run args are missing", async () => {
    const { service } = await setup()
    await service.saveWorkflow("sample", source, null)
    expect(await runServerCommand(service, "run")).toContain("Usage:")
    expect(await runServerCommand(service, "run sample")).toContain("Usage:")
  })

  it("starts a run and lists it", async () => {
    const { service } = await setup()
    await service.saveWorkflow("sample", source, null)
    const started = await runServerCommand(service, "run sample implement it", { requestID: "req-1" })
    expect(started).toContain("Started workflow 'sample'")
    const runs = await runServerCommand(service, "runs")
    expect(runs).toContain("sample")
    expect(runs).toContain("running")
  })

  it("describes one run for graph <runID> and hints without it", async () => {
    const { service } = await setup()
    await service.saveWorkflow("sample", source, null)
    const started = await service.startRun("sample", "implement it", "req-1")
    const detail = await runServerCommand(service, `graph ${started.runID}`)
    expect(detail).toContain("sample")
    expect(detail).toContain(started.runID)
    expect(await runServerCommand(service, "")).toContain("graph <runID>")
  })

  it("returns errors as text instead of throwing", async () => {
    const { service } = await setup()
    expect(await runServerCommand(service, "graph missing_run")).toContain("not found")
    expect(await runServerCommand(service, "run missing do it", { requestID: "req-x" })).toContain("not found")
  })

  it("tolerates a raw /flowgraph prefix", async () => {
    const { service } = await setup()
    await service.saveWorkflow("sample", source, null)
    expect(await runServerCommand(service, "/flowgraph list")).toContain("sample")
  })
})
