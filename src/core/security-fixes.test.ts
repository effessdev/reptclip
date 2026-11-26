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

test("P11 keeps files when the workspace itself is a re-included folder", async () => {
  // A root rule excludes `nested/build/`, `nested/.gitignore` re-includes it,
  // and the panel is opened on `nested/build` itself. The re-inclusion has to
  // survive the trip out of `inheritedLevels`, or every file under the
  // workspace is dropped.
  const root = await makeRoot("reptclip-p11-");
  await writeFile(root, ".git/HEAD", "ref: refs/heads/main\n");
  await writeFile(root, ".gitignore", "/nested/build/\n");
  await writeFile(root, "nested/.gitignore", "!build/\n");
  await writeFile(root, "nested/build/app.txt", "x\n");
  const workspace = path.join(root, "nested", "build");

  assert.deepEqual(await collectNonIgnoredFiles(workspace), ["app.txt"]);
  assert.equal((await createEmbeddingGuard(workspace)("app.txt")).ok, true);

  // A rule that excludes a directory below the re-included base still applies.
  await writeFile(root, "nested/.gitignore", "!build/\nbuild/private/\n");
  await writeFile(root, "nested/build/private/secret.txt", "secret\n");
  assert.deepEqual(await collectNonIgnoredFiles(workspace), ["app.txt"]);
  assert.equal(
    (await createEmbeddingGuard(workspace)("private/secret.txt")).ok,
    false,
  );

  // The base only scopes the *cause* of an ignore to the re-included directory:
  // a root pattern that matches the file itself still applies.
  await writeFile(root, ".gitignore", "/nested/build/\n*.secret\n");
  await writeFile(root, "nested/build/x.secret", "s\n");
  assert.equal((await createEmbeddingGuard(workspace)("x.secret")).ok, false);
});

test("P11b judges an alias inside a re-included workspace from its base", async (t) => {
  // The lexical name is `alias/file.txt`, the real path is `sub/file.txt`: the
  // alias branch evaluates the canonical target, and it must use the same
  // re-inclusion base as the walk, or a legitimate file is rejected.
  const root = await makeRoot("reptclip-p11b-");
  await writeFile(root, ".git/HEAD", "ref: refs/heads/main\n");
  await writeFile(root, ".gitignore", "/nested/build/\n");
  await writeFile(root, "nested/.gitignore", "!build/\n");
  await writeFile(root, "nested/build/sub/file.txt", "x\n");
  const workspace = path.join(root, "nested", "build");

  try {
    await fs.symlink(path.join(workspace, "sub"), path.join(workspace, "alias"), "junction");
  } catch {
    t.skip("cannot create a directory link in this environment");
    return;
  }

  assert.equal(
    (await createEmbeddingGuard(workspace)("alias/file.txt")).ok,
    true,
  );
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

// ---------------------------------------------------------------------------
// E12 - an NTFS alternate-data-stream alias must not bypass .gitignore.
// ---------------------------------------------------------------------------

// NTFS alternate data streams exist only on Windows; on POSIX `a::$DATA` is a
// separate file name, so these cases cannot be exercised there.
const adsTest = process.platform === "win32" ? test : test.skip;
adsTest("E12 refuses writing a gitignored file via its ADS alias", async () => {
  const root = await makeRoot("reptclip-e12-");
  await writeFile(root, ".gitignore", ".env\n");
  await writeFile(root, ".env", "TOKEN=1\n");

  await assert.rejects(
    () => applyDiffs(root, block(".env::$DATA", "TOKEN=1", "TOKEN=2")),
    /gitignore/i,
  );
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "TOKEN=1\n");
});

adsTest("E12 refuses creating a new file at a gitignored path via its ADS alias", async () => {
  const root = await makeRoot("reptclip-e12-create-");
  await writeFile(root, ".gitignore", "secrets.json\n");

  await assert.rejects(
    () => applyDiffs(root, block("secrets.json::$DATA", "", "{}")),
    /gitignore/i,
  );
  assert.equal(
    await fs
      .access(path.join(root, "secrets.json"))
      .then(() => true)
      .catch(() => false),
    false,
  );
});

adsTest("E12 refuses deleting a gitignored file via its ADS alias", async () => {
  const root = await makeRoot("reptclip-e12-delete-");
  await writeFile(root, ".gitignore", ".env\n");
  await writeFile(root, ".env", "TOKEN=1\n");

  await assert.rejects(
    () => applyDiffs(root, ".env::$DATA delete"),
    /gitignore/i,
  );
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "TOKEN=1\n");
});

