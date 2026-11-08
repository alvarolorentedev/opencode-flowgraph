import type { RunGraphNode, RunGraphOutput } from "../contract.js"

export type GraphTone = RunGraphNode["state"] | "rejected" | "edge" | "edgeLabel"
export type DiagramSpan = { text: string; tone?: GraphTone }
export type DiagramLine = DiagramSpan[]
export type RunGraphDiagram = { lines: DiagramLine[]; width: number; height: number }
export type RunGraphDiagramResult = RunGraphDiagram | { reason: string }

export type RunGraphDiagramOptions = {
  width: number
  maxLines: number
  maxNodes?: number
  maxBoxWidth?: number
}

type LayoutNode = {
  id: string
  label: string
  agent?: string
  state: RunGraphNode["state"]
  routedBack: boolean
  terminal: boolean
  rank: number
  order: number
  x: number
  y: number
  width: number
}

type EdgeSide = "none" | "left" | "right"

type LayoutEdge = {
  from: string
  to: string
  outcome?: string
  back: boolean
  side: EdgeSide
  railX: number
  departY: number
  entryY: number
  lineY: number
  labelY: number
}

type Label = { text: string; x: number; y: number; maxWidth: number }

const MARKERS: Record<RunGraphNode["state"], string> = {
  active: "▶",
  completed: "✓",
  failed: "✗",
  paused: "⏸",
  pending: "○",
}

const BOX_HEIGHT = 3
const BOX_GAP = 2
const MIN_BOX_WIDTH = 12
const DEFAULT_MAX_BOX_WIDTH = 40
const DEFAULT_MAX_NODES = 40

const U = 1
const D = 2
const L = 4
const R = 8

const MASK_CHARS: Record<number, string> = {
  0: " ",
  1: "╵",
  2: "╷",
  3: "│",
  4: "╴",
  5: "┘",
  6: "┐",
  7: "┤",
  8: "╶",
  9: "└",
  10: "┌",
  11: "├",
  12: "─",
  13: "┴",
  14: "┬",
  15: "┼",
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function charWidth(code: number): number {
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  ) {
    return 0
  }
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f1e6 && code <= 0x1f1ff) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f680 && code <= 0x1f6ff) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x1fa70 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

function graphemeWidth(grapheme: string): number {
  let width = 0
  for (const char of grapheme) width = Math.max(width, charWidth(char.codePointAt(0) ?? 0))
  return width
}

export function textWidth(text: string): number {
  let width = 0
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment)
  return width
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (textWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return "…"
  let width = 0
  let result = ""
  for (const { segment } of segmenter.segment(text)) {
    const next = width + graphemeWidth(segment)
    if (next > maxWidth - 1) break
    result += segment
    width = next
  }
  return `${result}…`
}

