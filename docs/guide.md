# Workflow guide

This guide covers the two files you own: native OpenCode agents and the workflow YAML that connects them.

## Agent requirements

Agent nodes reference native OpenCode agent IDs from `.opencode/agents/*.md`. Agents must be:

- Not hidden
- `mode: primary` or `mode: all`
- Able to use tools, because every node reports through the `flowgraph_report` tool
- Given a `model`, or covered by a global `model` in `opencode.json(c)`

`mode: subagent` agents are rejected. The native contract runs subagents only through the `subagent` tool, and selecting one directly from a workflow would bypass that gate. Change the agent to `mode: all` if you want it in a workflow.

The plugin never creates, edits, or elevates agents.

```md
---
description: Reviews changes for correctness and missing tests
mode: primary
model: opencode-go/deepseek-v4.1-flash
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

Review the change. Report findings in severity order.
```

## Workflow files

Workflows live in `.opencode/workflows/*.yaml`. The file stem must match `name`: `development.yaml` → `name: development`.

```yaml
version: 1
name: development
description: Development with iterative quality checks

entry: developer

limits:
  max_steps: 12
  timeout_seconds: 3600
  node_timeout_seconds: 900
  max_result_retries: 2
  max_recovery_attempts: 3
  max_repeat_transitions: 5

nodes:
  developer:
    agent: developer
    next: reviewer

  reviewer:
    agent: reviewer
    routes:
      approved: security
      changes_requested: developer
      blocked: pause

  security:
    agent: security
    routes:
      approved: complete
      changes_requested: developer
      blocked: pause
```

### Rules

- `version` must be `1`.
- `name` and every node ID are lowercase slugs.
- `entry` must be a node ID.
- An agent node defines exactly one of `next` or `routes`.
- `next` is unconditional.
- `routes` maps structured outcomes to targets.
- `complete` and `pause` are reserved terminal targets.
- Every node must be reachable from `entry`.
- Cycles are supported; `max_steps` and `max_repeat_transitions` bound them.
- Unknown fields, duplicate YAML keys, aliases, merge keys, custom tags, and oversized files are rejected.

### Parallel branches and workflow calls

A fork declares 2–16 distinct branch entry nodes and a join. The join is an agent node dedicated to that fork. It runs once after every branch reaches it and receives the last result from each branch in declaration order. Branches may contain routes, loops, and nested forks. Each branch has its own nodes until the join, and every branch node needs a path to the join.

A call references a workflow in the same repository by its YAML name. Map both child terminal outcomes, `complete` and `pause`, to caller targets. The child receives the parent's objective and recent results. Its final result passes back to the caller. Child steps, permissions, and failures are part of the same run.

```yaml
nodes:
  dispatch: { fork: [security, verification], join: integrate }
  security: { agent: security, next: integrate }
  verification:
    workflow: review
    routes: { complete: integrate, pause: investigate }
  investigate: { agent: reviewer, next: integrate }
  integrate: { agent: reviewer, next: complete }
```

The parent supplies the overall step, wall-clock, and recovery budgets. Each workflow supplies its own node timeout, report retry count, and repeated-transition limit. Forks and calls themselves consume no steps. The combined YAML sources must fit within 256 KiB, and workflow references must be acyclic.

Parallel branches and runs in the same checkout share files. Coordinate writes when agents can edit the same paths.

### Limits

`limits` and `max_steps` are required. Other limits have defaults.

| Limit | Default | Meaning |
|---|---|---|
| `max_steps` | required | Node executions, including repetitions |
| `timeout_seconds` | `3600` | Wall-clock run deadline |
| `node_timeout_seconds` | unset | Bound for one node; the runner interrupts its session on timeout |
| `max_result_retries` | `2` | Correction turns after a missing report |
| `max_recovery_attempts` | `3` | Restart reconciliation attempts |
| `max_repeat_transitions` | `5` | Stops a repeated transition sequence that makes no progress |

## Structured outcomes

V2 session prompts do not support a native response schema. The plugin registers a typed tool, `flowgraph_report`, which the node prompt asks the agent to call exactly once when finished:

```json
{
  "outcome": "changes_requested",
  "summary": "The implementation has an unhandled error path.",
  "feedback": "Handle the error and add a regression test.",
  "evidence": [
    { "kind": "file", "value": "src/example.ts:42" }
  ]
}
```

The plugin validates `outcome` against the current node's declared routes. Invalid outcomes are returned to the agent as tool errors. If a successful node never reports, the plugin sends a bounded correction prompt and then fails the node.

The orchestrator, not the agent, chooses the next node.

Evidence is **agent-reported**. It is stored separately from the native tool audit and is never presented as independently verified. The plugin does not claim a test passed because an agent said so.

The tool is registered for the whole location because OpenCode plugin tools are not session-scoped. Calls from normal, non-workflow sessions are rejected.

## Examples

Runnable examples live in [`examples/.opencode`](../examples/.opencode):

- `agents/` — developer, reviewer, security, tester, designer, and product owner agents
- `workflows/development.yaml` — development, review, and security loop
- `workflows/review.yaml` — a smaller two-stage review loop
- `workflows/product-delivery.yaml` — product, design, build, and review flow
- `workflows/parallel-review.yaml` — parallel security and review branches with a workflow call and a join
