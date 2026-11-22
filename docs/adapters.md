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
| `security.protectedPaths` | `tool_hook`, `approval_hook`, or `none`. |
| `security.backgroundWork` | `blocked` or `unobservable`. |
| `usage.tokens` / `usage.cost` | What the adapter can actually report. |
| `audit` | The adapter can produce tool-call audit entries. |

Do not set `protectedPaths: "tool_hook"` unless every file-write and shell tool is intercepted. Do not set `backgroundWork: "blocked"` unless background work is actually rejected.

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
- Derive the JSON Schema from `NodeResultSchema`; do not maintain a second definition by hand. Add a test that compares the generated schema to the expected fields.

Set `results.mechanism: "structured_output"`. Missing or invalid output should leave no report; the engine applies its normal correction/failure policy.

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

## Contract tests

A new adapter should pass a shared suite covering:

- agent discovery and selectability;
- session creation and submission;
- successful completion and structured result;
- undeclared outcome rejection;
- duplicate report dedupe;
- conditional routing and cycles;
- parallel branches and joins;
- nested workflows;
- permission pending/unknown;
- cancellation;
- timeouts;
- missing report after success;
- restart recovery and admission ambiguity;
- idempotency;
- concurrent run isolation.

`test/contract/harness-contract.test.ts` is the starting point. `test/fixtures/fake-harness.ts` shows a configurable adapter for testing capability variants. `test/architecture/core-is-harness-agnostic.test.ts` enforces the import boundary.

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
