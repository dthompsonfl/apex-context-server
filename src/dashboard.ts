import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWorkspaceIndex,
  type IndexedFile,
  type WorkspaceIndex,
} from "./indexer.js";
import {
  getWorkspaceTopology,
  type PackageMeta,
  type WorkspaceTopology,
} from "./topology.js";

export interface ApexDashboardOptions {
  root?: string;
  force?: boolean;
  maxPackages?: number;
  maxFiles?: number;
}

export async function primeWorkspaceContext(
  options: ApexDashboardOptions = {},
): Promise<string> {
  const root = resolveRoot(options.root);
  const guardState = await readGuardState(root);
  const [topology, index] = await Promise.all([
    getWorkspaceTopology(root),
    buildWorkspaceIndex({
      root,
      force: options.force ?? Boolean(guardState?.memoryStale),
    }),
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

export async function getContextHealth(
  options: ApexDashboardOptions = {},
): Promise<string> {
  return primeWorkspaceContext({ ...options, force: false, maxPackages: 8, maxFiles: 8 });
}

interface DashboardData {
  root: string;
  topology: WorkspaceTopology;
  index: WorkspaceIndex;
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
  const packages = Object.values(data.topology).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const languageCounts = countBy(data.index.files, (file) => file.language);
  const topSymbolFiles = [...data.index.files]
    .sort((a, b) => b.symbols.length - a.symbols.length || b.sizeBytes - a.sizeBytes)
    .slice(0, data.maxFiles);
  const topologyLines = packages
    .slice(0, data.maxPackages)
    .map(formatPackageLine);
  const fileLines = topSymbolFiles.map(formatFileLine);
  const guard = data.guardState;
  const status = getDashboardStatus(data.index, guard);

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
    "",
    "Visual Workflow",
    "---------------",
    "[1] prime_workspace_context -> [2] locate_code -> [3] read_component_context -> [4] targeted CLI only",
    "",
    "Token Discipline",
    "----------------",
    "- Do not run broad rg, grep, find, fd, tree, or ls -R commands for code discovery.",
    "- Use locate_code first. It checks memory maps for symbols, files, routes, imports, and content lines.",
    "- Use search_code for exact text search, find_symbol for exported symbols, and read_component_context before edits.",
    "- Use shell commands only after Apex narrows the exact file, command, or verification target.",
    "- Override the raw-search guard only with APEX_CONTEXT_ALLOW_RAW_SEARCH=1 when the shell is truly required.",
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
      : "No guard telemetry yet. It will appear after OpenCode loads the Apex TUI guard plugin.",
    "",
    "Workspace Packages",
    "------------------",
    topologyLines.length ? topologyLines.join("\n") : "(no apps/* or packages/* packages found)",
    packages.length > data.maxPackages
      ? `... ${packages.length - data.maxPackages} more package(s) omitted`
      : undefined,
    "",
    "Hot Files By Exported Symbols",
    "-----------------------------",
    fileLines.length ? fileLines.join("\n") : "(no source files indexed)",
    data.index.files.length > data.maxFiles
      ? `... ${data.index.files.length - data.maxFiles} more file(s) indexed`
      : undefined,
    "",
    "Language Coverage",
    "-----------------",
    Object.entries(languageCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([language, count]) => `- ${language}: ${count}`)
      .join("\n") || "(none)",
    "",
    "Recommended Next Tool",
    "---------------------",
    "- Architecture question: get_workspace_topology",
    "- Unknown location: locate_code",
    "- Exact text search: search_code",
    "- Component or API symbol lookup: find_symbol",
    "- Editing or explaining an exported node: read_component_context",
    "",
    "Machine Summary",
    "---------------",
    JSON.stringify(
      {
        status,
        root: data.root,
        packageCount: packages.length,
        fileCount: data.index.fileCount,
        symbolCount: data.index.symbolCount,
        lineCount: data.index.lineCount,
        tokenCount: data.index.tokenCount,
        indexPath: data.index.indexPath,
        generatedAt: data.index.generatedAt,
        guard: guard ?? null,
      },
      null,
      2,
    ),
  ];

  return dashboard
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function formatPackageLine(meta: PackageMeta): string {
  const deps = meta.internalDependencies.length
    ? meta.internalDependencies.join(", ")
    : "(none)";
  return `- ${meta.name} [${meta.path}] -> ${deps}`;
}

function formatFileLine(file: IndexedFile): string {
  return `- ${file.path} (${file.language}, ${file.symbols.length} symbol(s), ${formatBytes(
    file.sizeBytes,
  )})`;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function readGuardState(root: string): Promise<GuardState | null> {
  const statePath = path.join(
    process.env.OPENCODE_CONFIG_DIR ||
      path.join(os.homedir(), ".config", "opencode"),
    "apex-context-usage.json",
  );

  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as
      | GuardState
      | { workspaces?: Record<string, GuardState> };
    const rootHash = hashRoot(root);
    return "workspaces" in parsed
      ? parsed.workspaces?.[rootHash] ?? null
      : (parsed as GuardState);
  } catch {
    return null;
  }
}

function getDashboardStatus(index: WorkspaceIndex, guard: GuardState | null): string {
  if (!guard) return "INDEX AVAILABLE (guard not connected)";
  if (guard.memoryStale) return "STALE";
  if (
    index.diagnostics.skippedFiles.length > 0 ||
    index.diagnostics.parseFailures.length > 0 ||
    index.diagnostics.aliasResolutionFailures.length > 0
  ) {
    return "DEGRADED";
  }
  return "INDEX AVAILABLE (freshness checked per lookup)";
}

function hashRoot(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20);
}

function resolveRoot(root?: string): string {
  return path.resolve(root || process.env.APEX_CONTEXT_ROOT || process.cwd());
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
