# Verification and release evidence

Apex Context Server is tested as a local, single-process TypeScript MCP product. This record separates **executed tests**, **supported product compatibility**, and **limitations**. Check [the latest main-branch CI run](https://github.com/dthompsonfl/apex-context-server/actions/workflows/ci.yml?query=branch%3Amain) for the exact revision under review. CI success on an earlier commit does not validate later edits.

## Proven historical milestones

- Baseline SHA `993d3b684a6bc2efba90ebf0c2fd1137fa2711cc`, [run 41548089176](https://github.com/dthompsonfl/apex-context-server/actions/runs/41548089176): original two fixture tests, Node build/typecheck and dependency audit.
- [Run 42278374317](https://github.com/dthompsonfl/apex-context-server/actions/runs/42278374317), an intermediate hardening SHA: Node 20 and 22 passed 23 full-suite tests, the MCP demo and a **clean tarball installation invoking its installed binary**, with `PACKAGE_SMOKE_PASS`. That run's experimental V2 client job failed and was not treated as a supported product result.
- [Run 42279198615](https://github.com/dthompsonfl/apex-context-server/actions/runs/42279198615), another intermediate SHA: real `opencode-ai@1.19.5` client connected and executed `locate_code` and `read_context_bundle` through the actual agent-tool pipeline, producing `OPENCODE_CLIENT_SMOKE_PASS`.
- The release CI scope is now deliberately **Node 20/22 + a real pinned OpenCode V1.19.5 client**. The unverified V2 adapter is rejected by the installer, rather than being represented as working.

## Former blocked acceptance gates

| Gate | Observable evidence and source | Release scope |
|---|---|---|
| AC-05 Cache integrity and restart recovery | `src/cache-recovery.test.ts` forces failed pre-rename writes, SIGKILL of a child writer, orphan cleanup and corrupt-index restart; `src/usage-state.test.ts` checks concurrent updates | Automated on supported Node versions |
| AC-08 Watcher failure recovery and shutdown | `src/watcher.test.ts` injects startup/async failures, degraded polling, reconciliation errors, timers, stop/restart; optional watcher not required for query freshness | Automated |
| AC-10 Resource safety | `src/resources.test.ts` checks aggregate byte/line budgets, output limits and adversarial regex against a 220-file fixture | Automated; not an OS-wide CPU/memory sandbox |
| AC-11 Install and uninstall reversal | `src/installer.test.ts` runs real setup/uninstall in fake homes, JSONC preservation, conflicts, V1 scope, SIGKILL and recovery journal; V2 explicitly refused | Automated |
| AC-12 Supported OpenCode invocation | `scripts/opencode-client-smoke.mjs` drives actual pinned OpenCode V1.19.5 and verifies both MCP tool results with a deterministic local model endpoint | V1 supported; V2 **unsupported** |
| AC-14 Package installation | `scripts/package-smoke.mjs` packs the built artifact, installs into an empty npm prefix, checks executable, then invokes it with a real MCP client | Automated on Node 20/22 |
| AC-16 Defined security release gate | Path traversal, realpath/symlink escape, synthetic secret filtering, aggregate limits, authorized config inheritance, tool-error boundaries and installer ownership checks have test coverage | Scoped assurance only; see SECURITY.md for residual risk |

## Exact commands required on the final SHA

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
npm run smoke:package
```

The separate OpenCode job pins `opencode-ai@1.19.5` in an isolated runner directory, sets `OPENCODE_BIN`, and calls `npm run smoke:opencode -- --client v1`. The model stub does not return fabricated MCP tool responses. The core MCP client integration uses real SDK Client and StdioClientTransport and exercises all 15 tool names. The installer tests mutate only temporary directories.

## Limits and honesty contract

No local build is claimed for the isolated assistant container (GitHub dependency DNS was inaccessible). GitHub Actions supplies actual Node execution and logs. Regex restrictions and best-effort credential redaction are not a DLP guarantee. The watcher polling fallback is not an immediate event source. Some external/package-based TypeScript `extends` references are refused for source-boundary safety. The benchmark uses a synthetic fixture, not production workloads. **OpenCode V2 is not supported**, even though its early configuration/diagnostic harness remains for future investigation. No npm publication, release tag, external deployment or measured agent productivity improvement is asserted.
