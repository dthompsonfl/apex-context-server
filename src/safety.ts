import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_LINE_LENGTH = 2048;
export const MAX_QUERY_LENGTH = 256;
export const MAX_RESPONSE_LENGTH = 60000;
export const MAX_INDEXED_FILES = 30000;
export const MAX_TOTAL_INDEXED_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_INDEXED_LINES = 250_000;

export class IndexBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexBudgetExceeded";
  }
}

export function assertIndexBudget(bytes: number, lines: number): void {
  if (bytes > MAX_TOTAL_INDEXED_BYTES)
    throw new IndexBudgetExceeded("Workspace exceeds the 64 MiB total indexed source budget.");
  if (lines > MAX_TOTAL_INDEXED_LINES)
    throw new IndexBudgetExceeded("Workspace exceeds the 250,000-line index budget.");
}


const DENIED_PARTS = new Set([
  ".git", ".env", ".aws", ".ssh", ".npmrc", ".pypirc", ".cache",
  ".next", ".turbo", "node_modules", "dist", "coverage", "build",
  "secrets", "credentials", "private", "apex-context-index",
]);
const DENIED_FILENAME = /(?:^|[.-])(?:credentials?|secrets?)(?:[.-]|$)|\.(?:pem|key|p12|pfx|keystore|jks)$/i;

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export function isSensitivePath(relative: string): boolean {
  const parts = relative.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((part) => DENIED_PARTS.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))
    || (parts.length > 0 && DENIED_FILENAME.test(parts[parts.length - 1]));
}

/** MCP callers can narrow an authorized workspace but never move outside it. */
export function resolveRoot(requested?: string): string {
  const anchor = path.resolve(process.env.APEX_CONTEXT_ROOT || process.cwd());
  const target = path.resolve(requested || anchor);
  const authorized = realpathSync(anchor);
  const canonical = realpathSync(target);
  if (!contained(authorized, canonical)) {
    throw new Error("Requested root is outside the authorized workspace.");
  }
  return canonical;
}

/** Re-check canonical paths at each read: lexical containment alone does not stop symlinks. */
export function authorizeFile(root: string, filepath: string): string {
  const canonicalRoot = realpathSync(path.resolve(root));
  const requested = path.resolve(canonicalRoot, filepath);
  if (!contained(canonicalRoot, requested)) {
    throw new Error("Source path is outside the authorized workspace.");
  }
  const canonical = realpathSync(requested);
  if (!contained(canonicalRoot, canonical)) {
    throw new Error("Source path resolves outside the authorized workspace.");
  }
  if (isSensitivePath(path.relative(canonicalRoot, requested)) ||
      isSensitivePath(path.relative(canonicalRoot, canonical))) {
    throw new Error("Source path is excluded by the sensitive-file policy.");
  }
  const metadata = statSync(canonical);
  if (!metadata.isFile()) {
    throw new Error("Source path is not a regular file.");
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error("Source file exceeds the 1 MiB indexing/read limit.");
  }
  return canonical;
}

export interface SecretHit { pattern: string; line: number }
export function redactSource(source: string): { text: string; redactions: SecretHit[] } {
  let text = source;
  const redactions: SecretHit[] = [];
  const rules: Array<[string, RegExp]> = [
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
    ["json-credential", /["'](?:private[_-]?key|password|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["']\s*:\s*["'][^"']{8,}["']/gi],
    ["assignment-secret", /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*["']?[^"',;\s]{8,}["']?/gi],
    ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/g],
    ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ["known-token-prefix", /\b(?:ghp_|gho_|github_pat_|sk-[A-Za-z0-9_-]{3,})[A-Za-z0-9_-]{16,}\b/g],
  ];
  for (const [name, pattern] of rules) {
    text = text.replace(pattern, (matched, ...args: unknown[]) => {
      const offset = Number(args[args.length - 2]);
      const line = text.slice(0, offset).split("\n").length;
      redactions.push({ pattern: name, line });
      // Preserve line numbering through multiline replacements.
      return "[REDACTED_SECRET]" + "\n".repeat((matched.match(/\n/g) || []).length);
    });
  }
  return { text, redactions };
}

export function assertSafeQuery(query: string): void {
  if (!query.trim() || query.length > MAX_QUERY_LENGTH) {
    throw new Error("Query must contain 1 to 256 characters.");
  }
}

/** A deliberately limited regular-expression subset prevents nested-quantifier ReDoS. */
export function assertSafeRegex(query: string): void {
  assertSafeQuery(query);
  const withoutEscapes = query.replace(/\\./g, "");
  const outsideClasses = withoutEscapes.replace(/\[[^\]]*\]/g, "");
  // Repeated quantifiers over adjacent atoms can cause polynomial backtracking.
  const quantifiers = outsideClasses.match(/[+*?]/g) ?? [];
  if (/[(){}|]/.test(outsideClasses) || /\\[1-9]/.test(query) || quantifiers.length > 1) {
    throw new Error("Unsafe regex construct; use literal search or a simple character-class pattern.");
  }
}

export function boundedOutput(value: string): string {
  const sanitized = redactSource(value).text;
  if (sanitized.length > MAX_RESPONSE_LENGTH) {
    throw new Error("MCP output exceeds 60,000 characters; narrow the query or lower result limits.");
  }
  return sanitized;
}
