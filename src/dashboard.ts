import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildWorkspaceIndex, type IndexedFile } from "./indexer.js";
import { getWorkspaceTopology, type PackageMeta, type WorkspaceTopology } from "./topology.js";
import { getOpenCodeConfigDir, hashRoot, resolveRoot } from "./paths.js";
import { getWatcherStatus } from "./watcher.js";

export interface ApexDashboardOptions {
  root?: string;
  force?: boolean;
  maxPackages?: number;
  maxFiles?: number;
}

export async function primeWorkspaceContext(options: ApexDashboardOptions = {}): Promise<string> {
  const root = resolveRoot(options.root);
  const guardState = await readGuardState(root);
  const [topology, index] = await Promise.all([
    getWorkspaceTopology(root),
    buildWorkspaceIndex({ root, force: options.force ?? Boolean(guardState?.memoryStale) }),
  ]);
  const refreshedGuardState = await readGuardState(root);
  return formatDashboard({
    root,
    topology,
    index,
    guardState: refreshedGuardState ?? guardState,
    maxPackages: clamp(options.maxPackages ?? 12, 1, 40),
    maxFiles: clamp(options.maxFiles ?? 12, 1, 40),
  });
}

export async function getContextHealth(options: ApexDashboardOptions = {}): Promise<string> {
  return primeWorkspaceContext({ ...options, force: false, maxPackages: 8, maxFiles: 8 });
}

interface DashboardData {
  root: string;
  topology: WorkspaceTopology;
  index: Awaited<ReturnType<typeof buildWorkspaceIndex>>;
  guardState: GuardState | null;
  maxPackages: number;
  maxFiles: number;
}

interface GuardState {
  apexToolCalls?: number;
  rawSearchBlocked?: number;
  rawSearchAllowed?: number;
  lastApexTool?: string;
  lastBlockedCommand?: string;
  memoryStale?: boolean;
  updatedAt?: string;
}

