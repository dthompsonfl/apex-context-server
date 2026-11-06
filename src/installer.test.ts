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
