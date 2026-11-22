# Roadmap: harness parity

This is a plan, not a support claim. OpenCode remains the reference adapter and
the only supported harness until a milestone ships. The plan makes no breaking
change: the workflow YAML schema (`version: 1`) and current OpenCode behavior are
unchanged, and new RPC methods or stored keys are additive with dual-read of the
old keys.

## Status

| Milestone | Status |
|---|---|
| M0 — Verify OpenCode | Automated lifecycle/restart tests are implemented and pass against a real OpenCode binary (`v2.2.5`, `@opencode/cli` 2.2.5). The manual real-model E2E record is **pending**. |
| M1 — Contract suite, transports, recovery parity | **Implemented and tested.** `describeHarnessContract` runs every documented scenario on two capability variants, a deliberate capability lie fails, `NodeResultJsonSchema` is generated from `NodeResultSchema`, synthesized report refs are canonical, and the recovery matrix matches the tests. |
| M2 — Capability exposure and harness-aware views | **Implemented and tested at the RPC/service/presentation level.** `harnessCapabilities`, foreign-run identity, ownership-aware controls, read-only TUI/GUI/server rendering, and fixtures are covered by tests. The manual TUI/GUI check remains pending (the verification environment has no interactive TUI/Desktop session) and real foreign-harness visuals stay fixture-only until an M4 adapter exists. |
| M3/M4/M5 | **Not implemented.** Future milestones; no second adapter exists. |

"Implemented and tested" means the default `bun run check` suite exercises the
behavior. "Pending" means the test exists but the required real binary, model, or
manual environment was unavailable; skipped tests are not counted as passed.

## Baseline

The harness-agnostic refactor is in place:

- `src/execution/harness.ts` defines `HarnessAdapter` and `HarnessCapabilities`.
- The core (`execution/`, `workflow/`, `state/`, `util/`) does not import
  `@opencode/*` or `src/adapters/*`; `test/architecture/` enforces the boundary.
- `src/adapters/opencode/` is the only adapter and transports reports through the
  native `flowgraph_report` tool.
- Run ownership is stored beside the run at
  `v1/run-harness/<projectID>/<runID>`; `RunRecord` is unchanged.
- `src/index.ts` is the only composition root; it wires the core to the OpenCode
  plugin.
- Controls reject a foreign harness, and a missing sidecar is adopted only by an
  adapter with `sessions.adoptLegacyRuns`.

Known gaps this plan closes:

- `harnessCapabilities` now exposes the active adapter's strict, Zod-validated
  capabilities. `getRun`, `getRunGraph`, and `listRuns` add harness identity only
  for foreign runs and `readOnly: true` only for runs the adapter does not own, so
  OpenCode-owned and adopted legacy payloads are unchanged.
