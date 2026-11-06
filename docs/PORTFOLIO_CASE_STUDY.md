# Portfolio Case Study — Apex Context Server

## Problem
Coding agents working in large TypeScript/Next.js/Turborepo repositories need fast, structured, and safe code context (symbols, routes, imports, nearby source) over a standard protocol, without relying on slow ad hoc shell scanning or leaking sensitive file contents.

## What was implemented
- Hardened a local **MCP (stdio)** server exposing 15 tools for indexing, search, symbol lookup, AST component context, topology, diagnostics, watcher refresh, and context bundles.
- Added **authorized workspace boundary** enforcement and **best-effort secret redaction** across indexing and tool outputs.
- Improved **freshness, concurrency, and safe persistence** (cache validation, per-root locking, atomic writes, corruption/stale recovery behavior).
- Built **real MCP-client integration tests**, security/installer tests, a reproducible `demo` using the actual server/client, and a micro-benchmark script.
- Updated CI to run typecheck/build, all test suites, smoke/demo/bench, and packaging checks across Node versions; documented limitations honestly.

## Architecture decisions & tradeoffs
- **Local-first stdio MCP**: simple, inspectable integration; no hosted backend/vector DB.
- **Freshness-first cache**: validates persisted indexes before reuse to avoid stale answers after external edits/branch changes.
- **AST-assisted, not full semantic analysis**: `ts-morph` provides practical symbol/type context; complex TypeScript resolution remains best-effort and is reported via diagnostics.
- **Defense in depth with caveats**: path containment + redaction + bounds reduce risk, but heuristic redaction is not perfect.

## Constraints handled
- Preserve existing 15-tool public surface and local architecture.
- No global user config mutation in tests/demo (isolated temp config dirs).
- External file changes observed without restarting the MCP server (freshness test/demo).
- npm audit: 3 moderate transitive issues remain in the `ts-morph` chain; no high/critical gate failures under `--audit-level=high` (see verification).

## Evidence-backed resume bullets (accurate)
- Built and hardened a TypeScript/Node.js **Model Context Protocol (MCP)** stdio server with 15 tools for AST-aware code search, symbol/import context, and workspace indexing across TS/JS monorepo patterns.
- Implemented workspace-boundary enforcement, sensitive-file exclusion, and heuristic secret redaction with automated security tests; added freshness-safe caching (validation, per-root locking, atomic persistence) verified by real MCP-client integration tests.
- Delivered reproducible engineering workflows: real-client `smoke:mcp`/demo, installer safety checks in isolated configs, micro-benchmarks, and CI matrix validation (Node 20/22) covering integration, security, and packaging.
