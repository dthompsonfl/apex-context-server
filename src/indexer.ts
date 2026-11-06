import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Node, Project, SourceFile, SyntaxKind } from "ts-morph";
import type {
  BuildIndexOptions,
  FindSymbolOptions,
  GitSnapshot,
  IndexDiagnostics,
  IndexedFile,
  IndexedFileFingerprint,
  IndexedLine,
  IndexedSymbol,
  LocateCodeOptions,
  MemoryLocation,
  MemoryLookupResult,
  SearchOptions,
  SearchResult,
  SymbolSearchResult,
  WorkspaceIndex,
  WorkspaceMemorySnapshot,
} from "./indexer-types.js";
import {
  getOpenCodeConfigDir,
  hashRoot,
  isSensitivePath,
  MAX_GLOB_PATTERN_CHARS,
  MAX_INDEXED_FILE_BYTES,
  MAX_SEARCH_QUERY_CHARS,
  normalizePath,
  resolveRoot,
  toRelativePath,
} from "./paths.js";
import { redactText } from "./redact.js";

export type * from "./indexer-types.js";

const INDEX_SCHEMA_VERSION = 6;
const MAX_RESULTS = 200;
const JSONC_COMMENTS = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;
const JSONC_TRAILING_COMMAS = /,\s*([}\]])/g;

const CODE_EXTENSIONS =
  "ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,mdx,css,scss,prisma,sql,graphql,gql,yaml,yml,toml,sh,bash,py,go,rs,php,vue,svelte,astro";

const DEFAULT_PATTERNS = [
  `apps/**/*.{${CODE_EXTENSIONS}}`,
  `packages/**/*.{${CODE_EXTENSIONS}}`,
  `services/**/*.{${CODE_EXTENSIONS}}`,
  `libs/**/*.{${CODE_EXTENSIONS}}`,
  `tools/**/*.{${CODE_EXTENSIONS}}`,
  `workers/**/*.{${CODE_EXTENSIONS}}`,
  "supabase/**/*.{sql,ts,tsx,mts,cts,js,json,md,yaml,yml}",
  "prisma/**/*.{prisma,sql,ts,js,json,md}",
  ".github/workflows/*.{yaml,yml}",
  `src/**/*.{${CODE_EXTENSIONS}}`,
  `*.{${CODE_EXTENSIONS}}`,
  "*.config.{js,cjs,mjs,ts,mts,cts}",
  "Dockerfile",
  "docker-compose.{yaml,yml}",
  ".env.example",
  "*.env.example",
  "tsconfig*.json",
  "turbo.json",
  "nx.json",
  "rush.json",
  "lerna.json",
  "pnpm-workspace.yaml",
];

const IGNORE_PATTERNS = [
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/build/**",
  "**/coverage/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/out/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/.env",
  "**/.env.*",
  "!**/.env.example",
  "!**/*.env.example",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/.npmrc",
  "**/.pypirc",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
];

const INDEXABLE_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SEARCHABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".prisma",
  ".sql",
  ".graphql",
  ".gql",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".bash",
  ".py",
  ".go",
  ".rs",
  ".php",
  ".vue",
  ".svelte",
  ".astro",
]);

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

let cachedIndex: WorkspaceIndex | null = null;
const buildLocks = new Map<string, Promise<WorkspaceIndex>>();

export async function buildWorkspaceIndex(
  options: BuildIndexOptions = {},
): Promise<WorkspaceIndex> {
  const root = resolveRoot(options.root);
  const key = hashRoot(root);
  const running = buildLocks.get(key);
  if (running) return running;
  const p = buildWorkspaceIndexUnlocked(options).finally(() => {
    if (buildLocks.get(key) === p) buildLocks.delete(key);
  });
  buildLocks.set(key, p);
  return p;
}

