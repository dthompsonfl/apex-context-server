# Engineering case study: Apex Context Server

## The engineering problem

Coding agents need dependable answers about the locations and relationships of symbols, imports, routes and nearby types before editing source. A search result is not useful when its cache is stale, its client cannot call it, its output discloses unrelated sensitive files, or its installer damages a developer's configuration.

## Implemented architecture

Apex is a local TypeScript ESM MCP stdio server with **15 public tools**, AST-based JS/TS symbol extraction, Next.js route discovery, import/importer maps, ranked line search, bounded edit-ready context bundles and local JSON indexing. This is a real tool, not a hosted assistant or demonstration mock.

The hardening work includes canonical workspace authorization, no-follow descriptor-based source parsing, authorized local tsconfig inheritance, multi-line secret filtering, query/regex/line/file/aggregate-size limits, per-root cache reconciliation, private synced atomic persistence, SIGKILL cache recovery, watcher readiness and degraded polling, and an owned reversible OpenCode installer with a durable transaction journal.

## Evidence an interviewer can reproduce

- `npm ci --ignore-scripts --no-fund && npm run build && npm run demo`: real MCP SDK client/server, tool discovery, code lookup and context, external file edit, redaction and root-boundary refusal.
- `npm run smoke:package`: build an npm tarball, install it without the repository's development dependencies and invoke its installed binary through MCP.
- `npm test`: indexing, configuration, security, root boundaries, cache crash/restart, watcher degradation, Git changes and installation recovery.
- The dedicated OpenCode CI job uses **real `opencode-ai@1.19.5`** and validates two actual MCP calls through the agent. The deterministic local model stub selects calls but **does not simulate MCP outputs**.
- `npm run bench`: a reproducible, small synthetic benchmark with transparent methods. No comparative improvement is claimed.

Core technical files include `src/index.ts`, `src/indexer.ts`, `src/ast.ts`, `src/safety.ts`, `src/atomic-cache.ts`, `src/watcher.ts`, `scripts/opencode-transaction.mjs`, `src/mcp.integration.test.ts`, `src/cache-recovery.test.ts`, `src/installer.test.ts` and `scripts/package-smoke.mjs`. The [verification ledger](VERIFICATION.md) links actual CI evidence.

## Design decisions and scope

Local stdio avoids hosting and multi-tenant auth. JSON persistence keeps retrieval inspectable. Reconciliation/full rebuild is prioritized over speculative incremental postings. Unverified OpenCode V2 integration is *explicitly refused* by setup until the client's MCP registration defects are resolved and tested. No GUI, Docker, vector index, cloud service or package publication was added.

## Copy-ready portfolio/resume statements

- Engineered a TypeScript Model Context Protocol server exposing 15 AST-aware code navigation, dependency mapping and source-context tools for Next.js-style repositories.
- Hardened local repository retrieval with workspace-root authorization, source redaction, bounded indexing, atomic persistence and crash-recovery regression tests.
- Developed real-client MCP and OpenCode V1 integration tests, reversible installation tooling and reproducible clean-package demonstrations for independent technical review.

**Claims not supported:** production customers, third-party adoption, reduced agent token usage, superior speed over `rg`, full security certification or OpenCode V2 compatibility. Verify the final commit's GitHub Actions checks before describing that revision as green.
