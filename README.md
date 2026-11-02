# Apex Context Server

Apex Context Server is a local Model Context Protocol (MCP) server for OpenCode. It gives coding agents AST-aware tools for searching, indexing, mapping, and reading code in large Next.js and Turborepo workspaces.

**Verification:** [Build, typecheck, fixture tests, and dependency audit passed in GitHub Actions](https://github.com/dthompsonfl/apex-context-server/actions/runs/41545493391) on Node.js 20 and 22 (November 2, 2026). The repository does not yet contain a checked-in `package-lock.json`; installations are not fully locked or independently benchmarked.

To validate the source locally, run `npm install`, `npm run typecheck`, `npm run build`, then `npm test`. The `setup:opencode` script edits user-level OpenCode settings; run it only after reviewing the effect.

## Install

From the repository root:

```bash
npm install
npm run build
npm run setup:opencode
```

Those commands install dependencies, build the TypeScript server, copy the runnable server into `~/.config/opencode/apex-context-server`, and update `~/.config/opencode/opencode.json` so OpenCode starts it as the `apex-context` MCP server.

The installer also writes `~/.config/opencode/apex-context-instructions.md` and adds it to OpenCode's global instructions. This makes Apex the preferred system for code search and context retrieval while leaving existing OpenCode settings intact.

## TUI System

Apex installs three OpenCode TUI surfaces:

- Global slash commands:
  - `/apex`: primes the visual Apex dashboard and then proceeds with the task.
  - `/apex-boot`: loads the compact agent boot context.
  - `/apex-find`: locates code through Apex memory, symbol lookup, and exact code search instead of broad shell commands.
  - `/apex-status`: shows index health and raw-search guard telemetry.
  - `/apex-where`: asks Apex memory where something lives.
  - `/apex-refresh`: rebuilds persistent Apex memory after edits or branch changes.
- A guard plugin at `~/.config/opencode/plugins/apex-context-guard.js` that blocks broad raw CLI discovery commands such as `rg`, recursive `grep`, `find .`, `fd`, `tree`, and `ls -R`.
- A persistent telemetry file at `~/.config/opencode/apex-context-usage.json`, surfaced by the dashboard, so the TUI can show whether Apex tools are being used and whether broad shell search was blocked.

If raw shell search is truly necessary, prefix the command with `APEX_CONTEXT_ALLOW_RAW_SEARCH=1`. To run the guard in warning-only mode, start OpenCode with `APEX_CONTEXT_GUARD_MODE=warn`.

## Workspace Memory

Apex builds a durable workspace memory file under `~/.config/opencode/apex-context-index/`. The memory contains:

- file paths, basenames, languages, sizes, imports, and importers
- exported symbols and top-level local declarations with file, line, column, and declaration kind
- static imports, re-exports, dynamic imports, and CommonJS `require` edges
- relative imports, workspace package imports, and common `tsconfig`/Next.js app aliases such as `@/*`
- per-file size, mtime, and SHA-256 content fingerprints
- Next.js route, layout, page, loading, error, and route-handler files
- searchable source lines
- token maps for instant lookup across symbols, paths, imports, and content
- diagnostics for skipped files, parse failures, alias misses, large files, and redactions

Once built, future lookups load this memory instead of walking the repository. Agents should call `locate_code` first for any "where is this?" question, then use `read_component_context` once a concrete symbol is identified.

The OpenCode guard plugin marks memory stale when files change. The next Apex lookup automatically rebuilds the persisted memory before answering, then clears the stale flag.

Secret-like values are redacted before source lines are written to memory. `.env`, private keys, and lockfiles are ignored.

## Tools

- `prime_workspace_context`: renders the Apex TUI dashboard with topology, index status, guard telemetry, and the low-token search workflow.
- `get_agent_boot_context`: returns a compact always-fresh repo brief for agents.
- `get_context_health`: shows a compact dashboard for index and guard status.
- `get_workspace_memory`: returns the persistent memory map summary and cache location.
- `refresh_workspace_memory`: force-rebuilds and persists the workspace memory.
- `watch_workspace_memory`: starts or reports the live watcher.
- `refresh_changed_files`: refreshes memory after changed/deleted/added files are detected.
- `get_index_diagnostics`: reports skipped files, parse failures, redactions, alias misses, and watcher status.
- `locate_code`: instantly locates likely files, symbols, routes, imports, and source lines from memory.
- `read_context_bundle`: returns edit-ready context for a file, symbol, route, or query.
- `get_workspace_topology`: scans `apps/*` and `packages/*` package manifests and returns a workspace dependency graph.
- `index_workspace`: loads or builds the persistent AST-backed workspace memory.
- `search_code`: searches memory-indexed source lines with plain text or regular expressions.
- `find_symbol`: finds exported and top-level local symbols discovered by the indexer.
- `read_component_context`: returns an exported symbol and the local or imported type definitions it depends on.

## Manual Start

```bash
npm run build
npm start
```

The MCP server communicates over stdio and is normally launched by OpenCode.
