import { buildMermaidModel, renderMermaid } from "../workflow/mermaid.js"
import { buildGraph, resolveTransition } from "../workflow/graph.js"
import type { RunGraphNode, RunGraphOutput } from "../contract.js"
import type { RunRecord, PermissionSummary, StepSummary } from "../state/types.js"
import { activeSteps, blockersOf, displayNode } from "./checkpoint.js"

export function buildRunGraph(run: RunRecord, pendingPermissions: PermissionSummary[] = run.pendingPermissions): RunGraphOutput {
  const graph = buildGraph(run.workflowSnapshot)
  const mermaidNodes = buildMermaidModel(graph).nodes.flatMap((node) =>
    node.nodeId === undefined ? [] : [{ nodeID: node.nodeId, mermaidID: node.id }],
  )
  const active = activeSteps(run)
  const blockers = blockersOf(run)
  const activity = new Set(active.filter((step) => step.phase !== "ambiguous").map(displayNode))
  const ambiguous = new Set(active.filter((step) => step.phase === "ambiguous").map(displayNode))
  const activeNode = active[0] ? displayNode(active[0]) : (run.status === "running" || run.status === "pausing" ? run.currentNode : null)
  if (active.length === 0 && activeNode) activity.add(activeNode)
  const paused = new Set(run.status !== "paused" ? [] : run.execution
    ? run.execution.branches.map((branch) => branch.calls[0]?.nodeID ?? branch.nodeID)
    : [run.nextNode ?? run.currentNode])

  const steps = new Map<string, StepSummary>()
  for (const step of run.steps) steps.set(step.stepID, step)
  for (const step of active) {
    if (steps.has(step.stepID)) continue
    steps.set(step.stepID, {
      stepID: step.stepID, seq: step.stepIndex, nodeID: step.nodeID, workflowID: step.workflowID,
      callPath: step.callPath, sessionID: step.sessionID, status: "running", startedAt: step.startedAt,
    })
  }
  const history = new Map<string, StepSummary[]>()
  for (const step of [...steps.values()].sort((a, b) => a.seq - b.seq)) {
    const id = displayNode(step)
    const entries = history.get(id) ?? []
    entries.push(step)
    history.set(id, entries)
  }

  const failed = run.failure?.stepID ? steps.get(run.failure.stepID) : undefined
  const failedNode = failed ? displayNode(failed) : run.failure?.nodeID
  const nodes: RunGraphNode[] = Object.values(graph.nodes).map((node) => {
    const entries = history.get(node.id) ?? []
    const latest = entries.at(-1)
    let routedBack = false
    if (latest?.status === "completed" && node.agent) {
      try {
        const target = resolveTransition(graph, node.id, latest.outcome)
        const first = history.get(target)?.[0]
        routedBack = target === node.id || (first !== undefined && first.seq < latest.seq)
      } catch {
        // A legacy step can lack an outcome.
      }
    }

    let state: RunGraphNode["state"] = "pending"
    if (activity.has(node.id)) state = "active"
    else if (node.id === failedNode || ambiguous.has(node.id) || latest?.status === "failed" || latest?.status === "interrupted" || latest?.status === "ambiguous") state = "failed"
    else if (paused.has(node.id)) state = "paused"
    else if (latest?.status === "completed" || run.execution?.enteredForks.includes(node.id)) state = "completed"
    return {
      nodeID: node.id,
      label: node.label,
      agent: node.agent,
      workflow: node.workflow,
      join: node.join,
      ...(node.workflow && { childSteps: entries }),
      state,
      routedBack,
      sessionIDs: Array.from(new Set(entries.map((step) => step.sessionID))),
      stepCount: entries.length,
    }
  })

  const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled"
  return {
    runID: run.runID,
    workflowID: run.workflowID,
    revision: run.revision,
    status: run.status,
    runSessionID: run.runSessionID,
    activeNode,
    activeSteps: active,
    blockers,
    currentNode: run.currentNode,
    nodes,
    edges: Object.values(graph.nodes).flatMap((node) => node.edges.map((edge) => ({
      from: node.id, to: edge.target, outcome: edge.outcome, kind: edge.kind, terminal: edge.terminal,
    }))),
    mermaid: renderMermaid(graph),
    mermaidNodes,
    activeMermaidID: mermaidNodes.find((node) => node.nodeID === activeNode)?.mermaidID ?? null,
    controls: {
      canPause: run.status === "running" || run.status === "pausing",
      canResume: pendingPermissions.length === 0 && (
        (run.status === "paused" && run.pause?.reason !== "route") ||
        run.status === "blocked" ||
        (run.status === "running" && blockers.some((blocker) => blocker.type !== "permission"))
      ),
      canCancel: !terminal,
    },
    pendingPermissions,
    blocker: run.blocker === null ? null : { type: run.blocker.type, message: run.blocker.message },
    failure: run.failure,
  }
}
