# Operations and recovery

## Run lifecycle

Statuses: `running`, `pausing`, `paused`, `blocked`, `completed`, `failed`, `cancelled`.

`blocked` means the run needs an external action: a native permission decision, or an explicit retry decision after an interruption or ambiguous node.

- MVP execution is sequential: one node session at a time.
- One active workflow per canonical project tree. Separate canonical trees can run concurrently.
- The TUI page and Desktop run picker list runs from every project and worktree on the connected server.
- Each node runs in a fresh native child session of a stable workflow-run session.
- The workflow graph is snapshotted at run start. Editing the YAML does not affect an active run.
- Native agent definitions are owned by OpenCode and resolved when each node session starts; editing an agent affects later nodes. The plugin never copies or edits agent definitions.
- Paused-at-terminal runs are not resumable; start a new run.
- Exactly-once external side effects are not promised.
- Cost and token usage are provider-reported estimates, not enforced spending caps.

## Execution model

1. Validate the YAML and resolve native agents.
2. Snapshot the validated workflow and hash.
3. Create a durable run record and project lock.
4. Create a stable workflow-run session.
5. For each node, create a fresh native child session with the configured agent.
6. Prompt with a bounded context handoff.
7. Wait/poll the native session; surface pending permissions.
8. Read the typed report, validate the outcome against the graph, and persist a step.
9. Resolve the next transition in the orchestrator.
10. Persist checkpoints after every transition.

## Storage

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

Storage has no transactions or compare-and-swap. The plugin uses a host-local project lock, a KV lease, in-process mutexes, and revision preconditions. One OpenCode server per project database is supported; multi-host HA is not.

## Restart and recovery

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

Completed nodes are never rerun merely because the server restarted. A node that finished before the last checkpoint is reconciled from its native session and persisted report. An interrupted or ambiguous active node is blocked, not blindly re-prompted.

`resumeRun` with `confirmRetry: true` explicitly retries an ambiguous node in a new session. A blocked ambiguous node is never re-prompted automatically.

Node sessions are child sessions of the workflow-run session. OpenCode's native restart sweep resumes top-level orphaned claims and releases orphaned child claims, so the workflow plugin owns node-session reconciliation.

## Failure boundaries

- Missing/invalid report after bounded corrections: node/run fails.
- Native failure or interruption: explicit failure or blocked state.
- Permission pending: blocked, never auto-approved.
- Ambiguous active node after restart: blocked, never automatically re-prompted.
- Storage corruption: invalid state, fail closed.
- Unsupported concurrent writers: project lock plus fail-closed checks.

## Concurrency

- One active workflow per canonical project tree.
- Host-local file lock with heartbeat and stale timeout.
- KV lease for observability and fail-closed cross-host detection.
- Per-run in-process mutex for record mutations.
- Revision preconditions on control RPCs.
- Multi-host execution is not supported in the MVP.

## Permissions and Git

- Native permissions are respected.
- Pending permission requests are surfaced through `getRun` and native sessions.
- The plugin never auto-approves a permission.
- The plugin adds no Git side effects: no branches, commits, pushes, pull requests, worktrees, or release process.
- Agents may use Git under their own native permissions and project policy.
- Background `subagent` and `shell` calls are rejected inside workflow sessions by default because they would outlive the sequential node. Set the plugin option `allowBackgroundWork: true` to opt out.
- Workflow nodes cannot modify protected configuration paths: `.opencode`, `opencode.json`, `opencode.jsonc`, `AGENTS.md`, `.git`, and `.github`. File edits are blocked directly; destructive shell commands are blocked by a command-text guard. Reads remain allowed.
- Add project-specific protected paths with the plugin option `protectedPaths: ["infra", ".env"]`. The shell guard is heuristic; native permissions remain the security boundary.
- Workflow file writes are restricted to `.opencode/workflows`, reject symlinks/path traversal, use atomic replacement, and require the current content hash.
