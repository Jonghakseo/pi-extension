# @ryan_nookpi/pi-extension-cc-system-prompt

For pi users who want to use the **Claude Code system prompt** inside pi.

When you select a Claude model, this extension swaps pi's default system prompt with a Claude Code-style system prompt, so pi behaves with the Claude Code prompt instead of pi's default one.

Pi's original system prompt is preserved by injecting it once as a persistent `<system-reminder>` message, so pi's tool and skill guidance stays available.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-cc-system-prompt
```

## Behavior

- Applies only when the selected model ID starts with `claude-`.
- Replaces pi's system prompt with a Claude Code system prompt assembled from vendored prompt fragments.
- Injects pi's original system prompt once as a persistent reminder message.

## Notes

- Vendored prompt fragments come from [`Piebald-AI/claude-code-system-prompts`](https://github.com/Piebald-AI/claude-code-system-prompts).
