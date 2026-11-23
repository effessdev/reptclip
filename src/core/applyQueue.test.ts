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

test("withLock keeps a queued successor alive when the running task fails", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];

  // The successor is queued while the first task still runs, so it is already
  // waiting when that task rejects — the case that used to strand the queue.
  const failing = withLock("root", async () => {
    order.push("first:start");
    await gate;
    throw new Error("boom");
  });
  const successor = withLock("root", async () => {
    order.push("second:start");
    return "next";
  });

  await settle();
  assert.deepEqual(order, ["first:start"]);

  release();
  await assert.rejects(() => failing, /boom/);
  assert.equal(await successor, "next");
  assert.deepEqual(order, ["first:start", "second:start"]);

  // A call made after the rejection still runs too.
  assert.equal(await withLock("root", async () => "later"), "later");
});

test("withLock keys on the directory identity, not the spelling", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-lockkey-"));
  const holder = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-locklink-"));
  const link = path.join(holder, "alias");
  try {
    // A junction needs no elevation on Windows; a directory symlink does the
    // same on POSIX. Case folding alone would not hide a broken key here: the
    // two spellings differ in more than case.
    await fs.symlink(dir, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this environment cannot create a directory link");
    return;
  }
  t.after(async () => {
    await fs.rmdir(link).catch(() => undefined);
    await fs.rm(holder, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const order: string[] = [];
  await Promise.all([
    withLock(dir, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first:end");
    }),
    withLock(link, async () => {
      order.push("second:start");
      order.push("second:end");
    }),
  ]);

  // One directory, so one queue: the second task waits for the first.
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("withLock merges case spellings only when they are one directory", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-lockcase-"));
  const other = dir.toUpperCase();
  const sameDirectory = await fs
    .realpath(other)
    .then((resolved) => resolved === dir, () => false);
  if (!sameDirectory) {
    // A case-sensitive volume keeps `other` apart, so a separate queue is the
    // correct answer and there is nothing to fold here.
    t.skip("this filesystem treats the two spellings as different paths");
    return;
  }

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

  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
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
