# Architecture

## Ownership

- OpenCode owns agents, sessions, permissions, models, and tools.
- The plugin owns workflow YAML parsing, graph validation, orchestration, run state, recovery, and Mermaid generation.
- Workflow definitions stay in `.opencode/workflows`.
- Runtime state stays in OpenCode plugin storage, keyed by project.

## Modules

| Module | Responsibility |
|---|---|
| `workflow/schema.ts` | Zod YAML schema and hard limits |
| `workflow/loader.ts` | Safe YAML parsing, discovery, hashing, atomic file operations |
| `workflow/graph.ts` | Pure graph construction, validation, transition resolution |
| `workflow/mermaid.ts` | Pure, escaped, deterministic Mermaid generation |
| `workflow/validator.ts` | Semantic validation and native agent resolution |
| `execution/native-agents.ts` | Typed adapter over OpenCode agents, sessions, and permissions |
| `execution/report-tool.ts` | `agent_workflows_report` tool and active-session registry |
| `execution/tool-hooks.ts` | Workflow-session background-work policy |
| `execution/prompts.ts` | Bounded context handoff prompts |
| `execution/results.ts` | Result/audit summarization and usage estimates |
| `execution/runner.ts` | Explicit run state machine, polling, limits, pause/resume/cancel, recovery |
| `state/store.ts` | Project-scoped records with revisioned run mutations |
| `state/concurrency.ts` | Host-local project lock and busy detection |
| `service.ts` | Workflow discovery/validation and run control facade |
| `rpc.ts` | Shared `Rpc.define` contract |
| `contract.ts` | Shared Zod schemas and exported types |
| `rpc/handlers.ts` | Thin RPC handlers and error mapping |
| `index.ts` | Plugin setup, tool/RPC registration, recovery scheduling, cleanup |

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

The agent never chooses a target node. It only reports an outcome; the validated graph chooses the transition.

## Structured result boundary

V2 agent prompts do not have a native response schema. The plugin uses a typed tool whose input is validated by OpenCode and persisted by the plugin. Free-form phrases such as `DONE` or `LGTM` are never parsed.

The tool is location-wide because OpenCode plugin tools are not session-scoped. Executors reject calls outside an active workflow node session, and background `subagent`/`shell` calls are rejected inside workflow sessions by default.

## Failure boundaries

- Missing/invalid report after bounded corrections: node/run fails.
- Native failure or interruption: explicit failure or blocked state.
- Permission pending: blocked, never auto-approved.
- Ambiguous active node after restart: blocked, never automatically re-prompted.
- Storage corruption: invalid state, fail closed.
- Unsupported concurrent writers: project lock plus fail-closed checks.
