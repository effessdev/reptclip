import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";

const originalLoad = (Module as any)._load;
const fakeVscode = {
  Uri: {
    file: (absPath: string) => ({
      fsPath: absPath,
      path: absPath,
      toString: () => absPath,
    }),
  },
  Position: class {
    line: number;
    character: number;

    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
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
    operations: any[];

    constructor() {
      this.operations = [];
    }

    deleteFile(uri: { fsPath: string }) {
      this.operations.push(["deleteFile", uri]);
    }

    createFile(uri: { fsPath: string }) {
      this.operations.push(["createFile", uri]);
    }

    insert(uri: { fsPath: string }, position: any, text: string) {
      this.operations.push(["insert", uri, position, text]);
    }

    replace(uri: { fsPath: string }, range: any, text: string) {
      this.operations.push(["replace", uri, text]);
    }
  },
  workspace: {
    async applyEdit(edit: { operations: any[] }) {
      for (const operation of edit.operations) {
        const [kind, uri, ...rest] = operation;
        const filePath = uri.fsPath;

        if (kind === "createFile") {
          await fs.writeFile(filePath, "", "utf8");
          continue;
        }

        if (kind === "deleteFile") {
          await fs.rm(filePath, { force: true });
          continue;
        }

        if (kind === "insert") {
          const [, , , text] = operation;
          const existing = await fs.readFile(filePath, "utf8").catch(() => "");
          await fs.writeFile(filePath, existing + text, "utf8");
          continue;
        }

        if (kind === "replace") {
          const [, , text] = operation;
          await fs.writeFile(filePath, text, "utf8");
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

const { parseDiffBlocks, applyDiffs, applySnapshot } =
  require("./diffApplier") as typeof import("./diffApplier");
const { collectNonIgnoredFiles, createEmbeddingGuard } =
  require("./gitignoreScanner") as typeof import("./gitignoreScanner");

test("parseDiffBlocks parses a valid fenced Search/Replace block", () => {
  const text = [
    "```diff",
    "src/app.ts",
    "<<<<<<< SEARCH",
    "const value = 1;",
    "=======",
    "const value = 2;",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");

  assert.deepEqual(parseDiffBlocks(text), [
    {
      file: "src/app.ts",
      search: "const value = 1;",
      replace: "const value = 2;",
    },
  ]);
});

test("parseDiffBlocks parses move and delete operations", () => {
  assert.deepEqual(
    parseDiffBlocks("src/old.ts -> src/new.ts\nsrc/remove.ts delete"),
    [
      {
        file: "src/old.ts",
        destination: "src/new.ts",
        search: "",
        replace: "",
        kind: "move",
      },
      {
        file: "src/remove.ts",
        search: "",
        replace: "",
        kind: "delete",
      },
    ],
  );
});

test("parseDiffBlocks throws a clear error for truncated diff text", () => {
  const text = [
    "src/app.ts",
    "<<<<<<< SEARCH",
    "const value = 1;",
    "=======",
  ].join("\n");

  assert.throws(() => parseDiffBlocks(text), /Truncated diff/);
});

test("parseDiffBlocks rejects a SEARCH block with no file path before it", () => {
  const text = [
    "<<<<<<< SEARCH",
    "const value = 1;",
    "=======",
    "const value = 2;",
    ">>>>>>> REPLACE",
  ].join("\n");

  assert.throws(
    () => parseDiffBlocks(text),
    /Found a SEARCH\/REPLACE block with no file path before it\./,
  );
});

test("applyDiffs replaces an exact match without fuzzy fallback", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-exact-"));
  const filePath = path.join(rootDir, "src", "example.js");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "const value = 1;\n", "utf8");

  const diff = [
    "src/example.js",
    "<<<<<<< SEARCH",
    "const value = 1;",
    "=======",
    "const value = 2;",
    ">>>>>>> REPLACE",
  ].join("\n");

  const summary = await applyDiffs(rootDir, diff);

  assert.equal(summary.modified, 1);
  assert.equal(summary.fuzzy, 0);
  assert.equal(await fs.readFile(filePath, "utf8"), "const value = 2;\n");
});

test("applyDiffs still matches when indentation drifts within the SEARCH block", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-fuzzy-"));
  const filePath = path.join(rootDir, "src", "drift.js");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    "if (value) {\n    console.log(value);\n}\n",
    "utf8",
  );

  const diff = [
    "src/drift.js",
    "<<<<<<< SEARCH",
    "if (value) {",
    "  console.log(value);",
    "}",
    "=======",
    "if (value) {",
    '  console.log("updated");',
    "}",
    ">>>>>>> REPLACE",
  ].join("\n");

  const summary = await applyDiffs(rootDir, diff);

  assert.equal(summary.fuzzy, 1);
  assert.equal(
    await fs.readFile(filePath, "utf8"),
    'if (value) {\n  console.log("updated");\n}\n',
  );
});

test("applyDiffs normalizes CRLF files when the diff uses LF line endings", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-crlf-"));
  const filePath = path.join(rootDir, "src", "newline.js");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "alpha\r\nbeta\r\n", "utf8");

  const diff = [
    "src/newline.js",
    "<<<<<<< SEARCH",
    "alpha",
    "beta",
    "=======",
    "alpha",
    "gamma",
    ">>>>>>> REPLACE",
  ].join("\n");

  const summary = await applyDiffs(rootDir, diff);

  assert.equal(summary.modified, 1);
  assert.equal(await fs.readFile(filePath, "utf8"), "alpha\r\ngamma\r\n");
});

