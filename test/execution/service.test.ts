import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorkflowService, IdempotencyConflictError, InvalidWorkflowError } from "../../src/service.js"
import { WorkflowRunner } from "../../src/execution/runner.js"
import { RunLockManager } from "../../src/state/concurrency.js"
import { WorkflowStore } from "../../src/state/store.js"
import { createInvocationRegistry } from "../../src/execution/report-tool.js"
import { FakeNative, type Behavior, type PromptLog } from "../fixtures/fake-native.js"
import { MemoryStorage, source, waitForRun } from "../fixtures/memory.js"
import { WorkflowRepository } from "../../src/workflow/loader.js"

const dirs: string[] = []
const runners: WorkflowRunner[] = []
async function tempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-service-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function setup(scenario?: (input: PromptLog, count: number) => Behavior) {
  const directory = await tempProject()
  const project = { id: "prj_1", canonical: directory, directory }
  const storage = new MemoryStorage()
  const store = new WorkflowStore(storage)
  const native = new FakeNative(store, project.id, scenario ?? ((input) => ({
    report:
      input.agent === "developer"
        ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
        : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
  })))
  const repo = new WorkflowRepository(directory)
  const newService = () => {
    const runner = new WorkflowRunner({
      store, native, locks: new RunLockManager(), invocations: createInvocationRegistry(),
      emit: async () => undefined,
      now: () => 2_000,
      options: { pollIntervalMs: 5, recoveryGraceMs: 50 },
    })
    runners.push(runner)
    const service = new WorkflowService({
      project, store, runner, native, repo, instanceID: "inst_test",
      emit: async () => undefined,
      now: () => 2_000,
    })
    return { runner, service }
  }
  return { directory, project, store, native, newService, ...newService() }
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
    expect(runs[0]?.runSessionID).toBe(final.runSessionID)

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

const parent = `version: 1
name: parent
entry: prep
limits: { max_steps: 5 }
nodes:
  prep: { agent: developer, next: check }
  check: { workflow: child, routes: { complete: accepted, pause: inspect } }
  accepted: { agent: reviewer, next: complete }
  inspect: { agent: reviewer, next: complete }
`
const child = `version: 1
name: child
entry: scan
limits: { max_steps: 1 }
nodes:
  scan: { agent: developer, next: decide }
  decide: { agent: reviewer, routes: { approved: complete, blocked: pause } }
`

describe("workflow composition and concurrent starts", () => {
  it("routes both child exits within the parent and snapshots child definitions at admission", async () => {
    const { service, store, project, native } = await setup((input, count) => ({
      pendingPermission: input.nodeID === "prep" && count === 1,
      report: {
        outcome: input.nodeID === "decide" ? (input.text.includes("inspect this") ? "blocked" : "approved") : "done",
        summary: input.nodeID, feedback: "", evidence: [],
      },
    }))
    const saved = await service.saveWorkflow("child", child, null)
    await service.saveWorkflow("parent", parent, null)

    const started = await service.startRun("parent", "approve this", "a")
    const waiting = await waitForRun(store, project.id, started.runID, (run) => run.status === "blocked")
    const modified = await service.saveWorkflow("child", child.replaceAll("scan", "rescan"), saved.hash)
    native.release(waiting.activeStep!.sessionID)

    const complete = await waitForRun(store, project.id, started.runID, (run) => run.status === "completed")
    expect(complete.workflowDependencies?.child?.hash).toBe(saved.hash)
    expect(complete.steps.map((step) => step.nodeID)).toEqual(["prep", "scan", "decide", "accepted"])
    expect(complete.stepCount).toBe(4)
    expect(native.prompts.find((prompt) => prompt.nodeID === "scan")!.text).toContain("<summary>prep</summary>")
    expect(native.prompts.find((prompt) => prompt.nodeID === "accepted")!.text).toContain("<summary>decide</summary>")
    expect(native.prompts.find((prompt) => prompt.nodeID === "accepted")!.text).not.toContain("<summary>scan</summary>")
    const graph = await service.getRunGraph(started.runID)
    const call = graph.nodes.find((node) => node.nodeID === "check")
    expect(call?.childSteps?.map((step) => [step.workflowID, step.callPath, step.nodeID])).toEqual([
      ["child", ["check"], "scan"], ["child", ["check"], "decide"],
    ])

    const second = await service.startRun("parent", "inspect this", "b")
    const pausedChild = await waitForRun(store, project.id, second.runID, (run) => run.status === "completed")
    expect(pausedChild.workflowDependencies?.child?.hash).toBe(modified.hash)
    expect(pausedChild.steps.map((step) => step.nodeID)).toEqual(["prep", "rescan", "decide", "inspect"])
  })

  it("checks missing children and recursion against the proposed source", async () => {
    const { service } = await setup()
    const missing = await service.validateWorkflowSource(parent, "parent")
    expect(missing.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_workflow_reference" })]))
    await service.saveWorkflow("child", child, null)
    await service.saveWorkflow("parent", parent, null)
    const recursive = child.replace("scan: { agent: developer, next: decide }", "scan: { workflow: parent, routes: { complete: decide, pause: decide } }")
    const validation = await service.validateWorkflowSource(recursive, "child")
    expect(validation.valid).toBe(false)
    expect(validation.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "recursive_workflow" })]))
  })

  it("admits distinct same-checkout runs, deduplicates requests, and routes controls to the owning runner", async () => {
    const { service, store, native, project, newService } = await setup(({ nodeID }) => ({
      pendingPermission: nodeID === "developer",
      report: { outcome: nodeID === "developer" ? "done" : "approved", summary: nodeID, feedback: "", evidence: [] },
    }))
    const { service: other } = newService()
    await service.saveWorkflow("sample", source, null)
    const [first, duplicate, second] = await Promise.all([
      service.startRun("sample", "first", "same-key"),
      other.startRun("sample", "first", "same-key"),
      other.startRun("sample", "second", "second-key"),
    ])
    expect(duplicate.runID).toBe(first.runID)
    expect(second.runID).not.toBe(first.runID)
    await expect(other.startRun("sample", "conflict", "same-key")).rejects.toBeInstanceOf(IdempotencyConflictError)

    const [left, right] = await Promise.all([first, second].map(({ runID }) =>
      waitForRun(store, project.id, runID, (run) => run.status === "blocked"),
    ))
    expect((await service.listRuns()).length).toBe(2)
    expect(native.prompts).toHaveLength(2)
    await other.cancelRun(left!.runID, "cancel", left!.revision)
    expect((await native.getSession(left!.activeStep!.sessionID)).outcome).toBe("interrupted")
    expect((await service.getRun(right!.runID)).pendingPermissions).toHaveLength(1)

    native.release(right!.activeStep!.sessionID)
    await waitForRun(store, project.id, right!.runID, (run) => run.status === "completed")
    expect((await service.getRun(left!.runID)).run.status).toBe("cancelled")
  })

  it("recovers multiple same-checkout runs independently", async () => {
    const { service, store, native, project, runner, newService } = await setup(({ nodeID }) => ({
      pendingPermission: nodeID === "developer",
      report: { outcome: nodeID === "developer" ? "done" : "approved", summary: nodeID, feedback: "", evidence: [] },
    }))
    await service.saveWorkflow("sample", source, null)
    const starts = await Promise.all(["left", "right"].map((key) => service.startRun("sample", key, key)))
    const waiting = await Promise.all(starts.map(({ runID }) => waitForRun(store, project.id, runID, (run) => run.status === "blocked")))
    await runner.shutdown()
    for (const run of waiting) native.release(run.activeStep!.sessionID)
    await newService().service.recover()
    const recovered = await Promise.all(starts.map(({ runID }) => waitForRun(store, project.id, runID, (run) => run.status === "completed")))
    expect(recovered.map((run) => run.recovery.attempts)).toEqual([1, 1])
    expect(native.prompts.map((prompt) => prompt.nodeID).sort()).toEqual(["developer", "developer", "reviewer", "reviewer"])
  })
})
