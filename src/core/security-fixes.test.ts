import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";

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

test("E1 refuses to write through a directory link that leaves the workspace", async (t) => {
  const root = await makeRoot("reptclip-e1-root-");
  const outside = await makeRoot("reptclip-e1-outside-");
  const linkPath = path.join(root, "linked");

  let linked = true;
  try {
    await fs.symlink(outside, linkPath, "junction");
  } catch {
    try {
      await fs.symlink(outside, linkPath);
    } catch {
      linked = false;
    }
  }
  if (!linked) {
    t.skip("cannot create a directory link in this environment");
    return;
  }

  await assert.rejects(
    () => applyDiffs(root, block("linked/pwned.txt", "", "owned")),
    /escapes the workspace/,
  );
  assert.equal(await exists(path.join(outside, "pwned.txt")), false);
});

test("E1 refuses to follow a file link that points outside the workspace", async (t) => {
  const root = await makeRoot("reptclip-e1f-root-");
  const outside = await makeRoot("reptclip-e1f-outside-");
  await writeFile(outside, "secret.txt", "OUTSIDE-SECRET\n");
  const linkPath = path.join(root, "secret.txt");

  try {
    await fs.symlink(path.join(outside, "secret.txt"), linkPath, "file");
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }

  await assert.rejects(
    () => applyDiffs(root, block("secret.txt", "OUTSIDE-SECRET", "PWNED")),
    /escapes the workspace/,
  );
  assert.equal(
    await fs.readFile(path.join(outside, "secret.txt"), "utf8"),
    "OUTSIDE-SECRET\n",
  );
});

// ---------------------------------------------------------------------------
// E2 [C2] - the write path must honour the same protected paths as the read path.
// ---------------------------------------------------------------------------

test("E2 refuses to write a gitignored .env and anything under .git", async () => {
  const root = await makeRoot("reptclip-e2-");
  await writeFile(root, ".gitignore", ".env\n");
  await writeFile(root, ".env", "TOKEN=1\n");
  await writeFile(root, ".git/hooks/pre-commit", "#!/bin/sh\n");

  const diff = [
    block(".env", "TOKEN=1", "TOKEN=2"),
    block(".git/hooks/pre-commit", "", "#!/bin/sh\necho pwned\n"),
  ].join("\n");

  await assert.rejects(() => applyDiffs(root, diff), /gitignore|\.git/i);
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "TOKEN=1\n");
  assert.equal(
    await fs.readFile(path.join(root, ".git/hooks/pre-commit"), "utf8"),
    "#!/bin/sh\n",
  );

  // The read-side guard already rejects both paths; that must not change.
  const guard = createEmbeddingGuard(root);
  assert.equal((await guard(".env")).ok, false);
  assert.equal((await guard(".git/hooks/pre-commit")).ok, false);
});

test("E2 allows writing .env when it is not gitignored", async () => {
  const root = await makeRoot("reptclip-e2y-");
  await writeFile(root, ".env", "TOKEN=1\n");
  const diff = block(".env", "TOKEN=1", "TOKEN=2");

  const result = await applyDiffs(root, diff);
  assert.equal(result.modified, 1);
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "TOKEN=2\n");
});

// ---------------------------------------------------------------------------
// E3 [C4] - undo must not silently destroy edits made after the apply.
// ---------------------------------------------------------------------------

test("E3 undo asks before overwriting a file edited after the apply", async () => {
  const root = await makeRoot("reptclip-e3-");
  const file = await writeFile(root, "a.txt", "v1\n");
  const result = await applyDiffs(root, block("a.txt", "v1", "v2"));
  await fs.writeFile(file, "USER-EDIT-AFTER-APPLY\n", "utf8");

  await assert.rejects(
    () =>
      applySnapshot(root, result.checkpoint.files, "undo", {
        confirmConflict: async () => false,
      }),
    /changed since|conflict/i,
  );
  assert.equal(await fs.readFile(file, "utf8"), "USER-EDIT-AFTER-APPLY\n");

  await applySnapshot(root, result.checkpoint.files, "undo", {
    confirmConflict: async () => true,
  });
  assert.equal(await fs.readFile(file, "utf8"), "v1\n");
});