class Canvas {
  readonly width: number
  readonly height: number
  private readonly cells: Array<{
    ch: string
    mask: number
    tone?: GraphTone
    continuation: boolean
  }>

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: width * height }, () => ({
      ch: "",
      mask: 0,
      continuation: false,
    }))
  }

  private cell(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined
    return this.cells[y * this.width + x]
  }

  addBits(x: number, y: number, bits: number, tone?: GraphTone) {
    const cell = this.cell(x, y)
    if (!cell || cell.continuation) return
    cell.mask |= bits
    if (cell.tone === undefined) cell.tone = tone
  }

  set(x: number, y: number, ch: string, tone?: GraphTone) {
    const cell = this.cell(x, y)
    if (!cell || cell.continuation) return
    cell.ch = ch
    cell.mask = 0
    if (tone !== undefined) cell.tone = tone
  }

  segV(x: number, y0: number, y1: number, tone?: GraphTone) {
    if (y0 === y1) {
      this.addBits(x, y0, U | D, tone)
      return
    }
    const start = Math.min(y0, y1)
    const end = Math.max(y0, y1)
    this.addBits(x, y0, y1 > y0 ? D : U, tone)
    this.addBits(x, y1, y1 > y0 ? U : D, tone)
    for (let y = start + 1; y < end; y++) this.addBits(x, y, U | D, tone)
  }

  segH(y: number, x0: number, x1: number, tone?: GraphTone) {
    if (x0 === x1) {
      this.addBits(x0, y, L | R, tone)
      return
    }
    const start = Math.min(x0, x1)
    const end = Math.max(x0, x1)
    this.addBits(x0, y, x1 > x0 ? R : L, tone)
    this.addBits(x1, y, x1 > x0 ? L : R, tone)
    for (let x = start + 1; x < end; x++) this.addBits(x, y, L | R, tone)
  }

  writeText(text: string, x: number, y: number, maxWidth: number, tone?: GraphTone) {
    let cursor = x
    const limit = x + maxWidth
    for (const { segment } of segmenter.segment(text)) {
      const width = graphemeWidth(segment)
      if (width === 0) continue
      if (cursor + width > limit || cursor + width > this.width) break
      const cell = this.cell(cursor, y)
      if (!cell || cell.continuation) break
      cell.ch = segment
      cell.mask = 0
      if (tone !== undefined) cell.tone = tone
      if (width === 2) {
        const next = this.cell(cursor + 1, y)
        if (!next) break
        next.ch = ""
        next.mask = 0
        next.continuation = true
        if (tone !== undefined) next.tone = tone
      }
      cursor += width
    }
  }

  lines(): DiagramLine[] {
    const lines: DiagramLine[] = []
    for (let y = 0; y < this.height; y++) {
      const spans: DiagramSpan[] = []
      let current: DiagramSpan | undefined
      for (let x = 0; x < this.width; x++) {
        const cell = this.cell(x, y)!
        if (cell.continuation) continue
        const ch = cell.ch || MASK_CHARS[cell.mask] || " "
        if (current !== undefined && current.tone === cell.tone) {
          current.text += ch
        } else {
          current = { text: ch, tone: cell.tone }
          spans.push(current)
        }
      }
      while (spans.length > 0) {
        const last = spans[spans.length - 1]!
        const trimmed = last.text.replace(/ +$/u, "")
        if (trimmed.length > 0) {
          last.text = trimmed
          break
        }
        spans.pop()
      }
      if (spans.length === 0) spans.push({ text: " " })
      lines.push(spans)
    }
    return lines
  }
}

function cleanText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/[\u0000-\u001f\u007f]/gu, " ")
}

function toneFor(node: LayoutNode): GraphTone {
  return node.state === "completed" && node.routedBack ? "rejected" : node.state
}

function contentFor(node: LayoutNode): string {
  const marker = toneFor(node) === "rejected" ? MARKERS.failed : MARKERS[node.state]
  const label = cleanText(node.label)
  return node.agent ? `${marker} ${label} · ${cleanText(node.agent)}` : `${marker} ${label}`
}

function outcomeLabel(outcome: string | undefined): string {
  return outcome?.replace(/_/gu, " ") ?? ""
}

function buildNodes(graph: RunGraphOutput): LayoutNode[] {
  const order = new Map(graph.mermaidNodes.map((item, index) => [item.nodeID, index]))
  const nodes: LayoutNode[] = graph.nodes.map((node) => ({
    id: node.nodeID,
    label: node.label,
    agent: node.agent ?? node.workflow,
    state: node.state,
    routedBack: node.routedBack === true,
    terminal: false,
    rank: 0,
    order: order.get(node.nodeID) ?? 0,
    x: 0,
    y: 0,
    width: 0,
  }))

  const terminals = new Set(graph.edges.filter((edge) => edge.terminal).map((edge) => edge.to))
  for (const id of ["complete", "pause"] as const) {
    if (!terminals.has(id)) continue
    const state: RunGraphNode["state"] =
      id === "complete"
        ? graph.status === "completed"
          ? "completed"
          : "pending"
        : graph.status === "paused"
          ? "paused"
          : "pending"
    nodes.push({
      id,
      label: id === "complete" ? "Complete" : "Pause",
      state,
      routedBack: false,
      terminal: true,
      rank: 0,
      order: Number.MAX_SAFE_INTEGER,
      x: 0,
      y: 0,
      width: 0,
    })
  }
  return nodes
}

