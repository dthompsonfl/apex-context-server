import crypto from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ||
  path.join(os.homedir(), ".config", "opencode");
const STATE_PATH = path.join(CONFIG_DIR, "apex-context-usage.json");
const ALLOW_RAW_SEARCH_MARKER = "APEX_CONTEXT_ALLOW_RAW_SEARCH=1";
const ROOT = path.resolve(process.env.APEX_CONTEXT_ROOT || process.cwd());
const ROOT_HASH = hashRoot(ROOT);

export const ApexContextGuard = async ({ client }) => {
  return {
    "tool.execute.before": async (input, output) => {
      const toolName = normalizeToolName(input?.tool);

      if (isApexTool(toolName)) {
        return;
      }

      if (!isShellTool(toolName)) {
        return;
      }

      const command = getCommand(output?.args ?? input?.args);
      if (!command || command.includes(ALLOW_RAW_SEARCH_MARKER)) {
        if (command?.includes(ALLOW_RAW_SEARCH_MARKER)) {
          await updateWorkspaceState((state) => {
            state.rawSearchAllowed = (state.rawSearchAllowed ?? 0) + 1;
          });
        }
        return;
      }

      if (!isBroadSearchCommand(command)) {
        return;
      }

      const strict = process.env.APEX_CONTEXT_GUARD_MODE === "strict";
      await updateWorkspaceState((state) => {
        if (strict) state.rawSearchBlocked = (state.rawSearchBlocked ?? 0) + 1;
        else state.rawSearchWarned = (state.rawSearchWarned ?? 0) + 1;
        state.lastBroadSearchCommand = command.slice(0, 500);
      });

      const message = [
        "Apex Context Guard detected a broad CLI search.",
        "",
        "Use Apex instead:",
        "- apex-context_search_code for text search",
        "- apex-context_find_symbol for exported symbols",
        "- apex-context_read_component_context before editing a symbol",
        "",
        `Blocked command: ${command}`,
        "",
        `If this shell search is truly required, rerun it with ${ALLOW_RAW_SEARCH_MARKER}.`,
      ].join("\n");

      await log(client, "warn", message);

      if (!strict) {
        return;
      }

      throw new Error(message);
    },

    "tool.execute.after": async (input) => {
      const toolName = normalizeToolName(input?.tool);
      if (!isApexTool(toolName)) {
        return;
      }

      await updateWorkspaceState((state) => {
        state.apexToolCalls = (state.apexToolCalls ?? 0) + 1;
        state.lastApexTool = toolName;
        if (
          toolName.includes("refresh_workspace_memory") ||
          toolName.includes("index_workspace") ||
          toolName.includes("prime_workspace_context")
        ) {
          state.memoryStale = false;
        }
      });
    },

    event: async ({ event }) => {
      if (isFileLifecycleEvent(event?.type)) {
        await updateWorkspaceState((state) => {
          state.memoryStale = true;
          state.lastFileEvent = event.type;
          const changed = event?.properties?.file || event?.properties?.path;
          if (changed && typeof changed === "string") {
            if (event.type === "file.deleted") {
              state.deletedFiles = uniqueStrings([...(state.deletedFiles ?? []), changed]);
            } else {
              state.changedFiles = uniqueStrings([...(state.changedFiles ?? []), changed]);
            }
          }
        });
        return;
      }

      if (event?.type !== "session.created") {
        return;
      }

      await log(
        client,
        "info",
        "Apex Context Guard active. Use /apex to render the context dashboard.",
      );
    },
  };
};

function normalizeToolName(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isApexTool(toolName) {
  return toolName.includes("apex-context");
}

function isShellTool(toolName) {
  return ["bash", "shell", "terminal"].includes(toolName);
}

function getCommand(args) {
  if (!args || typeof args !== "object") {
    return "";
  }

  for (const key of ["command", "cmd", "shell", "script"]) {
    if (typeof args[key] === "string") {
      return args[key].trim();
    }
  }

  return "";
}

function isBroadSearchCommand(command) {
  const normalized = command.replace(/\s+/g, " ").trim();
  const first = normalized.split(" ")[0]?.toLowerCase() ?? "";

  if (["rg", "ag", "ack"].includes(first)) {
    return !hasTargetedPath(normalized);
  }

  return [
    /^\bfd\b/i,
    /^\bgrep\b.*\s(-R|-r|--recursive)\b/i,
    /^\bfind\s+(\.|\$PWD|\/workspace|\/|[~])/i,
    /^\bls\b.*\s-R\b/i,
    /^\btree\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function hasTargetedPath(command) {
  const tokens = command.match(/(?:"[^"]+"|'[^']+'|\S+)/g) ?? [];
  return tokens.some((token) => {
    const cleaned = token.replace(/^['"]|['"]$/g, "");
    if (cleaned === "." || cleaned === "./" || cleaned === "/" || cleaned === "/workspace") {
      return false;
    }
    return /[/\\]/.test(cleaned) || /\.[A-Za-z0-9]+$/.test(cleaned);
  });
}

function isFileLifecycleEvent(type) {
  return [
    "file.created",
    "file.deleted",
    "file.edited",
    "file.renamed",
    "file.moved",
    "file.watcher.updated",
    "workspace.changed",
  ].includes(type);
}

async function updateWorkspaceState(mutator) {
  const lock = STATE_PATH + ".lock";
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      handle = await open(lock, "wx", 0o600);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 10000) await rm(lock, { force: true });
      } catch (inner) {
        if (inner.code !== "ENOENT") throw inner;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("Apex usage state lock timed out");
  const temporary = STATE_PATH + "." + process.pid + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    let state;
    try {
      state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error("Invalid Apex state JSON; refusing to erase it");
      state = {};
    }
    state.workspaces ??= {};
    const workspace = state.workspaces[ROOT_HASH] ?? { root: ROOT };
    workspace.root = ROOT;
    mutator(workspace);
    workspace.updatedAt = new Date().toISOString();
    state.workspaces[ROOT_HASH] = workspace;
    state.memoryStale = Object.values(state.workspaces).some(entry => entry.memoryStale === true);
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, STATE_PATH);
  } catch (err) {
    // Telemetry failure must not sabotage an ordinary OpenCode tool invocation.
    console.error("Apex guard telemetry unavailable: " + err.message);
  } finally {
    await rm(temporary, { force: true });
    await handle.close();
    await rm(lock, { force: true });
  }
}

function hashRoot(root) {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 20);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

async function log(client, level, message) {
  try {
    await client?.app?.log?.({
      body: {
        service: "apex-context-guard",
        level,
        message,
      },
    });
  } catch {
    // Logging is best-effort; the guard behavior should not depend on it.
  }
}
