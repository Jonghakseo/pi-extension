# memory-layer

Long-term and session memory for Pi. Remember, recall, forget, and browse memories across sessions.

## What it does

- **Scopes**
  - `agent`: private to the current Pi session. It is restored when that session is reopened, but is not inherited by a fork.
  - `user`: persistent personal preferences and cross-project rules.
  - `project`: persistent repository-specific decisions, tooling, and configuration.
- **Tiers**: `profile`, `log`, and `note`. Recall and prompt injection prioritize them in that order, with query relevance deciding order within a tier. New and legacy memories default to `profile`. Tiers do not expire or delete memories automatically.
- **Prompt injection**: each turn receives a bounded, tier-ordered index of accessible memory titles rather than full memory bodies. Use `recall` to search the index or retrieve full content when the index is truncated.
- **remember**: save a fact, rule, or lesson with a required scope, optional tier, and optional topic. The tier defaults to `profile`.
- **recall**: search by query, retrieve by ID, or list entries. Query results return at most the top 20 matches. `scope` and `tier` filters apply to every mode, including ID lookup.
- **forget**: remove a memory from active recall. User/project entries are deleted from their topic files; agent entries are logically deleted and remain in session history.
- **memory_list**: list memories with optional scope and tier filters.
- **`/remember`**: interactive save. Usage: `/remember [agent|user|project] [profile|log|note] <content>`. Omitted options default to `project` and `profile`.
- **`/memory`**: browse, search, filter, copy, and delete memories. Use `--scope agent` and `--tier note` with ordinary search text, or cycle scope with Tab and tier with Shift+Tab in the overlay. Press Ctrl+L to clear scope and tier filters without clearing the search text.

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

Topic Markdown and indexes are written in the `0.3.3`-compatible `@entry` format. Tier metadata is stored in a versioned adjacent `<topic>.memory-layer-tiers.json` sidecar, so a `0.3.3` writer can read and rewrite topic files without erasing memories. Existing `0.4.0` v2 markers, old `@entry` markers, and indexes remain readable. The current reader restores sidecar tiers after an old `0.4.0` writer rewrites a topic as v2. Legacy entries without sidecar metadata default to `profile`, and metadata-looking text in a memory body stays ordinary text.

Do not mix an already-running `0.4.0` writer with a `0.3.3` writer: the former can write v2 markers that the latter does not recognize, so a following `0.3.3` save can overwrite those entries. Stop or reload all old `0.4.0` runtimes before allowing a `0.3.3` writer to access the same storage. Session-scoped `agent` memories use Pi session custom entries, rather than the persistent directory. Forgetting an agent memory appends a tombstone to session history, so it stays logically deleted after reopening the session.

When `PI_CODING_AGENT_DIR` is set to a custom path, persistent memories are isolated under `$PI_CODING_AGENT_DIR/memory/`. An explicit normalized default path such as `~/.pi/agent` still uses the existing `~/.pi/memory/` storage. Changing a custom path does not migrate data; copy or migrate the directory explicitly if that is intended.

## Project ID resolution

Project identity resolves automatically:

1. `git remote origin` URL, normalized to a slug
2. Root commit hash
3. CWD path hash

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-memory-layer
```
