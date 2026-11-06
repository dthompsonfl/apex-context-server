# Architecture

## Overview
Apex Context Server is a **local-first TypeScript/Node.js ESM** MCP server using **stdio** transport. It indexes an authorized workspace, builds a persistent per-root memory index, and exposes MCP tools for discovery, symbol lookup, AST context extraction, topology, diagnostics, and workspace freshness.

## Key modules
- `src/index.ts` — MCP server registration/dispatch for all 15 tools; input validation, response truncation, and redaction at the tool boundary.
- `src/indexer.ts` — workspace discovery (fast-glob), file manifest/fingerprints, symbol/line/token indexes, import graph extraction, tsconfig alias parsing (JSONC/best-effort extends), search/locate/find APIs, freshness validation, per-root build locking, atomic cache persistence, and diagnostics.
- `src/ast.ts` — `ts-morph`-based extraction of an exported symbol plus local/imported type dependencies; enforces authorized-root file access and redacts output.
- `src/context.ts` — agent boot context and edit-ready context bundles (target resolution, exports/imports/importers, nearby source, related tests/docs, package metadata).
- `src/topology.ts` — workspace package manifest discovery and internal dependency graph (`apps/*`, `packages/*`, workspaces/pnpm patterns).
- `src/watcher.ts` — workspace watcher (chokidar with `fs.watch` fallback), change recording, debounced refresh, and status reporting.
- `src/dashboard.ts` — TUI/dashboard text combining topology, index health, diagnostics, watcher state, and guard telemetry (guard state is evidence-based; missing telemetry is reported).
- `src/paths.ts` / `src/redact.ts` — shared path normalization, root hashing/config paths, authorized file resolution, sensitive-path classification, bounds, and redaction.
- `scripts/*` — installer/uninstaller, `smoke:mcp` (real MCP client), `demo` (real MCP client), `bench` (micro-benchmark).
- `opencode/*` — commands and guard plugin (default warn mode).

## Data flow
1. MCP client calls a tool over stdio (`index.ts`).
2. Index-backed tools call `buildWorkspaceIndex`/query APIs (`indexer.ts`) for the resolved authorized root.
3. Index is loaded from cache only after freshness validation (manifest, file set, content hashes on mtime/size changes, git snapshot when available); stale/corrupt/incompatible caches trigger rebuild.
4. Search/locate results are assembled from in-memory token/posting maps; context/AST tools read source and apply root authorization + redaction.
5. Watcher/guard can mark memory stale; the next lookup rebuilds as needed.

## Persistence
- Cache: `${APEX_CONTEXT_CONFIG_DIR|OPENCODE_CONFIG_DIR}/apex-context-index/<rootHash>.json` (schema-versioned, atomic write).
- Usage/watcher/guard state: `apex-context-usage.json` (best-effort atomic updates).
- `refresh_changed_files` performs a freshness-aware rebuild and reports changed/added/deleted files from the manifest diff; it does not claim fine-grained incremental parsing.

## Decisions & tradeoffs
- **Local stdio MCP** preserves simple deployment and avoids hosted dependencies.
- **Freshness-first loading** prevents stale answers after external edits/branch changes at the cost of validation work.
- **Heuristic redaction and bounded outputs** reduce accidental leakage/risk but are not perfect.
- **ts-morph AST** provides practical symbol/type context for TS/JS without claiming full semantic type-checker correctness across all project configurations.
