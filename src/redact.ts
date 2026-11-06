export interface RedactionHit {
  path: string;
  line?: number;
  pattern: string;
}

export interface RedactionDiagnostics {
  secretRedactions: RedactionHit[];
}

const PATTERNS: Array<{ name: string; pattern: RegExp; replace: string }> = [
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: "[REDACTED_AWS_KEY]",
  },
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
    replace: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replace: "Bearer [REDACTED_TOKEN]",
  },
  {
    name: "authorization-header",
    pattern: /\b(Authorization\s*[:=]\s*["']?)(?:Basic|Bearer)?\s*[A-Za-z0-9._~+/=:-]{12,}(["']?)/gi,
    replace: "$1[REDACTED_AUTH]$2",
  },
  {
    name: "assignment-secret",
    pattern:
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|private[_-]?key|client[_-]?secret|session[_-]?secret|database[_-]?url|db[_-]?password|token)\b\s*[:=]\s*)(["']?)([^"'\s\r\n]{6,})\2/gi,
    replace: "$1$2[REDACTED_SECRET]$2",
  },
  {
    name: "url-credential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+:)([^@/\s]+)(@)/gi,
    replace: "$1[REDACTED_SECRET]$3",
  },
];

export function redactText(
  value: string,
  context: { path?: string; line?: number; diagnostics?: RedactionDiagnostics } = {},
): string {
  let output = value;
  for (const { name, pattern, replace } of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(output)) {
      output = output.replace(new RegExp(pattern.source, pattern.flags), replace);
      context.diagnostics?.secretRedactions.push({
        path: context.path ?? "(unknown)",
        line: context.line ?? 0,
        pattern: name,
      });
    }
  }
  return output;
}
