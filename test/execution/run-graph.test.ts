import { describe, expect, it } from "vitest"
import { buildRunGraph } from "../../src/execution/run-graph.js"
import { RunGraphOutputSchema } from "../../src/contract.js"
import { makeRunRecord } from "../fixtures/memory.js"

describe("buildRunGraph", () => {
  it("marks completed and active nodes and maps Mermaid IDs", () => {
    const run = makeRunRecord({
      status: "running",
      stepCount: 2,
      currentNode: "reviewer",
      steps: [
        {
          stepID: "step_000001_a001",
          seq: 1,
          nodeID: "developer",
          outcome: "done",
          status: "completed",
          sessionID: "sess_dev_1",
          startedAt: 1,
          completedAt: 2,
        },
      ],
      activeStep: {
        stepID: "step_000002_a001",
        stepIndex: 2,
        attempt: 1,
        nodeID: "reviewer",
        agentID: "reviewer",
        sessionID: "sess_rev_1",
        promptMessageID: "msg_1",
        phase: "prompted",
        startedAt: 3,
        promptedAt: 3,
        resultAttempts: 0,
      },
    } as never)
    const graph = buildRunGraph(run)
    expect(RunGraphOutputSchema.safeParse(graph).success).toBe(true)
    expect(graph.runSessionID).toBe("sess_run_1")
    expect(graph.activeNode).toBe("reviewer")
    expect(graph.nodes.find((node) => node.nodeID === "developer")).toMatchObject({
      state: "completed",
      sessionIDs: ["sess_dev_1"],
      stepCount: 1,
    })
    expect(graph.nodes.find((node) => node.nodeID === "reviewer")).toMatchObject({
      state: "active",
      sessionIDs: ["sess_rev_1"],
      stepCount: 1,
    })
    expect(graph.activeMermaidID).toBe(graph.mermaidNodes.find((node) => node.nodeID === "reviewer")?.mermaidID)
    expect(graph.edges.some((edge) => edge.from === "reviewer" && edge.to === "complete" && edge.terminal)).toBe(true)
    expect(graph.controls).toEqual({ canPause: true, canResume: false, canCancel: true })
  })

  it("marks a paused next node", () => {
    const run = makeRunRecord({
      status: "paused",
      stepCount: 1,
      currentNode: "reviewer",
      nextNode: "reviewer",
      pause: { reason: "user", requestedAt: 5 },
      steps: [
        {
          stepID: "step_000001_a001",
          seq: 1,
          nodeID: "developer",
          outcome: "done",
          status: "completed",
          sessionID: "sess_dev_1",
          startedAt: 1,
          completedAt: 2,
        },
      ],
    })
    const graph = buildRunGraph(run)
    expect(graph.activeNode).toBeNull()
    expect(graph.nodes.find((node) => node.nodeID === "reviewer")?.state).toBe("paused")
    expect(graph.controls.canResume).toBe(true)
  })

  it("uses the latest attempt when a node failed and later completed", () => {
    const run = makeRunRecord({
      status: "completed",
      stepCount: 2,
      steps: [
        {
          stepID: "step_000001_a001",
          seq: 1,
          nodeID: "developer",
          status: "failed",
          sessionID: "sess_dev_1",
          startedAt: 1,
          completedAt: 2,
        },
        {
          stepID: "step_000002_a001",
          seq: 2,
          nodeID: "developer",
          outcome: "done",
          status: "completed",
          sessionID: "sess_dev_2",
          startedAt: 3,
          completedAt: 4,
        },
      ],
    })
    const graph = buildRunGraph(run)
    expect(graph.nodes.find((node) => node.nodeID === "developer")).toMatchObject({
      state: "completed",
      sessionIDs: ["sess_dev_1", "sess_dev_2"],
      stepCount: 2,
    })
  })

  it("marks a completed node that routed back and clears it after a forward attempt", () => {
    const steps = [
      {
        stepID: "step_000001_a001",
        seq: 1,
        nodeID: "developer",
        outcome: "done",
        status: "completed" as const,
        sessionID: "sess_dev_1",
        startedAt: 1,
        completedAt: 2,
      },
      {
        stepID: "step_000002_a001",
        seq: 2,
        nodeID: "reviewer",
        outcome: "changes_requested",
        status: "completed" as const,
        sessionID: "sess_rev_1",
        startedAt: 3,
        completedAt: 4,
      },
    ]
    const back = buildRunGraph(makeRunRecord({ status: "running", stepCount: 2, steps }))
    expect(back.nodes.find((node) => node.nodeID === "reviewer")).toMatchObject({
      state: "completed",
      routedBack: true,
    })
    expect(back.nodes.find((node) => node.nodeID === "developer")).toMatchObject({
      state: "completed",
      routedBack: false,
    })

    const passed = buildRunGraph(
      makeRunRecord({
        status: "completed",
        stepCount: 3,
        steps: [
          ...steps,
          {
            stepID: "step_000003_a001",
            seq: 3,
            nodeID: "reviewer",
            outcome: "approved",
            status: "completed",
            sessionID: "sess_rev_2",
            startedAt: 5,
            completedAt: 6,
          },
        ],
      }),
    )
    expect(passed.nodes.find((node) => node.nodeID === "reviewer")).toMatchObject({
      state: "completed",
      routedBack: false,
    })
  })

  it("marks failed nodes and exposes blockers", () => {
    const run = makeRunRecord({
      status: "failed",
      failure: { code: "native_failure", message: "failed", nodeID: "reviewer" },
      steps: [
        {
          stepID: "step_000002_a001",
          seq: 2,
          nodeID: "reviewer",
          status: "failed",
          sessionID: "sess_rev_1",
          startedAt: 1,
          completedAt: 2,
        },
      ],
    })
    const graph = buildRunGraph(run)
    expect(graph.nodes.find((node) => node.nodeID === "reviewer")?.state).toBe("failed")
    expect(graph.failure).toMatchObject({ code: "native_failure", message: "failed", nodeID: "reviewer" })
    expect(graph.controls.canCancel).toBe(false)
  })
})
