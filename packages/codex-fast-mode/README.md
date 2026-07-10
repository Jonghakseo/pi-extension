# @ryan_nookpi/pi-extension-codex-fast-mode

This extension helps pi use OpenAI Codex in a faster, lower-verbosity mode.

It is mainly intended for `openai-codex` with `gpt-5.4`, `gpt-5.5`, or the `gpt-5.6` Codex variants (`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`), where you want quick execution and shorter responses.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-codex-fast-mode
```

## Great for

- prioritizing speed over long explanations
- keeping Codex responses concise
- toggling a faster Codex setup per session

## Usage

```text
/codex-fast on
/codex-fast off
/codex-fast status
```

## Notes

- Target models: `openai-codex / gpt-5.4`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra`.
- It always applies `text.verbosity=low`.
- When fast mode is enabled, it also injects `service_tier=priority`.
- The setting is stored locally and persists across sessions.

## References

- OpenAI recommends the Responses API for reasoning models such as `gpt-5.6`: <https://developers.openai.com/api/docs/guides/text>
- OpenAI documents `text.verbosity=low` for shorter GPT-5-family outputs: <https://help.openai.com/en/articles/5072518-controlling-the-length-of-completions>
- OpenAI documents `service_tier=priority` as the request-level opt-in for Priority processing on the Responses API: <https://developers.openai.com/api/docs/guides/priority-processing>
