# @ryan_nookpi/pi-extension-idle-screensaver

This extension shows a clean idle overlay when pi has been inactive for a while.

If you often leave sessions open in the background, it keeps the screen less distracting and makes the current session easier to recognize.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-idle-screensaver
```

## Great for

- leaving pi open for long periods while you work on something else
- keeping an inactive session visually tidy
- displaying the current session name or fallback context more clearly

## How it works

- After a period of inactivity, it opens a full-screen overlay.
- Press any key to dismiss it immediately.
- It pauses automatically while the agent is running or while a question UI is open.
- If a session name exists, it shows that name. Otherwise it falls back to folder or branch information.
