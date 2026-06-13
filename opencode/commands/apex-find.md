---
description: Find code through Apex symbol and text search
---

Find the requested code using Apex Context Server, not broad shell search.

1. Call `apex-context_locate_code` with `$ARGUMENTS`.
2. If a likely target is found, call `apex-context_read_context_bundle` for the best candidate before answering or editing.
3. If memory lookup is insufficient, call `apex-context_find_symbol`, then `apex-context_search_code` for exact text.
4. Report the shortest useful result set and the next best file or symbol to inspect.

Search target:

$ARGUMENTS
