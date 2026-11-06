import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_TOTAL_INDEXED_BYTES, MAX_TOTAL_INDEXED_LINES, MAX_LINE_LENGTH,
  assertIndexBudget, assertSafeRegex, boundedOutput,
} from "./safety.js";
import { buildWorkspaceIndex, searchCode, locateCode } from "./indexer.js";

test("aggregate source/line limits reject invalid growth, output never truncates JSON", () => {
  assert.doesNotThrow(() => assertIndexBudget(MAX_TOTAL_INDEXED_BYTES, MAX_TOTAL_INDEXED_LINES));
  assert.throws(() => assertIndexBudget(MAX_TOTAL_INDEXED_BYTES + 1, 1), /64 MiB/);
  assert.throws(() => assertIndexBudget(1, MAX_TOTAL_INDEXED_LINES + 1), /250,000/);
  assert.throws(() => boundedOutput("a".repeat(60_001)), /exceeds 60,000/);
  assert.equal(boundedOutput(JSON.stringify({ valid: true })), '{"valid":true}');
  assert.throws(() => assertSafeRegex("(a+)+$"), /Unsafe/);
  assert.throws(() => assertSafeRegex("a+a+a+$"), /Unsafe/);
  assert.doesNotThrow(() => assertSafeRegex("[a-z]+"));
});

test("large deterministic fixture preserves bounded lookup and regex results under load", { timeout: 60000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-stress-"));
  const root = path.join(temp, "workspace");
  const original = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
  await mkdir(path.join(root, "src"), { recursive: true });
  try {
    const count = 220;
    for (let i = 0; i < count; i++) {
      const symbol = "TestSignal" + String(i).padStart(3, "0");
      await writeFile(path.join(root, "src", "file" + i + ".ts"),
        "export const " + symbol + " = " + i + ";\n" + "a".repeat(MAX_LINE_LENGTH * 2) + "\n");
    }
    const indexed = await buildWorkspaceIndex({ root, force: true });
    assert.equal(indexed.fileCount, count);
    assert.ok(indexed.lines.every(line => line.text.length <= MAX_LINE_LENGTH));
    const queries = Array.from({ length: 20 }, (_, i) => searchCode("TestSignal" + String(i).padStart(3, "0"), { root }));
    const results = await Promise.all(queries);
    assert.ok(results.every(result => result.matchCount >= 1));
    const regex = await searchCode("a+", { root, regex: true, maxResults: 25 });
    assert.equal(regex.matches.length, 25);
    assert.equal(regex.truncated, true);
    assert.ok(JSON.stringify(regex).length < 60_000);
    const found = await locateCode("TestSignal172", { root, maxResults: 5 });
    assert.ok(found.matches.some(match => match.file.includes("file172.ts")));
  } finally {
    if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = original;
    await rm(temp, { recursive: true, force: true });
  }
});
