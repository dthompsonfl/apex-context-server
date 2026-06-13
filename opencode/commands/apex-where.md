---
description: Ask Apex memory where something lives
---

Use Apex workspace memory to locate this target:

$ARGUMENTS

Steps:

1. Call `apex-context_locate_code` with `$ARGUMENTS`.
2. If the best match is actionable, call `apex-context_read_context_bundle`.
3. Answer with the likely files, symbols, and why Apex ranked them there.
