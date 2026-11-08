import type { RunRecord } from "../state/types.js"

export type LimitFailure = {
  code: "run_timeout"
  message: string
}

export function checkRunDeadline(run: RunRecord, now: number): LimitFailure | undefined {
  if (now >= run.deadlineAt) {
    return { code: "run_timeout", message: `workflow exceeded its ${run.workflowSnapshot.limits.timeout_seconds}s run timeout` }
  }
  return undefined
}
