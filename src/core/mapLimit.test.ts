import test from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "./mapLimit";

test("mapLimit keeps the order of the input", async () => {
  const items = [3, 1, 2, 5, 4];
  const results = await mapLimit(items, 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value));
    return value * 10;
  });
  assert.deepEqual(results, [30, 10, 20, 50, 40]);
});

test("mapLimit runs at most `limit` workers at a time", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);

  await mapLimit(items, 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return null;
  });

  assert.equal(peak, 4, `peak concurrency was ${peak}`);
});

test("mapLimit passes the index and handles an empty list", async () => {
  const seen: number[] = [];
  const results = await mapLimit(["a", "b"], 8, async (_item, index) => {
    seen.push(index);
    return index;
  });
  assert.deepEqual(seen.sort(), [0, 1]);
  assert.deepEqual(results, [0, 1]);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test("mapLimit stops on the first error", async () => {
  let started = 0;
  await assert.rejects(
    () =>
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
        started += 1;
        if (value === 3) {
          throw new Error("boom");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
        return value;
      }),
    /boom/,
  );
  assert.ok(started >= 3, `only ${started} workers started`);
});
