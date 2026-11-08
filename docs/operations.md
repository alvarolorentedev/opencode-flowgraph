# Operations and recovery

## Run lifecycle

Statuses: `running`, `pausing`, `paused`, `blocked`, `completed`, `failed`, `cancelled`.

`blocked` means all remaining branches need a native permission decision or explicit retry. While a sibling can make progress, the run stays `running` and exposes the blocked step separately.

- Each run has a stable root session. Agent steps use fresh native child sessions, including steps from called workflows.
- Separate runs in the same checkout can execute concurrently. They share the files and can conflict if agents write the same paths.
- The root workflow and all referenced definitions and hashes are snapshotted at start. Native agents are resolved when each session starts, so changes to agent definitions affect later steps.
- A user pause drains admitted steps and preserves pending branches. A root terminal `pause` ends the run in a non-resumable state. A child's `pause` follows the caller's declared route.
- Cost and token usage are provider-reported estimates. Restart reconciliation protects workflow state, while external tool effects can still repeat after a confirmed retry.

## Execution model

The scheduler checkpoints the runnable branches, active sessions, pending joins, and call frames. Before prompting an agent, it reserves a step slot and records the session and prompt ID. The root budget applies across all branches and calls. Each completion records the step, then advances its branch and updates the join in one run checkpoint. Cancel, fatal failure, and timeout stop admission and request interrupts for that run's outstanding sessions.

## Storage

Runtime state lives in OpenCode plugin storage, keyed by project:

```text
v1/runs/<projectID>/<runID>
v1/steps/<projectID>/<runID>/<stepID>
v1/reports/<projectID>/<runID>/<stepID>
v1/run-sources/<projectID>/<runID>
v1/workflow-backups/<projectID>/<workflowID>/<hash>
v1/idem/<projectID>/<sha256(requestID)>
```

Workflow definitions remain YAML files in `.opencode/workflows`. Runtime checkpoints are never written into the repository.

Storage has no transactions or compare-and-swap. A host-local file lock protects ownership of each run. After an unclean shutdown, recovery retries busy run locks until they become available. In-process serialization protects run transitions, idempotent start admission, and the stored-run cap. Control RPCs require the current revision. Use one OpenCode server per project database.

## Restart and recovery

| Crash point | Recovery |
|---|---|
| Before prompt admission | Retry preparation when native session history is empty |
| Prompt admitted, node still active | Wait/reconcile; do not prompt again |
| Node succeeded and valid report exists | Persist the step and continue |
| Node succeeded but report is missing | Block with `missing_report`; require an explicit resume |
| Node failed or interrupted | Fail on native failure. Block the affected branch on interruption. |
| No terminal idle outcome | Block with `ambiguous_node` |
| Branch arrived at a join | Preserve the arrival and reconcile outstanding branches |
| Recovery attempts exhausted | Fail with `recovery_exhausted` |
| Run deadline expired | Fail with `run_timeout` |

Recovery preserves completed steps and join arrivals. A step that finished before the last checkpoint is reconciled from its saved result or native session and report. Existing sequential records are read in place and resume with one branch.

`resumeRun` with `confirmRetry: true` retries ambiguous steps in new sessions after their prior sessions are confirmed stopped. Resolve any pending native permissions before resuming.

Node sessions are child sessions of the workflow-run session. OpenCode's native restart sweep resumes top-level orphaned claims and releases orphaned child claims, so the workflow plugin owns node-session reconciliation.

## Failure boundaries

- Missing/invalid report after bounded corrections: node/run fails.
- Native failure or interruption: explicit failure or blocked state.
- Permission pending: blocked, never auto-approved.
- Ambiguous active node after restart: blocked, never automatically re-prompted.
- Storage corruption: invalid state, fail closed.
- Duplicate runners are excluded by the per-run ownership lock.

## Permissions and Git

- Native permissions are respected.
- Pending permission requests are surfaced through `getRun` and native sessions.
- The plugin never auto-approves a permission.
- The plugin adds no Git side effects: no branches, commits, pushes, pull requests, worktrees, or release process.
- Agents may use Git under their own native permissions and project policy.
- Background `subagent` and `shell` calls are rejected inside workflow sessions by default because they would outlive the agent step. Set the plugin option `allowBackgroundWork: true` to opt out.
- Workflow nodes cannot modify protected configuration paths: `.opencode`, `opencode.json`, `opencode.jsonc`, `AGENTS.md`, `.git`, and `.github`. File edits are blocked directly; destructive shell commands are blocked by a command-text guard. Reads remain allowed.
- Add project-specific protected paths with the plugin option `protectedPaths: ["infra", ".env"]`. The shell guard is heuristic; native permissions remain the security boundary.
- Workflow file writes are restricted to `.opencode/workflows`, reject symlinks/path traversal, use atomic replacement, and require the current content hash.