test("E3 matches against the editor buffer, not the stale disk copy", async () => {
  const root = await makeRoot("reptclip-e3b-");
  const file = await writeFile(root, "a.ts", "const a = 1;\n");
  const buffer = "const a = 1;\n// unsaved\n";

  const result = await applyDiffs(
    root,
    block("a.ts", "// unsaved", "// saved"),
    { bufferOverrides: new Map([[file, buffer]]) },
  );

  assert.equal(result.modified, 1);
  assert.equal(await fs.readFile(file, "utf8"), "const a = 1;\n// saved\n");
});

// ---------------------------------------------------------------------------
// E4 [M3] - inserted lines must follow the target file's line ending.
// ---------------------------------------------------------------------------

test("E4 keeps a CRLF file pure CRLF when the replacement has new lines", async () => {
  const root = await makeRoot("reptclip-e4-");
  const file = await writeFile(root, "a.txt", "alpha\r\nbeta\r\ngamma\r\n");

  const summary = await applyDiffs(
    root,
    block("a.txt", "beta", "BETA\nnew line"),
  );

  const content = await fs.readFile(file, "utf8");
  assert.equal(summary.fuzzy, 0);
  assert.equal(content, "alpha\r\nBETA\r\nnew line\r\ngamma\r\n");
  assert.equal(/[^\r]\n/.test(content), false, "no lone LF may remain");
});

test("E4 leaves an LF file on LF", async () => {
  const root = await makeRoot("reptclip-e4lf-");
  const file = await writeFile(root, "a.txt", "alpha\nbeta\n");

  await applyDiffs(root, block("a.txt", "beta", "BETA\nnew line"));

  assert.equal(await fs.readFile(file, "utf8"), "alpha\nBETA\nnew line\n");
});

// ---------------------------------------------------------------------------
// E5 [M4a] - a hijacked path must produce an actionable error.
// ---------------------------------------------------------------------------

test("E5 names the suspicious path and the format rule when the path is prose", async () => {
  const root = await makeRoot("reptclip-e5-");
  await writeFile(root, "a.txt", "one\ntwo\n");

  const diff = [
    block("a.txt", "one", "ONE"),
    "",
    "Now the second change:",
    "<<<<<<< SEARCH",
    "two",
    "=======",
    "TWO",
    ">>>>>>> REPLACE",
  ].join("\n");

  await assert.rejects(
    () => applyDiffs(root, diff),
    (error: Error) =>
      /Now the second change:/.test(error.message) &&
      /immediately before/.test(error.message),
  );
  assert.equal(
    await fs.readFile(path.join(root, "a.txt"), "utf8"),
    "one\ntwo\n",
  );
});

// ---------------------------------------------------------------------------
// E6 [M4b] - a swallowed "=======" separator must not apply silently.
// ---------------------------------------------------------------------------

test("E6 asks before applying a REPLACE that contains a separator-like line", async () => {
  const root = await makeRoot("reptclip-e6-");
  const file = await writeFile(root, "doc.md", "title\n=======\nbody\n");

  const diff = [
    "doc.md",
    "<<<<<<< SEARCH",
    "title",
    "=======",
    "body",
    "=======",
    "h2",
    "body",
    ">>>>>>> REPLACE",
  ].join("\n");

  await assert.rejects(
    () =>
      applyDiffs(root, diff, {
        confirmSuspiciousReplace: async () => false,
      }),
    /cancel|declin|abort|separator/i,
  );
  assert.equal(await fs.readFile(file, "utf8"), "title\n=======\nbody\n");

  await applyDiffs(root, diff, {
    confirmSuspiciousReplace: async () => true,
  });
  assert.notEqual(await fs.readFile(file, "utf8"), "title\n=======\nbody\n");
});

