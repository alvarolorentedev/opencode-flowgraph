import { describe, expect, it } from "vitest"
import { WorkflowStore } from "../../src/state/store.js"
import {
  createInvocationRegistry,
  ReportIntake,
  syntheticReportRef,
  type ActiveInvocation,
} from "../../src/execution/report-intake.js"
import { MemoryStorage } from "../fixtures/memory.js"

const approved = { outcome: "approved", summary: "looks good", feedback: "", evidence: [] }

function setup(overrides: Partial<ActiveInvocation> = {}) {
  const store = new WorkflowStore(new MemoryStorage())
  const invocations = createInvocationRegistry()
  const intake = new ReportIntake(store, invocations, () => 5_000)
  const invocation: ActiveInvocation = {
    runID: "run_1",
    projectID: "prj_1",
    stepID: "step_000001_a001",
    sessionID: "session_1",
    nodeID: "reviewer",
    allowedOutcomes: ["approved", "blocked"],
    attempt: 2,
    reported: 0,
    ...overrides,
  }
  invocations.register(invocation)
  return { store, invocations, intake, invocation }
}

const submission = {
  session: "session_1",
  messageRef: "message_1",
  toolCallRef: "call_1",
  result: approved,
}

describe("ReportIntake canonical reports", () => {
  it("persists the first valid report and treats an identical duplicate as idempotent", async () => {
    const { intake, invocation } = setup()
    const first = await intake.submit(submission)
    expect(first).toMatchObject({
      runID: "run_1",
      stepID: "step_000001_a001",
      sessionID: "session_1",
      messageID: "message_1",
      toolCallID: "call_1",
      attempt: 2,
    })
    expect(await intake.submit(submission)).toEqual(first)
    expect(invocation.reported).toBe(2)
  })

  it("keeps an identical duplicate idempotent after the per-step cap", async () => {
    const { intake } = setup()
    const first = await intake.submit(submission)
    for (let attempt = 0; attempt < 4; attempt += 1) await intake.submit(submission)
    expect(await intake.submit(submission)).toEqual(first)
    await expect(intake.submit({ ...submission, toolCallRef: "call_2" }))
      .rejects.toThrow(/too many workflow reports/)
  })

  it("rejects a conflicting result for the same reference without changing the canonical report", async () => {
    const { intake, store } = setup()
    await intake.submit(submission)
    await expect(intake.submit({
      ...submission,
      result: { ...approved, summary: "different" },
    })).rejects.toThrow(/different result/)
    expect((await store.getReport("prj_1", "run_1", "step_000001_a001"))?.result.summary).toBe("looks good")
  })

  it("rejects a second reference for a step that already has a canonical report", async () => {
    const { intake, store } = setup()
    await intake.submit(submission)
    await expect(intake.submit({
      ...submission,
      toolCallRef: "call_2",
      result: { ...approved, outcome: "blocked" },
    })).rejects.toThrow(/first valid report is canonical/)
    const stored = await store.getReport("prj_1", "run_1", "step_000001_a001")
    expect(stored).toMatchObject({ toolCallID: "call_1", result: { outcome: "approved" } })
  })

  it("serializes concurrent submissions so exactly one becomes canonical", async () => {
    const { intake, store } = setup()
    const settles = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => intake.submit({
        ...submission,
        toolCallRef: `call_${index}`,
        result: { ...approved, summary: `attempt ${index}` },
      })),
    )
    const fulfilled = settles.filter((item) => item.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)
    expect(settles.filter((item) => item.status === "rejected")).toHaveLength(5)
    const stored = await store.getReport("prj_1", "run_1", "step_000001_a001")
    expect(stored?.toolCallID).toBe(fulfilled[0]!.status === "fulfilled" ? fulfilled[0]!.value.toolCallID : "unreachable")
  })

  it("rejects an undeclared outcome before persistence", async () => {
    const { intake, store } = setup()
    await expect(intake.submit({
      ...submission,
      result: { ...approved, outcome: "unknown" },
    })).rejects.toThrow(/not declared/)
    expect(await store.getReport("prj_1", "run_1", "step_000001_a001")).toBeUndefined()
  })

  it("rejects a report outside an active invocation", async () => {
    const { intake } = setup()
    await expect(intake.submit({ ...submission, session: "session_other" }))
      .rejects.toThrow(/only available during an active workflow node session/)
  })

  it("recovers a persisted report after restart and keeps it canonical", async () => {
    const { store, invocations, intake } = setup()
    const first = await intake.submit(submission)

    const restartedInvocations = createInvocationRegistry()
    restartedInvocations.register({
      runID: "run_1",
      projectID: "prj_1",
      stepID: "step_000001_a001",
      sessionID: "session_1",
      nodeID: "reviewer",
      allowedOutcomes: ["approved", "blocked"],
      attempt: 2,
      reported: 0,
    })
    const restarted = new ReportIntake(store, restartedInvocations, () => 9_000)
    expect(await restarted.submit(submission)).toEqual(first)
    await expect(restarted.submit({ ...submission, toolCallRef: "call_after_restart" }))
      .rejects.toThrow(/first valid report is canonical/)
    expect((await store.getReport("prj_1", "run_1", "step_000001_a001"))?.toolCallID).toBe("call_1")
  })

  it("derives a bounded deterministic reference for transports without native IDs", async () => {
    const one = syntheticReportRef("run_1", "step_000001_a001", "session_1", 1)
    expect(one).toBe(syntheticReportRef("run_1", "step_000001_a001", "session_1", 1))
    expect(one).not.toBe(syntheticReportRef("run_1", "step_000001_a001", "session_1", 2))
    expect(one.startsWith("flowgraph:synthetic:")).toBe(true)
    expect(one.length).toBeLessThanOrEqual(128)

    const { intake, store } = setup()
    const result = { ...approved, outcome: "blocked" }
    await intake.submit({ ...submission, toolCallRef: one, result })
    expect(await intake.submit({ ...submission, toolCallRef: one, result })).toMatchObject({ toolCallID: one })
    await expect(intake.submit({
      ...submission,
      toolCallRef: syntheticReportRef("run_1", "step_000001_a001", "session_1", 2),
      result,
    })).rejects.toThrow(/first valid report is canonical/)
    expect((await store.getReport("prj_1", "run_1", "step_000001_a001"))?.toolCallID).toBe(one)
  })
})
