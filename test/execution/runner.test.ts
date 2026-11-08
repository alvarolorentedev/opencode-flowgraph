import { describe, expect, it } from "vitest"
import { WorkflowStore } from "../../src/state/store.js"
import { ProjectLockManager } from "../../src/state/concurrency.js"
import { createInvocationRegistry } from "../../src/execution/report-tool.js"
import { WorkflowRunner, type RunUpdatedPayload } from "../../src/execution/runner.js"
import { FakeNative, type Behavior } from "../fixtures/fake-native.js"
import { MemoryStorage, makeRunRecord, source, waitForRun } from "../fixtures/memory.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { RunRecordSchema, type RunRecord } from "../../src/state/types.js"
import { zeroUsage } from "../../src/execution/results.js"

function setup(scenario: (input: { nodeID: string; agent: string }, callIndex: number) => Behavior) {
  const storage = new MemoryStorage()
  const store = new WorkflowStore(storage)
  const native = new FakeNative(store, "prj_1", (log, index) => scenario(log, index))
  const locks = new ProjectLockManager()
  const invocations = createInvocationRegistry()
  const events: RunUpdatedPayload[] = []
  const runner = new WorkflowRunner({
    store,
    native,
    locks,
    invocations,
    emit: async (event) => {
      events.push(event)
    },
    now: () => 2_000,
    options: { pollIntervalMs: 5, recoveryGraceMs: 50 },
  })
  return { storage, store, native, locks, invocations, runner, events }
}

async function createRun(
  store: WorkflowStore,
  overrides: Partial<RunRecord> = {},
  workflowSource = source,
): Promise<RunRecord> {
  const workflow = parseWorkflowSource(workflowSource, { workflowID: "sample" }).workflow!
  const base = makeRunRecord({
    project: { id: "prj_1", canonical: `/tmp/awf-${Math.random().toString(36).slice(2)}`, directory: "/tmp/project" },
    workflowSnapshot: workflow,
    maxSteps: workflow.limits.max_steps,
    nextNode: workflow.entry,
    ...overrides,
  })
  return store.createRun(base)
}