async function buildWorkspaceIndexUnlocked(
  options: BuildIndexOptions = {},
): Promise<WorkspaceIndex> {
  const startedAt = Date.now();
  const root = resolveRoot(options.root);
  const indexPath = getIndexPath(root);
  const forceRefresh = options.force || (await isWorkspaceMemoryMarkedStale(root));

  if (!forceRefresh) {
    if (cachedIndex?.root === root && (await isPersistedIndexFresh(cachedIndex))) {
      cachedIndex.diagnostics.lastRefreshKind = "cache";
      return cachedIndex;
    }

    const persisted = await readPersistedIndex(root, indexPath);
    if (persisted) {
      cachedIndex = persisted;
      return persisted;
    }
  }

  const patterns = options.patterns?.length ? options.patterns : DEFAULT_PATTERNS;
  const files = await fg(patterns, {
    absolute: true,
    cwd: root,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
  });
  const aliases = await readTsConfigAliases(root, files);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });

  const indexedFiles: IndexedFile[] = [];
  const symbols: IndexedSymbol[] = [];
  const lines: IndexedLine[] = [];
  const tokenIndex: Record<string, number[]> = {};
  const symbolNameIndex: Record<string, number[]> = {};
  const symbolTokenIndex: Record<string, number[]> = {};
  const pathTokenIndex: Record<string, number[]> = {};
  const importTokenIndex: Record<string, number[]> = {};
  const manifest: Record<string, IndexedFileFingerprint> = {};
  const diagnostics = createDiagnostics("full");

  for (const absolutePath of files.sort()) {
    const ext = path.extname(absolutePath);
    if (!SEARCHABLE_EXTENSIONS.has(ext)) continue;
    const relativePath = toRelativePath(root, absolutePath);
    if (isSensitivePath(relativePath)) {
      diagnostics.skippedFiles.push({ path: relativePath, reason: "Sensitive file excluded from indexing." });
      continue;
    }

    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_INDEXED_FILE_BYTES) {
        diagnostics.largeFilesIgnored.push({ path: relativePath, reason: `File exceeds ${MAX_INDEXED_FILE_BYTES} bytes.` });
        continue;
      }
      const text = await readFile(absolutePath, "utf8");
      const contentHash = hashContent(text);
      let sourceFile: SourceFile | undefined;
      if (INDEXABLE_SOURCE_EXTENSIONS.has(ext)) {
        try {
          sourceFile = project.addSourceFileAtPathIfExists(absolutePath);
        } catch (err) {
          diagnostics.parseFailures.push({ path: relativePath, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      const fileId = indexedFiles.length;
      const fileSymbols = sourceFile
        ? extractCodeSymbols(sourceFile, root, fileId, symbols.length)
        : [];
      const imports = sourceFile ? extractImports(sourceFile) : [];

      const indexedFile: IndexedFile = {
        id: fileId,
        path: relativePath,
        absolutePath,
        basename: path.basename(relativePath),
        extension: ext,
        language: languageForExtension(ext),
        sizeBytes: fileStat.size,
        modifiedTime: fileStat.mtime.toISOString(),
        modifiedTimeMs: fileStat.mtimeMs,
        contentHash,
        indexedAt: new Date().toISOString(),
        routeKind: inferRouteKind(relativePath),
        packageName: extractPackageName(relativePath, text),
        imports,
        resolvedImports: [],
        importedBy: [],
        symbols: fileSymbols,
      };

      indexedFiles.push(indexedFile);
      manifest[relativePath] = {
        path: relativePath,
        sizeBytes: fileStat.size,
        modifiedTimeMs: fileStat.mtimeMs,
        contentHash,
      };
      symbols.push(...fileSymbols);
      addFileTokens(pathTokenIndex, indexedFile);
      addImportTokens(importTokenIndex, fileId, imports);
      addSymbolTokens(symbolNameIndex, symbolTokenIndex, fileSymbols);
      addContentLines(tokenIndex, lines, indexedFile, text, diagnostics);
    } catch (err) {
      diagnostics.skippedFiles.push({
        path: relativePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  attachResolvedImportGraph(indexedFiles, aliases, diagnostics);
  diagnostics.lastRefreshDurationMs = Date.now() - startedAt;
  diagnostics.lastIndexedAt = new Date().toISOString();
  diagnostics.lastRefreshAt = diagnostics.lastIndexedAt;

  const index: WorkspaceIndex = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    root,
    rootHash: hashRoot(root),
    indexPath,
    generatedAt: new Date().toISOString(),
    fileCount: indexedFiles.length,
    symbolCount: symbols.length,
    lineCount: lines.length,
    tokenCount: Object.keys(tokenIndex).length,
    manifest,
    changedFiles: [],
    deletedFiles: [],
    git: await readGitSnapshot(root),
    diagnostics,
    files: indexedFiles,
    symbols,
    lines,
    tokenIndex,
    symbolNameIndex,
    symbolTokenIndex,
    pathTokenIndex,
    importTokenIndex,
  };

  await writePersistedIndex(index);
  await clearWorkspaceMemoryStale(root);
  cachedIndex = index;
  return index;
}

export async function refreshChangedFiles(
  options: BuildIndexOptions = {},
): Promise<WorkspaceIndex> {
  const root = resolveRoot(options.root);
  const existing = await readPersistedIndexUnchecked(root, getIndexPath(root));
  const diff = existing ? await diffWorkspaceFiles(existing) : null;
  const index = await buildWorkspaceIndex({ ...options, root, force: true });
  index.changedFiles = uniqueStrings([
    ...(diff?.changedFiles ?? []),
    ...(diff?.addedFiles ?? []),
  ]);
  index.deletedFiles = diff?.deletedFiles ?? [];
  index.diagnostics.lastRefreshKind = diff ? "incremental" : "full";
  index.diagnostics.fileChangeSummary = {
    changed: diff?.changedFiles.length ?? 0,
    added: diff?.addedFiles.length ?? 0,
    deleted: diff?.deletedFiles.length ?? 0,
  };
  await writePersistedIndex(index);
  cachedIndex = index;
  return index;
}

export async function getIndexDiagnostics(
  options: BuildIndexOptions = {},
): Promise<IndexDiagnostics & { root: string; rootHash: string; indexPath: string }> {
  const index = await buildWorkspaceIndex(options);
  return {
    ...index.diagnostics,
    root: index.root,
    rootHash: index.rootHash,
    indexPath: index.indexPath,
  };
}

export interface WorkspaceDiff {
  changedFiles: string[];
  deletedFiles: string[];
  addedFiles: string[];
}

export async function diffWorkspaceFiles(index: WorkspaceIndex): Promise<WorkspaceDiff> {
  const currentFiles = await discoverCurrentFiles(index.root);
  const currentSet = new Set(currentFiles.map((file) => toRelativePath(index.root, file)));
  const knownSet = new Set(Object.keys(index.manifest));
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const addedFiles: string[] = [];

  for (const knownPath of knownSet) {
    if (!currentSet.has(knownPath)) deletedFiles.push(knownPath);
  }

  for (const currentPath of currentSet) {
    if (!knownSet.has(currentPath)) {
      addedFiles.push(currentPath);
      continue;
    }
    const fingerprint = index.manifest[currentPath];
    const absolutePath = path.join(index.root, currentPath);
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size !== fingerprint.sizeBytes || fileStat.mtimeMs !== fingerprint.modifiedTimeMs) {
        const text = await readFile(absolutePath, "utf8");
        if (hashContent(text) !== fingerprint.contentHash) changedFiles.push(currentPath);
      }
    } catch {
      deletedFiles.push(currentPath);
    }
  }

  return {
    changedFiles: uniqueStrings(changedFiles),
    deletedFiles: uniqueStrings(deletedFiles),
    addedFiles: uniqueStrings(addedFiles),
  };
}

export async function recordWorkspaceChange(
  root: string,
  details: { event: string; changedFiles?: string[]; deletedFiles?: string[] },
): Promise<void> {
  await markWorkspaceMemoryStale(resolveRoot(root), details);
}

export function getWorkspaceRootHash(root: string): string {
  return hashRoot(resolveRoot(root));
}

export async function searchCode(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  if (!query) throw new Error("A non-empty query is required.");
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error(`Query exceeds ${MAX_SEARCH_QUERY_CHARS} characters.`);
  }

  const root = resolveRoot(options.root);
  const maxResults = clamp(options.maxResults ?? 50, 1, MAX_RESULTS);
  const workspaceIndex = await buildWorkspaceIndex({ root });
  const allowedFileIds = await resolveGlobbedFileIds(workspaceIndex, options.glob);
  const matches: SearchResult["matches"] = [];
  const candidateLineIds = options.regex
    ? workspaceIndex.lines.map((line) => line.id)
    : getCandidateLineIds(workspaceIndex, query);
  const matcher = createLineMatcher(query, options);

  for (const lineId of candidateLineIds) {
    const line = workspaceIndex.lines[lineId];
    if (!line || (allowedFileIds && !allowedFileIds.has(line.fileId))) continue;
    for (const column of matcher(line.text)) {
      matches.push({ file: line.file, line: line.line, column, text: line.text });
      if (matches.length >= maxResults) {
        return toSearchResult(query, root, workspaceIndex, matches, true);
      }
    }
  }

  return toSearchResult(query, root, workspaceIndex, matches, false);
}

export async function findSymbol(
  query: string,
  options: FindSymbolOptions = {},
): Promise<SymbolSearchResult> {
  if (!query) throw new Error("A non-empty symbol query is required.");
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error(`Symbol query exceeds ${MAX_SEARCH_QUERY_CHARS} characters.`);
  }

  const root = resolveRoot(options.root);
  const maxResults = clamp(options.maxResults ?? 50, 1, MAX_RESULTS);
  const workspaceIndex = await buildWorkspaceIndex({ root });
  const normalizedQuery = normalizeLookup(query);
  const symbolIds = options.exact
    ? workspaceIndex.symbolNameIndex[normalizedQuery] ?? []
    : getCandidateSymbolIds(workspaceIndex, query);
  const matches = symbolIds
    .map((id) => workspaceIndex.symbols[id])
    .filter((symbol): symbol is IndexedSymbol => Boolean(symbol))
    .filter((symbol) => {
      if (options.exact) {
        return (
          normalizeLookup(symbol.name) === normalizedQuery ||
          normalizeLookup(symbol.exportName) === normalizedQuery
        );
      }
      return (
        normalizeLookup(symbol.name).includes(normalizedQuery) ||
        normalizeLookup(symbol.exportName).includes(normalizedQuery)
      );
    })
    .sort((a, b) => rankSymbol(query, b) - rankSymbol(query, a))
    .slice(0, maxResults);

  return {
    query,
    root,
    source: "apex-memory",
    generatedAt: workspaceIndex.generatedAt,
    matchCount: matches.length,
    truncated: matches.length >= maxResults,
    matches,
  };
}

