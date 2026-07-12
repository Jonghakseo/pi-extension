# @ryan_nookpi/pi-extension-codex-large-context

> **⚠️ Deprecated.** This package is no longer maintained and will not receive updates.

This extension raises the pi context window metadata for newer OpenAI Codex models.

It is intended for `gpt-5.4` and `gpt-5.5` model IDs when pi reports a smaller context window than the model can actually handle.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-codex-large-context
```

## Usage

Large context mode is ON by default.

```text
/codex-large-context on
/codex-large-context off
/codex-large-context status
```

Running `/codex-large-context` with no argument shows the current status.

## What it does

- Watches `session_start` and `model_select` events while enabled.
- If the active model ID starts with `gpt-5.4` or `gpt-5.5`, sets its context window to `922000` tokens.
- Stores the on/off setting locally so it persists across sessions.
- Shows a small notification when the context window is updated in the interactive UI.

## Notes

- This only changes pi's local model metadata for the active session/model selection.
- It does not change API limits on the provider side.
- If pi already reports a context window of `922000` tokens or more, it leaves the model unchanged.
- Turning the feature off prevents future context-window adjustments; it does not restore a model that was already adjusted earlier in the session.
