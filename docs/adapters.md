# Harness adapters

This document describes how to add a harness adapter without changing the workflow schema or the scheduler.

OpenCode is the reference adapter. Codex, Claude Code, and ACP adapters are not implemented. The compatibility notes below are based on their official APIs and mark proof-of-concept assumptions.

## Implement `HarnessAdapter`

Implement `src/execution/harness.ts`:

```ts
export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities

  listAgents(): Promise<AgentDescriptor[]>
  resolveAgent(agentRef: string): Promise<AgentDescriptor | undefined>

  createRunScope?(input: {
    title: string
    metadata: Record<string, string>
  }): Promise<{ ref: SessionRef }>

  createSession(input: {
    agentRef: string
    title: string
    metadata: Record<string, string>
    parent?: SessionRef
  }): Promise<{ ref: SessionRef }>

  submit(input: {
    session: SessionRef
    submission: SubmissionRef
    text: string
    metadata?: Record<string, string>
  }): Promise<void>

  inspect(session: SessionRef): Promise<ExecutionSnapshot>
  pendingPermissions(session: SessionRef): Promise<PendingPermissions>
  cancel(session: SessionRef): Promise<boolean>

  completionInstruction?(input: {
    nodeID: string
    allowedOutcomes: string[]
  }): string

  submissionState?(
    session: SessionRef,
    submission: SubmissionRef,
  ): Promise<SubmissionState>
}
```

### Method requirements

- `listAgents` returns descriptors. Set `selectable: false` and a `reason` for agents the workflow must not use. If the harness has no native agent catalog, map configured profiles and report `agents.discovery: "configured"`.
- `resolveAgent` re-checks at admission time. Agent configuration may change after validation.
- `createRunScope` is optional. Use it only if the harness has a real grouping session. Otherwise leave `runSessionID` null; the engine supports that.
- `createSession` must not prompt. Parent is optional and may be ignored.
- `submit` resolves after admission proof, not completion. If the harness cannot prove admission after a crash, return `unknown` from `submissionState`.
- `inspect` must be cheap. Fetch messages/audit only when the native work is terminal. Use `finishedAt` when the harness exposes an idle/completion timestamp. It may lazily reattach/read a native session after a restart, but must never submit work.
- `pendingPermissions` must return `unknown` if absence cannot be proven. Never return `none` by default after a restart.
- `cancel` returns `true` only when the harness confirmed the stop.
- `completionInstruction` must tell the agent exactly how to return the structured result. It is static adapter text, never derived from agent output.

Adapters must be safe for concurrent calls on different sessions. The engine observes parallel branches concurrently.

`SessionRef` and `SubmissionRef` are persisted in `RunRecord`/`StepRecord` fields with a 128-character limit. If a native identifier is longer, map it to a stable bounded key and keep the native value in adapter-local storage.

## Portable runtime

Adapters do not construct the engine directly. A host calls
`createFlowgraphRuntime` and supplies either an adapter instance or a provider:

```ts
const runtime = await createFlowgraphRuntime({
  project: { id, canonical, directory },
  storage,
  harness: myAdapter,
  emit: (event) => hostEventBridge(event),
})
await runtime.start()
```

A provider receives the portable components an adapter legitimately needs:

```ts
const runtime = await createFlowgraphRuntime({
  project,
  storage,
  harness: async ({ project, workflowRoot, store, intake, invocations }) => {
    return createMyAdapter({ project, workflowRoot, store, intake, invocations })
  },
})
```

`intake` is the canonical way to transport a native structured result. The
adapter must not write `ReportRecord`s directly. The runtime factory does not
import any harness-specific module.

## Standalone CLI adapter provider

The CLI and future native plugins use the same entry point. A trusted local
module must export:

```ts
export async function createHarnessAdapter(context: {
  project: ProjectIdentity
  workflowRoot: string
  store: WorkflowStore
  intake: ReportIntake
  invocations: InvocationRegistry
}): Promise<HarnessAdapter>
```

Usage:

```bash
flowgraph run development "implement it" --adapter-module ./my-adapter.mjs
```

Rules:

- Only an explicit local file path is loaded. Remote URLs and non-files are rejected.
- Adapter modules execute trusted code in the CLI process. Review them before use.
- The runtime validates `HarnessCapabilitiesSchema` and requires
  `listAgents`, `resolveAgent`, `createSession`, `submit`, `inspect`,
  `pendingPermissions`, and `cancel`.