test("applyDiffs throws instead of applying an ambiguous SEARCH match", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-ambiguous-"),
  );
  const filePath = path.join(rootDir, "src", "ambiguous.js");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "alpha\nvalue\nalpha\nvalue\n", "utf8");

  const diff = [
    "src/ambiguous.js",
    "<<<<<<< SEARCH",
    "alpha",
    "value",
    "=======",
    "alpha",
    "updated",
    ">>>>>>> REPLACE",
  ].join("\n");

  await assert.rejects(
    () => applyDiffs(rootDir, diff),
    /matches multiple locations/i,
  );
  assert.equal(
    await fs.readFile(filePath, "utf8"),
    "alpha\nvalue\nalpha\nvalue\n",
  );
});

test("applySnapshot undoes and redoes a modified file checkpoint", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-undo-"));
  const filePath = path.join(rootDir, "src", "counter.js");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "let value = 1;\n", "utf8");

  const diff = [
    "src/counter.js",
    "<<<<<<< SEARCH",
    "let value = 1;",
    "=======",
    "let value = 2;",
    ">>>>>>> REPLACE",
  ].join("\n");

  const result = await applyDiffs(rootDir, diff);
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 2;\n");

  const undoSummary = await applySnapshot(
    rootDir,
    result.checkpoint.files,
    "undo",
  );
  assert.deepEqual(undoSummary, {
    modified: 1,
    created: 0,
    deleted: 0,
    fuzzy: 0,
  });
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 1;\n");

  const redoSummary = await applySnapshot(
    rootDir,
    result.checkpoint.files,
    "redo",
  );
  assert.deepEqual(redoSummary, {
    modified: 1,
    created: 0,
    deleted: 0,
    fuzzy: 0,
  });
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 2;\n");
});

