# memory-layer

Long-term and session memory for Pi. Remember, recall, forget, and browse memories across sessions.

## What it does

- **Scopes**
  - `agent`: private to the current Pi session. It is restored when that session is reopened, but is not inherited by a fork.
  - `user`: persistent personal preferences and cross-project rules.
  - `project`: persistent repository-specific decisions, tooling, and configuration.
- **Tiers**: `profile`, `log`, and `note`. Recall and prompt injection prioritize them in that order, with query relevance deciding order within a tier. New and legacy memories default to `profile`. Tiers do not expire or delete memories automatically.
- **remember**: save a fact, rule, or lesson with scope, tier, and optional topic.
- **recall**: search by query, retrieve by ID, or list entries. `scope` and `tier` filters apply to every mode, including ID lookup.
- **forget**: remove a memory from active recall. User/project entries are deleted from their topic files; agent entries are logically deleted and remain in session history.
- **memory_list**: list memories with optional scope and tier filters.
- **`/remember`**: interactive save. Usage: `/remember [agent|user|project] [profile|log|note] <content>`.
- **`/memory`**: browse, search, filter, copy, and delete memories. Use `--scope agent` and `--tier note` with ordinary search text, or cycle scope with Tab and tier with Shift+Tab in the overlay.

## Storage

Persistent `user` and `project` memories are Markdown files under `~/.pi/memory/`:

```text
~/.pi/memory/
  user/
    MEMORY.md
    general.md
  projects/
    <project-id>/
      MEMORY.md
      general.md
```

Tier metadata is stored with a versioned entry marker. Existing Markdown files, including old `@entry` markers and indexes, remain readable as `profile` entries without reinterpreting their titles or body text. Session-scoped `agent` memories use Pi session custom entries, rather than the persistent directory. Forgetting an agent memory appends a tombstone to session history, so it stays logically deleted after reopening the session.

## Project ID resolution

Project identity resolves automatically:

1. `git remote origin` URL, normalized to a slug
2. Root commit hash
3. CWD path hash

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-memory-layer
```