adsTest("E12 refuses a move whose source or destination is a gitignored ADS alias", async () => {
  const root = await makeRoot("reptclip-e12-move-");
  await writeFile(root, ".gitignore", ".env\nsecrets.json\n");
  await writeFile(root, ".env", "TOKEN=1\n");
  await writeFile(root, "plain.txt", "hello\n");

  // Source is an ADS alias of a gitignored file.
  await assert.rejects(
    () => applyDiffs(root, ".env::$DATA -> moved.txt"),
    /gitignore/i,
  );
  assert.equal(
    await fs
      .access(path.join(root, "moved.txt"))
      .then(() => true)
      .catch(() => false),
    false,
  );

  // Destination is an ADS alias of a gitignored path.
  await assert.rejects(
    () => applyDiffs(root, "plain.txt -> secrets.json::$DATA"),
    /gitignore/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, "plain.txt"), "utf8"),
    "hello\n",
  );
});

adsTest("E12 still allows writing an ungitignored file through an ADS-like path", async () => {
  const root = await makeRoot("reptclip-e12-allow-");
  const file = await writeFile(root, "notes.txt", "v1\n");

  const result = await applyDiffs(root, block("notes.txt::$DATA", "v1", "v2"));
  assert.equal(result.modified, 1);
  assert.equal(await fs.readFile(file, "utf8"), "v2\n");
});

adsTest("E12 refuses editing .gitignore itself via its ADS alias without confirmation", async () => {
  const root = await makeRoot("reptclip-e12-gi-");
  await writeFile(root, ".gitignore", ".env\n");

  await assert.rejects(
    () => applyDiffs(root, block(".gitignore::$DATA", ".env", ".env\n*.log")),
    /gitignore/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n",
  );

  const result = await applyDiffs(
    root,
    block(".gitignore::$DATA", ".env", ".env\n*.log"),
    { confirmGitignoreEdits: async () => true },
  );
  assert.equal(result.modified, 1);
  assert.equal(
    await fs.readFile(path.join(root, ".gitignore"), "utf8"),
    ".env\n*.log\n",
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


test("E13 refuses editing .gitignore through a symbolic link without confirmation", async (t) => {
  const root = await makeRoot("reptclip-e13-sym-");
  const gitignore = await writeFile(root, ".gitignore", ".env\n");
  try {
    await fs.symlink(gitignore, path.join(root, "ignore-link"));
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }

  await assert.rejects(
    () => applyDiffs(root, block("ignore-link", ".env", "# gone")),
    /gitignore/i,
  );
  assert.equal(await fs.readFile(gitignore, "utf8"), ".env\n");

  // The confirmation path still works through the alias.
  const confirmed = await applyDiffs(
    root,
    block("ignore-link", ".env", "# gone"),
    { confirmGitignoreEdits: async (paths) => paths.includes("ignore-link") },
  );
  assert.equal(confirmed.modified, 1);
});

// ---------------------------------------------------------------------------
// E14 - git also ignores $GIT_COMMON_DIR/info/exclude; anything git hides must
// stay hidden from context and from diffs.
// ---------------------------------------------------------------------------

function gitIgnored(root: string, relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", relPath], {
      cwd: root,
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw err;
    }
    return false;
  }
}


test("E14 honours .git/info/exclude exactly like git", async (t) => {
  const root = await makeRoot("reptclip-e14-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".git", "info", "exclude"),
    "secrets.local\n",
    "utf8",
  );
  await writeFile(root, "secrets.local", "TOKEN=1\n");
  await writeFile(root, "keep.txt", "keep\n");

  const guard = createEmbeddingGuard(root);
  const listed = await collectNonIgnoredFiles(root);
  for (const rel of ["secrets.local", "keep.txt"]) {
    const gitSaysIgnored = gitIgnored(root, rel);
    const verdict = await guard(rel);
    assert.equal(
      !verdict.ok,
      gitSaysIgnored,
      `${rel}: guard refused=${!verdict.ok}, git ignored=${gitSaysIgnored}`,
    );
    assert.equal(listed.includes(rel), !gitSaysIgnored);
  }

  await assert.rejects(
    () => applyDiffs(root, block("secrets.local", "TOKEN=1", "TOKEN=2")),
    /gitignore/i,
  );
  assert.equal(
    await fs.readFile(path.join(root, "secrets.local"), "utf8"),
    "TOKEN=1\n",
  );

  // A .gitignore negation outranks info/exclude, in git and here alike.
  await writeFile(root, ".gitignore", "!secrets.local\n");
  assert.equal(
    await createEmbeddingGuard(root)("secrets.local").then((v) => v.ok),
    true,
  );
  assert.equal(gitIgnored(root, "secrets.local"), false);
  assert.equal(
    (await collectNonIgnoredFiles(root)).includes("secrets.local"),
    true,
  );
});


test("E14 follows core.ignorecase instead of always matching case-insensitively", async (t) => {
  const root = await makeRoot("reptclip-e14-case-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await writeFile(root, ".gitignore", "*.LOG\n");
  await writeFile(root, "app.log", "x\n");

  execFileSync("git", ["config", "core.ignorecase", "true"], { cwd: root });
  assert.equal(gitIgnored(root, "app.log"), true);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    false,
    "core.ignorecase=true must hide app.log from a *.LOG rule, like git",
  );

  execFileSync("git", ["config", "core.ignorecase", "false"], { cwd: root });
  assert.equal(gitIgnored(root, "app.log"), false);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    true,
    "core.ignorecase=false must keep app.log readable, like git",
  );
});