- Without `--adapter-module`, inspection commands still work and execution
  commands exit with code `3` and a clear message. No fake adapter is shipped.
- A missing or invalid adapter is never reported as workflow validity. The CLI
  distinguishes structural validity from agent resolution.
- CLI state holds only runs started by the CLI. A run owned by another harness
  is not visible, so `pause`, `resume`, `cancel`, and `respond` report it as not
  found in CLI state; the CLI cannot control it.

`submit` must still resolve after admission proof. `inspect` must remain
side-effect free. Foreground `run` polls the engine and never re-submits an
uncertain prompt. `pause` drains through the same engine, including a run
restored after the previous CLI process exited; it refuses while any branch has a
native permission or human decision outstanding. A permission discovered during
the drain stops the wait with exit `1`, leaves the run `pausing`, and prints the
resume command. A persisted active session that
`inspect` reports as `interrupted` or `cancelled` becomes a
`node_interrupted` blocker, then the drained run becomes `paused`. A pause drain
never consumes `max_recovery_attempts`; interrupted or retried pauses remain
resumable.

## Capabilities

`HarnessCapabilities` must be honest:

| Field | Meaning |
|---|---|
| `agents.discovery` | `native` catalog or configured profiles. |
| `sessions.runScope` | The adapter can create a non-node grouping session. |
| `sessions.adoptLegacyRuns` | Only the adapter that wrote pre-identity runs may adopt them. OpenCode only. |
| `results.mechanism` | `native_tool`, `structured_output`, `mcp_tool`, or `none`. `none` makes agent nodes invalid. |
| `results.corrections` | The adapter can submit a correction prompt on the same session. |
| `permissions.survivesRestart` | Pending requests remain queryable after a process restart. |
| `permissions.approval` | `native` UI, `host` callback, or `none`. |
| `security.nativePermissions` | The harness enforces its own permission model. |
| `security.protectedPaths` | `tool_hook`, `approval_hook`, `best_effort`, or `none`. |
| `security.backgroundWork` | `blocked` or `unobservable`. |
| `usage.tokens` / `usage.cost` | What the adapter can actually report. |
| `audit` | The adapter can produce tool-call audit entries. |

Do not set `protectedPaths: "tool_hook"` unless every file-write and shell tool is intercepted. Use `"best_effort"` when known file tools are blocked and shell protection is heuristic; it warns users that the check is not a sandbox. The OpenCode adapter reports `"best_effort"`. Do not set `backgroundWork: "blocked"` unless background work is actually rejected.

## Structured results

The core accepts results only through `ReportIntake`. Choose a transport:

### Native tool (OpenCode)

Register a typed tool (`flowgraph_report`) and call:

```ts
await intake.submit({
  session: context.sessionID,
  messageRef: context.messageID,
  toolCallRef: context.id,
  result: input,
})
```

OpenCode validates the tool input and the intake re-validates the result.

### Native structured output (Claude, Codex)

- Claude: set `outputFormat: { type: "json_schema", schema }`, read `structured_output` on the result message, validate with `NodeResultSchema`, then submit. The SDK retries invalid schema output natively.
- Codex app-server: pass `outputSchema` on `turn/start`, parse the final agent message as JSON, validate with `NodeResultSchema`, then submit. The app-server is preferred over the TypeScript SDK because it exposes thread IDs before the first turn, approvals, and `turn/interrupt`.
- Use `NodeResultJsonSchema` exported from `src/workflow/schema.ts`. It is generated by `z.toJSONSchema(NodeResultSchema)`; do not maintain a second definition by hand. `test/execution/result-schema.test.ts` pins its fields and required outcomes.

Set `results.mechanism: "structured_output"`. Missing or invalid output should leave no report; the engine applies its normal correction/failure policy.

### Stable report references

A transport without a native tool-call ID must use
`syntheticReportRef(runID, stepID, sessionID, attempt)` from
`src/execution/report-intake.ts`. It returns a namespaced
(`flowgraph:synthetic:`), SHA-256-derived, 84-character reference that is
deterministic for one run/step/session/attempt and fits the 128-character
`toolCallID` field. Pass it as `toolCallRef`. Canonical persistence and dedupe
are identical to a native tool-call ID.