// ---------------------------------------------------------------------------
// E7 - .gitignore must agree with git when a deeper file re-includes a path.
// ---------------------------------------------------------------------------

test("E7 honours a nested .gitignore negation that overrides a root pattern", async () => {
  const root = await makeRoot("reptclip-e7-");
  await writeFile(root, ".gitignore", "*.log\n");
  await writeFile(root, "nested/.gitignore", "!keep.log\n");
  await writeFile(root, "nested/keep.log", "kept\n");
  await writeFile(root, "nested/other.log", "skipped\n");

  const files = await collectNonIgnoredFiles(root);

  assert.ok(
    files.includes("nested/keep.log"),
    "git re-includes nested/keep.log",
  );
  assert.ok(!files.includes("nested/other.log"));
  assert.equal((await createEmbeddingGuard(root)("nested/keep.log")).ok, true);
});

test("E1 refuses a dangling link instead of walking past it", async (t) => {
  const root = await makeRoot("reptclip-e1d-");
  const outside = await makeRoot("reptclip-e1d-outside-");
  const linkPath = path.join(root, "report.txt");

  try {
    await fs.symlink(path.join(outside, "missing.txt"), linkPath, "file");
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }

  await assert.rejects(
    () => applyDiffs(root, block("report.txt", "", "owned")),
    /dangling link|escapes the workspace/,
  );
  assert.equal(await exists(path.join(outside, "missing.txt")), false);
});

test("E2 refuses .git reached through an in-workspace link", async (t) => {
  const root = await makeRoot("reptclip-e2l-");
  await writeFile(root, ".git/hooks/pre-commit", "#!/bin/sh\n");
  const linkPath = path.join(root, "gitlink");

  let linked = true;
  try {
    await fs.symlink(path.join(root, ".git"), linkPath, "junction");
  } catch {
    try {
      await fs.symlink(path.join(root, ".git"), linkPath);
    } catch {
      linked = false;
    }
  }
  if (!linked) {
    t.skip("cannot create a directory link in this environment");
    return;
  }

  await assert.rejects(
    () =>
      applyDiffs(
        root,
        block("gitlink/hooks/pre-commit", "#!/bin/sh", "#!/bin/sh\necho pwned"),
      ),
    /gitignore|\.git/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, ".git/hooks/pre-commit"), "utf8"),
    "#!/bin/sh\n",
  );
});

// NOTE: NTFS alternate-data-stream aliasing of .env (e.g. ".env::$DATA") is no
// longer specifically guarded now that .env has no special-cased protection;
// it is only refused if the literal path happens to match a .gitignore
// pattern. This is a known, accepted gap from moving to .gitignore-only
// enforcement (see conversation/design notes), not a regression to silently fix.

test("E6 detects a separator that is indented inside the REPLACE", async () => {
  const root = await makeRoot("reptclip-e6i-");
  const file = await writeFile(root, "doc.md", "A\n");

  const diff = [
    "doc.md",
    "<<<<<<< SEARCH",
    "A",
    "=======",
    "B",
    "   =======",
    "C",
    ">>>>>>> REPLACE",
  ].join("\n");

  await assert.rejects(
    () =>
      applyDiffs(root, diff, {
        confirmSuspiciousReplace: async () => false,
      }),
    /cancel|declin|abort|separator/i,
  );
  assert.equal(await fs.readFile(file, "utf8"), "A\n");
});

test("E7 guard rejects a re-include under an excluded directory", async () => {
  const root = await makeRoot("reptclip-e7b-");
  await writeFile(root, ".gitignore", "build/\n");
  await writeFile(root, "build/.gitignore", "!secret.txt\n");
  await writeFile(root, "build/secret.txt", "hidden\n");

  const files = await collectNonIgnoredFiles(root);
  assert.equal(files.includes("build/secret.txt"), false);
  assert.deepEqual(await createEmbeddingGuard(root)("build/secret.txt"), {
    ok: false,
    reason: "ignored by .gitignore",
  });
});

