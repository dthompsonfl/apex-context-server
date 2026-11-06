import crypto from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APEX_CONFIG_ENV = "APEX_CONTEXT_CONFIG_DIR";
export const APEX_ROOT_ENV = "APEX_CONTEXT_ROOT";
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_SEARCH_QUERY_CHARS = 4000;
export const MAX_GLOB_PATTERN_CHARS = 512;
export const MAX_TOOL_RESPONSE_CHARS = 120_000;

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "service-account.json",
]);

export function resolveRoot(root?: string): string {
  return path.resolve(root || process.env[APEX_ROOT_ENV] || process.cwd());
}

export function getOpenCodeConfigDir(): string {
  return process.env[APEX_CONFIG_ENV] || path.join(os.homedir(), ".config", "opencode");
}

export function hashRoot(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20);
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function toRelativePath(root: string, absolutePath: string): string {
  return normalizePath(path.relative(root, absolutePath));
}

export function isPathWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export async function resolveAuthorizedFile(
  inputPath: string,
  root?: string,
): Promise<{ root: string; absolutePath: string; relativePath: string; realPath: string }> {
  const resolvedRoot = path.resolve(resolveRoot(root));
  const rootReal = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(resolvedRoot, inputPath);

  if (!isPathWithin(rootReal, candidate)) {
    throw new Error(`Path is outside the authorized workspace root: ${inputPath}`);
  }

  const lst = await lstat(candidate);
  if (lst.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${inputPath}`);
  }

  const targetReal = await realpath(candidate);
  if (!isPathWithin(rootReal, targetReal)) {
    throw new Error(`Symlink escapes the authorized workspace root: ${inputPath}`);
  }

  return {
    root: rootReal,
    absolutePath: candidate,
    relativePath: toRelativePath(rootReal, candidate),
    realPath: targetReal,
  };
}

export function isSensitivePath(relativePath: string): boolean {
  const rel = normalizePath(relativePath).replace(/^\.\/+/, "");
  const base = path.posix.basename(rel);
  const lowerBase = base.toLowerCase();
  if (SENSITIVE_BASENAMES.has(lowerBase)) return true;
  if (/^\.env(?:\..+)?$/i.test(base) && base.toLowerCase() !== ".env.example") return true;
  if (/\.(pem|key|p12|pfx|kdbx|keystore)$/i.test(base)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/i.test(base)) return true;
  if (/(^|\/)(\.git\/config|\.ssh\/|\.aws\/credentials)/i.test(rel)) return true;
  return false;
}

export function truncateToolText(text: string, maxChars = MAX_TOOL_RESPONSE_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated: output exceeded ${maxChars} characters]`;
}
