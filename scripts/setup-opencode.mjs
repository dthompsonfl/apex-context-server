#!/usr/bin/env node
/**
 * Opt-in OpenCode installer. Stages every mutation before commit and retains a
 * durable recovery journal across crashes. User scope is never implicit.
 */
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configWithApex, getJsoncValue, hasJsoncProperty } from "./jsonc-edit.mjs";
import { applyTransaction, exists, journalPath, managedHash, recoverTransaction } from "./opencode-transaction.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const scope = flag("--scope", "project");
const client = flag("--client", "v1");
const dryRun = args.includes("--dry-run");
const recoverOnly = args.includes("--recover");
if (!["project", "user"].includes(scope) || !["v1", "v2"].includes(client)) {
  throw new Error("Usage: setup-opencode.mjs [--scope project|user] [--client v1|v2] [--dry-run|--recover]");
}
const projectDir = path.resolve(process.env.APEX_CONTEXT_PROJECT_DIR || process.cwd());
const opencodeDir = scope === "project"
  ? path.join(projectDir, ".opencode")
  : path.resolve(process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config/opencode"));
const configPath = scope === "project"
  ? path.join(projectDir, "opencode.json")
  : path.join(opencodeDir, "opencode.json");
const manifestPath = path.join(opencodeDir, "apex-context-manifest.json");
const installDir = path.join(opencodeDir, "apex-context-server");
const instructionsPath = path.join(opencodeDir, "apex-context-instructions.md");
const assets = [
  ...["apex.md", "apex-boot.md", "apex-find.md", "apex-status.md", "apex-where.md", "apex-refresh.md"].map(name => ({
    source: path.join(repo, "opencode/commands", name),
    target: path.join(opencodeDir, "commands", name),
  })),
  {
    source: path.join(repo, "opencode/plugins/apex-context-guard.js"),
    target: path.join(opencodeDir, "plugins/apex-context-guard.js"),
  },
];
const managedPaths = [installDir, instructionsPath, ...assets.map(asset => asset.target)];
const allowed = [configPath, manifestPath, ...managedPaths];
const server = client === "v1"
  ? { type: "local", command: [process.execPath, path.join(installDir, "dist/index.js")], enabled: true, timeout: 30000 }
  : { type: "local", command: [process.execPath, path.join(installDir, "dist/index.js")], cwd: projectDir };
const mcpPath = client === "v1" ? ["mcp", "apex-context"] : ["mcp", "servers", "apex-context"];
const otherPath = client === "v1" ? ["mcp", "servers", "apex-context"] : ["mcp", "apex-context"];

async function main() {
  if (await exists(opencodeDir) && (await lstat(opencodeDir)).isSymbolicLink()) {
    throw new Error("OpenCode install directory cannot be a symlink");
  }
  if (recoverOnly) {
    const recovered = await recoverTransaction(opencodeDir, allowed);
    console.log(recovered ? "Recovered incomplete Apex transaction" : "No incomplete transaction");
    return;
  }
  if (await exists(journalPath(opencodeDir))) {
    throw new Error("Incomplete transaction found. Run setup:opencode with --recover before installing.");
  }
  const previous = await exists(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
  if (previous && (![1, 2].includes(previous.version) ||
      previous.scope !== scope || previous.configPath !== configPath)) {
    throw new Error("Existing manifest belongs to another scope or unsupported schema");
  }
  if (previous && (previous.client ?? "v1") !== client) {
    throw new Error("Changing OpenCode client version requires uninstalling the previous managed installation first");
  }
  const configExisted = await exists(configPath);
  const raw = configExisted ? await readFile(configPath, "utf8") : "{}\n";
  const hadMcp = hasJsoncProperty(raw, ["mcp"]);
  const found = hasJsoncProperty(raw, mcpPath) ? getJsoncValue(raw, mcpPath) : undefined;
  if (hasJsoncProperty(raw, otherPath)) throw new Error("Conflicting Apex MCP entry in the other client schema");
  if (found !== undefined && !previous) {
    throw new Error("Apex MCP entry already exists and is not owned by this installer");
  }
  if (previous && JSON.stringify(found) !== JSON.stringify(previous.server)) {
    throw new Error("Apex MCP entry was manually modified; refusing to overwrite it");
  }
  for (const target of managedPaths) {
    const onDisk = await exists(target);
    if (onDisk && !previous?.owned?.[target]) throw new Error("Unowned Apex destination: " + target);
    if (!onDisk && previous?.owned?.[target]) throw new Error("Previously managed asset was removed: " + target);
    if (onDisk && await managedHash(target) !== previous.owned[target]) {
      throw new Error("Managed asset changed since installation: " + target);
    }
  }
  const nextConfig = configWithApex(raw, server, client);
  const instructions = [
    "# Apex Context Server",
    "Use locate_code before broad discovery and read_context_bundle before edits.",
    "Start the optional watcher when useful. The raw-search guard is warning-only unless you select strict mode.",
    "Workspace source can contain sensitive data; inspect generated context before sharing.",
    "",
  ].join("\n");
  const changes = [
    { target: installDir, kind: "runtime", source: repo },
    { target: instructionsPath, kind: "file", content: instructions },
    ...assets.map(asset => ({
      target: asset.target, kind: "file", source: asset.source,
    })),
    { target: configPath, kind: "file", content: nextConfig },
  ];
  console.log(JSON.stringify({
    action: dryRun ? "preview" : "install", scope, client, configPath,
    managedPaths, preservesUnrelatedConfig: true,
  }, null, 2));
  if (dryRun) return;
  if (!await exists(path.join(repo, "dist/index.js")) ||
      !await exists(path.join(repo, "node_modules"))) {
    throw new Error("Install project-local dependencies and build first: npm ci && npm run build");
  }
  // Read asset contents before starting a mutating transaction.
  for (const entry of changes) {
    if (entry.source && entry.kind === "file") entry.content = await readFile(entry.source);
  }
  changes.push({
    target: manifestPath, kind: "derivedFile",
    prepare(entries) {
      const owned = {};
      for (const target of managedPaths) {
        owned[target] = entries.find(entry => entry.target === target)?.after;
        if (!owned[target]) throw new Error("Missing staged asset hash in Apex transaction");
      }
      return JSON.stringify({
        version: 2, scope, client, configPath,
        configCreated: !configExisted, mcpCreated: !hadMcp,
        server, owned,
      }, null, 2) + "\n";
    },
  });
  await applyTransaction(opencodeDir, changes, allowed);
  console.log("Apex OpenCode integration installed transactionally; uninstall with matching --scope.");
}

main().catch(error => {
  console.error("Apex setup failed: " + error.message);
  process.exitCode = 1;
});
