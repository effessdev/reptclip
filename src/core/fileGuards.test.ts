import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Content guards: a file the context builder cannot represent as UTF-8 text
 * must be skipped with a reason, not pasted as mojibake or truncated at the
 * first NUL sniff window.
 */

const { readFileSafe } = require("./fileGuards") as typeof import("./fileGuards");

async function makeRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// E17 - content that cannot be represented as text must not reach the prompt.
// ---------------------------------------------------------------------------

test("E17 skips text that is not valid UTF-8 instead of embedding mojibake", async () => {
  const root = await makeRoot("reptclip-e17-utf8-");
  // "Привет" encoded as Windows-1251.
  await fs.writeFile(
    path.join(root, "ru.txt"),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
  );

  const result = await readFileSafe(path.join(root, "ru.txt"));
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? "", /UTF-8/i);
});


test("E17 detects a NUL byte past the first 8000 bytes", async () => {
  const root = await makeRoot("reptclip-e17-nul-");
  await fs.writeFile(
    path.join(root, "late.bin"),
    Buffer.from("a".repeat(9000) + "\0" + "b"),
  );

  const result = await readFileSafe(path.join(root, "late.bin"));
  assert.equal(result.skipped, true);
});
