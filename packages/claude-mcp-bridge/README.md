# claude-mcp-bridge

Bridge [Claude Code MCP](https://modelcontextprotocol.io/) server configurations into pi — auto-discovers and registers MCP tools from stdio, SSE, and streamable-HTTP servers.

## What it does

- **Config auto-discovery** — scans for MCP settings in priority order:
  - `PI_MCP_CONFIG` env var (single file override)
  - Scoped search from cwd upward: `.pi/mcp.json`, `.mcp.json`, `backend/.mcp.json`, `frontend/.mcp.json` (only after Pi project-trust approval, or with `PI_MCP_ALLOW_PROJECT=1`)
  - Global: `~/.mcp.json`, `~/.claude.json`
  - First-seen server name wins on duplicates
- **Protocol compatibility** — auto-negotiates the stateless MCP `2026-07-28` protocol over stdio and streamable HTTP, then falls back to the `2025` initialize/session protocol for older servers
- **Server transports** — `stdio`, `http` (streamable HTTP), plus deprecated `sse` for legacy-server compatibility
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
| `PI_MCP_ALLOW_PROJECT=1` | Explicitly allow project-scoped MCP config discovery when the project has no Pi trust-requiring resources |
| `PI_MCP_EAGER=1` | Wait for MCP connections during extension load (temporary rollback path) |
| `PI_MCP_CONNECT_TIMEOUT_MS` | Override the per-server connection timeout (default: 30000 ms) |
| `PI_MCP_PROTOCOL_PROBE_TIMEOUT_MS` | Override the stdio `server/discover` probe timeout for slow modern servers (default: min of 10000 ms and half the connection timeout) |
| `PI_MCP_TOOL_TIMEOUT_MS` | Override the MCP tool call timeout (default: 60000 ms) |

## Protocol compatibility

For stdio and streamable HTTP servers, the bridge uses the official TypeScript SDK's `versionNegotiation: { mode: "auto" }` flow:

1. Probe with `server/discover` for MCP `2026-07-28`.
2. Use stateless, self-describing requests when the server supports it.
3. Fall back to the legacy `initialize` handshake when the server only supports a 2025-era protocol.

The stdio probe uses a shorter timeout than the full connection by default so a silent legacy server still has time to complete its `initialize` handshake. Set `PI_MCP_PROTOCOL_PROBE_TIMEOUT_MS` higher when a modern stdio server legitimately needs more than 10 seconds to start.

Explicit `type: "sse"` configurations stay on the legacy protocol because HTTP+SSE is deprecated and does not support the new stateless transport model. See the [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) and the [TypeScript SDK protocol version guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md).

## Notes

- Node.js 20 or newer is required by the MCP TypeScript SDK v2.
- `${ENV_NAME}` in config values are expanded from environment variables only for permitted config sources. Untrusted project MCP files are not read.
- Cache fingerprints include only server names, transport types, URL hosts, and redacted command structure. Header and environment values are never persisted.
- URL paths and command argument values are intentionally excluded from fingerprints. Matching cached schemas can be briefly stale until live discovery refreshes them; rename the server or remove the cache before an offline-only run after such changes.
- Cache files are replaced atomically after every changed live tool discovery.
- A cached tool called before its server is ready waits for the existing connection attempt instead of starting a duplicate process.
- After changing MCP config (add/remove/rename servers), run `/reload`.
