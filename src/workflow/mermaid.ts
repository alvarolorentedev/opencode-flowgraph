import type { Terminal } from "./schema.js"
import type { WorkflowGraph } from "./graph.js"

export type MermaidNode = {
  id: string
  nodeId?: string
  label: string
  terminal: boolean
}

export type MermaidEdge = {
  from: string
  to: string
  label?: string
  kind: "next" | "route" | "fork"
}

export type MermaidModel = {
  nodes: MermaidNode[]
  edges: MermaidEdge[]
}

export function escapeMermaidText(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "|": "&#124;",
    "[": "&#91;",
    "]": "&#93;",
    "{": "&#123;",
    "}": "&#125;",
    "`": "&#96;",
    "#": "&#35;",
    ";": "&#59;",
  }
  return value
    .normalize("NFC")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[&<>"'|\[\]{}`#;]/gu, (char) => map[char] ?? char)
    .slice(0, 400)
}

export function buildMermaidModel(graph: WorkflowGraph): MermaidModel {
  const orderedIds = [
    ...(Object.hasOwn(graph.nodes, graph.entry) ? [graph.entry] : []),
    ...Object.keys(graph.nodes)
      .filter((id) => id !== graph.entry)
      .sort(),
  ]
  const mermaidIds = new Map<string, string>()
  orderedIds.forEach((nodeId, index) => mermaidIds.set(nodeId, `n${index}`))

  const nodes: MermaidNode[] = orderedIds.map((nodeId) => ({
    id: mermaidIds.get(nodeId)!,
    nodeId,
    label: graph.nodes[nodeId]!.workflow === undefined
      ? graph.nodes[nodeId]!.label
      : `${graph.nodes[nodeId]!.label} (${graph.nodes[nodeId]!.workflow})`,
    terminal: false,
  }))

  const terminalOrder: Terminal[] = ["complete", "pause"]
  for (const terminal of terminalOrder) {
    if (!graph.terminals[terminal]) continue
    nodes.push({
      id: terminal,
      label: terminal === "complete" ? "Complete" : "Pause",
      terminal: true,
    })
  }

  const edges: MermaidEdge[] = []
  for (const nodeId of orderedIds) {
    const node = graph.nodes[nodeId]!
    const from = mermaidIds.get(nodeId)!
    for (const edge of node.edges) {
      const to = edge.terminal ? edge.target : mermaidIds.get(edge.target)
      if (!to) continue
      edges.push({
        from,
        to,
        ...(edge.outcome === undefined ? {} : { label: edge.outcome }),
        kind: edge.kind,
      })
    }
  }

  return { nodes, edges }
}

export function renderMermaid(graph: WorkflowGraph): string {
  const model = buildMermaidModel(graph)
  const lines = ["flowchart TD"]

  for (const node of model.nodes) {
    lines.push(`    ${node.id}["${escapeMermaidText(node.label)}"]`)
  }
  for (const edge of model.edges) {
    const label = edge.label === undefined ? "" : `|${escapeMermaidText(edge.label.replace(/_/gu, " "))}|`
    lines.push(`    ${edge.from} -->${label} ${edge.to}`)
  }

  return `${lines.join("\n")}\n`
}
