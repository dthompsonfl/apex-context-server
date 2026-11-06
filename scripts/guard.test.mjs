import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("OpenCode guard warns by default, supports targeted search and explicit strict mode", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-guard-"));
  const old = process.env.OPENCODE_CONFIG_DIR;
  const previousMode = process.env.APEX_CONTEXT_GUARD_MODE;
  process.env.OPENCODE_CONFIG_DIR = temp;
  delete process.env.APEX_CONTEXT_GUARD_MODE;
  try {
    const { ApexContextGuard } = await import("../opencode/plugins/apex-context-guard.js");
    const plugin = await ApexContextGuard({ client: { app: { log: async () => {} } } });
    const invoke = async command => plugin["tool.execute.before"]({ tool: "bash" }, { args: { command } });
    await invoke("rg button");
    await invoke("rg button src/index.ts");
    let state = JSON.parse(await readFile(path.join(temp, "apex-context-usage.json"), "utf8"));
    const key = Object.keys(state.workspaces)[0];
    assert.equal(state.workspaces[key].rawSearchWarned, 1);
    assert.equal(state.workspaces[key].rawSearchBlocked ?? 0, 0);
    process.env.APEX_CONTEXT_GUARD_MODE = "strict";
    await assert.rejects(invoke("rg findme"), /broad CLI search/);
    await invoke("APEX_CONTEXT_ALLOW_RAW_SEARCH=1 rg findme");
    state = JSON.parse(await readFile(path.join(temp, "apex-context-usage.json"), "utf8"));
    assert.equal(state.workspaces[key].rawSearchBlocked, 1);
    assert.equal(state.workspaces[key].rawSearchAllowed, 1);
    await plugin.event({ event: { type: "file.edited", properties: { path: "src/index.ts" } } });
    state = JSON.parse(await readFile(path.join(temp, "apex-context-usage.json"), "utf8"));
    assert.equal(state.workspaces[key].memoryStale, true);
    await plugin.event({ event: { type: "session.updated" } });
    assert.equal(JSON.parse(await readFile(path.join(temp, "apex-context-usage.json"), "utf8")).workspaces[key].lastFileEvent, "file.edited");
  } finally {
    if (old === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = old;
    if (previousMode === undefined) delete process.env.APEX_CONTEXT_GUARD_MODE;
    else process.env.APEX_CONTEXT_GUARD_MODE = previousMode;
    await rm(temp, { recursive: true, force: true });
  }
});
