import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  getWorkspaceRootHash,
  recordWorkspaceChange,
  refreshChangedFiles,
} from "./indexer.js";

export interface WatchWorkspaceOptions {
  root?: string;
}

export interface WatcherStatus {
  root: string;
  rootHash: string;
  status: "watching" | "unavailable" | "stopped";
  backend: "chokidar" | "fs.watch" | "none";
  changedFiles: string[];
  deletedFiles: string[];
  lastEvent?: string;
  lastRefreshAt?: string;
  message?: string;
}

type CloseableWatcher = { close: () => Promise<void> | void };

const watchers = new Map<string, { watcher: CloseableWatcher; status: WatcherStatus }>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

export async function watchWorkspaceMemory(
  options: WatchWorkspaceOptions = {},
): Promise<WatcherStatus> {
  const root = path.resolve(options.root || process.env.APEX_CONTEXT_ROOT || process.cwd());
  const rootHash = getWorkspaceRootHash(root);
  const existing = watchers.get(rootHash);
  if (existing?.status.status === "watching") return existing.status;
  if (existing) {
    await existing.watcher.close();
    watchers.delete(rootHash);
  }

  const status: WatcherStatus = {
    root,
    rootHash,
    status: "watching",
    backend: "none",
    changedFiles: [],
    deletedFiles: [],
  };

  try {
    const watcher = await createChokidarWatcher(root, status);
    watchers.set(rootHash, { watcher, status });
    return status;
  } catch (err) {
    try {
      const watcher = createFsWatcher(root, status);
      watchers.set(rootHash, { watcher, status });
      return status;
    } catch (fallbackErr) {
      status.status = "unavailable";
      status.backend = "none";
      status.message = [
        err instanceof Error ? err.message : String(err),
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      ].join("; ");
      return status;
    }
  }
}

export async function refreshChangedWorkspaceFiles(
  options: WatchWorkspaceOptions = {},
): Promise<string> {
  const index = await refreshChangedFiles({ root: options.root });
  const status = watchers.get(index.rootHash)?.status;
  if (status) {
    status.changedFiles = [];
    status.deletedFiles = [];
    status.lastRefreshAt = new Date().toISOString();
  }

  return [
    "Apex changed-file refresh complete",
    `Root: ${index.root}`,
    `Changed: ${index.changedFiles.length}`,
    `Deleted: ${index.deletedFiles.length}`,
    `Files: ${index.fileCount}`,
    `Symbols: ${index.symbolCount}`,
    `Generated: ${index.generatedAt}`,
  ].join("\n");
}

/** Explicit, idempotent cleanup of watcher and outstanding refresh timer. */
export async function stopWorkspaceMemory(root = process.env.APEX_CONTEXT_ROOT || process.cwd()): Promise<WatcherStatus> {
  const canonical = path.resolve(root);
  const key = getWorkspaceRootHash(canonical);
  const active = watchers.get(key);
  const timer = debounceTimers.get(key);
  if (timer) clearTimeout(timer);
  debounceTimers.delete(key);
  if (!active) return getWatcherStatus(canonical);
  await active.watcher.close();
  watchers.delete(key);
  active.status.status = "stopped";
  active.status.backend = "none";
  return active.status;
}

export function getWatcherStatus(root = process.cwd()): WatcherStatus {
  const resolvedRoot = path.resolve(root);
  const rootHash = getWorkspaceRootHash(resolvedRoot);
  return (
    watchers.get(rootHash)?.status ?? {
      root: resolvedRoot,
      rootHash,
      status: "stopped",
      backend: "none",
      changedFiles: [],
      deletedFiles: [],
    }
  );
}

async function createChokidarWatcher(
  root: string,
  status: WatcherStatus,
): Promise<CloseableWatcher> {
  const chokidar = await import("chokidar");
  const watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])(\.git|node_modules|dist|\.next|\.turbo|coverage|out)([/\\]|$)/,
    ignoreInitial: true,
    persistent: true,
  });

  status.backend = "chokidar";
  watcher.on("add", (filePath) => queueChange(root, status, "file.created", filePath));
  watcher.on("change", (filePath) => queueChange(root, status, "file.edited", filePath));
  watcher.on("unlink", (filePath) => queueDelete(root, status, "file.deleted", filePath));
  watcher.on("error", (err) => {
    status.status = "unavailable";
    status.message = err instanceof Error ? err.message : String(err);
    const key = getWorkspaceRootHash(root);
    void (async () => {
      const active = watchers.get(key);
      if (!active || active.watcher !== watcher) return;
      try {
        await watcher.close();
        const replacement = createFsWatcher(root, status);
        status.status = "watching";
        status.message = "chokidar failed; using nonrecursive fs.watch fallback";
        watchers.set(key, { watcher: replacement, status });
      } catch (fallbackError) {
        status.backend = "none";
        status.status = "unavailable";
        status.message += "; fallback failed: " + String(fallbackError);
        watchers.delete(key);
      }
    })();
  });

  return watcher;
}

function createFsWatcher(root: string, status: WatcherStatus): CloseableWatcher {
  const watcher: FSWatcher = fsWatch(root, { persistent: true }, (event, filename) => {
    const relative = filename ? normalizePath(String(filename)) : "";
    if (!relative) {
      return;
    }

    if (event === "rename") {
      queueChange(root, status, "file.renamed", path.join(root, relative));
      return;
    }

    queueChange(root, status, "file.edited", path.join(root, relative));
  });

  status.backend = "fs.watch";
  return {
    close: () => watcher.close(),
  };
}

function queueChange(
  root: string,
  status: WatcherStatus,
  event: string,
  absolutePath: string,
): void {
  const relative = normalizePath(path.relative(root, absolutePath));
  if (shouldIgnore(relative)) {
    return;
  }

  status.lastEvent = event;
  status.changedFiles = uniqueStrings([...status.changedFiles, relative]);
  void recordWorkspaceChange(root, { event, changedFiles: [relative] });
  debounceRefresh(root);
}

function queueDelete(
  root: string,
  status: WatcherStatus,
  event: string,
  absolutePath: string,
): void {
  const relative = normalizePath(path.relative(root, absolutePath));
  if (shouldIgnore(relative)) {
    return;
  }

  status.lastEvent = event;
  status.deletedFiles = uniqueStrings([...status.deletedFiles, relative]);
  void recordWorkspaceChange(root, { event, deletedFiles: [relative] });
  debounceRefresh(root);
}

function debounceRefresh(root: string): void {
  const rootHash = getWorkspaceRootHash(root);
  const existing = debounceTimers.get(rootHash);
  if (existing) {
    clearTimeout(existing);
  }

  debounceTimers.set(
    rootHash,
    setTimeout(() => {
      void refreshChangedWorkspaceFiles({ root }).catch((error: unknown) => {
        const active = watchers.get(rootHash);
        if (active) active.status.message = "Watcher-triggered refresh failed: " + String(error);
      });
    }, 750),
  );
}

function shouldIgnore(relativePath: string): boolean {
  return /(^|\/)(\.git|node_modules|dist|\.next|\.turbo|coverage|out)(\/|$)/.test(
    relativePath,
  );
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
