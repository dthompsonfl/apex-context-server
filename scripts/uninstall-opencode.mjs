#!/usr/bin/env node

import { access, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const opencodeDir =
  process.env.OPENCODE_CONFIG_DIR ||
  path.join(os.homedir(), ".config", "opencode");
const configPath = path.join(opencodeDir, "opencode.json");
const apexPaths = [
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

try {
  await removeConfigEntries();
  for (const targetPath of apexPaths) {
    await rm(targetPath, { recursive: true, force: true });
  }
  console.log("Apex Context Server removed from OpenCode.");
} catch (err) {
  console.error(
    `Apex Context Server uninstall failed: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  process.exitCode = 1;
}

async function removeConfigEntries() {
  if (!(await exists(configPath))) {
    return;
  }

  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);

  if (config.mcp && typeof config.mcp === "object") {
    delete config.mcp["apex-context"];
  }
  if (config.tools && typeof config.tools === "object") {
    delete config.tools["apex-context*"];
  }
  if (Array.isArray(config.instructions)) {
    config.instructions = config.instructions.filter(
      (item) => item !== path.join(opencodeDir, "apex-context-instructions.md"),
    );
  }

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
