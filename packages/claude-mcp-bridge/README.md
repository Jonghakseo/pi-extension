# claude-mcp-bridge

Bridge [Claude Code MCP](https://modelcontextprotocol.io/) server configurations into pi — auto-discovers and registers MCP tools from stdio, SSE, and streamable-HTTP servers.

## What it does

- **Config auto-discovery** — scans for MCP settings in priority order:
  - `PI_MCP_CONFIG` env var (single file override)
  - Scoped search from cwd upward: `.pi/mcp.json`, `.mcp.json`, `backend/.mcp.json`, `frontend/.mcp.json`
  - Global: `~/.mcp.json`, `~/.claude.json`
  - First-seen server name wins on duplicates
- **Server transports** — `stdio`, `sse`, `http` (streamable-HTTP)
- **Tool registration** — each MCP tool becomes a pi tool named `mcp__<server>__<tool>`
- **Tool toggle** — enable/disable per-tool via `/mcp-status` overlay; persisted in `~/.pi/agent/claude-mcp-bridge-tools.json`
- **Auto-reconnect** — exponential backoff on unexpected disconnection (up to 5 attempts)
- **Status bar** — footer shows `MCP connected/total`
- **Large payload handling** — responses > 30 KB are saved to a temp file with a truncated preview

## Commands

| Command | Description |
|---------|-------------|
| `/mcp-status` | Interactive overlay: server list → actions (Tools toggle, Reconnect) |

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-claude-mcp-bridge
```

## Notes

- `${ENV_NAME}` in config values are expanded from environment variables.
- After changing MCP config (add/remove/rename servers), run `/reload`.
