#!/usr/bin/env node
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await mkdtemp(path.join(os.tmpdir(), "apex-smoke-"));
const configDir = path.join(root, ".apex-config");
await mkdir(path.join(root, "src"), { recursive: true });
await mkdir(configDir, { recursive: true });
await writeFile(path.join(root, "src", "hello.ts"), "export function hello(name: string){ return `hi ${name}`; }\n");

const serverPath = path.resolve("dist/index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: { ...process.env, APEX_CONTEXT_ROOT: root, APEX_CONTEXT_CONFIG_DIR: configDir, OPENCODE_CONFIG_DIR: configDir },
  stderr: "pipe",
});
let stderr = ""; transport.stderr?.on("data", (d) => stderr += String(d));
const client = new Client({ name: "apex-smoke", version: "1.0.0" });
let ok = false;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const required = ["find_symbol","get_agent_boot_context","get_context_health","get_index_diagnostics","get_workspace_memory","get_workspace_topology","index_workspace","locate_code","prime_workspace_context","read_component_context","read_context_bundle","refresh_changed_files","refresh_workspace_memory","search_code","watch_workspace_memory"];
  const names = new Set(tools.tools.map(t => t.name));
  for (const r of required) if (!names.has(r)) throw new Error(`Missing tool: ${r}`);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = (r.content??[]).map(c=>c.text??"").join("\n"); if (r.isError) throw new Error(`${name} failed: ${t}\n${stderr}`); return t; };
  await call("index_workspace", { root, force: true });
  const find = await call("find_symbol", { root, query: "hello", exact: true });
  if (!find.includes("hello")) throw new Error("find_symbol failed");
  ok = true;
  console.log(`smoke:mcp PASS (${tools.tools.length} tools, hello symbol found)`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  if (stderr) console.error("--- stderr ---\n"+stderr);
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