test("E3 undo uses the buffer when checking for later edits", async () => {
  const root = await makeRoot("reptclip-e3c-");
  const file = await writeFile(root, "a.txt", "v1\n");
  const result = await applyDiffs(root, block("a.txt", "v1", "v2"));
  const buffer = new Map([[file, "USER-EDIT-IN-BUFFER\n"]]);

  await assert.rejects(
    () =>
      applySnapshot(root, result.checkpoint.files, "undo", {
        bufferOverrides: buffer,
        confirmConflict: async () => false,
      }),
    /changed since|conflict/i,
  );
  assert.equal(await fs.readFile(file, "utf8"), "v2\n");

  await applySnapshot(root, result.checkpoint.files, "undo", {
    bufferOverrides: buffer,
    confirmConflict: async () => true,
  });
  assert.equal(await fs.readFile(file, "utf8"), "v1\n");
});

// ---------------------------------------------------------------------------
// Post-merge review: buffer identity, directory re-includes, TOCTOU.
// ---------------------------------------------------------------------------

test("P1 matches a buffer by file identity, not by host platform", async () => {
  const root = await makeRoot("reptclip-p1-");
  const file = await writeFile(root, "a.ts", "disk\n");
  const differentlyCased = path.join(root, "A.TS");
  const sameFile = await fs
    .stat(differentlyCased)
    .then(() => true)
    .catch(() => false);
  const overrides = new Map([[file, "buffer"]]);

  assert.equal(
    await findBufferOverride(overrides, differentlyCased),
    sameFile ? "buffer" : undefined,
  );
  assert.equal(await findBufferOverride(overrides, file), "buffer");
  assert.equal(
    await findBufferOverride(
      new Map([["/definitely/missing/a.ts", "buffer"]]),
      differentlyCased,
    ),
    undefined,
  );
});

test("P2 keeps files under a directory re-included by a deeper .gitignore", async () => {
  const root = await makeRoot("reptclip-p2-");
  await writeFile(root, ".gitignore", "nested/build/\n*.log\n");
  await writeFile(root, "nested/.gitignore", "!build/\n");
  await writeFile(root, "nested/build/secret.txt", "kept\n");
  await writeFile(root, "nested/build/debug.log", "still ignored\n");

  const files = await collectNonIgnoredFiles(root);
  const guard = createEmbeddingGuard(root);

  assert.ok(files.includes("nested/build/secret.txt"));
  assert.equal(files.includes("nested/build/debug.log"), false);
  assert.equal((await guard("nested/build/secret.txt")).ok, true);
  assert.equal((await guard("nested/build/debug.log")).ok, false);
});

test("P3 aborts when a buffer changes while the diff is being prepared", async () => {
  const root = await makeRoot("reptclip-p3-");
  const file = await writeFile(root, "a.txt", "v1\n");

  await assert.rejects(
    () =>
      applyDiffs(root, block("a.txt", "v1", "v2"), {
        assertBuffersCurrent: () => {
          throw new Error("buffer changed while preparing");
        },
      }),
    /buffer changed/i,
  );
  assert.equal(await fs.readFile(file, "utf8"), "v1\n");
});

test("P3b re-checks buffers after documents are opened for the edit", async () => {
  const root = await makeRoot("reptclip-p3b-");
  await writeFile(root, "a.txt", "v1\n");
  let checks = 0;

  await applyDiffs(root, block("a.txt", "v1", "v2"), {
    assertBuffersCurrent: () => {
      checks += 1;
    },
  });

  assert.ok(checks >= 2, `expected a re-check before applyEdit, got ${checks}`);
});

