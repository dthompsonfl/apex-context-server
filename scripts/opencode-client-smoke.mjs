#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockToolModel } from "./mock-tool-model.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = process.argv.indexOf("--client");
const client = index < 0 ? "v1" : process.argv[index + 1];
if (!["v1", "v2"].includes(client)) throw new Error("Select --client v1 or --client v2");
const cli = process.env.OPENCODE_BIN;
if (!cli) throw new Error("OPENCODE_BIN must identify an installed, version-pinned OpenCode CLI");
await access(cli);
const temp = await mkdtemp(path.join(os.tmpdir(), "apex-opencode-cli-"));
const project = path.join(temp, "workspace");
const home = path.join(temp, "home");
const global = path.join(temp, "global");
let model;
async function run(command, args, env, timeout = 90000) {
  try {
    return await exec(command, args, {
      cwd: project, env, timeout, maxBuffer: 5_000_000,
    });
  } catch (error) {
    const message = "OpenCode CLI smoke failed: " + path.basename(command) + " " + args.join(" ") + "\n"
      + String(error.stderr ?? "").slice(-1800) + "\n" + String(error.stdout ?? "").slice(-1800);
    throw new Error(message, { cause: error });
  }
}
try {
  await cp(path.join(repo, "examples/demo-workspace"), project, { recursive: true });
  await mkdir(home);
  await mkdir(global);
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(temp, "xdg-config"),
    XDG_DATA_HOME: path.join(temp, "xdg-data"), XDG_CACHE_HOME: path.join(temp, "xdg-cache"),
    OPENCODE_CONFIG_DIR: global, APEX_CONTEXT_PROJECT_DIR: project,
    APEX_CONTEXT_ROOT: project, OPENCODE_DISABLE_AUTOUPDATE: "true",
    CI: "true", NO_COLOR: "1", TERM: "dumb",
  };
  const version = (await run(cli, ["--version"], env)).stdout.trim();
  assert.match(version, client === "v1" ? /^1\./ : /^2\./, "CLI version must match selected adapter");
  await run(process.execPath, [path.join(repo, "scripts/setup-opencode.mjs"),
    "--scope", "project", "--client", client], env, 180000);
  const configPath = path.join(project, "opencode.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  model = await createMockToolModel();
  if (client === "v1") {
    config.provider = {
      fixture: {
        npm: "@ai-sdk/openai-compatible", name: "Apex deterministic test model",
        options: { baseURL: model.baseURL, apiKey: "not-real-apex-test-key" },
        models: { fixture: { name: "Synthetic", limit: { context: 32768, output: 4096 } } },
      },
    };
  } else {
    config.providers = {
      fixture: {
        name: "Apex deterministic test model",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: model.baseURL, apiKey: "not-real-apex-test-key" },
        models: {
          fixture: {
            name: "Synthetic", capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 32768, output: 4096 },
          },
        },
      },
    };
  }
  config.model = "fixture/fixture";
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const listed = await run(cli, ["mcp", "list"], env, 120000);
  const text = listed.stdout + "\n" + listed.stderr;
  assert.match(text, /apex-context/i, "OpenCode must discover Apex in the client config");
  assert.match(text, /connected/i, "OpenCode must establish an MCP connection");
  const running = await run(cli, ["run", "--model", "fixture/fixture", "--format", "json",
    "Use apex-context locate_code for Button, then read_context_bundle for its declaration. Do not use shell."],
    env, 150000);
  assert.ok(model.step >= 3, "OpenCode must execute both Apex tools and return results to the model stub");
  const output = running.stdout + "\n" + running.stderr;
  assert.match(output, /apex.context/i, "OpenCode session must contain Apex tool events");
  console.log("OPENCODE_CLIENT_SMOKE_PASS: " + version + " (" + client
    + "), connected and invoked locate_code plus read_context_bundle over the real OpenCode tool pipeline.");
} finally {
  if (model) await model.close();
  await rm(temp, { recursive: true, force: true });
}
