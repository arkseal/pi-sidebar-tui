# pi-sidebar-tui

OpenCode-style sidebar TUI extension for [pi coding agent](https://github.com/earendil-works/pi).

Displays a real-time sidebar panel inside the pi terminal UI showing session metrics, todo tracking, workspace status, and connected MCP servers — inspired by [OpenCode](https://github.com/atanunny/opencode) sidebar.

## Features

### Session Panel
- Session title (auto-inferred from first user message with LLM fallback, or manually set)
- Cumulative **active agent runtime**, not time since opening Pi (idle/offline time and blocking user confirmations are excluded)
- Active tool indicator with live elapsed timer
- Current model name with thinking level (`think:high`, `think:medium`, etc.)
- Context window usage: `tokens / max_window (pct%)` — fill bar escalates color by usage **and** by pace
- Context estimate: `left ≈Nt` — turns remaining until the window fills at recent growth rate (`∞` when flat, `—` until enough data); colored muted ≥20t / accent 5–19t / warning red <5t
- Auto-compact status indicator
- Persistent all-time token input/output totals, cost, cache hit percentage, and model-turn count
- Runtime, usage, last-turn duration, and last measured speed survive closing Pi, `/reload`, and new sessions
- Live tokens-per-second (tok/s) via 2-second sliding window
- Session ID display
- Theme-aware colors (delegates to pi Theme API when available)

### MCP Servers Panel
- Connected MCP server status with connection indicators
- Tool count per server (direct/total)
- Token estimate per server

### Todos Panel
- Parses todo items from tool calls (`todo` tool)
- Status glyphs: `○` pending, `●` in progress, `✓` completed
- Progress counter: `Todos (2/5)`
- Sub-action annotations for in-progress items

### Workspace Panel
- Git branch with ahead/untracked counts
- Dirty file listing with diff stats (+N/-N)
- Current working directory at bottom of sidebar
- Auto-refreshes on write operations (write/edit/bash/computer tools)

## Installation

```bash
pi install npm:pi-sidebar-tui
```

The extension auto-registers via the `"pi"` field in `package.json`.

## Usage

The sidebar activates automatically when a session starts. Toggle visibility with:

```
/sidebar-tui on       # Enable sidebar
/sidebar-tui off      # Disable sidebar
/sidebar-tui width 45 # Set sidebar width (10-120)
/sidebar-tui todos 5  # Set max visible todos (1-100)
/sidebar-tui scroll 1   # Set scroll speed in lines (1-20, default: 1)
/sidebar-tui momentum on|off # Enable/disable scroll velocity momentum (default: on)
/sidebar-tui subagents input|sidebar|both # Configure subagents display (default: both)

/sidebar-scroll down  # Scroll sidebar panel down 3 lines
/sidebar-scroll up    # Scroll sidebar panel up 3 lines
/sidebar-scroll top   # Scroll to top of sidebar
/sidebar-scroll bottom # Scroll to bottom of sidebar
/sidebar-scroll 10    # Scroll to specific line offset

Alt+Shift+Up / Alt+Shift+Down # Scroll sidebar up / down (3 lines, or Ctrl+Alt+Up / Ctrl+Alt+Down)
Alt+PageUp / Alt+PageDown # Scroll sidebar page up / down (10 lines)
Mouse Wheel over sidebar # Scroll sidebar panel with momentum acceleration

Ctrl+Shift+T           # Toggle sidebar on/off
```

Set custom session title:

```
/session-title "My feature implementation"
```

## Persistent Stats

The **All-time / Tokens** grid is cumulative across top-level Pi sessions and workspaces using the same agent directory. Model, context usage, context-pace estimates, active tools, and the live streaming speed remain session-specific.

`time` counts the main agent's active runs (including model requests and tool execution), pauses for blocking user prompts, and stops when the run ends or is aborted. It never includes time spent idle at the editor or time while Pi is closed. `last` is the last model turn's duration; `speed` shows live tok/s while streaming, otherwise the last measured speed.

Stats are saved under `<agent-dir>/sidebar-stats/` (normally `~/.pi/agent/sidebar-stats/`) after usage/turn updates, at run end, every 10 seconds during active work, and on clean shutdown. Atomic per-process snapshots prevent parallel Pi instances from overwriting each other's contributions; totals are combined at startup. Child-agent usage reported to the parent is not also persisted by the child. A forced kill can lose work since the latest checkpoint, but cannot add offline time.

On the first run only, usage and model-turn counts from the current session branch seed the totals. Older active runtime cannot be reconstructed reliably and starts at zero. Reloading/resuming history never counts that usage twice. Damaged snapshot files are skipped, and write failures warn without breaking the sidebar.

To reset the totals, close all Pi instances and remove the stats directory. Set `PI_SIDEBAR_STATS_DIR` to use a different storage location.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PI_SIDEBAR_BG` | *(unset)* | Paint the sidebar with an opaque `#rrggbb` background. Unset (default) leaves the terminal background untouched so terminal transparency shows through. Set e.g. `PI_SIDEBAR_BG="#000000"` to hide scroll flash on opaque terminals. |
| `PI_SIDEBAR_SCROLL_SPEED` | `1` | Number of lines to scroll per wheel/trackpad tick in fullscreen mode (1–20). |
| `PI_SIDEBAR_MOMENTUM` | `1` | Enable scroll momentum/velocity acceleration and inertial glide (`1`/`true` or `0`/`false`). |
| `PI_SIDEBAR_SUBAGENTS` | `1` | Show dynamic subagents panel in sidebar (`1`/`true` or `0`/`false`). |
| `PI_SIDEBAR_STATS_DIR` | `<agent-dir>/sidebar-stats/` | Persistent cumulative stats directory; respects `PI_CODING_AGENT_DIR` by default. |

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi) >= 0.74.0
- [pi-tui](https://github.com/earendil-works/pi) >= 0.74.0

## Persistent Scrolling (Fullscreen TUI Mode)

To keep the sidebar persistent and pinned when scrolling through earlier messages, Pi's **fullscreen TUI mode** (`tuiMode: "fullscreen"`) is used.
- In **fullscreen mode**, Pi manages viewport scrolling (`ScrollView`) with mouse wheel, trackpad, and keyboard shortcuts (`PageUp`/`PageDown`), keeping the sidebar fixed on the right.
- In **regular mode**, the terminal emulator owns native scrollback, causing the sidebar to stay down at the bottom of history when scrolling up.

`pi-sidebar-tui` automatically sets `tuiMode: "fullscreen"` in your Pi settings. You can also run Pi with `pi --tui-mode fullscreen` or toggle TUI mode in `/settings`.

## Architecture

```
pi-sidebar-tui/
├── index.ts              # Extension entry point, event handlers, state management
├── sidebar.ts            # Main sidebar renderer (composes all panels)
├── compositor.ts         # Terminal compositor for right-column layout
├── colors.ts             # ANSI color helpers, formatting utilities
├── types.ts              # TypeScript type definitions
├── stats.ts              # Active-run timer and atomic persistent cumulative stats
├── mcp.ts                # MCP server discovery and status
├── workspace.ts          # Git workspace state tracking
├── panels/
│   ├── session.ts        # Session metrics panel
│   ├── todos.ts          # Todo tracking panel
│   ├── workspace.ts      # Git workspace status panel
│   └── mcp.ts            # MCP server status panel
├── tests/
│   ├── panels.test.ts    # Panel rendering tests
│   └── sidebar.test.ts   # Sidebar rendering tests
└── package.json
```

## How It Works

The extension hooks into pi's event system (`session_start`, `tool_call`, `message_end`, `turn_end`, etc.) to track state and renders a right-column sidebar using a custom `SidebarCompositor` that:

1. Narrows `terminal.columns` so pi renders main content in the left portion
2. Paints the sidebar in the rightmost columns after each pi render cycle
3. Uses synchronized output (`\x1b[?2026h`) to prevent rendering artifacts
4. Saves/restores cursor position (`DECSC`/`DECRC`) around paint

## Development

```bash
npm install
npm test
```

## Publish on npm

```bash
npm login
npm publish
```

## License

MIT
