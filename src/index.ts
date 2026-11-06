#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { extractComponentContext } from "./ast.js";
import { getAgentBootContext, readContextBundle } from "./context.js";
import { getContextHealth, primeWorkspaceContext } from "./dashboard.js";
import {
  buildWorkspaceIndex,
  createWorkspaceMemorySnapshot,
  findSymbol,
  getIndexDiagnostics,
  formatIndexSummary,
  formatMemorySummary,
  locateCode,
  refreshChangedFiles,
  searchCode,
} from "./indexer.js";
import { formatTopologySummary, getWorkspaceTopology } from "./topology.js";
import {
  getWatcherStatus,
  refreshChangedWorkspaceFiles,
  watchWorkspaceMemory,
} from "./watcher.js";
import { truncateToolText } from "./paths.js";
import { redactText } from "./redact.js";

const server = new Server(
  { name: "apex-context-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_agent_boot_context",
      description:
        "Return a compact, fresh startup brief: workspace shape, entry files, routes, diagnostics, and the required Apex memory workflow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          maxFiles: { type: "number", description: "Maximum file rows to include. Defaults to 20." },
        },
        required: [],
      },
    },
    {
      name: "read_context_bundle",
      description:
        "Return edit-ready context for a file, symbol, route, or query: exports, imports, importers, nearby source, related tests/docs, package metadata, hash, and mtime.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          query: { type: "string", description: "Optional query to resolve through Apex memory." },
          filepath: { type: "string", description: "Optional target file path (must be within authorized root)." },
          nodeName: { type: "string", description: "Optional exported symbol name." },
          maxRelated: { type: "number", description: "Maximum related test/doc files to include (default 12)." },
        },
        required: [],
      },
    },
    {
      name: "watch_workspace_memory",
      description:
        "Start or report the live workspace memory watcher. Uses chokidar when available and records changed/deleted files per workspace.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
        },
        required: [],
      },
    },
    {
      name: "refresh_changed_files",
      description:
        "Refresh Apex memory after changed/deleted files are detected and report the changed-file refresh result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
        },
        required: [],
      },
    },
    {
      name: "get_index_diagnostics",
      description:
        "Report index diagnostics: skipped files, parse failures, secret redactions, alias misses, watcher status, and refresh metadata.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
        },
        required: [],
      },
    },
    {
      name: "prime_workspace_context",
      description:
        "Render the Apex TUI dashboard: workspace topology, index health, guard telemetry, and the required low-token context workflow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          force: { type: "boolean", description: "Force a fresh index rebuild before rendering the dashboard." },
          maxPackages: { type: "number", description: "Maximum package rows to show. Defaults to 12." },
          maxFiles: { type: "number", description: "Maximum hot-file rows to show. Defaults to 12." },
        },
        required: [],
      },
    },
    {
      name: "get_context_health",
      description:
        "Show a compact Apex health panel for the TUI, including index status and raw-search guard telemetry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
        },
        required: [],
      },
    },
    {
      name: "get_workspace_topology",
      description:
        "Scan apps/* and packages/* package manifests and return a workspace dependency graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
        },
        required: [],
      },
    },
    {
      name: "get_workspace_memory",
      description:
        "Return the persistent Apex workspace memory map: index path, counts, hot files, routes, and likely entry points.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          maxFiles: { type: "number", description: "Maximum file rows to include. Defaults to 25." },
        },
        required: [],
      },
    },
    {
      name: "refresh_workspace_memory",
      description:
        "Force rebuild the durable Apex workspace memory index and persist it for instant future lookups.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
        },
        required: [],
      },
    },
    {
      name: "locate_code",
      description:
        "Instantly answer where code lives using Apex's persistent memory maps across symbols, files, routes, imports, and content lines.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Natural language, symbol, file, route, or import target to locate." },
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          maxResults: { type: "number", description: "Maximum result count, capped at 200. Defaults to 25." },
          kind: { type: "string", enum: ["any", "symbol", "file", "import", "line", "route"], description: "Optional location type filter. Defaults to any." },
        },
        required: ["query"],
      },
    },
    {
      name: "index_workspace",
      description:
        "Build or load the persistent Apex code memory for the active workspace, including files, imports, exported symbols, and token maps.",
      inputSchema: {
        type: "object" as const,
        properties: {
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          force: { type: "boolean", description: "Force a rebuild instead of returning the cached index." },
        },
        required: [],
      },
    },
    {
      name: "search_code",
      description:
        "Search repository code using the Apex index. Supports plain text and regular-expression queries.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "The text or regular expression to search for." },
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          glob: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Optional glob or list of globs to limit searched files, relative to the workspace root." },
          maxResults: { type: "number", description: "Maximum result count, capped at 200. Defaults to 50." },
          caseSensitive: { type: "boolean", description: "Whether matching should be case-sensitive." },
          regex: { type: "boolean", description: "Treat query as a JavaScript regular expression." },
        },
        required: ["query"],
      },
    },
    {
      name: "find_symbol",
      description:
        "Find exported symbols discovered by the Apex AST index, returning file and line locations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Symbol name or partial symbol name." },
          root: { type: "string", description: "Optional workspace root. Defaults to the MCP process working directory." },
          exact: { type: "boolean", description: "Require an exact symbol name match." },
          maxResults: { type: "number", description: "Maximum result count, capped at 200. Defaults to 50." },
        },
        required: ["query"],
      },
    },
    {
      name: "read_component_context",
      description:
        "Extract an exported symbol plus imported and local type definitions it depends on. File access is restricted to the authorized workspace root.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filepath: { type: "string", description: "Path to the source file, relative to root or absolute (must remain within authorized root)." },
          nodeName: { type: "string", description: "The exported symbol name to extract." },
          root: { type: "string", description: "Optional workspace root used for authorization. Defaults to the MCP process working directory." },
        },
        required: ["filepath", "nodeName"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = objectArgs(args);

  switch (name) {
    case "get_agent_boot_context":
      return asToolResult(async () =>
        getAgentBootContext({
          root: optionalString(input.root, "root"),
          maxFiles: optionalNumber(input.maxFiles, "maxFiles"),
        }), "Error building Apex agent boot context");

    case "read_context_bundle":
      return asToolResult(async () =>
        readContextBundle({
          root: optionalString(input.root, "root"),
          query: optionalString(input.query, "query"),
          filepath: optionalString(input.filepath, "filepath"),
          nodeName: optionalString(input.nodeName, "nodeName"),
          maxRelated: optionalNumber(input.maxRelated, "maxRelated"),
        }), "Error reading Apex context bundle");

    case "watch_workspace_memory":
      return asToolResult(async () => {
        const status = await watchWorkspaceMemory({ root: optionalString(input.root, "root") });
        return JSON.stringify(status, null, 2);
      }, "Error starting Apex workspace watcher");

    case "refresh_changed_files":
      return asToolResult(async () =>
        refreshChangedWorkspaceFiles({ root: optionalString(input.root, "root") }),
        "Error refreshing changed files");

    case "get_index_diagnostics":
      return asToolResult(async () => {
        const root = optionalString(input.root, "root");
        const diagnostics = await getIndexDiagnostics({ root });
        const watcher = getWatcherStatus(root);
        return JSON.stringify({ ...diagnostics, watcher }, null, 2);
      }, "Error reading Apex index diagnostics");

    case "prime_workspace_context":
      return asToolResult(async () =>
        primeWorkspaceContext({
          root: optionalString(input.root, "root"),
          force: optionalBoolean(input.force, "force") ?? false,
          maxPackages: optionalNumber(input.maxPackages, "maxPackages"),
          maxFiles: optionalNumber(input.maxFiles, "maxFiles"),
        }), "Error priming Apex workspace context");

    case "get_context_health":
      return asToolResult(async () =>
        getContextHealth({ root: optionalString(input.root, "root") }),
        "Error reading Apex context health");

    case "get_workspace_topology":
      return asToolResult(async () => {
        const topology = await getWorkspaceTopology(optionalString(input.root, "root"));
        return `${formatTopologySummary(topology)}\n\n${JSON.stringify(topology, null, 2)}`;
      }, "Error scanning workspace");

    case "get_workspace_memory":
      return asToolResult(async () => {
        const index = await buildWorkspaceIndex({ root: optionalString(input.root, "root") });
        return `${formatMemorySummary(index)}\n\n${JSON.stringify(
          createWorkspaceMemorySnapshot(index, optionalNumber(input.maxFiles, "maxFiles") ?? 25),
          null, 2,
        )}`;
      }, "Error reading Apex workspace memory");

    case "refresh_workspace_memory":
      return asToolResult(async () => {
        const index = await refreshChangedFiles({ root: optionalString(input.root, "root") });
        return `${formatIndexSummary(index)}\n\n${JSON.stringify(createWorkspaceMemorySnapshot(index, 25), null, 2)}`;
      }, "Error refreshing Apex workspace memory");

    case "locate_code":
      return asToolResult(async () => {
        const result = await locateCode(requiredString(input.query, "query"), {
          root: optionalString(input.root, "root"),
          maxResults: optionalNumber(input.maxResults, "maxResults"),
          kind: optionalLocationKind(input.kind, "kind"),
        });
        return JSON.stringify(result, null, 2);
      }, "Error locating code from Apex memory");

    case "index_workspace":
      return asToolResult(async () => {
        const index = await buildWorkspaceIndex({
          root: optionalString(input.root, "root"),
          force: optionalBoolean(input.force, "force") ?? false,
        });
        return `${formatIndexSummary(index)}\n\n${JSON.stringify(createWorkspaceMemorySnapshot(index, 25), null, 2)}`;
      }, "Error indexing workspace");

    case "search_code":
      return asToolResult(async () => {
        const result = await searchCode(requiredString(input.query, "query"), {
          root: optionalString(input.root, "root"),
          glob: optionalStringOrStringArray(input.glob, "glob"),
          maxResults: optionalNumber(input.maxResults, "maxResults"),
          caseSensitive: optionalBoolean(input.caseSensitive, "caseSensitive") ?? false,
          regex: optionalBoolean(input.regex, "regex") ?? false,
        });
        return JSON.stringify(result, null, 2);
      }, "Error searching code");

    case "find_symbol":
      return asToolResult(async () => {
        const result = await findSymbol(requiredString(input.query, "query"), {
          root: optionalString(input.root, "root"),
          exact: optionalBoolean(input.exact, "exact") ?? false,
          maxResults: optionalNumber(input.maxResults, "maxResults"),
        });
        return JSON.stringify(result, null, 2);
      }, "Error finding symbol");

    case "read_component_context":
      return asToolResult(async () => {
        return extractComponentContext(
          requiredString(input.filepath, "filepath"),
          requiredString(input.nodeName, "nodeName"),
          optionalString(input.root, "root"),
        );
      }, "Error extracting component context");

    default:
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
  }
});

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("apex-context-server: listening on stdio");
}

