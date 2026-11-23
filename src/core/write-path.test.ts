import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";

/**
 * Regression tests for the P0 audit findings (C1, C2, C4, M3, M4a, M4b and the
 * `.gitignore` negation divergence).
 *
 * The `vscode` module is faked the same way `core-behavior.test.ts` does it so
 * the real `diffApplier` code runs against real files in temp directories.
 */

const originalLoad = (Module as any)._load;
const fakeVscode = {
  Uri: { file: (absPath: string) => ({ fsPath: absPath, path: absPath }) },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };

    constructor(
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
    ) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  WorkspaceEdit: class {
    operations: any[] = [];

    deleteFile(uri: { fsPath: string }) {
      this.operations.push(["deleteFile", uri]);
    }

    createFile(uri: { fsPath: string }) {
      this.operations.push(["createFile", uri]);
    }

    insert(uri: { fsPath: string }, position: unknown, text: string) {
      this.operations.push(["insert", uri, position, text]);
    }

    replace(uri: { fsPath: string }, range: unknown, text: string) {
      this.operations.push(["replace", uri, text]);
    }
  },
  workspace: {
    async applyEdit(edit: { operations: any[] }) {
      for (const operation of edit.operations) {
        const [kind, uri] = operation;
        const filePath = uri.fsPath;

        if (kind === "createFile") {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, "", "utf8");
          continue;
        }

        if (kind === "deleteFile") {
          await fs.rm(filePath, { force: true });
          continue;
        }

        if (kind === "insert") {
          const existing = await fs.readFile(filePath, "utf8").catch(() => "");
          await fs.writeFile(filePath, existing + operation[3], "utf8");
          continue;
        }

        if (kind === "replace") {
          await fs.writeFile(filePath, operation[2], "utf8");
        }
      }
      return true;
    },
    async openTextDocument(uri: { fsPath: string }) {
      const content = await fs.readFile(uri.fsPath, "utf8").catch(() => "");
      return {
        uri,
        lineCount: content.split(/\r?\n/).length,
        save: async () => undefined,
      };
    },
  },
  window: {
    async showTextDocument() {
      return undefined;
    },
  },
};

