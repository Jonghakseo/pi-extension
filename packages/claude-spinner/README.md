# @ryan_nookpi/pi-extension-claude-spinner

This extension applies a Claude-style spinner to Pi sessions.

It only changes the working indicator frames. It does not add custom working text or elapsed-time status messages.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-claude-spinner
```

## What it does

- sets the working indicator on session start
- uses the following frame cycle: `· ✻ ✽ ✶ ✳ ✢`
- keeps the rest of Pi's default working text behavior untouched
