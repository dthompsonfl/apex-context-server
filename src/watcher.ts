import { watch as fsWatch } from "node:fs";
import path from "node:path";
import {
  getWorkspaceRootHash,
  recordWorkspaceChange,
  refreshChangedFiles,
} from "./indexer.js";

export interface WatchWorkspaceOptions { root?: string }
export interface WatcherStatus {
  root: string;
  rootHash: string;
  status: "starting" | "watching" | "degraded" | "unavailable" | "stopped";
  backend: "chokidar" | "fs.watch" | "polling" | "none";
  changedFiles: string[];
  deletedFiles: string[];
  lastEvent?: string;
  lastRefreshAt?: string;
  message?: string;
}

interface WatcherEvent { type: "change" | "delete"; file: string; event: string }
interface WatcherHandle {
  backend: "chokidar" | "fs.watch" | "polling";
  close(): Promise<void> | void;
}
type ChangeHandler = (change: WatcherEvent) => void;
type ErrorHandler = (error: Error) => void;

/** Injectable boundary makes readiness, asynchronous errors, failover and cleanup testable. */
export interface WatcherRuntime {
  startPrimary(root: string, changed: ChangeHandler, failed: ErrorHandler): Promise<WatcherHandle>;
  startFallback(root: string, changed: ChangeHandler, failed: ErrorHandler): Promise<WatcherHandle>;
  reconcile(root: string): Promise<void>;
  record(root: string, details: { event: string; changedFiles?: string[]; deletedFiles?: string[] }): Promise<void>;
  fallbackPollMs?: number;
  debounceMs?: number;
}
type Active = {
  status: WatcherStatus;
  handle: WatcherHandle;
  debounce?: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
  recovering?: boolean;
  stopped?: boolean;
};

export class WorkspaceWatcherManager {
  private readonly active = new Map<string, Active>();
  private readonly starts = new Map<string, Promise<WatcherStatus>>();
  constructor(private readonly runtime: WatcherRuntime) {}

  async start(root: string): Promise<WatcherStatus> {
    const canonical = path.resolve(root);
    const key = getWorkspaceRootHash(canonical);
    const current = this.active.get(key);
    if (current && !current.stopped) return this.snapshot(current.status);
    const pending = this.starts.get(key);
    if (pending) return this.snapshot(await pending);
    const promise = this.startNew(canonical, key);
    this.starts.set(key, promise);
    try { return this.snapshot(await promise); }
    finally { if (this.starts.get(key) === promise) this.starts.delete(key); }
  }

  private async startNew(root: string, key: string): Promise<WatcherStatus> {
    const status: WatcherStatus = {
      root, rootHash: key, status: "starting", backend: "none",
      changedFiles: [], deletedFiles: [],
    };
    const notify: ChangeHandler = change => this.onChange(key, change);
    const failed: ErrorHandler = error => { void this.recover(key, error); };
    try {
      const handle = await this.runtime.startPrimary(root, notify, failed);
      status.status = "watching";
      status.backend = handle.backend;
      this.active.set(key, { status, handle });
    } catch (error) {
      const handle = await this.fallback(root, notify, failed);
      status.status = "degraded";
      status.backend = handle.backend;
      status.message = "Primary watcher unavailable: " + this.safeReason(error)
        + "; polling reconciliation enabled";
      const active: Active = { status, handle };
      this.active.set(key, active);
      this.startPolling(key, active);
    }
    return status;
  }

  private async fallback(root: string, notify: ChangeHandler, failed: ErrorHandler): Promise<WatcherHandle> {
    try { return await this.runtime.startFallback(root, notify, failed); }
    catch {
      // A failed native fallback is not a false healthy state: bounded polling still works.
      return { backend: "polling", close() {} };
    }
  }

  private async recover(key: string, error: Error): Promise<void> {
    const current = this.active.get(key);
    if (!current || current.stopped || current.recovering) return;
    current.recovering = true;
    current.status.status = "degraded";
    current.status.message = "Watcher error: " + this.safeReason(error)
      + "; switching to periodic reconciliation";
    const old = current.handle;
    try { await old.close(); } catch { /* failure remains visible in degraded state */ }
    if (current.stopped) return;
    try {
      current.handle = await this.fallback(
        current.status.root,
        event => this.onChange(key, event),
        subsequent => { current.status.message = "Fallback watcher error: " + this.safeReason(subsequent); },
      );
      current.status.backend = current.handle.backend;
      this.startPolling(key, current);
    } catch (fallbackError) {
      current.status.backend = "none";
      current.status.status = "unavailable";
      current.status.message = "All watcher mechanisms failed: " + this.safeReason(fallbackError);
    } finally { current.recovering = false; }
  }

  private onChange(key: string, change: WatcherEvent): void {
    const active = this.active.get(key);
    if (!active || active.stopped) return;
    const relative = path.relative(active.status.root, change.file).split(path.sep).join("/");
    if (!relative || relative === ".." || relative.startsWith("../") ||
      /(^|\/)(\.git|node_modules|dist|\.next|\.turbo|coverage|out)(\/|$)/.test(relative)) return;
    const status = active.status;
    status.lastEvent = change.event;
    const isDelete = change.type === "delete";
    const keyName = isDelete ? "deletedFiles" : "changedFiles";
    status[keyName] = [...new Set([...status[keyName], relative])].sort();
    void this.runtime.record(status.root, {
      event: change.event,
      ...(isDelete ? { deletedFiles: [relative] } : { changedFiles: [relative] }),
    }).catch(err => { status.message = "Could not mark stale: " + this.safeReason(err); });
    if (active.debounce) clearTimeout(active.debounce);
    active.debounce = setTimeout(() => { void this.reconcile(key, active); }, this.runtime.debounceMs ?? 750);
    active.debounce.unref();
  }