(Module as any)._load = function (
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request === "vscode") {
    return fakeVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

test.after(() => {
  (Module as any)._load = originalLoad;
});

const { applyDiffs, applySnapshot, findBufferOverride } =
  require("./diffApplier") as typeof import("./diffApplier");
const { collectNonIgnoredFiles, createEmbeddingGuard } =
  require("./gitignoreScanner") as typeof import("./gitignoreScanner");
const { readFileSafe } = require("./fileGuards") as typeof import("./fileGuards");

async function makeRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(
  root: string,
  relPath: string,
  content: string,
): Promise<string> {
  const absPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf8");
  return absPath;
}

async function exists(absPath: string): Promise<boolean> {
  return fs
    .access(absPath)
    .then(() => true)
    .catch(() => false);
}

function block(file: string, search: string, replace: string): string {
  return [
    file,
    "<<<<<<< SEARCH",
    search,
    "=======",
    replace,
    ">>>>>>> REPLACE",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// E1 [C1] - a link inside the workspace must not become a write outside it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E13 - .gitignore reached through an alias is still a .gitignore edit.
// ---------------------------------------------------------------------------

test("E13 refuses editing .gitignore through a hard link without confirmation", async (t) => {
  const root = await makeRoot("reptclip-e13-hard-");
  const gitignore = await writeFile(root, ".gitignore", ".env\n");
  const alias = path.join(root, "ignore-mirror");
  try {
    await fs.link(gitignore, alias);
  } catch {
    t.skip("hard links are not supported in this environment");
    return;
  }

  await assert.rejects(
    () => applyDiffs(root, block("ignore-mirror", ".env", "# gone")),
    /hard link/i,
  );
  assert.equal(await fs.readFile(gitignore, "utf8"), ".env\n");
});


test("E20 refuses an edit through a hard link to .git/config", async (t) => {
  const root = await makeRoot("reptclip-e20-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  const config = path.join(root, ".git", "config");
  const before = await fs.readFile(config, "utf8");
  try {
    await fs.link(config, path.join(root, "notese.txt"));
  } catch {
    t.skip("hard links are not supported in this environment");
    return;
  }

  await assert.rejects(
    () =>
      applyDiffs(
        root,
        block("notese.txt", "[core]", "[core]\n\thooksPath = .evil"),
      ),
    /hard link/i,
  );
  assert.equal(await fs.readFile(config, "utf8"), before);
});


test("E21 refuses an edit through a hard link to a gitignored file", async (t) => {
  const root = await makeRoot("reptclip-e21-");
  await writeFile(root, ".gitignore", ".env\n");
  await writeFile(root, ".env", "TOKEN=1\n");
  try {
    await fs.link(path.join(root, ".env"), path.join(root, "innocent.txt"));
  } catch {
    t.skip("hard links are not supported in this environment");
    return;
  }

  await assert.rejects(
    () => applyDiffs(root, block("innocent.txt", "TOKEN=1", "TOKEN=PWNED")),
    /hard link/i,
  );
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "TOKEN=1\n");
});


test("E31 refuses a write when a directory becomes a link while the diff is pending", async (t) => {
  const root = await makeRoot("reptclip-e31-");
  const outside = await makeRoot("reptclip-e31-out-");
  await fs.mkdir(path.join(root, "sub"));

  let swapped = false;
  await assert.rejects(
    () =>
      applyDiffs(root, block("sub/new.txt", "", "escaped"), {
        // Stand-in for another process swapping the directory between the
        // path check and the workspace edit.
        assertBuffersCurrent: () => {
          if (swapped) {
            return;
          }
          swapped = true;
          const fsSync = require("node:fs");
          fsSync.rmSync(path.join(root, "sub"), {
            recursive: true,
            force: true,
          });
          fsSync.symlinkSync(outside, path.join(root, "sub"), "junction");
        },
      }),
    /outside|escape|resolves/i,
  );
  assert.equal(swapped, true, "the swap must have run");
  assert.equal(await exists(path.join(outside, "new.txt")), false);
});


test("E26 refuses undo when the file became a hard link after the apply", async (t) => {
  const root = await makeRoot("reptclip-e26-");
  const file = await writeFile(root, "notes.txt", "v1\n");
  const applied = await applyDiffs(root, block("notes.txt", "v1", "v2"));
  assert.equal(await fs.readFile(file, "utf8"), "v2\n");

  const secret = await writeFile(root, "secrets.env", "TOKEN=secret\n");
  await fs.rm(file);
  try {
    await fs.link(secret, file);
  } catch {
    t.skip("hard links are not supported in this environment");
    return;
  }

  await assert.rejects(
    () =>
      applySnapshot(root, applied.checkpoint.files, "undo", {
        confirmConflict: async () => true,
      }),
    /hard link/i,
  );
  assert.equal(await fs.readFile(secret, "utf8"), "TOKEN=secret\n");
});


test("E27 refuses undo after a hard link appears while the diff is pending", async (t) => {
  const root = await makeRoot("reptclip-e27-");
  const file = await writeFile(root, "notes.txt", "v1\n");
  const secret = await writeFile(root, "secrets.env", "TOKEN=secret\n");

  let linked = false;
  await assert.rejects(
    () =>
      applyDiffs(root, block("notes.txt", "v1", "v2"), {
        // Stand-in for a concurrent process (dedup tool, backup, attacker) that
        // replaces the path after planning but before the write.
        assertBuffersCurrent: () => {
          if (linked) {
            return;
          }
          linked = true;
          const fsSync = require("node:fs");
          fsSync.rmSync(file);
          fsSync.linkSync(secret, file);
        },
      }),
    /hard link/i,
  );
  assert.equal(linked, true, "the hook must have run");
  assert.equal(await fs.readFile(secret, "utf8"), "TOKEN=secret\n");
});


test("E25 applies the size limit to diffs but not to undo", async () => {
  const root = await makeRoot("reptclip-e25-");
  const file = await writeFile(root, "notes.txt", "v1\n");
  const applied = await applyDiffs(root, block("notes.txt", "v1", "v2"));
  assert.equal(await fs.readFile(file, "utf8"), "v2\n");

  // The file outgrows the edit limit after the checkpoint was recorded.
  await fs.writeFile(file, "v2\n" + "a".repeat(8 * 1024 * 1024), "utf8");
  await assert.rejects(
    () => applyDiffs(root, block("notes.txt", "v2", "v3")),
    /8 MB|limit/i,
  );

  await applySnapshot(root, applied.checkpoint.files, "undo", {
    confirmConflict: async () => true,
  });
  assert.equal(await fs.readFile(file, "utf8"), "v1\n");
});

// ---------------------------------------------------------------------------
// E16 - a case-only rename is a real operation on a case-insensitive volume,
// and the error must say so instead of claiming the paths are identical.
// ---------------------------------------------------------------------------

test("E16 reports a case-only rename instead of calling it the same path", async () => {
  const root = await makeRoot("reptclip-e16-");
  await writeFile(root, "foo.ts", "export const a = 1;\n");
  const caseInsensitive = await fs
    .stat(path.join(root, "FOO.TS"))
    .then(() => true)
    .catch(() => false);

  if (caseInsensitive) {
    await assert.rejects(
      () => applyDiffs(root, "foo.ts -> Foo.ts"),
      /case/i,
    );
    assert.equal(
      await fs.readFile(path.join(root, "foo.ts"), "utf8"),
      "export const a = 1;\n",
    );
    assert.deepEqual(await fs.readdir(root), ["foo.ts"]);
    return;
  }

  const result = await applyDiffs(root, "foo.ts -> Foo.ts");
  assert.equal(result.created, 1);
  assert.deepEqual(await fs.readdir(root), ["Foo.ts"]);
});

// ---------------------------------------------------------------------------
// E18 - an unreadable target is not an absent one.
// ---------------------------------------------------------------------------

test("E18 refuses a diff whose target is a directory", async () => {
  const root = await makeRoot("reptclip-e18-");
  await fs.mkdir(path.join(root, "docs"));

  // Assert the guard's own message, not just "some EISDIR": a fake workspace
  // edit would throw EISDIR too, which would make this test pass with the
  // guard removed.
  await assert.rejects(
    () => applyDiffs(root, block("docs", "", "x")),
    /it is a directory, not a file/i,
  );
  assert.equal((await fs.stat(path.join(root, "docs"))).isDirectory(), true);
});
