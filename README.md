# Apex Context Server

Apex is a local **TypeScript Model Context Protocol (MCP) server** that gives coding agents AST-aware search, symbol lookup, import/dependency context, Next.js route discovery and persistent workspace memory. It runs over stdio with no hosted service, embedding model or API key.

## Start with the reproducible demo

Requires Node 20 or 22 and npm.

```bash
git clone https://github.com/dthompsonfl/apex-context-server.git
cd apex-context-server
npm ci --ignore-scripts --no-fund
npm run build
npm run demo
```

The demo launches a **real SDK MCP client and server over stdio**, lists 15 tools, indexes an isolated copy of `examples/demo-workspace`, locates a symbol and Next.js route, reads a context bundle, creates a new file outside the server process and finds it on the same connection, checks synthetic secret redaction, and rejects an outside-root read. Assertions fail loudly. It does not change global OpenCode configuration.

## Features

- 15 stable MCP tools for discovery, memory, health, watcher, refresh, search, symbols, topology and context
- JS/TS AST declarations, static/dynamic imports, CommonJS require and imports/importers
- Common monorepo aliases, JSONC and locally authorized tsconfig inheritance, route recognition and workspace packages
- Local JSON cache with file-content reconciliation, single-flight builds and atomic persistence
- Workspace-root containment, symlink defense, secret exclusions/redaction and resource limits
- Opt-in project-first OpenCode V1 installer with dry-run, persistent rollback journal, ownership manifest, JSONC-aware edits and safe uninstall

**Recommended flow:** `locate_code` → `read_context_bundle` → targeted file verification. For a known exported declaration use `read_component_context`.

## Direct MCP launch

```bash
APEX_CONTEXT_ROOT=/absolute/workspace/path npm start
```

The server speaks MCP over stdout, not an interactive shell prompt. It defaults to its process CWD when `APEX_CONTEXT_ROOT` is absent. Explicit tool roots may narrow the authorized workspace, never escape it. `OPENCODE_CONFIG_DIR` specifies cache/telemetry storage; otherwise use `~/.config/opencode`. Configure any supported MCP client to spawn `node /absolute/path/to/dist/index.js`.

The official MCP Inspector CLI can independently inspect tool metadata after build:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

The Inspector binary is optional. **OpenCode V1.19.5 is the only supported and real-client-tested OpenCode adapter.** Its CI job installs the pinned real CLI, connects to Apex and invokes `locate_code` and `read_context_bundle` through the agent using a deterministic local model stub. OpenCode V2 is deliberately unsupported because released V2 versions can connect to MCP without registering its tools for agents.

## Opt-in OpenCode setup

Project scope is the default and targets `APEX_CONTEXT_PROJECT_DIR` or the current directory.

```bash
npm run setup:opencode -- --scope project --dry-run
npm run setup:opencode -- --scope project
npm run uninstall:opencode -- --scope project
# For an interrupted transaction:
npm run setup:opencode -- --scope project --recover
```

Use `APEX_CONTEXT_PROJECT_DIR=/path/to/another/project` to target another project. `--scope user` explicitly operates in your OpenCode user config. Review its dry-run first. The installed raw-search guard **warns by default**; set `APEX_CONTEXT_GUARD_MODE=strict` to make it block heuristic broad searches. This is workflow policy, not filesystem security.

## Tests and reproducible measurements

```bash
npm run typecheck && npm run build
npm test
npm run test:unit
npm run test:integration
npm run test:security
npm run test:installer
npm run test:guard
npm run smoke:mcp
npm run demo
npm run bench
npm audit --audit-level=high
npm pack --dry-run
npm run smoke:package # isolated tarball installation and executable test
```

CI executes the verification matrix on Node 20 and 22. Only the CI run matching the current commit proves that commit's status.

Resource budgets: 1 MiB per file, 30,000 discovered files, 64 MiB total source, 250,000 indexed lines, 2,048 characters per line, 256-character query and 60,000-character response. Complex regex forms are restricted. Content freshness checks intentionally prioritize correctness over large-repo speed. Redaction is best-effort and **not a guarantee that all secrets are detected**.

## Further reading

- [Architecture](docs/ARCHITECTURE.md)
- [Security and limitations](docs/SECURITY.md)
- [Live demo](docs/DEMO.md)
- [Verification ledger](docs/VERIFICATION.md)
- [Benchmarks](docs/BENCHMARKS.md)
- [Portfolio case study](docs/PORTFOLIO_CASE_STUDY.md)

Troubleshooting: rebuild `dist` if missing; rerun `npm ci` for missing dependencies; for a corrupt cache, stop the server and remove only the matching JSON in `apex-context-index`. When watcher monitoring is unavailable, the next retrieval still reconciles the filesystem. Installation conflicts should be resolved by reviewing owned-path manifests, not deleting unrelated config.

**License:** None has been granted. Public visibility is not a general reuse license.
