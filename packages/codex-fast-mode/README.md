# @ryan_nookpi/pi-extension-codex-fast-mode

This extension helps pi use OpenAI Codex in a faster, lower-verbosity mode.

It is mainly intended for `openai-codex` with `gpt-5.4`, where you want quick execution and shorter responses.

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

- Target model: `openai-codex / gpt-5.4`
- It always applies `text.verbosity=low`.
- When fast mode is enabled, it also injects `service_tier=priority`.
- The setting is stored locally and persists across sessions.
