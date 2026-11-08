import { isReservedNodeId, isTerminal, type Terminal, type WorkflowDefinition } from "./schema.js"

export type Diagnostic = {
  path: string
  message: string
  code?: string
}

export type GraphEdge = {
  kind: "next" | "route" | "fork"
  outcome?: string
  target: string
  terminal: boolean
}

export type GraphNode = {
  id: string
  agent?: string
  join?: string
  workflow?: string
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
    if ("fork" in node) {
      for (const target of node.fork) edges.push({ kind: "fork", target, terminal: false })
    } else if ("next" in node && node.next !== undefined) {
      const terminal = isTerminal(node.next)
      if (terminal) terminals[node.next as Terminal] = true
      edges.push({ kind: "next", target: node.next, terminal })
    } else {
      for (const [outcome, target] of Object.entries(node.routes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const terminal = isTerminal(target)
        if (terminal) terminals[target as Terminal] = true
        edges.push({ kind: "route", outcome, target, terminal })
      }
    }
    nodes[id] = {
      id,
      ...("agent" in node ? { agent: node.agent } : "fork" in node ? { join: node.join } : { workflow: node.workflow }),
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
    if (seen.has(id) || !Object.hasOwn(graph.nodes, id)) continue
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
    if (seen.has(id) || !Object.hasOwn(graph.nodes, id)) continue
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

  if (!Object.hasOwn(workflow.nodes, workflow.entry)) {
    errors.push({ path: "entry", message: `entry node "${workflow.entry}" does not exist`, code: "missing_entry" })
  }

  for (const id of Object.keys(workflow.nodes)) {
    if (isReservedNodeId(id)) {
      errors.push({ path: `nodes.${id}`, message: `node id "${id}" is reserved`, code: "reserved_node_id" })
    }
  }

  for (const node of Object.values(graph.nodes)) {
    for (const [index, edge] of node.edges.entries()) {
      if (!edge.terminal && !Object.hasOwn(graph.nodes, edge.target)) {
        errors.push({
          path: `nodes.${node.id}.${edge.kind === "route" ? `routes.${edge.outcome}` : edge.kind === "fork" ? `fork.${index}` : "next"}`,
          message: `transition target "${edge.target}" is neither a node nor a terminal`,
          code: "invalid_target",
        })
      }
    }
  }
  errors.push(...validateForks(graph))

  if (Object.hasOwn(workflow.nodes, workflow.entry)) {
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

function validateForks(graph: WorkflowGraph): Diagnostic[] {
  const errors: Diagnostic[] = []
  const incoming = new Map<string, string[]>()
  const joins = new Set<string>()
  for (const node of Object.values(graph.nodes)) {
    for (const { target } of node.edges) {
      const sources = incoming.get(target) ?? []
      sources.push(node.id)
      incoming.set(target, sources)
    }
  }

  for (const fork of Object.values(graph.nodes)) {
    const join = fork.join
    if (join === undefined) continue
    const invalid = (message: string) => errors.push({ path: `nodes.${fork.id}.join`, message, code: "invalid_join" })
    if (!graph.nodes[join]?.agent || isTerminal(join) || joins.has(join) || join === graph.entry) {
      invalid(`join "${join}" must be a distinct agent node dedicated to this fork`)
      continue
    }
    joins.add(join)
    const members = new Set<string>()
    for (const { target: entry } of fork.edges) {
      const branch = new Set<string>()
      const queue = [entry]
      let exits = entry === join
      for (const id of queue) {
        if (id === join || branch.has(id)) continue
        if (!Object.hasOwn(graph.nodes, id) || isTerminal(id) || id === fork.id) {
          exits = true
          continue
        }
        branch.add(id)
        queue.push(...graph.nodes[id]!.edges.map((edge) => edge.target))
      }
      const reachesJoin = new Set([join])
      const reverse = [join]
      for (const id of reverse) {
        for (const source of incoming.get(id) ?? []) {
          if (!branch.has(source) || reachesJoin.has(source)) continue
          reachesJoin.add(source)
          reverse.push(source)
        }
      }
      if (exits || reachesJoin.size !== branch.size + 1) {
        invalid(`branch "${entry}" must reach "${join}" without leaving the fork`)
      }
      const overlap = [...branch].find((id) => members.has(id))
      if (overlap) invalid(`branches overlap at "${overlap}" before "${join}"`)
      const bypass = [...branch].find((id) => id === graph.entry ||
        (incoming.get(id) ?? []).some((source) => !branch.has(source) && (source !== fork.id || id !== entry)),
      )
      if (bypass) invalid(`an edge enters branch "${entry}" at "${bypass}" without passing through its fork`)
      for (const id of branch) members.add(id)
    }
    if ((incoming.get(join) ?? []).some((source) => !members.has(source))) {
      invalid(`an edge enters join "${join}" outside its branches`)
    }
  }
  return errors
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
  const node = Object.hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined
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
  const node = Object.hasOwn(graph.nodes, nodeId) ? graph.nodes[nodeId] : undefined
  if (!node) return []
  return node.edges.filter((edge) => edge.kind === "route").map((edge) => edge.outcome!).sort()
}
