# @ryan_nookpi/pi-extension-auto-name

This extension automatically names a pi session based on the first user message.

It helps you quickly recognize what each session is about when many tasks are open at once.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-auto-name
```

## Great for

- quickly understanding what a session is about
- avoiding manual naming with `/name`
- showing the current task clearly in the terminal title and status area

## Configuration

You can customize the model and reasoning level used for name generation.

### `/auto-name:setting`

Show current settings:
```
/auto-name:setting
```

Set a specific model (must be `provider/model-id` format):
```
/auto-name:setting model anthropic/claude-sonnet-4-20250514
```

Set thinking level (affects name generation quality vs speed):
```
/auto-name:setting thinking minimal
```

Available thinking levels: `minimal` (default), `low`, `medium`, `high`, `xhigh`.

Settings are saved to `~/.pi/agent/auto-name/settings.json` and persist across sessions.

If no custom model is set, the extension uses the current session's model.

## How it works

- It reads the first user message and generates a short session name.
- The generated name is applied to the session name, status area, and terminal title.
- If a session already has a name, it does not overwrite it.
- It skips automatic naming for subagent sessions.

## Example

If the first request is something like `Prepare a pre-release checklist`, pi can automatically turn that into a short session title.
