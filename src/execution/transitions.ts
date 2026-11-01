import { resolveTransition, type WorkflowGraph } from "../workflow/graph.js"
export function nextTarget(graph: WorkflowGraph, nodeID: string, outcome?: string): string {
  return resolveTransition(graph, nodeID, outcome)
}

export function transitionKey(from: string, outcome: string | undefined, to: string): string {
  return `${from}\u0000${outcome ?? ""}\u0000${to}`
}

export function repeatedTransitionCount(
  steps: ReadonlyArray<{ nodeID: string; outcome?: string }>,
  from: string,
  outcome: string | undefined,
  to: string,
): number {
  const keys: string[] = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    const next = steps[index + 1]
    if (next) keys.push(transitionKey(step.nodeID, step.outcome, next.nodeID))
  }
  keys.push(transitionKey(from, outcome, to))
  let count = 1
  for (let index = keys.length - 2; index >= 0; index -= 1) {
    if (keys[index] !== keys[keys.length - 1]) break
    count += 1
  }
  return count
}
