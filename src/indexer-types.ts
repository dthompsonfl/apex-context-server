export interface BuildIndexOptions {
  root?: string;
  force?: boolean;
  patterns?: string[];
}

export interface SearchOptions {
  root?: string;
  glob?: string | string[];
  maxResults?: number;
  caseSensitive?: boolean;
  regex?: boolean;
}

export interface FindSymbolOptions {
  root?: string;
  exact?: boolean;
  maxResults?: number;
}

export interface LocateCodeOptions {
  root?: string;
  maxResults?: number;
  kind?: "any" | "symbol" | "file" | "import" | "line" | "route";
}

export interface IndexedFileFingerprint {
  path: string;
  sizeBytes: number;
  modifiedTimeMs: number;
  contentHash: string;
}

export interface GitSnapshot {
  head?: string;
  indexMtimeMs?: number;
}

export interface IndexDiagnosticItem {
  path: string;
  reason: string;
}

export interface IndexDiagnostics {
  skippedFiles: IndexDiagnosticItem[];
  parseFailures: IndexDiagnosticItem[];
  largeFilesIgnored: IndexDiagnosticItem[];
  aliasResolutionFailures: IndexDiagnosticItem[];
  secretRedactions: Array<{ path: string; line: number; pattern: string }>;
  lastRefreshDurationMs: number;
  watcherStatus: "unknown" | "watching" | "stopped" | "unavailable";
  lastRefreshKind: "full" | "incremental" | "cache";
  lastRefreshAt?: string;
  lastIndexedAt?: string;
  fileChangeSummary?: { changed: number; added: number; deleted: number };
}

export interface IndexedSymbol {
  id: number;
  name: string;
  exportName: string;
  kind: string;
  file: string;
  fileId: number;
  line: number;
  column: number;
  isExported?: boolean;
}

export interface IndexedFile {
  id: number;
  path: string;
  absolutePath: string;
  basename: string;
  extension: string;
  language: string;
  sizeBytes: number;
  modifiedTime: string;
  modifiedTimeMs: number;
  contentHash: string;
  indexedAt: string;
  routeKind?: string;
  packageName?: string;
  imports: string[];
  resolvedImports: string[];
  importedBy: string[];
  symbols: IndexedSymbol[];
}

export interface IndexedLine {
  id: number;
  file: string;
  fileId: number;
  line: number;
  text: string;
}

export interface WorkspaceIndex {
  schemaVersion: number;
  root: string;
  rootHash: string;
  indexPath: string;
  generatedAt: string;
  fileCount: number;
  symbolCount: number;
  lineCount: number;
  tokenCount: number;
  manifest: Record<string, IndexedFileFingerprint>;
  changedFiles: string[];
  deletedFiles: string[];
  git?: GitSnapshot;
  diagnostics: IndexDiagnostics;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  lines: IndexedLine[];
  tokenIndex: Record<string, number[]>;
  symbolNameIndex: Record<string, number[]>;
  symbolTokenIndex: Record<string, number[]>;
  pathTokenIndex: Record<string, number[]>;
  importTokenIndex: Record<string, number[]>;
}

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchResult {
  query: string;
  root: string;
  source: "apex-memory";
  generatedAt: string;
  matchCount: number;
  truncated: boolean;
  matches: SearchMatch[];
}

export interface SymbolSearchResult {
  query: string;
  root: string;
  source: "apex-memory";
  generatedAt: string;
  matchCount: number;
  truncated: boolean;
  matches: IndexedSymbol[];
}

export interface MemoryLocation {
  kind: "symbol" | "file" | "import" | "line" | "route";
  score: number;
  file: string;
  line?: number;
  column?: number;
  name?: string;
  reason: string;
  preview?: string;
}

export interface MemoryLookupResult {
  query: string;
  root: string;
  source: "apex-memory";
  generatedAt: string;
  matchCount: number;
  truncated: boolean;
  matches: MemoryLocation[];
}

export interface WorkspaceMemorySnapshot {
  root: string;
  rootHash: string;
  indexPath: string;
  generatedAt: string;
  counts: { files: number; symbols: number; lines: number; tokens: number };
  topSymbolFiles: Array<{ path: string; language: string; symbols: number; imports: number; importedBy: number }>;
  routeFiles: Array<{ path: string; routeKind: string; symbols: number }>;
  entryFiles: Array<{ path: string; reason: string }>;
}