// POSIX only: a colon is an ordinary filename character there, so `a:b` must
// not be judged against a rule written for `a`.
test("E19 does not treat a POSIX filename with a colon as an NTFS stream alias", async (t) => {
  if (process.platform === "win32") {
    t.skip("colons cannot appear in Windows filenames");
    return;
  }
  const root = await makeRoot("reptclip-e19-");
  await writeFile(root, ".gitignore", "notes.txt\n");
  await writeFile(root, "notes.txt:backup", "keep\n");

  const verdict = await createEmbeddingGuard(root)("notes.txt:backup");
  assert.equal(verdict.ok, true);
});


test("E22 inherits .gitignore files from above a subdirectory workspace", async (t) => {
  const repo = await makeRoot("reptclip-e22-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  const root = path.join(repo, "sub");
  await writeFile(repo, ".gitignore", "secret.txt\n");
  await writeFile(root, "secret.txt", "TOKEN=1\n");
  await writeFile(root, "keep.txt", "keep\n");

  const guard = createEmbeddingGuard(root);
  assert.equal((await guard("secret.txt")).ok, false);
  assert.equal((await collectNonIgnoredFiles(root)).includes("secret.txt"), false);
  await assert.rejects(
    () => applyDiffs(root, block("secret.txt", "TOKEN=1", "TOKEN=2")),
    /gitignore/i,
  );

  // A negation in the parent .gitignore is anchored at the repository root and
  // still re-includes the file, exactly as git reports it.
  await writeFile(repo, ".gitignore", "secret.txt\n!/sub/secret.txt\n");
  assert.equal(
    await createEmbeddingGuard(root)("secret.txt").then((v) => v.ok),
    true,
  );
  assert.equal(gitIgnored(root, "secret.txt"), false);
});


test("E24 accepts git's bool spelling of core.ignorecase", async (t) => {
  const root = await makeRoot("reptclip-e24-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "core.ignorecase", "1"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await writeFile(root, ".gitignore", "*.LOG\n");
  await writeFile(root, "app.log", "x\n");

  assert.equal(gitIgnored(root, "app.log"), true);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    false,
  );

  // `0` is false in git; the old parser only knew `true`/`false` and fell back
  // to the volume probe, which is `true` on Windows and macOS.
  execFileSync("git", ["config", "core.ignorecase", "0"], { cwd: root });
  assert.equal(gitIgnored(root, "app.log"), false);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    true,
  );

  // Only `[core]` owns this key: a same-named key in another section must not
  // override it.
  execFileSync("git", ["config", "core.ignorecase", "true"], { cwd: root });
  execFileSync("git", ["config", "alias.ignorecase", "false"], {
    cwd: root,
  });
  assert.equal(gitIgnored(root, "app.log"), true);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    false,
  );
});


