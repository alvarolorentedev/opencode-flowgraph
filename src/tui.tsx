/** @jsxImportSource @opentui/solid */
import { Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { FlowgraphRpc } from "./rpc.js"
import type { RunGraphOutput, RunGraphNode, WorkflowSummaryView } from "./contract.js"
import { parseWorkflowCommand } from "./command.js"
import { errorDetail } from "./util/redact.js"
import { withTimeout } from "./util/timeout.js"

const PANEL = "flowgraph.graph"

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

function WorkflowPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const [graph, setGraph] = createSignal<RunGraphOutput>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const location = () => context.location ?? context.data.location.default()
  const rpc = () => context.client.rpc(FlowgraphRpc)

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
      const session = context.data.session.get(props.panel.sessionID)
      const metadata = session?.metadata as Record<string, unknown> | undefined
      if (typeof metadata?.runID === "string") return metadata.runID
    } catch {
      // Fall back to the project run list.
    }
    const runs = await rpc().listRuns({ limit: 50 }, { location: location() })
    return (
      runs.runs.find((run) => run.status === "running" || run.status === "pausing" || run.status === "blocked")?.runID ??
      runs.runs[0]?.runID
    )
  }

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
        "Workflow RPC timed out while listing runs; is the plugin loaded on this server?",
      )
      if (current !== generation) return
      if (!runID) {
        setError(`No workflow runs visible for ${location().directory}`)
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

  createEffect(on(() => props.panel.sessionID, () => void start()))
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
    if (!current) return
    try {
      await rpc().pauseRun(
        { runID: current.runID, requestID: requestID(), expectedRevision: current.revision },
        { location: location() },
      )
    } catch (cause) {
      context.ui.toast.show({ message: errorDetail(cause, "Pause failed"), variant: "error" })
    }
  }

  const resume = async () => {
    const current = graph()
    if (!current) return
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
      await rpc().resumeRun(
        { runID: current.runID, requestID: requestID(), expectedRevision: current.revision, confirmRetry: confirm },
        { location: location() },
      )
    } catch (cause) {
      context.ui.toast.show({ message: errorDetail(cause, "Resume failed"), variant: "error" })
    }
  }

  const cancel = async () => {
    const current = graph()
    if (!current) return
    const ok = await context.ui.dialog.confirm({
      title: "Cancel workflow run?",
      message: "Future nodes will not execute. The active node may be interrupted.",
      label: { confirm: "Cancel run", cancel: "Keep running" },
    })
    if (!ok) return
    try {
      await rpc().cancelRun(
        { runID: current.runID, requestID: requestID(), expectedRevision: current.revision },
        { location: location() },
      )
    } catch (cause) {
      context.ui.toast.show({ message: errorDetail(cause, "Cancel failed"), variant: "error" })
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 20,
    enabled: () => context.ui.panel.current()?.name === PANEL,
    commands: [
      { id: "flowgraph.graph.refresh", title: "Refresh workflow graph", bind: "r", run: () => {
        const current = graph()
        if (current) void load(current.runID)
      } },
      { id: "flowgraph.graph.open", title: "Open active workflow session", bind: "enter", run: openActive },
      { id: "flowgraph.graph.toggle", title: "Pause or resume workflow", bind: "p", run: () => {
        const current = graph()
        if (!current) return
        if (current.status === "paused" || current.status === "blocked") void resume()
        else void pause()
      } },
      { id: "flowgraph.graph.cancel", title: "Cancel workflow run", bind: "c", run: () => void cancel() },
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
    <box flexDirection="column" padding={1}>
      <Show when={error()}>
        {(message) => <text fg={context.theme.text.feedback.error.base}>{message()}</text>}
      </Show>
      <Show when={graph()} fallback={<text fg={context.theme.text.muted}>{loading() ? "Loading workflow graph…" : ""}</text>}>
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

export default Plugin.define({
  id: "flowgraph.tui",
  setup(context) {
    const location = () => context.location ?? context.data.location.default()
    const rpc = () => context.client.rpc(FlowgraphRpc)

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant })

    const open = () => {
      if (!context.ui.panel.open(PANEL)) {
        toast("Open a session before viewing the workflow graph", "warning")
      }
    }

    const pickWorkflow = async (): Promise<string | undefined> => {
      try {
        const result = await rpc().listWorkflows(undefined, { location: location() })
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
      try {
        const run = await rpc().startRun(
          { workflowID, objective, requestID: requestID() },
          { location: location() },
        )
        toast(`Started ${workflowID} (${run.runID})`, "success")
        open()
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
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <WorkflowPanel panel={panel} />
        </Show>
      ),
    })
  },
})
