import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { updateUsageState } from "./usage-state.js";

test("concurrent state mutations are serialized without lost updates or partial JSON", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-usage-"));
  const file = path.join(temp, "state/usage.json");
  try {
    await Promise.all(Array.from({ length: 25 }, (_, id) =>
      updateUsageState<{ values?: number[] }>(file, state => {
        state.values ??= [];
        state.values.push(id);
      }),
    ));
    const saved = JSON.parse(await readFile(file, "utf8")) as { values: number[] };
    assert.deepEqual(saved.values.slice().sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
    const entries = await readdir(path.dirname(file));
    assert.deepEqual(entries, ["usage.json"]);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