test("P2b keeps anchored patterns relative to their own .gitignore", async () => {
  const root = await makeRoot("reptclip-p2b-");
  await writeFile(root, ".gitignore", "/config\nnested/build/\n");
  await writeFile(root, "nested/.gitignore", "!build/\n");
  await writeFile(root, "config", "root\n");
  await writeFile(root, "nested/build/config", "inner\n");

  const files = await collectNonIgnoredFiles(root);
  const guard = createEmbeddingGuard(root);

  assert.equal(files.includes("config"), false);
  assert.ok(files.includes("nested/build/config"));
  assert.equal((await guard("config")).ok, false);
  assert.equal((await guard("nested/build/config")).ok, true);
});

test("P5 does not crash when the re-included base is the level itself", async () => {
  const root = await makeRoot("reptclip-p5-");
  await writeFile(root, ".gitignore", "!nested/\n");
  await writeFile(root, "nested/.gitignore", "*.log\n");
  await writeFile(root, "nested/debug.log", "x\n");
  await writeFile(root, "nested/keep.txt", "x\n");

  const files = await collectNonIgnoredFiles(root);
  assert.equal(files.includes("nested/debug.log"), false);
  assert.ok(files.includes("nested/keep.txt"));
  assert.equal(
    (await createEmbeddingGuard(root)("nested/debug.log")).ok,
    false,
  );
});

test("P6 keeps a directory exclusion declared below a re-included base", async () => {
  const root = await makeRoot("reptclip-p6-");
  await writeFile(root, ".gitignore", "build/\n!build/\nbuild/private/\n");
  await writeFile(root, "build/keep.txt", "x\n");
  await writeFile(root, "build/private/secret.txt", "x\n");

  const files = await collectNonIgnoredFiles(root);
  const guard = createEmbeddingGuard(root);

  assert.ok(files.includes("build/keep.txt"));
  assert.equal(files.includes("build/private/secret.txt"), false);
  assert.equal((await guard("build/keep.txt")).ok, true);
  assert.equal((await guard("build/private/secret.txt")).ok, false);
});

test("P7 keeps nested files under a re-included base without a separate rule", async () => {
  const root = await makeRoot("reptclip-p7-");
  await writeFile(root, ".gitignore", "nested/build/\n");
  await writeFile(root, "nested/.gitignore", "!build/\n");
  await writeFile(root, "nested/build/sub/file.txt", "x\n");

  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes("nested/build/sub/file.txt"));
  assert.equal(
    (await createEmbeddingGuard(root)("nested/build/sub/file.txt")).ok,
    true,
  );
});

test("P8 keeps a deeper match of an unanchored rule that also matches the base", async () => {
  const root = await makeRoot("reptclip-p8-");
  await writeFile(root, ".gitignore", "build/\n!/build/\n");
  await writeFile(root, "build/keep.txt", "x\n");
  await writeFile(root, "build/sub/build/secret.txt", "x\n");

  const files = await collectNonIgnoredFiles(root);
  const guard = createEmbeddingGuard(root);

  assert.ok(files.includes("build/keep.txt"));
  assert.equal(files.includes("build/sub/build/secret.txt"), false);
  assert.equal((await guard("build/keep.txt")).ok, true);
  assert.equal((await guard("build/sub/build/secret.txt")).ok, false);
});

test("P9 does not let a synthetic prefix create a directory match", async () => {
  const root = await makeRoot("reptclip-p9-");
  await writeFile(root, ".gitignore", "x/\n");
  await writeFile(root, "nested/.gitignore", "!/x/\n");
  await writeFile(root, "nested/x/sub/file.txt", "x\n");

  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes("nested/x/sub/file.txt"));
  assert.equal(
    (await createEmbeddingGuard(root)("nested/x/sub/file.txt")).ok,
    true,
  );
});

