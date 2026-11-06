import crypto from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const JOURNAL = ".apex-context-transaction";

export async function exists(target) {
  try { await lstat(target); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function managedHash(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error("Refusing symlink-managed path: " + target);
  const digest = crypto.createHash("sha256");
  if (info.isFile()) digest.update(await readFile(target));
  else if (info.isDirectory()) {
    for (const name of (await readdir(target)).sort()) {
      digest.update(name + "\0");
      digest.update(await managedHash(path.join(target, name)));
    }
  } else throw new Error("Unsupported managed file type at " + target);
  return digest.digest("hex");
}

async function makePrivateFile(target, content) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600, flag: "wx" });
}

export function journalPath(directory) { return path.join(directory, JOURNAL); }

function assertAllowed(target, paths) {
  if (!paths.has(target)) throw new Error("Transaction journal references an unauthorized destination");
}

async function currentHash(target) {
  return await exists(target) ? managedHash(target) : null;
}

/**
 * Safe replayable rollback after SIGKILL, a process crash or an interrupted rename.
 * Does not overwrite divergent user changes: unknown target hashes are reported first.
 */
export async function recoverTransaction(directory, allowedPaths) {
  const journal = journalPath(directory);
  if (!await exists(journal)) return false;
  const record = path.join(journal, "plan.json");
  if (!await exists(record)) {
    // A transaction cannot modify destinations before the plan is fully written.
    await rm(journal, { recursive: true, force: true });
    return true;
  }
  const { entries } = JSON.parse(await readFile(record, "utf8"));
  const allowed = new Set(allowedPaths.map(item => path.resolve(item)));
  if (!Array.isArray(entries)) throw new Error("Invalid transaction journal");
  for (const item of entries) {
    assertAllowed(item.target, allowed);
    const hash = await currentHash(item.target);
    if (hash !== null && hash !== item.before && hash !== item.after) {
      throw new Error("Recovery conflict: user-modified target " + item.target);
    }
    const backup = path.join(journal, "backup", String(item.id));
    if (item.before !== null && (!await exists(backup) || await managedHash(backup) !== item.before)) {
      throw new Error("Recovery failed: original backup missing or modified for " + item.target);
    }
  }
  for (const item of [...entries].reverse()) {
    const actual = await currentHash(item.target);
    if (actual === item.before) continue;
    const displaced = path.join(journal, "displaced-" + String(item.id));
    if (actual !== null) {
      await rm(displaced, { recursive: true, force: true });
      await rename(item.target, displaced);
    }
    if (item.before !== null) {
      const restoring = path.join(path.dirname(item.target), ".apex-restore-" + crypto.randomBytes(8).toString("hex"));
      try {
        await cp(path.join(journal, "backup", String(item.id)), restoring, { recursive: true, dereference: false });
        await rename(restoring, item.target);
      } finally { await rm(restoring, { recursive: true, force: true }); }
    }
  }
  await rm(journal, { recursive: true, force: true });
  return true;
}

/**
 * Stages and backs up everything before changing one managed destination.
 * Each replacement is a rename; an interrupted transaction is explicitly recoverable.
 */
export async function applyTransaction(directory, changes, allowedPaths) {
  const journal = journalPath(directory);
  if (await exists(journal)) {
    throw new Error("Pending interrupted Apex transaction. Run the command with --recover first.");
  }
  const allowed = new Set(allowedPaths.map(item => path.resolve(item)));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const entries = [];
  let planCommitted = false;
  try {
    await mkdir(path.join(journal, "backup"));
    await mkdir(path.join(journal, "stage"));
    for (const [id, change] of changes.entries()) {
      const target = path.resolve(change.target);
      assertAllowed(target, allowed);
      const before = await currentHash(target);
      const backup = path.join(journal, "backup", String(id));
      if (before !== null) await cp(target, backup, { recursive: true, dereference: false });
      const staged = path.join(journal, "stage", String(id));
      if (change.kind === "file") await makePrivateFile(staged, change.content);
      else if (change.kind === "derivedFile") await makePrivateFile(staged, change.prepare(entries));
      else if (change.kind === "directory") await cp(change.source, staged, { recursive: true, dereference: true });
      else if (change.kind === "runtime") {
        await mkdir(staged, { mode: 0o700 });
        for (const name of ["dist", "node_modules", "package.json"]) {
          await cp(path.join(change.source, name), path.join(staged, name), { recursive: true, dereference: true });
        }
      }
      else if (change.kind !== "delete") throw new Error("Invalid Apex transaction operation");
      const after = change.kind === "delete" ? null : await managedHash(staged);
      entries.push({ id, target, before, after });
    }
    // No user-owned destination is changed until a complete recovery plan exists.
    await makePrivateFile(path.join(journal, "plan.json"), JSON.stringify({ version: 1, entries }) + "\n");
    planCommitted = true;
    for (const item of entries) {
      if (await currentHash(item.target) !== item.before)
        throw new Error("Managed file changed while preparing transaction: " + item.target);
      await mkdir(path.dirname(item.target), { recursive: true, mode: 0o700 });
      if (item.before !== null) {
        await rename(item.target, path.join(journal, "moved-" + String(item.id)));
      }
      if (item.after !== null) await rename(path.join(journal, "stage", String(item.id)), item.target);
      // Fault injection is disabled unless explicitly running a test.
      if (process.env.NODE_ENV === "test" && process.env.APEX_OPENCODE_TEST_FAULT_AFTER === String(item.id)) {
        if (process.env.APEX_OPENCODE_TEST_FAULT_MODE === "kill") process.kill(process.pid, "SIGKILL");
        throw new Error("Injected transactional installation failure");
      }
    }
    await rm(journal, { recursive: true, force: true });
  } catch (error) {
    if (planCommitted) {
      try { await recoverTransaction(directory, allowedPaths); }
      catch (recoveryError) {
        throw new AggregateError([error, recoveryError],
          "Apex transaction failed and could not automatically recover; run --recover");
      }
    } else {
      await rm(journal, { recursive: true, force: true });
    }
    throw error;
  }
}