test("E30 reads a git config value with an inline comment", async (t) => {
  const root = await makeRoot("reptclip-e30-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await fs.writeFile(
    path.join(root, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tignorecase = false ; comment\n",
    "utf8",
  );
  await writeFile(root, ".gitignore", "*.LOG\n");
  await writeFile(root, "app.log", "x\n");

  assert.equal(gitIgnored(root, "app.log"), false);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    true,
  );
});


test("E28 inherits rules when the workspace is reached through a link", async (t) => {
  const repo = await makeRoot("reptclip-e28-repo-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await writeFile(repo, ".gitignore", ".env\n");
  await writeFile(repo, "sub/.env", "TOKEN=1\n");
  const workspace = path.join(await makeRoot("reptclip-e28-ws-"), "linked");

  try {
    await fs.symlink(path.join(repo, "sub"), workspace, "junction");
  } catch {
    try {
      await fs.symlink(path.join(repo, "sub"), workspace);
    } catch {
      t.skip("cannot create a directory link in this environment");
      return;
    }
  }

  assert.equal(
    await createEmbeddingGuard(workspace)(".env").then((v) => v.ok),
    false,
  );
  await assert.rejects(
    () => applyDiffs(workspace, block(".env", "TOKEN=1", "TOKEN=2")),
    /gitignore/i,
  );
});


test("E29 does not read rules from a symlinked .gitignore, as git does not", async (t) => {
  const root = await makeRoot("reptclip-e29-");
  await writeFile(root, "rules.inc", ".env\n");
  try {
    await fs.symlink(path.join(root, "rules.inc"), path.join(root, ".gitignore"));
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }
  await writeFile(root, ".env", "TOKEN=1\n");

  assert.equal(
    await createEmbeddingGuard(root)(".env").then((v) => v.ok),
    true,
  );
  assert.equal((await collectNonIgnoredFiles(root)).includes(".env"), true);
});


test("E15 resolves info/exclude through a linked worktree's gitdir/commondir", async () => {
  const root = await makeRoot("reptclip-e15-root-");
  const commonDir = await makeRoot("reptclip-e15-common-");
  await writeFile(commonDir, "info/exclude", "wt-secret.txt\n");
  const worktreeGitDir = path.join(commonDir, "worktrees", "wt1");
  await fs.mkdir(worktreeGitDir, { recursive: true });
  await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  await fs.writeFile(
    path.join(root, ".git"),
    `gitdir: ${worktreeGitDir}\n`,
    "utf8",
  );
  await writeFile(root, "wt-secret.txt", "s\n");

  const verdict = await createEmbeddingGuard(root)("wt-secret.txt");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /ignored/i);
});

test("E35 refuses editing a hard link to a .gitignore above the workspace", async (t) => {
  const repo = await makeRoot("reptclip-e35-");
  const source = await writeFile(repo, ".gitignore", ".env\n");
  const workspace = path.join(repo, "work");
  await fs.mkdir(workspace);
  const alias = path.join(workspace, "ignore-mirror");
  try {
    await fs.link(source, alias);
  } catch {
    t.skip("hard links are not supported in this environment");
    return;
  }

  // Two guards can claim this write: the hard-link rule (one inode, two names)
  // and the .gitignore confirmation (the alias is a .gitignore above the
  // workspace). Either refusal is correct, so accept either reason.
  await assert.rejects(
    () => applyDiffs(workspace, block("ignore-mirror", ".env", "# gone")),
    /gitignore|hard link/i,
  );
  assert.equal(await fs.readFile(source, "utf8"), ".env\n");
});

