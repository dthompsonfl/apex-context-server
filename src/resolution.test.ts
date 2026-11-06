import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkspaceIndex, locateCode, findSymbol } from "./indexer.js";
import { getWorkspaceTopology } from "./topology.js";

test("committed npm workspace fixture resolves aliases, package exports, re-exports and Next.js routes", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-resolver-"));
  const root = path.join(temp, "workspace");
  const oldConfig = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
  try {
    await cp(path.join(process.cwd(), "examples/demo-workspace"), root, { recursive: true });
    const index = await buildWorkspaceIndex({ root, force: true });
    const page = index.files.find(file => file.path === "apps/web/src/app/page.tsx");
    assert.ok(page);
    assert.ok(page.resolvedImports.includes("apps/web/src/components/Button.tsx"), "app @/* alias");
    assert.ok(page.resolvedImports.includes("apps/web/src/lib/format.ts"), "dynamic import and require alias");
    assert.ok(page.resolvedImports.some(file => file.startsWith("packages/ui/src/")), "workspace package");
    const barrel = index.files.find(file => file.path === "packages/ui/src/index.ts");
    assert.ok(barrel?.resolvedImports.includes("packages/ui/src/Panel.tsx"), "barrel re-export");
    const topology = await getWorkspaceTopology(root);
    assert.ok(topology["@demo/web"]);
    assert.ok(topology["@demo/ui"]);
    assert.ok(topology["@demo/web"].internalDependencies.includes("@demo/ui"));
    const local = await findSymbol("helperMemorySignal", { root, exact: true });
    assert.equal(local.matchCount, 1);
    assert.equal(local.matches[0]?.isExported, false);
    const route = await locateCode("page", { root, kind: "route" });
    assert.ok(route.matches.some(item => item.file === "apps/web/src/app/page.tsx"));
  } finally {
    if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = oldConfig;
    await rm(temp, { recursive: true, force: true });
  }
});
