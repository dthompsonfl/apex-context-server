# Apex Context Server

Apex Context Server is a **local-first Model Context Protocol (MCP)** server (Node.js/TypeScript, stdio) that builds a persistent, AST-aware index of a workspace so MCP clients can locate symbols/routes/files, search source, inspect workspace topology, and retrieve edit-ready context without broad ad hoc shell scanning.

## Verified capabilities (evidence-based)
- **15 MCP tools** exposed over stdio (discovery, indexing, search/symbol/locate, AST component context, topology, diagnostics, watcher/refresh, boot/context bundles, dashboard/health). Verified by a real MCP SDK client in automated tests and `smoke:mcp`/`demo`.
- **Freshness after external changes**: index freshness validation detects external edits/manifest changes; demo/test confirm updated results without restarting the server.
- **Workspace boundary & sensitive-data controls**: direct file reads are constrained to the authorized root (path containment/realpath checks in AST context path), sensitive files (e.g., `.env`) are excluded from indexing, and best-effort redaction is applied to indexed/output text. *Limitation: heuristic redaction is not perfect.*
- **Safe installer workflows**: setup/uninstall support isolated config dirs, `--dry-run`, preserve unrelated OpenCode config, and use managed-manifest removal (verified in isolated temp configs). *Live OpenCode client compatibility is not verified in this environment.*
- **Local reproducible checks**: typecheck/build, tests (unit/integration/security/installer), `smoke:mcp`, `demo`, `bench`.

## Quickstart
```bash
npm ci --ignore-scripts --no-fund
npm run build
npm run smoke:mcp   # real MCP client + compiled stdio server
npm run demo       # reproducible end-to-end demo (isolated temp workspace)
```

Manual server start (normally launched by an MCP client):
```bash
npm start
```

## OpenCode setup (optional; review before running)
Targets the OpenCode config directory (`APEX_CONTEXT_CONFIG_DIR` / `OPENCODE_CONFIG_DIR`, default `~/.config/opencode`).
```bash
npm run setup:opencode -- --dry-run
npm run setup:opencode
npm run uninstall:opencode
```
The guard plugin defaults to **warn** mode for broad raw searches; set `APEX_CONTEXT_GUARD_MODE=strict` to block. Override a specific shell command only when necessary with `APEX_CONTEXT_ALLOW_RAW_SEARCH=1`.

## MCP tools (15)
`get_agent_boot_context`, `read_context_bundle`, `watch_workspace_memory`, `refresh_changed_files`, `get_index_diagnostics`, `prime_workspace_context`, `get_context_health`, `get_workspace_topology`, `get_workspace_memory`, `refresh_workspace_memory`, `locate_code`, `index_workspace`, `search_code`, `find_symbol`, `read_component_context`.

## Testing & verification
```bash
npm run typecheck
npm run build
npm test                  # all compiled tests
npm run test:integration  # real MCP stdio + freshness
npm run test:security
npm run test:installer
npm run smoke:mcp
npm run demo
npm run bench
npm audit --audit-level=high
npm pack --dry-run
```
See `docs/VERIFICATION.md`, `docs/DEMO.md`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/BENCHMARKS.md`.

## Limitations
- Secret detection is **best-effort** (pattern-based) and cannot guarantee complete coverage.
- TypeScript/alias/import resolution and AST dependency extraction are practical but not full semantic compiler guarantees for every configuration.
- Live OpenCode client integration was not executed in this environment; installer behavior is verified only in isolated configs.
- `npm audit --audit-level=high` currently reports **3 moderate** transitive vulnerabilities in the `ts-morph` dependency chain (no high/critical observed); fixing requires a breaking upstream change not applied here.
- Micro-benchmarks are synthetic and **not** productivity claims.

## License
No open-source license file is included in this repository snapshot; treat usage/redistribution as unspecified until an owner adds a license.