### Canonical report semantics

Only the first valid report persisted for a run/step is canonical. The store
serializes the read/write check per step, so concurrent submissions cannot
overwrite one another:

- same reference and identical content returns the stored report (idempotent);
- same reference and different content is rejected;
- a different reference for the same step is rejected and the canonical report
  is untouched;
- invalid or undeclared outcomes and reports outside an active invocation are
  rejected before persistence.

This is single-server serialization, not distributed exactly-once. Agents may
still repeat external side effects when a node is explicitly retried.

### Client-provided MCP tool (ACP)

ACP has no native structured output. ACP guarantees stdio MCP support on `session/new`, so an adapter can provide a per-session MCP server that exposes `flowgraph_report`.

A practical design:
- Create a per-session report token.
- Start or configure a stdio MCP server with that token in `env`.
- The server forwards the validated result to `ReportIntake` over a loopback channel.
- The agent calls the tool once; the intake attributes the report by token/session.

This is a proof-of-concept assumption, not a confirmed universal behavior. Validate it against real ACP agents before promising ACP support. If the tool is not visible to an agent, ACP nodes cannot produce structured outcomes; do not fall back to parsing free-form text.

## Agent mapping

| Harness | Mapping |
|---|---|
| OpenCode | Native agent ID from `ctx.agent.list`; hidden and `mode: subagent` agents are not selectable. |
| Claude | Agent name from `supportedAgents()`/settings/`.claude/agents`; define agents programmatically if needed. |
| Codex | No native named-agent catalog in the SDK/app-server; map `agent:` to configured profiles (model, sandbox, instructions) or collaboration modes. |
| ACP | No named-agent catalog; map `agent:` to configured ACP profiles (command, args, env, optional mode). |

Do not introduce a universal agent definition. Flowgraph resolves the YAML `agent:` string through the adapter’s native configuration.

## Session and recovery differences

- **OpenCode:** native session IDs, parent/child sessions, queryable permissions, context-based admission proof.
- **Codex app-server:** `thread/start` returns a thread ID immediately; `thread/resume` resumes; approvals arrive as server requests; `turn/interrupt` cancels. Pending approvals are not queryable after restart.
- **Claude Agent SDK:** sessions persist to disk and can be resumed; `canUseTool` is a host callback; `interrupt()`/`AbortController` cancels. The SDK does not expose a session ID before the first query message, so the adapter may need a durable local-ref → native-session mapping. If the mapping is missing after a crash, return `unknown`.
- **ACP:** `session/new` returns an ID immediately; `session/load`/`session/resume` are optional capabilities; `session/cancel` cancels. Pending permission requests are connection-bound; after a restart they are unknown.

The engine’s rule is absolute: an adapter that cannot prove admission, terminal state, or permission absence returns `unknown`; the engine blocks. It never silently re-prompts or retries.

## Permission approvals

The core does not approve permissions. The adapter must either:

- expose the harness’s native UI (OpenCode), or
- implement a host approval surface (future, for Codex/Claude/ACP), or
- run with a static allow/deny policy.

Do not auto-approve to make a workflow pass. Do not claim a protection the adapter cannot enforce.

## Recovery matrix

The engine never silently repeats work when admission, execution, permission, or
completion state cannot be proven.

| Point | Adapter signal | Engine behavior | Never |
|---|---|---|---|
| Durable report, terminal success | `inspect` returns `succeeded` and a stored report matches the session | Complete the step, persist it, route — only when the terminal state is proven; a report alone never completes it | Re-prompt |
| Succeeded, no report | `inspect` returns `succeeded` | Block `missing_report` after restart (or fail conservatively when the terminal state is unprovable); otherwise correct within the retry limit | Re-prompt automatically |
| Prompt admission unknown | `submissionState` returns `unknown` or throws | Block `ambiguous_node` | Guess admitted or re-prompt |
| Permission state unknown | `pendingPermissions` returns `unknown` or throws | Block `ambiguous_node`; `resumeRun` refuses | Assume none; auto-approve |
| Permission pending | `pendingPermissions` returns items | Block with `permission`; wait for the harness UI | Auto-approve |
| Native terminal state unknown | `inspect` returns `unknown` or idle without an outcome | Block `ambiguous_node` after the recovery grace | Retry the node |
| Native failure | `inspect` returns `failed` | Fail with `native_failure` | Retry automatically |
| Interrupted or cancelled | `inspect` returns `interrupted`/`cancelled` | Block `node_interrupted`; retry only with `confirmRetry` | Re-prompt automatically |
| Missing admission after restart | `submissionState` returns `not_admitted` | Abandon the prepared step and admit it again | Send a second prompt in the old session |

