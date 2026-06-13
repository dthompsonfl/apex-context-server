import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWorkspaceIndex,
  findSymbol,
  locateCode,
  refreshChangedFiles,
} from "./indexer.js";

async function createFixture(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "apex-memory-"));
  const configDir = path.join(root, ".opencode");
  process.env.OPENCODE_CONFIG_DIR = configDir;

  await mkdir(path.join(root, "apps/web/src/app"), { recursive: true });
  await mkdir(path.join(root, "apps/web/src/components"), { recursive: true });
  await mkdir(path.join(root, "apps/web/src/lib"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-root",
        workspaces: ["apps/*"],
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(root, "apps/web/package.json"),
    JSON.stringify(
      {
        name: "@fixture/web",
        version: "1.0.0",
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(root, "apps/web/tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(root, "apps/web/src/components/Button.tsx"),
    [
      "export interface ButtonProps {",
      "  label: string;",
      "}",
      "",
      "export function Button(props: ButtonProps) {",
      "  return props.label;",
      "}",
    ].join("\n"),
  );

  await writeFile(
    path.join(root, "apps/web/src/lib/format.ts"),
    [
      "export function formatTitle(value: string) {",
      "  return value.trim().toUpperCase();",
      "}",
    ].join("\n"),
  );

  await writeFile(
    path.join(root, "apps/web/src/lib/index.ts"),
    'export { formatTitle } from "./format";\n',
  );

  await writeFile(
    path.join(root, "apps/web/src/app/page.tsx"),
    [
      'import { Button } from "@/components/Button";',
      'import("@/lib/format");',
      'const formatModule = require("@/lib/format");',
      "",
      "function helperMemorySignal(value: string) {",
      "  return formatModule.formatTitle(value);",
      "}",
      "",
      "export default function Page() {",
      '  return Button({ label: helperMemorySignal("hello") });',
      "}",
    ].join("\n"),
  );

  return { root, configDir };
}

test("workspace memory indexes local declarations and resolves app aliases", async () => {
  const { root } = await createFixture();
  try {
    const index = await buildWorkspaceIndex({ root, force: true });
    const page = index.files.find((file) => file.path === "apps/web/src/app/page.tsx");

    assert.ok(page, "page file should be indexed");
    assert.ok(
      page.resolvedImports.includes("apps/web/src/components/Button.tsx"),
      "app-local @/ alias should resolve to the nearest package src root",
    );
    assert.ok(
      page.resolvedImports.includes("apps/web/src/lib/format.ts"),
      "dynamic import and require calls should be part of the import graph",
    );
    assert.ok(
      index.symbols.some(
        (symbol) =>
          symbol.name === "helperMemorySignal" &&
          symbol.file === "apps/web/src/app/page.tsx" &&
          symbol.isExported === false,
      ),
      "top-level local functions should be part of symbol memory",
    );

    const lookup = await findSymbol("helperMemorySignal", { root, exact: true });
    assert.equal(lookup.matchCount, 1);
    assert.equal(lookup.matches[0]?.file, "apps/web/src/app/page.tsx");

    const located = await locateCode("helper memory signal", { root, maxResults: 5 });
    assert.ok(
      located.matches.some((match) => match.file === "apps/web/src/app/page.tsx"),
      "natural-language lookup should find local symbol memory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed-file refresh reports added files as changed memory inputs", async () => {
  const { root } = await createFixture();
  try {
    await buildWorkspaceIndex({ root, force: true });
    await writeFile(
      path.join(root, "apps/web/src/components/Card.tsx"),
      "export function Card() { return null; }\n",
    );

    const refreshed = await refreshChangedFiles({ root });
    assert.ok(refreshed.changedFiles.includes("apps/web/src/components/Card.tsx"));
    assert.ok(
      refreshed.files.some((file) => file.path === "apps/web/src/components/Card.tsx"),
      "added files should be present in refreshed memory",
    );

    const persistedRaw = await readFile(refreshed.indexPath, "utf8");
    assert.ok(persistedRaw.includes("apps/web/src/components/Card.tsx"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
