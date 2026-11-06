import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("setup/uninstall OpenCode in isolated config is safe and reversible", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "apex-inst-"));
  const configDir = path.join(tmp, "opencode");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "opencode.json");
  const unrelated = { mcp: { other: { type: "local", command: ["echo", "hi"], enabled: true } }, tools: { "other*": true }, instructions: ["keep-me.md"] };
  await writeFile(configPath, JSON.stringify(unrelated, null, 2));
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir, APEX_CONTEXT_CONFIG_DIR: configDir } as Record<string, string | undefined>;
  delete env.APEX_CONTEXT_SKIP_POSTINSTALL;

  const setup = spawnSync(process.execPath, [path.resolve("scripts/setup-opencode.mjs")], { cwd: process.cwd(), env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  assert.equal(setup.status, 0, `setup failed: ${setup.stderr}\n${setup.stdout}`);
  const after = JSON.parse(await readFile(configPath, "utf8"));
  assert.ok(after.mcp["apex-context"], "apex-context entry added");
  assert.ok(after.mcp.other, "unrelated mcp preserved");
  assert.ok(after.tools["apex-context*"], "apex tool enabled");
  assert.ok((after.instructions || []).includes("keep-me.md"), "unrelated instruction preserved");
  await stat(path.join(configDir, "apex-context-server", "dist", "index.js"));
  const dry = spawnSync(process.execPath, [path.resolve("scripts/setup-opencode.mjs"), "--dry-run"], { cwd: process.cwd(), env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr}\n${dry.stdout}`);
  assert.match(dry.stdout, /"dryRun": true/);

  const uninstall = spawnSync(process.execPath, [path.resolve("scripts/uninstall-opencode.mjs")], { cwd: process.cwd(), env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  assert.equal(uninstall.status, 0, `uninstall failed: ${uninstall.stderr}\n${uninstall.stdout}`);
  const restored = JSON.parse(await readFile(configPath, "utf8"));
  assert.ok(!restored.mcp["apex-context"], "apex entry removed");
  assert.ok(restored.mcp.other, "unrelated mcp still preserved");
  await rm(tmp, { recursive: true, force: true });
});
