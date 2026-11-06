import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { authorizeFile, assertSafeRegex, isSensitivePath, MAX_FILE_BYTES, boundedOutput, redactSource } from "./safety.js";
import { buildWorkspaceIndex, findSymbol, searchCode } from "./indexer.js";
import { extractComponentContext } from "./ast.js";

test("source policy rejects path traversal, symlinks and sensitive files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-boundary-"));
  const root = path.join(temp, "project");
  const outside = path.join(temp, "outside.ts");
  await mkdir(root);
  await writeFile(outside, "export const outside = true");
  await writeFile(path.join(root, "normal.ts"), "export function inside() { return true; }");
  await symlink(outside, path.join(root, "linked.ts"));
  try {
    assert.ok(isSensitivePath(".env.local"));
    assert.ok(isSensitivePath("apps/web/private/token.ts"));
    assert.ok(isSensitivePath("config/credentials.json"));
    assert.equal(isSensitivePath("src/components/Button.tsx"), false);
    assert.throws(() => authorizeFile(root, outside), /outside/);
    assert.throws(() => authorizeFile(root, "../outside.ts"), /outside/);
    assert.throws(() => authorizeFile(root, path.join(root, "linked.ts")), /outside/);
    assert.equal(authorizeFile(root, "normal.ts"), path.join(root, "normal.ts"));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("synthetic key and bearer token are redacted in cache and AST", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-redact-"));
  const root = path.join(temp, "workspace");
  const previous = process.env.APEX_CONTEXT_ROOT;
  const previousConfig = process.env.OPENCODE_CONFIG_DIR;
  await mkdir(path.join(root, "src"), { recursive: true });
  process.env.APEX_CONTEXT_ROOT = root;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
  const marker = "SYNTHETIC_SECRET_MATERIAL_ONLY_FOR_TESTS";
  const key = "-----BEGIN PRIVATE KEY-----\n" + marker + "\n-----END PRIVATE KEY-----";
  const tick = String.fromCharCode(96);
  const source = "export const canary = " + tick + key + tick + ";\n"
    + 'export const token = "Bearer TOKENVALUEEXAMPLE1234567890123";\n'
    + 'export const ordinaryIdentifier = "IdentifierOfAValidMeaningfulLength2026";\n';
  await writeFile(path.join(root, "src/canary.ts"), source);
  await writeFile(path.join(root, ".env.production"), "TOKEN=NOT_A_REAL_SECRET_123456789");
  try {
    const index = await buildWorkspaceIndex({ root, force: true });
    const saved = await readFile(index.indexPath, "utf8");
    assert.doesNotMatch(saved, new RegExp(marker));
    assert.doesNotMatch(saved, /TOKENVALUEEXAMPLE1234567890123/);
    assert.doesNotMatch(saved, /NOT_A_REAL_SECRET_123456789/);
    assert.ok(index.diagnostics.secretRedactions.length >= 2);
    const found = await searchCode("SYNTHETIC_SECRET_MATERIAL", { root });
    assert.equal(found.matchCount, 0);
    const ast = await extractComponentContext(path.join(root, "src/canary.ts"), "canary");
    assert.doesNotMatch(ast, new RegExp(marker));
    assert.match(ast, /REDACTED_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.APEX_CONTEXT_ROOT;
    else process.env.APEX_CONTEXT_ROOT = previous;
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfig;
    await rm(temp, { recursive: true, force: true });
  }
});

test("hostile regex input is rejected and oversized files are diagnosed", async () => {
  assert.throws(() => assertSafeRegex("(a+)+$"), /Unsafe/);
  assert.throws(() => assertSafeRegex("a".repeat(300)), /256/);
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-budget-"));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
  await mkdir(path.join(temp, "src"));
  await writeFile(path.join(temp, "src/huge.ts"), "X".repeat(MAX_FILE_BYTES + 1));
  await writeFile(path.join(temp, "src/small.ts"), "export const safeSmall = 1;");
  try {
    const index = await buildWorkspaceIndex({ root: temp, force: true });
    assert.equal(index.files.some(item => item.path.endsWith("huge.ts")), false);
    assert.ok(index.diagnostics.largeFilesIgnored.some(item => item.path.endsWith("huge.ts")));
    assert.equal((await findSymbol("safeSmall", { root: temp, exact: true })).matchCount, 1);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
    await rm(temp, { recursive: true, force: true });
  }
});


test("Basic Authorization headers and credentials in connection URLs are redacted at all boundaries", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-url-secret-"));
  const root = path.join(temp, "workspace");
  const priorRoot = process.env.APEX_CONTEXT_ROOT;
  const priorConfig = process.env.OPENCODE_CONFIG_DIR;
  const encodedBasic = "dXNlcjpwYXNzd29yZC1tb3Jl";
  const dbPassword = "SYNTHETIC_URL_PASSWORD_12345";
  const code = 'export const testBasic = "Authorization: Basic ' + encodedBasic + '";\n' +
    'export const testConnection = "postgresql://reader:' + dbPassword + '@db.example.test:5432/app";\n';
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    process.env.APEX_CONTEXT_ROOT = root;
    process.env.OPENCODE_CONFIG_DIR = path.join(temp, "config");
    await writeFile(path.join(root, "src/connection.ts"), code);

    const redacted = redactSource(code);
    assert.ok(redacted.redactions.some(hit => hit.pattern === "basic-authorization"));
    assert.ok(redacted.redactions.some(hit => hit.pattern === "url-credential"));
    assert.doesNotMatch(redacted.text, new RegExp(encodedBasic));
    assert.doesNotMatch(redacted.text, new RegExp(dbPassword));
    assert.doesNotMatch(boundedOutput(code), new RegExp(dbPassword));

    const index = await buildWorkspaceIndex({ root, force: true });
    const persisted = await readFile(index.indexPath, "utf8");
    for (const secret of [encodedBasic, dbPassword]) {
      assert.equal(persisted.includes(secret), false, "No raw credential in persisted index");
    }
    assert.ok(index.diagnostics.secretRedactions.some(hit => hit.pattern === "basic-authorization"));
    assert.ok(index.diagnostics.secretRedactions.some(hit => hit.pattern === "url-credential"));
    assert.equal((await searchCode(dbPassword, { root })).matchCount, 0);

    const ast = await extractComponentContext(path.join(root, "src/connection.ts"), "testConnection");
    assert.doesNotMatch(ast, new RegExp(dbPassword));
    assert.match(ast, /REDACTED_SECRET/);
  } finally {
    if (priorRoot === undefined) delete process.env.APEX_CONTEXT_ROOT;
    else process.env.APEX_CONTEXT_ROOT = priorRoot;
    if (priorConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = priorConfig;
    await rm(temp, { recursive: true, force: true });
  }
});
