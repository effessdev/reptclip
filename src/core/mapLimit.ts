/**
 * Runs `worker` over `items` with at most `limit` in flight and keeps the result
 * order, so callers see the same output as a sequential loop.
 *
 * The "Context" click reads every file twice — once for the project-structure
 * line count and once for the embedded content — and per-file I/O dominates:
 * 0.56 ms per open on Windows, so 2 000 files take 2.9 s sequentially and 0.6 s
 * with 32 in flight. The limit keeps memory bounded, since a file can be 1 MB.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }
  const lanes = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}
