export type WorkflowCommand =
  | { type: "graph" }
  | { type: "runs" }
  | { type: "list" }
  | { type: "run"; workflowID?: string; objective?: string }

const GRAPH = new Set(["graph", "visual", "visuals", "view"])
const RUNS = new Set(["runs", "all", "page"])
const RUN = new Set(["run", "start"])
const LIST = "list"

export function parseWorkflowCommand(input?: string): WorkflowCommand {
  const text = (input ?? "").trim()
  if (text.length === 0) return { type: "graph" }

  const [head, ...rest] = text.split(/\s+/u)
  const keyword = head!.toLowerCase()

  if (GRAPH.has(keyword)) return { type: "graph" }
  if (RUNS.has(keyword)) return { type: "runs" }
  if (keyword === LIST) return { type: "list" }

  if (RUN.has(keyword)) {
    const workflowID = rest.shift()
    const objective = rest.join(" ").trim()
    return {
      type: "run",
      ...(workflowID === undefined ? {} : { workflowID }),
      ...(objective.length === 0 ? {} : { objective }),
    }
  }

  const objective = rest.join(" ").trim()
  return {
    type: "run",
    workflowID: head,
    ...(objective.length === 0 ? {} : { objective }),
  }
}
