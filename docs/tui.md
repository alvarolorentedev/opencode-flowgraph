# TUI graph

The package ships a TUI part. It adds a full-screen `Workflow` page, a `Workflow graph` session panel, and a `/flowgraph` command.

## Open it

1. Run `/flowgraph` or use the command palette: **Workflow**.
2. If the current session belongs to a workflow run, the graph opens in its session panel.
3. Otherwise the full-screen workflow page opens. No session is required.

The page lists every workflow run visible on the connected server, including runs in other projects and worktrees. Select a run to see its structured graph.

## Commands

The `/flowgraph` slash command accepts arguments:

| Command | Action |
|---|---|
| `/flowgraph` or `/flowgraph graph` | Open the current workflow session panel, or the all-runs page. |
| `/flowgraph visuals` | Same as `graph`. |
| `/flowgraph runs` | Open the all-runs page. |
| `/flowgraph list` | List available workflows and start one. |
| `/flowgraph run <workflow-id> <objective...>` | Start a run. |
| `/flowgraph <workflow-id> <objective...>` | Shorthand for `run`. |

Starting a workflow asks for a missing workflow ID or objective with a dialog, then opens the new run's own session and graph panel.

## What it shows

- Every run on the server: workflow, status, directory, and objective.
- Workflow and run identity for the selected run.
- Status, revision, step count, blocker, and pending native permissions.
- A boxed top-down diagram: nodes are boxes, branches sit side by side, and cycles or long jumps route around a right-hand rail.
- Nodes with completed (green), active (yellow), failed or routed-back (red), paused, and pending markers and colours.
- Outcome-labelled edges, including cycles and terminal edges.
- The active node is highlighted and pulses while the panel is visible.

The TUI does not render Mermaid. It renders the structured graph from `getRunGraph` directly. If the diagram does not fit the available width or height, the page falls back to a compact text list and says why.

## Keys

### Workflow page

| Key | Action |
|---|---|
| `up` / `down` | Select a run |
| `o` | Open the selected run's session with its graph panel |
| `enter` | Open the active node's native session |
| `p` | Pause or resume |
| `c` | Cancel the run |
| `r` | Refresh |

### Session panel

| Key | Action |
|---|---|
| `enter` | Open the active node's native session |
| `p` | Pause or resume |
| `c` | Cancel the run |
| `r` | Refresh |

The page and panel receive `runUpdated` events and refresh periodically as a fallback.

## Loading

The TUI part is exported as `./tui`. OpenCode loads it with the package's server part. For a TUI connected to a remote server, make sure the plugin is available in the TUI's plugin configuration as documented by OpenCode.

If no run appears, the page shows an explicit message. Runs are stored in the plugin storage of the server that started them; a TUI connected to a different server will not see another server's runs.

The page and panel also check the server plugin version through `capabilities`. If the TUI and server parts differ, they show a version-mismatch message instead of loading forever. Restart OpenCode after updating the plugin, and make sure the old `opencode-agent-workflows` package is removed from `opencode.json(c)` and `cli.json`.
