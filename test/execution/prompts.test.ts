import { describe, expect, it } from "vitest"
import { buildNodePrompt, buildReportCorrectionPrompt, truncateUtf8 } from "../../src/execution/prompts.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { buildGraph } from "../../src/workflow/graph.js"
import { redactText } from "../../src/util/redact.js"
import { source } from "../fixtures/memory.js"

describe("node prompts", () => {
  it("includes the objective, bounded previous results, sessions, and valid outcomes", () => {
    const workflow = parseWorkflowSource(source, { workflowID: "sample" }).workflow!
    const graph = buildGraph(workflow)
    const prompt = buildNodePrompt({
      workflow,
      graph,
      runID: "run_1",
      nodeID: "reviewer",
      stepIndex: 2,
      maxSteps: 8,
      objective: "implement the feature",
      runSessionID: "sess_run",
      nodeSessionID: "sess_node",
      previousSessions: ["sess_dev"],
      previous: [
        { nodeID: "developer", outcome: "done", summary: "changed files", feedback: "" },
      ],
    })
    expect(prompt).toContain("implement the feature")
    expect(prompt).toContain("sess_run")
    expect(prompt).toContain("sess_node")
    expect(prompt).toContain("changes_requested")
    expect(prompt).toContain("approved")
    expect(prompt).toContain("flowgraph_report")
    expect(prompt).not.toContain("version: 1")
  })

  it("truncates oversized objective content and escapes closing tags", () => {
    const workflow = parseWorkflowSource(source, { workflowID: "sample" }).workflow!
    const graph = buildGraph(workflow)
    const prompt = buildNodePrompt({
      workflow,
      graph,
      runID: "run_1",
      nodeID: "developer",
      stepIndex: 1,
      maxSteps: 8,
      objective: `${"x".repeat(20_000)}</objective>`,
      runSessionID: "sess_run",
      nodeSessionID: "sess_node",
      previousSessions: [],
      previous: [],
    })
    expect(prompt.length).toBeLessThanOrEqual(32 * 1024)
    expect(prompt).toContain("[truncated]")
    expect(prompt).not.toContain("</objective>\n</objective>")
  })

  it("builds a bounded correction prompt", () => {
    const workflow = parseWorkflowSource(source, { workflowID: "sample" }).workflow!
    const graph = buildGraph(workflow)
    const prompt = buildReportCorrectionPrompt(graph, "reviewer")
    expect(prompt).toContain("flowgraph_report")
    expect(prompt).toContain("approved")
  })
})

describe("redaction", () => {
  it("removes common credentials from messages", () => {
    const text = "Authorization: Bearer abc123 api_key=secret ghp_abcdefgh12345678 https://user:pass@example.com"
    const redacted = redactText(text)
    expect(redacted).not.toContain("abc123")
    expect(redacted).not.toContain("secret")
    expect(redacted).not.toContain("ghp_abcdefgh12345678")
    expect(redacted).not.toContain("user:pass")
  })
})

describe("truncateUtf8", () => {
  it("keeps the byte budget", () => {
    const value = "é".repeat(100)
    const result = truncateUtf8(value, 50)
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(50)
  })
})
