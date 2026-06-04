# @ryan_nookpi/pi-extension-headroom

This extension reclaims context window in pi by compressing large tool results through a [Headroom](https://github.com/headroom-ai/headroom) proxy before each LLM call.

Headroom runs locally, compresses only oversized `toolResult` payloads, and leaves your prompts, assistant turns, and tool-call metadata untouched. Compression is applied only when the proxy is online and the change passes strict alignment guards, so it never silently rewrites your conversation.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-headroom
```

You also need the Headroom proxy available on your machine:

```bash
pip install "headroom-ai[proxy]"
```

By default the extension auto-starts a local token-mode proxy (`headroom proxy --mode token --no-cache`) on `http://127.0.0.1:8788` and leaves it running after pi exits.

## How it works

- Listens on the `context` event fired before each LLM call.
- Skips entirely until context usage reaches the configured token threshold.
- Sends an OpenAI-shaped copy of the conversation to the proxy's `/v1/compress` endpoint.
- Applies the result only to large `toolResult` messages, preserving pi metadata (`toolName`, `details`, tool-call ids, images).
- Rejects any response that changes message count, roles, tool-call ids, or non-candidate content.

## Privacy

Compression sends conversation context to the proxy, so remote URLs are blocked by default. Only `localhost`/`127.0.0.1`/`::1` are allowed unless you explicitly set `PI_HEADROOM_ALLOW_REMOTE=1` for a proxy you trust.

## Commands

- `/headroom` — show current status and session stats.
- `/headroom on` — enable compression and ensure the proxy is running.
- `/headroom off` — disable compression for this session (the proxy keeps running).
- `/headroom health` — check / start the proxy and report whether it is online.
- `/headroom stats` — print the proxy's own `/stats` output.
- `/headroom-health` — shortcut for `/headroom health`.

The footer shows a compact status (`✓ Headroom -42% (12,345 saved)`) once compression is applied.

## Configuration

Settings are read at startup from `~/.pi/agent/headroom/settings.json`. Values in this file override environment variables; environment variables remain supported as fallbacks.

Example:

```json
{
  "minContextTokens": 10000,
  "minMessageChars": 1000
}
```

| Setting key | Env fallback | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `PI_HEADROOM_ENABLED` | `true` | Enable compression on start. |
| `baseUrl` (`url` also accepted) | `PI_HEADROOM_URL` (`HEADROOM_URL` / `HEADROOM_BASE_URL` also accepted) | `http://127.0.0.1:8788` | Proxy base URL. |
| `allowRemote` | `PI_HEADROOM_ALLOW_REMOTE` | `false` | Allow non-local proxy URLs. |
| `autoStart` | `PI_HEADROOM_AUTO_START` | `true` | Auto-start a local persistent proxy when offline. |
| `command` | `PI_HEADROOM_COMMAND` | `headroom` | Command used to launch the proxy. |
| `minContextTokens` | `PI_HEADROOM_MIN_CONTEXT_TOKENS` | `20000` | Skip compression below this context token count. |
| `minMessageChars` | `PI_HEADROOM_MIN_MESSAGE_CHARS` | `2000` | Only compress tool results at or above this size. |
| `timeoutMs` | `PI_HEADROOM_TIMEOUT_MS` | `30000` | HTTP timeout for proxy requests. |

Boolean values accept JSON booleans, or strings such as `1/0`, `true/false`, `yes/no`, `on/off`.
