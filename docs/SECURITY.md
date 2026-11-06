# Security and threat model

Apex runs locally under the user's OS identity. There are no remote sockets or tenant isolation, and any allowed MCP client can receive returned source context. **Never treat local execution as complete data-loss prevention.**

## Root and file policy

The process startup CWD or explicit `APEX_CONTEXT_ROOT` defines the authorized workspace. Request roots cannot escape it. Direct AST reads use realpath containment, reject symlink escapes, exclude common sensitive names/extensions and reject oversized files. The indexer filters generated directories, dependency caches, private-key formats, `.env*`, credentials/secret-named paths and inaccessible sources.

The index is persisted under `OPENCODE_CONFIG_DIR/apex-context-index` or the user's OpenCode config location, with restricted initial permissions and atomic writes. Existing filesystem ACLs, same-user processes and imperfect secret detection remain threats.

Indexed source lines and AST/context responses receive a best-effort secret-redaction pass. Multiline private-key envelopes, common credential assignments/JSON keys, bearer tokens and selected token prefixes are covered by synthetic regression tests. **This does not catch all secrets**, unusual encodings, generated strings or adversarial formats. Do not index real credentials you cannot afford to expose.

## Resource policy

Maximum 1 MiB per indexed source, 30,000 discovered files, 2,048 characters per indexed line, 256-character search queries and 60,000-character tool outputs. Hazardous regex constructs are rejected. These are application budgets, not OS memory/CPU quotas.

## Installer policy

Default scope is project. Setup is opt-in, has `--dry-run`, refuses unmanaged collisions and uses an ownership/hash manifest. Uninstall refuses changed assets or changed Apex config values rather than silently deleting users' edits. It preserves other MCP entries and unrelated JSONC comments. The raw-search guard defaults to warn; strict mode is explicitly selected and is a **workflow preference, not a security sandbox**.

## Residual risks

- Heuristic redaction can produce false positives and false negatives.
- Complex JSONC formatting/comment placement may need additional compatibility tests.
- Filesystem checks cannot prove all race conditions are eliminated.
- Watcher fallback is not recursively equivalent on all platforms; retrieval freshness uses reconciliation.
- Full content reconciliation may be costly on large workspaces.
- OpenCode CLI interoperability requires an actual supported-version smoke, beyond the passing SDK client test.

A demonstrated outside-root read, credential leak or destructive uninstall is a release stop condition. Reproduce with **synthetic** material and add a regression test.
