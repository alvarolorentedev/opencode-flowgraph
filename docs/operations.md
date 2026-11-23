# Operations and recovery

## Run lifecycle

Statuses: `running`, `pausing`, `paused`, `blocked`, `completed`, `failed`, `cancelled`.

`blocked` means all remaining branches need a native permission decision, a human decision, or explicit retry. While a sibling can make progress, the run stays `running` and exposes the blocked step separately.

- Each run has a stable root session. Agent steps use fresh native child sessions, including steps from called workflows. Human steps use no session; their decision is recorded against the root session.
- Separate runs in the same checkout can execute concurrently. They share the files and can conflict if agents write the same paths.
- The root workflow and all referenced definitions and hashes are snapshotted at start. Native agents are resolved when each session starts, so changes to agent definitions affect later steps.
- A user pause drains admitted steps and preserves pending branches. A run blocked on a native permission or human decision is not paused; resolve the permission or answer the human step. The CLI starts the drain loop for a run whose previous process exited, so an interrupted active step becomes an explicit blocker and then pauses. A root terminal `pause` ends the run in a non-resumable state. A child's `pause` follows the caller's declared route.
- A waiting human step checkpoints as a branch blocker. It never prompts, never times out as a node, and survives restart until `respondRun` records the decision.
- Cost and token usage are provider-reported estimates. Restart reconciliation protects workflow state, while external tool effects can still repeat after a confirmed retry.

## Execution model

The scheduler checkpoints the runnable branches, active sessions, pending joins, and call frames. Before prompting an agent, it reserves a step slot and records the session and prompt ID. The root budget applies across all branches and calls. Each completion records the step, then advances its branch and updates the join in one run checkpoint. Cancel, fatal failure, and timeout stop admission and request interrupts for that run's outstanding sessions.

## Structured reports

The first valid report persisted for a run/step is canonical. The store
serializes that check per step:

- an identical resubmission with the same report reference returns the stored
  report and is not persisted twice, even after the per-step attempt cap;
- a conflicting result for the same reference is rejected;
- a different reference for the same step is rejected without changing the
  canonical report;
- invalid or undeclared outcomes and reports outside an active invocation are
  rejected before persistence.

This is single-server serialization, not distributed exactly-once. A retried
node can still repeat external side effects. OpenCode transports reports through
`flowgraph_report`; other transports use their native structured output and
`syntheticReportRef`.

## Storage

Runtime state lives in OpenCode plugin storage, keyed by project:

```text
v1/runs/<projectID>/<runID>
v1/steps/<projectID>/<runID>/<stepID>
v1/reports/<projectID>/<runID>/<stepID>
v1/run-sources/<projectID>/<runID>
v1/run-harness/<projectID>/<runID>
v1/workflow-backups/<projectID>/<workflowID>/<hash>
v1/idem/<projectID>/<sha256(requestID)>
```

Workflow definitions are YAML files in `.flowgraph/workflows` (legacy `.opencode/workflows` is used only when the neutral directory is absent). OpenCode runtime checkpoints stay in OpenCode plugin storage and are never written into the repository. The standalone CLI keeps its state in `.flowgraph/state`, which lives inside the checkout and can contain objectives and native session references; add it to `.gitignore`, and do not commit or share it. OpenCode keeps its plugin storage as before.

The `run-harness` sidecar records which adapter created a run. `RunRecord` is unchanged, so existing runs and older binaries remain compatible; older binaries simply ignore the sidecar. No migration is required. A run without a sidecar is a legacy run: OpenCode adopts it; a different adapter refuses to resume it. This prevents one harness from controlling another harness's native sessions. Foreign run views use the stored sidecar and permissions only; they never query the other harness's live session.

Storage has no transactions or compare-and-swap. A host-local file lock protects ownership of each run. After an unclean shutdown such as `kill -9`, a run's ownership lock stays claimed until its stale window expires (about 120 s by default); until then, `pause`/`resume`/`cancel` on that run exit 1 with `another instance owns this workflow run`, and the lock is never silently stolen by another controller. In-process serialization protects run transitions, idempotent start admission, and the stored-run cap. Control RPCs require the current revision. Use one OpenCode server per project database. The standalone CLI shares the same host-local run lock but uses `.flowgraph/state`; do not run two CLI controllers for one run. Its filesystem storage writes whole values atomically and resolves same-key concurrent writes last-write-wins; it does not claim distributed compare-and-swap.

The CLI uses the runtime default recovery grace (`recoveryGraceMs: 5_000`); if an adapter needs longer before it can report admission or a terminal outcome after an interrupt or restart, the run blocks `ambiguous_node` (or a permission/terminal wait) instead of guessing, and `resume --confirm-retry` retries ambiguous nodes after they are confirmed stopped.

