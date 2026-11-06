import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildWorkspaceIndex, locateCode, _resetIndexStateForTests } from "../indexer.js";
import { createFixtureWorkspace } from "./helpers.js";

test("external file changes are observed without restart (freshness)", async () => {
  const fx = await createFixtureWorkspace("apex-fresh-");
  try {
    await _resetIndexStateForTests();
    await buildWorkspaceIndex({ root: fx.root, force: true });
    const target = path.join(fx.root, "packages/shared/src/format.ts");
    await writeFile(target, `export function formatTitle(v:string){return v}\nexport const NEW_SENTINEL_4242 = true;\n`);
    // do not force; build should detect staleness/freshness changes
    const again = await buildWorkspaceIndex({ root: fx.root });
    const hit = again.symbols.some((s) => s.name === "NEW_SENTINEL_4242");
    assert.ok(hit, "new symbol should appear after external change");
    const loc = await locateCode("NEW_SENTINEL_4242", { root: fx.root });
    assert.ok(loc.matches.length > 0);
  } finally {
    await fx.cleanup();
  }
});
