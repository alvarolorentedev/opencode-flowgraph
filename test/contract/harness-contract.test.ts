// Contract tests for the portable HarnessAdapter. A future adapter should
// provide the same fixture shape and run these scenarios against it.
import { afterEach, describe, expect, it } from "vitest"
import { WorkflowStore } from "../../src/state/store.js"
import { RunLockManager } from "../../src/state/concurrency.js"
import { WorkflowRunner, NotResumableError } from "../../src/execution/runner.js"
import { createInvocationRegistry, ReportIntake } from "../../src/execution/report-intake.js"
import { FakeHarness, type Behavior, type FakeHarnessOptions } from "../fixtures/fake-harness.js"
import { MemoryStorage, makeRunRecord, source, waitForRun } from "../fixtures/memory.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { activeSteps } from "../../src/execution/checkpoint.js"

const runners: WorkflowRunner[] = []
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()))
})

function setup(options: FakeHarnessOptions = {}, scenario?: (input: { nodeID: string; agent: string }, count: number) => Behavior) {
  const store = new WorkflowStore(new MemoryStorage())
  const invocations = createInvocationRegistry()
  const intake = new ReportIntake(store, invocations)
  const harness = new FakeHarness(
    intake,
    scenario ?? ((input) => ({
      report: input.agent === "developer"
        ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
        : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
    })),
    options,
  )
  const runner = new WorkflowRunner({
    store,
    harness,
    locks: new RunLockManager(),
    invocations,
    emit: async () => undefined,
    now: () => 2_000,
    options: { pollIntervalMs: 5, recoveryGraceMs: 30 },
  })
  runners.push(runner)
  return { store, invocations, intake, harness, runner }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for contract condition")
}