### Migrating workflows to `.flowgraph/workflows`

Move files; do not copy them into both directories. If both exist, the neutral
directory wins and the legacy one is ignored, not merged. No automatic migration
runs and no user file is overwritten.

```sh
mkdir -p .flowgraph/workflows
git mv .opencode/workflows/*.yaml .flowgraph/workflows/
```

Workflow file stems and `name` fields do not change. Existing runs keep their
embedded workflow snapshot, so moving the YAML file does not invalidate them.
The plugin logs one warning, and the CLI prints it to stderr, until the legacy
directory is gone.

Add `.flowgraph/state/` to `.gitignore` before starting a CLI run. It holds run
records, objectives, and native session references and must not be committed.

## Restart and recovery

| Crash point | Recovery |
|---|---|
| Before prompt admission | Retry preparation when native session history is empty |
| Prompt admitted, node still active | Wait/reconcile; do not prompt again |
| Node succeeded and valid report exists | Persist the step and continue |
| Node succeeded but report is missing | Block with `missing_report`; require an explicit resume |
| First valid report exists | Complete the step; later duplicate/conflicting submissions cannot replace it |
| Node failed or interrupted | Fail on native failure. Block the affected branch on interruption. |
| No terminal idle outcome | Block with `ambiguous_node` |
| Branch waiting at a human step | Preserve the `human_input` blocker; do not prompt |
| Branch arrived at a join | Preserve the arrival and reconcile outstanding branches |
| Permission state cannot be proven | Block; `resume` refuses |
| Run belongs to another harness | Read-only; `resume` and control refuse |
| Recovery attempts exhausted | Fail with `recovery_exhausted` |
| Run deadline expired | Fail with `run_timeout` |

Recovery preserves completed steps and join arrivals. A step that finished before the last checkpoint is reconciled from its saved result or native session and report. Existing sequential records are read in place and resume with one branch. A user `pause` drain is not restart reconciliation and does not consume `max_recovery_attempts`; an interrupted or retried pause stays `pausing` and remains resumable. If a native permission appears while the drain waits, the CLI stops with exit `1`, leaves the run `pausing`, and prints the resume command; resolve the permission before resuming.

`resumeRun` with `confirmRetry: true` retries ambiguous steps in new sessions after their prior sessions are confirmed stopped. Resolve any pending native permissions before resuming.

Node sessions are child sessions of the workflow-run session. OpenCode's native restart sweep resumes top-level orphaned claims and releases orphaned child claims, so the OpenCode adapter owns node-session reconciliation.

## Failure boundaries

- Missing/invalid report after bounded corrections: node/run fails.
- Native failure or interruption: explicit failure or blocked state.
- Permission pending: blocked, never auto-approved.
- Human step pending: blocked with `human_input`, never auto-answered.
- Ambiguous active node after restart: blocked, never automatically re-prompted.
- Storage corruption: invalid state, fail closed.
- Duplicate runners are excluded by the per-run ownership lock.

## Permissions and Git

- Native permissions are respected.
- Pending permission requests are surfaced through `getRun` and native sessions.
- The plugin never auto-approves a permission.
- The plugin adds no Git side effects: no branches, commits, pushes, pull requests, worktrees, or release process.
- Agents may use Git under their own native permissions and project policy.
- Background `subagent` and `shell` calls are rejected inside workflow sessions by default because they would outlive the agent step. Set the plugin option `allowBackgroundWork: true` to opt out; the reported `security.backgroundWork` then becomes `unobservable` and the TUI/GUI show the background-work warning.
- Workflow nodes cannot modify protected configuration paths: `.opencode`, `.flowgraph`, `opencode.json`, `opencode.jsonc`, `AGENTS.md`, `.git`, and `.github`. This covers workflow definitions and CLI state. Known file tools (`edit`, `write`, `patch`, `apply_patch`) are blocked directly; shell commands are matched by a best-effort command-text guard. Reads remain allowed.
- Add project-specific protected paths with the plugin option `protectedPaths: ["infra", ".env"]`. The reported capability is `security.protectedPaths: "best_effort"`, not `"tool_hook"`.
- The shell guard is heuristic, not a sandbox. It can miss interpreters and scripts (`python -c`, `node -e`, a checked-in script), commands it cannot classify, tools other than the named file tools, and symlinked paths; it can also reject a harmless command that reads a protected path next to a redirect. Native OpenCode permissions remain the security boundary. A full filesystem sandbox or native restriction would be a separate architectural change.
- Workflow file writes are restricted to the resolved workflow directory (`.flowgraph/workflows` or the legacy `.opencode/workflows`), reject symlinks/path traversal, use atomic replacement, and require the current content hash.