test("applySnapshot supports chained undo/redo across multiple checkpoints", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-stack-"));
  const filePath = path.join(rootDir, "src", "counter.js");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "let value = 1;\n", "utf8");

  const firstDiff = [
    "src/counter.js",
    "<<<<<<< SEARCH",
    "let value = 1;",
    "=======",
    "let value = 2;",
    ">>>>>>> REPLACE",
  ].join("\n");

  const secondDiff = [
    "src/counter.js",
    "<<<<<<< SEARCH",
    "let value = 2;",
    "=======",
    "let value = 3;",
    ">>>>>>> REPLACE",
  ].join("\n");

  const firstResult = await applyDiffs(rootDir, firstDiff);
  const secondResult = await applyDiffs(rootDir, secondDiff);
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 3;\n");

  await applySnapshot(rootDir, secondResult.checkpoint.files, "undo");
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 2;\n");

  await applySnapshot(rootDir, firstResult.checkpoint.files, "undo");
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 1;\n");

  await applySnapshot(rootDir, firstResult.checkpoint.files, "redo");
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 2;\n");

  await applySnapshot(rootDir, secondResult.checkpoint.files, "redo");
  assert.equal(await fs.readFile(filePath, "utf8"), "let value = 3;\n");
});

test("applySnapshot undoes and redoes a newly created file checkpoint", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-create-"));
  const filePath = path.join(rootDir, "notes.txt");

  const diff = [
    "notes.txt",
    "<<<<<<< SEARCH",
    "=======",
    "hello from reptclip",
    ">>>>>>> REPLACE",
  ].join("\n");

  const result = await applyDiffs(rootDir, diff);
  assert.equal(await fs.readFile(filePath, "utf8"), "hello from reptclip");

  const undoSummary = await applySnapshot(
    rootDir,
    result.checkpoint.files,
    "undo",
  );
  assert.deepEqual(undoSummary, {
    modified: 0,
    created: 0,
    deleted: 1,
    fuzzy: 0,
  });
  assert.equal(
    await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false),
    false,
  );

  const redoSummary = await applySnapshot(
    rootDir,
    result.checkpoint.files,
    "redo",
  );
  assert.deepEqual(redoSummary, {
    modified: 0,
    created: 1,
    deleted: 0,
    fuzzy: 0,
  });
  assert.equal(await fs.readFile(filePath, "utf8"), "hello from reptclip");
});

test("collectNonIgnoredFiles skips files ignored by nested .gitignore entries", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-ignore-"));
  const nestedDir = path.join(rootDir, "nested");
  await fs.mkdir(nestedDir, { recursive: true });

  await fs.writeFile(
    path.join(rootDir, ".gitignore"),
    "ignored-root.txt\n",
    "utf8",
  );
  await fs.writeFile(path.join(rootDir, "kept.txt"), "root\n", "utf8");
  await fs.writeFile(path.join(rootDir, "ignored-root.txt"), "skip\n", "utf8");
  await fs.writeFile(
    path.join(nestedDir, ".gitignore"),
    "skip-me.txt\n",
    "utf8",
  );
  await fs.writeFile(path.join(nestedDir, "kept-inner.txt"), "inner\n", "utf8");
  await fs.writeFile(path.join(nestedDir, "skip-me.txt"), "skip\n", "utf8");

  const files = await collectNonIgnoredFiles(rootDir);

  assert.deepEqual(files, [
    ".gitignore",
    "kept.txt",
    "nested/.gitignore",
    "nested/kept-inner.txt",
  ]);
});

test("createEmbeddingGuard rejects absolute paths and paths escaping the project root", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-guard-"));
  const guard = createEmbeddingGuard(rootDir);

  const absolute = await guard(path.join(rootDir, "safe.txt"));
  assert.deepEqual(absolute, {
    ok: false,
    reason: "absolute path; must be relative to the project root",
  });

  const escaping = await guard("../outside.txt");
  assert.deepEqual(escaping, {
    ok: false,
    reason: "resolves outside the project root",
  });
});

test("createEmbeddingGuard rejects .git paths even when they are otherwise valid-looking", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-git-"));
  const guard = createEmbeddingGuard(rootDir);

  const verdict = await guard(".git/config");

  assert.deepEqual(verdict, {
    ok: false,
    reason: "inside .git, which is never embedded",
  });
});
