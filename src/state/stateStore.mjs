import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

/**
 * Load persisted state from disk.
 * Returns a default empty state if the file does not exist yet.
 */
export async function loadState(stateFile) {
  try {
    const raw = await readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return { seenIds: {}, lastRun: null };
  }
}

/**
 * Save state to disk atomically (write to tmp then rename).
 */
export async function saveState(stateFile, state) {
  const dir = path.dirname(stateFile);
  await mkdir(dir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  // rename is atomic on POSIX
  const { rename } = await import("fs/promises");
  await rename(tmp, stateFile);
}
