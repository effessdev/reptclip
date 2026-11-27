import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";

/**
 * Transaction-boundary tests for the panel. They drive the real message
 * handler with a fake editor host, so "two Apply clicks" and "Apply then Undo"
 * are exercised as overlapping async handlers — the case where an edit used to
 * vanish while both operations reported success.
 */

const clipboardQueue: string[] = [];
const events: string[] = [];
const posts: any[] = [];
let handler: ((message: any) => Promise<void>) | undefined;
const store = new Map<string, unknown>();

const originalLoad = (Module as any)._load;
const fakeVscode: any = {
  Uri: {
    file: (fsPath: string) => ({ fsPath, path: fsPath }),
    joinPath: (base: any, ...parts: string[]) => ({
      fsPath: path.join(base.fsPath, ...parts),
    }),
  },
  RelativePattern: class {
    constructor(
      public base: any,
      public pattern: string,
    ) {}
  },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Range: class {
    start: any;
    end: any;
    constructor(a: number, b: number, c: number, d: number) {
      this.start = { line: a, character: b };
      this.end = { line: c, character: d };
    }
  },
  WorkspaceEdit: class {
    operations: any[] = [];
    deleteFile(uri: any) {
      this.operations.push(["deleteFile", uri]);
    }
    createFile(uri: any) {
      this.operations.push(["createFile", uri]);
    }
    insert(uri: any, position: unknown, text: string) {
      this.operations.push(["insert", uri, position, text]);
    }
    replace(uri: any, range: unknown, text: string) {
      this.operations.push(["replace", uri, text]);
    }
  },
  workspace: {
    workspaceFolders: [] as any[],
    textDocuments: [] as any[],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({ get: (_k: string, fallback: unknown) => fallback }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    async applyEdit(edit: { operations: any[] }) {
      events.push("edit");
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
    activeTextEditor: undefined,
    async showTextDocument() {
      return undefined;
    },
    async showWarningMessage(message: string) {
      posts.push({ type: "warning", message });
      return undefined; // every modal is dismissed by default in these tests
    },
  },
  env: {
    clipboard: {
      async readText() {
        events.push("clipboard");
        return clipboardQueue.shift() ?? "";
      },
      async writeText() {
        return undefined;
      },
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

// The panel pulls in markdownBuilder, which imports ai-instructions.md as text
// (esbuild does that at build time; here the loader is registered by hand).
(require as any).extensions[".md"] = (module: any, filename: string) => {
  const source = require("node:fs").readFileSync(filename, "utf8");
  module._compile(`module.exports = ${JSON.stringify(source)};`, filename);
};

const { ReptclipViewProvider } =
  require("./ReptclipViewProvider") as typeof import("./ReptclipViewProvider");

const context = {
  globalState: {
    get: (key: string, fallback: unknown) =>
      store.has(key) ? store.get(key) : fallback,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  },
  subscriptions: [],
};

const block = (file: string, search: string, replace: string) =>
  [file, "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join(
    "\n",
  );

function mount(rootDir: string): void {
  clipboardQueue.length = 0;
  events.length = 0;
  posts.length = 0;
  handler = undefined;
  fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: rootDir } }];

  const provider = new ReptclipViewProvider(
    { fsPath: path.join(rootDir, "extension") } as any,
    context as any,
  );
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: any) => uri,
      postMessage: async (message: any) => {
        posts.push(message);
        return true;
      },
      onDidReceiveMessage: (fn: any) => {
        handler = fn;
        return { dispose: () => undefined };
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  provider.resolveWebviewView(view as any);
}

async function makeRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("an Apply queued behind another reads the file after the first write", async () => {
  const root = await makeRoot("reptclip-scope-apply-");
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "one\ntwo\n", "utf8");

  mount(root);
  // The second click carries a diff that was valid a moment ago; once the
  // first click rewrote that line it must not match the stale copy.
  clipboardQueue.push(
    block("a.txt", "one", "ONE"),
    block("a.txt", "one", "ONE AGAIN"),
  );

  await Promise.all([
    handler!({ type: "applyDiffs" }),
    handler!({ type: "applyDiffs" }),
  ]);

  assert.equal(await fs.readFile(file, "utf8"), "ONE\ntwo\n");
  const results = posts.filter((post) => post.type === "applyResult");
  assert.equal(results.length, 2);
  assert.equal(results.filter((post) => post.ok).length, 1, JSON.stringify(results));
  const rejected = results.find((post) => !post.ok);
  assert.match(rejected.error, /no match/i);
});

test("an Undo queued behind an Apply sees that Apply's checkpoint", async () => {
  const root = await makeRoot("reptclip-scope-undo-");
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "one\n", "utf8");

  mount(root);
  clipboardQueue.push(block("a.txt", "one", "ONE"));

  await Promise.all([
    handler!({ type: "applyDiffs" }),
    handler!({ type: "undo" }),
  ]);

  assert.equal(await fs.readFile(file, "utf8"), "one\n");
  const undo = posts.find((post) => post.type === "undoResult");
  assert.ok(undo, "undo result missing");
  assert.equal(undo.ok, true, JSON.stringify(undo));
});

