# RPC

The plugin registers the `agent_workflows` RPC at each OpenCode location where it is loaded.

## Contract

```ts
import { AgentWorkflowsRpc } from "opencode-agent-workflows/rpc"
```

Use it with the official client:

```ts
import { OpenCode } from "@opencode/client"
import { AgentWorkflowsRpc } from "opencode-agent-workflows/rpc"

const client = OpenCode.make({ baseUrl, headers })
const workflows = client.rpc(AgentWorkflowsRpc)
const location = { directory: "/workspace/project" }

const workflowsList = await workflows.listWorkflows(undefined, { location })

const started = await workflows.startRun(
  {
    workflowID: "development",
    objective: "Implement the requested change.",
    requestID: crypto.randomUUID(),
  },
  { location },
)

let detail = await workflows.getRun({ runID: started.runID }, { location })
while (detail.run.status === "running" || detail.run.status === "pausing") {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  detail = await workflows.getRun({ runID: started.runID }, { location })
}

const unsubscribe = workflows.events.on("runUpdated", (event) => {
  if (event.location.directory !== location.directory) return
  console.log(event.data.runID, event.data.status, event.data.currentNode)
})
```

Events are live-only. After reconnecting, call `listRuns` or `getRun`.

## HTTP

The generic RPC route is:

```text
POST /api/rpc/agent_workflows/{method}
```

The body is `{ "input": ... }`, and the response is `{ "output": ... }`. Pass `location[directory]` as a query parameter when the request is not already location-scoped.

## Errors

Declared errors include:

- `not_found`
- `invalid_input`
- `invalid_workflow`
- `unsafe_path`
- `stale_revision`
- `not_owner`
- `project_busy`
- `idempotency_conflict`
- `too_many_runs`
- `permission_pending`
- `ambiguous_requires_confirmation`
- `not_resumable`
- `invalid_state`
- `unavailable`

Error data contains IDs, validation diagnostics, the current revision, or redacted permission summaries. It never contains prompts, objectives, YAML source, tool inputs, provider bodies, or credentials.

## Control semantics

- `pauseRun` sets `pausing` while a node is active and `paused` between nodes. It does not interrupt the active node.
- `resumeRun` requires the current `expectedRevision`.
- `resumeRun` on a permission-blocked node returns `permission_pending` until the native decision is made.
- `resumeRun` on an ambiguous node requires `confirmRetry: true`.
- `cancelRun` interrupts the active node where supported and marks the run cancelled.
- An idempotent retry with the same `requestID` returns the current run.
- `startRun` uses `requestID` plus the workflow/objective hash to detect conflicting retries.
