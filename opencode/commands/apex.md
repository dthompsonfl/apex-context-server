---
description: Prime the Apex context dashboard before working
---

Use Apex Context Server as the context system for this task.

1. Call `apex-context_prime_workspace_context` for the current workspace. Use `force: true` if this is the first Apex call in the session or files were recently changed.
2. Call `apex-context_get_agent_boot_context` when starting meaningful repo work.
3. Show the returned dashboard summary in the TUI response.
4. For unknown locations, call `apex-context_locate_code` first. Treat it as the workspace memory.
5. Before editing or explaining a target, call `apex-context_read_context_bundle`.
6. For exact text search, use `apex-context_search_code`.
7. For exported symbols, use `apex-context_find_symbol`.
8. Avoid broad raw shell search commands. Use shell only for targeted verification after Apex narrows the files or commands.

Task:

$ARGUMENTS