test("saved state stays keyed by the workspace path as opened", async () => {
  // A folder whose spelling has uppercase letters is the regression case: a
  // canonicalised key would be a different string, so the settings saved by an
  // earlier version would never be found again.
  const root = await makeRoot("Reptclip-State-");
  store.clear();
  mount(root);

  await handler!({
    type: "stateChanged",
    state: { pattern: "*.ts", gitignore: true, diffFormat: true },
  });

  const saved = store.get("reptclip.projectStates") as
    | Record<string, unknown>
    | undefined;
  assert.deepEqual(Object.keys(saved ?? {}), [root]);
});

test("an apply through a linked workspace still matches the dirty buffer", async (t) => {
  const real = await makeRoot("reptclip-link-real-");
  const holder = await makeRoot("reptclip-link-holder-");
  const link = path.join(holder, "project");
  try {
    await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this environment cannot create a directory link");
    return;
  }
  t.after(async () => {
    await fs.rmdir(link).catch(() => undefined);
    await fs.rm(holder, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(real, { recursive: true, force: true }).catch(() => undefined);
  });

  await fs.writeFile(path.join(real, "a.txt"), "one\ntwo\n", "utf8");
  mount(link);

  // The user has the file open through the link, with an unsaved line that is
  // not on disk. The diff only matches that unsaved text.
  const bufferPath = path.join(link, "a.txt");
  fakeVscode.workspace.textDocuments = [
    {
      uri: {
        scheme: "file",
        fsPath: bufferPath,
        toString: () => `file://${bufferPath.replace(/\\/g, "/")}`,
      },
      isDirty: true,
      version: 2,
      getText: () => "two\n",
    },
  ];

  clipboardQueue.push(block("a.txt", "two", "TWO"));
  await handler!({ type: "applyDiffs" });

  const result = posts.find((post) => post.type === "applyResult");
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(real, "a.txt"), "utf8"), "TWO\n");
  fakeVscode.workspace.textDocuments = [];
});

test("both clicks read the clipboard before the first edit", async () => {
  const root = await makeRoot("reptclip-clip-order-");
  await fs.writeFile(path.join(root, "a.txt"), "one\n", "utf8");

  mount(root);
  // The second diff does not match anything; it only has to get its own
  // clipboard entry while the first click is still queued, not after it wrote.
  clipboardQueue.push(block("a.txt", "one", "ONE"), block("a.txt", "missing", "x"));

  await Promise.all([
    handler!({ type: "applyDiffs" }),
    handler!({ type: "applyDiffs" }),
  ]);

  assert.deepEqual(events.slice(0, 2), ["clipboard", "clipboard"], events.join(" | "));
});