export async function locateCode(
  query: string,
  options: LocateCodeOptions = {},
): Promise<MemoryLookupResult> {
  if (!query) throw new Error("A non-empty lookup query is required.");
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error(`Lookup query exceeds ${MAX_SEARCH_QUERY_CHARS} characters.`);
  }

  const root = resolveRoot(options.root);
  const maxResults = clamp(options.maxResults ?? 25, 1, MAX_RESULTS);
  const workspaceIndex = await buildWorkspaceIndex({ root });
  const kind = options.kind ?? "any";
  const locations = new Map<string, MemoryLocation>();

  if (kind === "any" || kind === "symbol") addSymbolLocations(workspaceIndex, query, locations);
  if (kind === "any" || kind === "file" || kind === "route") addFileLocations(workspaceIndex, query, kind, locations);
  if (kind === "any" || kind === "import") addImportLocations(workspaceIndex, query, locations);
  if (kind === "any" || kind === "line") addLineLocations(workspaceIndex, query, locations);

  const matches = [...locations.values()]
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxResults);

  return {
    query,
    root,
    source: "apex-memory",
    generatedAt: workspaceIndex.generatedAt,
    matchCount: matches.length,
    truncated: locations.size > maxResults,
    matches,
  };
}

export function createWorkspaceMemorySnapshot(
  index: WorkspaceIndex,
  maxFiles = 25,
): WorkspaceMemorySnapshot {
  const topSymbolFiles = [...index.files]
    .sort(
      (a, b) =>
        b.symbols.length - a.symbols.length ||
        b.importedBy.length - a.importedBy.length ||
        a.path.localeCompare(b.path),
    )
    .slice(0, maxFiles)
    .map((file) => ({
      path: file.path,
      language: file.language,
      symbols: file.symbols.length,
      imports: file.resolvedImports.length || file.imports.length,
      importedBy: file.importedBy.length,
    }));

  const routeFiles = index.files
    .filter((file) => file.routeKind)
    .slice(0, maxFiles)
    .map((file) => ({ path: file.path, routeKind: file.routeKind ?? "route", symbols: file.symbols.length }));

  const entryFiles = index.files
    .filter(isLikelyEntryFile)
    .slice(0, maxFiles)
    .map((file) => ({ path: file.path, reason: entryReason(file) }));

  return {
    root: index.root,
    rootHash: index.rootHash,
    indexPath: index.indexPath,
    generatedAt: index.generatedAt,
    counts: {
      files: index.fileCount,
      symbols: index.symbolCount,
      lines: index.lineCount,
      tokens: index.tokenCount,
    },
    topSymbolFiles,
    routeFiles,
    entryFiles,
  };
}

export function formatIndexSummary(index: WorkspaceIndex): string {
  return [
    `Workspace Memory - ${index.fileCount} file(s), ${index.symbolCount} symbol(s), ${index.lineCount} searchable line(s)`,
    `Tokens: ${index.tokenCount}`,
    `Root: ${index.root}`,
    `Index: ${index.indexPath}`,
    `Generated: ${index.generatedAt}`,
  ].join("\n");
}

export function formatMemorySummary(index: WorkspaceIndex): string {
  const snapshot = createWorkspaceMemorySnapshot(index, 15);
  const lines = [
    "Apex Workspace Memory",
    "---------------------",
    `Root       : ${snapshot.root}`,
    `Index      : ${snapshot.indexPath}`,
    `Generated  : ${snapshot.generatedAt}`,
    `Files      : ${snapshot.counts.files}`,
    `Symbols    : ${snapshot.counts.symbols}`,
    `Lines      : ${snapshot.counts.lines}`,
    `Tokens     : ${snapshot.counts.tokens}`,
    "",
    "Top Symbol Files",
    "----------------",
    snapshot.topSymbolFiles.length
      ? snapshot.topSymbolFiles
          .map((file) => `- ${file.path} (${file.symbols} symbol(s), imported by ${file.importedBy})`)
          .join("\n")
      : "(none)",
    "",
    "Likely Entry Files",
    "------------------",
    snapshot.entryFiles.length
      ? snapshot.entryFiles.map((file) => `- ${file.path} (${file.reason})`).join("\n")
      : "(none)",
  ];
  return lines.join("\n");
}

function extractImports(sourceFile: SourceFile): string[] {
  const imports = new Set<string>();
  for (const decl of sourceFile.getImportDeclarations()) imports.add(decl.getModuleSpecifierValue());
  for (const decl of sourceFile.getExportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    if (specifier) imports.add(specifier);
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression().getText();
    const firstArg = call.getArguments()[0];
    const literal = getStringLiteralValue(firstArg);
    if (!literal) continue;
    if (expression === "require" || expression === "import") imports.add(literal);
  }
  return [...imports].sort();
}

