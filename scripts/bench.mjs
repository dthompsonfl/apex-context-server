#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function pct(arr, p) { const a=[...arr].sort((x,y)=>x-y); return a[Math.min(a.length-1, Math.floor(a.length*p))] ?? 0; }
const root = await mkdtemp(path.join(os.tmpdir(), "apex-bench-"));
const configDir = path.join(root, ".apex-config");
await mkdir(path.join(root, "packages/shared/src"), { recursive: true });
await mkdir(path.join(root, "apps/web/src/app"), { recursive: true });
await mkdir(configDir, { recursive: true });
await writeFile(path.join(root, "package.json"), JSON.stringify({name:"bench",workspaces:["apps/*","packages/*"]}));
await writeFile(path.join(root, "packages/shared/src/util.ts"), Array.from({length:80}, (_,i)=>`export function fn${i}(x:number){ return x+${i}; }`).join("\n")+"\n");
await writeFile(path.join(root, "apps/web/src/app/page.tsx"), `import { fn1 } from "../../../packages/shared/src/util";\nexport default function Page(){ return fn1(1) }\n`);
const queries = ["fn1","fn42","Page","util","shared","ButtonMissing","route","fn79","page tsx","workspace"];
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/index.js")], cwd: root, env: { ...process.env, APEX_CONTEXT_ROOT: root, APEX_CONTEXT_CONFIG_DIR: configDir, OPENCODE_CONFIG_DIR: configDir }, stderr: "pipe" });
const client = new Client({ name: "apex-bench", version: "1.0.0" });
try {
  await client.connect(transport);
  const t0 = performance.now();
  await client.callTool({ name: "index_workspace", arguments: { root, force: true } });
  const cold = performance.now()-t0;
  const lat = [];
  let hits = 0;
  for (let i=0;i<30;i++) {
    const q = queries[i%queries.length];
    const s = performance.now();
    const r = await client.callTool({ name: "locate_code", arguments: { root, query: q } });
    lat.push(performance.now()-s);
    if (JSON.stringify(r).includes("matches")) hits++;
  }
  const mem = process.memoryUsage();
  console.log(JSON.stringify({
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus()?.[0]?.model },
    corpus: { filesApprox: 3, queries: queries.length, iterations: 30 },
    coldIndexMs: Math.round(cold),
    warmLocateP50Ms: Math.round(pct(lat,0.5)),
    warmLocateP95Ms: Math.round(pct(lat,0.95)),
    processRssMiB: Math.round(mem.rss/1024/1024),
    responseShapeChecks: hits,
    notes: "Micro-benchmark on synthetic fixture; not a claim of real-world productivity gains."
  }, null, 2));
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}
