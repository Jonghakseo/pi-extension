# @ryan_nookpi/pi-extension-clipboard

This extension lets pi copy generated text directly to your system clipboard and paste your clipboard contents back into the conversation.

It is especially handy for reply drafts, commit messages, PR descriptions, SQL queries, and other text you want to paste right away.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-clipboard
```

## Great for

- "Write a reply draft and put it in my clipboard"
- copying long outputs without selecting them manually
- using clipboard copy from terminal or SSH-based workflows
- "Paste my clipboard and summarize / translate / refactor it"
- pulling logs, URLs, or snippets you just copied into the chat

## Example prompts

- "Draft a Slack reply and copy it to my clipboard."
- "Put this SQL query in my clipboard."
- "Write a PR description and copy it for me."
- "Paste my clipboard and summarize what's in it."
- "Read my clipboard and translate it to English."

## Tools

- `copy_to_clipboard` — copies text to the user's clipboard via OSC52 escape sequences (works over SSH and in most modern terminals).
- `paste_from_clipboard` — reads the current text contents of the user's clipboard using `pbpaste` (macOS), `xclip -selection clipboard -o` or `wl-paste` (Linux), or PowerShell `Get-Clipboard` (Windows).