function buildEdges(graph: RunGraphOutput): LayoutEdge[] {
  return graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    outcome: edge.outcome,
    back: false,
    side: "none",
    railX: 0,
    departY: 0,
    entryY: 0,
    lineY: 0,
    labelY: 0,
  }))
}

function findEntry(graph: RunGraphOutput, nodes: LayoutNode[]): string | undefined {
  const incoming = new Set(graph.edges.map((edge) => edge.to))
  const root = nodes.find((node) => !node.terminal && !incoming.has(node.id))
  return root?.id ?? graph.mermaidNodes[0]?.nodeID ?? nodes.find((node) => !node.terminal)?.id
}

function markBackEdges(nodes: LayoutNode[], edges: LayoutEdge[], entry: string | undefined) {
  const outgoing = new Map<string, LayoutEdge[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }

  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string) => {
    state.set(id, 1)
    for (const edge of outgoing.get(id) ?? []) {
      const target = state.get(edge.to) ?? 0
      if (target === 1) edge.back = true
      else if (target === 0) visit(edge.to)
    }
    state.set(id, 2)
  }

  if (entry !== undefined) visit(entry)
  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id)
  }
}

function assignRanks(nodes: LayoutNode[], edges: LayoutEdge[]) {
  const known = new Set(nodes.map((node) => node.id))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, LayoutEdge[]>()

  for (const edge of edges) {
    if (edge.back || !known.has(edge.from) || !known.has(edge.to)) continue
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  const rank = new Map(nodes.map((node) => [node.id, 0]))
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]!
    for (const edge of outgoing.get(id) ?? []) {
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(id) ?? 0) + 1))
      const next = (indegree.get(edge.to) ?? 0) - 1
      indegree.set(edge.to, next)
      if (next === 0) queue.push(edge.to)
    }
  }

  for (const node of nodes) node.rank = rank.get(node.id) ?? 0
}

function assignOrder(nodes: LayoutNode[], edges: LayoutEdge[], entry: string | undefined) {
  const outgoing = new Map<string, LayoutEdge[]>()
  for (const edge of edges) {
    if (edge.back) continue
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }

  const seen = new Set<string>()
  const queue = entry === undefined ? nodes.map((node) => node.id) : [entry]
  let head = 0
  let nextOrder = 0
  while (head < queue.length) {
    const id = queue[head++]!
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes.find((candidate) => candidate.id === id)
    if (node) node.order = nextOrder++
    for (const edge of outgoing.get(id) ?? []) queue.push(edge.to)
  }
  for (const node of nodes) {
    if (!seen.has(node.id)) node.order = nextOrder++
  }
}

function classifyEdges(nodes: LayoutNode[], edges: LayoutEdge[]) {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    const from = byID.get(edge.from)
    const to = byID.get(edge.to)
    if (!from || !to) continue
    if (edge.back || to.rank <= from.rank) edge.side = "left"
    else if (to.rank > from.rank + 1) edge.side = "right"
    else edge.side = "none"
  }
}

function groupRanks(nodes: LayoutNode[]) {
  const layers = new Map<number, LayoutNode[]>()
  for (const node of nodes) {
    const layer = layers.get(node.rank) ?? []
    layer.push(node)
    layers.set(node.rank, layer)
  }
  const ranks = [...layers.keys()].sort((a, b) => a - b)
  for (const rank of ranks) {
    layers.get(rank)!.sort((a, b) => {
      if (a.terminal !== b.terminal) return a.terminal ? 1 : -1
      if (a.terminal) return a.id === "complete" ? -1 : b.id === "complete" ? 1 : 0
      return a.order - b.order
    })
  }
  return { ranks, layers }
}

