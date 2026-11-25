import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";

// `applyDiffs` imports vscode; the scanner does not, but both live in the same
// module graph once the write-path test is in this file.
const originalLoad = (Module as any)._load;
const fakeVscode = {
  Uri: {
    file: (absPath: string) => ({
      fsPath: absPath,
      path: absPath,
      toString: () => absPath,
    }),
  },
  workspace: {
    async applyEdit() {
      return true;
    },
    async openTextDocument() {
      return undefined;
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

const { collectNonIgnoredFiles, createEmbeddingGuard } =
  require("./gitignoreScanner") as typeof import("./gitignoreScanner");
const { applyDiffs } = require("./diffApplier") as typeof import("./diffApplier");

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

async function writeFile(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const absPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf8");
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

test("R1 excludes a file the project ignore file matches", async () => {
  const root = await makeRoot("reptclip-r1-");
  await writeFile(root, ".reptclipignore", "*.generated.ts\n");
  await writeFile(root, "a.ts", "a\n");
  await writeFile(root, "b.generated.ts", "b\n");

  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes("a.ts"));
  assert.equal(files.includes("b.generated.ts"), false);

  const verdict = await createEmbeddingGuard(root)("b.generated.ts");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /reptclipignore/);
});

test("R2 its own negation re-includes a path", async () => {
  const root = await makeRoot("reptclip-r2-");
  await writeFile(root, ".reptclipignore", "*.log\n!keep.log\n");
  await writeFile(root, "keep.log", "k\n");
  await writeFile(root, "other.log", "o\n");

  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes("keep.log"));
  assert.equal(files.includes("other.log"), false);
  assert.equal((await createEmbeddingGuard(root)("keep.log")).ok, true);
});

test("R3 a negation cannot re-include a git-ignored file", async () => {
  const root = await makeRoot("reptclip-r3-");
  await writeFile(root, ".gitignore", ".env\n");
  await writeFile(root, ".reptclipignore", "!.env\n");
  await writeFile(root, ".env", "SECRET=1\n");

  const files = await collectNonIgnoredFiles(root);
  assert.equal(files.includes(".env"), false);

  const verdict = await createEmbeddingGuard(root)(".env");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /gitignore/);
});

test("R4 a nested ignore file applies to its own subtree", async () => {
  const root = await makeRoot("reptclip-r4-");
  await writeFile(root, "nested/.reptclipignore", "tmp/\n");
  await writeFile(root, "nested/tmp/x.ts", "x\n");
  await writeFile(root, "nested/keep.ts", "k\n");
  await writeFile(root, "top.ts", "t\n");

  const files = await collectNonIgnoredFiles(root);
  assert.equal(files.includes("nested/tmp/x.ts"), false);
  assert.ok(files.includes("nested/keep.ts"));
  assert.ok(files.includes("top.ts"));
});

test("R5 a re-included directory keeps its files and still excludes below", async () => {
  const root = await makeRoot("reptclip-r5-");
  await writeFile(root, ".reptclipignore", "build/\n!build/\nbuild/private/\n");
  await writeFile(root, "build/keep.ts", "k\n");
  await writeFile(root, "build/private/secret.ts", "s\n");

  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes("build/keep.ts"));
  assert.equal(files.includes("build/private/secret.ts"), false);
});

test("R6 .git stays excluded whatever the ignore file says", async () => {
  const root = await makeRoot("reptclip-r6-");
  await writeFile(root, ".reptclipignore", "!.git/config\n");
  await writeFile(root, ".git/config", "[core]\n");

  const verdict = await createEmbeddingGuard(root)(".git/config");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /never embedded/);
});

test("R7 editing the ignore file asks for confirmation", async () => {
  const root = await makeRoot("reptclip-r7-");
  await writeFile(root, ".reptclipignore", "*.log\n");
  const diff = block(".reptclipignore", "*.log", "");

  await assert.rejects(
    () => applyDiffs(root, diff),
    /reptclipignore/,
  );
  await assert.rejects(
    () => applyDiffs(root, diff, { confirmGitignoreEdits: async () => false }),
    /not confirmed/,
  );
});

test("R8 a symlinked ignore file is not read, like git", async (t) => {
  const root = await makeRoot("reptclip-r8-");
  const target = path.join(root, "rules.txt");
  await fs.writeFile(target, "secret.txt\n", "utf8");
  try {
    await fs.symlink(target, path.join(root, ".reptclipignore"), "file");
  } catch {
    t.skip("cannot create a file link in this environment");
    return;
  }
  await writeFile(root, "secret.txt", "s\n");

  // git ignores a symlinked .gitignore; this follows the same rule, which means
  // the exclusions in the link are lost. Pinned so a future change is a choice.
  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes("secret.txt"));
});

test("R10 an ignore file above the workspace applies inside it", async () => {
  const root = await makeRoot("reptclip-r10-");
  await writeFile(root, ".reptclipignore", "*.log\n");
  await writeFile(root, "sub/keep.ts", "k\n");
  await writeFile(root, "sub/noise.log", "n\n");
  const workspace = path.join(root, "sub");

  const files = await collectNonIgnoredFiles(workspace);
  assert.deepEqual(files, ["keep.ts"]);
  assert.equal((await createEmbeddingGuard(workspace)("noise.log")).ok, false);
});

test("R11 a lexical .git path is refused before resolution", async (t) => {
  const root = await makeRoot("reptclip-r11-");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-r11-out-"));
  await fs.mkdir(path.join(outside, ".git"), { recursive: true });
  await fs.writeFile(path.join(outside, ".git", "config"), "[core]\n", "utf8");
  try {
    await fs.symlink(outside, path.join(root, "sub"), "junction");
  } catch {
    t.skip("cannot create a directory link in this environment");
    return;
  }

  // The path names .git, so it must be refused for that reason rather than as a
  // generic "outside the project" link: both layers exist on purpose.
  const verdict = await createEmbeddingGuard(root)("sub/.git/config");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /never embedded/);
});

test("R9 the ignore file itself is listed, like .gitignore", async () => {
  const root = await makeRoot("reptclip-r9-");
  await writeFile(root, ".reptclipignore", "*.log\n");
  await writeFile(root, "a.ts", "a\n");

  const files = await collectNonIgnoredFiles(root);
  assert.ok(files.includes(".reptclipignore"));
  assert.ok(files.includes("a.ts"));
});
