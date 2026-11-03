import { describe, expect, it } from "vitest"
import { buildRunGraph } from "../../src/execution/run-graph.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import type { RunRecord } from "../../src/state/types.js"
import type { RunGraphOutput } from "../../src/contract.js"
import { makeRunRecord } from "../fixtures/memory.js"
import {
  renderRunGraphDiagram,
  textWidth,
  type RunGraphDiagramResult,
} from "../../src/ui/graph.js"

const reviewSource = `version: 1
name: review
entry: developer
limits:
  max_steps: 8
  timeout_seconds: 60
nodes:
  developer:
    agent: developer
    next: reviewer
  reviewer:
    agent: reviewer
    routes:
      approved: complete
      changes_requested: developer
      blocked: pause
`

const productSource = `version: 1
name: product
entry: po
limits:
  max_steps: 20
  timeout_seconds: 3600
nodes:
  po:
    agent: po
    next: designer
  designer:
    agent: designer
    routes:
      ready: developer
      needs_clarification: po
      blocked: pause
  developer:
    agent: developer
    next: tester
  tester:
    agent: tester
    routes:
      passed: complete
      failed: developer
      blocked: pause
`

const selfSource = `version: 1
name: self
entry: a
limits:
  max_steps: 8
  timeout_seconds: 60
nodes:
  a:
    agent: a
    routes:
      retry: a
      done: complete
`

const joinSource = `version: 1
name: join
entry: a
limits:
  max_steps: 8
  timeout_seconds: 60
nodes:
  a:
    agent: a
    routes:
      left: c
      right: b
  b:
    agent: b
    next: c
  c:
    agent: c
    next: complete
`

const multiRailSource = `version: 1
name: multi
entry: a
limits:
  max_steps: 20
  timeout_seconds: 60
nodes:
  a:
    agent: a
    routes:
      next: b
      skip: d
  b:
    agent: b
    routes:
      next: c
      long: d
  c:
    agent: c
    next: d
  d:
    agent: d
    routes:
      retry: a
      done: complete
`

const wideSource = `version: 1
name: wide
entry: a
limits:
  max_steps: 8
  timeout_seconds: 60
nodes:
  a:
    label: "审查"
    agent: reviewer
    next: complete
`

function graph(source: string, overrides: Partial<RunRecord> = {}): RunGraphOutput {
  const name = /^name:\s*(\S+)/mu.exec(source)?.[1] ?? "test"
  const parsed = parseWorkflowSource(source, { workflowID: name })
  if (!parsed.workflow) throw new Error(parsed.errors.map((error) => error.message).join(", "))
  return buildRunGraph(
    makeRunRecord({
      workflowSnapshot: parsed.workflow,
      ...overrides,
    } as never),
  )
}

function diagram(result: RunGraphDiagramResult) {
  if ("reason" in result) throw new Error(result.reason)
  return result
}

function text(result: RunGraphDiagramResult): string {
  return diagram(result)
    .lines.map((line) => line.map((span) => span.text).join(""))
    .join("\n")
}

const completedDeveloper: RunRecord["steps"] = [
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
]