function getStringLiteralValue(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  return null;
}

function extractCodeSymbols(
  sourceFile: SourceFile,
  root: string,
  fileId: number,
  firstSymbolId: number,
): IndexedSymbol[] {
  const relativeFile = toRelativePath(root, sourceFile.getFilePath());
  const exportedByStart = new Map<number, string[]>();
  for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      const textNode = expandDeclarationTextNode(declaration);
      const names = exportedByStart.get(textNode.getStart()) ?? [];
      names.push(exportName);
      exportedByStart.set(textNode.getStart(), names);
    }
  }

  const symbols: IndexedSymbol[] = [];
  const seen = new Set<string>();
  for (const declaration of sourceFile.getDescendants()) {
    if (!isSupportedSymbolDeclaration(declaration)) continue;
    const textNode = expandDeclarationTextNode(declaration);
    if (!isTopLevelDeclaration(textNode) && !exportedByStart.has(textNode.getStart())) continue;
    const name = getDeclarationName(declaration);
    if (!name) continue;
    const exportNames = exportedByStart.get(textNode.getStart()) ?? [];
    const position = sourceFile.getLineAndColumnAtPos(declaration.getStart());
    const key = `${relativeFile}:${textNode.getStart()}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push({
      id: firstSymbolId + symbols.length,
      name,
      exportName: exportNames[0] ?? name,
      kind: declaration.getKindName(),
      file: relativeFile,
      fileId,
      line: position.line,
      column: position.column,
      isExported: exportNames.length > 0,
    });
  }

  for (const [start, exportNames] of exportedByStart) {
    if (symbols.some((symbol) => symbol.isExported && exportNames.includes(symbol.exportName))) continue;
    const declaration = sourceFile.getDescendants().find((candidate) => expandDeclarationTextNode(candidate).getStart() === start);
    if (!declaration) continue;
    const position = sourceFile.getLineAndColumnAtPos(declaration.getStart());
    const exportName = exportNames[0] ?? "default";
    symbols.push({
      id: firstSymbolId + symbols.length,
      name: getDeclarationName(declaration) ?? exportName,
      exportName,
      kind: declaration.getKindName(),
      file: relativeFile,
      fileId,
      line: position.line,
      column: position.column,
      isExported: true,
    });
  }
  return symbols;
}

function isSupportedSymbolDeclaration(node: Node): boolean {
  return (
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isEnumDeclaration(node)
  );
}

function getDeclarationName(node: Node): string | undefined {
  if (
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isEnumDeclaration(node)
  ) {
    return node.getName();
  }
  return undefined;
}

function expandDeclarationTextNode(node: Node): Node {
  if (Node.isVariableDeclaration(node)) return node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node;
  return node;
}

function isTopLevelDeclaration(node: Node): boolean {
  const parent = node.getParent();
  return Node.isSourceFile(parent);
}

function addContentLines(
  tokenIndex: Record<string, number[]>,
  lines: IndexedLine[],
  file: IndexedFile,
  text: string,
  diagnostics: IndexDiagnostics,
): void {
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i += 1) {
    const lineText = rawLines[i];
    if (lineText.trim() === "") continue;
    const redacted = redactText(lineText.trimEnd(), { path: file.path, line: i + 1, diagnostics });
    const line: IndexedLine = { id: lines.length, file: file.path, fileId: file.id, line: i + 1, text: redacted };
    lines.push(line);
    for (const token of tokenizeForIndex(line.text)) addUniqueNumber(tokenIndex, token, line.id);
  }
}

function addFileTokens(pathTokenIndex: Record<string, number[]>, file: IndexedFile): void {
  for (const token of tokenizeForIndex(`${file.path} ${file.basename}`)) addUniqueNumber(pathTokenIndex, token, file.id);
  if (file.routeKind) addUniqueNumber(pathTokenIndex, normalizeLookup(file.routeKind), file.id);
}

function addImportTokens(importTokenIndex: Record<string, number[]>, fileId: number, imports: string[]): void {
  for (const specifier of imports) {
    for (const token of tokenizeForIndex(specifier)) addUniqueNumber(importTokenIndex, token, fileId);
  }
}

function addSymbolTokens(
  symbolNameIndex: Record<string, number[]>,
  symbolTokenIndex: Record<string, number[]>,
  symbols: IndexedSymbol[],
): void {
  for (const symbol of symbols) {
    addUniqueNumber(symbolNameIndex, normalizeLookup(symbol.name), symbol.id);
    addUniqueNumber(symbolNameIndex, normalizeLookup(symbol.exportName), symbol.id);
    for (const token of tokenizeForIndex(`${symbol.name} ${symbol.exportName}`)) addUniqueNumber(symbolTokenIndex, token, symbol.id);
  }
}

function attachResolvedImportGraph(
  files: IndexedFile[],
  aliases: TsConfigAlias[],
  diagnostics: IndexDiagnostics,
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    file.resolvedImports = uniqueStrings(
      file.imports
        .map((specifier) => resolveImportToIndexedPath(file.path, specifier, fileByPath, aliases, diagnostics))
        .filter((resolved): resolved is string => Boolean(resolved)),
    );
    for (const importedPath of file.resolvedImports) {
      const imported = fileByPath.get(importedPath);
      if (imported && !imported.importedBy.includes(file.path)) imported.importedBy.push(file.path);
    }
  }
  for (const file of files) file.importedBy.sort();
}

function resolveImportToIndexedPath(
  fromPath: string,
  specifier: string,
  fileByPath: Map<string, IndexedFile>,
  aliases: TsConfigAlias[],
  diagnostics: IndexDiagnostics,
): string | null {
  const candidates = getImportCandidates(fromPath, specifier, fileByPath, aliases);
  for (const candidate of candidates) if (fileByPath.has(candidate)) return candidate;
  if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/")) {
    diagnostics.aliasResolutionFailures.push({ path: fromPath, reason: `Could not resolve import "${specifier}"` });
  }
  return null;
}

function getImportCandidates(
  fromPath: string,
  specifier: string,
  fileByPath: Map<string, IndexedFile>,
  aliases: TsConfigAlias[],
): string[] {
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    candidates.push(...expandImportBase(normalizePath(path.join(path.dirname(fromPath), specifier))));
    return uniqueStrings(candidates);
  }
  candidates.push(...getAliasCandidates(fromPath, specifier, aliases, fileByPath));
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    for (const srcRoot of getNearestSourceRoots(fromPath, fileByPath)) {
      candidates.push(...expandImportBase(normalizePath(path.join(srcRoot, specifier.slice(2)))));
    }
    candidates.push(...expandImportBase(normalizePath(path.join("src", specifier.slice(2)))));
  } else {
    const workspaceMatch = findWorkspacePackageImport(specifier, fileByPath);
    if (workspaceMatch) candidates.push(workspaceMatch);
  }
  return uniqueStrings(candidates);
}

function expandImportBase(basePath: string): string[] {
  return [
    ...SOURCE_EXTENSIONS.map((ext) => `${basePath}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => normalizePath(path.join(basePath, `index${ext}`))),
  ];
}

