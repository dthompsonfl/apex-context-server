import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkspaceIndex } from "./indexer.js";

test("tsconfig extends outside root cannot load external configuration contents", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-tsconfig-boundary-"));
  const root = path.join(temp, "authorized");
  const outside = path.join(temp, "external");
  const priorConfig = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "cache");
  try {
    await mkdir(path.join(root, "apps/web/src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const marker = "EXTERNAL_UNAUTHORIZED_CONFIG_MARKER_123456789";
    await writeFile(path.join(outside, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { [marker + "/*"]: ["./*"] } },
    }));
    await writeFile(path.join(root, "apps/web/tsconfig.json"), JSON.stringify({
      extends: path.join(outside, "tsconfig.json"),
      compilerOptions: { paths: { "@/*": ["src/*"] } },
    }));
    await writeFile(path.join(root, "apps/web/src/page.ts"), "export const localSource = 'safe';\n");
    const index = await buildWorkspaceIndex({ root, force: true });
    assert.ok(index.files.some(file => file.path === "apps/web/src/page.ts"));
    const persisted = await readFile(index.indexPath, "utf8");
    assert.doesNotMatch(persisted, new RegExp(marker), "External tsconfig must not enter index");
    assert.equal(index.files.some(file => file.absolutePath.startsWith(outside)), false);
  } finally {
    if (priorConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = priorConfig;
    await rm(temp, { recursive: true, force: true });
  }
});
