#!/usr/bin/env node

import { access, lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const opencodeDir = path.resolve(
  process.env.APEX_CONTEXT_CONFIG_DIR ||
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "opencode"),
);
const configPath = path.join(opencodeDir, "opencode.json");
const manifestPath = path.join(opencodeDir, "apex-context-install-manifest.json");
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");

try {
  const manifest = await readManifest();
  const managed = manifest?.managedFiles?.length ? manifest.managedFiles : defaultManaged();
  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true, opencodeDir, managed, manifestFound: Boolean(manifest) }, null, 2));
    process.exit(0);
  }
  await removeConfigEntries();
  for (const targetPath of managed) await removePath(targetPath);
  await removePath(manifestPath);
  console.log(`Apex Context Server removed from OpenCode config at ${opencodeDir}.`);
} catch (err) {
  console.error(`Apex Context Server uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

async function readManifest() {
  try { return JSON.parse(await readFile(manifestPath, "utf8")); } catch { return null; }
}

function defaultManaged() {
  return [
    path.join(opencodeDir, "apex-context-server"),
    path.join(opencodeDir, "apex-context-instructions.md"),
    path.join(opencodeDir, "commands", "apex.md"),
    path.join(opencodeDir, "commands", "apex-boot.md"),
    path.join(opencodeDir, "commands", "apex-find.md"),
    path.join(opencodeDir, "commands", "apex-status.md"),
    path.join(opencodeDir, "commands", "apex-where.md"),
    path.join(opencodeDir, "commands", "apex-refresh.md"),
    path.join(opencodeDir, "plugins", "apex-context-guard.js"),
  ];
}

async function removeConfigEntries() {
  if (!(await exists(configPath))) return;
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  if (config.mcp && typeof config.mcp === "object") delete config.mcp["apex-context"];
  if (config.tools && typeof config.tools === "object") delete config.tools["apex-context*"];
  if (Array.isArray(config.instructions)) {
    config.instructions = config.instructions.filter((item) => item !== path.join(opencodeDir, "apex-context-instructions.md"));
  }
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function atomicWrite(target, content) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}
async function removePath(targetPath) {
  if (!(await exists(targetPath))) return;
  const st = await lstat(targetPath);
  if (st.isSymbolicLink()) await unlink(targetPath); else await rm(targetPath, { recursive: true, force: true });
}
async function exists(targetPath) { try { await access(targetPath); return true; } catch { return false; } }
