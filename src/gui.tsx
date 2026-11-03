import { Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Style,
  usePlugin,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui"
import mermaid from "mermaid"
import { FlowgraphRpc } from "./rpc.js"
import type { RunGraphOutput } from "./contract.js"
import { parseWorkflowCommand } from "./command.js"
import { listLocatedRuns, waitForRunSession, type LocatedRun } from "./ui/runs.js"
import { errorDetail } from "./util/redact.js"
import { withTimeout } from "./util/timeout.js"

const TAB_ID = "graph"

const css = `
.awf-graph { display:flex; flex-direction:column; gap:10px; height:100%; min-height:0; padding:12px; font-size:12px; }
.awf-graph-header { display:flex; flex-direction:column; gap:2px; }
.awf-graph-title { font-weight:600; }
.awf-graph-muted { opacity:.65; }
.awf-graph-warn { color:#c47c00; }
.awf-graph-error { color:#c43d3d; }
.awf-graph-actions { display:flex; flex-wrap:wrap; gap:6px; }
.awf-graph-actions button { border:1px solid currentColor; border-radius:6px; background:transparent; padding:3px 8px; cursor:pointer; color:inherit; }
.awf-graph-actions button:disabled { opacity:.4; cursor:default; }
.awf-mermaid { flex:1; min-height:0; overflow:auto; font-size:14px; }
.awf-mermaid svg { max-width:100%; height:auto; }
.awf-mermaid g.node { cursor:default; }
.awf-mermaid g.node.wf-clickable { cursor:pointer; }
.awf-mermaid .nodeLabel, .awf-mermaid .label, .awf-mermaid text { fill:#f7fafc !important; color:#f7fafc !important; font-size:14px !important; }
.awf-mermaid .edgeLabel, .awf-mermaid .edgeLabel * { fill:#e2e8f0 !important; color:#e2e8f0 !important; font-size:12px !important; }
.awf-mermaid .edgeLabel rect { fill:#1a202c !important; opacity:1 !important; }
.awf-mermaid .edgePath .path { stroke:#a0aec0 !important; stroke-width:1.5px !important; }
.awf-mermaid g.node rect, .awf-mermaid g.node polygon, .awf-mermaid g.node path { fill:#2d3748 !important; stroke:#a0aec0 !important; }
.awf-mermaid g.node.wf-active rect,
.awf-mermaid g.node.wf-active polygon,
.awf-mermaid g.node.wf-active path { fill:#f4c95d !important; stroke:#8a5a00 !important; stroke-width:2px !important; }
.awf-mermaid g.node.wf-active .nodeLabel, .awf-mermaid g.node.wf-active text { fill:#1a202c !important; color:#1a202c !important; }
.awf-zoom { display:inline-flex; align-items:center; gap:4px; }
.awf-zoom button { min-width:24px; }
.awf-zoom span { opacity:.65; min-width:36px; text-align:center; }
`

function requestID(): string {
  return `gui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function directoryLabel(directory: string): string {
  return directory.split(/[\\/]/u).filter(Boolean).at(-1) ?? directory
}

function objectiveLabel(objective: string): string {
  const line = objective.replace(/\s+/gu, " ").trim()
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

function nodeSession(graph: RunGraphOutput, nodeID: string): string | undefined {
  return graph.nodes.find((node) => node.nodeID === nodeID)?.sessionIDs.at(-1)
}

function WorkflowGraphPanel(props: { session: MountedSession; onPickRun: () => void }) {
  const ctx = usePlugin()
  const [graph, setGraph] = createSignal<RunGraphOutput>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [zoom, setZoom] = createSignal(100)
  let container: HTMLDivElement | undefined
  let renderSequence = 0

  const location = () => ({ directory: props.session.directory })
  const rpc = () => props.session.server.client.rpc(FlowgraphRpc)

  const load = async (runID: string): Promise<boolean> => {
    try {
      const result = await rpc().getRunGraph({ runID }, { location: location() })
      setGraph(result)
      setError(undefined)
      return true
    } catch (cause) {
      setError(errorDetail(cause, "Unable to load the workflow graph"))
      return false
    }
  }

  const resolveRun = async (): Promise<string | undefined> => {
    try {
      const session = await props.session.server.client.session.get({ sessionID: props.session.id })
      const metadata = session.metadata as Record<string, unknown> | undefined
      if (typeof metadata?.runID === "string") return metadata.runID
    } catch {
      // The panel only follows workflow sessions; use the run picker otherwise.
    }
    return undefined
  }

  const render = async (value: RunGraphOutput) => {
    if (!container) return
    const sequence = ++renderSequence
    try {
      const id = `awf-${value.runID}-${value.revision}-${sequence}`.replace(/[^a-zA-Z0-9_-]/g, "-")
      const { svg } = await mermaid.render(id, value.mermaid)
      if (sequence !== renderSequence || !container) return
      container.innerHTML = svg
      const active = value.activeMermaidID
      for (const element of Array.from(container.querySelectorAll<SVGGElement>("g.node"))) {
        const mermaidID = value.mermaidNodes.find(
          (node) => element.id.includes(`-${node.mermaidID}-`) || element.id.endsWith(`-${node.mermaidID}`),
        )?.nodeID
        if (!mermaidID) continue
        const node = value.nodes.find((candidate) => candidate.nodeID === mermaidID)
        if (node?.state === "active") element.classList.add("wf-active")
        const sessionID = nodeSession(value, mermaidID)
        if (sessionID) element.classList.add("wf-clickable")
        element.addEventListener("click", () => {
          const session = nodeSession(value, mermaidID)
          if (session) {
            ctx.tabs.open({ server: props.session.server.id, id: session }, { focus: true })
            return
          }
          const label = value.nodes.find((candidate) => candidate.nodeID === mermaidID)?.label ?? mermaidID
          ctx.toast.show({
            title: "Workflow",
            description:
              value.status === "failed"
                ? `Node "${label}" has no session: the run failed before it started.`
                : `Node "${label}" has no session yet.`,
            variant: "default",
          })
        })
      }
      if (active) {
        for (const element of Array.from(container.querySelectorAll<SVGGElement>("g.node"))) {
          if (element.id.includes(`-${active}-`)) element.classList.add("wf-active")
        }
      }
    } catch (cause) {
      setError(errorDetail(cause, "Unable to render Mermaid"))
    }
  }

  createEffect(() => {
    const value = graph()
    if (value) void render(value)
  })

  let generation = 0
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const start = async () => {
    const current = ++generation
    unsubscribe?.()
    unsubscribe = undefined
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    setLoading(true)
    setError(undefined)
    setGraph(undefined)
    try {
      const runID = await withTimeout(
        resolveRun(),
        10_000,
        "Workflow RPC timed out while resolving the run; is the plugin loaded on this server?",
      )
      if (current !== generation) return
      if (!runID) {
        setError("This session is not a workflow run. Use Runs to choose one.")
        return
      }
      const loaded = await withTimeout(load(runID), 10_000, "Workflow RPC timed out while loading the graph")
      if (current !== generation || !loaded) return
      unsubscribe = rpc().events.on("runUpdated", (event) => {
        if (event.data.runID === runID) void load(runID)
      })
      timer = setInterval(() => void load(runID), 3_000)
    } catch (cause) {
      if (current !== generation) return
      setError(errorDetail(cause, "Unable to load the workflow graph"))
    } finally {
      if (current === generation) setLoading(false)
    }
  }

  createEffect(on(() => props.session.id, () => void start()))
  onCleanup(() => {
    generation += 1
    unsubscribe?.()
    if (timer !== undefined) clearInterval(timer)
  })

  const activeSession = () => {
    const value = graph()
    return value?.activeNode ? nodeSession(value, value.activeNode) : undefined
  }

  const openActive = () => {
    const sessionID = activeSession()
    if (!sessionID) return
    ctx.tabs.open({ server: props.session.server.id, id: sessionID }, { focus: true })
  }

  const pause = async () => {
    const value = graph()
    if (!value) return
    try {
      await rpc().pauseRun(
        { runID: value.runID, requestID: requestID(), expectedRevision: value.revision },
        { location: location() },
      )
    } catch (cause) {
      ctx.toast.show({ title: "Workflow", description: errorDetail(cause, "Pause failed"), variant: "error" })
    }
  }

  const resume = async () => {
    const value = graph()
    if (!value) return
    const confirm = value.status === "blocked"
    if (confirm) {
      const ok = await ctx.dialogs.confirm({
        title: "Retry workflow node?",
        description: "The active node is ambiguous. Retrying may repeat work. Continue?",
        confirm: "Retry",
        cancel: "Cancel",
      })
      if (!ok) return
    }
    try {
      await rpc().resumeRun(
        { runID: value.runID, requestID: requestID(), expectedRevision: value.revision, confirmRetry: confirm },
        { location: location() },
      )
    } catch (cause) {
      ctx.toast.show({ title: "Workflow", description: errorDetail(cause, "Resume failed"), variant: "error" })
    }
  }

  const cancel = async () => {
    const value = graph()
    if (!value) return
    const ok = await ctx.dialogs.confirm({
      title: "Cancel workflow run?",
      description: "Future nodes will not execute. The active node may be interrupted.",
      confirm: "Cancel run",
      cancel: "Keep running",
      danger: true,
    })
    if (!ok) return
    try {
      await rpc().cancelRun(
        { runID: value.runID, requestID: requestID(), expectedRevision: value.revision },
        { location: location() },
      )
    } catch (cause) {
      ctx.toast.show({ title: "Workflow", description: errorDetail(cause, "Cancel failed"), variant: "error" })
    }
  }

  return (
    <div class="awf-graph">
      <Show when={error()}>
        {(message) => <div class="awf-graph-error">{message()}</div>}
      </Show>
      <Show
        when={graph()}
        fallback={
          <div class="awf-graph-muted">
            {loading() ? "Loading workflow graph…" : ""}
            {!loading() && !error() ? "No workflow run selected." : ""}
            <div class="awf-graph-actions">
              <button onClick={props.onPickRun}>Runs</button>
            </div>
          </div>
        }
      >
        {(current) => {
          const value = current()
          return (
            <>
              <div class="awf-graph-header">
                <div class="awf-graph-title">
                  Workflow {value.workflowID} · {value.status} · {value.nodes.filter((node) => node.state === "completed").length}/
                  {value.nodes.length} nodes
                </div>
                <div class="awf-graph-muted">
                  Run {value.runID} · revision {value.revision}
                </div>
                <Show when={value.blocker}>
                  {(blocker) => <div class="awf-graph-warn">Blocked: {blocker().message}</div>}
                </Show>
                <Show when={value.failure}>
                  {(failure) => (
                    <div class="awf-graph-error">
                      Failed: {failure().code} — {failure().message}
                      {failure().nodeID ? ` (${failure().nodeID})` : ""}
                    </div>
                  )}
                </Show>
                <Show when={value.pendingPermissions.length > 0}>
                  <div class="awf-graph-warn">
                    Waiting for {value.pendingPermissions.length} native permission request(s)
                  </div>
                </Show>
              </div>
              <div class="awf-graph-actions">
                <button onClick={props.onPickRun}>Runs</button>
                <button onClick={openActive} disabled={!activeSession()}>Open active session</button>
                <button onClick={pause} disabled={!value.controls.canPause}>Pause</button>
                <button onClick={resume} disabled={!value.controls.canResume}>Resume</button>
                <button onClick={cancel} disabled={!value.controls.canCancel}>Cancel</button>
                <span class="awf-zoom">
                  <button onClick={() => setZoom((current) => Math.max(50, current - 10))} title="Zoom out">−</button>
                  <span>{zoom()}%</span>
                  <button onClick={() => setZoom((current) => Math.min(200, current + 10))} title="Zoom in">+</button>
                  <button onClick={() => setZoom(100)} title="Reset zoom">1:1</button>
                </span>
              </div>
              <div class="awf-mermaid" ref={container} style={{ zoom: `${zoom()}%` }} />
              <div class="awf-graph-muted">Click a node to open its native session.</div>
            </>
          )
        }}
      </Show>
    </div>
  )
}

const graphTab: PanelTab = {
  id: TAB_ID,
  title: "Workflow graph",
  closable: "compact",
  fallback: true,
}

export default Plugin.define({
  setup(ctx) {
    const panelKey = `${ctx.id}:${TAB_ID}`
    const [pendingRunSession, setPendingRunSession] = createSignal<{ server: string; sessionID: string }>()

    const toast = (description: string, variant: "default" | "success" | "error" = "default") =>
      ctx.toast.show({ title: "Workflow", description, variant })

    const currentServer = () => {
      const session = ctx.sessions.current()
      if (session) return session.server
      const servers = ctx.servers.list().map((id) => ctx.servers.get(id))
      return servers.find((server) => server?.builtin) ?? servers.find(Boolean)
    }

    const openRun = (server: string, runSessionID: string) => {
      setPendingRunSession({ server, sessionID: runSessionID })
      ctx.tabs.open({ server, id: runSessionID }, { focus: true })
    }

    createEffect(() => {
      const target = pendingRunSession()
      if (!target) return
      const session = ctx.sessions
        .list()
        .find((item) => item.id === target.sessionID && item.server.id === target.server)
      if (!session) return
      ctx.layout.open(panelKey, session, { tab: "select" })
      setPendingRunSession(undefined)
    })

    const pickRun = async () => {
      const server = currentServer()
      if (!server) {
        toast("No server is reachable.", "error")
        return
      }
      const directory = ctx.sessions.current()?.directory
      const rpc = server.client.rpc(FlowgraphRpc)
      try {
        const result = await listLocatedRuns({ client: server.client, rpc, currentDirectory: directory })
        if (result.runs.length === 0) {
          toast("No workflow runs visible for this server.")
          return
        }
        const selected = await ctx.dialogs.select<LocatedRun>({
          title: "Open workflow run",
          placeholder: "Search runs",
          options: result.runs.map((item) => ({
            title: `${item.run.workflowID} · ${item.run.status}`,
            value: item,
            description: `${directoryLabel(item.directory)} · ${objectiveLabel(item.run.objective)}`,
          })),
        })
        if (!selected) return
        const runSessionID =
          selected.run.runSessionID ??
          (await waitForRunSession(rpc, selected.directory, selected.run.runID))
        if (!runSessionID) {
          toast("The workflow run has no session yet.", "error")
          return
        }
        openRun(server.id, runSessionID)
      } catch (cause) {
        toast(errorDetail(cause, "Unable to list workflow runs"), "error")
      }
    }

    const open = () => {
      const session = ctx.sessions.current()
      if (!session) {
        void pickRun()
        return
      }
      void (async () => {
        let runID: string | undefined
        try {
          const info = await session.server.client.session.get({ sessionID: session.id })
          const metadata = info.metadata as Record<string, unknown> | undefined
          if (typeof metadata?.runID === "string") runID = metadata.runID
        } catch {
          // Not a workflow session; offer the run picker.
        }
        if (runID) ctx.layout.open(panelKey, session, { tab: "select" })
        else void pickRun()
      })()
    }

    const pickWorkflow = async (): Promise<string | undefined> => {
      const session = ctx.sessions.current()
      if (!session) {
        toast("Open a session before starting a workflow.")
        return undefined
      }
      try {
        const result = await session.server.client
          .rpc(FlowgraphRpc)
          .listWorkflows(undefined, { location: { directory: session.directory } })
        if (result.workflows.length === 0) {
          toast(`No workflows found in ${result.directory}`)
          return undefined
        }
        return await ctx.dialogs.select<string>({
          title: "Start workflow",
          placeholder: "Search workflows",
          options: result.workflows.map((workflow) => ({
            title: workflow.id,
            value: workflow.id,
            description: workflow.description ?? (workflow.valid ? undefined : workflow.errors[0]?.message),
          })),
        })
      } catch (cause) {
        toast(errorDetail(cause, "Unable to list workflows"), "error")
        return undefined
      }
    }

    const start = async (workflowID: string, objective: string) => {
      const session = ctx.sessions.current()
      if (!session) {
        toast("Open a session before starting a workflow.")
        return
      }
      const rpc = session.server.client.rpc(FlowgraphRpc)
      try {
        const run = await rpc.startRun(
          { workflowID, objective, requestID: requestID() },
          { location: { directory: session.directory } },
        )
        toast(`Started ${workflowID} (${run.runID})`, "success")
        const runSessionID = await waitForRunSession(rpc, session.directory, run.runID)
        if (runSessionID) openRun(session.server.id, runSessionID)
        else toast("Workflow started, but its session is not ready yet.")
      } catch (cause) {
        toast(errorDetail(cause, "Unable to start workflow"), "error")
      }
    }

    const runCommand = async (input?: string) => {
      const command = parseWorkflowCommand(input)

      if (command.type === "graph") {
        open()
        return
      }
      if (command.type === "runs") {
        await pickRun()
        return
      }

      const workflowID = command.type === "run" && command.workflowID ? command.workflowID : await pickWorkflow()
      if (!workflowID) return

      const objective =
        command.type === "run" && command.objective
          ? command.objective
          : await ctx.dialogs.prompt({
              title: `Objective for ${workflowID}`,
              placeholder: "What should the workflow do?",
            })
      if (!objective) return

      await start(workflowID, objective)
    }

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        background: "#1a202c",
        primaryColor: "#2d3748",
        primaryTextColor: "#f7fafc",
        primaryBorderColor: "#a0aec0",
        lineColor: "#a0aec0",
        secondaryColor: "#2d3748",
        tertiaryColor: "#2d3748",
        edgeLabelBackground: "#1a202c",
        textColor: "#f7fafc",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
      },
      flowchart: { curve: "basis", nodeSpacing: 30, rankSpacing: 55, padding: 10, useMaxWidth: true },
    })

    ctx.add(Command, (): Command => ({
      id: "graph",
      title: "Workflow",
      description: "Open the graph, list workflows, or start a run",
      group: "Workflow",
      slash: { name: "flowgraph", arguments: true },
      run: (input) => void runCommand(input),
    }))

    ctx.add(MenuItem, (): MenuItem => ({
      menu: "session.panel",
      id: "graph",
      title: "Workflow graph",
      keybind: `${ctx.id}.graph`,
      opened: ctx.sessions.current()
        ? ctx.layout.state(panelKey, ctx.sessions.current()!) !== "closed"
        : false,
      run: open,
    }))

    ctx.add(Style, css)

    ctx.add(Panel, {
      id: TAB_ID,
      region: "side",
      mobile: { title: "Workflow", order: 50, kind: "menu" },
      list: (input) => (input.open.includes(TAB_ID) ? [graphTab] : []),
      render: (props) => <WorkflowGraphPanel session={props.session} onPickRun={() => void pickRun()} />,
    })
  },
})