test("P10 keeps a separately excluded directory inside a re-included base", async () => {
  const root = await makeRoot("reptclip-p10-");
  await writeFile(root, ".gitignore", "nested/build/\nnested/build/private/\n");
  await writeFile(root, "nested/.gitignore", "!build/\n");
  await writeFile(root, "nested/build/private/.gitignore", "!secret.txt\n");
  await writeFile(root, "nested/build/ok.txt", "ok\n");
  await writeFile(root, "nested/build/private/secret.txt", "secret\n");

  const files = await collectNonIgnoredFiles(root);
  const guard = createEmbeddingGuard(root);

  assert.ok(files.includes("nested/build/ok.txt"));
  assert.equal(files.includes("nested/build/private/secret.txt"), false);
  assert.equal((await guard("nested/build/ok.txt")).ok, true);
  assert.equal((await guard("nested/build/private/secret.txt")).ok, false);
});

test("R1 the guard rejects a directory link that leaves the project", async (t) => {
  const root = await makeRoot("reptclip-r1-");
  const outside = await makeRoot("reptclip-r1-out-");
  await writeFile(outside, "secret.txt", "secret\n");
  const link = path.join(root, "link");

  let linked = true;
  try {
    await fs.symlink(outside, link, "junction");
  } catch {
    try {
      await fs.symlink(outside, link);
    } catch {
      linked = false;
    }
  }
  if (!linked) {
    t.skip("cannot create a directory link in this environment");
    return;
  }

  const verdict = await createEmbeddingGuard(root)("link/secret.txt");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /outside|link/i);
});

test("R2 the guard rejects a file link that leaves the project", async (t) => {
  const root = await makeRoot("reptclip-r2-");
  const outside = await makeRoot("reptclip-r2-out-");
  await writeFile(outside, "secret.txt", "secret\n");
  const link = path.join(root, "secret.txt");

  try {
    await fs.symlink(path.join(outside, "secret.txt"), link, "file");
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }

  const verdict = await createEmbeddingGuard(root)("secret.txt");
  assert.equal(verdict.ok, false);
});

test("R3 the guard rejects a dangling link", async (t) => {
  const root = await makeRoot("reptclip-r3-");
  const link = path.join(root, "ghost.txt");

  try {
    await fs.symlink(path.join(root, "missing.txt"), link, "file");
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }

  const verdict = await createEmbeddingGuard(root)("ghost.txt");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /dangling|outside/i);
});

test("R4 the guard returns the canonical path for a normal file", async () => {
  const root = await makeRoot("reptclip-r4-");
  await writeFile(root, "src/app.ts", "export const a = 1;\n");

  const verdict = await createEmbeddingGuard(root)("src/app.ts");
  assert.equal(verdict.ok, true);
  assert.ok(verdict.absPath);
  assert.equal(
    await fs.readFile(verdict.absPath!, "utf8"),
    "export const a = 1;\n",
  );
});

test("R5 the guard judges the canonical target, not just the alias", async (t) => {
  const root = await makeRoot("reptclip-r5-");
  await writeFile(root, ".git/config", "[core]\n");
  const link = path.join(root, "alias");

  try {
    await fs.symlink(path.join(root, ".git"), link, "junction");
  } catch {
    try {
      await fs.symlink(path.join(root, ".git"), link, "dir");
    } catch {
      t.skip("cannot create a directory link in this environment");
      return;
    }
  }

  const verdict = await createEmbeddingGuard(root)("alias/config");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /\.git/i);
});

test("R6 the guard rejects an alias to a gitignored file", async (t) => {
  const root = await makeRoot("reptclip-r6-");
  await writeFile(root, ".gitignore", ".env\n");
  await writeFile(root, ".env", "TOKEN=1\n");
  const link = path.join(root, "envlink");

  try {
    await fs.symlink(path.join(root, ".env"), link, "file");
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }

  const verdict = await createEmbeddingGuard(root)("envlink");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /ignored/i);
});

// ---------------------------------------------------------------------------
// E10 - legitimate flows must keep working after the fixes.
// ---------------------------------------------------------------------------