export { server };

const isDirectRun =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error("apex-context-server: fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

async function asToolResult(
  fn: () => Promise<string>,
  errorPrefix: string,
): Promise<
  | { content: Array<{ type: "text"; text: string }> }
  | { isError: true; content: Array<{ type: "text"; text: string }> }
> {
  try {
    const text = truncateToolText(redactText(await fn(), { path: "tool-response" }));
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = redactText(`${errorPrefix}: ${err instanceof Error ? err.message : String(err)}`, { path: "tool-error" });
    return { isError: true, content: [{ type: "text", text: truncateToolText(message) }] };
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${name}" must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${name}" must be a non-empty string when provided.`);
  return value;
}

function optionalStringOrStringArray(value: unknown, name: string): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "")) return value;
  throw new Error(`"${name}" must be a non-empty string or string array.`);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`"${name}" must be a boolean when provided.`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${name}" must be a finite number when provided.`);
  return value;
}

function optionalLocationKind(value: unknown, name: string): "any" | "symbol" | "file" | "import" | "line" | "route" | undefined {
  if (value === undefined) return undefined;
  if (value === "any" || value === "symbol" || value === "file" || value === "import" || value === "line" || value === "route") return value;
  throw new Error(`"${name}" must be one of any, symbol, file, import, line, route.`);
}
