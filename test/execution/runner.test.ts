import { afterEach, describe, expect, it } from "vitest"
import { WorkflowStore } from "../../src/state/store.js"
import { RunLockManager } from "../../src/state/concurrency.js"
import { createInvocationRegistry } from "../../src/execution/report-tool.js"
import { WorkflowRunner, type RunUpdatedPayload } from "../../src/execution/runner.js"
import { FakeNative, type Behavior } from "../fixtures/fake-native.js"
import { MemoryStorage, makeRunRecord, source, waitForRun } from "../fixtures/memory.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { RunRecordSchema, type RunRecord } from "../../src/state/types.js"
import { activeSteps } from "../../src/execution/checkpoint.js"
import { buildRunGraph } from "../../src/execution/run-graph.js"
import { zeroUsage } from "../../src/execution/results.js"

const runners: WorkflowRunner[] = []
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()))
})

function setup(scenario: (input: { nodeID: string; agent: string }, callIndex: number) => Behavior) {
  const storage = new MemoryStorage()
  const store = new WorkflowStore(storage)
  const native = new FakeNative(store, "prj_1", (log, index) => scenario(log, index))
  const locks = new RunLockManager()
  const invocations = createInvocationRegistry()
  const events: RunUpdatedPayload[] = []
  const newRunner = () => {
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
    runners.push(runner)
    return runner
  }
  const runner = newRunner()
  return { storage, store, native, locks, invocations, runner, newRunner, events }
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

const parallel = `version: 1
name: sample
entry: dispatch
limits: { max_steps: 12 }
nodes:
  dispatch: { fork: [left, right], join: merge }
  left: { agent: developer, next: merge }
  right: { agent: reviewer, next: followup }
  followup: { agent: reviewer, next: merge }
  merge:
    agent: developer
    routes: { again: dispatch, done: complete }
`

describe("parallel workflow checkpoints", () => {
  it("runs overlapping sessions, lets a sibling progress while blocked, and joins once per fork invocation", async () => {
    const { store, native, runner } = setup(({ nodeID }, count) => ({
      pendingPermission: count === 1 && (nodeID === "left" || nodeID === "right"),
      report: { outcome: nodeID === "merge" && count === 1 ? "again" : "done", summary: nodeID, feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, parallel)
    await runner.start("prj_1", run.runID)
    const waiting = await waitForRun(store, "prj_1", run.runID, (item) => item.pendingPermissions.length === 2)
    const steps = activeSteps(waiting)
    expect(steps.map((step) => step.nodeID)).toEqual(["left", "right"])
    expect(buildRunGraph(waiting).nodes.filter((node) => node.state === "active").map((node) => node.nodeID)).toEqual(["left", "right"])
    native.release(steps[1]!.sessionID)

    const arrived = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked" && item.steps.some((step) => step.nodeID === "followup"))
    expect(arrived.steps.map((step) => step.nodeID)).toEqual(["right", "followup"])
    expect(native.prompts.some((prompt) => prompt.nodeID === "merge")).toBe(false)
    native.release(steps[0]!.sessionID)

    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    const joins = native.prompts.filter((prompt) => prompt.nodeID === "merge")
    expect(joins).toHaveLength(2)
    expect(joins[0]!.text).toMatch(/<summary>left<\/summary>[\s\S]*<summary>followup<\/summary>/)
    expect(native.prompts.find((prompt) => prompt.nodeID === "followup")!.text).not.toContain("<summary>left</summary>")
    expect(final.stepCount).toBe(8)
    expect(new Set(final.steps.map((step) => step.stepID)).size).toBe(8)
  })

  it("restores a partial join after restart without admitting completed steps again", async () => {
    const { store, native, runner, newRunner } = setup(({ nodeID }) => ({
      pendingPermission: nodeID === "left",
      report: { outcome: "done", summary: nodeID, feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, parallel)
    await runner.start("prj_1", run.runID)
    const before = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked" && item.steps.length === 2)
    await runner.shutdown()
    native.release(before.activeStep!.sessionID)

    await newRunner().recoverProject("prj_1", run.project.canonical)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.recovery.attempts).toBe(1)
    expect(final.usage.input).toBe(40)
    expect(native.prompts.map((prompt) => prompt.nodeID)).toEqual(["left", "right", "followup", "merge"])
  })

  it("drains admitted siblings on pause and cancels every live session", async () => {
    const { store, native, runner } = setup(({ nodeID }) => ({
      pendingPermission: nodeID === "left" || nodeID === "right",
      report: { outcome: "done", summary: nodeID, feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, parallel)
    await runner.start("prj_1", run.runID)
    const waiting = await waitForRun(store, "prj_1", run.runID, (item) => item.pendingPermissions.length === 2)
    const steps = activeSteps(waiting)
    expect((await runner.pause("prj_1", run.runID, waiting.revision, "pause")).status).toBe("pausing")
    for (const step of steps) native.release(step.sessionID)
    const paused = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "paused")
    expect(native.prompts.map((prompt) => prompt.nodeID)).toEqual(["left", "right"])
    expect(paused.nextNode).toBe("followup")
    await runner.resume("prj_1", run.runID, paused.revision, "resume", false)
    await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")

    const another = await createRun(store, { runID: "run_parallel_cancel" }, parallel)
    await runner.start("prj_1", another.runID)
    const active = await waitForRun(store, "prj_1", another.runID, (item) => item.pendingPermissions.length === 2)
    const cancelled = await runner.cancel("prj_1", another.runID, active.revision, "cancel")
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.cancel?.interruptAccepted).toBe(true)
    expect(cancelled.steps.map((step) => step.status)).toEqual(["interrupted", "interrupted"])
    expect(activeSteps(cancelled)).toEqual([])
  })

  it("reserves unique steps under contention and enforces the root budget", async () => {
    const { store, native, runner } = setup(({ nodeID }) => ({
      report: { outcome: "done", summary: nodeID, feedback: "", evidence: [] },
    }))
    const workflow = parallel.replace("max_steps: 12", "max_steps: 3")
      .replace("left: { agent: developer, next: merge }", "left: { agent: developer, next: polish }\n  polish: { agent: developer, next: merge }")
    const run = await createRun(store, {}, workflow)
    await runner.start("prj_1", run.runID)
    const failed = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "failed")
    expect(failed.failure?.code).toBe("max_steps_exhausted")
    expect(failed.stepCount).toBe(3)
    expect(native.prompts).toHaveLength(3)
    expect(new Set(native.prompts.map((prompt) => prompt.stepID)).size).toBe(3)
  })

  it("retries only the ambiguous branch while another branch is live", async () => {
    const { store, native, runner } = setup(({ nodeID }, count) => ({
      ...(nodeID === "left" && count === 1 ? { outcome: "interrupted" } : {}),
      delayMs: nodeID === "right" ? 500 : 0,
      report: { outcome: "done", summary: nodeID, feedback: "", evidence: [] },
    }))
    const run = await createRun(store, {}, parallel)
    await runner.start("prj_1", run.runID)
    const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.blocker?.type === "node_interrupted")
    expect(blocked.status).toBe("running")
    await expect(runner.resume("prj_1", run.runID, blocked.revision, "resume", false)).rejects.toMatchObject({
      name: "AmbiguousResumeError",
    })
    await runner.resume("prj_1", run.runID, blocked.revision, "resume", true)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
    expect(final.steps.map((step) => step.status)).toContain("abandoned")
    expect(native.prompts.filter((prompt) => prompt.nodeID === "left")).toHaveLength(2)
    expect(native.prompts.filter((prompt) => prompt.nodeID === "right")).toHaveLength(1)
  })
})

it("recovers an unlocked run immediately and retries another run's lingering lock", async () => {
  const { store, native, locks, runner } = setup(() => ({
    report: { outcome: "done", summary: "done", feedback: "", evidence: [] },
  }))
  const workflow = `version: 1
name: sample
entry: task
limits: { max_steps: 1 }
nodes:
  task: { agent: developer, next: complete }
`
  const first = await createRun(store, {}, workflow)
  const second = await createRun(store, { runID: "run_busy_recovery", project: first.project }, workflow)
  const stale = await locks.acquire("prj_1", first.project.canonical, second.runID)
  try {
    await runner.recoverProject("prj_1", first.project.canonical)
    await waitForRun(store, "prj_1", first.runID, (item) => item.status === "completed")
    expect(native.prompts).toHaveLength(1)
  } finally {
    await stale.release()
  }
  await waitForRun(store, "prj_1", second.runID, (item) => item.status === "completed")
  expect(native.prompts).toHaveLength(2)
})

it("joins nested forks within a branch before admitting the outer join", async () => {
  const { store, native, runner } = setup(({ nodeID }) => ({
    report: { outcome: "done", summary: nodeID, feedback: "", evidence: [] },
  }))
  const workflow = `version: 1
name: sample
entry: outer
limits: { max_steps: 5 }
nodes:
  outer: { fork: [inner, security], join: publish }
  inner: { fork: [left, right], join: merge }
  left: { agent: developer, next: merge }
  right: { agent: reviewer, next: merge }
  merge: { agent: developer, next: publish }
  security: { agent: reviewer, next: publish }
  publish: { agent: reviewer, next: complete }
`
  const run = await createRun(store, {}, workflow)
  await runner.start("prj_1", run.runID)
  const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
  expect(final.stepCount).toBe(5)
  expect(native.prompts.map((prompt) => prompt.nodeID)).toEqual(["left", "right", "security", "merge", "publish"])
  expect(native.prompts.at(-1)?.text).toMatch(/<summary>merge<\/summary>[\s\S]*<summary>security<\/summary>/)
})