  private startPolling(key: string, active: Active): void {
    if (active.poll) clearInterval(active.poll);
    active.poll = setInterval(() => { void this.reconcile(key, active); }, this.runtime.fallbackPollMs ?? 5000);
    active.poll.unref();
  }

  private async reconcile(key: string, active: Active): Promise<void> {
    if (active.stopped || this.active.get(key) !== active) return;
    try {
      await this.runtime.reconcile(active.status.root);
      if (active.stopped) return;
      active.status.lastRefreshAt = new Date().toISOString();
      active.status.changedFiles = [];
      active.status.deletedFiles = [];
    } catch (error) {
      active.status.status = "degraded";
      active.status.message = "Reconciliation failed: " + this.safeReason(error);
    }
  }

  getStatus(root: string): WatcherStatus {
    const canonical = path.resolve(root);
    const entry = this.active.get(getWorkspaceRootHash(canonical));
    return entry ? this.snapshot(entry.status) : {
      root: canonical, rootHash: getWorkspaceRootHash(canonical),
      status: "stopped", backend: "none", changedFiles: [], deletedFiles: [],
    };
  }

  async stop(root: string): Promise<WatcherStatus> {
    const canonical = path.resolve(root);
    const key = getWorkspaceRootHash(canonical);
    const starting = this.starts.get(key);
    if (starting) await starting;
    const active = this.active.get(key);
    if (!active) return this.getStatus(canonical);
    active.stopped = true;
    if (active.poll) clearInterval(active.poll);
    if (active.debounce) clearTimeout(active.debounce);
    await active.handle.close();
    this.active.delete(key);
    return { ...this.snapshot(active.status), status: "stopped", backend: "none" };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.values()].map(entry => this.stop(entry.status.root)));
  }

  private safeReason(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
  }
  private snapshot(status: WatcherStatus): WatcherStatus {
    return { ...status, changedFiles: [...status.changedFiles], deletedFiles: [...status.deletedFiles] };
  }
}

async function primaryWatcher(root: string, changed: ChangeHandler, failed: ErrorHandler): Promise<WatcherHandle> {
  const { default: chokidar } = await import("chokidar");
  const watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])(\.git|node_modules|dist|\.next|\.turbo|coverage|out)([/\\]|$)/,
    ignoreInitial: true, persistent: true,
  });
  watcher.on("add", file => changed({ type: "change", file, event: "file.created" }));
  watcher.on("change", file => changed({ type: "change", file, event: "file.edited" }));
  watcher.on("unlink", file => changed({ type: "delete", file, event: "file.deleted" }));
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Watcher startup timed out"));
      }, 15000);
      timeout.unref();
      watcher.once("ready", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      });
      watcher.on("error", error => {
        if (settled) { failed(error instanceof Error ? error : new Error("Unknown watcher backend error")); return; }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
    });
  } catch (error) {
    await watcher.close();
    throw error;
  }
  return { backend: "chokidar", close: () => watcher.close() };
}

async function nativeFallback(root: string, changed: ChangeHandler, failed: ErrorHandler): Promise<WatcherHandle> {
  const watcher = fsWatch(root, { persistent: false }, (event, filename) => {
    if (!filename) return;
    // fs.watch is nonrecursive; polling provides the reliable nested-directory fallback.
    changed({ type: "change", file: path.join(root, String(filename)),
      event: event === "rename" ? "file.renamed" : "file.edited" });
  });
  watcher.on("error", failed);
  return { backend: "fs.watch", close() { watcher.close(); } };
}

const manager = new WorkspaceWatcherManager({
  startPrimary: primaryWatcher, startFallback: nativeFallback,
  reconcile: async root => { await refreshChangedFiles({ root }); },
  record: recordWorkspaceChange,
});

export async function watchWorkspaceMemory(options: WatchWorkspaceOptions = {}): Promise<WatcherStatus> {
  return manager.start(options.root || process.env.APEX_CONTEXT_ROOT || process.cwd());
}
export function getWatcherStatus(root = process.env.APEX_CONTEXT_ROOT || process.cwd()): WatcherStatus {
  return manager.getStatus(root);
}
export async function stopWorkspaceMemory(root = process.env.APEX_CONTEXT_ROOT || process.cwd()): Promise<WatcherStatus> {
  return manager.stop(root);
}
export async function stopAllWorkspaceWatchers(): Promise<void> { await manager.stopAll(); }

export async function refreshChangedWorkspaceFiles(options: WatchWorkspaceOptions = {}): Promise<string> {
  const index = await refreshChangedFiles({ root: options.root });
  return [
    "Apex changed-file refresh complete",
    "Root: " + index.root, "Changed: " + index.changedFiles.length,
    "Deleted: " + index.deletedFiles.length, "Files: " + index.fileCount,
    "Symbols: " + index.symbolCount, "Generated: " + index.generatedAt,
  ].join("\n");
}
