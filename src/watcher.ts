import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  getWorkspaceRootHash,
  recordWorkspaceChange,
  refreshChangedFiles,
} from "./indexer.js";
import { resolveRoot } from "./paths.js";

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
  const root = resolveRoot(options.root);
  const rootHash = getWorkspaceRootHash(root);
  const existing = watchers.get(rootHash);
  if (existing) return existing.status;

  const status: WatcherStatus = {
    root, rootHash, status: "watching", backend: "none", changedFiles: [], deletedFiles: [],
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
      status.message = [err instanceof Error ? err.message : String(err), fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)].join("; ");
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

export function getWatcherStatus(root = process.cwd()): WatcherStatus {
  const resolvedRoot = resolveRoot(root);
  const rootHash = getWorkspaceRootHash(resolvedRoot);
  return (
    watchers.get(rootHash)?.status ?? {
      root: resolvedRoot, rootHash, status: "stopped", backend: "none", changedFiles: [], deletedFiles: [],
    }
  );
}

export async function stopAllWatchers(): Promise<void> {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  for (const entry of watchers.values()) {
    try { await entry.watcher.close(); } catch {}
    entry.status.status = "stopped";
  }
  watchers.clear();
}

async function createChokidarWatcher(root: string, status: WatcherStatus): Promise<CloseableWatcher> {
  const chokidar = await import("chokidar");
  const watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])(\.git|node_modules|dist|\.next|\.turbo|coverage|out)([/\\]|$)/,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  status.backend = "chokidar";
  watcher.on("add", (filePath) => queueChange(root, status, "file.created", filePath));
  watcher.on("change", (filePath) => queueChange(root, status, "file.edited", filePath));
  watcher.on("unlink", (filePath) => queueDelete(root, status, "file.deleted", filePath));
  watcher.on("error", (err) => {
    status.status = "unavailable";
    status.message = err instanceof Error ? err.message : String(err);
  });
  return watcher;
}

function createFsWatcher(root: string, status: WatcherStatus): CloseableWatcher {
  const watcher: FSWatcher = fsWatch(root, { persistent: true, recursive: true }, (event, filename) => {
    const relative = filename ? normalizePath(String(filename)) : "";
    if (!relative) return;
    if (event === "rename") queueChange(root, status, "file.renamed", path.join(root, relative));
    else queueChange(root, status, "file.edited", path.join(root, relative));
  });
  status.backend = "fs.watch";
  return { close: () => watcher.close() };
}

function queueChange(root: string, status: WatcherStatus, event: string, absolutePath: string): void {
  const relative = normalizePath(path.relative(root, absolutePath));
  if (shouldIgnore(relative)) return;
  status.lastEvent = event;
  status.changedFiles = uniqueStrings([...status.changedFiles, relative]);
  void recordWorkspaceChange(root, { event, changedFiles: [relative] });
  debounceRefresh(root);
}

function queueDelete(root: string, status: WatcherStatus, event: string, absolutePath: string): void {
  const relative = normalizePath(path.relative(root, absolutePath));
  if (shouldIgnore(relative)) return;
  status.lastEvent = event;
  status.deletedFiles = uniqueStrings([...status.deletedFiles, relative]);
  void recordWorkspaceChange(root, { event, deletedFiles: [relative] });
  debounceRefresh(root);
}

function debounceRefresh(root: string): void {
  const rootHash = getWorkspaceRootHash(root);
  const existing = debounceTimers.get(rootHash);
  if (existing) clearTimeout(existing);
  debounceTimers.set(rootHash, setTimeout(() => {
    void refreshChangedWorkspaceFiles({ root }).catch(() => undefined);
  }, 750));
}

function shouldIgnore(relativePath: string): boolean {
  return /(^|\/)(\.git|node_modules|dist|\.next|\.turbo|coverage|out)(\/|$)/.test(relativePath);
}

function normalizePath(value: string): string { return value.split(path.sep).join("/"); }
function uniqueStrings(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
