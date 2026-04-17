# @ryan_nookpi/pi-extension-cc-system-prompt

Use your **Claude Code subscription** (Max, Team, Enterprise) with pi.

Claude Code's API uses a dedicated system prompt to identify itself. This extension swaps pi's system prompt with that Claude Code-style prompt when you select a Claude model, so the API recognizes requests as coming from Claude Code and routes them through your subscription plan.

Pi's original system prompt is preserved by injecting it once as a persistent `<system-reminder>` message.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-cc-system-prompt
```

## Great for

- experimenting with Claude Code-flavored prompt behavior inside pi
- keeping pi's original guidance available as a reminder
- using a vendored, reviewable prompt source instead of a remote dependency

## Behavior

- Applies only when the selected model ID starts with `claude-`
- Replaces pi's system prompt with a curated Claude Code prompt assembled from vendored prompt fragments
- Injects pi's original system prompt once as a persistent reminder message

## Notes

- No additional API charges — requests are billed against your existing Claude Code subscription.
- This relies on undocumented Anthropic internal behavior and may break at any time without notice.
- Vendored prompt fragments come from `Piebald-AI/claude-code-system-prompts`.
