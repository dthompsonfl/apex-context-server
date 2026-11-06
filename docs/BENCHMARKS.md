# Reproducible benchmark

Run `npm ci --ignore-scripts --no-fund && npm run build && npm run bench`.

The script runs **12 fixed lookup questions for three rounds** on independent isolated copies of `examples/demo-workspace`, with separate cache directories. It records cold index time, warm query p50/p95, hit@1/hit@5 against named expected files, cache bytes, process RSS and mean response bytes.

## Measured CI sample

Source: [GitHub Actions run 42267333715, verify (22)](https://github.com/dthompsonfl/apex-context-server/actions/runs/42267333715), commit `60c22d2fbd8042288d405d517983be74e539a419`. Environment: Linux x64, Node `v22.23.4`.

| Metric | Observed |
|---|---:|
| Cold index per run | 1,316.12 / 891.34 / 700.70 ms |
| Warm lookup p50 | 11.78 ms |
| Warm lookup p95 | 19.51 ms |
| Hit@1 | 91.7% (33/36 queries) |
| Hit@5 | 100% (36/36 queries) |
| Peak process RSS | 384,331,776 bytes |
| Cache size | 20,614 / 20,615 / 20,611 bytes |
| Mean response | 887 bytes |

**Interpretation:** These are measurements of a tiny synthetic corpus on one CI runner. Process RSS includes the Node runtime and dependencies; it does not measure indexer-only allocation. Cold timings contain runtime startup effects. This is not proof of large-monorepo scalability, superiority to `rg`, or reduced agent tool calls. There is no controlled Apex-on/Apex-off coding-task experiment. The code intentionally rechecks source fingerprints on cached lookups, so larger workspaces can be slower.

Re-run on the exact commit or current revision and record machine, Node version, corpus and any changes in methodology. Report disappointing results instead of inventing an improvement.