- `getRunGraph` controls are ownership-aware. A foreign or unadopted legacy run returns all controls false, and the read views add `readOnly: true`; `getRun` returns `resumable: false`. The engine still refuses foreign control.
- `test/contract/harness-suite.ts` provides `describeHarnessContract` and the
  contract test runs every scenario in [`adapters.md`](adapters.md#contract-tests)
  against two capability variants, including capability honesty.
- The structured-output JSON Schema is generated from `NodeResultSchema`
  (`NodeResultJsonSchema`), and transports without a native tool-call ID have a
  stable `syntheticReportRef`.
- The smoke test adds a no-model human-only lifecycle over RPC; the model
  integration adds a restart-during-agent-step case.
- Report persistence is canonical per step: the first valid report wins and
  concurrent or conflicting submissions cannot overwrite it.

Open gaps:

- The manual real-model E2E record is outstanding. Real-binary smoke and
  model-integration runs pass against OpenCode `v2.2.5`.
- The M2 manual TUI/GUI check is outstanding; foreign visuals are fixture-only
  until M4.
- Approval is native OpenCode only; there is no host approval surface.
- Packaging has not been tested without OpenCode peers installed.

## Gate order

| Milestone | Scope | Gate |
|---|---|---|
| M0 | Verify OpenCode | Tests and a manual record; no product change |
| M1 | Contract suite, result transports, recovery parity | Core-internal and test-only |
| M2 | Capability RPC and harness-aware run views | Additive RPC plus UX |
| M3 | Select and prove the second harness | Time-boxed spike; no production merge |
| M4 | Second-adapter beta | Experimental, headless, opt-in |
| M5 | Full parity | Only with a real host, user, and security review |

Do not start a milestone before the previous gate passes. If no second-harness
host or user is confirmed after M2, stop there.

## M0 — Verify OpenCode

Prove the reference adapter on a real binary before changing how other hosts see
it.

**Status:** verified against OpenCode `v2.2.5` (`@opencode/cli` 2.2.5). The
no-model lifecycle test is `test/integration/opencode-smoke.test.ts`; the
restart-during-agent-step tests are in `test/integration/opencode-model.test.ts`
(persisted-report completion and no-report conservative blocking). Both skip
unless their environment flag and `OPENCODE_BIN` are present. With a real binary
and a mock model provider they pass, including the capability values reported by
`harnessCapabilities`. Unknown prompt admission and pending or unknown permission
states cannot be produced deterministically by the mock provider; those recovery
cases are covered at the `FakeHarness` contract level instead. The manual
real-model E2E record is still pending.

### Work

- Extend `test:smoke` with a no-model, human-only lifecycle: start a run, observe
  `human_input`, pause/resume, respond through `respondRun` until `completed`,
  and cancel a second run at its blocker. The test uses a long-lived
  `opencode serve` so state is shared across RPC calls.
- Extend `test:integration` with a restart during an agent run. Stop and restart
  `opencode serve` mid-step, then assert conservative recovery: a durable report
  completes the step; an unprovable admission or terminal state blocks; the
  prompt is never re-sent.
- Record a real-model E2E checklist run: two primary agents, a review loop, a
  dropped client, a server restart, and conservative recovery. Record the
  OpenCode binary version, model ID, and date. Keep it manual; do not add a paid
  model call to CI.

### Acceptance

- `OPENCODE_SMOKE=1 OPENCODE_BIN=... bun run test:smoke` passes and covers the
  human-only start → respond → completed path, pause/resume, and cancel. Passes
  against OpenCode `v2.2.5`.
- `OPENCODE_MODEL_INTEGRATION=1 OPENCODE_BIN=... bun run test:integration`
  passes and includes the restart assertion. Passes against OpenCode `v2.2.5`.
- The manual E2E record is attached to the release or issue that claims
  verification.
- `bun run check` is green.

### Tests

- `test/integration/opencode-smoke.test.ts` (new lifecycle cases, including
  completion and a separate cancellation run).
- `test/integration/opencode-model.test.ts` (restart with a persisted report, and
  restart without one).
- Manual E2E checklist in the release record.

### Risks

- OpenCode CLI output and `api` JSON shape can change between versions.
- `opencode api --standalone` must share project state across invocations for
  the lifecycle. If it does not, run the same assertions against a long-lived
  `opencode serve` instead.
- The mock provider proves routing, not native permission behavior.
- Restart timing is flaky; poll with a bounded deadline and fail with server logs.
- A real-model run is slow and may cost money; keep it out of the default suite.

### Rollback

Test-only. Revert the test files; no runtime, schema, or stored data changes.

### Non-goals

No adapter changes, no new RPC, no UI change, no model-routing redesign.

## M1 — Contract suite, transports, and recovery parity

Make the adapter contract reusable before a second adapter exists.

**Status:** implemented and tested. The reusable suite is
`test/contract/harness-suite.ts`; `test/contract/harness-contract.test.ts` runs
it on two capability variants and includes the capability-honesty cases. The
generated schema and synthesized report reference are exported from the core.

### Work

- Add a `describeHarnessContract` test helper that runs every scenario in
  [`adapters.md`](adapters.md#contract-tests) against a harness factory. That list
  has fifteen items; the existing single file has six test cases.
- Add capability-honesty cases: a variant that claims
  `security.backgroundWork: "blocked"` must actually reject background work; one
  that claims `security.protectedPaths: "tool_hook"` must actually intercept
  every file-write and shell path. A claim without behavior fails the suite.
- Keep the suite free of `@opencode/*` imports so a future adapter can run it.
- Derive the structured-output JSON Schema from `NodeResultSchema` with Zod 4
  `z.toJSONSchema`; no second hand-written definition and no new dependency.
  Assert the generated field set and required outcomes.
- Define a stable synthesized report reference for transports without a native
  tool-call ID (structured output, ACP MCP). It must be deterministic per
  run/step/session/attempt and dedupe like a native tool-call ID.
- Write the recovery matrix as a table in `docs/adapters.md`: missing report,
  unknown admission, unknown permission, unknown terminal state, restart with a
  durable report. For each: recover or block, and never re-prompt.

### Acceptance

- The suite runs every documented scenario on at least two `FakeHarness`
  variants and fails on a deliberate capability lie.
- The contract suite imports no `@opencode/*`.
- The generated JSON Schema test is green; the schema is exported for the M4
  structured-output transport, not consumed in this milestone.
- The recovery matrix is documented and matches
  `test/execution/runner.test.ts` and the contract suite.
- The architecture boundary test is green.

### Tests

- `test/contract/harness-contract.test.ts` (expanded).
- New capability-honesty cases beside the contract suite.
- New schema test (for example `test/execution/result-schema.test.ts`).
- `test/architecture/core-is-harness-agnostic.test.ts`.

### Risks

- A suite tied to `FakeHarness` internals can pass while a real SDK fails.
- A synthetic report ref can collide with a native ID if the format is not
  namespaced.
- Zod upgrades can change generated JSON Schema details; pin the assertion to
  semantics, not formatting.

### Rollback

Test-only plus core-internal code. No stored-run or RPC change. Revert the helper
and schema derivation if a POC disproves them.

### Non-goals

No second adapter, no RPC field, no UI change, no free-text result parsing.

## M2 — Capability exposure and harness-aware run views

Expose what the active adapter can do, and stop advertising control over runs
that belong to another harness. This is the only milestone with a UX contract.

**Status:** implemented and tested at the RPC, service, server-command, and pure
presentation level. The manual TUI/GUI check on a real OpenCode run remains
pending; foreign visuals are verified by fixture only until M4.

### RPC and service

- Add `harnessCapabilities`: no input, output `HarnessCapabilities` (which
  already carries `id` and `version?`). Define one strict Zod schema for
  `HarnessCapabilities` and derive the TypeScript type from it, so the RPC and
  the adapter cannot drift.
- Add optional `harness: { id, version? }` and `readOnly: true` to `RunSummary`, `RunDetail`, and `RunGraphOutput`. Omit both when the active adapter owns the run. A legacy run with no sidecar is owned by the active adapter only when `sessions.adoptLegacyRuns` is true; otherwise it is read-only with no harness identity, so OpenCode output stays unchanged.
- Make run-graph controls ownership-aware. `getRunGraph` returns `canPause`,
  `canResume`, `canRespond`, and `canCancel` false for a run the adapter does not
  own. `getRun` returns `resumable: false`. Foreign reads use stored permissions
  only; never query the live native session.
- Keep `pauseRun`, `resumeRun`, `respondRun`, and `cancelRun` refusing a foreign
  run with `not_resumable`. The UI pre-gates; the RPC is the backstop.
- Update `docs/interfaces.md` in this milestone: add `harnessCapabilities`, the
  optional `harness` field, and read-only foreign controls to the RPC, TUI/GUI,
  and Server `/flowgraph` command sections.
- Do not change the existing `capabilities` payload, RPC ID, error codes, or
  stored-run keys.

### UX contract

The TUI page keeps its current header `Workflow runs · N` and its empty and
error states unchanged; no new loading line is added. Capability lines appear
under the TUI page header, in the TUI graph panel, and in the GUI panel header,
labeled **Active harness** so they are never read as the foreign run's own
capabilities:

- loading: `Active harness: loading…`
- ready: `Active harness: <id> <version>`, then
  `Results <mechanism> · Permissions <approval> · Paths <protectedPaths> · Background <backgroundWork>`
  (omit `<version>` when the adapter reports none)
- error: `Active harness capabilities unavailable.` (muted; never blocks runs or
  the graph; a missing method degrades here)

Warnings, exact copy:

- `Warning: background work can outlive this step (unobservable).`
- `Warning: protected paths are not intercepted (none).`

Foreign runs:

- TUI row appends ` · [<id>]` after the status; the page and panel add
  `Harness <id> · read-only in this client`. An unadopted legacy run appends
  ` · [read-only]` and adds `Read-only in this client · harness identity unavailable`.
- TUI keys `u`, `p`, `c`, `s`, `o`, and `enter` are gated and explain via a
  toast; `r` still refreshes. No silent no-ops.
- Control toast: `This run belongs to the <id> harness. Pause, resume, respond, and cancel are unavailable in this client.`
- Session toast: `Sessions for the <id> harness open in its own client.`
- GUI picker title appends ` · <id>` (or ` · read-only` when no identity is
  known); selecting it shows the read-only line. If a foreign graph is rendered,
  the header adds `Read-only: this run belongs to the <id> harness. Controls are unavailable in this client.`
- GUI Pause, Resume, Respond, Cancel, Open active session, and node-session
  buttons get `disabled` and `title="Unavailable for <id> runs"`. Runs and Zoom
  stay enabled.
- Never open a foreign native session from the TUI, GUI, or server command.
- Graph blocked, failure, permission, and error lines are unchanged. An
  OpenCode-owned run graph has no badge.

Server `/flowgraph runs` and `/flowgraph graph`:

- Foreign rows append ` · [<id>]`.
- Foreign graph output adds `Harness: <id> (read-only via RPC)` and omits the
  `respondRun` hint.
- OpenCode output is byte-identical.

Accessibility and layout:

- State is text, not colour alone. Native disabled plus a visible reason in the
  GUI; toasts in the TUI. Keep focus order and key docs unchanged.
- Keep the Desktop-only GUI. At panel width >= 360px, wrap header, badge, and
  capability lines; no fixed widths and no new horizontal scroll.
- Truncate a displayed harness id to 16 characters plus `…`; keep the existing
  objective truncation.
- Reuse existing TUI theme/`errorDetail`/dialogs and `.awf-graph-*` GUI classes.
  No new components, breakpoints, or dependencies.

### Acceptance

- Existing `capabilities`, `getRun`, `getRunGraph`, and `listRuns` output is
  byte-identical for OpenCode-owned and adopted legacy runs.
- `harnessCapabilities` returns the active adapter's honest capabilities.
- A foreign run exposes `harness.id`, `readOnly: true`, false controls from
  `getRunGraph`, and `resumable: false` from `getRun`; its control methods still
  return `not_resumable`. An unadopted legacy run exposes `readOnly: true`
  without a harness identity and is equally read-only.
- The TUI and GUI show capability lines, warnings, the foreign badge, and
  read-only reasons; foreign sessions are not opened.
- `bun run build:gui` passes.

### Tests

- `test/rpc/contract.test.ts` (method list, `harnessCapabilities` shape).
- New RPC snapshot tests for OpenCode and foreign payloads.
- `test/execution/run-graph.test.ts` (ownership-aware controls).
- `test/execution/service.test.ts` (summary/detail identity, no live
  permissions for foreign runs).
- A pure presentation helper used by the TUI and GUI, unit-tested in
  `test/ui/` with an OpenCode plus foreign fixture (node-only; the repo has no
  DOM renderer).
- `test/server-command.test.ts` (foreign text and unchanged OpenCode text).
- Manual TUI/GUI check on a real OpenCode run: capability lines render, no badge
  on OpenCode runs, controls unchanged.

### Risks

- Additive fields can break a strict old client that parses a foreign run.
  Restrict the fields to foreign runs and add a new method rather than changing
  `capabilities`.
- A foreign adapter does not exist yet, so foreign visuals are verified by
  fixture only until M4.
- Showing capabilities too prominently can be read as a support promise. The
  Active harness label and the docs wording stay explicit.

### Rollback

Ship a patch that hides the new UI and ignores `harnessCapabilities`. Existing
payloads for OpenCode never changed, and no stored key changed. Foreign runs stay
readable and read-only.

### Non-goals

No approval UI, adapter picker, harness filter or grouping, capability dump, or
change to OpenCode-owned copy. Interactive approval waits for M3 and a PO states
model (pending, approved, denied, timeout).

## M3 — Select and prove the second harness

Choose one harness with a real POC. Do not merge production code.

### Decision criteria

Score each candidate on:

- structured-result transport that does not parse free text;
- admission and terminal-state proof, including restart;
- permission model and whether pending approvals survive a restart;
- host approval surface and cancellation;
- native agent catalog or a bounded configured-profile mapping;
- usage and cost reporting;
- protected-path enforcement and background-work behavior;
- session-ID stability and 128-character mapping;
- host composition: whether the adapter can run under the existing OpenCode
  plugin or needs a standalone entry point;
- SDK stability, maintenance, and install footprint.

Provisional order:

1. **Claude Agent SDK** — native structured output, agent catalog, cost. The
   SDK does not reveal a session ID before the first message; the adapter needs a
   durable local-ref → native-session map and must return `unknown` if it is
   missing after a crash.
2. **Codex app-server** — thread IDs arrive before the first turn, approvals and
   `turn/interrupt` are exposed, but pending approvals are not queryable after a
   restart and cost is not reported.
3. **ACP** — defer until a concrete ACP agent proves it can see a per-session
   MCP `flowgraph_report` tool. Without that proof, ACP cannot produce structured
   outcomes.

The decision record must confirm the order with real SDK evidence; the order
above is a hypothesis, not a commitment.

### POC checklist

Run against the real SDK, headless:

1. Discover or map agents; reject unusable ones with a reason.
2. Start a node and receive a schema-valid result without parsing free text.
3. Reject an undeclared outcome and a duplicate report.
4. Cancel an active turn and map the stop reason.
5. Kill the process mid-turn; confirm recovery blocks and does not re-prompt.
6. Restart with a pending permission; confirm the adapter reports `unknown`, not
   `none`.
7. Confirm no auto-approve path exists.
8. Record usage, cost, audit, background-work, and protected-path behavior.
9. Record the native session ID length and the mapping strategy.

### Acceptance

- A decision record selects one harness and records the scorecard, POC evidence,
  known gaps, and a go/no-go.
- The POC proves the checklist above or documents why a scenario is impossible.
- No production code, dependency, RPC, or docs support claim is merged.

### Tests

The POC runs as a manual or opt-in integration check outside the default suite.
It does not add a CI model call.

### Risks

- SDK behavior differs from documentation and invalidates the scorecard.
- A POC can drift into production; time-box it and keep it out of `src/`.
- Approval without a host surface deadlocks a run; record the static-policy
  fallback before M4.

### Rollback

Discard the spike. There is no production surface to revert.

### Non-goals

No second adapter in `src/`, no RPC approval, no UI, no package split, no support
claim.

## M4 — Second-adapter beta

Ship one experimental adapter, headless, with honest capabilities.

### Work

- Implement the selected adapter behind an opt-in option. One active harness owns
  a store at a time; a run written by another harness is readable and read-only.
- Add a minimal headless composition root (CLI or local server) only if the
  adapter cannot run under the OpenCode plugin. Reuse `WorkflowService`,
  `WorkflowRunner`, the store, and `ReportIntake`; do not add a second UI.
- Use a host-supplied static allow/deny permission policy. No auto-approve. If a
  pending permission has no surface, block and document the deadlock. Do not add
  an RPC approval method yet.
- Report `backgroundWork: "unobservable"` unless background work is actually
  rejected, and `protectedPaths` only at the level actually enforced.
- Add a packed-install test: build the tarball, install it in a temp project
  without OpenCode peers, and import the core entry points plus
  `NodeResultSchema`. If installation fails only because OpenCode peers are
  required, add a `./core` subpath and mark the OpenCode peers optional. Keep one
  package; do not split.
- Keep the `v1` storage keys and the `run-harness` sidecar. Do not namespace by
  harness yet. A run without a sidecar is adopted only by OpenCode.
- Add a security parity matrix to `docs/adapters.md`: one row per claim, the
  enforcing layer, a test or manual evidence link, and a status of verified,
  POC, or unverified. Unverified claims are removed from user-facing docs.
- Update `README.md`, `docs/adapters.md`, `docs/operations.md`, and
  `docs/interfaces.md` only to the extent the adapter actually supports. Keep
  "experimental" and "headless" visible.

### Acceptance

- The new adapter passes the full contract suite.
- A packed tarball imports the core in a temp project without OpenCode peers, or
  the documented `./core` plus optional-peer change is in place and tested.
- `bun run check` and `bun run build:gui` pass.
- OpenCode output snapshots remain unchanged, and the opt-in flag off leaves
  behavior identical.
- The security matrix has evidence for every claim; POC-only claims are labeled.
- Disabling the adapter leaves foreign runs readable and read-only; no OpenCode
  data is touched.

### Tests

- The new adapter's contract suite (opt-in for the real SDK, fixture for CI).
- Packed-install smoke in a temp directory.
- Existing RPC/UI snapshots.
- Runs with and without a sidecar: OpenCode adopts a legacy run; the second
  adapter refuses it and leaves it read-only.
- One manual real-harness run covering report transport, cancel, restart, and
  permission blocking.
- Security matrix evidence links.

### Risks

- Optional peers or a new export can break existing installs.
- A capability lie is a security defect; the matrix and contract suite gate it.
- Background work can outlive a node; the UI warning is not an enforcement.
- Two harnesses in one store could allow cross-harness control; refuse foreign
  control and defer namespacing.
- Maintenance cost grows with every adapter.

### Rollback

Disable the opt-in flag; foreign runs remain readable and read-only. Revert
`package.json` exports and peer metadata, publish a fixed patch, and deprecate the
bad version. No tags are rewritten and no stored run is migrated.

### Non-goals

No full second-host RPC/TUI, interactive approval, shared-store namespacing,
package split, hosted service, marketplace, visual editor, or browser UI.

## M5 — Full parity (not committed)

Start only when a real host and user commit to it and the M4 security review
passes.

### Work

- Add an interactive approval contract with pending, approved, denied, and
  timeout states, owned by the host or a new RPC method. Never auto-approve.
- Add full second-host RPC, TUI, and Desktop surfaces with the same
  read-only/ownership rules. M2's capability lines, warnings, foreign badges, and
  accessibility rules apply unchanged; they are inherited, not re-specified.
- Add shared-store namespacing under `v1/h/<harnessID>/` with dual-read of
  `v1/...`, and migrate only with a tested rollback. Until then, one harness per
  store.
- Revisit packaging only if a real host must install without OpenCode.

### Acceptance

- A real host completes a workflow with a human gate and an approval decision.
- The approval state model is specified, tested, and audited.
- Dual-read storage proves old and new keys resolve the same runs.
- No OpenCode regression and no silent control of a foreign run.

### Tests

Host-integration tests, approval-state tests, storage migration and dual-read
tests, and the full contract suite on both adapters.

### Risks

- Approval is the highest-risk surface; a missing deny path can block or
  over-permit work.
- Storage migration can orphan runs.
- A second UI doubles the support surface.

### Rollback

Keep the flag off, leave the `v1` keys authoritative, and revert the UI. Do not
delete or rewrite existing run records.

### Non-goals

No hosted backend, marketplace, visual editor, or exactly-once external side
effects.

## Global non-goals

- No workflow YAML change or new node type; `version: 1` stays.
- No breaking RPC change, no RPC v2, no stored-key rewrite.
- No change to OpenCode behavior, permissions, or OpenCode-owned copy.
- No free-text result parsing and no auto-approval.
- No hosted execution, marketplace, visual editor, or browser UI.
- No new dependency unless the M3 POC proves it is required.
- No full second-host RPC/TUI before M5.
- No shared-store migration before M5.
- No package split.

## Compatibility invariants

These hold through every milestone:

- Workflow YAML stays `version: 1`; no new node type is required for a new
  harness.
- The RPC ID stays `flowgraph`, the existing methods and error codes keep their
  behavior, and no v2 surface is introduced.
- `RunRecord`, step, and report keys are unchanged. Harness identity stays in the
  sidecar.
- A legacy run with no sidecar is adopted by OpenCode only.
- A foreign run is read-only: no live permission query, no control, no native
  session opened by this client.
- No free-text outcome parsing and no auto-approval.
- OpenCode behavior and permissions are unchanged.

## Open questions

- Which second harness and host is the target: Claude Code, Codex, or an ACP
  editor? If none, stop after M2.
- Is a headless adapter shippable, or is the POC only a proof?
- Does the second harness run under the existing OpenCode plugin, or under a new
  headless entry point?
- For `backgroundWork: "unobservable"`, is a warning enough or must the run be
  opt-in?
- Who owns approval: the host UI or a new RPC method?
- Is the Desktop GUI expected to control a second harness, or only display it?

Answer the first four before M4; answer the last two before M5.

## Definition of done for a second harness

- Real SDK POC evidence for transport, recovery, permissions, cancel, usage, and
  security posture.
- Full contract suite green, including capability-honesty cases.
- Capabilities exposed and run views ownership-aware.
- Packed install tested without OpenCode peers.
- Security matrix complete, with POC claims labeled.
- Docs updated honestly; support statement matches evidence.
- Rollback rehearsed: disable the flag, revert packaging, keep old runs readable.
