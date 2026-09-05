# @ryan_nookpi/pi-extension-codex-fast-mode

This extension helps pi use OpenAI Codex in a faster, lower-verbosity mode.

It is intended for `openai-codex` with `gpt-5.4` through the supported `gpt-5.6` variants, plus `gpt-6-astra`, when you want quick execution and shorter responses.

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

- Target models: `openai-codex / gpt-5.4`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-6-astra`.
- Command descriptions and status messages abbreviate the list as `gpt-5.4 ~ gpt-5.6, gpt-6-astra`; matching still uses the exact model IDs above.
- This extension does not register models. Pi must already offer `openai-codex/gpt-6-astra` through its model catalog or your `models.json`. The bundled catalog in Pi SDK `0.85.0` does not include Astra; upstream support was added after that release.
- Astra availability depends on your account. Where available, Codex Astra Fast mode consumes credits at 2.5x the Standard rate.
- It always applies `text.verbosity=low`.
- When fast mode is enabled, it also injects `service_tier=priority`.
- The setting is stored locally and persists across sessions.

## References

- OpenAI documents GPT-6 Astra Fast mode availability and Codex credit consumption: <https://developers.openai.com/codex/speed>
- OpenAI documents Astra and its API Fast mode pricing: <https://developers.openai.com/api/docs/models/gpt-6-astra>
- Pi added Astra for OpenAI API keys and Codex subscriptions after `0.85.0`: <https://github.com/earendil-works/pi/commit/17de82d7bea18a6589677a9761baabc2060c9efb>

- OpenAI recommends the Responses API for reasoning models such as `gpt-5.6`: <https://developers.openai.com/api/docs/guides/text>
- OpenAI documents `text.verbosity=low` for shorter GPT-5-family outputs: <https://help.openai.com/en/articles/5072518-controlling-the-length-of-completions>
- OpenAI documents `service_tier=priority` as the request-level opt-in for Priority processing on the Responses API: <https://developers.openai.com/api/docs/guides/priority-processing>
