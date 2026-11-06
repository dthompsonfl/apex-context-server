# Verification

## Environment (this run)
- Date: 2026-11-06
- OS/Arch: Linux x64
- Node: `v24.22.1`
- npm: `11.19.1`
- Repo: `/workspace/app` (`dthompsonfl/apex-context-server`)

## Baseline (before changes)
Commands run from repo root:
- `npm ci --ignore-scripts --no-fund` — PASS
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (2 tests discovered via `dist/*.test.js`)
- `npm audit --audit-level=high` — reported **3 moderate** vulnerabilities (minimatch chain via ts-morph); no high/critical shown.

## Final verification (after implementation)
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm test` — PASS (**7/7**): existing indexer tests + MCP real-client integration, freshness, security boundaries, installer.
- `npm run test:integration` — PASS (real MCP stdio client lists/calls all 15 tools; freshness after external change without restart).
- `npm run test:security` — PASS (authorized-root rejection for AST/bundle path; `.env` excluded from index; synthetic secret absent from search output and persisted index).
- `npm run test:installer` — PASS (isolated config: dry-run/apply, unrelated config preserved, managed manifest, uninstall removes managed Apex entries).
- `npm run smoke:mcp` — PASS (`smoke:mcp PASS (15 tools, hello symbol found)`).
- `npm run demo` — PASS (real MCP client; freshness without restart; redaction + outside-root protection; `DEMO PASS`).
- `npm run bench` — PASS (synthetic micro-benchmark JSON emitted; not a productivity claim).
- `npm audit --audit-level=high` — **3 moderate** transitive vulnerabilities remain (minimatch via `ts-morph`); **no high/critical** findings reported at `--audit-level=high`. Upstream fix requires a breaking `ts-morph` major change not applied.
- `npm pack --dry-run` — PASS (package contents include `dist/`, `opencode/`, `scripts/`, `docs/`, `README.md`).

## Final-SHA CI evidence
- Feature branch: `apex/harden-and-complete` (local). Final commit SHA: **recorded in git log after commit**.
- GitHub Actions run for final SHA: **not executed in this environment** (no push performed). After pushing/opening a PR, confirm the final-SHA Actions run is green and attach its URL.

## Supported/tested matrix (evidence-based)
- **Node:** locally verified on Node 24.x; CI workflow configured for Node 20 and 22.
- **OpenCode:** installer/guard/plugin behavior tested in **isolated temporary config directories** and dry-run only. A real supported OpenCode client invocation was **not executed** here — **implemented but unverified** for specific OpenCode versions.