function getNearestSourceRoots(fromPath: string, fileByPath: Map<string, IndexedFile>): string[] {
  const roots = new Set<string>();
  const parts = fromPath.split("/");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts.slice(0, i).join("/");
    if (!candidate) continue;
    const srcRoot = normalizePath(path.join(candidate, "src"));
    if ([...fileByPath.keys()].some((filePath) => filePath.startsWith(`${srcRoot}/`))) roots.add(srcRoot);
  }
  return [...roots];
}

function findWorkspacePackageImport(specifier: string, fileByPath: Map<string, IndexedFile>): string | null {
  const packageJsonFiles = [...fileByPath.values()].filter((file) => file.path.endsWith("package.json"));
  for (const packageFile of packageJsonFiles) {
    const packageRoot = path.dirname(packageFile.path);
    const packageName = packageFile.packageName;
    if (!packageName || (specifier !== packageName && !specifier.startsWith(`${packageName}/`))) continue;
    const remainder = specifier === packageName ? "src/index" : specifier.slice(packageName.length + 1);
    const bases = [
      normalizePath(path.join(packageRoot, remainder)),
      normalizePath(path.join(packageRoot, "src", remainder)),
    ];
    if (specifier === packageName) bases.push(normalizePath(path.join(packageRoot, "index")));
    for (const base of bases) {
      for (const candidate of expandImportBase(base)) if (fileByPath.has(candidate)) return candidate;
    }
  }
  return null;
}

interface TsConfigAlias { configDir: string; baseUrl: string; key: string; targets: string[]; }

async function readTsConfigAliases(root: string, files: string[]): Promise<TsConfigAlias[]> {
  const aliases: TsConfigAlias[] = [];
  const cache = new Map<string, any>();
  for (const absolutePath of files) {
    const basename = path.basename(absolutePath);
    if (!/^tsconfig.*\.json$/.test(basename)) continue;
    try {
      const config = await readTsConfigWithExtends(root, absolutePath, cache, new Set());
      const compilerOptions = config?.compilerOptions;
      if (!compilerOptions || typeof compilerOptions.paths !== "object" || !compilerOptions.paths) continue;
      const configDir = toRelativePath(root, path.dirname(absolutePath));
      const baseUrl =
        typeof compilerOptions.baseUrl === "string"
          ? normalizePath(path.join(configDir, compilerOptions.baseUrl))
          : configDir;
      for (const [key, value] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const targets = value.filter((target): target is string => typeof target === "string");
        if (targets.length) aliases.push({ configDir, baseUrl, key, targets });
      }
    } catch {
      continue;
    }
  }
  return aliases;
}

async function readTsConfigWithExtends(
  root: string,
  absolutePath: string,
  cache: Map<string, any>,
  seen: Set<string>,
): Promise<any | null> {
  const key = path.resolve(absolutePath);
  if (cache.has(key)) return cache.get(key);
  if (seen.has(key)) return null;
  seen.add(key);
  let raw: string;
  try { raw = await readFile(key, "utf8"); } catch { cache.set(key, null); return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw.replace(JSONC_COMMENTS, "").replace(JSONC_TRAILING_COMMAS, "$1")); }
  catch { cache.set(key, null); return null; }
  let base: any = {};
  if (typeof parsed.extends === "string") {
    const extPath = resolveExtendsPath(key, parsed.extends);
    if (extPath) base = (await readTsConfigWithExtends(root, extPath, cache, new Set(seen))) ?? {};
  }
  const merged = deepMergeTsConfig(base, parsed);
  cache.set(key, merged);
  return merged;
}

function resolveExtendsPath(fromConfig: string, spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = path.resolve(path.dirname(fromConfig), spec);
    const candidates = [base, `${base}.json`, path.join(base, "tsconfig.json")];
    for (const c of candidates) try { if (path.extname(c) || c.endsWith(".json")) return c; } catch {}
    return `${base}.json`;
  }
  return null; // package extends best-effort omitted to avoid unsafe resolution
}

function deepMergeTsConfig(base: any, ext: any): any {
  const out = { ...base, ...ext };
  if (base?.compilerOptions || ext?.compilerOptions) {
    out.compilerOptions = { ...(base?.compilerOptions ?? {}), ...(ext?.compilerOptions ?? {}) };
    if (base?.compilerOptions?.paths || ext?.compilerOptions?.paths) {
      out.compilerOptions.paths = { ...(base?.compilerOptions?.paths ?? {}), ...(ext?.compilerOptions?.paths ?? {}) };
    }
  }
  return out;
}

function getAliasCandidates(
  fromPath: string,
  specifier: string,
  aliases: TsConfigAlias[],
  fileByPath: Map<string, IndexedFile>,
): string[] {
  const candidates: string[] = [];
  const relevant = aliases
    .filter((alias) => alias.configDir === "" || fromPath === alias.configDir || fromPath.startsWith(`${alias.configDir}/`))
    .sort((a, b) => b.configDir.length - a.configDir.length);
  for (const alias of relevant) {
    const wildcard = matchTsPathAlias(alias.key, specifier);
    if (wildcard === null) continue;
    for (const target of alias.targets) {
      const replaced = target.includes("*") ? target.replace("*", wildcard) : target;
      const base = normalizePath(path.join(alias.baseUrl, replaced));
      candidates.push(...expandImportBase(base));
    }
  }
  return candidates.filter((candidate) => fileByPath.has(candidate));
}

