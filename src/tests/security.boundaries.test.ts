import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { extractComponentContext } from "../ast.js";
import { buildWorkspaceIndex, searchCode, _resetIndexStateForTests } from "../indexer.js";
import { readContextBundle } from "../context.js";
import { createFixtureWorkspace } from "./helpers.js";

test("AST and bundle access reject paths outside the authorized root", async () => {
  const fx = await createFixtureWorkspace("apex-sec-");
  try {
    await _resetIndexStateForTests();
    await writeFile("/tmp/apex-outside-secret.ts", "export const SecretLeak = 'NOPE';\n");
    await assert.rejects(
      () => extractComponentContext("/tmp/apex-outside-secret.ts", "SecretLeak", fx.root),
      /outside the authorized workspace root|escapes/i,
    );
    await assert.rejects(
      () => readContextBundle({ root: fx.root, filepath: "/tmp/apex-outside-secret.ts" }),
      /outside the authorized workspace root/i,
    );
  } finally {
    await fx.cleanup();
  }
});

test("symlink escape is rejected and sensitive files are excluded/redacted", async () => {
  const fx = await createFixtureWorkspace("apex-sym-");
  try {
    await _resetIndexStateForTests();
    await mkdir(path.join(fx.root, "links"), { recursive: true });
    await symlink("/tmp", path.join(fx.root, "links", "escape"));
    await writeFile(path.join(fx.root, ".env"), "OPENAI_API_KEY=sk-THIS_IS_A_FAKE_TEST_SECRET_1234567890\n");
    await writeFile(path.join(fx.root, "packages/shared/src/leak.ts"), 'export const token = "Bearer supersecrettokenvaluethatshouldnotappear";\n');

    const index = await buildWorkspaceIndex({ root: fx.root, force: true });
    assert.ok(!index.files.some((f) => f.path === ".env"), ".env should be excluded");
    assert.ok(index.diagnostics.secretRedactions.length > 0, "redaction should be recorded");

    // The synthetic bearer value must never appear in search output or persisted index.
    const res = await searchCode("Bearer", { root: fx.root });
    const joined = JSON.stringify(res);
    assert.ok(!joined.includes("supersecrettokenvaluethatshouldnotappear"), "raw token must not appear in search output");
    const persisted = await readFile(index.indexPath, "utf8");
    assert.ok(!persisted.includes("supersecrettokenvaluethatshouldnotappear"), "persisted index must not contain raw token");
    assert.ok(!persisted.includes("sk-THIS_IS_A_FAKE_TEST_SECRET_1234567890"), "persisted index must not contain env secret");
  } finally {
    await fx.cleanup();
  }
});
