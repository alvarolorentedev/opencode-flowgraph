# Recovery and state

Runtime state lives in OpenCode plugin storage, keyed by project:

```text
v1/runs/<projectID>/<runID>
v1/steps/<projectID>/<runID>/<stepID>
v1/reports/<projectID>/<runID>/<stepID>
v1/run-sources/<projectID>/<runID>
v1/workflow-backups/<projectID>/<workflowID>/<hash>
v1/idem/<projectID>/<sha256(requestID)>
v1/leases/<projectID>
```

Workflow definitions remain YAML files in `.opencode/workflows`. Runtime checkpoints are never written into the repository.

## Statuses

`running`, `pausing`, `paused`, `blocked`, `completed`, `failed`, `cancelled`.

`blocked` means the run needs an external action: a native permission decision, or an explicit retry decision after an interruption or ambiguous node.

## Restart matrix

| Crash point | Recovery |
|---|---|
| Before prompt admission | Safe to retry preparation without consuming a node execution |
| Prompt admitted, node still active | Wait/reconcile; do not prompt again |
| Node succeeded and valid report exists | Persist the step and continue |
| Node succeeded but report is missing | Block with `missing_report`; require an explicit resume |
| Node failed or interrupted | Block with a node failure/interruption blocker |
| No terminal idle outcome | Block with `ambiguous_node` |
| Next node checkpoint persisted | Continue from the next node |
| Recovery attempts exhausted | Fail with `recovery_exhausted` |
| Run deadline expired | Fail with `run_timeout` |

A blocked ambiguous node is never re-prompted automatically. `resumeRun({ confirmRetry: true })` is the explicit retry boundary.

Node sessions are child sessions of the workflow-run session. OpenCode's native restart sweep resumes top-level orphaned claims and releases orphaned child claims, so the workflow plugin owns node-session reconciliation.

## Concurrency

- One active workflow per canonical project tree.
- Host-local file lock with heartbeat and stale timeout.
- KV lease for observability and fail-closed cross-host detection.
- Per-run in-process mutex for record mutations.
- Revision preconditions on control RPCs.
- Multi-host execution is not supported in the MVP.

## Limits

- `max_steps` counts actual node executions, including repetitions.
- `timeout_seconds` is a wall-clock run deadline.
- `node_timeout_seconds` bounds one node; the runner interrupts the session on timeout.
- `max_result_retries` bounds correction turns after a missing report.
- `max_recovery_attempts` bounds restart reconciliation.
- `max_repeat_transitions` stops a repeated transition sequence that makes no progress.
- Cost and token usage are estimates; they are not enforced spending caps.
