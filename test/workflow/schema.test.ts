import { describe, expect, it } from "vitest"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { buildGraph, resolveTransition, validateGraph, validOutcomes } from "../../src/workflow/graph.js"
import { validateWorkflow } from "../../src/workflow/validator.js"
import { renderMermaid, escapeMermaidText } from "../../src/workflow/mermaid.js"

const valid = `
version: 1
name: development
description: Development with iterative quality checks
entry: developer
limits:
  max_steps: 12
  timeout_seconds: 3600
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

const agents = [
  { id: "developer", name: "Developer", mode: "primary" as const, hidden: false },
  { id: "reviewer", name: "Reviewer", mode: "all" as const, hidden: false },
]

describe("workflow schema and loader", () => {
  it("parses a valid workflow", () => {
    const result = parseWorkflowSource(valid, { workflowID: "development" })
    expect(result.errors).toEqual([])
    expect(result.workflow?.name).toBe("development")
    expect(result.workflow?.limits.max_steps).toBe(12)
  })

  it("rejects duplicate YAML keys", () => {
    const source = valid.replace("entry: developer", "entry: developer\nentry: developer")
    const result = parseWorkflowSource(source, { workflowID: "development" })
    expect(result.workflow).toBeUndefined()
    expect(result.errors.some((error) => error.code === "yaml_parse")).toBe(true)
  })

  it("rejects aliases and anchors", () => {
    const source = valid.replace("entry: developer", "entry: &entry developer\nother: *entry")
    const result = parseWorkflowSource(source, { workflowID: "development" })
    expect(result.errors.some((error) => error.code === "yaml_alias" || error.code === "yaml_parse")).toBe(true)
  })

  it("rejects merge keys", () => {
    const source = `
version: 1
name: development
entry: a
limits: { max_steps: 2 }
base: &base { agent: developer }
nodes:
  a:
    <<: *base
    next: complete
`
    const result = parseWorkflowSource(source, { workflowID: "development" })
    expect(result.workflow).toBeUndefined()
  })

  it("rejects unknown fields", () => {
    const result = parseWorkflowSource(valid.replace("description:", "unknown: true\ndescription:"), { workflowID: "development" })
    expect(result.workflow).toBeUndefined()
    expect(result.errors.some((error) => error.message.includes("unknown") || error.message.includes("Unrecognized"))).toBe(true)
  })

  it("rejects unsupported versions", () => {
    const result = parseWorkflowSource(valid.replace("version: 1", "version: 2"), { workflowID: "development" })
    expect(result.workflow).toBeUndefined()
  })

  it("rejects a name that does not match the file stem", () => {
    const result = parseWorkflowSource(valid, { workflowID: "other" })
    expect(result.errors.some((error) => error.code === "name_mismatch")).toBe(true)
  })

  it("rejects unsafe object keys", () => {
    const source = valid.replace("entry: developer", "entry: developer\n__proto__: {}")
    const result = parseWorkflowSource(source, { workflowID: "development" })
    expect(result.errors.some((error) => error.code === "unsafe_key")).toBe(true)
  })

  it("rejects oversized documents", () => {
    const result = parseWorkflowSource(`${valid}\n# ${"x".repeat(300_000)}`, { workflowID: "development" })
    expect(result.errors.some((error) => error.code === "oversized_document")).toBe(true)
  })
})

describe("graph validation", () => {
  it("builds edges and resolves transitions", () => {
    const parsed = parseWorkflowSource(valid, { workflowID: "development" }).workflow!
    const graph = buildGraph(parsed)
    expect(resolveTransition(graph, "developer", "done")).toBe("reviewer")
    expect(resolveTransition(graph, "reviewer", "approved")).toBe("complete")
    expect(validOutcomes(graph, "reviewer")).toEqual(["approved", "blocked", "changes_requested"])
    expect(() => resolveTransition(graph, "reviewer", "unknown")).toThrow(/not declared/)
  })

  it("detects unreachable nodes and missing entry", () => {
    const parsed = parseWorkflowSource(valid, { workflowID: "development" }).workflow!
    parsed.nodes.orphan = { agent: "developer", next: "complete" }
    const graph = buildGraph(parsed)
    const result = validateGraph(parsed, graph)
    expect(result.errors.some((error) => error.code === "unreachable_node")).toBe(true)

    const missing = { ...parsed, entry: "missing" }
    expect(validateGraph(missing, buildGraph(missing)).errors.some((error) => error.code === "missing_entry")).toBe(true)
  })

  it("resolves agents and rejects subagent-only agents", () => {
    const parsed = parseWorkflowSource(valid, { workflowID: "development" }).workflow!
    const ok = validateWorkflow(parsed, agents)
    expect(ok.valid).toBe(true)
    const subagent = validateWorkflow(parsed, [{ ...agents[0]!, mode: "subagent" }, agents[1]!])
    expect(subagent.valid).toBe(false)
    expect(subagent.errors.some((error) => error.code === "subagent_agent_not_selectable")).toBe(true)
  })
})

describe("mermaid generation", () => {
  it("is deterministic and represents every graph edge", () => {
    const parsed = parseWorkflowSource(valid, { workflowID: "development" }).workflow!
    const graph = buildGraph(parsed)
    const first = renderMermaid(graph)
    const second = renderMermaid(graph)
    expect(first).toBe(second)
    expect(first).toContain("flowchart TD")
    expect(first).toContain('n0["Developer"]')
    expect(first).toContain("n0 --> n1")
    expect(first).toContain("n1 -->|approved| complete[\"Complete\"]".replace('[\"Complete\"]', ""))
    expect(first).toContain("n1 -->|changes requested| n0")
    expect(first).toContain("n1 -->|blocked| pause")
    expect(first).toContain('complete["Complete"]')
    expect(first).toContain('pause["Pause"]')
  })

  it("escapes labels and cannot emit Mermaid directives", () => {
    const escaped = escapeMermaidText('evil"]\nclick n0 "https://evil" <script>alert(1)</script>')
    expect(escaped).not.toContain('"')
    expect(escaped).not.toContain("<script>")
    expect(escaped).toContain("&quot;")
    expect(escaped).toContain("&lt;script&gt;")
  })
})
