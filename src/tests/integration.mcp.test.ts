import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureWorkspace } from "./helpers.js";

async function withMcp<T>(root: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const serverPath = path.resolve(process.cwd(), "dist/index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: { ...process.env, APEX_CONTEXT_ROOT: root, APEX_CONTEXT_CONFIG_DIR: path.join(root, ".apex-config"), OPENCODE_CONFIG_DIR: path.join(root, ".apex-config") },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => { stderr += String(d); });
  const client = new Client({ name: "apex-test-client", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}\n--- server stderr ---\n${stderr}`);
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
}

test("MCP stdio server exposes and exercises all 15 tools", async () => {
  const fx = await createFixtureWorkspace("apex-mcp-");
  try {
    await withMcp(fx.root, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      const expected = [
        "find_symbol", "get_agent_boot_context", "get_context_health", "get_index_diagnostics",
        "get_workspace_memory", "get_workspace_topology", "index_workspace", "locate_code",
        "prime_workspace_context", "read_component_context", "read_context_bundle",
        "refresh_changed_files", "refresh_workspace_memory", "search_code", "watch_workspace_memory",
      ];
      assert.deepEqual(names, expected, `tool list mismatch: ${names.join(",")}`);

      const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
      const txt = (r: any) => (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
      const ok = (r: any, re: RegExp, label: string) => { const t = txt(r); assert.ok(!r.isError, `${label} errored: ${t}`); assert.match(t, re, `${label} mismatch: ${t.slice(0,200)}`); };

      ok(await call("index_workspace", { root: fx.root, force: true }), /Workspace Memory|file\(s\)/, "index_workspace");
      ok(await call("get_workspace_memory", { root: fx.root }), /Apex Workspace Memory/, "get_workspace_memory");
      ok(await call("prime_workspace_context", { root: fx.root }), /APEX CONTEXT TUI DASHBOARD/, "prime_workspace_context");
      ok(await call("get_agent_boot_context", { root: fx.root }), /Apex Agent Boot Context/, "get_agent_boot_context");
      ok(await call("get_context_health", { root: fx.root }), /Status/, "get_context_health");
      ok(await call("get_workspace_topology", { root: fx.root }), /Workspace Topology/, "get_workspace_topology");
      ok(await call("get_index_diagnostics", { root: fx.root }), /watcher|rootHash/, "get_index_diagnostics");
      ok(await call("watch_workspace_memory", { root: fx.root }), /rootHash/, "watch_workspace_memory");
      ok(await call("locate_code", { root: fx.root, query: "Button" }), /Button/, "locate_code");
      ok(await call("search_code", { root: fx.root, query: "formatTitle" }), /formatTitle/, "search_code");
      ok(await call("find_symbol", { root: fx.root, query: "formatTitle" }), /formatTitle/, "find_symbol");
      ok(await call("read_context_bundle", { root: fx.root, query: "Button" }), /Apex Context Bundle/, "read_context_bundle");
      ok(await call("read_component_context", { root: fx.root, filepath: "packages/ui/src/Button.tsx", nodeName: "Button" }), /Button/, "read_component_context");
      ok(await call("refresh_changed_files", { root: fx.root }), /changed-file refresh complete|Changed/i, "refresh_changed_files");
      ok(await call("refresh_workspace_memory", { root: fx.root }), /Workspace Memory/, "refresh_workspace_memory");
    });
  } finally {
    await fx.cleanup();
  }
});