test("E10 exact, fuzzy, create, delete and a three-step undo/redo round trip", async () => {
  const root = await makeRoot("reptclip-e10-");
  const file = await writeFile(root, "src/counter.js", "let value = 1;\n");

  const first = await applyDiffs(
    root,
    block("src/counter.js", "let value = 1;", "let value = 2;"),
  );
  assert.equal(await fs.readFile(file, "utf8"), "let value = 2;\n");

  const fuzzyRoot = await makeRoot("reptclip-e10f-");
  const fuzzyFile = await writeFile(
    fuzzyRoot,
    "src/drift.js",
    "if (value) {\n    console.log(value);\n}\n",
  );
  const fuzzy = await applyDiffs(
    fuzzyRoot,
    [
      "src/drift.js",
      "<<<<<<< SEARCH",
      "if (value) {",
      "  console.log(value);",
      "}",
      "=======",
      'if (value) {\n  console.log("updated");\n}',
      ">>>>>>> REPLACE",
    ].join("\n"),
  );
  assert.equal(fuzzy.fuzzy, 1);
  assert.equal(
    await fs.readFile(fuzzyFile, "utf8"),
    'if (value) {\n  console.log("updated");\n}\n',
  );

  const created = await applyDiffs(root, block("notes.txt", "", "hello"));
  assert.equal(created.created, 1);
  assert.equal(
    await fs.readFile(path.join(root, "notes.txt"), "utf8"),
    "hello",
  );

  const emptied = await applyDiffs(root, block("notes.txt", "hello", ""));
  assert.equal(emptied.deleted, 0);
  assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "");

  await applySnapshot(root, first.checkpoint.files, "undo");
  assert.equal(await fs.readFile(file, "utf8"), "let value = 1;\n");
  await applySnapshot(root, first.checkpoint.files, "redo");
  assert.equal(await fs.readFile(file, "utf8"), "let value = 2;\n");
  await applySnapshot(root, first.checkpoint.files, "undo");
  assert.equal(await fs.readFile(file, "utf8"), "let value = 1;\n");
});

// ---------------------------------------------------------------------------
// E11 - modifying .gitignore itself must require explicit confirmation.
// ---------------------------------------------------------------------------

test("E11 refuses to edit .gitignore without an explicit confirmation", async () => {
  const root = await makeRoot("reptclip-e11-edit-");
  await writeFile(root, ".gitignore", ".env\n");

  await assert.rejects(
    () => applyDiffs(root, block(".gitignore", ".env", ".env\n*.log")),
    /gitignore/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n",
  );
});

test("E11 applies a .gitignore edit only when the confirmation resolves true", async () => {
  const root = await makeRoot("reptclip-e11-edity-");
  await writeFile(root, ".gitignore", ".env\n");

  const result = await applyDiffs(
    root,
    block(".gitignore", ".env", ".env\n*.log"),
    {
      confirmGitignoreEdits: async (paths) =>
        paths.length === 1 && paths[0] === ".gitignore",
    },
  );
  assert.equal(result.modified, 1);
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n*.log\n",
  );
});

test("E11 aborts a .gitignore edit without writing when confirmation is declined", async () => {
  const root = await makeRoot("reptclip-e11-editn-");
  await writeFile(root, ".gitignore", ".env\n");

  await assert.rejects(
    () =>
      applyDiffs(root, block(".gitignore", ".env", ".env\n*.log"), {
        confirmGitignoreEdits: async () => false,
      }),
    /cancel|declin|abort/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n",
  );
});

