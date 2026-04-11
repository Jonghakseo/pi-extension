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

## How it works

- It reads the first user message and generates a short session name.
- The generated name is applied to the session name, status area, and terminal title.
- If a session already has a name, it does not overwrite it.
- It skips automatic naming for subagent sessions.

## Example

If the first request is something like `Prepare a pre-release checklist`, pi can automatically turn that into a short session title.
