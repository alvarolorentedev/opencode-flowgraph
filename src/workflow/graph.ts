import { isReservedNodeId, isTerminal, type Terminal, type WorkflowDefinition } from "./schema.js"

export type Diagnostic = {
  path: string
  message: string
  code?: string
}

export type GraphEdge = {
  kind: "next" | "route"
  outcome?: string
  target: string
  terminal: boolean
}

export type GraphNode = {
  id: string
  agent: string
  label: string
  edges: GraphEdge[]
}

export type WorkflowGraph = {
  workflowId: string
  entry: string
  nodes: Record<string, GraphNode>
  terminals: Record<Terminal, boolean>
  warnings: string[]
}

export function humanizeNodeId(id: string): string {
  return id
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function buildGraph(workflow: WorkflowDefinition): WorkflowGraph {
  const terminals: Record<Terminal, boolean> = { complete: false, pause: false }
  const nodes: Record<string, GraphNode> = {}

  for (const [id, node] of Object.entries(workflow.nodes)) {
    const edges: GraphEdge[] = []
    if (node.next !== undefined) {
      const terminal = isTerminal(node.next)
      if (terminal) terminals[node.next as Terminal] = true
      edges.push({ kind: "next", target: node.next, terminal })
    } else if (node.routes !== undefined) {
      for (const outcome of Object.keys(node.routes).sort()) {
        const target = node.routes[outcome]!
        const terminal = isTerminal(target)
        if (terminal) terminals[target as Terminal] = true
        edges.push({ kind: "route", outcome, target, terminal })
      }
    }
    nodes[id] = {
      id,
      agent: node.agent,
      label: node.label ?? humanizeNodeId(id),
      edges,
    }
  }

  return { workflowId: workflow.name, entry: workflow.entry, nodes, terminals, warnings: [] }
}

export function reachableNodes(graph: WorkflowGraph): Set<string> {
  const seen = new Set<string>()
  const queue = [graph.entry]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id) || !graph.nodes[id]) continue
    seen.add(id)
    for (const edge of graph.nodes[id]!.edges) {
      if (!edge.terminal) queue.push(edge.target)
    }
  }
  return seen
}

export function terminalReachable(graph: WorkflowGraph): Set<Terminal> {
  const reachable = new Set<Terminal>()
  const seen = new Set<string>()
  const queue = [graph.entry]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id) || !graph.nodes[id]) continue
    seen.add(id)
    for (const edge of graph.nodes[id]!.edges) {
      if (edge.terminal) reachable.add(edge.target as Terminal)
      else queue.push(edge.target)
    }
  }
  return reachable
}

export function validateGraph(workflow: WorkflowDefinition, graph: WorkflowGraph): {
  errors: Diagnostic[]
  warnings: string[]
} {
  const errors: Diagnostic[] = []
  const warnings: string[] = []

  if (!workflow.nodes[workflow.entry]) {
    errors.push({ path: "entry", message: `entry node "${workflow.entry}" does not exist`, code: "missing_entry" })
  }

  for (const id of Object.keys(workflow.nodes)) {
    if (isReservedNodeId(id)) {
      errors.push({ path: `nodes.${id}`, message: `node id "${id}" is reserved`, code: "reserved_node_id" })
    }
  }

  for (const [id, node] of Object.entries(workflow.nodes)) {
    const targets =
      node.next !== undefined ? [node.next] : Object.entries(node.routes ?? {}).map(([outcome, target]) => ({ outcome, target }))
    for (const item of targets) {
      const target = typeof item === "string" ? item : item.target
      const outcome = typeof item === "string" ? undefined : item.outcome
      if (!isTerminal(target) && !workflow.nodes[target]) {
        errors.push({
          path: outcome === undefined ? `nodes.${id}.next` : `nodes.${id}.routes.${outcome}`,
          message: `transition target "${target}" is neither a node nor a terminal`,
          code: "invalid_target",
        })
      }
    }
  }

  if (workflow.nodes[workflow.entry]) {
    const reachable = reachableNodes(graph)
    for (const id of Object.keys(workflow.nodes)) {
      if (!reachable.has(id)) {
        errors.push({ path: `nodes.${id}`, message: `node "${id}" is not reachable from entry`, code: "unreachable_node" })
      }
    }

    const terminals = terminalReachable(graph)
    if (terminals.size === 0) {
      warnings.push("no path to a terminal node was found; the run can only end by a limit or cancellation")
    }
  }

  return { errors, warnings }
}

export class TransitionError extends Error {
  constructor(
    readonly nodeId: string,
    readonly outcome: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = "TransitionError"
  }
}

export function resolveTransition(graph: WorkflowGraph, nodeId: string, outcome?: string): string {
  const node = graph.nodes[nodeId]
  if (!node) throw new TransitionError(nodeId, outcome, `unknown node "${nodeId}"`)
  if (node.edges.length === 1 && node.edges[0]!.kind === "next") return node.edges[0]!.target
  if (outcome === undefined) {
    throw new TransitionError(nodeId, outcome, `node "${nodeId}" requires a structured outcome`)
  }
  const edge = node.edges.find((candidate) => candidate.kind === "route" && candidate.outcome === outcome)
  if (!edge) {
    const allowed = node.edges.filter((candidate) => candidate.kind === "route").map((candidate) => candidate.outcome)
    throw new TransitionError(
      nodeId,
      outcome,
      `outcome "${outcome}" is not declared for node "${nodeId}"; allowed: ${allowed.join(", ") || "none"}`,
    )
  }
  return edge.target
}

export function validOutcomes(graph: WorkflowGraph, nodeId: string): string[] {
  const node = graph.nodes[nodeId]
  if (!node) return []
  return node.edges.filter((edge) => edge.kind === "route").map((edge) => edge.outcome!).sort()
}
