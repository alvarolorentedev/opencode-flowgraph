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

  it("requires a model on each agent when there is no default model", () => {
    const parsed = parseWorkflowSource(valid, { workflowID: "development" }).workflow!
    const missing = validateWorkflow(parsed, agents, { hasDefaultModel: false })
    expect(missing.valid).toBe(false)
    expect(missing.errors.filter((error) => error.code === "agent_missing_model")).toHaveLength(2)

    const withModels = validateWorkflow(
      parsed,
      agents.map((agent) => ({ ...agent, model: { providerID: "test", id: "model" } })),
      { hasDefaultModel: false },
    )
    expect(withModels.valid).toBe(true)
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

describe("human nodes", () => {
  const human = `
version: 1
name: approval
entry: developer
limits: { max_steps: 6 }
nodes:
  developer: { agent: developer, next: signoff }
  signoff:
    human: true
    label: Approve the release
    routes:
      approved: ship
      rejected: developer
  ship: { agent: reviewer, next: complete }
`

  it("parses, validates, and routes human steps without an agent", () => {
    const parsed = parseWorkflowSource(human, { workflowID: "approval" })
    expect(parsed.errors).toEqual([])
    expect(parsed.workflow?.nodes.signoff).toMatchObject({ human: true, label: "Approve the release" })
    const graph = buildGraph(parsed.workflow!)
    expect(graph.nodes.signoff).toMatchObject({ human: true, label: "Approve the release" })
    expect(validOutcomes(graph, "signoff")).toEqual(["approved", "rejected"])
    expect(resolveTransition(graph, "signoff", "approved")).toBe("ship")
    expect(validateWorkflow(parsed.workflow!, agents).valid).toBe(true)
    expect(renderMermaid(graph)).toContain("Approve the release (human)")
  })

  it("requires routes and rejects agent or next fields", () => {
    const noRoutes = parseWorkflowSource(
      human.replace("    routes:\n      approved: ship\n      rejected: developer\n", ""),
      { workflowID: "approval" },
    )
    expect(noRoutes.workflow).toBeUndefined()
    const withAgent = parseWorkflowSource(human.replace("    human: true\n", "    human: true\n    agent: developer\n"), {
      workflowID: "approval",
    })
    expect(withAgent.workflow).toBeUndefined()
    const withNext = parseWorkflowSource(
      human.replace("    routes:\n      approved: ship\n      rejected: developer\n", "    next: ship\n"),
      { workflowID: "approval" },
    )
    expect(withNext.workflow).toBeUndefined()
  })
})

describe("structured fork validation", () => {
  const source = `version: 1
name: parallel
entry: start
limits: { max_steps: 20 }
nodes:
  start: { fork: [left, right], join: finish }
  left: { fork: [scan, review], join: merge }
  scan: { agent: developer, routes: { again: scan, done: merge } }
  review: { agent: reviewer, next: merge }
  merge: { agent: reviewer, next: finish }
  right: { agent: developer, next: finish }
  finish: { agent: reviewer, routes: { again: start, done: complete } }
`

  function diagnostics(yaml: string) {
    const result = parseWorkflowSource(yaml)
    return result.workflow ? validateGraph(result.workflow, buildGraph(result.workflow)).errors : result.errors
  }

  it("accepts nested forks and loop routes contained in a branch", () => {
    expect(diagnostics(source)).toEqual([])
  })

  it("allows a human branch but not a human join", () => {
    const fork = `version: 1
name: approval
entry: dispatch
limits: { max_steps: 6 }
nodes:
  dispatch: { fork: [review, approve], join: merge }
  review: { agent: reviewer, next: merge }
  approve: { human: true, routes: { approved: merge } }
  merge: { agent: developer, next: complete }
`
    expect(diagnostics(fork)).toEqual([])
    expect(diagnostics(fork.replace("merge: { agent: developer, next: complete }", "merge: { human: true, routes: { done: complete } }")))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_join" })]))
  })

  it("rejects duplicate, overlapping, and escaping branches and bypass edges", () => {
    expect(diagnostics(source.replace("[left, right]", "[left, left]"))).not.toHaveLength(0)
    for (const yaml of [
      source.replace("next: merge }\n  merge", "next: finish }\n  merge"),
      source.replace("next: finish }\n  finish", "next: merge }\n  finish"),
      source.replace("again: start, done: complete", "again: left, done: complete"),
      source.replace("again: scan, done: merge", "again: scan, done: scan"),
    ]) {
      expect(diagnostics(yaml)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_join" })]))
    }
  })
})

it("reports an unknown route target even when its name is inherited from Object", () => {
  const workflow = parseWorkflowSource(`version: 1
name: example
entry: start
limits: { max_steps: 2 }
nodes:
  start: { agent: developer, next: constructor }
`).workflow!
  expect(validateGraph(workflow, buildGraph(workflow)).errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "nodes.start.next", code: "invalid_target" }),
  ]))
})