function formatDashboard(data: DashboardData): string {
  const packages = Object.values(data.topology).sort((a, b) => a.name.localeCompare(b.name));
  const languageCounts = countBy(data.index.files, (file) => file.language);
  const topSymbolFiles = [...data.index.files]
    .sort((a, b) => b.symbols.length - a.symbols.length || b.sizeBytes - a.sizeBytes)
    .slice(0, data.maxFiles);
  const topologyLines = packages.slice(0, data.maxPackages).map(formatPackageLine);
  const fileLines = topSymbolFiles.map(formatFileLine);
  const guard = data.guardState;
  const watcher = getWatcherStatus(data.root);
  const status = getDashboardStatus(data.index, guard, watcher.status);

  const dashboard: Array<string | undefined> = [
    "APEX CONTEXT TUI DASHBOARD",
    "==========================",
    "",
    `Status       : ${status}`,
    `Root         : ${data.root}`,
    `Memory       : ${data.index.fileCount} file(s), ${data.index.symbolCount} symbol(s), ${data.index.lineCount} line(s), ${data.index.tokenCount} token(s)`,
    `Cache        : ${data.index.indexPath}`,
    `Topology     : ${packages.length} workspace package(s)`,
    `Generated    : ${data.index.generatedAt}`,
    `Watcher      : ${watcher.status} (${watcher.backend})${watcher.lastEvent ? ` last=${watcher.lastEvent}` : ""}`,
    `Refresh      : ${data.index.diagnostics.lastRefreshKind} ${data.index.diagnostics.lastRefreshDurationMs}ms`,
    "",
    "Diagnostics",
    "-----------",
    `- Skipped files: ${data.index.diagnostics.skippedFiles.length}`,
    `- Parse failures: ${data.index.diagnostics.parseFailures.length}`,
    `- Large files ignored: ${data.index.diagnostics.largeFilesIgnored.length}`,
    `- Alias misses: ${data.index.diagnostics.aliasResolutionFailures.length}`,
    `- Secret redactions: ${data.index.diagnostics.secretRedactions.length}`,
    "",
    "Guard Telemetry",
    "---------------",
    guard
      ? [
          `Apex tool calls     : ${guard.apexToolCalls ?? 0}`,
          `Raw search blocked  : ${guard.rawSearchBlocked ?? 0}`,
          `Raw search allowed  : ${guard.rawSearchAllowed ?? 0}`,
          `Last Apex tool      : ${guard.lastApexTool ?? "(none)"}`,
          `Last blocked search : ${guard.lastBlockedCommand ?? "(none)"}`,
          `Memory stale        : ${guard.memoryStale ? "yes" : "no"}`,
          `Updated             : ${guard.updatedAt ?? "(unknown)"}`,
        ].join("\n")
      : "No guard telemetry yet. Guard health requires the OpenCode guard plugin to report usage.",
    "",
    "Workspace Packages",
    "------------------",
    topologyLines.length ? topologyLines.join("\n") : "(no apps/* or packages/* packages found)",
    packages.length > data.maxPackages ? `... ${packages.length - data.maxPackages} more package(s) omitted` : undefined,
    "",
    "Hot Files By Exported Symbols",
    "-----------------------------",
    fileLines.length ? fileLines.join("\n") : "(no source files indexed)",
    data.index.files.length > data.maxFiles ? `... ${data.index.files.length - data.maxFiles} more file(s) indexed` : undefined,
    "",
    "Language Coverage",
    "-----------------",
    Object.entries(languageCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([language, count]) => `- ${language}: ${count}`).join("\n") || "(none)",
    "",
    "Machine Summary",
    "---------------",
    JSON.stringify({
      status, root: data.root, packageCount: packages.length,
      fileCount: data.index.fileCount, symbolCount: data.index.symbolCount,
      lineCount: data.index.lineCount, tokenCount: data.index.tokenCount,
      indexPath: data.index.indexPath, generatedAt: data.index.generatedAt,
      watcher, guard: guard ?? null,
      diagnostics: {
        skippedFiles: data.index.diagnostics.skippedFiles.length,
        parseFailures: data.index.diagnostics.parseFailures.length,
        aliasResolutionFailures: data.index.diagnostics.aliasResolutionFailures.length,
        secretRedactions: data.index.diagnostics.secretRedactions.length,
      },
    }, null, 2),
  ];

  return dashboard.filter((line): line is string => line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
}

function formatPackageLine(meta: PackageMeta): string {
  const deps = meta.internalDependencies.length ? meta.internalDependencies.join(", ") : "(none)";
  return `- ${meta.name} [${meta.path}] -> ${deps}`;
}

function formatFileLine(file: IndexedFile): string {
  return `- ${file.path} (${file.language}, ${file.symbols.length} symbol(s), ${formatBytes(file.sizeBytes)})`;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) { const key = keyFn(item); counts[key] = (counts[key] ?? 0) + 1; }
  return counts;
}

async function readGuardState(root: string): Promise<GuardState | null> {
  const statePath = path.join(getOpenCodeConfigDir(), "apex-context-usage.json");
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as GuardState | { workspaces?: Record<string, GuardState> };
    const rootHash = hashRoot(root);
    return "workspaces" in parsed ? parsed.workspaces?.[rootHash] ?? null : (parsed as GuardState);
  } catch { return null; }
}

function getDashboardStatus(
  index: Awaited<ReturnType<typeof buildWorkspaceIndex>>,
  guard: GuardState | null,
  watcherStatus: string,
): string {
  if (guard?.memoryStale) return "STALE";
  if (index.diagnostics.parseFailures.length > 0 || index.diagnostics.aliasResolutionFailures.length > 0) return "DEGRADED";
  if (!guard) return watcherStatus === "watching" ? "INDEXED_NO_GUARD" : "INDEXED_NO_GUARD";
  if (watcherStatus === "unavailable") return "DEGRADED_WATCHER";
  return "ACTIVE";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
