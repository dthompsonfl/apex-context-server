# Architecture

Apex is a single-package TypeScript ESM MCP server that analyzes other application repositories, including Next.js/Turborepo-style workspaces.

## Request lifecycle

1. `src/index.ts` initializes an MCP stdio server with 15 stable tool definitions and dispatches calls.
2. `src/safety.ts` binds caller-selected roots to the canonical launch workspace, checks source paths against symlink/traversal escapes and provides redaction/size limits.
3. `src/indexer.ts` discovers allowed files with fast-glob, extracts TS/JS declarations/imports via ts-morph, builds ranked token postings and import/importer maps, and stores redacted searchable lines plus fingerprints in local JSON.
4. `src/context.ts` constructs an agent boot brief and edit-ready bundles; `src/ast.ts` follows exported declarations and related types; `src/topology.ts` maps workspace package dependencies.
5. `src/watcher.ts` optionally observes changes; `src/dashboard.ts` renders plain-text diagnostics, not a GUI.

The indexer reconciles live file contents, including changes outside an editor and unchanged sizes/mtimes, when a cached index is used. Per-root single-flight coordination avoids simultaneous duplicate indexing. The JSON index is written to a private temporary file, synced and atomically renamed; a killed writer leaves the previous snapshot intact. The changed-file refresh currently does a **full rebuild**, correctly reported as such. Full reconciliation costs additional IO on large projects and is intentionally measured rather than marketed as instant.

TypeScript-aware tsconfig parsing supports comments and inherited aliases after rejecting any extends chain outside the authorized workspace, while pragmatic import resolution covers common relative, package and `@/*` references. It is not a complete language-server replacement or full conditional-exports resolver.

## Installation and trust

The MCP process has the caller's local OS permissions. Root containment protects MCP-exposed reads, not other tools installed on the machine. The OpenCode adapter is optional and version-specific: V1.19.5 has proven real CLI invocation; V2 is not supported until its MCP catalog works reliably. `scripts/jsonc-edit.mjs` changes only the Apex config property while retaining unrelated JSONC, and installer/uninstaller manifests plus a persistent crash-recovery journal restrict owned-file changes. Watcher failures degrade to a polling-backed reconciler.

## Decisions

- Local stdio, not hosted HTTP/cloud accounts: fewer services and no remote authentication.
- TypeScript/AST indexing and JSON persistence, not vectors: inspectable results and simple offline operation.
- Correct full refresh, not speculative incremental mutations: smaller invalidation surface.
- Redaction/exclusions and bounded output: source is potentially sensitive.
- Guard warnings by default: heuristic shell-search blocking must not sabotage legitimate development.

See [Security](SECURITY.md) for the residual limitations.