describe("WorkflowRunner", () => {
  it("runs the development loop and completes after an approval", async () => {
    const { store, native, runner } = setup((input, callIndex) => {
      if (input.agent === "developer") {
        return { report: { outcome: "done", summary: "implemented", feedback: "", evidence: [] } }
      }
      return {
        report: {
          outcome: callIndex === 1 ? "changes_requested" : "approved",
          summary: callIndex === 1 ? "needs a fix" : "looks good",
          feedback: callIndex === 1 ? "fix the bug" : "",
          evidence: [],
        },
      }
    })
    const run = await createRun(store)
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status !== "running")
    expect(final.status).toBe("completed")
    expect(final.stepCount).toBe(4)
    expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "reviewer", "developer", "reviewer"])
    expect(native.prompts.map((prompt) => prompt.agent)).toEqual(["developer", "reviewer", "developer", "reviewer"])
    expect(new Set(native.prompts.map((prompt) => prompt.sessionID)).size).toBe(4)
  })

  it("stops when max_steps is exhausted", async () => {
    const workflow = `version: 1
name: sample
entry: developer
limits: { max_steps: 2, timeout_seconds: 60, max_repeat_transitions: 10 }
nodes:
  developer: { agent: developer, next: reviewer }
  reviewer:
    agent: reviewer
    routes: { changes_requested: developer, approved: complete, blocked: pause }
`
    const { store, runner } = setup((input) => {
      if (input.agent === "developer") return { report: { outcome: "done", summary: "work", feedback: "", evidence: [] } }
      return { report: { outcome: "changes_requested", summary: "again", feedback: "again", evidence: [] } }
    })
    const run = await createRun(store, {}, workflow)
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "failed")
    expect(final.failure?.code).toBe("max_steps_exhausted")
  })

  it("stops a self-loop that makes no progress", async () => {
    const workflow = `version: 1
name: sample
entry: loop
limits: { max_steps: 20, timeout_seconds: 60, max_repeat_transitions: 1 }
nodes:
  loop:
    agent: developer
    routes: { again: loop, done: complete }
`
    const { store, runner } = setup(() => ({
      report: { outcome: "again", summary: "same", feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, workflow)
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "failed")
    expect(final.failure?.code).toBe("no_progress")
  })

  it("bounds correction turns when an agent does not report", async () => {
    const workflow = `version: 1
name: sample
entry: developer
limits: { max_steps: 2, timeout_seconds: 60, max_result_retries: 1 }
nodes:
  developer: { agent: developer, next: complete }
`
    const { store, native, runner } = setup(() => ({ outcome: "succeeded" }))
    const run = await createRun(store, {}, workflow)
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "failed")
    expect(final.failure?.code).toBe("missing_structured_result")
    expect(native.prompts.length).toBe(2)
  })

  it("exposes native permission blockers and resumes after the decision", async () => {
    const { store, native, runner } = setup((input) => ({
      pendingPermission: input.agent === "developer",
      report:
        input.agent === "developer"
          ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
          : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
    }))
    const run = await createRun(store)
    await runner.start("prj_1", run.runID)
    const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
    expect(blocked.blocker?.type).toBe("permission")
    const sessionID = blocked.activeStep!.sessionID
    await expect(runner.resume("prj_1", run.runID, blocked.revision, "resume-1", false)).rejects.toMatchObject({
      name: "PermissionPendingError",
    })
    native.release(sessionID)
    await runner.resume("prj_1", run.runID, blocked.revision, "resume-1", false)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.status).toBe("completed")
  })

  it("pauses safely between nodes and resumes", async () => {
    const { store, runner } = setup((input) => ({
      delayMs: input.agent === "developer" ? 50 : 0,
      report:
        input.agent === "developer"
          ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
          : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
    }))
    const run = await createRun(store)
    await runner.start("prj_1", run.runID)
    const active = await waitForRun(store, "prj_1", run.runID, (item) => item.activeStep !== null)
    const pausing = await runner.pause("prj_1", run.runID, active.revision, "pause-1")
    expect(pausing.status).toBe("pausing")
    const paused = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "paused")
    expect(paused.stepCount).toBe(1)
    expect(paused.nextNode).toBe("reviewer")
    await runner.resume("prj_1", run.runID, paused.revision, "resume-pause-1", false)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.status).toBe("completed")
  })

  it("cancels an active node", async () => {
    const { store, runner } = setup(() => ({ delayMs: 10_000, report: { outcome: "done", summary: "x", feedback: "", evidence: [] } }))
    const run = await createRun(store)
    await runner.start("prj_1", run.runID)
    const active = await waitForRun(store, "prj_1", run.runID, (item) => item.activeStep !== null)
    const cancelled = await runner.cancel("prj_1", run.runID, active.revision, "cancel-1")
    expect(cancelled.status).toBe("cancelled")
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "cancelled")
    expect(final.status).toBe("cancelled")
  })

  it("recovers a node that completed before the run checkpoint", async () => {
    const workflow = `version: 1
name: sample
entry: a
limits: { max_steps: 2, timeout_seconds: 60 }
nodes:
  a: { agent: developer, next: complete }
`
    const { store, native, runner } = setup(() => ({
      report: { outcome: "done", summary: "done", feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, workflow)
    const root = await native.createRootSession({ title: "root", metadata: {} })
    const node = await native.createSession({ parentID: root.id, agent: "developer", title: "a", metadata: {} })
    const stepID = "step_000001_a001"
    await native.prompt({
      sessionID: node.id,
      messageID: "msg_recovery_1",
      text: "do it",
      metadata: { runID: run.runID, stepID, nodeID: "a" },
    })
    const seeded = await store.mutateRun("prj_1", run.runID, null, (draft) => {
      draft.runSessionID = root.id
      draft.currentNode = "a"
      draft.nextNode = "a"
      draft.stepCount = 1
      draft.activeStep = {
        stepID,
        stepIndex: 1,
        attempt: 1,
        nodeID: "a",
        agentID: "developer",
        sessionID: node.id,
        promptMessageID: "msg_recovery_1",
        phase: "prompted",
        startedAt: 1_000,
        promptedAt: 1_000,
        resultAttempts: 0,
      }
    })
    expect(seeded.activeStep).not.toBeNull()
    await runner.recoverProject("prj_1")
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.status).toBe("completed")
    expect(final.stepCount).toBe(1)
  })

  it("creates each node session with its agent's model, falling back to the default model", async () => {
    const workflow = `version: 1
name: sample
entry: developer
limits: { max_steps: 2, timeout_seconds: 60 }
nodes:
  developer: { agent: developer, next: opus-reviewer }
  opus-reviewer: { agent: opus-reviewer, next: complete }
`
    const { store, native, runner } = setup(() => ({
      report: { outcome: "done", summary: "done", feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, workflow)
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "opus-reviewer"])
    const sessions = Array.from(native.sessions.values())
    const developerSession = sessions.find((session) => session.agent === "developer")
    const opusSession = sessions.find((session) => session.agent === "opus-reviewer")
    expect(developerSession?.model).toEqual({ providerID: "test", id: "model" })
    expect(opusSession?.model).toEqual({ providerID: "anthropic", id: "claude-opus-4" })
  })

  it("preserves distinct configured models and variants for each node", async () => {
    const workflow = `version: 1
name: sample
entry: developer
limits: { max_steps: 3, timeout_seconds: 60 }
nodes:
  developer: { agent: developer, next: opus-reviewer }
  opus-reviewer: { agent: opus-reviewer, next: variant-reviewer }
  variant-reviewer: { agent: variant-reviewer, next: complete }
`
    const { store, native, runner } = setup(() => ({
      report: { outcome: "done", summary: "done", feedback: "", evidence: [] },
    }))
    native.agents.find((agent) => agent.id === "developer")!.model = { providerID: "openai", id: "gpt-4.1" }
    native.agents.push({
      id: "variant-reviewer",
      name: "Variant Reviewer",
      mode: "primary",
      hidden: false,
      model: { providerID: "anthropic", id: "claude-sonnet-4", variant: "low" },
    })
    const run = await createRun(store, {}, workflow)
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "opus-reviewer", "variant-reviewer"])
    const sessions = Array.from(native.sessions.values())
    expect(sessions.find((session) => session.agent === "developer")?.model).toEqual({ providerID: "openai", id: "gpt-4.1" })
    expect(sessions.find((session) => session.agent === "opus-reviewer")?.model).toEqual({ providerID: "anthropic", id: "claude-opus-4" })
    expect(sessions.find((session) => session.agent === "variant-reviewer")?.model).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4",
      variant: "low",
    })
  })

  it("blocks an ambiguous active node after restart", async () => {
    const workflow = `version: 1
name: sample
entry: a
limits: { max_steps: 2, timeout_seconds: 60 }
nodes:
  a: { agent: developer, next: complete }
`
    const { store, native, runner } = setup(() => ({ delayMs: 10_000 }))
    const run = await createRun(store, {}, workflow)
    const root = await native.createRootSession({ title: "root", metadata: {} })
    const node = await native.createSession({ parentID: root.id, agent: "developer", title: "a", metadata: {} })
    await store.mutateRun("prj_1", run.runID, null, (draft) => {
      draft.runSessionID = root.id
      draft.currentNode = "a"
      draft.nextNode = "a"
      draft.stepCount = 1
      draft.activeStep = {
        stepID: "step_000001_a001",
        stepIndex: 1,
        attempt: 1,
        nodeID: "a",
        agentID: "developer",
        sessionID: node.id,
        promptMessageID: "msg_ambiguous_1",
        phase: "prompted",
        startedAt: 1_000,
        promptedAt: 1_000,
        resultAttempts: 0,
      }
    })
    await runner.recoverProject("prj_1")
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
    expect(final.blocker?.type).toBe("ambiguous_node")
  })
})
