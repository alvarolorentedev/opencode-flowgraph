# Architecture

Flowgraph is a workflow engine with a harness adapter. OpenCode is the reference adapter and the only adapter currently implemented. The core owns the graph, the scheduler, durable state, recovery, and observability. The adapter owns native agents, sessions, models, tools, permissions, and structured-result transport.

## Ownership

### Core owns

- YAML parsing, validation, graph construction, and Mermaid generation.
- Node admission, conditional routing, cycles, parallel forks/joins, nested workflow calls, and limits.
- Checkpoints, run/step/report records, revisions, idempotency, and run ownership.
- Recovery and reconciliation policy.
- Structured-result validation, attribution, duplicate handling, and persistence.
- Run lifecycle and the public service/RPC contracts.
- The decision of which node runs next. An agent never advances the graph.

### The adapter owns

- Native agent discovery and selectability.
- Native session creation, prompting, observation, and cancellation.
- Native model/provider selection.
- Native permission requests and approvals.
- Structured-result transport.
- Harness-specific security enforcement and recovery inspection.

The adapter must not decide transitions. It reports what happened; the core decides what happens next.

## Module layout

```text
src/
  adapters/opencode/       OpenCode plugin adapter
    runtime.ts             HarnessAdapter implementation
    report-tool.ts         OpenCode flowgraph_report tool
    tool-hooks.ts          Protected paths and background-work policy
    results.ts             OpenCode usage/audit normalization
    rpc/                   OpenCode Rpc.define surface and error mapping
  execution/
    harness.ts             Portable adapter contract
    report-intake.ts       Structured-result validation and persistence
    runner.ts              Scheduler, controls, recovery
    checkpoint.ts          Portable branch/call/join state machine
    prompts.ts             Bounded prompts; completion instruction is adapter-supplied
    results.ts             Portable usage merge and outcome assertion
    run-graph.ts           Structured observability and ownership-aware controls
  workflow/                YAML, graph, validation, Mermaid
  state/                   Store, keys, types, locking
  service.ts               Workflow/run facade
  contract.ts              OpenCode RPC schemas
  index.ts                 OpenCode plugin composition root
  rpc.ts                   Public OpenCode RPC re-export
  tui.tsx / gui.tsx / ui/  OpenCode UI surfaces
    ui/harness.ts          Pure harness capability and foreign-run copy
```

The core folders are `execution/`, `workflow/`, `state/`, `util/`, plus `service.ts`, `contract.ts`, `command.ts`, and `server-command.ts`. They must not import `@opencode/*` or `src/adapters/*`. `test/architecture/core-is-harness-agnostic.test.ts` enforces that boundary.

The OpenCode RPC entry (`src/rpc.ts`) is a re-export of the adapter’s RPC definition. It is intentionally OpenCode-specific; the core schemas in `contract.ts` are not.

## Runtime contract

`src/execution/harness.ts` defines one `HarnessAdapter` interface:

- `listAgents` / `resolveAgent`
- `createRunScope` (optional)
- `createSession`
- `submit`
- `inspect`
- `pendingPermissions`
- `cancel`
- `completionInstruction` (optional)
- `submissionState` (optional)

Key rules:

- `submit` resolves after admission, not after completion.
- `inspect` is cheap and repeatable; it returns a terminal state only when the harness is finished.
- `pendingPermissions` returns `unknown` when the adapter cannot prove absence.
- `cancel` returns `true` only when the stop is confirmed.
- Adapters must be safe for concurrent calls on different sessions.

`HarnessCapabilities` is defined by one strict Zod schema
(`HarnessCapabilitiesSchema`) in `src/execution/harness.ts`; the TypeScript type
and the `harnessCapabilities` RPC output are derived from it. It reports what the
adapter can actually do. Capability fields are not marketing: they drive
conservative engine behavior and host reporting. See
[`adapters.md`](adapters.md).

## Structured results

The core owns `ReportIntake`:

