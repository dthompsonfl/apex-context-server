#!/usr/bin/env node
/** Remove only assets recorded in Apex's ownership manifest, preserving user modifications. */
import crypto from "node:crypto";
import { lstat, readFile, readdir, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configWithoutApex, getJsoncValue } from "./jsonc-edit.mjs";

const args = process.argv.slice(2);
const scopeIndex = args.indexOf("--scope");
const scope = scopeIndex < 0 ? "project" : args[scopeIndex + 1];
const dryRun = args.includes("--dry-run");
if (!["project", "user"].includes(scope)) throw new Error("Usage: uninstall-opencode.mjs [--scope project|user] [--dry-run]");
const project = path.resolve(process.env.APEX_CONTEXT_PROJECT_DIR || process.cwd());
const directory = scope === "project" ? path.join(project, ".opencode")
  : path.resolve(process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config/opencode"));
const manifestPath = path.join(directory, "apex-context-manifest.json");

async function exists(p) {
  try { await lstat(p); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
async function hash(target) {
  const info = await lstat(target);
  const digest = crypto.createHash("sha256");
  if (info.isSymbolicLink()) throw new Error("Managed path changed to symlink: " + target);
  if (info.isDirectory()) {
    for (const name of (await readdir(target)).sort()) {
      digest.update(name + "\0");
      digest.update(await hash(path.join(target, name)));
    }
  } else if (info.isFile()) digest.update(await readFile(target));
  else throw new Error("Unsupported managed asset " + target);
  return digest.digest("hex");
}
async function atomic(target, body) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = target + ".apex-" + crypto.randomBytes(6).toString("hex");
  try { await writeFile(tmp, body, { mode: 0o600 }); await rename(tmp, target); }
  finally { await rm(tmp, { force: true }); }
}
async function main() {
  if (!await exists(manifestPath)) throw new Error("No Apex ownership manifest in selected scope; refusing unmanaged uninstall");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.scope !== scope) throw new Error("Manifest version or scope mismatch");
  if (!await exists(manifest.configPath)) throw new Error("Configured OpenCode file is missing");
  const previousRaw = await readFile(manifest.configPath, "utf8");
  const current = getJsoncValue(previousRaw, ["mcp", "apex-context"]);
  if (JSON.stringify(current) !== JSON.stringify(manifest.server)) {
    throw new Error("Apex MCP configuration has changed; refusing uninstall");
  }
  const paths = Object.keys(manifest.owned || {});
  for (const p of paths) {
    if (!await exists(p)) throw new Error("Owned asset is already missing: " + p);
    if (await hash(p) !== manifest.owned[p]) throw new Error("Owned asset modified; refusing deletion: " + p);
  }
  const updatedRaw = configWithoutApex(previousRaw, manifest.mcpCreated);
  console.log(JSON.stringify({ operation: dryRun ? "preview only" : "uninstall", scope, config: manifest.configPath, ownedPaths: paths }, null, 2));
  if (dryRun) return;
  const trash = path.join(directory, ".apex-removal-" + crypto.randomBytes(6).toString("hex"));
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const moved = [];
  let configChanged = false;
  try {
    for (const [index, target] of paths.entries()) {
      const destination = path.join(trash, String(index));
      await rename(target, destination);
      moved.push({ destination, target });
    }
    if (manifest.configCreated && updatedRaw.replace(/\s/g, "") === "{}") {
      await rm(manifest.configPath);
    } else {
      await atomic(manifest.configPath, updatedRaw);
    }
    configChanged = true;
    await rm(manifestPath);
    await rm(trash, { recursive: true, force: true });
    console.log("Apex removed; unrelated OpenCode settings preserved.");
  } catch (err) {
    if (configChanged) await atomic(manifest.configPath, previousRaw);
    for (const { destination, target } of moved.reverse()) await rename(destination, target);
    throw err;
  } finally {
    if (!moved.length) await rm(trash, { recursive: true, force: true });
  }
}
main().catch(err => { console.error("Apex uninstall failed:", err.message); process.exitCode = 1; });
