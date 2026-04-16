# memory-layer

Long-term memory layer for pi — remember, recall, forget, and browse memories across sessions.

## What it does

Provides persistent memory that survives across pi sessions:

- **remember** tool — save facts, rules, or lessons with `user` (global) or `project` (repo-specific) scope
- **recall** tool — search memories by keyword, retrieve by ID, or list the full index
- **forget** tool — permanently delete memories that are no longer valid
- **memory_list** tool — list all active memories, optionally filtered by scope
- `/remember` command — interactive memory save with topic selection UI
- `/memory` command — full-featured overlay browser with search, scope filter, view, copy, and delete

### Storage

Memories are stored as Markdown files under `~/.pi/memory/`:

```text
~/.pi/memory/
  user/
    MEMORY.md          # index
    general.md         # topic file
    coding-rules.md    # topic file
  projects/
    <project-id>/
      MEMORY.md
      general.md
```

### Project ID resolution

Project identity is resolved automatically:

1. `git remote origin` URL → normalized slug
2. Root commit hash → `commit-{hash8}`
3. Fallback: cwd path hash → `local-{hash8}`

### System prompt injection

On each turn, the memory index is injected into the system prompt so the LLM knows what's stored without needing an explicit recall call.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-memory-layer
```
