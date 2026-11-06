# Security

## Threat model (local MCP server)
Apex Context Server is a local, stdio MCP process intended to index and serve context for an **authorized workspace root**. Primary risks:
- **Unauthorized file read / path traversal / symlink escape**: a caller could request `read_component_context` or a context bundle for files outside the workspace.
- **Sensitive data exposure**: indexed source lines, context bundles, diagnostics, or persisted cache could contain secrets/tokens/credentials from synthetic or real files.
- **Cache/state leakage**: persisted index and usage state may contain derived content; insecure permissions or unsafe writes can increase exposure/race risk.
- **Resource exhaustion**: large files, huge queries/globs/regex, or oversized responses can degrade the host process.
- **Installer misconfiguration**: setup/uninstall could overwrite unrelated OpenCode configuration or leave unsafe state.

## Controls implemented
- **Authorized workspace boundaries**: `resolveAuthorizedFile` (realpath + containment) enforces that direct file reads (`read_component_context`) remain within the authorized root; `read_context_bundle` rejects `filepath` outside root. Glob/file discovery uses `followSymbolicLinks: false` and ignores sensitive patterns.
- **Sensitive file exclusions**: indexing ignores common secret-bearing files (`.env*` except examples, keys, credential files, lockfiles where appropriate) and skips paths classified as sensitive.
- **Redaction**: best-effort redaction is applied to indexed source lines, tool responses, and AST/context bundle output for common patterns (private key blocks, AWS keys, GitHub tokens, bearer/auth headers, assignment-style secrets, URL credentials). Diagnostics record redaction events. **Limitation:** pattern-based detection cannot guarantee all secrets are detected and may miss novel formats or produce false positives.
- **Bounded resources**: query/glob length limits, max indexed file size, capped result counts, and tool-response truncation.
- **Safe persistence**: cache/usage state writes use atomic temp+rename and restrictive permissions (best-effort `0600`/`0700`). Corrupt/incompatible/stale persisted indexes are not trusted.
- **Installer safety**: setup supports `--dry-run`, targets isolated config dirs via `APEX_CONTEXT_CONFIG_DIR`/`OPENCODE_CONFIG_DIR`, preserves unrelated config entries, writes an ownership manifest, and uninstall removes only managed Apex entries/files.

## Residual risks / limitations
- Redaction is heuristic and not a substitute for secret hygiene.
- MCP clients control invocation; Apex relies on correct root scoping and local-process trust boundaries.
- Some module-resolution/import cases (complex tsconfig extends/package exports conditions) are handled on a best-effort basis and may be reported as unresolved.
- Guard/OpenCode integration behavior depends on the host OpenCode version/contract; not all external client environments are verified here.
