# TUI graph

The package ships a TUI part. It adds a `Workflow graph` session panel and a `/workflow` command.

## Open it

1. Open a session that belongs to a workflow run, or any session in the project.
2. Run `/workflow` or use the command palette: **Workflow**.
3. The panel resolves the run from the session metadata, or shows the active/latest run for the project.

## Commands

The `/workflow` slash command accepts arguments:

| Command | Action |
|---|---|
| `/workflow` or `/workflow graph` | Open the workflow graph. |
| `/workflow visuals` | Same as `graph`. |
| `/workflow list` | List available workflows and start one. |
| `/workflow run <workflow-id> <objective...>` | Start a run. |
| `/workflow <workflow-id> <objective...>` | Shorthand for `run`. |

Starting a workflow asks for a missing workflow ID or objective with a dialog, then opens the graph panel.

## What it shows

- Workflow and run identity.
- Status, revision, step count, blocker, and pending native permissions.
- Nodes with completed, active, failed, paused, and pending markers.
- Outcome-labelled edges, including cycles and terminal edges.
- The active node is highlighted.

The TUI does not render Mermaid. It renders the structured graph from `getRunGraph`, which keeps the terminal view readable and interactive.

## Keys

| Key | Action |
|---|---|
| `enter` | Open the active node's native session |
| `p` | Pause or resume |
| `c` | Cancel the run |
| `r` | Refresh |

The panel also receives `runUpdated` events and refreshes periodically as a fallback.

## Loading

The TUI part is exported as `./tui`. OpenCode loads it with the package's server part. For a TUI connected to a remote server, make sure the plugin is available in the TUI's plugin configuration as documented by OpenCode.

If no run appears, the panel shows the project directory and an explicit `No workflow runs visible` message after a short RPC timeout. Runs are stored in the plugin storage of the server that started them; a TUI connected to a different server will not see the Desktop app's runs.

The panel also checks the server plugin version through `capabilities`. If the TUI and server parts differ, it shows a version-mismatch message instead of loading forever. Restart OpenCode after updating the plugin, and make sure the old `opencode-agent-workflows` package is removed from `opencode.json(c)` and `cli.json`.
