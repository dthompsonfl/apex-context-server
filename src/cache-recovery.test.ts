import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWritePrivateFile, cleanStaleCacheTemps } from "./atomic-cache.js";
import { buildWorkspaceIndex, findSymbol } from "./indexer.js";

test("cache atomic-write fault leaves last snapshot intact and private", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apex-cache-fault-"));
  const file = path.join(dir, "index.json");
  try {
    await atomicWritePrivateFile(file, JSON.stringify({ version: 1 }));
    await assert.rejects(
      atomicWritePrivateFile(file, JSON.stringify({ version: 2 }), {
        beforeReplace() { throw new Error("simulated failure before rename"); },
      }),
      /simulated failure/,
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1 });
    assert.deepEqual(await readdir(dir), ["index.json"]);
    if (process.platform !== "win32") assert.equal((await lstat(file)).mode & 0o077, 0);
    const link = path.join(dir, "symlink.json");
    await symlink(file, link);
    await assert.rejects(atomicWritePrivateFile(link, "{}"), /Refusing/);
    assert.equal(await readFile(file, "utf8"), JSON.stringify({ version: 1 }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("interrupted child write never corrupts the previous snapshot", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apex-cache-kill-"));
  const file = path.join(dir, "index.json");
  try {
    await atomicWritePrivateFile(file, '{"stable":true}');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist/atomic-cache.js")).href;
    const script = "import { atomicWritePrivateFile } from " + JSON.stringify(moduleUrl) + "; "
      + "await atomicWritePrivateFile(" + JSON.stringify(file) + ", '{\"stable\":false}', {beforeReplace: () => process.kill(process.pid, 'SIGKILL')});";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000, encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { stable: true });
    const orphan = (await readdir(dir)).find(entry => entry.endsWith(".tmp"));
    assert.ok(orphan, "SIGKILL should leave an uncommitted temp file");
    await utimes(path.join(dir, orphan), new Date(0), new Date(0));
    assert.equal(await cleanStaleCacheTemps(file), 1);
    assert.deepEqual(await readdir(dir), ["index.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("corrupted index is rebuilt in a fresh process, not silently reused", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-cache-corrupt-"));
  const root = path.join(temp, "workspace");
  const previousConfig = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/health.ts"), "export const HealthySymbol = true;\n");
  try {
    const index = await buildWorkspaceIndex({ root, force: true });
    await writeFile(index.indexPath, '{"incomplete":');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist/indexer.js")).href;
    const script = "import {buildWorkspaceIndex,findSymbol} from " + JSON.stringify(moduleUrl) + "; "
      + "const i=await buildWorkspaceIndex({root:" + JSON.stringify(root) + "}); "
      + "const s=await findSymbol('HealthySymbol',{root:" + JSON.stringify(root) + ",exact:true}); "
      + "console.log(JSON.stringify({files:i.fileCount,matches:s.matchCount}));";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APEX_CONTEXT_ROOT: root },
      encoding: "utf8", timeout: 25000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { files: 1, matches: 1 });
    assert.ok(JSON.parse(await readFile(index.indexPath, "utf8")).manifest["src/health.ts"]);
  } finally {
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfig;
    await rm(temp, { recursive: true, force: true });
  }
});