describe("harness contract", () => {
  it("discovers, creates, submits, inspects, and cancels native work", async () => {
    const { harness, store, invocations } = setup({}, (_input, count) => count === 1
      ? { report: { outcome: "done", summary: "implemented", feedback: "", evidence: [] } }
      : { delayMs: 10_000 })
    const agents = await harness.listAgents()
    expect(agents.find((agent) => agent.id === "developer")?.selectable).toBe(true)
    expect(await harness.resolveAgent("missing")).toBeUndefined()

    const scope = await harness.createRunScope!({ title: "run", metadata: {} })
    const session = await harness.createSession({
      parent: scope.ref,
      agentRef: "developer",
      title: "node",
      metadata: {},
    })
    invocations.register({
      runID: "run_1",
      projectID: "prj_1",
      stepID: "step_1",
      sessionID: session.ref,
      nodeID: "developer",
      allowedOutcomes: [],
      attempt: 1,
      reported: 0,
    })
    await harness.submit({ session: session.ref, submission: "msg_1", text: "do it" })
    await waitFor(async () => (await harness.inspect(session.ref)).state === "succeeded")
    expect(await harness.submissionState!(session.ref, "msg_1")).toBe("admitted")
    expect(await harness.pendingPermissions(session.ref)).toEqual({ state: "none" })
    await waitFor(async () => (await store.getReport("prj_1", "run_1", "step_1")) !== undefined)

    const slow = await harness.createSession({ agentRef: "developer", title: "slow", metadata: {} })
    await harness.submit({ session: slow.ref, submission: "msg_2", text: "wait", metadata: {} })
    expect(await harness.cancel(slow.ref)).toBe(true)
    expect((await harness.inspect(slow.ref)).state).toBe("interrupted")
  })

  it("validates, dedupes, and attributes structured reports", async () => {
    const { intake, invocations, store } = setup()
    invocations.register({
      runID: "run_1",
      projectID: "prj_1",
      stepID: "step_1",
      sessionID: "session_1",
      nodeID: "reviewer",
      allowedOutcomes: ["approved", "blocked"],
      attempt: 2,
      reported: 0,
    })
    const base = {
      session: "session_1",
      messageRef: "message_1",
      toolCallRef: "call_1",
      result: { outcome: "approved", summary: "looks good", feedback: "", evidence: [] },
    }
    const first = await intake.submit(base)
    expect(first).toMatchObject({
      runID: "run_1",
      stepID: "step_1",
      sessionID: "session_1",
      attempt: 2,
      result: { outcome: "approved" },
    })
    expect((await intake.submit(base)).toolCallID).toBe("call_1")
    await expect(intake.submit({
      ...base,
      result: { ...base.result, summary: "different" },
    })).rejects.toThrow(/different result/)
    await expect(intake.submit({
      ...base,
      toolCallRef: "call_2",
      result: { ...base.result, outcome: "unknown" },
    })).rejects.toThrow(/not declared/)
    expect((await store.getReport("prj_1", "run_1", "step_1"))?.toolCallID).toBe("call_1")
  })

  it("runs without a native run scope", async () => {
    const { store, runner } = setup({ runScope: false })
    const run = await store.createRun(makeRunRecord({ runSessionID: null }))
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status !== "running")
    expect(final.status).toBe("completed")
    expect(final.runSessionID).toBeNull()
  })

  it("fails immediately when the harness cannot correct a missing result", async () => {
    const { store, runner, harness } = setup({ corrections: false }, () => ({ outcome: "succeeded" }))
    const run = await store.createRun(makeRunRecord())
    await runner.start("prj_1", run.runID)
    const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status !== "running")
    expect(final.status).toBe("failed")
    expect(final.failure?.code).toBe("missing_structured_result")
    expect(harness.prompts).toHaveLength(1)
  })

  it("blocks when permissions are unknown and refuses resume", async () => {
    const { store, runner } = setup({ permissions: "unknown" })
    const run = await store.createRun(makeRunRecord())
    await runner.start("prj_1", run.runID)
    const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
    expect(blocked.blocker?.type).toBe("ambiguous_node")
    await expect(runner.resume("prj_1", run.runID, blocked.revision, "resume-1", false))
      .rejects.toBeInstanceOf(NotResumableError)
  })

  it("blocks a node that finished after restart without a report", async () => {
    const workflow = parseWorkflowSource(`version: 1
name: sample
entry: a
limits: { max_steps: 2, timeout_seconds: 60 }
nodes:
  a: { agent: developer, next: complete }
`, { workflowID: "sample" }).workflow!
    const { store, harness, runner, invocations } = setup({}, () => ({ outcome: "succeeded" }))
    const run = await store.createRun(makeRunRecord({
      workflowSnapshot: workflow,
      maxSteps: 2,
      nextNode: "a",
    }))
    const scope = await harness.createRunScope!({ title: "run", metadata: {} })
    const session = await harness.createSession({ parent: scope.ref, agentRef: "developer", title: "a", metadata: {} })
    const stepID = "step_000001_a001"
    invocations.register({
      runID: run.runID,
      projectID: "prj_1",
      stepID,
      sessionID: session.ref,
      nodeID: "a",
      allowedOutcomes: [],
      attempt: 1,
      reported: 0,
    })
    await harness.submit({ session: session.ref, submission: "msg_1", text: "do it" })
    await waitFor(async () => (await harness.inspect(session.ref)).state === "succeeded")
    await store.mutateRun("prj_1", run.runID, null, (draft) => {
      draft.runSessionID = scope.ref
      draft.currentNode = "a"
      draft.nextNode = "a"
      draft.stepCount = 1
      draft.activeStep = {
        stepID,
        stepIndex: 1,
        attempt: 1,
        nodeID: "a",
        agentID: "developer",
        sessionID: session.ref,
        promptMessageID: "msg_1",
        phase: "prompted",
        startedAt: 1_000,
        promptedAt: 1_000,
        resultAttempts: 0,
      }
    })
    await runner.recoverProject("prj_1")
    const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
    expect(blocked.blocker?.type).toBe("missing_report")
    expect(activeSteps(blocked)).toHaveLength(1)
  })
})