test("E36 reads an explicit empty core.ignorecase as false", async (t) => {
  const root = await makeRoot("reptclip-e36-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  // `git config` normalises an empty value away, so write the file by hand.
  const config = path.join(root, ".git", "config");
  const base = await fs.readFile(config, "utf8");
  await fs.writeFile(config, `${base}\n[core]\n\tignorecase =\n`, "utf8");
  await writeFile(root, ".gitignore", "*.LOG\n");
  await writeFile(root, "app.log", "x\n");

  // git: a bare key means true, `key =` means false. The parser read both as
  // true, which hid app.log on a case-sensitive volume.
  assert.equal(gitIgnored(root, "app.log"), false);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    true,
  );
});

test("E37 reads a quoted core.ignorecase value", async (t) => {
  const root = await makeRoot("reptclip-e37-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  const config = path.join(root, ".git", "config");
  const base = await fs.readFile(config, "utf8");
  await writeFile(root, ".gitignore", "*.LOG\n");
  await writeFile(root, "app.log", "x\n");

  // Both spellings, so the test fails on either kind of volume: a parser that
  // keeps the quotes falls back to the volume probe and gets one of them wrong.
  for (const [written, hidden] of [
    ["true", true],
    ["false", false],
  ] as const) {
    await fs.writeFile(
      config,
      `${base}\n[core]\n\tignorecase = "${written}"\n`,
      "utf8",
    );
    assert.equal(gitIgnored(root, "app.log"), hidden, written);
    assert.equal(
      await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
      !hidden,
      written,
    );
  }
});

test("E38 reads a commented header and does not leak a subsection", async (t) => {
  const root = await makeRoot("reptclip-e38-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  const config = path.join(root, ".git", "config");
  const base = await fs.readFile(config, "utf8");
  await writeFile(root, ".gitignore", "*.LOG\n");
  await writeFile(root, "app.log", "x\n");

  // A comment after the header is legal, and the assignment still belongs to
  // [core]; the previous parser dropped both and fell back to the probe.
  await fs.writeFile(
    config,
    `${base}\n[core] # settings\n\tignorecase = false\n`,
    "utf8",
  );
  assert.equal(gitIgnored(root, "app.log"), false);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    true,
  );

  // `[core "x"]` is the section core.x. It must not leave [core] active, or an
  // unrelated assignment would be read as core.ignorecase.
  await fs.writeFile(
    config,
    `${base}\n[core]\n\tignorecase = false\n[core "x"]\n\tignorecase = true\n`,
    "utf8",
  );
  assert.equal(gitIgnored(root, "app.log"), false);
  assert.equal(
    await createEmbeddingGuard(root)("app.log").then((v) => v.ok),
    true,
  );
});

test("E39 inherits rules for a workspace whose name starts with two dots", async (t) => {
  const repo = await makeRoot("reptclip-e39-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await writeFile(repo, ".gitignore", "*.log\n");
  const workspace = path.join(repo, "..workspace");
  await fs.mkdir(workspace);
  await writeFile(workspace, "app.log", "x\n");

  // `..workspace` only looks like a parent traversal; the rule still applies.
  assert.equal(gitIgnored(workspace, "app.log"), true);
  assert.equal(
    await createEmbeddingGuard(workspace)("app.log").then((v) => v.ok),
    false,
  );
  assert.deepEqual(await collectNonIgnoredFiles(workspace), []);
});

test("E40 treats a workspace folder excluded by an ancestor rule as empty", async (t) => {
  const repo = await makeRoot("reptclip-e40-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  } catch {
    t.skip("git is not available in this environment");
    return;
  }
  await writeFile(repo, ".gitignore", "/private/\n");
  const workspace = path.join(repo, "private");
  await fs.mkdir(workspace);
  await writeFile(workspace, ".gitignore", "!app.log\n");
  await writeFile(workspace, "app.log", "x\n");

  // git applies nothing from inside an excluded directory, so the negation in
  // private/.gitignore cannot rescue app.log.
  assert.equal(gitIgnored(workspace, "app.log"), true);
  assert.deepEqual(await collectNonIgnoredFiles(workspace), []);
  assert.equal(
    await createEmbeddingGuard(workspace)("app.log").then((v) => v.ok),
    false,
  );
});
