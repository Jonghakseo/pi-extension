# cross-agent

Load commands from other AI coding agent directories (`.claude/`, `.gemini/`, `.codex/`) into pi.

## What it does

Scans project-local and global agent directories and registers `commands/*.md` files as `/name` commands.

| Source | Pattern | Behavior |
|--------|---------|----------|
| `commands/*.md` | Markdown with optional frontmatter | Registered as `/name` command |
| `skills/` | Directories with `SKILL.md` or flat `.md` files | Detected but not registered (reserved for future use) |
| `agents/*.md` | Markdown agent definitions | Detected but not registered (reserved for future use) |
| `.pi/agents/*.md` | Pi-native agent definitions | Detected but not registered (reserved for future use) |

### Scan order

For each provider (`claude`, `gemini`, `codex`):
1. `<cwd>/.<provider>/` (project-local)
2. `~/.<provider>/` (global)

First-seen command name wins on duplicates.

### Command template variables

Commands support `$ARGUMENTS` / `$@` (full args) and `$1`, `$2`, … (positional) substitution.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-cross-agent
```