function rankOf(byID: Map<string, LayoutNode>, id: string): number {
  return byID.get(id)?.rank ?? 0
}

// shortcut: no crossing minimisation between sibling branches; same-side rail departures can still
// cross an older inner lane. tui.tsx falls back to the compact list when the result does not fit.
export function renderRunGraphDiagram(
  graph: RunGraphOutput,
  options: RunGraphDiagramOptions,
): RunGraphDiagramResult {
  if (graph.nodes.length === 0) return { reason: "no nodes" }

  const nodes = buildNodes(graph)
  if (nodes.length > (options.maxNodes ?? DEFAULT_MAX_NODES)) {
    return { reason: `too many nodes (${nodes.length})` }
  }
  const edges = buildEdges(graph)
  const entry = findEntry(graph, nodes)
  markBackEdges(nodes, edges, entry)
  assignRanks(nodes, edges)
  assignOrder(nodes, edges, entry)
  classifyEdges(nodes, edges)

  const { ranks, layers } = groupRanks(nodes)
  if (ranks.length === 0) return { reason: "no nodes" }

  const byID = new Map(nodes.map((node) => [node.id, node]))
  const sideEdges = edges.filter((edge) => edge.side !== "none")
  const leftEdges = sideEdges
    .filter((edge) => edge.side === "left")
    .sort((a, b) => {
      const rank = rankOf(byID, a.to) - rankOf(byID, b.to)
      if (rank !== 0) return rank
      const from = rankOf(byID, b.from) - rankOf(byID, a.from)
      if (from !== 0) return from
      return (a.outcome ?? "").localeCompare(b.outcome ?? "")
    })
  const rightEdges = sideEdges
    .filter((edge) => edge.side === "right")
    .sort((a, b) => {
      const rank = rankOf(byID, a.to) - rankOf(byID, b.to)
      if (rank !== 0) return rank
      const from = rankOf(byID, b.from) - rankOf(byID, a.from)
      if (from !== 0) return from
      return (a.outcome ?? "").localeCompare(b.outcome ?? "")
    })

  const leftReserve = leftEdges.length > 0 ? leftEdges.length * 2 + 2 : 0
  const rightReserve = rightEdges.length > 0 ? rightEdges.length * 2 + 2 : 0
  const widestLayer = Math.max(...ranks.map((rank) => layers.get(rank)!.length))
  const available = Math.max(0, Math.floor(options.width))
  const availableForBoxes =
    available - leftReserve - rightReserve - BOX_GAP * (widestLayer - 1)
  const maxBox = Math.min(
    options.maxBoxWidth ?? DEFAULT_MAX_BOX_WIDTH,
    Math.floor(availableForBoxes / widestLayer),
  )
  if (maxBox < MIN_BOX_WIDTH) return { reason: `needs ${MIN_BOX_WIDTH * widestLayer} columns` }

  const natural = Math.max(...nodes.map((node) => textWidth(contentFor(node)) + 4))
  const boxWidth = Math.max(MIN_BOX_WIDTH, Math.min(natural, maxBox))
  const contentWidth = widestLayer * boxWidth + BOX_GAP * (widestLayer - 1)
  const canvasWidth = leftReserve + contentWidth + rightReserve
  if (canvasWidth > available) return { reason: `needs ${canvasWidth} columns` }

  for (const rank of ranks) {
    const layer = layers.get(rank)!
    const layerWidth = layer.length * boxWidth + BOX_GAP * (layer.length - 1)
    const layerX = Math.floor((contentWidth - layerWidth) / 2)
    layer.forEach((node, index) => {
      node.x = leftReserve + layerX + index * (boxWidth + BOX_GAP)
      node.width = boxWidth
    })
  }

  leftEdges.forEach((edge, index) => void (edge.railX = 2 + index * 2))
  rightEdges.forEach(
    (edge, index) => void (edge.railX = leftReserve + contentWidth + 1 + index * 2),
  )

  const entryGroups = new Map<string, LayoutEdge[]>()
  for (const edge of [...leftEdges, ...rightEdges]) {
    const key = `${edge.to}\u0000${edge.side}`
    const group = entryGroups.get(key) ?? []
    group.push(edge)
    entryGroups.set(key, group)
  }
  for (const group of entryGroups.values()) {
    if (group.length > 3) return { reason: `too many edges into ${group[0]!.to}` }
  }

  let y = 0
  for (let index = 0; index < ranks.length; index++) {
    const rank = ranks[index]!
    for (const node of layers.get(rank)!) node.y = y
    const nextRank = ranks[index + 1]
    const departures = sideEdges
      .filter((edge) => rankOf(byID, edge.from) === rank)
      .sort((a, b) => {
        const aOuter = Math.abs(a.railX - (leftReserve + contentWidth / 2))
        const bOuter = Math.abs(b.railX - (leftReserve + contentWidth / 2))
        if (aOuter !== bOuter) return bOuter - aOuter
        return a.railX - b.railX
      })

    if (nextRank === undefined) {
      let cursor = y + BOX_HEIGHT
      for (const edge of departures) {
        if (outcomeLabel(edge.outcome)) edge.labelY = cursor++
        edge.departY = cursor++
      }
      y = cursor + (departures.length > 0 ? 1 : 0)
      break
    }

    const forward = edges
      .filter(
        (edge) =>
          edge.side === "none" &&
          rankOf(byID, edge.from) === rank &&
          rankOf(byID, edge.to) === nextRank,
      )
      .sort((a, b) => {
        const fromA = byID.get(a.from)
        const fromB = byID.get(b.from)
        const ax = (fromA?.x ?? 0) + Math.floor((fromA?.width ?? 0) / 2)
        const bx = (fromB?.x ?? 0) + Math.floor((fromB?.width ?? 0) / 2)
        if (ax !== bx) return ax - bx
        return (byID.get(a.to)?.x ?? 0) - (byID.get(b.to)?.x ?? 0)
      })

    const gapStart = y + BOX_HEIGHT
    let cursor = gapStart
    for (const edge of departures) {
      if (outcomeLabel(edge.outcome)) edge.labelY = cursor++
      edge.departY = cursor++
    }
    for (const edge of forward) {
      const from = byID.get(edge.from)
      const to = byID.get(edge.to)
      if (!from || !to) continue
      const sx = from.x + Math.floor(from.width / 2)
      const tx = to.x + Math.floor(to.width / 2)
      if (outcomeLabel(edge.outcome)) edge.labelY = cursor++
      if (sx !== tx) edge.lineY = cursor++
    }
    y = Math.max(cursor + 1, gapStart + 2)
  }

  for (const group of entryGroups.values()) {
    const target = byID.get(group[0]!.to)
    if (!target) continue
    const rows =
      group.length <= 2
        ? [target.y + 1, target.y + 2]
        : [target.y, target.y + 1, target.y + 2]
    group.sort((a, b) => a.railX - b.railX)
    group.forEach((edge, index) => void (edge.entryY = rows[index]!))
  }

  const canvasHeight = y
  if (canvasHeight > options.maxLines) {
    return { reason: `needs ${canvasHeight} lines` }
  }

  const canvas = new Canvas(canvasWidth, canvasHeight)
  const labels: Label[] = []

  for (const node of nodes) {
    const x = node.x
    const top = node.y
    const bottom = node.y + BOX_HEIGHT - 1
    const right = x + node.width - 1
    const tone = toneFor(node)

    for (let offset = 1; offset < node.width - 1; offset++) {
      canvas.addBits(x + offset, top, L | R, tone)
      canvas.addBits(x + offset, bottom, L | R, tone)
    }
    canvas.addBits(x, top, D | R, tone)
    canvas.addBits(right, top, D | L, tone)
    canvas.addBits(x, bottom, U | R, tone)
    canvas.addBits(right, bottom, U | L, tone)
    canvas.addBits(x, top + 1, U | D, tone)
    canvas.addBits(right, top + 1, U | D, tone)

    const content = truncate(contentFor(node), node.width - 4)
    canvas.writeText(content, x + 2, top + 1, node.width - 4, tone)
  }

  for (const edge of edges) {
    const from = byID.get(edge.from)
    const to = byID.get(edge.to)
    if (!from || !to) continue
    const sx = from.x + Math.floor(from.width / 2)
    const tx = to.x + Math.floor(to.width / 2)

    if (edge.side === "left") {
      canvas.addBits(sx, from.y + BOX_HEIGHT - 1, D, "edge")
      canvas.segV(sx, from.y + BOX_HEIGHT - 1, edge.departY, "edge")
      canvas.segH(edge.departY, sx, edge.railX, "edge")
      canvas.segV(edge.railX, edge.departY, edge.entryY, "edge")
      canvas.segH(edge.entryY, edge.railX, to.x - 1, "edge")
      canvas.set(to.x - 1, edge.entryY, "▶", "edge")
      canvas.addBits(to.x, edge.entryY, L, "edge")
      continue
    }

    if (edge.side === "right") {
      canvas.addBits(sx, from.y + BOX_HEIGHT - 1, D, "edge")
      canvas.segV(sx, from.y + BOX_HEIGHT - 1, edge.departY, "edge")
      canvas.segH(edge.departY, sx, edge.railX, "edge")
      canvas.segV(edge.railX, edge.departY, edge.entryY, "edge")
      canvas.segH(edge.entryY, edge.railX, to.x + to.width, "edge")
      canvas.set(to.x + to.width, edge.entryY, "◀", "edge")
      canvas.addBits(to.x + to.width - 1, edge.entryY, R, "edge")
      continue
    }

    canvas.addBits(sx, from.y + BOX_HEIGHT - 1, D, "edge")
    canvas.addBits(tx, to.y, U, "edge")
    if (sx === tx) {
      canvas.segV(sx, from.y + BOX_HEIGHT - 1, to.y - 1, "edge")
    } else {
      canvas.segV(sx, from.y + BOX_HEIGHT - 1, edge.lineY, "edge")
      canvas.segH(edge.lineY, sx, tx, "edge")
      canvas.segV(tx, edge.lineY, to.y - 1, "edge")
    }
    canvas.set(tx, to.y - 1, "▼", "edge")
  }

  const contentEnd = leftReserve + contentWidth
  for (const edge of edges) {
    const label = outcomeLabel(edge.outcome)
    if (!label) continue
    const from = byID.get(edge.from)
    const to = byID.get(edge.to)
    if (!from || !to) continue
    const sx = from.x + Math.floor(from.width / 2)
    const tx = to.x + Math.floor(to.width / 2)
    let x: number
    let maxWidth: number
    if (edge.side !== "none" || sx === tx) {
      x = sx + 2
      maxWidth = contentEnd - x - 1
      if (maxWidth < textWidth(label)) {
        x = sx + 1
        maxWidth = contentEnd - x - 1
      }
    } else {
      x = Math.min(sx, tx) + 2
      maxWidth = Math.abs(sx - tx) - 2
      if (maxWidth < 4) {
        x = sx + 2
        maxWidth = contentEnd - x - 1
      }
    }
    labels.push({ text: label, x, y: edge.labelY, maxWidth: Math.max(0, maxWidth) })
  }

  for (const label of labels) {
    if (label.y < 0 || label.y >= canvasHeight) continue
    canvas.writeText(truncate(label.text, label.maxWidth), label.x, label.y, label.maxWidth, "edgeLabel")
  }

  return { lines: canvas.lines(), width: canvasWidth, height: canvasHeight }
}
