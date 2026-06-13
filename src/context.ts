import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractComponentContext } from "./ast.js";
import {
  buildWorkspaceIndex,
  createWorkspaceMemorySnapshot,
  locateCode,
  type IndexedFile,
  type IndexedLine,
  type WorkspaceIndex,
} from "./indexer.js";
import { getWorkspaceTopology } from "./topology.js";

export interface AgentBootContextOptions {
  root?: string;
  maxFiles?: number;
}

export interface ContextBundleOptions {
  root?: string;
  query?: string;
  filepath?: string;
  nodeName?: string;
  maxRelated?: number;
}

export async function getAgentBootContext(
  options: AgentBootContextOptions = {},
): Promise<string> {
  const index = await buildWorkspaceIndex({ root: options.root });
  const topology = await getWorkspaceTopology(index.root);
  const snapshot = createWorkspaceMemorySnapshot(index, options.maxFiles ?? 20);
  const diagnostics = index.diagnostics;

  return [
    "Apex Agent Boot Context",
    "=======================",
    "",
    `Workspace root : ${index.root}`,
    `Memory cache   : ${index.indexPath}`,
    `Generated      : ${index.generatedAt}`,
    `Files          : ${index.fileCount}`,
    `Symbols        : ${index.symbolCount}`,
    `Lines          : ${index.lineCount}`,
    `Tokens         : ${index.tokenCount}`,
    `Packages       : ${Object.keys(topology).length}`,
    `Diagnostics    : ${diagnostics.skippedFiles.length} skipped, ${diagnostics.parseFailures.length} parse failure(s), ${diagnostics.secretRedactions.length} redaction(s)`,
    "",
    "Entry Files",
    "-----------",
    snapshot.entryFiles.length
      ? snapshot.entryFiles.map((file) => `- ${file.path} (${file.reason})`).join("\n")
      : "(none detected)",
    "",
    "Routes",
    "------",
    snapshot.routeFiles.length
      ? snapshot.routeFiles.map((file) => `- ${file.path} (${file.routeKind})`).join("\n")
      : "(none detected)",
    "",
    "Top Symbol Files",
    "----------------",
    snapshot.topSymbolFiles
      .map((file) => `- ${file.path} (${file.symbols} symbol(s))`)
      .join("\n") || "(none)",
    "",
    "Required Flow",
    "-------------",
    "1. Use locate_code for unknown locations.",
    "2. Use read_context_bundle for edit-ready context.",
    "3. Use read_component_context when a specific exported symbol is known.",
    "4. Use shell only for targeted verification after Apex narrows the target.",
  ].join("\n");
}

export async function readContextBundle(
  options: ContextBundleOptions = {},
): Promise<string> {
  const index = await buildWorkspaceIndex({ root: options.root });
  const target = await resolveBundleTarget(index, options);
  if (!target) {
    throw new Error("Could not resolve a bundle target from filepath, nodeName, or query.");
  }

  const relatedTests = findRelatedFiles(index, target, ["test", "spec"]);
  const relatedDocs = findRelatedFiles(index, target, ["md", "mdx"]);
  const packageMeta = await readNearestPackageJson(index.root, target.path);
  const nearbyLines = getNearbyLines(index, target, options.nodeName);
  const componentContext =
    options.nodeName && target.path
      ? await extractComponentContext(path.join(index.root, target.path), options.nodeName).catch(
          (err) => `Component context unavailable: ${err instanceof Error ? err.message : String(err)}`,
        )
      : "";

  return [
    "Apex Context Bundle",
    "===================",
    "",
    `Target        : ${target.path}`,
    `Language      : ${target.language}`,
    `Hash          : ${target.contentHash}`,
    `Modified      : ${target.modifiedTime}`,
    `Package       : ${packageMeta?.name ?? "(unknown)"}`,
    `Route kind    : ${target.routeKind ?? "(none)"}`,
    "",
    "Exports",
    "-------",
    target.symbols.length
      ? target.symbols
          .map((symbol) => `- ${symbol.name} (${symbol.kind}) at ${symbol.line}:${symbol.column}`)
          .join("\n")
      : "(none)",
    "",
    "Imports",
    "-------",
    target.imports.length ? target.imports.map((specifier) => `- ${specifier}`).join("\n") : "(none)",
    "",
    "Importers",
    "---------",
    target.importedBy.length ? target.importedBy.map((file) => `- ${file}`).join("\n") : "(none)",
    "",
    "Related Tests",
    "-------------",
    relatedTests.length ? relatedTests.map((file) => `- ${file.path}`).join("\n") : "(none)",
    "",
    "Related Docs",
    "------------",
    relatedDocs.length ? relatedDocs.map((file) => `- ${file.path}`).join("\n") : "(none)",
    "",
    "Nearby Source",
    "-------------",
    nearbyLines.length
      ? nearbyLines.map((line) => `${line.line}: ${line.text}`).join("\n")
      : "(not available)",
    componentContext ? `\n${componentContext}` : "",
  ].join("\n");
}

async function resolveBundleTarget(
  index: WorkspaceIndex,
  options: ContextBundleOptions,
): Promise<IndexedFile | null> {
  if (options.filepath) {
    const normalizedPath = normalizePath(path.relative(index.root, path.resolve(index.root, options.filepath)));
    return (
      index.files.find((file) => file.path === normalizedPath || file.path === options.filepath) ??
      null
    );
  }

  if (options.nodeName) {
    const symbol = index.symbols.find(
      (candidate) =>
        candidate.name === options.nodeName || candidate.exportName === options.nodeName,
    );
    return symbol ? index.files[symbol.fileId] ?? null : null;
  }

  if (options.query) {
    const lookup = await locateCode(options.query, { root: index.root, maxResults: 1 });
    const first = lookup.matches[0];
    return first ? index.files.find((file) => file.path === first.file) ?? null : null;
  }

  return null;
}

function findRelatedFiles(
  index: WorkspaceIndex,
  target: IndexedFile,
  markers: string[],
): IndexedFile[] {
  const base = target.basename.replace(/\.[^.]+$/, "").toLowerCase();
  return index.files
    .filter((file) => file.path !== target.path)
    .filter((file) => {
      const lower = file.path.toLowerCase();
      return markers.some((marker) => lower.includes(marker)) && lower.includes(base);
    })
    .slice(0, 12);
}

function getNearbyLines(
  index: WorkspaceIndex,
  target: IndexedFile,
  nodeName?: string,
): IndexedLine[] {
  const symbol = nodeName
    ? target.symbols.find((candidate) => candidate.name === nodeName || candidate.exportName === nodeName)
    : target.symbols[0];
  const center = symbol?.line ?? 1;
  return index.lines
    .filter((line) => line.fileId === target.id)
    .filter((line) => Math.abs(line.line - center) <= 12)
    .slice(0, 30);
}

async function readNearestPackageJson(
  root: string,
  relativeFile: string,
): Promise<{ name?: string; version?: string } | null> {
  let dir = path.dirname(path.join(root, relativeFile));

  while (dir.startsWith(root)) {
    try {
      return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
    } catch {
      dir = path.dirname(dir);
    }
  }

  return null;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}
