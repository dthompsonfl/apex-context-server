#!/usr/bin/env node
/** Manifest-controlled, crash-recoverable OpenCode uninstall. */
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configWithoutApex, getJsoncValue, hasJsoncProperty } from "./jsonc-edit.mjs";
import { applyTransaction, exists, journalPath, managedHash, recoverTransaction } from "./opencode-transaction.mjs";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
const scope = flag("--scope", "project");
const dryRun = args.includes("--dry-run");
const recoverOnly = args.includes("--recover");
if (!["project", "user"].includes(scope)) throw new Error("Usage: uninstall-opencode.mjs [--scope project|user] [--dry-run|--recover]");
const project = path.resolve(process.env.APEX_CONTEXT_PROJECT_DIR || process.cwd());
const directory = scope === "project"
  ? path.join(project, ".opencode")
  : path.resolve(process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config/opencode"));
const configPath = scope === "project" ? path.join(project, "opencode.json") : path.join(directory, "opencode.json");
const manifestPath = path.join(directory, "apex-context-manifest.json");
const knownPaths = [
  path.join(directory, "apex-context-server"),
  path.join(directory, "apex-context-instructions.md"),
  ...["apex.md", "apex-boot.md", "apex-find.md", "apex-status.md", "apex-where.md", "apex-refresh.md"]
    .map(name => path.join(directory, "commands", name)),
  path.join(directory, "plugins/apex-context-guard.js"),
];
const allowed = [configPath, manifestPath, ...knownPaths];

async function main() {
  if (await exists(directory) && (await lstat(directory)).isSymbolicLink()) {
    throw new Error("OpenCode config directory cannot be a symlink");
  }
  if (recoverOnly) {
    const recovered = await recoverTransaction(directory, allowed);
    console.log(recovered ? "Recovered incomplete Apex transaction" : "No incomplete transaction");
    return;
  }
  if (await exists(journalPath(directory))) {
    throw new Error("Incomplete Apex transaction exists. Use --recover first.");
  }
  if (!await exists(manifestPath)) throw new Error("No Apex ownership manifest; refusing to delete unmanaged files");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (![1, 2].includes(manifest.version) || manifest.scope !== scope ||
      manifest.configPath !== configPath) throw new Error("Apex manifest scope/version/path mismatch");
  const client = manifest.client ?? "v1";
  if (!["v1", "v2"].includes(client)) throw new Error("Unsupported installed client version");
  if (!await exists(configPath)) throw new Error("Managed OpenCode config is missing; refusing deletion");
  const raw = await readFile(configPath, "utf8");
  const entry = client === "v1" ? ["mcp", "apex-context"] : ["mcp", "servers", "apex-context"];
  if (!hasJsoncProperty(raw, entry) ||
      JSON.stringify(getJsoncValue(raw, entry)) !== JSON.stringify(manifest.server)) {
    throw new Error("Apex MCP entry was changed; refusing to delete user settings");
  }
  const paths = Object.keys(manifest.owned ?? {});
  const expected = new Set(knownPaths);
  if (paths.length !== knownPaths.length || paths.some(target => !expected.has(target))) {
    throw new Error("Manifest ownership list differs from the supported Apex asset set");
  }
  for (const target of paths) {
    if (!await exists(target)) throw new Error("Owned file is missing: " + target);
    if (await managedHash(target) !== manifest.owned[target]) {
      throw new Error("Owned file was modified, refusing uninstall: " + target);
    }
  }
  const nextRaw = configWithoutApex(raw, manifest.mcpCreated, client);
  const shouldDeleteConfig = manifest.configCreated && nextRaw.trim() === "{}";
  console.log(JSON.stringify({
    action: dryRun ? "preview" : "uninstall", scope, client, configPath, ownedPaths: paths,
  }, null, 2));
  if (dryRun) return;
  const changes = [
    ...paths.map(target => ({ target, kind: "delete" })),
    shouldDeleteConfig
      ? { target: configPath, kind: "delete" }
      : { target: configPath, kind: "file", content: nextRaw },
    { target: manifestPath, kind: "delete" },
  ];
  await applyTransaction(directory, changes, allowed);
  console.log("Removed only verified Apex-owned assets and config entry; unrelated settings retained.");
}

main().catch(error => {
  console.error("Apex uninstall failed: " + error.message);
  process.exitCode = 1;
});
