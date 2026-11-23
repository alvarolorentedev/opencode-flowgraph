import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFlowgraphRuntime, type FlowgraphRuntime, type HarnessAdapterContext } from "../../src/runtime/create.js"
import { FileSystemStoragePort } from "../../src/storage/filesystem.js"
import { FakeHarness } from "../fixtures/fake-harness.js"
import { source, waitForRun } from "../fixtures/memory.js"
import type { HarnessAdapter } from "../../src/execution/harness.js"

const dirs: string[] = []
const runtimes: FlowgraphRuntime[] = []
async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-runtime-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const directory = await tempProject()
  const project = { id: "prj_1", canonical: directory, directory }
  let harnessContext: HarnessAdapterContext | undefined
  const runtime = await createFlowgraphRuntime({
    project,
    storage: new FileSystemStoragePort({ directory: path.join(directory, ".flowgraph", "state") }),
    harness: (context) => {
      harnessContext = context
      return new FakeHarness(context.intake, (input) => ({
        report: input.agent === "developer"
          ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
          : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
      }))
    },
    options: { recoverOnStart: false, pollIntervalMs: 5, recoveryGraceMs: 20 },
    instanceID: "inst_runtime",
    now: () => 10_000,
  })
  runtimes.push(runtime)
  return { directory, project, runtime, harnessContext: () => harnessContext! }
}

describe("createFlowgraphRuntime", () => {
  it("composes the store, intake, invocations, runner, repository, and service", async () => {
    const { runtime, harnessContext } = await setup()
    expect(runtime.intake).toBe(harnessContext().intake)
    expect(runtime.invocations).toBe(harnessContext().invocations)
    expect(runtime.service).toBeDefined()
    expect(runtime.repo.root).toBe(path.join(runtime.project.directory, ".flowgraph", "workflows"))
    expect(runtime.workflowRoot).toBe(runtime.repo.root)
  })

  it("starts and shuts down idempotently", async () => {
    const { runtime } = await setup()
    await runtime.start()
    await runtime.start()
    await runtime.shutdown()
    await runtime.shutdown()
  })

  it("runs a workflow through the portable service", async () => {
    const { runtime, project } = await setup()
    await runtime.start()
    await runtime.service.saveWorkflow("sample", source, null)
    expect(await fs.readdir(path.join(project.directory, ".flowgraph", "workflows"))).toEqual(["sample.yaml"])

    const started = await runtime.service.startRun("sample", "implement it", "request-runtime")
    const final = await waitForRun(runtime.store, project.id, started.runID, (run) => run.status === "completed")
    expect(final.status).toBe("completed")
    expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "reviewer"])
  })

  it("recovers a project without active runs", async () => {
    const { runtime } = await setup()
    await runtime.start()
    await expect(runtime.recover()).resolves.toBeUndefined()
  })

  it("recovers a persisted running run shortly after start", async () => {
    const directory = await tempProject()
    const project = { id: "prj_auto", canonical: directory, directory }
    const state = () => new FileSystemStoragePort({ directory: path.join(directory, ".flowgraph", "state") })
    let native: FakeHarness | undefined
    const first = await createFlowgraphRuntime({
      project,
      storage: state(),
      harness: (context) => {
        native = new FakeHarness(context.intake, () => ({
          delayMs: 60_000,
          report: { outcome: "done", summary: "still running", feedback: "", evidence: [] },
        }))
        return native
      },
      options: { recoverOnStart: false, pollIntervalMs: 5, recoveryGraceMs: 20 },
      instanceID: "inst_first",
      now: () => 10_000,
    })
    runtimes.push(first)
    await first.service.saveWorkflow("sample", source, null)
    const started = await first.service.startRun("sample", "recover me", "recover-request")
    await waitForRun(first.store, project.id, started.runID, (run) => run.activeStep !== null)
    await first.shutdown()

    const second = await createFlowgraphRuntime({
      project,
      storage: state(),
      harness: native!,
      options: { pollIntervalMs: 5, recoveryGraceMs: 20, recoveryDelayMs: 20 },
      instanceID: "inst_second",
      now: () => 10_000,
    })
    runtimes.push(second)
    await second.start()
    const recovered = await waitForRun(second.store, project.id, started.runID, (run) => run.status === "blocked")
    expect(recovered.recovery.attempts).toBe(1)
    expect(recovered.blocker?.type).toBe("node_interrupted")
  })

  it("cancels scheduled automatic recovery on shutdown", async () => {
    const directory = await tempProject()
    const project = { id: "prj_timer", canonical: directory, directory }
    const runtime = await createFlowgraphRuntime({
      project,
      storage: new FileSystemStoragePort({ directory: path.join(directory, "state") }),
      harness: (context) => new FakeHarness(context.intake, () => ({ report: { outcome: "done", summary: "ok", feedback: "", evidence: [] } })),
      options: { recoveryDelayMs: 40 },
      instanceID: "inst_timer",
    })
    runtimes.push(runtime)
    let calls = 0
    runtime.service.recover = async () => { calls += 1 }
    await runtime.start()
    await runtime.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(0)
  })

  it("rejects an invalid harness capability contract", async () => {
    const directory = await tempProject()
    const invalid = { capabilities: { id: "" } } as unknown as HarnessAdapter
    await expect(createFlowgraphRuntime({
      project: { id: "prj_1", canonical: directory, directory },
      storage: new FileSystemStoragePort({ directory: path.join(directory, "state") }),
      harness: invalid,
    })).rejects.toBeDefined()
  })
})
