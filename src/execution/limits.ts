import type { RunRecord } from "../state/types.js"

export type LimitFailure = {
  code: "max_steps_exhausted" | "run_timeout" | "node_timeout" | "no_progress" | "recovery_exhausted"
  message: string
}

export function checkRunDeadline(run: RunRecord, now: number): LimitFailure | undefined {
  if (now >= run.deadlineAt) {
    return { code: "run_timeout", message: `workflow exceeded its ${run.workflowSnapshot.limits.timeout_seconds}s run timeout` }
  }
  return undefined
}

export function checkBeforeNextNode(run: RunRecord, target: string, now: number): LimitFailure | undefined {
  const deadline = checkRunDeadline(run, now)
  if (deadline) return deadline
  if (target !== "complete" && target !== "pause" && run.stepCount >= run.maxSteps) {
    return {
      code: "max_steps_exhausted",
      message: `workflow reached max_steps (${run.maxSteps}) before executing node "${target}"`,
    }
  }
  return undefined
}
