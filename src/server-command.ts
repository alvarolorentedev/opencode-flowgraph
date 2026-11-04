import { randomUUID } from "node:crypto"
import { parseWorkflowCommand } from "./command.js"
import type { WorkflowService } from "./service.js"
import { errorDetail } from "./util/redact.js"

// Headless rendering of /flowgraph for API-driven clients (mobile, web).
// TUI/GUI navigate and open dialogs; the server command can only reply with text.

function objectiveLabel(objective: string): string {
  const line = objective.replace(/\s+/gu, " ").trim()
  return line.length > 64 ? `${line.slice(0, 61)}…` : line
}

function usage(): string {
  return [
    "Usage:",
    "- `/flowgraph list` — list workflows",
    "- `/flowgraph run <workflow-id> <objective...>` — start a run",
    "- `/flowgraph runs` — list runs",
    "- `/flowgraph graph <runID>` — describe one run",
  ].join("\n")
}

function cleanInput(rawInput?: string): string {
  const text = (rawInput ?? "").trim()
  // `session.command` already strips the command name; tolerate a raw "/flowgraph" prefix.
  return text.replace(/^\/flowgraph(?:\s+|$)/iu, "")
}

function graphRunID(cleaned: string): string | undefined {
  const [, ...rest] = cleaned.split(/\s+/u)
  const id = (rest.join(" ") || "").trim()
  return id.length === 0 ? undefined : id
}

async function runsText(service: WorkflowService): Promise<string> {
  const runs = await service.listRuns(undefined, 50)
  if (runs.length === 0) return "No workflow runs yet. Start one with `/flowgraph run <workflow-id> <objective...>`."
  const lines = runs.map(
    (run) => `- ${run.runID} · ${run.workflowID} · ${run.status} · ${objectiveLabel(run.objective)}`,
  )
  return [`Runs (${runs.length}):`, ...lines].join("\n")
}

export async function runServerCommand(
  service: WorkflowService,
  rawInput?: string,
  options?: { requestID?: string },
): Promise<string> {
  const cleaned = cleanInput(rawInput)
  const command = parseWorkflowCommand(cleaned)
  try {
    if (command.type === "list") {
      const result = await service.listWorkflows()
      if (result.workflows.length === 0) return `No workflows found in ${result.directory}.`
      const lines = result.workflows.map((workflow) => {
        const state = workflow.valid ? "valid" : `invalid: ${workflow.errors[0]?.message ?? "see getWorkflow"}`
        const description = workflow.description ? ` — ${workflow.description}` : ""
        return `- ${workflow.id}${description} (${state})`
      })
      return [`Workflows (${result.workflows.length}):`, ...lines].join("\n")
    }

    if (command.type === "run") {
      if (!command.workflowID || !command.objective) {
        let hint = ""
        try {
          const result = await service.listWorkflows()
          if (result.workflows.length > 0) {
            hint = `\nAvailable: ${result.workflows.map((workflow) => workflow.id).join(", ")}`
          }
        } catch {
          // Usage text must never fail because the hint lookup failed.
        }
        return `${usage()}${hint}`
      }
      const started = await service.startRun(command.workflowID, command.objective, options?.requestID ?? randomUUID())
      return [
        `Started workflow '${command.workflowID}'.`,
        `Run ID: ${started.runID}`,
        `Status: ${started.status} (revision ${started.revision})`,
        "Track it with `/flowgraph runs` or RPC getRun / getRunGraph.",
      ].join("\n")
    }

    if (command.type === "runs") return await runsText(service)

    const runID = graphRunID(cleaned)
    if (runID === undefined) {
      const runs = await runsText(service)
      return `${runs}\n\nTip: \`/flowgraph graph <runID>\` describes one run. The Workflow panel and RPC getRunGraph show the full graph.`
    }
    const graph = await service.getRunGraph(runID)
    const done = graph.nodes.filter((node) => node.state === "completed").length
    const lines = [
      `Workflow ${graph.workflowID} · ${graph.status} · ${done}/${graph.nodes.length} nodes`,
      `Run ${graph.runID} · revision ${graph.revision}`,
    ]
    if (graph.activeNode) lines.push(`Active node: ${graph.activeNode}`)
    if (graph.blocker) lines.push(`Blocked: ${graph.blocker.message}`)
    if (graph.failure) lines.push(`Failed: ${graph.failure.code} — ${graph.failure.message}`)
    if (graph.pendingPermissions.length > 0) {
      lines.push(`Waiting for ${graph.pendingPermissions.length} native permission request(s)`)
    }
    return lines.join("\n")
  } catch (error) {
    return errorDetail(error, "Unable to run workflow command")
  }
}
