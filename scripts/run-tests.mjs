#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir, out=[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith(".test.js")) out.push(p);
  }
  return out;
}
const files = [];
for (const root of ["dist/tests", "dist"]) {
  try { for (const f of walk(root)) if (f.includes(`${path.sep}tests${path.sep}`) || path.basename(f)==='indexer.test.js') files.push(path.resolve(f)); } catch {}
}
const uniq = [...new Set(files)].sort();
if (!uniq.length) { console.error("No compiled test files found. Run npm run build first."); process.exit(1); }
const res = spawnSync(process.execPath, ["--test", ...uniq], { stdio: "inherit" });
process.exit(res.status ?? 1);
