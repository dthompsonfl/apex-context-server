#!/usr/bin/env node
/** Test a real npm-installed tarball, including its executable entrypoint and SDK handshake. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "apex-package-smoke-"));
const packDir = path.join(root, "pack");
const installDir = path.join(root, "clean-install");
const workspace = path.join(root, "workspace");
const config = path.join(root, "config");
let client;
try {
  await Promise.all([mkdir(packDir), mkdir(installDir), mkdir(config)]);
  const packed = await exec("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: repo, timeout: 60000, maxBuffer: 3_000_000,
  });
  const items = JSON.parse(packed.stdout);
  assert.equal(items.length, 1, "Expected exactly one npm tarball");
  const tarball = path.join(packDir, items[0].filename);
  await access(tarball);
  await exec("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-package-lock",
    "--no-audit", "--no-fund", "--prefix", installDir, tarball], {
    cwd: root, timeout: 180000, maxBuffer: 3_000_000,
  });
  const pkg = path.join(installDir, "node_modules", "@vantus", "apex-context-server");
  const entry = path.join(pkg, "dist/index.js");
  const executable = path.join(installDir, "node_modules", ".bin",
    process.platform === "win32" ? "apex-context-server.cmd" : "apex-context-server");
  await Promise.all([access(entry), access(executable)]);
  await cp(path.join(pkg, "examples/demo-workspace"), workspace, { recursive: true });
  client = new Client({ name: "apex-installed-bin-smoke", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: executable, cwd: workspace,
    args: [], env: {
      ...process.env, HOME: root, OPENCODE_CONFIG_DIR: config, APEX_CONTEXT_ROOT: workspace,
    },
  });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 15);
  const indexed = await client.callTool({ name: "index_workspace", arguments: {} });
  assert.notEqual(indexed.isError, true, "Installed binary must index workspace");
  const result = await client.callTool({ name: "locate_code", arguments: { query: "Button" } });
  assert.notEqual(result.isError, true);
  const payload = (result.content ?? []).filter(part => part.type === "text")
    .map(part => part.text).join("\n");
  assert.ok(JSON.parse(payload).matches.some(item => item.file.endsWith("Button.tsx")));
  console.log("PACKAGE_SMOKE_PASS: npm tarball installed without repository-local dependencies; executable invoked MCP tools");
} finally {
  if (client) await client.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
