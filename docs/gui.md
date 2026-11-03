# Desktop GUI graph

The package ships an experimental OpenCode Desktop GUI part, `./gui-experimental`.

## What it shows

- The generated Mermaid graph.
- The active node highlighted.
- Completed, failed, paused, and pending nodes styled by the graph state.
- Run status, revision, failure reason, blocker, and pending permission count.
- Click a node to open its native session. A node without a session shows a toast instead.
- Buttons for changing runs, pause, resume, cancel, and graph zoom.
- Live updates from `runUpdated`, with polling as a fallback.

## Multiple runs

Each workflow run has its own root session. Opening a run opens that session's tab and adds a graph panel to it, so several runs can stay open as separate graph tabs.

The **Workflow** command opens a run picker containing every run on the current server, across projects and worktrees. The **Runs** button in the graph panel reopens it. An unrelated session never silently shows another run's graph.

Runs are stored in the plugin storage of the server that started them. Desktop loads GUI parts from its own background server, so the TUI and Desktop must use the same server to see the same runs.

## Requirements

- OpenCode Desktop with the experimental GUI plugin API.
- The plugin must be configured in the **global** `opencode.json(c)` so Desktop can load the GUI bundle.
- The server part must load successfully. A plugin whose server part fails has no GUI.

## Build

The GUI entry must be one prebuilt CommonJS file:

```sh
bun run build:gui
```

This writes `dist/gui-experimental.cjs`. The release workflow and `prepublishOnly` build it automatically.

## Open it

Use the command palette: **Workflow**, or the session side panel's **+** menu and choose **Workflow graph**.

The `/flowgraph` slash command accepts arguments:

| Command | Action |
|---|---|
| `/flowgraph` or `/flowgraph graph` | Open the current workflow graph, or pick a run. |
| `/flowgraph visuals` | Same as `graph`. |
| `/flowgraph runs` | Pick a run. |
| `/flowgraph list` | List available workflows and start one. |
| `/flowgraph run <workflow-id> <objective...>` | Start a run. |
| `/flowgraph <workflow-id> <objective...>` | Shorthand for `run`. |

Starting a workflow asks for a missing workflow ID or objective with a dialog, then opens the new run's own session and graph panel.

## Experimental status

The Desktop GUI API is experimental and may change between OpenCode releases. The server RPC and TUI graph use the stable structured `getRunGraph` model, so changes to the GUI part do not affect the orchestrator.
