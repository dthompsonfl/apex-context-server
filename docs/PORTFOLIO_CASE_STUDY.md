# Engineering case study: Apex Context Server

## Problem
Code assistants need reliable answers about file locations, exported symbols, importers and nearby context. Repeated broad search can cost time and produce incomplete context. A useful navigation tool must also avoid stale results, arbitrary filesystem reads and destructive editor configuration changes.

## Technical solution
Implemented a local TypeScript ESM Model Context Protocol server with **15 real public tools**, AST-backed JS/TS symbol lookup, import/dependency relationships, Next.js route discovery, ranked text retrieval and persisted source context. Added canonical workspace containment, synthetic-secret redaction, response/regex/file budgets, atomic JSON persistence and live-content reconciliation.

Chose local stdio and JSON storage over an unnecessary hosted service or embeddings. Preserved existing MCP public tool names. Implemented an optional project-first OpenCode installer with reversible owned assets, and a warning-only default search guard.

## Independent proof
The repo contains an SDK-driven real MCP client test, security and installer regression suites, a synthetic npm workspace fixture, a runnable no-global-config demo, a benchmark script and a Node 20/22 CI matrix. See [Verification](VERIFICATION.md) for the exact matching GitHub Actions run. These proofs concern behavior of the program, not user adoption.

Review files: `src/index.ts`, `src/indexer.ts`, `src/ast.ts`, `src/safety.ts`, `src/mcp.integration.test.ts`, `src/security.test.ts`, `src/installer.test.ts`, `scripts/demo.mjs` and `.github/workflows/ci.yml`.

## Resume-ready descriptions (after checking current CI)

- Engineered a local TypeScript MCP server exposing 15 AST-aware code search, navigation and context-retrieval tools for Next.js-style workspaces.
- Built persistent workspace indexing and import/dependency lookup with source containment, redaction, output budgets and atomic cache updates.
- Added live stdio MCP integration tests, safe installation/reversal tests and a reproducible recruiter demo and benchmark workflow.

Do not claim external customers, business revenue, productivity improvements, benchmark speedups, full language-server equivalence or tested OpenCode CLI interoperability without independent evidence.

## Next evidence to collect
Test a specific supported OpenCode CLI version end to end, perform broader workload/secret-format testing and compare paired coding tasks with and without Apex. These are **not completed features or verified outcomes**.
