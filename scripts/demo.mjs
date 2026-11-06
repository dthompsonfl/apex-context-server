#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await mkdtemp(path.join(os.tmpdir(), "apex-demo-"));
const configDir = path.join(root, ".apex-config");
await mkdir(path.join(root, "apps/web/src/app"), { recursive: true });
await mkdir(path.join(root, "apps/web/src/components"), { recursive: true });
await mkdir(path.join(root, "packages/ui/src"), { recursive: true });
await mkdir(configDir, { recursive: true });
await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", private: true, workspaces: ["apps/*","packages/*"] }, null, 2));
await writeFile(path.join(root, "packages/ui/package.json"), JSON.stringify({ name: "@demo/ui", version: "1.0.0" }, null, 2));
await writeFile(path.join(root, "apps/web/package.json"), JSON.stringify({ name: "@demo/web", version: "1.0.0", dependencies: {"@demo/ui":"workspace:*"} }, null, 2));
await writeFile(path.join(root, "packages/ui/src/Button.tsx"), "export interface ButtonProps { label: string }\nexport function Button(p: ButtonProps){ return p.label }\n");
await writeFile(path.join(root, "apps/web/src/components/Card.tsx"), "import { Button } from \"@demo/ui\";\nexport function Card(){ return Button({label:'hi'}) }\n");
await writeFile(path.join(root, "apps/web/src/app/page.tsx"), "import { Card } from \"../components/Card\";\nexport default function Page(){ return Card() }\n");
await writeFile(path.join(root, "apps/web/src/app/route.ts"), "export async function GET(){ return new Response('ok') }\n");
await writeFile(path.join(root, "apps/web/src/secretish.ts"), "export const demo = { apiKey: 'sk-DEMO_FAKE_SECRET_SHOULD_REDACT_1234567890' };\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js")],
  cwd: root,
  env: { ...process.env, APEX_CONTEXT_ROOT: root, APEX_CONTEXT_CONFIG_DIR: configDir, OPENCODE_CONFIG_DIR: configDir },
  stderr: "pipe",
});
const client = new Client({ name: "apex-demo", version: "1.0.0" });
const txt = (r) => (r.content ?? []).map(c => c.text ?? "").join("\n");
let pass = false;
try {
  await client.connect(transport);
  console.log("1) MCP connected");
  const tools = await client.listTools();
  console.log(`2) Tools listed: ${tools.tools.length}`);
  assert.equal(tools.tools.length, 15);
  console.log(txt(await client.callTool({ name: "index_workspace", arguments: { root, force: true } })).split("\n").slice(0,2).join("\n"));
  console.log("3) Workspace indexed");
  const located = await client.callTool({ name: "locate_code", arguments: { root, query: "Button" } });
  console.log("4) locate_code(Button):", txt(located).slice(0,180).replace(/\n/g," "));
  assert.match(txt(located), /Button/);
  const bundle = await client.callTool({ name: "read_context_bundle", arguments: { root, query: "Page" } });
  console.log("5) read_context_bundle(Page) returned");
  assert.match(txt(bundle), /Apex Context Bundle/);
  // external change
  await writeFile(path.join(root, "packages/ui/src/Button.tsx"), "export interface ButtonProps { label: string; tone?: string }\nexport function Button(p: ButtonProps){ return p.label + (p.tone||'') }\nexport const ButtonSentinel = 1;\n");
  const located2 = await client.callTool({ name: "locate_code", arguments: { root, query: "ButtonSentinel" } });
  console.log("6) Freshness after external edit (no restart):", txt(located2).includes("ButtonSentinel") ? "ButtonSentinel found" : "MISSING");
  assert.match(txt(located2), /ButtonSentinel/);
  // security: synthetic secret should be redacted in search/bundle text outputs
  const search = await client.callTool({ name: "search_code", arguments: { root, query: "DEMO_FAKE_SECRET" } });
  const searchText = txt(search);
  assert.ok(!searchText.includes("sk-DEMO_FAKE_SECRET_SHOULD_REDACT_1234567890"), "synthetic secret leaked");
  console.log("7) Synthetic secret redaction: PASS");
  // authorized root: read_component_context outside root
  await writeFile("/tmp/apex-demo-outside.ts", "export const Outside = 1;\n");
  const outside = await client.callTool({ name: "read_component_context", arguments: { root, filepath: "/tmp/apex-demo-outside.ts", nodeName: "Outside" } });
  assert.equal(outside.isError, true);
  console.log("8) Outside-root protection: PASS");
  pass = true;
  console.log("DEMO PASS");
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}
process.exit(pass ? 0 : 1);
