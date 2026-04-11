# @ryan_nookpi/pi-extension-todo-write

This extension lets pi manage a structured task list during a coding session.

It helps break larger requests into clear steps and keeps progress visible while work is in progress.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-todo-write
```

## Great for

- multi-step implementation or debugging work
- showing the user what pi is doing right now
- reorganizing the plan when requirements change mid-task

## Example prompts

- "Create a task list and work through it step by step."
- "Break this job into phases and track progress."
- "Keep track of testing, fixing, and verification as separate tasks."

## Notes

- It uses the `todo_write` tool to create and update tasks.
- It is designed so that only one task stays `in_progress` at a time.
- It preserves task state so work can continue cleanly after session compaction.
