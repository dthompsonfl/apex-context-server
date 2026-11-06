#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opencodeDir = path.resolve(
  process.env.APEX_CONTEXT_CONFIG_DIR ||
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "opencode"),
);
const installDir = path.join(opencodeDir, "apex-context-server");
const configPath = path.join(opencodeDir, "opencode.json");
const instructionsPath = path.join(opencodeDir, "apex-context-instructions.md");
const manifestPath = path.join(opencodeDir, "apex-context-install-manifest.json");
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SCOPE = args.has("--project") ? "project" : "user"; // project scope still targets CWD/.opencode via env

if (args.has("--help")) {
  console.log("Usage: node scripts/setup-opencode.mjs [--dry-run] [--project]\n" +
    "Installs Apex Context Server into the selected OpenCode config directory.\n" +
    "Set APEX_CONTEXT_CONFIG_DIR or OPENCODE_CONFIG_DIR to control the target.");
  process.exit(0);
}

if (process.env.APEX_CONTEXT_SKIP_POSTINSTALL === "1") process.exit(0);

try {
  assertSupportedNode();
  await buildServer();
  const plan = await buildPlan();
  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true, scope: SCOPE, opencodeDir, ...plan }, null, 2));
    process.exit(0);
  }
  await applyPlan(plan);
  console.log(`Apex Context Server installed for OpenCode (${SCOPE}) at ${installDir}`);
} catch (err) {
  console.error(`Apex Context Server setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node >= 18 is required. Current version: ${process.version}`);
  }
}

async function buildServer() {
  if (await exists(path.join(repoRoot, "dist", "index.js"))) return;
  const res = spawnSync(process.execPath, ["./node_modules/typescript/bin/tsc", "--pretty", "false"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, APEX_CONTEXT_SKIP_POSTINSTALL: "1" } });
  if (res.status !== 0) throw new Error(`Build failed: ${res.stderr || res.stdout}`);
  if (!(await exists(path.join(repoRoot, "dist", "index.js")))) throw new Error("Build did not produce dist/index.js.");
}

async function buildPlan() {
  const managedAssets = await collectManagedAssets();
  const configPatch = await computeConfigPatch();
  return { managedAssets, configPatch, manifestPath };
}

async function collectManagedAssets() {
  const assets = [];
  for (const rel of ["dist", "node_modules", "package.json", "package-lock.json", "README.md", "scripts", "opencode", "docs"]) {
    const source = path.join(repoRoot, rel);
    if (await exists(source)) assets.push({ source, target: path.join(installDir, rel), rel });
  }
  const commandDir = path.join(repoRoot, "opencode", "commands");
  if (await exists(commandDir)) {
    for (const e of await readdir(commandDir)) assets.push({ source: path.join(commandDir, e), target: path.join(opencodeDir, "commands", e), rel: `commands/${e}`, managed: true });
  }
  const pluginDir = path.join(repoRoot, "opencode", "plugins");
  if (await exists(pluginDir)) {
    for (const e of await readdir(pluginDir)) assets.push({ source: path.join(pluginDir, e), target: path.join(opencodeDir, "plugins", e), rel: `plugins/${e}`, managed: true });
  }
  assets.push({ sourceText: instructionsContent(), target: instructionsPath, rel: "apex-context-instructions.md", managed: true });
  return assets;
}

function instructionsContent() {
  return `# Apex Context Server Defaults\n\n- Start with apex-context_prime_workspace_context / apex-context_get_agent_boot_context.\n- Use apex-context_locate_code first, then apex-context_read_context_bundle.\n- Use apex-context_refresh_changed_files after edits.\n- Broad raw shell discovery is discouraged; guard default mode is warn (set APEX_CONTEXT_GUARD_MODE=strict to block).\n- Override raw search only with APEX_CONTEXT_ALLOW_RAW_SEARCH=1 when truly required.\n`;
}

async function computeConfigPatch() {
  await mkdir(opencodeDir, { recursive: true });
  const existingRaw = (await exists(configPath)) ? await readFile(configPath, "utf8") : "";
  const config = existingRaw ? parseJsonc(existingRaw, configPath) : {};
  if (!isPlainObject(config)) throw new Error(`${configPath} must contain a JSON object.`);
  const before = JSON.stringify(config);
  config.$schema ||= "https://opencode.ai/config.json";
  config.mcp = isPlainObject(config.mcp) ? config.mcp : {};
  config.tools = isPlainObject(config.tools) ? config.tools : {};
  config.mcp["apex-context"] = { type: "local", command: ["node", path.join(installDir, "dist", "index.js")], cwd: ".", enabled: true, timeout: 15000, env: { APEX_CONTEXT_CONFIG_DIR: opencodeDir } };
  config.tools["apex-context*"] = true;
  const currentInstructions = Array.isArray(config.instructions) ? config.instructions : config.instructions === undefined ? [] : [config.instructions];
  config.instructions = uniqueStrings([...currentInstructions, instructionsPath]);
  const nextRaw = `${JSON.stringify(config, null, 2)}\n`;
  return { existingRaw, nextRaw, changed: before !== JSON.stringify(config) };
}