function matchTsPathAlias(pattern: string, specifier: string): string | null {
  if (!pattern.includes("*")) return pattern === specifier ? "" : null;
  const [prefix, suffix = ""] = pattern.split("*", 2);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function getCandidateLineIds(index: WorkspaceIndex, query: string): number[] {
  const tokens = tokenizeForIndex(query);
  if (tokens.length === 0) return index.lines.map((line) => line.id);
  const postingLists = tokens
    .map((token) => index.tokenIndex[token] ?? [])
    .filter((list) => list.length > 0)
    .sort((a, b) => a.length - b.length);
  if (postingLists.length === 0) return index.lines.map((line) => line.id);
  return postingLists.slice(1).reduce((candidateIds, postingList) => intersectSorted(candidateIds, postingList), [...postingLists[0]]);
}

function getCandidateSymbolIds(index: WorkspaceIndex, query: string): number[] {
  const normalized = normalizeLookup(query);
  const exactIds = index.symbolNameIndex[normalized] ?? [];
  const tokens = tokenizeForIndex(query);
  const tokenIds = uniqueNumbers(tokens.flatMap((token) => index.symbolTokenIndex[token] ?? []));
  if (exactIds.length || tokenIds.length) return uniqueNumbers([...exactIds, ...tokenIds]);
  return index.symbols.map((symbol) => symbol.id);
}

function addSymbolLocations(index: WorkspaceIndex, query: string, locations: Map<string, MemoryLocation>): void {
  for (const symbolId of getCandidateSymbolIds(index, query)) {
    const symbol = index.symbols[symbolId];
    if (!symbol) continue;
    const score = rankSymbol(query, symbol);
    if (score <= 0) continue;
    putBestLocation(locations, {
      kind: "symbol", score, file: symbol.file, line: symbol.line, column: symbol.column, name: symbol.name,
      reason: `${symbol.isExported ? "exported" : "local"} ${symbol.kind} ${symbol.exportName}`,
    });
  }
}

function addFileLocations(index: WorkspaceIndex, query: string, kind: "any" | "file" | "route", locations: Map<string, MemoryLocation>): void {
  const tokens = tokenizeForIndex(query);
  const candidateIds = tokens.length ? uniqueNumbers(tokens.flatMap((token) => index.pathTokenIndex[token] ?? [])) : index.files.map((file) => file.id);
  const normalizedQuery = normalizeLookup(query);
  for (const fileId of candidateIds) {
    const file = index.files[fileId];
    if (!file || (kind === "route" && !file.routeKind)) continue;
    const normalizedPath = normalizeLookup(file.path);
    const normalizedBase = normalizeLookup(file.basename);
    const tokenScore = scoreTokenCoverage(query, `${file.path} ${file.basename}`);
    let score = tokenScore;
    if (normalizedPath === normalizedQuery || normalizedBase === normalizedQuery) score += 100;
    else if (normalizedPath.includes(normalizedQuery) || normalizedBase.includes(normalizedQuery)) score += 60;
    if (file.routeKind) score += 12;
    if (score <= 0) continue;
    putBestLocation(locations, {
      kind: file.routeKind ? "route" : "file", score, file: file.path,
      reason: file.routeKind ? `Next.js ${file.routeKind} file` : `${file.language} file path match`,
      preview: `${file.symbols.length} symbol(s), ${file.importedBy.length} importer(s)`,
    });
  }
}

function addImportLocations(index: WorkspaceIndex, query: string, locations: Map<string, MemoryLocation>): void {
  const tokens = tokenizeForIndex(query);
  if (tokens.length === 0) return;
  const candidateIds = uniqueNumbers(tokens.flatMap((token) => index.importTokenIndex[token] ?? []));
  for (const fileId of candidateIds) {
    const file = index.files[fileId];
    if (!file) continue;
    const importsText = [...file.imports, ...file.resolvedImports].join(" ");
    const score = scoreTokenCoverage(query, importsText) + 25;
    if (score <= 25) continue;
    putBestLocation(locations, {
      kind: "import", score, file: file.path, reason: "import specifier match",
      preview: file.imports.filter((specifier) => tokenizeForIndex(specifier).some((token) => tokens.includes(token))).join(", "),
    });
  }
}

function addLineLocations(index: WorkspaceIndex, query: string, locations: Map<string, MemoryLocation>): void {
  const normalizedQuery = normalizeLookup(query);
  const candidateLineIds = getRecallLineIds(index, query, 5000);
  for (const lineId of candidateLineIds) {
    const line = index.lines[lineId];
    if (!line) continue;
    const normalizedLine = normalizeLookup(line.text);
    const tokenScore = scoreTokenCoverage(query, line.text);
    const exactBoost = normalizedLine.includes(normalizedQuery) ? 30 : 0;
    const score = tokenScore + exactBoost;
    if (score <= 0) continue;
    putBestLocation(locations, {
      kind: "line", score, file: line.file, line: line.line, column: Math.max(normalizedLine.indexOf(normalizedQuery), 0) + 1,
      reason: "content memory match", preview: line.text,
    });
  }
}

function getRecallLineIds(index: WorkspaceIndex, query: string, limit: number): number[] {
  const tokens = tokenizeForIndex(query);
  if (tokens.length === 0) return index.lines.slice(0, limit).map((line) => line.id);
  const postingLists = tokens.map((token) => index.tokenIndex[token] ?? []).filter((list) => list.length > 0).sort((a, b) => a.length - b.length);
  const ids = new Set<number>();
  for (const postingList of postingLists) {
    for (const id of postingList) {
      ids.add(id);
      if (ids.size >= limit) return [...ids];
    }
  }
  return [...ids];
}

function rankSymbol(query: string, symbol: IndexedSymbol): number {
  const normalizedQuery = normalizeLookup(query);
  const normalizedName = normalizeLookup(symbol.name);
  const normalizedExport = normalizeLookup(symbol.exportName);
  const tokenScore = scoreTokenCoverage(query, `${symbol.name} ${symbol.exportName}`);
  let score = tokenScore;
  if (normalizedName === normalizedQuery || normalizedExport === normalizedQuery) score += 120;
  else if (normalizedName.startsWith(normalizedQuery) || normalizedExport.startsWith(normalizedQuery)) score += 80;
  else if (normalizedName.includes(normalizedQuery) || normalizedExport.includes(normalizedQuery)) score += 50;
  if (symbol.isExported) score += 6;
  if (symbol.kind.includes("Function") || symbol.kind.includes("Class")) score += 8;
  return score;
}

function scoreTokenCoverage(query: string, target: string): number {
  const queryTokens = tokenizeForIndex(query);
  if (queryTokens.length === 0) return 0;
  const targetTokens = new Set(tokenizeForIndex(target));
  const hits = queryTokens.filter((token) => targetTokens.has(token)).length;
  return Math.round((hits / queryTokens.length) * 40) + hits * 5;
}

function putBestLocation(locations: Map<string, MemoryLocation>, location: MemoryLocation): void {
  const key = `${location.kind}:${location.file}:${location.line ?? 0}:${location.name ?? ""}`;
  const existing = locations.get(key);
  if (!existing || location.score > existing.score) locations.set(key, location);
}

function createLineMatcher(query: string, options: SearchOptions): (line: string) => number[] {
  if (options.regex) {
    let expression: RegExp;
    try { expression = new RegExp(query, options.caseSensitive ? "g" : "gi"); }
    catch (err) { throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`); }
    return (line) => {
      const columns: number[] = [];
      for (const match of line.matchAll(expression)) {
        columns.push((match.index ?? 0) + 1);
        if (match[0] === "") break;
      }
      return columns;
    };
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (line) => {
    const haystack = options.caseSensitive ? line : line.toLowerCase();
    const columns: number[] = [];
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      columns.push(index + 1);
      index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
    }
    return columns;
  };
}

async function resolveGlobbedFileIds(index: WorkspaceIndex, globPattern?: string | string[]): Promise<Set<number> | null> {
  if (!globPattern) return null;
  const patterns = Array.isArray(globPattern) ? globPattern : [globPattern];
  for (const p of patterns) if (p.length > MAX_GLOB_PATTERN_CHARS) throw new Error(`Glob pattern exceeds ${MAX_GLOB_PATTERN_CHARS} characters.`);
  const files = await fg(patterns, {
    absolute: true, cwd: index.root, ignore: IGNORE_PATTERNS, onlyFiles: true, unique: true, followSymbolicLinks: false,
  });
  const absolutePaths = new Set(files.map((file) => path.resolve(file)));
  const fileIds = new Set<number>();
  for (const file of index.files) if (absolutePaths.has(file.absolutePath)) fileIds.add(file.id);
  return fileIds;
}

function toSearchResult(query: string, root: string, index: WorkspaceIndex, matches: SearchResult["matches"], truncated: boolean): SearchResult {
  return { query, root, source: "apex-memory", generatedAt: index.generatedAt, matchCount: matches.length, truncated, matches };
}

async function readPersistedIndex(root: string, indexPath: string): Promise<WorkspaceIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as WorkspaceIndex;
    if (
      parsed.schemaVersion !== INDEX_SCHEMA_VERSION ||
      parsed.root !== root ||
      !Array.isArray(parsed.files) ||
      !Array.isArray(parsed.symbols) ||
      !Array.isArray(parsed.lines) ||
      !parsed.manifest ||
      !parsed.diagnostics
    ) return null;
    parsed.indexPath = indexPath;
    parsed.diagnostics.lastRefreshKind = "cache";
    if (!(await isPersistedIndexFresh(parsed))) {
      await markWorkspaceMemoryStale(root, { event: "freshness.validation.failed" });
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readPersistedIndexUnchecked(root: string, indexPath: string): Promise<WorkspaceIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as WorkspaceIndex;
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || parsed.root !== root) return null;
    parsed.indexPath = indexPath;
    return parsed;
  } catch {
    return null;
  }
}

async function writePersistedIndex(index: WorkspaceIndex): Promise<void> {
  const dir = path.dirname(index.indexPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(index)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${index.indexPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmp, index.indexPath);
      try { await chmod(index.indexPath, 0o600); } catch {}
      try { await chmod(dir, 0o700); } catch {}
      return;
    } catch (err) {
      try { await rm(tmp, { force: true }); } catch {}
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (attempt === 1) throw err;
    }
  }
}

async function isPersistedIndexFresh(index: WorkspaceIndex): Promise<boolean> {
  const currentFiles = await discoverCurrentFiles(index.root);
  const currentSet = new Set(currentFiles.map((file) => toRelativePath(index.root, file)));
  const knownSet = new Set(Object.keys(index.manifest));
  for (const knownPath of knownSet) if (!currentSet.has(knownPath)) return false;
  for (const currentPath of currentSet) if (!knownSet.has(currentPath)) return false;
  const currentGit = await readGitSnapshot(index.root);
  if (currentGit?.head !== index.git?.head || currentGit?.indexMtimeMs !== index.git?.indexMtimeMs) return false;
  for (const [relativePath, fingerprint] of Object.entries(index.manifest)) {
    const absolutePath = path.join(index.root, relativePath);
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size !== fingerprint.sizeBytes || fileStat.mtimeMs !== fingerprint.modifiedTimeMs) {
        const text = await readFile(absolutePath, "utf8");
        if (hashContent(text) !== fingerprint.contentHash) return false;
      }
    } catch { return false; }
  }
  return true;
}

async function discoverCurrentFiles(root: string): Promise<string[]> {
  return fg(DEFAULT_PATTERNS, {
    absolute: true, cwd: root, ignore: IGNORE_PATTERNS, onlyFiles: true, unique: true, followSymbolicLinks: false,
  });
}

async function isWorkspaceMemoryMarkedStale(root: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(path.join(getOpenCodeConfigDir(), "apex-context-usage.json"), "utf8")) as ApexUsageState;
    const workspace = state.workspaces?.[hashRoot(root)];
    return workspace?.memoryStale === true || state.memoryStale === true;
  } catch { return false; }
}

async function clearWorkspaceMemoryStale(root: string): Promise<void> {
  try {
    const statePath = path.join(getOpenCodeConfigDir(), "apex-context-usage.json");
    let state: ApexUsageState = {};
    try { state = JSON.parse(await readFile(statePath, "utf8")) as ApexUsageState; } catch { state = {}; }
    state.workspaces ??= {};
    const rootHash = hashRoot(root);
    state.workspaces[rootHash] ??= { root };
    state.workspaces[rootHash].root = root;
    state.workspaces[rootHash].memoryStale = false;
    state.workspaces[rootHash].changedFiles = [];
    state.workspaces[rootHash].deletedFiles = [];
    state.workspaces[rootHash].memoryRefreshedAt = new Date().toISOString();
    state.memoryStale = Object.values(state.workspaces).some((workspace) => workspace.memoryStale === true);
    await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, statePath);
    try { await chmod(statePath, 0o600); } catch {}
  } catch { /* best-effort */ }
}

async function markWorkspaceMemoryStale(
  root: string,
  details: { event: string; changedFiles?: string[]; deletedFiles?: string[] },
): Promise<void> {
  try {
    const statePath = path.join(getOpenCodeConfigDir(), "apex-context-usage.json");
    let state: ApexUsageState = {};
    try { state = JSON.parse(await readFile(statePath, "utf8")) as ApexUsageState; } catch { state = {}; }
    state.workspaces ??= {};
    const rootHash = hashRoot(root);
    const workspace = state.workspaces[rootHash] ?? { root };
    workspace.root = root;
    workspace.memoryStale = true;
    workspace.changedFiles = uniqueStrings([...(workspace.changedFiles ?? []), ...(details.changedFiles ?? [])]);
    workspace.deletedFiles = uniqueStrings([...(workspace.deletedFiles ?? []), ...(details.deletedFiles ?? [])]);
    workspace.lastFileEvent = details.event;
    workspace.updatedAt = new Date().toISOString();
    state.workspaces[rootHash] = workspace;
    state.memoryStale = true;
    await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, statePath);
    try { await chmod(statePath, 0o600); } catch {}
  } catch { /* best-effort */ }
}

interface ApexUsageState { memoryStale?: boolean; workspaces?: Record<string, ApexWorkspaceState>; }
interface ApexWorkspaceState {
  root: string; memoryStale?: boolean; changedFiles?: string[]; deletedFiles?: string[];
  lastFileEvent?: string; updatedAt?: string; memoryRefreshedAt?: string;
}

function getIndexPath(root: string): string {
  return path.join(getIndexRoot(), `${hashRoot(root)}.json`);
}
function getIndexRoot(): string {
  return path.join(getOpenCodeConfigDir(), "apex-context-index");
}

function tokenizeForIndex(value: string): string[] {
  const rawTokens = value.match(/[A-Za-z0-9_$@#-]+/g) ?? [];
  const tokens = new Set<string>();
  for (const rawToken of rawTokens) {
    const pieces = splitToken(rawToken);
    for (const piece of pieces) {
      const token = normalizeLookup(piece);
      if (token.length >= 2) tokens.add(token);
    }
  }
  return [...tokens];
}

function splitToken(token: string): string[] {
  const normalized = token.replace(/[_$@#-]+/g, " ");
  const camelPieces = normalized.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return [token, ...camelPieces.split(/\s+/)].filter(Boolean);
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function addUniqueNumber(index: Record<string, number[]>, key: string, value: number): void {
  const values = index[key] ?? [];
  if (values[values.length - 1] !== value && !values.includes(value)) values.push(value);
  index[key] = values;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function intersectSorted(a: number[], b: number[]): number[] {
  const result: number[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { result.push(a[i]); i += 1; j += 1; }
    else if (a[i] < b[j]) i += 1;
    else j += 1;
  }
  return result;
}

function inferRouteKind(relativePath: string): string | undefined {
  if (!relativePath.startsWith("apps/") && !relativePath.startsWith("src/")) return undefined;
  const basename = path.basename(relativePath);
  if (/^page\.(tsx|ts|jsx|js)$/.test(basename)) return "page";
  if (/^layout\.(tsx|ts|jsx|js)$/.test(basename)) return "layout";
  if (/^route\.(tsx|ts|jsx|js)$/.test(basename)) return "route-handler";
  if (/^loading\.(tsx|ts|jsx|js)$/.test(basename)) return "loading";
  if (/^error\.(tsx|ts|jsx|js)$/.test(basename)) return "error";
  if (/^not-found\.(tsx|ts|jsx|js)$/.test(basename)) return "not-found";
  return undefined;
}

function isLikelyEntryFile(file: IndexedFile): boolean {
  return Boolean(
    file.routeKind ||
      /^apps\/[^/]+\/src\/(app|pages)\//.test(file.path) ||
      /^src\/(app|pages)\//.test(file.path) ||
      /(^|\/)(index|main|server|app|middleware)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path),
  );
}

function entryReason(file: IndexedFile): string {
  if (file.routeKind) return `Next.js ${file.routeKind}`;
  if (file.path.includes("/middleware.")) return "middleware";
  if (file.basename.startsWith("index.")) return "barrel or package entry";
  if (file.basename.startsWith("main.") || file.basename.startsWith("server.")) return "runtime entry";
  return "app entry";
}

function languageForExtension(ext: string): string {
  switch (ext) {
    case ".ts": case ".mts": case ".cts": return "typescript";
    case ".tsx": return "typescript-react";
    case ".js": case ".mjs": case ".cjs": return "javascript";
    case ".jsx": return "javascript-react";
    case ".json": return "json";
    case ".md": case ".mdx": return "markdown";
    case ".css": case ".scss": return "style";
    case ".prisma": return "prisma";
    case ".sql": return "sql";
    case ".graphql": case ".gql": return "graphql";
    case ".yaml": case ".yml": return "yaml";
    case ".toml": return "toml";
    case ".sh": case ".bash": return "shell";
    case ".py": return "python";
    case ".go": return "go";
    case ".rs": return "rust";
    case ".php": return "php";
    case ".vue": return "vue";
    case ".svelte": return "svelte";
    case ".astro": return "astro";
    default: return ext.replace(/^\./, "") || "unknown";
  }
}

function createDiagnostics(kind: "full" | "incremental" | "cache"): IndexDiagnostics {
  return {
    skippedFiles: [], parseFailures: [], largeFilesIgnored: [], aliasResolutionFailures: [],
    secretRedactions: [], lastRefreshDurationMs: 0, watcherStatus: "unknown", lastRefreshKind: kind,
  };
}

function hashContent(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function extractPackageName(relativePath: string, text: string): string | undefined {
  if (!relativePath.endsWith("package.json")) return undefined;
  try {
    const pkg = JSON.parse(text.replace(JSONC_COMMENTS, "").replace(JSONC_TRAILING_COMMAS, "$1")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch { return undefined; }
}

async function readGitSnapshot(root: string): Promise<GitSnapshot | undefined> {
  const gitDir = path.join(root, ".git");
  try {
    const headRaw = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    let head = headRaw;
    if (headRaw.startsWith("ref: ")) {
      const ref = headRaw.slice(5).trim();
      try { head = `${ref}:${(await readFile(path.join(gitDir, ref), "utf8")).trim()}`; } catch { head = headRaw; }
    }
    let indexMtimeMs: number | undefined;
    try { indexMtimeMs = (await stat(path.join(gitDir, "index"))).mtimeMs; } catch { indexMtimeMs = undefined; }
    return { head, indexMtimeMs };
  } catch { return undefined; }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export async function indexExists(root?: string): Promise<boolean> {
  try { await stat(getIndexPath(resolveRoot(root))); return true; } catch { return false; }
}

export async function _resetIndexStateForTests(): Promise<void> {
  cachedIndex = null;
  buildLocks.clear();
}
