# @ryan_nookpi/pi-extension-cc-system-prompt

This extension swaps pi's default system prompt with a Claude Code-style prompt when you use a Claude model.

It also preserves pi's original system prompt by injecting it once as a persistent `<system-reminder>` message.

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

- This is experimental and prompt fidelity is approximate.
- Vendored prompt fragments come from `Piebald-AI/claude-code-system-prompts`.