`test/execution/runner.test.ts` and the contract suite cover these transitions.
The OpenCode integration restart cases cover both a persisted report that
completes the step and an unprovable native terminal state that blocks, and
assert that the prompt is not re-sent.

## Contract tests

`test/contract/harness-suite.ts` exports `describeHarnessContract(name, factory)`.
A new adapter writes a small factory that returns its `HarnessAdapter`, store,
invocation registry, intake, runner, optional security probe, and a stop
function; the shared suite does the rest. It imports no `@opencode/*` module.

The suite runs these scenarios on the adapter's capability variants:

- agent discovery and selectability;
- session creation and submission/admission proof;
- successful completion and a structured result;
- undeclared-outcome rejection;
- duplicate report dedupe and conflicting-report rejection;
- conditional routing and cycles;
- parallel branches and joins;
- nested workflow calls;
- missing results with and without corrections;
- pending and unknown permissions;
- cancellation and node timeout;
- native failure without retry;
- restart with a missing report, an unknown terminal state, ambiguous admission,
  and a missing admission that is abandoned and re-admitted;
- duplicate `start` calls (no accidental re-execution);
- concurrent run isolation;
- harness ownership, foreign-run refusal, and legacy-run adoption.

Capability honesty is part of the suite. A fixture supplies a
`capabilityProbe` that returns one finding per security claim it cannot
demonstrate. The suite fails if a claim such as `backgroundWork: "blocked"` or
`protectedPaths: "tool_hook"`/`"best_effort"` has no probe, and
`test/contract/harness-contract.test.ts` proves a deliberate lie is reported.
The real OpenCode adapter's values are asserted in
`test/adapters/opencode/runtime.test.ts`, and its enforcement paths in
`test/execution/tool-hooks.test.ts`.

`test/fixtures/fake-harness.ts` shows a configurable adapter. The OpenCode RPC
re-export is not part of the suite. `test/architecture/core-is-harness-agnostic.test.ts`
enforces the core import boundary.

## Proof-of-concept checklist for ACP

Before implementing a full ACP adapter:

1. Spawn one real ACP agent over stdio.
2. `initialize` and `session/new` with a per-session MCP report server.
3. Prompt a node; confirm the agent sees `flowgraph_report` and the intake receives a validated result.
4. Trigger `session/request_permission`; confirm Flowgraph blocks and does not auto-approve.
5. `session/cancel`; confirm the stop reason and interruption mapping.
6. Kill the process mid-turn; confirm recovery blocks and does not re-prompt.
7. If `loadSession`/`resume` is advertised, confirm whether a completed report can be recovered from the transcript.
8. If the MCP tool is not visible, document the limitation and defer ACP support.

## Compatibility snapshot

| Capability | OpenCode | Codex | Claude | ACP |
|---|---|---|---|---|
| Agent catalog | native | configured | native/probe | configured |
| Parent sessions | yes | no | no | optional subagents |
| Structured output | native tool | outputSchema | native | MCP tool (POC) |
| Permissions after restart | queryable | unknown | unknown | unknown |
| Approval UI | native | host | host | host |
| Protected paths | tool hook | approval/sandbox | PreToolUse | permission/fs |
| Background work blocked | yes | no | no | no |
| Cost reporting | yes | no | yes | optional |

This table is a design aid, not a support claim. Only OpenCode is implemented and supported.

## Next native integration

A Codex adapter will not change the workflow schema, scheduler, persistence
abstractions, or CLI. It supplies a `HarnessAdapter` over the Codex app-server
(agent discovery, sessions, `outputSchema` structured results, cancel, and
permission reporting), then either:

- wraps it in an OpenCode-like plugin that creates the runtime itself, or
- publishes a trusted local CLI adapter module exporting
  `createHarnessAdapter(context)`.

The adapter must report `sessions.adoptLegacyRuns: false` and map its native
session IDs into the `SessionRef` fields. Until that adapter exists, Codex and
Claude Code are not supported.
