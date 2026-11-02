import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorkflowService, IdempotencyConflictError, InvalidWorkflowError } from "../../src/service.js"
import { WorkflowRunner } from "../../src/execution/runner.js"
import { ProjectLockManager } from "../../src/state/concurrency.js"
import { WorkflowStore } from "../../src/state/store.js"
import { createInvocationRegistry } from "../../src/execution/report-tool.js"
import { FakeNative } from "../fixtures/fake-native.js"
import { MemoryStorage, source, waitForRun } from "../fixtures/memory.js"
import { WorkflowRepository } from "../../src/workflow/loader.js"

const dirs: string[] = []
async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-service-"))
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
  const native = new FakeNative(store, project.id, (input) => ({
    report:
      input.agent === "developer"
        ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
        : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
  }))
  const locks = new ProjectLockManager()
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
  return { directory, project, store, native, runner, service }
}

describe("WorkflowService", () => {
  it("validates, saves, lists, starts, inspects, and deletes a workflow", async () => {
    const { service, store, project } = await setup()
    const saved = await service.saveWorkflow("sample", source, null)
    expect(saved.hash).toHaveLength(64)

    const list = await service.listWorkflows()
    expect(list.workflows).toHaveLength(1)
    expect(list.workflows[0]?.valid).toBe(true)

    const view = await service.getWorkflow("sample")
    expect(view.valid).toBe(true)
    expect(view.mermaid).toContain("flowchart TD")
    expect(view.agents?.every((agent) => agent.resolved)).toBe(true)

    const validation = await service.validateWorkflowSource(source, "sample")
    expect(validation.valid).toBe(true)

    const summary = await service.startRun("sample", "implement it", "request-1")
    const final = await waitForRun(store, project.id, summary.runID, (run) => run.status === "completed")
    expect(final.status).toBe("completed")
    expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "reviewer"])

    const detail = await service.getRun(summary.runID)
    expect(detail.mermaid).toContain("flowchart TD")
    expect(detail.currentStep).toBeNull()
    expect(detail.pendingPermissions).toEqual([])
    expect(detail.resumable).toBe(false)

    const runGraph = await service.getRunGraph(summary.runID)
    expect(runGraph.nodes.map((node) => node.state)).toEqual(["completed", "completed"])
    expect(runGraph.activeNode).toBeNull()
    expect(runGraph.mermaid).toContain("flowchart TD")
    expect(runGraph.mermaidNodes).toHaveLength(2)

    const step = await service.getRunStep(summary.runID, final.steps[0]!.stepID)
    expect(step.result?.outcome).toBe("done")

    const runs = await service.listRuns()
    expect(runs.map((run) => run.runID)).toEqual([summary.runID])

    const duplicate = await service.startRun("sample", "implement it", "request-1")
    expect(duplicate.runID).toBe(summary.runID)
    await expect(service.startRun("sample", "a different objective", "request-1")).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    )

    await service.deleteWorkflow("sample", saved.hash)
    expect((await service.listWorkflows()).workflows).toEqual([])
  })

  it("rejects invalid workflows before saving", async () => {
    const { service } = await setup()
    const invalid = source.replace("agent: developer", "agent: does_not_exist")
    await expect(service.saveWorkflow("sample", invalid, null)).rejects.toBeInstanceOf(InvalidWorkflowError)
    expect((await service.listWorkflows()).workflows).toEqual([])
  })
})
