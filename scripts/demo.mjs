#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "apex-stdio-demo-"));
const root = path.join(temp, "workspace");
const config = path.join(temp, "config");
const client = new Client({ name: "apex-demo", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repo, "dist/index.js")],
  cwd: root,
  env: { PATH: process.env.PATH || "", HOME: temp, APEX_CONTEXT_ROOT: root, OPENCODE_CONFIG_DIR: config },
  stderr: "pipe",
});
const extract = result => Array.isArray(result.content)
  ? result.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(name + ": " + extract(result));
  return extract(result);
}

try {
  await cp(path.join(repo, "examples/demo-workspace"), root, { recursive: true });
  await mkdir(config, { recursive: true });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 15, "Expected all 15 public tools");
  console.log("Connected to real MCP stdio server; listed", tools.length, "tools.");
  const indexed = await call("index_workspace");
  console.log(indexed.split("\n").slice(0, 6).join(" | "));
  const found = JSON.parse(await call("locate_code", { query: "Button", maxResults: 5 }));
  assert.ok(found.matches.some(item => item.file.endsWith("Button.tsx")));
  console.log("Located Button:", found.matches.map(m => m.file).join(", "));
  const bundle = await call("read_context_bundle", { filepath: "apps/web/src/components/Button.tsx", nodeName: "Button" });
  assert.match(bundle, /ButtonProps/);
  console.log("Retrieved edit-ready bundle with ButtonProps.");
  const route = JSON.parse(await call("locate_code", { query: "page", kind: "route" }));
  assert.ok(route.matches.some(item => item.file.endsWith("page.tsx")));
  console.log("Located Next.js page route.");
  const added = path.join(root, "apps/web/src/components/ExternalChange.tsx");
  await writeFile(added, 'export function ExternalChange() { return "new"; }\n');
  const fresh = JSON.parse(await call("find_symbol", { query: "ExternalChange", exact: true }));
  assert.ok(fresh.matches.some(item => item.name === "ExternalChange"));
  console.log("External source creation detected on same client connection.");
  const canary = path.join(root, "apps/web/src/components/Canary.ts");
  const tick = String.fromCharCode(96);
  await writeFile(canary, "export const example = " + tick + "-----BEGIN PRIVATE KEY-----\nNOT_A_REAL_KEY_ONLY_A_SYNTHETIC_TEST\n-----END PRIVATE KEY-----" + tick + ";\n");
  await call("refresh_workspace_memory");
  const sanitized = await call("read_component_context", { filepath: canary, nodeName: "example" });
  assert.doesNotMatch(sanitized, /NOT_A_REAL_KEY_ONLY_A_SYNTHETIC_TEST/);
  assert.match(sanitized, /REDACTED_SECRET/);
  console.log("Synthetic private-key content redacted.");
  const outside = path.join(temp, "outside.ts");
  await writeFile(outside, "export const outside = true;\n");
  const denied = await client.callTool({ name: "read_component_context", arguments: { filepath: outside, nodeName: "outside" } });
  assert.equal(denied.isError, true);
  console.log("Outside-workspace source access denied.");
  console.log("DEMO PASSED. Actual user OpenCode settings were untouched.");
} finally {
  await client.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