- resolves the active invocation by native session;
- rejects reports outside an active node;
- rejects undeclared outcomes;
- keeps the first valid report for a run/step canonical;
- treats an identical same-reference resubmission as idempotent;
- rejects a conflicting result or a second reference for that step;
- caps reports per step;
- writes one `ReportRecord` attributed to the run, step, and session.

The store serializes the canonical read/write per step. That protects concurrent
submissions on one server; the storage backend has no distributed
compare-and-swap, so exactly-once is not claimed across servers.

Adapters transport reports using their native mechanism:

| Harness | Mechanism |
|---|---|
| OpenCode | Typed `flowgraph_report` tool |
| Claude Agent SDK | `outputFormat` / `structured_output` |
| Codex app-server | Per-turn `outputSchema`, then JSON parse + Zod validation |
| ACP | Client-provided stdio MCP server exposing `flowgraph_report` |

Free-form completion markers such as `DONE` or `LGTM` are never parsed.
`NodeResultJsonSchema` (generated from `NodeResultSchema`) is exported for
adapters that use native structured output. Transports without a native
tool-call ID use `syntheticReportRef`, which is deterministic per
run/step/session/attempt and deduplicates like a native ID.

## Storage and recovery

`StoragePort` remains a small key/value port. The core uses project-scoped keys and keeps the `v1` layout. No storage schema change is required for the adapter boundary.

Harness identity is stored in a separate key:

```text
v1/run-harness/<projectID>/<runID> -> { "id": "opencode", "version": "..." }
```

This keeps `RunRecord` unchanged, so old binaries can still read new runs. A run without a sidecar is a legacy run:
- OpenCode adopts it (`adoptLegacyRuns: true`).
- Every other adapter refuses to resume it.

Portable recovery remains conservative:
- A succeeded node without a report blocks with `missing_report`; it is never re-prompted automatically.
- An unknown admission, permission, or terminal state blocks.
- `resume` refuses when permission state cannot be confirmed.
- A foreign harness’s run is read-only and cannot be resumed or controlled.
- A legacy run with no harness sidecar is read-only unless the active adapter sets `sessions.adoptLegacyRuns`.

A run owned by another harness is still visible through `listRuns`, `getRun`, and
`getRunGraph`, but those views add `harness: { id, version? }` and
`readOnly: true` only for a run the adapter does not own. Owned and adopted
legacy runs keep their existing payloads. An unadopted legacy run adds
`readOnly: true` without a harness identity. Foreign reads use the stored
permissions; the engine never queries that harness’s live native session, and all
four graph controls plus `resumable` are false.

Harness-specific session reconciliation belongs in the adapter. For example, an adapter whose native SDK does not reveal a session ID until the first message may keep an adapter-local durable mapping. If that mapping is missing after a crash, the adapter returns `unknown` and the engine blocks.

## Security

Portable guarantees stay in the core: graph-controlled routing, outcome validation, bounded inputs, workflow file integrity, untrusted-output delimiting, no auto-approval, run locking, and explicit cancellation.

Protected configuration paths and background-work blocking are adapter-enforced. The adapter must report the truth:

- `protectedPaths: "tool_hook"` — full tool-level interception (OpenCode, Claude `PreToolUse`).
- `"approval_hook"` — only approval-time denial (Codex, ACP depending on the agent).
- `"none"` — no enforcement.

`backgroundWork: "blocked"` means the adapter actually rejects background work. `"unobservable"` means it may outlive the node; the host must not claim otherwise.

Permission approvals remain native/host concerns. The core only reads pending requests and never approves them. OpenCode has a native approval UI. Codex, Claude, and ACP adapters need a host approval surface or a static allow/deny policy.

## Why one package

The adapter boundary is internal. A package split would add build, release, and import complexity before a second adapter exists. The architecture test and the contract suite make a later split mechanical. If a non-OpenCode host must install the package without OpenCode, move `@opencode/plugin` to an optional peer or split `core` and `runtime-opencode` at that point.