async function applyPlan(plan) {
  await mkdir(opencodeDir, { recursive: true, mode: 0o700 });
  const backupDir = path.join(opencodeDir, `apex-context-backup-${Date.now()}`);
  const manifest = { schemaVersion: 1, opencodeDir, installDir, createdAt: new Date().toISOString(), scope: SCOPE, managedFiles: [], configBackup: null };

  try {
    // config backup + atomic write
    if (plan.configPatch.existingRaw) {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const cfgBak = path.join(backupDir, "opencode.json.bak");
      await writeFile(cfgBak, plan.configPatch.existingRaw, { encoding: "utf8", mode: 0o600 });
      manifest.configBackup = cfgBak;
    }
    if (plan.configPatch.changed || !plan.configPatch.existingRaw) await atomicWrite(configPath, plan.configPatch.nextRaw);

    await removePath(installDir);
    await mkdir(installDir, { recursive: true });
    for (const asset of plan.managedAssets) {
      await mkdir(path.dirname(asset.target), { recursive: true });
      if (asset.sourceText != null) await atomicWrite(asset.target, asset.sourceText);
      else await cp(asset.source, asset.target, { recursive: true, dereference: true, force: true, preserveTimestamps: true });
      manifest.managedFiles.push(asset.target);
    }
    manifest.managedFiles.push(installDir);
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (err) {
    await rollback(manifest).catch(() => {});
    throw err;
  }
}

async function rollback(manifest) {
  for (const target of [...(manifest.managedFiles || [])].reverse()) await removePath(target).catch(() => {});
  if (manifest.configBackup && await exists(manifest.configBackup)) {
    await atomicWrite(configPath, await readFile(manifest.configBackup, "utf8"));
  }
}

function parseJsonc(raw, sourceName) {
  try { return JSON.parse(raw); }
  catch {
    try { return JSON.parse(removeTrailingCommas(stripJsonComments(raw))); }
    catch (err) { throw new Error(`Could not parse ${sourceName}: ${err instanceof Error ? err.message : String(err)}`); }
  }
}
function stripJsonComments(input) {
  let output = "", inString = false, escaped = false, inLine = false, inBlock = false;
  for (let i=0;i<input.length;i++){ const c=input[i], n=input[i+1];
    if(inLine){ if(c==="\n"){inLine=false; output+=c;} continue; }
    if(inBlock){ if(c==="*"&&n==="/"){inBlock=false;i++;} else if(c==="\n") output+=c; continue; }
    if(inString){ output+=c; if(escaped) escaped=false; else if(c==="\\") escaped=true; else if(c==="\"") inString=false; continue; }
    if(c==="\""){ inString=true; output+=c; continue; }
    if(c==="/"&&n==="/"){ inLine=true; i++; continue; }
    if(c==="/"&&n==="*"){ inBlock=true; i++; continue; }
    output+=c;
  } return output;
}
function removeTrailingCommas(input) {
  let output = "", inString = false, escaped = false;
  for (let i=0;i<input.length;i++){ const c=input[i];
    if(inString){ output+=c; if(escaped) escaped=false; else if(c==="\\") escaped=true; else if(c==="\"") inString=false; continue; }
    if(c==="\""){ inString=true; output+=c; continue; }
    if(c===","){ let j=i+1; while(/\s/.test(input[j]||"")) j++; if(input[j]==="}"||input[j]==="]") continue; }
    output+=c;
  } return output;
}
async function atomicWrite(target, content) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}
async function removePath(targetPath) {
  if (!(await exists(targetPath))) return;
  const st = await lstat(targetPath);
  if (st.isSymbolicLink()) await unlink(targetPath); else await rm(targetPath, { recursive: true, force: true });
}
async function exists(targetPath) { try { await access(targetPath); return true; } catch { return false; } }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function uniqueStrings(values) { return [...new Set(values.filter((v) => typeof v === "string"))]; }
