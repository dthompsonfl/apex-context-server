#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { buildWorkspaceIndex, locateCode } from "../dist/indexer.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const queries = [
  ["Button", "apps/web/src/components/Button.tsx"],
  ["ButtonProps", "apps/web/src/components/Button.tsx"],
  ["Panel", "packages/ui/src/Panel.tsx"],
  ["PanelProps", "packages/ui/src/Panel.tsx"],
  ["formatTitle", "apps/web/src/lib/format.ts"],
  ["Page", "apps/web/src/app/page.tsx"],
  ["RootLayout", "apps/web/src/app/layout.tsx"],
  ["GET", "apps/web/src/app/api/health/route.ts"],
  ["helperMemorySignal", "apps/web/src/app/page.tsx"],
  ["testButton", "apps/web/src/components/Button.test.ts"],
  ["@demo/ui", "apps/web/package.json"],
  ["components", "apps/web/src/components/Button.tsx"],
];
const temp = await mkdtemp(path.join(os.tmpdir(), "apex-bench-"));
const before = process.env.OPENCODE_CONFIG_DIR;
const cold = [], lookups = [], cacheBytes = [];
let hits1 = 0, hits5 = 0, bytes = 0, peakRss = process.memoryUsage().rss;
const rounds = 3;
try {
  for (let round = 0; round < rounds; round++) {
    const root = path.join(temp, "workspace" + round);
    process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config" + round);
    await cp(path.join(repo, "examples/demo-workspace"), root, { recursive: true });
    await mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
    const started = performance.now();
    const index = await buildWorkspaceIndex({ root, force: true });
    cold.push(performance.now() - started);
    cacheBytes.push((await stat(index.indexPath)).size);
    for (const [query, expected] of queries) {
      const start = performance.now();
      const result = await locateCode(query, { root, maxResults: 5 });
      lookups.push(performance.now() - start);
      if (result.matches[0]?.file === expected) hits1++;
      if (result.matches.some(item => item.file === expected)) hits5++;
      bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }
} finally {
  if (before === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = before;
  await rm(temp, { recursive: true, force: true });
}
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100;
};
console.log(JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  fixture: "examples/demo-workspace", runs: rounds, queriesPerRun: queries.length,
  coldIndexMs: cold.map(n => Math.round(n * 100) / 100),
  lookupP50Ms: percentile(lookups, 0.5), lookupP95Ms: percentile(lookups, 0.95),
  hitAt1: hits1 / (queries.length * rounds), hitAt5: hits5 / (queries.length * rounds),
  peakProcessRssBytes: peakRss, cacheBytes, meanResponseBytes: Math.round(bytes / lookups.length),
  limitations: "Tiny synthetic dataset; process RSS is not isolated to indexer; no baseline comparator or agent-productivity claim."
}, null, 2));
