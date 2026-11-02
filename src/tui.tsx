/** @jsxImportSource @opentui/solid */
import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { RpcClient } from "@opencode/client/promise"
import { FlowgraphRpc, type FlowgraphRpcDefinition } from "./rpc.js"
import type { RunGraphOutput, RunGraphNode, WorkflowSummaryView } from "./contract.js"
import type { RunStatus } from "./state/types.js"
import { parseWorkflowCommand } from "./command.js"
import { listLocatedRuns, waitForRunSession, type LocatedRun } from "./ui/runs.js"
import { errorDetail } from "./util/redact.js"
import { withTimeout } from "./util/timeout.js"
import { PLUGIN_VERSION } from "./version.js"

const PANEL = "flowgraph.graph"
const PAGE = "workflow"

type FlowgraphRpcClient = RpcClient<FlowgraphRpcDefinition>

type GraphSource = {
  rpc: FlowgraphRpcClient
  directory: string
  runID: string
}

function requestID(): string {
  return `tui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function terminalLabel(target: string): string {
  return target === "complete" ? "Complete" : target === "pause" ? "Pause" : target
}

function nodeMarker(node: RunGraphNode): string {
  switch (node.state) {
    case "active":
      return "▶"
    case "completed":
      return "✓"
    case "failed":
      return "✗"
    case "paused":
      return "⏸"
    default:
      return "○"
  }
}

function statusMarker(status: RunStatus): string {
  switch (status) {
    case "running":
      return "▶"
    case "pausing":
    case "paused":
      return "⏸"
    case "blocked":
      return "!"
    case "completed":
      return "✓"
    case "failed":
      return "✗"
    default:
      return "×"
  }
}

function directoryLabel(directory: string): string {
  return directory.split(/[\\/]/u).filter(Boolean).at(-1) ?? directory
}

function objectiveLabel(objective: string): string {
  const line = objective.replace(/\s+/gu, " ").trim()
  return line.length > 64 ? `${line.slice(0, 61)}…` : line
}

function WorkflowGraph(props: {
  id: string
  source: () => GraphSource | undefined
  active?: () => boolean
  onRefresh?: () => void
}) {
  const context = usePlugin()
  const [graph, setGraph] = createSignal<RunGraphOutput>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)

  let generation = 0
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const load = async (source: GraphSource, current: number): Promise<boolean> => {
    try {
      const result = await withTimeout(
        source.rpc.getRunGraph({ runID: source.runID }, { location: { directory: source.directory } }),
        10_000,
        "Workflow RPC timed out while loading the graph",
      )
      if (current !== generation) return false
      setGraph(result)
      setError(undefined)
      return true
    } catch (cause) {
      if (current !== generation) return false
      setError(errorDetail(cause, "Unable to load the workflow graph"))
      return false
    }
  }

  const start = async (source: GraphSource | undefined) => {
    const current = ++generation
    unsubscribe?.()
    unsubscribe = undefined
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    setGraph(undefined)
    setError(undefined)
    setLoading(source !== undefined)
    if (!source) return

    try {
      const capabilities = await withTimeout(
        source.rpc.capabilities(undefined, { location: { directory: source.directory } }),
        5_000,
        "Workflow RPC unavailable on this server; is the flowgraph plugin loaded?",
      )
      if (current !== generation) return
      if (capabilities.plugin.version !== PLUGIN_VERSION) {
        setError(
          `TUI plugin ${PLUGIN_VERSION} is connected to server plugin ${capabilities.plugin.version}. ` +
            `Restart OpenCode so both parts load the same version.`,
        )
        return
      }

      const loaded = await load(source, current)
      if (current !== generation || !loaded) return
      unsubscribe = source.rpc.events.on("runUpdated", (event) => {
        if (event.data.runID === source.runID) void load(source, current)
      })
      timer = setInterval(() => void load(source, current), 3_000)
    } catch (cause) {
      if (current === generation) setError(errorDetail(cause, "Unable to load the workflow graph"))
    } finally {
      if (current === generation) setLoading(false)
    }
  }

  createEffect(
    on(
      () => {
        const source = props.source()
        return source ? `${source.directory}\u0000${source.runID}` : ""
      },
      () => void start(props.source()),
    ),
  )

  onCleanup(() => {
    generation += 1
    unsubscribe?.()
    if (timer !== undefined) clearInterval(timer)
  })

  const activeSession = () => {
    const current = graph()
    if (!current?.activeNode) return undefined
    return current.nodes.find((node) => node.nodeID === current.activeNode)?.sessionIDs.at(-1)
  }

  const openActive = () => {
    const sessionID = activeSession()
    if (!sessionID) {
      context.ui.toast.show({ message: "No active workflow session", variant: "warning" })
      return
    }
    context.ui.router.navigate({ type: "session", sessionID })
  }

  const pause = async () => {
    const current = graph()
    const source = props.source()
    if (!current || !source) return
    try {
      await source.rpc.pauseRun(
        { runID: current.runID, requestID: requestID(), expectedRevision: current.revision },
        { location: { directory: source.directory } },
      )
    } catch (cause) {
      context.ui.toast.show({ message: errorDetail(cause, "Pause failed"), variant: "error" })
    }
  }

  const resume = async () => {
    const current = graph()
    const source = props.source()
    if (!current || !source) return
    const confirm = current.status === "blocked"
    if (confirm) {
      const ok = await context.ui.dialog.confirm({
        title: "Retry workflow node?",
        message: "The active node is ambiguous. Retrying may repeat work. Continue?",
        label: { confirm: "Retry", cancel: "Cancel" },
      })
      if (!ok) return
    }
    try {
      await source.rpc.resumeRun(
        { runID: current.runID, requestID: requestID(), expectedRevision: current.revision, confirmRetry: confirm },
        { location: { directory: source.directory } },
      )
    } catch (cause) {
      context.ui.toast.show({ message: errorDetail(cause, "Resume failed"), variant: "error" })
    }
  }

  const cancel = async () => {
    const current = graph()
    const source = props.source()
    if (!current || !source) return
    const ok = await context.ui.dialog.confirm({
      title: "Cancel workflow run?",
      message: "Future nodes will not execute. The active node may be interrupted.",
      label: { confirm: "Cancel run", cancel: "Keep running" },
    })
    if (!ok) return
    try {
      await source.rpc.cancelRun(
        { runID: current.runID, requestID: requestID(), expectedRevision: current.revision },
        { location: { directory: source.directory } },
      )
    } catch (cause) {
      context.ui.toast.show({ message: errorDetail(cause, "Cancel failed"), variant: "error" })
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 20,
    enabled: () => props.active?.() ?? true,
    commands: [
      {
        id: `flowgraph.${props.id}.refresh`,
        title: "Refresh workflow graph",
        bind: "r",
        run: () => {
          void start(props.source())
          props.onRefresh?.()
        },
      },
      {
        id: `flowgraph.${props.id}.open`,
        title: "Open active workflow session",
        bind: "enter",
        run: openActive,
      },
      {
        id: `flowgraph.${props.id}.toggle`,
        title: "Pause or resume workflow",
        bind: "p",
        run: () => {
          const current = graph()
          if (!current) return
          if (current.status === "paused" || current.status === "blocked") void resume()
          else void pause()
        },
      },
      {
        id: `flowgraph.${props.id}.cancel`,
        title: "Cancel workflow run",
        bind: "c",
        run: () => void cancel(),
      },
    ],
  }))

  const color = (node: RunGraphNode) => {
    switch (node.state) {
      case "active":
        return context.theme.text.feedback.success.base
      case "completed":
        return context.theme.text.muted
      case "failed":
        return context.theme.text.feedback.error.base
      case "paused":
        return context.theme.text.feedback.warning.base
      default:
        return context.theme.text.faint
    }
  }

  return (
    <box flexDirection="column">
      <Show when={error()}>
        {(message) => <text fg={context.theme.text.feedback.error.base}>{message()}</text>}
      </Show>
      <Show
        when={graph()}
        fallback={
          <Show when={!error()}>
            <text fg={context.theme.text.muted}>
              {loading() ? "Loading workflow graph…" : "No workflow run selected."}
            </text>
          </Show>
        }
      >
        {(current) => {
          const value = current()
          const completed = value.nodes.filter((node) => node.state === "completed").length
          return (
            <box flexDirection="column">
              <text fg={context.theme.text.base}>
                Workflow {value.workflowID} · {value.status} · {completed}/{value.nodes.length} nodes
              </text>
              <text fg={context.theme.text.muted}>
                Run {value.runID} · revision {value.revision}
              </text>
              <Show when={value.blocker}>
                {(blocker) => <text fg={context.theme.text.feedback.warning.base}>Blocked: {blocker().message}</text>}
              </Show>
              <Show when={value.failure}>
                {(failure) => (
                  <text fg={context.theme.text.feedback.error.base}>
                    Failed: {failure().code} — {failure().message}
                    {failure().nodeID ? ` (${failure().nodeID})` : ""}
                  </text>
                )}
              </Show>
              <Show when={value.pendingPermissions.length > 0}>
                <text fg={context.theme.text.feedback.warning.base}>
                  Waiting for {value.pendingPermissions.length} native permission request(s)
                </text>
              </Show>
              <text> </text>
              {value.nodes.map((node) => {
                const edges = value.edges.filter((edge) => edge.from === node.nodeID)
                return (
                  <box flexDirection="column">
                    <text fg={color(node)}>
                      {nodeMarker(node)} {node.label} ({node.agent}) · {node.stepCount} step(s)
                      {node.sessionIDs.length > 0 ? ` · ${node.sessionIDs.length} session(s)` : ""}
                    </text>
                    {edges.map((edge) => (
                      <text fg={context.theme.text.muted}>
                        {"    "}
                        {edge.outcome === undefined ? "→" : `${edge.outcome} →`} {terminalLabel(edge.to)}
                      </text>
                    ))}
                  </box>
                )
              })}
              <text> </text>
              <text fg={context.theme.text.faint}>
                enter open active session · p pause/resume · c cancel · r refresh
              </text>
            </box>
          )
        }}
      </Show>
    </box>
  )
}

function WorkflowPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const location = () => context.location ?? context.data.location.default()
  const rpc = () => context.client.rpc(FlowgraphRpc)

  const session = () => {
    try {
      return context.data.session.get(props.panel.sessionID)
    } catch {
      return undefined
    }
  }
  const runID = () => {
    const metadata = session()?.metadata as Record<string, unknown> | undefined
    return typeof metadata?.runID === "string" ? metadata.runID : undefined
  }
  const directory = () => session()?.location.directory ?? location().directory

  const source = (): GraphSource | undefined => {
    const id = runID()
    return id ? { rpc: rpc(), directory: directory(), runID: id } : undefined
  }

  return (
    <box flexDirection="column" padding={1}>
      <Show
        when={source()}
        fallback={<text fg={context.theme.text.muted}>This session is not a workflow run. Run /workflow to choose one.</text>}
      >
        <WorkflowGraph
          id="panel"
          source={source}
          active={() => context.ui.panel.current()?.name === PANEL}
        />
      </Show>
    </box>
  )
}

function WorkflowPage(props: { data?: Record<string, unknown>; openRun: (sessionID: string) => void }) {
  const context = usePlugin()
  const location = () => context.location ?? context.data.location.default()
  const rpc = () => context.client.rpc(FlowgraphRpc)
  const [runs, setRuns] = createSignal<LocatedRun[]>([])
  const [selected, setSelected] = createSignal<LocatedRun>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [unavailable, setUnavailable] = createSignal(0)

  const initialRunID = () => (typeof props.data?.runID === "string" ? props.data.runID : undefined)
  const initialDirectory = () =>
    typeof props.data?.directory === "string" ? props.data.directory : undefined
  let appliedInitial: string | undefined

  const refreshRuns = async () => {
    try {
      const result = await listLocatedRuns({
        client: context.client,
        rpc: rpc(),
        currentDirectory: location().directory,
      })
      setRuns(result.runs)
      setUnavailable(result.unavailable.length)
      setError(undefined)
      const wantedID = initialRunID()
      const wantedDirectory = initialDirectory()
      const wanted =
        wantedID && wantedID !== appliedInitial
          ? result.runs.find(
              (item) =>
                item.run.runID === wantedID && (!wantedDirectory || item.directory === wantedDirectory),
            )
          : undefined
      if (wanted) appliedInitial = wantedID
      const previous = selected()
      const match =
        wanted ??
        (previous
          ? result.runs.find(
              (item) => item.run.runID === previous.run.runID && item.directory === previous.directory,
            )
          : undefined) ??
        (wantedID
          ? result.runs.find(
              (item) => item.run.runID === wantedID && (!wantedDirectory || item.directory === wantedDirectory),
            )
          : undefined)
      setSelected(match ?? result.runs[0])
    } catch (cause) {
      setError(errorDetail(cause, "Unable to list workflow runs"))
    } finally {
      setLoading(false)
    }
  }

  const move = (delta: number) => {
    const list = runs()
    if (list.length === 0) return
    const current = selected()
    const index = current
      ? list.findIndex((item) => item.run.runID === current.run.runID && item.directory === current.directory)
      : -1
    const next = index === -1 ? 0 : (index + delta + list.length) % list.length
    setSelected(list[next])
  }

  const openSelected = () => {
    const current = selected()
    if (!current?.run.runSessionID) {
      context.ui.toast.show({ message: "This workflow run has no session yet", variant: "warning" })
      return
    }
    props.openRun(current.run.runSessionID)
  }

  const isPage = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === PAGE
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 21,
    enabled: isPage,
    commands: [
      { id: "flowgraph.page.next", title: "Next workflow run", bind: "down", run: () => move(1) },
      { id: "flowgraph.page.previous", title: "Previous workflow run", bind: "up", run: () => move(-1) },
      { id: "flowgraph.page.open", title: "Open workflow run tab", bind: "o", run: openSelected },
    ],
  }))

  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleRefresh = () => {
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshRuns()
    }, 1_000)
  }

  onMount(() => {
    void refreshRuns()
    unsubscribe = rpc().events.on("runUpdated", scheduleRefresh)
    timer = setInterval(() => void refreshRuns(), 15_000)
  })
  onCleanup(() => {
    unsubscribe?.()
    if (timer !== undefined) clearInterval(timer)
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  })

  const source = (): GraphSource | undefined => {
    const current = selected()
    return current ? { rpc: rpc(), directory: current.directory, runID: current.run.runID } : undefined
  }

  return (
    <box flexDirection="column" padding={1}>
      <text fg={context.theme.text.base}>
        Workflow runs · {runs().length}
        {unavailable() > 0 ? ` · ${unavailable()} location(s) unavailable` : ""}
      </text>
      <Show when={error()}>
        {(message) => <text fg={context.theme.text.feedback.error.base}>{message()}</text>}
      </Show>
      <Show when={!loading() && runs().length === 0 && !error()}>
        <text fg={context.theme.text.muted}>No workflow runs visible for this server.</text>
      </Show>
      {runs().map((item) => {
        const current = selected()
        const active = current?.run.runID === item.run.runID && current.directory === item.directory
        return (
          <text fg={active ? context.theme.text.feedback.success.base : context.theme.text.muted}>
            {statusMarker(item.run.status)} {item.run.workflowID} · {item.run.status} · {directoryLabel(item.directory)}
            {` · ${objectiveLabel(item.run.objective)}`}
          </text>
        )
      })}
      <text> </text>
      <text fg={context.theme.text.faint}>up/down select · o open run tab · r refresh · enter active session · p pause/resume · c cancel</text>
      <text> </text>
      <WorkflowGraph id="page" source={source} active={isPage} onRefresh={() => void refreshRuns()} />
    </box>
  )
}

export default Plugin.define({
  id: "flowgraph.tui",
  setup(context) {
    const location = () => context.location ?? context.data.location.default()
    const rpc = () => context.client.rpc(FlowgraphRpc)

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant })

    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const sessionRunID = (sessionID: string | undefined): string | undefined => {
      if (!sessionID) return undefined
      try {
        const metadata = context.data.session.get(sessionID)?.metadata as Record<string, unknown> | undefined
        return typeof metadata?.runID === "string" ? metadata.runID : undefined
      } catch {
        return undefined
      }
    }

    const startDirectory = () => {
      const sessionID = currentSessionID()
      if (sessionID) {
        try {
          const directory = context.data.session.get(sessionID)?.location.directory
          if (directory) return directory
        } catch {
          // Fall back to the TUI location.
        }
      }
      return location().directory
    }

    const openPanelInSession = (sessionID: string) => {
      context.ui.tabs.open(sessionID)
      context.ui.tabs.focus(sessionID)
      context.ui.router.navigate({ type: "session", sessionID })
      let attempts = 0
      const attempt = () => {
        const route = context.ui.router.current()
        let known = false
        try {
          known = context.data.session.get(sessionID) !== undefined
        } catch {
          known = false
        }
        const ready = route.type === "session" && route.sessionID === sessionID && known
        if (ready && context.ui.panel.open(PANEL)) return
        if (++attempts < 10) {
          setTimeout(attempt, 50)
          return
        }
        context.ui.router.navigate({ type: "plugin", name: PAGE })
      }
      queueMicrotask(attempt)
    }

    const openGraph = () => {
      const sessionID = currentSessionID()
      if (sessionID && sessionRunID(sessionID) && context.ui.panel.open(PANEL)) return
      context.ui.router.navigate({ type: "plugin", name: PAGE })
    }

    const pickWorkflow = async (): Promise<string | undefined> => {
      try {
        const directory = startDirectory()
        const result = await rpc().listWorkflows(undefined, { location: { directory } })
        if (result.workflows.length === 0) {
          toast(`No workflows found in ${result.directory}`, "warning")
          return undefined
        }
        return await context.ui.dialog.select<string>({
          title: "Start workflow",
          placeholder: "Search workflows",
          options: result.workflows.map((workflow: WorkflowSummaryView) => ({
            title: workflow.id,
            value: workflow.id,
            description: workflow.description ?? (workflow.valid ? undefined : workflow.errors[0]?.message),
            disabled: !workflow.valid,
          })),
        })
      } catch (cause) {
        toast(errorDetail(cause, "Unable to list workflows"), "error")
        return undefined
      }
    }

    const start = async (workflowID: string, objective: string) => {
      const directory = startDirectory()
      try {
        const run = await rpc().startRun(
          { workflowID, objective, requestID: requestID() },
          { location: { directory } },
        )
        toast(`Started ${workflowID} (${run.runID})`, "success")
        const runSessionID = await waitForRunSession(rpc(), directory, run.runID)
        if (runSessionID) openPanelInSession(runSessionID)
        else context.ui.router.navigate({ type: "plugin", name: PAGE, data: { runID: run.runID, directory } })
      } catch (cause) {
        toast(errorDetail(cause, "Unable to start workflow"), "error")
      }
    }

    const runCommand = async (input?: string) => {
      const command = parseWorkflowCommand(input)

      if (command.type === "graph") {
        openGraph()
        return
      }
      if (command.type === "runs") {
        context.ui.router.navigate({ type: "plugin", name: PAGE })
        return
      }

      const workflowID = command.type === "run" && command.workflowID ? command.workflowID : await pickWorkflow()
      if (!workflowID) return

      const objective =
        command.type === "run" && command.objective
          ? command.objective
          : await context.ui.dialog.prompt({
              title: `Objective for ${workflowID}`,
              placeholder: "What should the workflow do?",
            })
      if (!objective) return

      await start(workflowID, objective)
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "flowgraph.graph",
          title: "Workflow",
          description: "Open the graph, list workflows, or start a run",
          group: "Flowgraph",
          palette: true,
          slash: { name: "workflow", arguments: true },
          run: (input) => void runCommand(input),
        },
      ],
      bindings: ["flowgraph.graph"],
    }))
    const unregisterPage = context.ui.router.register({
      name: PAGE,
      render: (input) => <WorkflowPage data={input.data} openRun={openPanelInSession} />,
    })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <WorkflowPanel panel={panel} />
        </Show>
      ),
    })
    return () => unregisterPage()
  },
})
