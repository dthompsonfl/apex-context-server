# Verification and evidence ledger

**Starting main:** `993d3b684a6bc2efba90ebf0c2fd1137fa2711cc` (November 6, 2026 review). Original [Actions run 41548089176](https://github.com/dthompsonfl/apex-context-server/actions/runs/41548089176) verified build/typecheck and the original two tests, not the new implementation.

**Expanded evidence:** [Actions run 42267333715](https://github.com/dthompsonfl/apex-context-server/actions/runs/42267333715) on `60c22d2fbd8042288d405d517983be74e539a419` passed `verify (20)`, `verify (22)` and `dependency-audit`. Jobs ran locked npm installation, TypeScript check, build, all tests, real MCP client integration, security tests, isolated OpenCode installer/uninstaller tests, MCP smoke, deterministic live demo, benchmark and `npm pack --dry-run`. Console output included `DEMO PASSED`.

This is historical evidence for that exact SHA, **not evidence of later commits**. The final commit must have its own passing CI checks before readiness is claimed. A separate [Dependabot job](https://github.com/dthompsonfl/apex-context-server/actions/runs/42267361674) failed at the same revision; it is not one of the three Build and Test jobs and needs separate investigation.

## Required verification commands

```bash
npm ci --ignore-scripts --no-fund
npm run typecheck
npm run build
npm test
npm run test:integration
npm run test:security
npm run test:installer
npm run test:guard
npm run smoke:mcp
npm run demo
npm run bench
npm audit --audit-level=high
npm pack --dry-run
```

Evidence is defined by the exact running SHA and job conclusion. `src/mcp.integration.test.ts` uses a real SDK `Client` and `StdioClientTransport`, not a fake handshake. `src/security.test.ts` uses synthetic data; `src/installer.test.ts` operates only in temporary directories. `scripts/demo.mjs` exercises live file edits over one connected client. Benchmarks are reported separately in [BENCHMARKS.md](BENCHMARKS.md).

## Limitations

The local isolated container could not resolve github.com and did not run npm dependencies; GitHub-hosted CI provided the actual Node execution. A real OpenCode CLI compatibility test has not been demonstrated in the available environment. This is an **external client integration verification gap**, not a reason to represent the successful SDK handshake as fictional. No merged PR, npm publication, new release, or production adoption is claimed.
