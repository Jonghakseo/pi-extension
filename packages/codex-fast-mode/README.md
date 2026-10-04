# @ryan_nookpi/pi-extension-codex-fast-mode

This extension helps pi use OpenAI Codex in a faster, lower-verbosity mode.

It is intended for `openai-codex` with `gpt-5.5`, the supported `gpt-5.6` variants, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, and `gpt-6.1-sol`, when you want quick execution and shorter responses.

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

- Target models: `openai-codex / gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, and `gpt-6.1-sol`. `gpt-5.4` is no longer targeted.
- Command descriptions and status messages abbreviate the list as `gpt-5.5 ~ gpt-5.6, gpt-6, gpt-6.1-sol`; matching still uses the exact model IDs above.
- This extension does not register models. All target models are in Pi SDK `1.0.1`; availability still depends on your account and workspace.
- OpenAI documents Fast mode usage at 2.5x the Standard rate for included subscription limits and 2x for purchased credits and Enterprise pay-as-you-go usage. These are billing multipliers, not speed increases.
- GPT-5.5 retires from Codex on October 14, 2026; the OpenAI API is not affected.
- It always applies `text.verbosity=low`.
- When fast mode is enabled, it also injects `service_tier=priority` into the ChatGPT Codex backend request. Do not substitute the Codex CLI config value `fast` without verifying backend support.
- Live requests with Pi SDK `1.0.1` succeeded for all four targeted GPT-6 models with `priority` and low verbosity. The backend returned `service_tier=default`, so this confirms request acceptance, not actual priority scheduling or a speed increase.
- The setting is stored locally and persists across sessions.

## References

- OpenAI documents GPT-6 Astra Fast mode availability and Codex credit consumption: <https://developers.openai.com/codex/speed>
- OpenAI documents Astra and its API Fast mode pricing: <https://developers.openai.com/api/docs/models/gpt-6-astra>
- Pi's model catalog and provider implementation: <https://github.com/earendil-works/pi/tree/main/packages/ai/src/providers>

- OpenAI recommends the Responses API for reasoning models such as `gpt-5.6`: <https://developers.openai.com/api/docs/guides/text>
- OpenAI documents `text.verbosity=low` for shorter GPT-5-family outputs: <https://help.openai.com/en/articles/5072518-controlling-the-length-of-completions>
- OpenAI documents `service_tier=priority` as the request-level opt-in for Priority processing on the Responses API: <https://developers.openai.com/api/docs/guides/priority-processing>