describe("renderRunGraphDiagram", () => {
  it("renders a running review workflow with states, edges, and terminals", () => {
    const result = renderRunGraphDiagram(
      graph(reviewSource, {
        status: "running",
        currentNode: "reviewer",
        stepCount: 1,
        steps: completedDeveloper,
      }),
      { width: 80, maxLines: 40 },
    )
    const output = text(result)
    expect(output).toContain("✓ Developer · developer")
    expect(output).toContain("▶ Reviewer · reviewer")
    expect(output).toContain("approved")
    expect(output).toContain("changes requested")
    expect(output).toContain("blocked")
    expect(output).toContain("○ Complete")
    expect(output).toContain("○ Pause")
    expect(output).toContain("▼")
    expect(diagram(result).width).toBeLessThanOrEqual(80)
    expect(diagram(result).height).toBeLessThanOrEqual(40)

    const spans = diagram(result).lines.flat()
    expect(spans.find((span) => span.text.includes("▶ Reviewer"))?.tone).toBe("active")
    expect(spans.find((span) => span.text.includes("✓ Developer"))?.tone).toBe("completed")
    expect(spans.find((span) => span.text.includes("approved"))?.tone).toBe("edgeLabel")
  })

  it("marks the complete terminal when the run is complete", () => {
    const output = text(
      renderRunGraphDiagram(
        graph(reviewSource, {
          status: "completed",
          stepCount: 2,
          steps: [
            ...completedDeveloper,
            {
              stepID: "step_000002_a001",
              seq: 2,
              nodeID: "reviewer",
              outcome: "approved",
              status: "completed",
              sessionID: "sess_rev_1",
              startedAt: 3,
              completedAt: 4,
            },
          ],
        }),
        { width: 80, maxLines: 40 },
      ),
    )
    expect(output).toContain("✓ Complete")
    expect(output).toContain("✓ Reviewer · reviewer")
  })

  it("marks a completed node that routed back as rejected until it passes", () => {
    const rejectedSteps: RunRecord["steps"] = [
      ...completedDeveloper,
      {
        stepID: "step_000002_a001",
        seq: 2,
        nodeID: "reviewer",
        outcome: "changes_requested",
        status: "completed",
        sessionID: "sess_rev_1",
        startedAt: 3,
        completedAt: 4,
      },
    ]
    const rejected = diagram(
      renderRunGraphDiagram(
        graph(reviewSource, { status: "running", stepCount: 2, steps: rejectedSteps }),
        { width: 80, maxLines: 40 },
      ),
    )
    const rejectedOutput = text(rejected)
    expect(rejectedOutput).toContain("✗ Reviewer · reviewer")
    expect(rejectedOutput).toContain("✓ Developer · developer")
    expect(rejected.lines.flat().find((span) => span.text.includes("✗ Reviewer"))?.tone).toBe("rejected")

    const passed = diagram(
      renderRunGraphDiagram(
        graph(reviewSource, {
          status: "completed",
          stepCount: 3,
          steps: [
            ...rejectedSteps,
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
        { width: 80, maxLines: 40 },
      ),
    )
    const passedOutput = text(passed)
    expect(passedOutput).toContain("✓ Reviewer · reviewer")
    expect(passed.lines.flat().find((span) => span.text.includes("✓ Reviewer"))?.tone).toBe("completed")
  })

  it("keeps sibling branch labels on separate rows", () => {
    const output = text(
      renderRunGraphDiagram(
        graph(productSource, { status: "running", currentNode: "tester" }),
        { width: 100, maxLines: 60 },
      ),
    )
    expect(output).toContain("needs clarification")
    expect(output).toContain("failed")
    expect(output).toContain("passed")
    expect(output).toContain("blocked")
    expect(output).not.toContain("passedblocked")
    expect(output).not.toContain("┼")
  })

  it("draws outcome labels on their own rows and enters boxes from the side", () => {
    const result = diagram(
      renderRunGraphDiagram(
        graph(productSource, { status: "running", currentNode: "tester" }),
        { width: 100, maxLines: 60 },
      ),
    )
    const lines = result.lines.map((line) => line.map((span) => span.text).join(""))
    for (const label of ["needs clarification", "blocked", "passed", "failed"]) {
      const row = lines.find((line) => line.includes(label))
      expect(row).toBeDefined()
      expect(row).not.toContain("─")
    }
    const output = lines.join("\n")
    expect(output).toContain("▶┤")
    expect(output).toContain("├◀")
  })

  it("routes a self-loop through a rail", () => {
    const output = text(
      renderRunGraphDiagram(graph(selfSource, { status: "running", currentNode: "a" }), {
        width: 60,
        maxLines: 40,
      }),
    )
    expect(output).toContain("retry")
    expect(output).toContain("○ Complete")
    expect(output).not.toContain("┼")
  })

  it("converges a join on the target box", () => {
    const output = text(
      renderRunGraphDiagram(graph(joinSource, { status: "running", currentNode: "c" }), {
        width: 80,
        maxLines: 40,
      }),
    )
    expect(output).toContain("left")
    expect(output).toContain("right")
    expect(output).toContain("▶ C · c")
    expect(output).not.toContain("┼")
  })

  it("keeps multiple rails on separate lanes without crossings", () => {
    const output = text(
      renderRunGraphDiagram(graph(multiRailSource, { status: "running", currentNode: "d" }), {
        width: 100,
        maxLines: 60,
      }),
    )
    expect(output).toContain("skip")
    expect(output).toContain("long")
    expect(output).toContain("retry")
    expect(output).not.toContain("┼")
  })

  it("measures terminal display width", () => {
    expect(textWidth("审查")).toBe(4)
    expect(textWidth("✓")).toBe(1)
    expect(textWidth("e\u0301")).toBe(1)
  })

  it("renders wide labels without overflowing the reported width", () => {
    const result = diagram(
      renderRunGraphDiagram(graph(wideSource, { status: "running", currentNode: "a" }), {
        width: 80,
        maxLines: 40,
      }),
    )
    const output = text(result)
    expect(output).toContain("审查")
    for (const line of result.lines) {
      expect(textWidth(line.map((span) => span.text).join(""))).toBeLessThanOrEqual(result.width)
    }
  })

  it("falls back when the diagram does not fit", () => {
    const narrow = renderRunGraphDiagram(graph(reviewSource), { width: 20, maxLines: 40 })
    expect("reason" in narrow && narrow.reason).toContain("columns")

    const tall = renderRunGraphDiagram(graph(reviewSource), { width: 80, maxLines: 5 })
    expect("reason" in tall && tall.reason).toContain("lines")

    const many = renderRunGraphDiagram(graph(reviewSource), {
      width: 80,
      maxLines: 40,
      maxNodes: 1,
    })
    expect("reason" in many && many.reason).toContain("too many nodes")
  })

  it("is deterministic", () => {
    const first = text(renderRunGraphDiagram(graph(productSource), { width: 100, maxLines: 60 }))
    const second = text(renderRunGraphDiagram(graph(productSource), { width: 100, maxLines: 60 }))
    expect(first).toBe(second)
  })
})
