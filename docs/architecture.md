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
  runtime/
    create.ts              Harness-independent runtime factory and lifecycle
    index.ts               Public runtime export
  storage/
    filesystem.ts          FileSystemStoragePort
    index.ts               Public storage export
  execution/
    harness.ts             Portable adapter contract
    report-intake.ts       Structured-result validation and persistence
    runner.ts              Scheduler, controls, recovery
    checkpoint.ts          Portable branch/call/join state machine
    prompts.ts             Bounded prompts; completion instruction is adapter-supplied
    results.ts             Portable usage merge and outcome assertion
    run-graph.ts           Structured observability and ownership-aware controls
  workflow/                YAML, graph, validation, Mermaid, root resolution
    root.ts                Shared neutral/legacy workflow-directory resolver
  state/                   Store, keys, types, locking
  service.ts               Workflow/run facade
  contract.ts              OpenCode RPC schemas
  core.ts                  Portable public schemas/contracts
  cli.ts                   Standalone `flowgraph` executable
  index.ts                 Thin OpenCode plugin composition root
  rpc.ts                   Public OpenCode RPC re-export
  tui.tsx / gui.tsx / ui/  OpenCode UI surfaces
    ui/harness.ts          Pure harness capability and foreign-run copy
```

The portable folders are `execution/`, `workflow/`, `state/`, `storage/`,
`runtime/`, `util/`, plus `service.ts`, `contract.ts`, `command.ts`,
`server-command.ts`, `core.ts`, and `cli.ts`. They must not import
`@opencode/*` or `src/adapters/*`. `test/architecture/core-is-harness-agnostic.test.ts`
enforces that boundary, including the built CLI and portable bundles.

`src/index.ts` is deliberately thin: it constructs the OpenCode adapter and
storage bridge, creates the runtime, registers the native report tool, hooks,
RPC handlers, and server command, bridges `runUpdated`, and shuts the runtime
down. All OpenCode-specific behavior stays under `src/adapters/opencode/`.

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

## Runtime factory

`createFlowgraphRuntime` in `src/runtime/create.ts` is the single composition
root. It owns the `WorkflowStore`, `RunLockManager`, `InvocationRegistry`,
`ReportIntake`, `WorkflowRunner`, `WorkflowRepository`, and `WorkflowService`,
plus recovery scheduling and shutdown:

```ts
const runtime = await createFlowgraphRuntime({
  project,              // id, canonical directory, working directory
  harness,              // HarnessAdapter, or a provider receiving the composed ports
  storage,              // StoragePort
  workflowRoot,         // optional explicit directory
  options: { pollIntervalMs, recoveryGraceMs, recoverOnStart },
  emit: (payload) => { /* host event bridge */ },
})
await runtime.start()
const { service, intake, invocations, store } = runtime
await runtime.shutdown()
```

`start()` is idempotent and schedules one project recovery unless
`recoverOnStart` is false. `shutdown()` is idempotent: it clears the recovery
timer and asks the runner to stop and checkpoint through the existing runner
shutdown path. The factory imports no harness adapter.

The OpenCode plugin and the CLI use different storage ports and lifecycle
policies over the same engine. The plugin keeps its existing OpenCode plugin
storage backend and RPC/tool surface. The CLI uses `FileSystemStoragePort` under
`.flowgraph/state`, which should be added to `.gitignore` because it holds
objectives and native session references.

## Workflow directory

`src/workflow/root.ts` is the shared resolver used by the plugin, the CLI, and
`WorkflowRepository`:

1. explicit `workflowDir`;
2. existing `.flowgraph/workflows/`;
3. legacy `.opencode/workflows/` only when the neutral directory is absent;
4. `.flowgraph/workflows/` for new installations.

If both directories exist, the neutral directory wins. Files are never merged.
The resolver returns one warning; the plugin logs it at setup and the CLI writes
it to stderr. An explicit, neutral, or legacy directory must resolve inside the
real project path, or the repository rejects it as an unsafe path. Resolution
walks the nearest existing ancestor, so a symlinked parent cannot redirect reads
or the first save outside the project. Read-only discovery never creates a
directory; the first save creates the resolved root.

## Filesystem storage and concurrency

`FileSystemStoragePort` (`.flowgraph/state/` by default in the CLI) implements
the same four-method `StoragePort`:

- Each key is hashed to a file name and stored inside a JSON envelope with the
  original key. Raw keys never become filesystem paths, so traversal strings are
  harmless.
- Writes use a same-directory temporary file with mode `0600`, `fsync`, then an
  atomic rename. The directory is `0700`. Reads never see a torn value.
- Missing keys return `undefined`; deletion is idempotent and fsyncs the
  directory after unlink, so a removed value cannot reappear after a crash.
- Scans verify that each envelope key hashes to its file name, then filter by
  prefix, sort deterministically, and paginate with `after`/`limit`/`next`.
- Corrupt envelopes, oversized records, symlinked records, a symlinked final
  state directory, and non-file entries fail closed with
  `StateCorruptionError`. The CLI resolves the state directory through its
  nearest existing ancestor, refuses any real path outside the project, and
  refuses the project root itself, so a symlinked `.flowgraph` or `--state-dir`
  cannot redirect writes and the project root is never chmodded. The standalone
  port itself only inspects the final directory; it does not walk every
  ancestor.
- Abandoned `.tmp-*` files older than one hour are removed on scan; fresh
  in-flight temporary files are left alone.

Concurrency is honest: atomic replacement gives whole-value, last-write-wins
semantics per key. There is no distributed compare-and-swap. The store keeps its
in-process per-key mutex for revision and canonical-report checks on one
process. Cross-process run ownership uses the existing host-local
`proper-lockfile` run lock, not a database lease. Do not run two controllers for
the same run; the second control attempt fails with `RunOwnershipError`.

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

`StoragePort` remains a small key/value port. The core uses project-scoped keys and keeps the `v1` layout. No storage schema change is required for the adapter boundary. The OpenCode plugin keeps its existing storage backend and keys; the CLI uses the filesystem port under `.flowgraph/state/`, so CLI state and OpenCode runs are intentionally separate.

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
- A user pause drain is not restart reconciliation and does not consume `max_recovery_attempts`; an interrupted or retried pause stays `pausing`.
- A legacy run with no harness sidecar is read-only unless the active adapter sets `sessions.adoptLegacyRuns`.

A run owned by another harness is still visible through `listRuns`, `getRun`, and
`getRunGraph`, but those views add `harness: { id, version? }` and
`readOnly: true` only for a run the adapter does not own. Owned and adopted
legacy runs keep their existing payloads. An unadopted legacy run adds
`readOnly: true` without a harness identity. Foreign reads use the stored
permissions; the engine never queries that harness’s live native session, and all
four graph controls plus `resumable` are false.

Harness-specific session reconciliation belongs in the adapter. For example, an adapter whose native SDK does not reveal a session ID until the first message may keep an adapter-local durable mapping. If that mapping is missing after a crash, the adapter returns `unknown` and the engine blocks.

## Standalone CLI

`src/cli.ts` builds on the same `WorkflowRepository`, `WorkflowStore`,
`validateWorkflowStructure`, `buildRunGraph`, and `WorkflowService`. It never
imports the OpenCode plugin or adapter.

- Read-only commands (`list`, `validate`, `show`, `runs`, `graph`) work without a
  harness. `list` and `validate` report structural validity and explicitly say
  agent compatibility was not checked.
- Execution and control commands create the runtime and require an explicit
  `--adapter-module`. The module exports
  `createHarnessAdapter(context)`; the runtime validates
  `HarnessCapabilitiesSchema` and the required methods before use.
- `run`, `resume`, and `respond` execute in the foreground, print the run ID
  immediately, poll terminal/blocked state, and shut the runtime down on
  SIGINT/SIGTERM. Adapter modules are trusted local code; remote modules are
  rejected.
- CLI output never prints native session references, prompts, tool inputs, or
  raw storage. `--json` emits JSON or NDJSON.

## Security

Portable guarantees stay in the core: graph-controlled routing, outcome validation, bounded inputs, workflow file integrity, untrusted-output delimiting, no auto-approval, run locking, and explicit cancellation.

Protected configuration paths and background-work blocking are adapter-enforced. The adapter must report the truth:

- `protectedPaths: "tool_hook"` — every file-write and shell tool is intercepted at one guaranteed point (for example, Claude `PreToolUse`).
- `"approval_hook"` — only approval-time denial (Codex, ACP depending on the agent).
- `"best_effort"` — known file-edit tools are intercepted directly and shell commands are inspected heuristically. Useful protection, not a sandbox or a guarantee against scripts, interpreters, symlinks, or unclassified tools. OpenCode reports this value.
- `"none"` — no enforcement.

`backgroundWork: "blocked"` means the adapter actually rejects background work. `"unobservable"` means it may outlive the node; the host must not claim otherwise.

Permission approvals remain native/host concerns. The core only reads pending requests and never approves them. OpenCode has a native approval UI. Codex, Claude, and ACP adapters need a host approval surface or a static allow/deny policy.

## Why one package

The adapter boundary is internal. A package split would add build, release, and import complexity before a second adapter exists. The architecture test and the contract suite make a later split mechanical.

The package exposes the OpenCode entries (`.`, `./rpc`, `./server`, `./tui`, `./gui-experimental`, `./workflow`, `./contract`) and portable entries (`./core`, `./runtime`, `./storage`) built into `dist/`. The `flowgraph` bin is `dist/cli.js` with a Node shebang. Portable bundles keep `@opencode/*` out of their dependency graph. OpenCode plugin dependencies remain peer dependencies so an existing plugin installation keeps working; a future non-OpenCode host can install only the portable entries when that split is justified.
