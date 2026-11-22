import { buildGraph, validateGraph, type Diagnostic, type WorkflowGraph } from "./graph.js"
import type { WorkflowDefinition } from "./schema.js"

export type AgentMode = "subagent" | "primary" | "all"

export type AgentDescriptor = {
  id: string
  name: string

  /** Preferred: the adapter decides selectability. */
  selectable?: boolean
  reason?: { code: string; message: string }

  /** OpenCode-compatible metadata; optional and ignored by other adapters. */
  mode?: AgentMode
  hidden?: boolean
  model?: { providerID: string; id: string; variant?: string }
  description?: string
}

export type AgentResolution = {
  agentID: string
  resolved: boolean
  mode?: AgentMode
  hidden?: boolean
  name?: string
  error?: string
}

export type WorkflowValidation = {
  valid: boolean
  workflow: WorkflowDefinition
  graph: WorkflowGraph
  errors: Diagnostic[]
  warnings: string[]
  agents: AgentResolution[]
}

export function resolveAgents(
  workflow: WorkflowDefinition,
  agents: readonly AgentDescriptor[],
  options: { hasDefaultModel?: boolean } = {},
): { resolutions: AgentResolution[]; errors: Diagnostic[] } {
  const hasDefaultModel = options.hasDefaultModel ?? true
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const resolutions: AgentResolution[] = []
  const errors: Diagnostic[] = []
  const checked = new Set<string>()

  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (!("agent" in node) || checked.has(node.agent)) continue
    checked.add(node.agent)
    const agent = byId.get(node.agent)
    if (!agent) {
      resolutions.push({ agentID: node.agent, resolved: false, error: "unknown agent" })
      errors.push({
        path: `nodes.${nodeId}.agent`,
        message: `agent "${node.agent}" was not found in the native agent list`,
        code: "unknown_agent",
      })
      continue
    }

    // Adapters that understand their own selectability take precedence.
    if (agent.selectable !== undefined) {
      if (agent.selectable) {
        resolutions.push({
          agentID: node.agent,
          resolved: true,
          ...(agent.mode === undefined ? {} : { mode: agent.mode }),
          ...(agent.hidden === undefined ? {} : { hidden: agent.hidden }),
          name: agent.name,
        })
        continue
      }
      resolutions.push({
        agentID: node.agent,
        resolved: false,
        ...(agent.mode === undefined ? {} : { mode: agent.mode }),
        ...(agent.hidden === undefined ? {} : { hidden: agent.hidden }),
        name: agent.name,
        error: agent.reason?.message ?? "agent is not selectable",
      })
      errors.push({
        path: `nodes.${nodeId}.agent`,
        message: agent.reason?.message ?? `agent "${node.agent}" is not selectable`,
        code: agent.reason?.code ?? "agent_unavailable",
      })
      continue
    }

    if (agent.hidden) {
      resolutions.push({
        agentID: node.agent,
        resolved: false,
        mode: agent.mode,
        hidden: true,
        name: agent.name,
        error: "hidden agent",
      })
      errors.push({
        path: `nodes.${nodeId}.agent`,
        message: `agent "${node.agent}" is hidden and cannot be selected by workflows`,
        code: "hidden_agent",
      })
      continue
    }
    if (agent.mode === "subagent") {
      resolutions.push({
        agentID: node.agent,
        resolved: false,
        mode: agent.mode,
        hidden: false,
        name: agent.name,
        error: "subagent-only agent",
      })
      errors.push({
        path: `nodes.${nodeId}.agent`,
        message:
          `agent "${node.agent}" is mode "subagent". Workflow nodes select agents directly; ` +
          `change the native agent to mode "all" or "primary" to use it in a workflow.`,
        code: "subagent_agent_not_selectable",
      })
      continue
    }
    if (agent.model === undefined && !hasDefaultModel) {
      resolutions.push({
        agentID: node.agent,
        resolved: false,
        mode: agent.mode,
        hidden: false,
        name: agent.name,
        error: "missing model",
      })
      errors.push({
        path: `nodes.${nodeId}.agent`,
        message:
          `agent "${node.agent}" has no model and no default model is configured; ` +
          `set a model on the agent or set "model" in the native configuration.`,
        code: "agent_missing_model",
      })
      continue
    }
    resolutions.push({
      agentID: node.agent,
      resolved: true,
      mode: agent.mode,
      hidden: false,
      name: agent.name,
    })
  }

  return { resolutions, errors }
}

export function validateWorkflow(
  workflow: WorkflowDefinition,
  agents: readonly AgentDescriptor[],
  options: { hasDefaultModel?: boolean; resultsSupported?: boolean } = {},
): WorkflowValidation {
  const graph = buildGraph(workflow)
  const graphResult = validateGraph(workflow, graph)
  const agentResult = resolveAgents(workflow, agents, options)
  const errors = [...graphResult.errors, ...agentResult.errors]
  const warnings = [...graphResult.warnings, ...graph.warnings]

  if (options.resultsSupported === false) {
    for (const [nodeID, node] of Object.entries(workflow.nodes)) {
      if (!("agent" in node)) continue
      errors.push({
        path: `nodes.${nodeID}.agent`,
        message: "the selected harness cannot return structured results for agent nodes",
        code: "harness_results_unsupported",
      })
    }
  }

  return {
    valid: errors.length === 0,
    workflow,
    graph,
    errors,
    warnings,
    agents: agentResult.resolutions,
  }
}
