import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { WorkspaceWatcherManager } from "./watcher.js";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("asynchronous watcher errors trigger degraded, polling-backed recovery and clean stop", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apex-watch-error-"));
  let failPrimary: ((error: Error) => void) | undefined;
  let onChanged: ((change: { type: "change" | "delete"; file: string; event: string }) => void) | undefined;
  let primaryClosed = 0;
  let fallbackClosed = 0;
  let reconciled = 0;
  const events: string[] = [];
  const manager = new WorkspaceWatcherManager({
    startPrimary: async (_root, changed, failed) => {
      onChanged = changed;
      failPrimary = failed;
      await delay(10); // A watcher must finish initialization before start returns watching.
      return { backend: "chokidar", close() { primaryClosed++; } };
    },
    startFallback: async () => ({ backend: "fs.watch", close() { fallbackClosed++; } }),
    reconcile: async () => { reconciled++; },
    record: async (_root, detail) => { events.push(detail.event); },
    fallbackPollMs: 15,
    debounceMs: 10,
  });
  try {
    const started = await manager.start(root);
    assert.equal(started.status, "watching");
    assert.equal(started.backend, "chokidar");
    onChanged?.({ type: "change", file: path.join(root, "src/example.ts"), event: "file.edited" });
    await delay(40);
    assert.ok(reconciled >= 1, "debounced change must reconcile");
    assert.deepEqual(events, ["file.edited"]);
    failPrimary?.(new Error("synthetic primary backend crash"));
    await delay(65);
    const degraded = manager.getStatus(root);
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.backend, "fs.watch");
    assert.equal(primaryClosed, 1);
    assert.ok(reconciled >= 2, "polling must reconcile after primary failure");
    assert.match(degraded.message ?? "", /Watcher error/);
    const stopped = await manager.stop(root);
    assert.equal(stopped.status, "stopped");
    assert.equal(fallbackClosed, 1);
    const atStop = reconciled;
    await delay(45);
    assert.equal(reconciled, atStop, "closed timer must not run again");
    assert.equal(manager.getStatus(root).status, "stopped");
    assert.equal((await manager.start(root)).status, "watching", "restart is supported");
    await manager.stopAll();
  } finally { await manager.stopAll(); await rm(root, { recursive: true, force: true }); }
});

test("unavailable native watcher and fallback produce honest polling degradation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apex-watch-fallback-"));
  let iterations = 0;
  const manager = new WorkspaceWatcherManager({
    startPrimary: async () => { throw new Error("startup failure"); },
    startFallback: async () => { throw new Error("fallback failure"); },
    record: async () => {},
    reconcile: async () => { iterations++; },
    fallbackPollMs: 10,
  });
  try {
    const status = await manager.start(root);
    assert.equal(status.status, "degraded");
    assert.equal(status.backend, "polling");
    assert.match(status.message ?? "", /Primary watcher unavailable/);
    await delay(40);
    assert.ok(iterations >= 1);
  } finally { await manager.stopAll(); await rm(root, { recursive: true, force: true }); }
});

test("reconciliation errors are visible and do not masquerade as healthy watcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apex-watch-refresh-"));
  let changed: ((change: { type: "change" | "delete"; file: string; event: string }) => void) | undefined;
  const manager = new WorkspaceWatcherManager({
    startPrimary: async (_root, onChange) => { changed = onChange; return { backend: "chokidar", close() {} }; },
    startFallback: async () => { throw new Error("not needed"); },
    record: async () => {},
    reconcile: async () => { throw new Error("synthetic refresh failure"); },
    debounceMs: 5,
  });
  try {
    await manager.start(root);
    changed?.({ type: "change", file: path.join(root, "src/new.ts"), event: "file.created" });
    await delay(50);
    const status = manager.getStatus(root);
    assert.equal(status.status, "degraded");
    assert.match(status.message ?? "", /Reconciliation failed/);
  } finally { await manager.stopAll(); await rm(root, { recursive: true, force: true }); }
});
