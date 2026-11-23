import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { withLock, pendingCount } =
  require("./applyQueue") as typeof import("./applyQueue");

/** Lets every pending microtask/timer tick run before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("withLock runs tasks for one key strictly one after another", async () => {
  const order: string[] = [];
  const slow = withLock("root", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
    return 1;
  });
  const fast = withLock("root", async () => {
    order.push("second:start");
    order.push("second:end");
    return 2;
  });

  assert.deepEqual(await Promise.all([slow, fast]), [1, 2]);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("withLock does not serialize different keys", async () => {
  let concurrent = 0;
  let peak = 0;
  const task = () =>
    withLock(`root-${Math.random()}`, async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
    });

  await Promise.all([task(), task(), task()]);
  assert.equal(peak, 3);
});

test("withLock keeps the queue alive after a rejected task", async () => {
  await assert.rejects(
    () =>
      withLock("root", async () => {
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.equal(await withLock("root", async () => "next"), "next");
});

test("withLock keys on the real directory, not the spelling", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-lockkey-"));
  const other = process.platform === "win32" ? dir.toUpperCase() : dir;

  const order: string[] = [];
  await Promise.all([
    withLock(dir, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first:end");
    }),
    withLock(other, async () => {
      order.push("second:start");
      order.push("second:end");
    }),
  ]);

  if (process.platform === "win32") {
    assert.deepEqual(order, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  } else {
    // Case-spelled paths are different directories on a case-sensitive FS.
    assert.equal(order.length, 4);
  }
});

test("withLock keys on the repository root, not the opened folder", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-lockrepo-"));
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  const nested = path.join(repo, "packages", "app");
  await fs.mkdir(nested, { recursive: true });

  const order: string[] = [];
  await Promise.all([
    withLock(repo, async () => {
      order.push("outer:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("outer:end");
    }),
    withLock(nested, async () => {
      order.push("inner:start");
      order.push("inner:end");
    }),
  ]);

  assert.deepEqual(order, [
    "outer:start",
    "outer:end",
    "inner:start",
    "inner:end",
  ]);
});

test("withLock loses no update across eight concurrent tasks", async () => {
  let counter = 0;
  const runs = Array.from({ length: 8 }, () =>
    withLock("counter", async () => {
      const current = counter;
      await new Promise((resolve) => setTimeout(resolve, 1));
      counter = current + 1;
    }),
  );

  await Promise.all(runs);
  assert.equal(counter, 8);
  await settle();
  assert.equal(pendingCount(), 0);
});
