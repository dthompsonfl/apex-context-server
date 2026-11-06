import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const NAMES = [
  "prime_workspace_context", "get_agent_boot_context", "get_context_health",
  "get_workspace_memory", "refresh_workspace_memory", "watch_workspace_memory",
  "refresh_changed_files", "get_index_diagnostics", "locate_code",
  "read_context_bundle", "get_workspace_topology", "index_workspace",
  "search_code", "find_symbol", "read_component_context",
] as const;

function contents(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.map((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).join("\n");
}
async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-mcp-test-"));
  const root = path.join(temp, "workspace");
  const config = path.join(temp, "config");
  await mkdir(path.join(root, "apps/web/src/app"), { recursive: true });
  await mkdir(path.join(root, "apps/web/src/components"), { recursive: true });
  await mkdir(path.join(root, "packages/ui/src"), { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", workspaces: ["apps/*", "packages/*"] }));
  await writeFile(path.join(root, "apps/web/package.json"), JSON.stringify({ name: "@demo/web" }));
  await writeFile(path.join(root, "packages/ui/package.json"), JSON.stringify({ name: "@demo/ui" }));
  await writeFile(path.join(root, "apps/web/tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  await writeFile(path.join(root, "apps/web/src/components/Button.tsx"), "export interface ButtonProps { label: string }\nexport function Button(props: ButtonProps) { return props.label; }\n");
  await writeFile(path.join(root, "apps/web/src/app/page.tsx"), 'import { Button } from "@/components/Button";\nexport default function Page() { return Button({ label: "Hello" }); }\n');
  await writeFile(path.join(root, "packages/ui/src/index.ts"), 'export { greet } from "./utils";\n');
  await writeFile(path.join(root, "packages/ui/src/utils.ts"), 'export function greet(name: string) { return "Hello " + name; }\n');
  await writeFile(path.join(root, "apps/web/src/components/canary.ts"), [
    'export const example = "-----BEGIN PRIVATE KEY-----',
    'SYNTHETIC_PRIVATE_KEY_NOT_VALID_ONLY_FOR_TESTING',
    '-----END PRIVATE KEY-----";',
    'export const token = "Bearer SYNTHETIC_TEST_TOKEN_123456789abcdef";',
  ].join("\n"));
  await writeFile(path.join(root, ".env"), "SECRET=synthetic_fixture_value_not_real_1234");
  return { temp, root, config };
}

test("real stdio MCP discovers and invokes all 15 public tools with live source, freshness and boundaries", { timeout: 60000 }, async () => {
  const { temp, root, config } = await fixture();
  const outside = path.join(temp, "outside.ts");
  await writeFile(outside, "export const outside = 'do not expose';\n");
  const client = new Client({ name: "apex-integration-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist/index.js")],
    cwd: root,
    env: { ...process.env, APEX_CONTEXT_ROOT: root, OPENCODE_CONFIG_DIR: config },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const declared = await client.listTools();
    assert.deepEqual(declared.tools.map(tool => tool.name).sort(), [...NAMES].sort());
    for (const tool of declared.tools) assert.equal(tool.inputSchema.type, "object");

    const args: Record<string, Record<string, unknown>> = {
      locate_code: { query: "Button" },
      read_context_bundle: { filepath: "apps/web/src/components/Button.tsx", nodeName: "Button", maxRelated: 2 },
      search_code: { query: "Button" },
      find_symbol: { query: "Button", exact: true },
      read_component_context: { filepath: path.join(root, "apps/web/src/components/Button.tsx"), nodeName: "Button" },
      watch_workspace_memory: {},
    };
    for (const name of NAMES) {
      const result = await client.callTool({ name, arguments: args[name] ?? {} });
      assert.notEqual(result.isError, true, name + ": " + contents(result));
      assert.ok(contents(result).length > 0, "empty " + name);
    }
    const symbol = await client.callTool({ name: "find_symbol", arguments: { query: "Button", exact: true } });
    assert.match(contents(symbol), /Button/);
    const ctx = await client.callTool({ name: "read_component_context", arguments: args.read_component_context });
    assert.match(contents(ctx), /ButtonProps/);
    const route = await client.callTool({ name: "locate_code", arguments: { query: "page", kind: "route" } });
    assert.match(contents(route), /page\.tsx/);

    // Changes are made by the test process, not the MCP server. Queries reuse the same stdio connection.
    const added = path.join(root, "apps/web/src/components/NewWidget.tsx");
    await writeFile(added, "export function NewWidget() { return 'first'; }\n");
    let found = await client.callTool({ name: "find_symbol", arguments: { query: "NewWidget", exact: true } });
    assert.match(contents(found), /NewWidget/);
    await writeFile(added, "export function ChangedWidget() { return 'second'; }\n");
    found = await client.callTool({ name: "find_symbol", arguments: { query: "ChangedWidget", exact: true } });
    assert.match(contents(found), /ChangedWidget/);
    const old = await client.callTool({ name: "find_symbol", arguments: { query: "NewWidget", exact: true } });
    assert.doesNotMatch(contents(old), /"name": "NewWidget"/);
    const renamed = path.join(root, "apps/web/src/components/RenamedWidget.tsx");
    await rename(added, renamed);
    const moved = await client.callTool({ name: "find_symbol", arguments: { query: "ChangedWidget", exact: true } });
    assert.match(contents(moved), /RenamedWidget.tsx/);
    await rm(renamed);
    const deleted = await client.callTool({ name: "find_symbol", arguments: { query: "ChangedWidget", exact: true } });
    assert.doesNotMatch(contents(deleted), /"name": "ChangedWidget"/);

    const escape = await client.callTool({ name: "read_component_context", arguments: { filepath: outside, nodeName: "outside" } });
    assert.equal(escape.isError, true);
    const wrongRoot = await client.callTool({ name: "index_workspace", arguments: { root: temp } });
    assert.equal(wrongRoot.isError, true);
    const link = path.join(root, "apps/web/src/components/External.ts");
    await symlink(outside, link);
    const linked = await client.callTool({ name: "read_component_context", arguments: { filepath: link, nodeName: "outside" } });
    assert.equal(linked.isError, true);

    const secret = await client.callTool({ name: "search_code", arguments: { query: "SYNTHETIC_PRIVATE_KEY_NOT_VALID_ONLY_FOR_TESTING" } });
    assert.deepEqual(JSON.parse(contents(secret)).matches, [], "secret material must not be searchable");
    const astSecret = await client.callTool({ name: "read_component_context", arguments: { filepath: path.join(root, "apps/web/src/components/canary.ts"), nodeName: "example" } });
    assert.doesNotMatch(contents(astSecret), /SYNTHETIC_PRIVATE_KEY_NOT_VALID_ONLY_FOR_TESTING/);
    const badType = await client.callTool({ name: "find_symbol", arguments: { query: 123 } });
    assert.equal(badType.isError, true, "wrong-type arguments return tool error");
    const missing = await client.callTool({ name: "search_code", arguments: {} });
    assert.equal(missing.isError, true, "missing required query returns tool error");
    const tooLong = await client.callTool({ name: "search_code", arguments: { query: "x".repeat(300) } });
    assert.equal(tooLong.isError, true, "query budget must be enforced");
    const regex = await client.callTool({ name: "search_code", arguments: { query: "(a+)+$", regex: true } });
    assert.equal(regex.isError, true);
    const cache = await client.callTool({ name: "index_workspace", arguments: {} });
    assert.notEqual(cache.isError, true);
    const saved = await readFile(path.join(config, "apex-context-index", (await import("node:crypto")).createHash("sha256").update(root).digest("hex").slice(0, 20) + ".json"), "utf8");
    assert.doesNotMatch(saved, /SYNTHETIC_PRIVATE_KEY_NOT_VALID_ONLY_FOR_TESTING/);
    const stopped = await client.callTool({ name: "watch_workspace_memory", arguments: { action: "stop" } });
    assert.notEqual(stopped.isError, true);
    assert.equal(JSON.parse(contents(stopped)).status, "stopped");
  } finally {
    await client.close().catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
