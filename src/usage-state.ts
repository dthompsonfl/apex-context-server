import crypto from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Atomically updates cross-process OpenCode usage state with an exclusive short-lived lock. */
export async function updateUsageState<T extends object>(
  file: string,
  modify: (state: T) => void,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + ".lock";
  let acquired: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      acquired = await open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 10000) await rm(lock, { force: true });
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
      }
      await wait(25);
    }
  }
  if (!acquired) throw new Error("Timed out acquiring Apex usage-state lock");
  const temp = file + "." + process.pid + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    let state: T;
    try {
      state = JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Apex usage-state JSON is invalid; refusing to discard concurrent state");
      }
      state = {} as T;
    }
    modify(state);
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
    await acquired.close();
    await rm(lock, { force: true });
  }
}
