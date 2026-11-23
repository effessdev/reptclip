import { existsSync, realpathSync, statSync } from "fs";
import * as path from "path";

/**
 * Per-key serialization for workspace mutations. VS Code delivers webview
 * messages as independent async handlers, so two "Apply Diffs" clicks (or an
 * apply racing an undo) can interleave at every `await`: both read the same
 * "before" content, the later write wins, and the losing edit is reported as
 * applied. Tasks for one project root run one at a time; different roots stay
 * independent.
 */

/** Tail of each key's chain: settled (never rejected) so a failure cannot poison the queue. */
const tails = new Map<string, Promise<unknown>>();

/**
 * One key per real directory. A project can be opened through two spellings
 * (a junction, a differently-cased path, a symlinked parent) and those are the
 * same files on disk, so locking on the spelled path would not serialize them.
 */
export function canonicalRootDir(key: string): string {
  let resolved = key;
  try {
    resolved = realpathSync.native(key);
  } catch {
    // A path that cannot be resolved keeps its spelling; it will fail later
    // with a clearer error from the operation itself.
  }
  const normalized = path.normalize(resolved);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * The lock unit is the repository, not the opened folder: a multi-root
 * workspace can open `repo` and `repo/packages/app` at the same time, and a
 * file they share must still be written by one operation at a time.
 */
function lockKeyFor(rootDir: string): string {
  const start = canonicalRootDir(rootDir);
  try {
    if (!statSync(start).isDirectory()) {
      return start;
    }
  } catch {
    return start;
  }
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}

/**
 * Runs `task` after every previously queued task for `key` has settled.
 * The returned promise carries `task`'s own result or rejection; the chain
 * itself is always settled, so one failure does not stop later tasks.
 */
export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const queueKey = lockKeyFor(key);
  const previous = tails.get(queueKey) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(queueKey, settled);
  void settled.then(() => {
    // Drop the key once nothing else is queued behind it, so the map does not
    // grow with every project ever opened.
    if (tails.get(queueKey) === settled) {
      tails.delete(queueKey);
    }
  });
  return result;
}

/** Number of keys with a live chain. Exposed for tests and diagnostics. */
export function pendingCount(): number {
  return tails.size;
}
