import crypto from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteOptions {
  /** Fault-injection seam: runs after durable temporary write, before replacement. */
  beforeReplace?: () => Promise<void> | void;
}

/** Never truncate the current snapshot; replace it only after the new file is synced. */
export async function atomicWritePrivateFile(
  target: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = target + "." + process.pid + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("Refusing to replace a non-regular or symlink cache destination");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeReplace?.();
    await rename(temporary, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

/** Remove only old Apex temp files, not active writers or unrelated files. */
export async function cleanStaleCacheTemps(indexFile: string, minimumAgeMs = 3_600_000): Promise<number> {
  const directory = path.dirname(indexFile);
  const basename = path.basename(indexFile);
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(basename + ".") ||
        !/^\d+\.[0-9a-f]{24}\.tmp$/.test(entry.slice(basename.length + 1))) continue;
    const candidate = path.join(directory, entry);
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink() || Date.now() - info.mtimeMs < minimumAgeMs) continue;
      await rm(candidate);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
