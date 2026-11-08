import type { ActiveStep, Blocker, Branch, RunRecord } from "../state/types.js"
import { isTerminal, type WorkflowDefinition } from "../workflow/schema.js"
import { transitionKey } from "./transitions.js"

export function definitionOf(run: RunRecord, workflowID: string): WorkflowDefinition {
  const definition = workflowID === run.workflowID ? run.workflowSnapshot : run.workflowDependencies?.[workflowID]?.definition
  if (!definition) throw new Error(`missing workflow snapshot "${workflowID}"`)
  return definition
}

export function activeSteps(run: RunRecord): ActiveStep[] {
  if (!run.execution) return run.activeStep ? [run.activeStep] : []
  return run.execution.branches.flatMap((branch) => branch.active ? [branch.active] : [])
    .sort((a, b) => a.stepIndex - b.stepIndex)
}

export function blockersOf(run: RunRecord): Blocker[] {
  if (!run.execution) return run.blocker ? [run.blocker] : []
  return run.execution.branches.flatMap((branch) => branch.blocker ? [branch.blocker] : [])
}

export function displayNode(step: { nodeID: string; callPath?: string[] | undefined }): string {
  return step.callPath?.[0] ?? step.nodeID
}

export function initialize(run: RunRecord) {
  if (run.execution) return run.execution
  const active = run.activeStep
  const completed = run.steps.filter((step) => step.status === "completed")
  const branch: Branch = {
    id: "root",
    workflowID: run.workflowID,
    nodeID: active?.nodeID ?? run.nextNode ?? run.currentNode ?? run.workflowSnapshot.entry,
    calls: [],
    previous: completed.slice(-3).map((step) => step.stepID),
    ...(active === null ? {} : { active }),
    ...(run.blocker === null ? {} : { blocker: run.blocker, permissions: run.pendingPermissions }),
  }
  for (const [index, step] of completed.entries()) {
    const target = completed[index + 1]?.nodeID ?? branch.nodeID
    trackTransition(branch, step.nodeID, step.outcome, target)
  }
  run.execution = {
    branches: [branch],
    joins: {},
    enteredForks: [],
    nextFork: 1,
    nextStep: Math.max(run.stepCount, active?.stepIndex ?? 0, ...run.steps.map((step) => step.seq)) + 1,
  }
  return run.execution
}

export function trackTransition(branch: Branch, from: string, outcome: string | undefined, target: string): number {
  const key = transitionKey(from, outcome, target)
  const count = branch.repeat?.key === key ? branch.repeat.count + 1 : 1
  branch.repeat = { key, count }
  return count
}

export function projectCheckpoint(run: RunRecord, now: number): void {
  const branches = run.execution!.branches
  run.activeStep = activeSteps(run)[0] ?? null
  run.blocker = blockersOf(run)[0] ?? null
  run.pendingPermissions = branches.flatMap((branch) => branch.permissions ?? [])
  const ready = branches.find((branch) => !branch.active)
  run.nextNode = ready ? ready.calls[0]?.nodeID ?? ready.nodeID : null
  run.currentNode = run.activeStep ? displayNode(run.activeStep) : run.nextNode

  if (run.status === "running" || run.status === "blocked") {
    run.status = branches.length > 0 && branches.every((branch) => branch.blocker) ? "blocked" : "running"
  }
  if (run.status === "pausing" && branches.every((branch) => !branch.active || branch.active.phase === "ambiguous")) {
    run.status = "paused"
    run.pause = { reason: "user", requestedAt: now }
  }
}

export class FrontierLimitError extends Error {}

// Consume control nodes and barrier arrivals before another prompt can be admitted.
export function advance(run: RunRecord, now: number, admit: boolean): void {
  const execution = run.execution!
  const branches = execution.branches
  for (let index = 0; index < branches.length;) {
    const branch = branches[index]!
    if (branch.active) {
      index += 1
      continue
    }

    const join = branch.join && execution.joins[branch.join.id]
    if (join && branch.calls.length === join.continuation.calls.length && branch.nodeID === join.target) {
      const last = branch.previous.at(-1)
      if (!last) throw new Error("branch reached its join without a result")
      join.arrivals[branch.join!.index] = last
      branches.splice(index, 1)
      if (join.arrivals.every((arrival) => arrival !== null)) {
        branches.splice(index, 0, { ...join.continuation, previous: join.arrivals, joined: true })
        delete execution.joins[branch.join!.id]
      }
      continue
    }

    if (isTerminal(branch.nodeID)) {
      const frame = branch.calls.pop()
      if (frame) {
        const caller = definitionOf(run, frame.workflowID).nodes[frame.nodeID]
        if (!caller || !("workflow" in caller)) throw new Error("missing caller in workflow snapshot")
        const outcome = branch.nodeID
        const target = caller.routes[outcome]
        branch.workflowID = frame.workflowID
        branch.nodeID = target
        branch.repeat = frame.repeat
        const last = branch.previous.at(-1)
        if (!last) throw new Error("called workflow reached a terminal without a result")
        branch.previous = [...frame.previous.slice(-2), last]
        if (trackTransition(branch, frame.nodeID, outcome, target) > definitionOf(run, frame.workflowID).limits.max_repeat_transitions) {
          throw new RepeatedTransitionError(frame.nodeID)
        }
        continue
      }
      if (branch.join || branches.length !== 1) throw new Error("parallel branch exited before its join")
      branches.splice(index, 1)
      if (branch.nodeID === "complete") {
        run.status = "completed"
        run.completedAt = now
      } else {
        run.status = "paused"
        run.pause = { reason: "route", requestedAt: now }
      }
      break
    }

    const node = definitionOf(run, branch.workflowID).nodes[branch.nodeID]
    if (!node) throw new Error(`missing node "${branch.nodeID}" in workflow snapshot`)
    if (!admit || "agent" in node) {
      index += 1
      continue
    }
    if ("workflow" in node) {
      if (node.workflow === branch.workflowID || branch.calls.some((frame) => frame.workflowID === node.workflow)) {
        throw new Error("recursive workflow call in checkpoint")
      }
      branch.calls.push({ workflowID: branch.workflowID, nodeID: branch.nodeID, previous: branch.previous, repeat: branch.repeat })
      branch.workflowID = node.workflow
      branch.nodeID = definitionOf(run, node.workflow).entry
      delete branch.repeat
      continue
    }

    if (branches.length - 1 + node.fork.length > run.maxSteps) throw new FrontierLimitError()
    const id = String(execution.nextFork++)
    if (branch.calls.length === 0 && !execution.enteredForks.includes(branch.nodeID)) execution.enteredForks.push(branch.nodeID)
    execution.joins[id] = {
      target: node.join,
      continuation: { ...branch, nodeID: node.join, repeat: undefined },
      arrivals: node.fork.map(() => null),
    }
    branches.splice(index, 1, ...node.fork.map((nodeID, branchIndex) => ({
      ...branch,
      id: `${id}.${branchIndex}`,
      nodeID,
      join: { id, index: branchIndex },
      repeat: undefined,
      calls: [...branch.calls],
    })))
  }
  projectCheckpoint(run, now)
}

export class RepeatedTransitionError extends Error {
  constructor(readonly nodeID: string) {
    super(`the same transition repeated at node "${nodeID}"`)
  }
}
