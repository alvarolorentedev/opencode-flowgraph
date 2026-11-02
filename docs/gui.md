# Desktop GUI graph

The package ships an experimental OpenCode Desktop GUI part, `./gui-experimental`.

## What it shows

- The generated Mermaid graph.
- The active node highlighted.
- Completed, failed, paused, and pending nodes styled by the graph state.
- Run status, revision, blocker, and pending permission count.
- Click a node to open its native session.
- Buttons for pause, resume, and cancel.
- Live updates from `runUpdated`, with polling as a fallback.

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

Use the command palette: **Workflow**. Or open the session side panel's **+** menu and choose **Workflow graph**.

The `/workflow` slash command accepts arguments:

| Command | Action |
|---|---|
| `/workflow` or `/workflow graph` | Open the workflow graph. |
| `/workflow visuals` | Same as `graph`. |
| `/workflow list` | List available workflows and start one. |
| `/workflow run <workflow-id> <objective...>` | Start a run. |
| `/workflow <workflow-id> <objective...>` | Shorthand for `run`. |

Starting a workflow asks for a missing workflow ID or objective with a dialog, then opens the graph panel.

## Experimental status

The Desktop GUI API is experimental and may change between OpenCode releases. The server RPC and TUI graph use the stable structured `getRunGraph` model, so changes to the GUI part do not affect the orchestrator.
