import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";

const exec = promisify(execFile);
const repo = process.cwd();
const setup = path.join(repo, "scripts/setup-opencode.mjs");
const uninstall = path.join(repo, "scripts/uninstall-opencode.mjs");
async function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return exec(process.execPath, [script, ...args], { cwd: repo, env, timeout: 90000, maxBuffer: 1024 * 1024 });
}

test("OpenCode project install preserves JSONC and unrelated config, and is reversible", { timeout: 240000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-installer-"));
  const project = path.join(temp, "project");
  const fakeGlobal = path.join(temp, "fake-global");
  await mkdir(project, { recursive: true });
  const config = path.join(project, "opencode.json");
  const original = '{\n // KEEP THIS COMMENT\n "mcp": {\n   "other": {"type":"local","command":["node","other.js"]}\n },\n "settings": {"safe": true}\n}\n';
  await writeFile(config, original);
  const env = { ...process.env, APEX_CONTEXT_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: fakeGlobal };
  try {
    await run(setup, ["--scope", "project", "--dry-run"], env);
    assert.equal(await readFile(config, "utf8"), original);
    await assert.rejects(access(path.join(project, ".opencode/apex-context-manifest.json")));
    await run(setup, ["--scope", "project"], env);
    const installed = await readFile(config, "utf8");
    assert.match(installed, /KEEP THIS COMMENT/);
    assert.match(installed, /"other"/);
    assert.match(installed, /"apex-context"/);
    await access(path.join(project, ".opencode/apex-context-server/dist/index.js"));
    await run(setup, ["--scope", "project"], env);
    await run(uninstall, ["--scope", "project", "--dry-run"], env);
    const modified = (await readFile(config, "utf8")).replace('"safe": true', '"safe": false');
    await writeFile(config, modified);
    await run(uninstall, ["--scope", "project"], env);
    const remaining = await readFile(config, "utf8");
    assert.match(remaining, /KEEP THIS COMMENT/);
    assert.match(remaining, /"other"/);
    assert.match(remaining, /"safe": false/);
    assert.doesNotMatch(remaining, /"apex-context"/);
    await assert.rejects(access(path.join(project, ".opencode/apex-context-server")));
    await assert.rejects(access(path.join(fakeGlobal, "opencode.json")));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("installer refuses unowned MCP collisions and uninstall refuses modified owned files", { timeout: 160000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-install-conflict-"));
  const project = path.join(temp, "project");
  await mkdir(project);
  const config = path.join(project, "opencode.json");
  const env = { ...process.env, APEX_CONTEXT_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: path.join(temp, "global") };
  try {
    await writeFile(config, '{"mcp":{"apex-context":{"type":"local","command":["other"]}}}\n');
    await assert.rejects(run(setup, ["--scope", "project"], env), /already exists|not owned/);
    await writeFile(config, '{}\n');
    await run(setup, ["--scope", "project"], env);
    const plugin = path.join(project, ".opencode/plugins/apex-context-guard.js");
    await writeFile(plugin, (await readFile(plugin, "utf8")) + "\n// user change\n");
    await assert.rejects(run(uninstall, ["--scope", "project"], env), /modified|refusing deletion/);
    assert.match(await readFile(plugin, "utf8"), /user change/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("explicit user scope installs only in isolated supplied config directory", { timeout: 160000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-user-scope-"));
  const fakeGlobal = path.join(temp, "fake-home-config");
  const env = { ...process.env, OPENCODE_CONFIG_DIR: fakeGlobal, APEX_CONTEXT_PROJECT_DIR: path.join(temp, "unrelated-project") };
  try {
    await run(setup, ["--scope", "user", "--dry-run"], env);
    await assert.rejects(access(path.join(fakeGlobal, "opencode.json")));
    await run(setup, ["--scope", "user"], env);
    assert.match(await readFile(path.join(fakeGlobal, "opencode.json"), "utf8"), /apex-context/);
    await run(uninstall, ["--scope", "user"], env);
    await assert.rejects(access(path.join(fakeGlobal, "apex-context-manifest.json")));
    await assert.rejects(access(path.join(fakeGlobal, "apex-context-server")));
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test("SIGKILL during reinstall is recovered from durable journal without losing original files", { timeout: 240000, skip: process.platform === "win32" }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-crash-install-"));
  const project = path.join(temp, "project");
  await mkdir(project);
  const configPath = path.join(project, "opencode.json");
  const original = '{\n // keep critical setting\n "mcp":{"other":{"type":"local","command":["node","other"]}},\n "safe":true\n}\n';
  await writeFile(configPath, original);
  const env = { ...process.env, APEX_CONTEXT_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: path.join(temp, "fake-global") };
  const manifestPath = path.join(project, ".opencode/apex-context-manifest.json");
  const pluginPath = path.join(project, ".opencode/plugins/apex-context-guard.js");
  try {
    await run(setup, ["--scope", "project"], env);
    const configBefore = await readFile(configPath, "utf8");
    const pluginBefore = await readFile(pluginPath, "utf8");
    const manifestBefore = await readFile(manifestPath, "utf8");
    await assert.rejects(run(setup, ["--scope", "project"], {
      ...env, NODE_ENV: "test",
      APEX_OPENCODE_TEST_FAULT_AFTER: "2", APEX_OPENCODE_TEST_FAULT_MODE: "kill",
    }));
    await access(path.join(project, ".opencode/.apex-context-transaction/plan.json"));
    await assert.rejects(run(setup, ["--scope", "project"], env), /Incomplete transaction/);
    await run(setup, ["--scope", "project", "--recover"], env);
    assert.equal(await readFile(configPath, "utf8"), configBefore);
    assert.equal(await readFile(pluginPath, "utf8"), pluginBefore);
    assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
    await run(setup, ["--scope", "project"], env);
    await run(uninstall, ["--scope", "project"], env);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("SIGKILL during uninstall preserves recoverable ownership and allows safe retry", { timeout: 240000, skip: process.platform === "win32" }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-crash-uninstall-"));
  const project = path.join(temp, "project");
  await mkdir(project);
  const env = { ...process.env, APEX_CONTEXT_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: path.join(temp, "fake-global") };
  const manifestPath = path.join(project, ".opencode/apex-context-manifest.json");
  try {
    await run(setup, ["--scope", "project"], env);
    const originalManifest = await readFile(manifestPath, "utf8");
    await assert.rejects(run(uninstall, ["--scope", "project"], {
      ...env, NODE_ENV: "test",
      APEX_OPENCODE_TEST_FAULT_AFTER: "1", APEX_OPENCODE_TEST_FAULT_MODE: "kill",
    }));
    await access(path.join(project, ".opencode/.apex-context-transaction/plan.json"));
    await run(uninstall, ["--scope", "project", "--recover"], env);
    assert.equal(await readFile(manifestPath, "utf8"), originalManifest);
    await run(uninstall, ["--scope", "project"], env);
    await assert.rejects(access(manifestPath));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("OpenCode V2 layout is installed and safely removed independently of V1", { timeout: 160000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-v2-install-"));
  const project = path.join(temp, "project");
  await mkdir(project);
  const configPath = path.join(project, "opencode.json");
  await writeFile(configPath, '{"mcp":{"servers":{"other":{"type":"local","command":["node","other"]}}},"custom":1}\n');
  const env = { ...process.env, APEX_CONTEXT_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: path.join(temp, "fake-global") };
  try {
    await run(setup, ["--scope", "project", "--client", "v2"], env);
    const installed = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(installed.mcp.servers["apex-context"].type, "local");
    assert.equal(installed.mcp.servers.other.command[1], "other");
    assert.equal(installed.custom, 1);
    const manifest = JSON.parse(await readFile(path.join(project, ".opencode/apex-context-manifest.json"), "utf8"));
    assert.equal(manifest.client, "v2");
    await assert.rejects(run(setup, ["--scope", "project", "--client", "v1"], env), /Changing OpenCode client version/);
    await run(uninstall, ["--scope", "project"], env);
    const cleaned = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(cleaned.mcp.servers.other.command[1], "other");
    assert.equal(cleaned.mcp.servers["apex-context"], undefined);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
