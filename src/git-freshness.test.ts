import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { buildWorkspaceIndex, findSymbol } from "./indexer.js";

const execute = promisify(execFile);

test("same-size unchanged-mtime edits and git branch switches invalidate cached symbols", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-git-fresh-"));
  const root = path.join(temp, "repo");
  const configBefore = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
  await mkdir(path.join(root, "src"), { recursive: true });
  const file = path.join(root, "src/symbol.ts");
  async function git(args: string[]) {
    return execute("git", args, { cwd: root, timeout: 10000 });
  }
  const commitArgs = ["-c", "user.name=Apex Test", "-c", "user.email=apex@example.invalid", "commit", "-q", "-m", "fixture"];
  try {
    await writeFile(file, "export const Alpha = 1;\n");
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "."]);
    await git(commitArgs);
    await buildWorkspaceIndex({ root, force: true });
    const oldStat = await stat(file);
    await writeFile(file, "export const Bravo = 1;\n");
    await utimes(file, oldStat.atime, oldStat.mtime);
    assert.equal((await findSymbol("Bravo", { root, exact: true })).matchCount, 1);
    assert.equal((await findSymbol("Alpha", { root, exact: true })).matchCount, 0);
    await git(["switch", "-q", "-c", "feature"]);
    await git(["add", "."]);
    await git(commitArgs);
    await git(["switch", "-q", "main"]);
    assert.equal((await findSymbol("Alpha", { root, exact: true })).matchCount, 1);
    assert.equal((await findSymbol("Bravo", { root, exact: true })).matchCount, 0);
    await git(["switch", "-q", "feature"]);
    assert.equal((await findSymbol("Bravo", { root, exact: true })).matchCount, 1);
  } finally {
    if (configBefore === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = configBefore;
    await rm(temp, { recursive: true, force: true });
  }
});
