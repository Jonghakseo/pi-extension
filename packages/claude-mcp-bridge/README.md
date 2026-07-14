# claude-mcp-bridge

Bridge [Claude Code MCP](https://modelcontextprotocol.io/) server configurations into pi — auto-discovers and registers MCP tools from stdio, SSE, and streamable-HTTP servers.

## What it does

- **Config auto-discovery** — scans for MCP settings in priority order:
  - `PI_MCP_CONFIG` env var (single file override)
  - Scoped search from cwd upward: `.pi/mcp.json`, `.mcp.json`, `backend/.mcp.json`, `frontend/.mcp.json`
  - Global: `~/.mcp.json`, `~/.claude.json`
  - First-seen server name wins on duplicates
- **Server transports** — `stdio`, `sse`, `http` (streamable-HTTP)
- **Lazy connections** — by default the extension factory never waits for MCP servers; background connections start at `session_start` and tools register dynamically as servers become ready
- **Tool schema cache** — cached schemas are registered immediately from `~/.pi/agent/cache/claude-mcp-bridge/tools-v1.json` and refreshed after connection
- **Tool registration** — each MCP tool becomes a pi tool named `mcp__<server>__<tool>`
- **Tool toggle** — enable/disable per-tool via `/mcp-status` overlay; persisted in `~/.pi/agent/claude-mcp-bridge-tools.json`
- **Auto-reconnect** — exponential backoff on unexpected disconnection (up to 5 attempts)
- **Status bar** — footer shows connecting, connected, failed, offline, and cached states
- **Large payload handling** — responses > 30 KB are saved to a temp file with a truncated preview

## Commands

| Command | Description |
|---------|-------------|
| `/mcp-status` | Interactive overlay: server list → actions (Tools toggle, Reconnect) |

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-claude-mcp-bridge
```

## Runtime controls

| Environment variable | Behavior |
|----------------------|----------|
| `PI_OFFLINE=1` | Skip connections and reconnect timers while keeping matching cached tool schemas available |
| `PI_MCP_EAGER=1` | Wait for MCP connections during extension load (temporary rollback path) |
| `PI_MCP_CONNECT_TIMEOUT_MS` | Override the per-server connection timeout (default: 30000 ms) |
| `PI_MCP_TOOL_TIMEOUT_MS` | Override the MCP tool call timeout (default: 60000 ms) |

## Notes

- `${ENV_NAME}` in config values are expanded from environment variables.
- Cache fingerprints include only server names, transport types, URL hosts, and redacted command structure. Header and environment values are never persisted.
- URL paths and command argument values are intentionally excluded from fingerprints. Matching cached schemas can be briefly stale until live discovery refreshes them; rename the server or remove the cache before an offline-only run after such changes.
- Cache files are replaced atomically after every changed live tool discovery.
- A cached tool called before its server is ready waits for the existing connection attempt instead of starting a duplicate process.
- After changing MCP config (add/remove/rename servers), run `/reload`.
