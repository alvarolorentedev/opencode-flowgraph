import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorkflowStore } from "../../src/state/store.js"
import { RunLockManager } from "../../src/state/concurrency.js"
import { NotResumableError, WorkflowRunner } from "../../src/execution/runner.js"
import { createInvocationRegistry, ReportIntake } from "../../src/execution/report-intake.js"
import { WorkflowService } from "../../src/service.js"
import { WorkflowRepository } from "../../src/workflow/loader.js"
import { FakeHarness } from "../fixtures/fake-harness.js"
import { MemoryStorage, makeRunRecord, source, waitForRun } from "../fixtures/memory.js"

const dirs: string[] = []
const runners: WorkflowRunner[] = []
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-harness-"))
  dirs.push(dir)
  return dir
}

function scenario(input: { agent: string }) {
  return {
    report: input.agent === "developer"
      ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
      : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
  }
}

describe("harness identity", () => {
  it("writes a sidecar when a service starts a run", async () => {
    const directory = await tempProject()
    const project = { id: "prj_1", canonical: directory, directory }
    const store = new WorkflowStore(new MemoryStorage())
    const invocations = createInvocationRegistry()
    const intake = new ReportIntake(store, invocations)
    const harness = new FakeHarness(intake, scenario)
    const runner = new WorkflowRunner({
      store,
      harness,
      locks: new RunLockManager(),
      invocations,
      emit: async () => undefined,
      now: () => 2_000,
      options: { pollIntervalMs: 5, recoveryGraceMs: 50 },
    })
    runners.push(runner)
    const service = new WorkflowService({
      project,
      store,
      runner,
      harness,
      repo: new WorkflowRepository(directory),
      instanceID: "inst_test",
      emit: async () => undefined,
      now: () => 2_000,
    })

    await service.saveWorkflow("sample", source, null)
    const started = await service.startRun("sample", "implement it", "request-1")
    await waitForRun(store, project.id, started.runID, (run) => run.status === "completed")
    expect(await store.getRunHarness(project.id, started.runID)).toEqual({ id: "fake" })
  })

  it("refuses legacy and foreign runs when adoption is disabled", async () => {
    const store = new WorkflowStore(new MemoryStorage())
    const invocations = createInvocationRegistry()
    const intake = new ReportIntake(store, invocations)
    const harness = new FakeHarness(intake, scenario, { adoptLegacyRuns: false })
    const runner = new WorkflowRunner({
      store,
      harness,
      locks: new RunLockManager(),
      invocations,
      emit: async () => undefined,
      now: () => 2_000,
      options: { pollIntervalMs: 5, recoveryGraceMs: 50 },
    })
    runners.push(runner)

    const legacy = await store.createRun(makeRunRecord())
    await expect(runner.start("prj_1", legacy.runID)).rejects.toBeInstanceOf(NotResumableError)

    const foreign = await store.createRun(makeRunRecord({ runID: "run_0000000002_abcdef", createdAt: 3_000 }))
    await store.putRunHarness("prj_1", foreign.runID, { id: "opencode" })
    await expect(runner.start("prj_1", foreign.runID)).rejects.toBeInstanceOf(NotResumableError)

    const owned = await store.createRun(makeRunRecord({ runID: "run_0000000003_abcdef", createdAt: 4_000 }))
    await store.putRunHarness("prj_1", owned.runID, { id: "fake" })
    await runner.start("prj_1", owned.runID)
    const final = await waitForRun(store, "prj_1", owned.runID, (run) => run.status !== "running")
    expect(final.status).toBe("completed")
  })

  it("marks an unadopted legacy run read-only in every view", async () => {
    const directory = await tempProject()
    const project = { id: "prj_1", canonical: directory, directory }
    const store = new WorkflowStore(new MemoryStorage())
    const invocations = createInvocationRegistry()
    const intake = new ReportIntake(store, invocations)
    const harness = new FakeHarness(intake, scenario, { adoptLegacyRuns: false })
    const runner = new WorkflowRunner({
      store,
      harness,
      locks: new RunLockManager(),
      invocations,
      emit: async () => undefined,
      now: () => 2_000,
      options: { pollIntervalMs: 5, recoveryGraceMs: 50 },
    })
    runners.push(runner)
    const service = new WorkflowService({
      project,
      store,
      runner,
      harness,
      repo: new WorkflowRepository(directory),
      instanceID: "inst_test",
      emit: async () => undefined,
      now: () => 2_000,
    })
    const legacy = await store.createRun(makeRunRecord({ project, status: "blocked" }))

    const summary = (await service.listRuns()).find((run) => run.runID === legacy.runID)
    expect(summary?.readOnly).toBe(true)
    expect(summary?.harness).toBeUndefined()
    const detail = await service.getRun(legacy.runID)
    expect(detail.readOnly).toBe(true)
    expect(detail.resumable).toBe(false)
    const graph = await service.getRunGraph(legacy.runID)
    expect(graph.readOnly).toBe(true)
    expect(graph.controls).toEqual({ canPause: false, canResume: false, canRespond: false, canCancel: false })

    await expect(service.resumeRun(legacy.runID, "resume", legacy.revision)).rejects.toBeInstanceOf(NotResumableError)
    await expect(service.pauseRun(legacy.runID, "pause", legacy.revision)).rejects.toBeInstanceOf(NotResumableError)
    await expect(service.cancelRun(legacy.runID, "cancel", legacy.revision)).rejects.toBeInstanceOf(NotResumableError)
  })
})
