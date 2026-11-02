import { buildMermaidModel, renderMermaid } from "../workflow/mermaid.js"
import { buildGraph } from "../workflow/graph.js"
import type { RunGraphEdge, RunGraphNode, RunGraphOutput } from "../contract.js"
import type { RunRecord, PermissionSummary } from "../state/types.js"

const TERMINAL_TARGETS = new Set(["complete", "pause"])

export function buildRunGraph(run: RunRecord, pendingPermissions: PermissionSummary[] = run.pendingPermissions): RunGraphOutput {
  const graph = buildGraph(run.workflowSnapshot)
  const mermaidModel = buildMermaidModel(graph)
  const mermaidIDs = new Map<string, string>()
  for (const node of mermaidModel.nodes) {
    if (node.nodeId !== undefined) mermaidIDs.set(node.nodeId, node.id)
  }

  const latest = new Map<string, RunRecord["steps"][number]>()
  const sessions = new Map<string, string[]>()
  for (const step of run.steps) {
    const ids = sessions.get(step.nodeID) ?? []
    if (!ids.includes(step.sessionID)) ids.push(step.sessionID)
    sessions.set(step.nodeID, ids)
    const previous = latest.get(step.nodeID)
    if (!previous || step.seq >= previous.seq) latest.set(step.nodeID, step)
  }
  const completed = new Set<string>()
  const failed = new Set<string>()
  for (const [nodeID, step] of latest) {
    if (step.status === "completed") completed.add(nodeID)
    if (step.status === "failed" || step.status === "interrupted" || step.status === "ambiguous") failed.add(nodeID)
  }
  if (run.failure?.nodeID) failed.add(run.failure.nodeID)
  if (run.activeStep) {
    const ids = sessions.get(run.activeStep.nodeID) ?? []
    if (!ids.includes(run.activeStep.sessionID)) ids.push(run.activeStep.sessionID)
    sessions.set(run.activeStep.nodeID, ids)
  }

  const activeNode = run.activeStep?.nodeID ?? (run.status === "running" || run.status === "pausing" ? run.currentNode : null)
  const pausedNode = run.status === "paused" ? run.nextNode ?? run.currentNode : null

  const nodes: RunGraphNode[] = Object.values(graph.nodes).map((node) => {
    let state: RunGraphNode["state"] = "pending"
    if (failed.has(node.id)) state = "failed"
    else if (node.id === activeNode) state = "active"
    else if (completed.has(node.id)) state = "completed"
    else if (node.id === pausedNode) state = "paused"
    const stepCount = run.steps.filter((step) => step.nodeID === node.id).length + (run.activeStep?.nodeID === node.id ? 1 : 0)
    return {
      nodeID: node.id,
      label: node.label,
      agent: node.agent,
      state,
      sessionIDs: sessions.get(node.id) ?? [],
      stepCount,
    }
  })

  const edges: RunGraphEdge[] = []
  for (const node of Object.values(graph.nodes)) {
    for (const edge of node.edges) {
      edges.push({
        from: node.id,
        to: edge.target,
        ...(edge.outcome === undefined ? {} : { outcome: edge.outcome }),
        kind: edge.kind,
        terminal: TERMINAL_TARGETS.has(edge.target),
      })
    }
  }

  const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled"
  return {
    runID: run.runID,
    workflowID: run.workflowID,
    revision: run.revision,
    status: run.status,
    runSessionID: run.runSessionID,
    activeNode,
    currentNode: run.currentNode,
    nodes,
    edges,
    mermaid: renderMermaid(graph),
    mermaidNodes: Array.from(mermaidIDs, ([nodeID, mermaidID]) => ({ nodeID, mermaidID })),
    activeMermaidID: activeNode === null ? null : mermaidIDs.get(activeNode) ?? null,
    controls: {
      canPause: run.status === "running" || run.status === "pausing",
      canResume:
        (run.status === "paused" && run.nextNode !== null && run.pause?.reason !== "route") ||
        (run.status === "blocked" && pendingPermissions.length === 0),
      canCancel: !terminal,
    },
    pendingPermissions,
    blocker: run.blocker === null ? null : { type: run.blocker.type, message: run.blocker.message },
    failure: run.failure,
  }
}
