#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opencodeDir =
  process.env.OPENCODE_CONFIG_DIR ||
  path.join(os.homedir(), ".config", "opencode");
const installDir = path.join(opencodeDir, "apex-context-server");
const configPath = path.join(opencodeDir, "opencode.json");
const instructionsPath = path.join(opencodeDir, "apex-context-instructions.md");

if (process.env.APEX_CONTEXT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

try {
  assertSupportedNode();
  await buildServer();
  await copyRuntime();
  await writeInstructions();
  await installOpenCodeAssets();
  await mergeOpenCodeConfig();
  console.log(`Apex Context Server installed for OpenCode at ${installDir}`);
} catch (err) {
  console.error(
    `Apex Context Server setup failed: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  process.exitCode = 1;
}

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node >= 18 is required. Current version: ${process.version}`);
  }
}

async function buildServer() {
  const tscBinary = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );

  if (!(await exists(tscBinary))) {
    if (await exists(path.join(repoRoot, "dist", "index.js"))) {
      return;
    }

    throw new Error(
      "TypeScript is not installed yet. Run npm install from the Apex Context Server root.",
    );
  }

  await run(tscBinary, ["--pretty", "false"], { cwd: repoRoot });
}

async function copyRuntime() {
  if (!(await exists(path.join(repoRoot, "dist", "index.js")))) {
    throw new Error("Build did not produce dist/index.js.");
  }

  await mkdir(opencodeDir, { recursive: true });
  await removePath(installDir);
  await mkdir(installDir, { recursive: true });

  await copyPath("dist");
  await copyPath("node_modules");
  await copyPath("package.json");
  await copyPath("package-lock.json", { optional: true });
  await copyPath("README.md", { optional: true });
  await copyPath("scripts", { optional: true });
  await copyPath("opencode", { optional: true });
}

async function copyPath(relativePath, options = {}) {
  const source = path.join(repoRoot, relativePath);
  const target = path.join(installDir, relativePath);

  if (!(await exists(source))) {
    if (options.optional) {
      return;
    }

    throw new Error(`Required runtime path is missing: ${source}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: true,
    force: true,
    preserveTimestamps: true,
  });
}

async function writeInstructions() {
  const content = `# Apex Context Server Defaults

When searching, indexing, mapping, or reading code, Apex Context Server is the default system.

- Start repository work with apex-context_prime_workspace_context so the TUI shows the Apex dashboard.
- Use apex-context_get_agent_boot_context as the compact repo brief at the start of substantial work.
- Use apex-context_get_context_health to confirm the index and guard telemetry are active.
- Use apex-context_watch_workspace_memory to start/report the live watcher.
- Use apex-context_get_workspace_memory to inspect the persistent codebase memory map.
- Use apex-context_refresh_workspace_memory after file edits, branch switches, renames, or when the dashboard says memory is stale.
- Use apex-context_refresh_changed_files to refresh changed/deleted files after edits.
- Use apex-context_locate_code first whenever you need to know where something lives. It checks memory maps for symbols, files, routes, imports, and content lines before any shell search.
- Use apex-context_read_context_bundle before edits. It returns exports, imports, importers, nearby source, tests, docs, package metadata, hash, and mtime.
- Use apex-context_get_workspace_topology to understand Turborepo package relationships.
- Use apex-context_index_workspace when starting work in a repository or after broad file changes; it loads or rebuilds the same persistent memory.
- Use apex-context_search_code only for exact text search after locate_code has narrowed the target.
- Use apex-context_find_symbol to locate exported functions, components, classes, types, and constants.
- Use apex-context_read_component_context before editing or explaining a specific exported symbol so local and imported type context is included.

Avoid broad raw shell search. The Apex TUI guard plugin blocks broad rg, grep, find, fd, tree, and ls -R discovery commands by default. Use raw shell search only when Apex does not cover the needed file type or when validating exact filesystem state. To intentionally override the guard, prefix the shell command with APEX_CONTEXT_ALLOW_RAW_SEARCH=1.

TUI commands:

- /apex: prime the visual Apex dashboard and proceed with the user's task.
- /apex-boot: load the agent boot context.
- /apex-find: locate code using Apex symbol and text search.
- /apex-status: show Apex context health and raw-search guard telemetry.
- /apex-where: ask Apex memory where something lives.
- /apex-refresh: rebuild Apex memory after code changes.
`;

  await writeFile(instructionsPath, content, "utf8");
}

async function installOpenCodeAssets() {
  await copyDirectoryContents("opencode/commands", path.join(opencodeDir, "commands"));
  await copyDirectoryContents("opencode/plugins", path.join(opencodeDir, "plugins"));
}

async function copyDirectoryContents(relativeSourceDir, targetDir) {
  const sourceDir = path.join(repoRoot, relativeSourceDir);
  if (!(await exists(sourceDir))) {
    return;
  }

  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    await cp(source, target, {
      recursive: true,
      dereference: true,
      force: true,
      preserveTimestamps: true,
    });
  }
}

async function mergeOpenCodeConfig() {
  await mkdir(opencodeDir, { recursive: true });

  const existingRaw = (await exists(configPath))
    ? await readFile(configPath, "utf8")
    : "";
  const config = existingRaw ? parseJsonc(existingRaw, configPath) : {};
  if (!isPlainObject(config)) {
    throw new Error(`${configPath} must contain a JSON object.`);
  }

  config.$schema ||= "https://opencode.ai/config.json";
  config.mcp = isPlainObject(config.mcp) ? config.mcp : {};
  config.tools = isPlainObject(config.tools) ? config.tools : {};

  const serverEntry = path.join(installDir, "dist", "index.js");
  config.mcp["apex-context"] = {
    type: "local",
    command: ["node", serverEntry],
    cwd: ".",
    enabled: true,
    timeout: 15000,
  };
  config.tools["apex-context*"] = true;

  const currentInstructions = Array.isArray(config.instructions)
    ? config.instructions
    : config.instructions === undefined
      ? []
      : [config.instructions];
  config.instructions = uniqueStrings([...currentInstructions, instructionsPath]);

  const nextRaw = `${JSON.stringify(config, null, 2)}\n`;
  if (existingRaw === nextRaw) {
    return;
  }

  if (existingRaw) {
    const backupPath = `${configPath}.bak-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`;
    await writeFile(backupPath, existingRaw, "utf8");
  }

  await writeFile(configPath, nextRaw, "utf8");
}

function parseJsonc(raw, sourceName) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(removeTrailingCommas(stripJsonComments(raw)));
    } catch (err) {
      throw new Error(
        `Could not parse ${sourceName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function removeTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (/\s/.test(input[j] || "")) {
        j += 1;
      }
      if (input[j] === "}" || input[j] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

async function removePath(targetPath) {
  if (!(await exists(targetPath))) {
    return;
  }

  const targetStat = await lstat(targetPath);
  if (targetStat.isSymbolicLink()) {
    await unlink(targetPath);
    return;
  }

  await rm(targetPath, { recursive: true, force: true });
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))];
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, APEX_CONTEXT_SKIP_POSTINSTALL: "1" },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}
