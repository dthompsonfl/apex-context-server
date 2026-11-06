# Benchmarks

## Methodology
- Command: `npm run bench` (`scripts/bench.mjs`)
- Uses a **synthetic temporary fixture** (small generated workspace) and a **real MCP stdio server + client**.
- Measures:
  - cold `index_workspace(force:true)` latency
  - warm `locate_code` latency over repeated queries (p50/p95 in the script’s output)
  - process RSS snapshot
  - response-shape sanity checks
- Environment is reported in the JSON output (Node/platform/arch/CPU). Results vary by machine/load.

## Results (this environment, 2026-11-06)
```json
{
  "environment": { "node": "v24.22.1", "platform": "linux", "arch": "x64", "cpus": "AMD EPYC" },
  "corpus": { "filesApprox": 3, "queries": 10, "iterations": 30 },
  "coldIndexMs": 1681,
  "warmLocateP50Ms": 12,
  "warmLocateP95Ms": 97,
  "processRssMiB": 77,
  "responseShapeChecks": 30,
  "notes": "Micro-benchmark on synthetic fixture; not a claim of real-world productivity gains."
}
```

## Interpretation & limitations
- This is a **micro-benchmark**, not a statistically rigorous performance study and **not** a productivity/time-savings claim.
- Synthetic corpus is much smaller than real monorepos; absolute numbers will differ.
- No fair head-to-head comparison against `ripgrep`/IDE indexing is included here; such a comparison would require a controlled corpus, identical queries, and documented methodology.