test("E11 refuses creating a new .gitignore without confirmation", async () => {
  const root = await makeRoot("reptclip-e11-create-");

  await assert.rejects(
    () => applyDiffs(root, block("nested/.gitignore", "", "*.log\n")),
    /gitignore/i,
  );
  assert.equal(
    await fs
      .access(path.join(root, "nested/.gitignore"))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test("E11 refuses deleting .gitignore without confirmation", async () => {
  const root = await makeRoot("reptclip-e11-delete-");
  await writeFile(root, ".gitignore", ".env\n");

  await assert.rejects(
    () => applyDiffs(root, ".gitignore delete"),
    /gitignore/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n",
  );

  const result = await applyDiffs(root, ".gitignore delete", {
    confirmGitignoreEdits: async () => true,
  });
  assert.equal(result.deleted, 1);
  assert.equal(
    await fs
      .access(path.join(root, ".gitignore"))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

test("E11 refuses moving .gitignore away or onto a new path without confirmation", async () => {
  const root = await makeRoot("reptclip-e11-move-");
  await writeFile(root, ".gitignore", ".env\n");

  // Moving .gitignore away from its tracked location.
  await assert.rejects(
    () => applyDiffs(root, ".gitignore -> old.gitignore.bak"),
    /gitignore/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n",
  );

  // Moving some other file onto a new .gitignore destination.
  await writeFile(root, "staged-ignore.txt", "*.log\n");
  await assert.rejects(
    () => applyDiffs(root, "staged-ignore.txt -> nested/.gitignore"),
    /gitignore/i,
  );
  assert.equal(
    await fs
      .access(path.join(root, "nested/.gitignore"))
      .then(() => true)
      .catch(() => false),
    false,
  );

  const result = await applyDiffs(
    root,
    "staged-ignore.txt -> nested/.gitignore",
    { confirmGitignoreEdits: async () => true },
  );
  assert.equal(result.created, 1);
  assert.equal(result.deleted, 1);
  assert.equal(
    await fs.readFile(path.join(root, "nested/.gitignore"), "utf8"),
    "*.log\n",
  );
});

test("E11 does not require confirmation for reading .gitignore", async () => {
  const root = await makeRoot("reptclip-e11-read-");
  await writeFile(root, ".gitignore", ".env\n");

  const guard = createEmbeddingGuard(root);
  const verdict = await guard(".gitignore");
  assert.equal(verdict.ok, true);
});

test("E11 does not flag an ordinary file whose name merely contains 'gitignore'", async () => {
  const root = await makeRoot("reptclip-e11-notfile-");
  await writeFile(root, "my.gitignore.txt", "note\n");

  // No confirmGitignoreEdits supplied; this must succeed on its own, proving
  // the check is scoped to the exact basename ".gitignore".
  const result = await applyDiffs(
    root,
    block("my.gitignore.txt", "note", "updated note"),
  );
  assert.equal(result.modified, 1);
  assert.equal(
    await fs.readFile(path.join(root, "my.gitignore.txt"), "utf8"),
    "updated note\n",
  );
});

test("standalone move and delete operations apply and round-trip", async () => {
  const root = await makeRoot("reptclip-move-delete-");
  const source = await writeFile(root, "src/old.txt", "keep me\n");
  await writeFile(root, "src/remove.txt", "remove me\n");

  const moved = await applyDiffs(root, "src/old.txt -> src/new.txt");
  assert.equal(await exists(source), false);
  assert.equal(
    await fs.readFile(path.join(root, "src/new.txt"), "utf8"),
    "keep me\n",
  );
  assert.equal(moved.created, 1);
  assert.equal(moved.deleted, 1);

  await applySnapshot(root, moved.checkpoint.files, "undo");
  assert.equal(await exists(source), true);
  assert.equal(await exists(path.join(root, "src/new.txt")), false);

  const deleted = await applyDiffs(root, "src/remove.txt delete");
  assert.equal(await exists(path.join(root, "src/remove.txt")), false);
  assert.equal(deleted.deleted, 1);

  await applySnapshot(root, deleted.checkpoint.files, "undo");
  assert.equal(
    await fs.readFile(path.join(root, "src/remove.txt"), "utf8"),
    "remove me\n",
  );
});
