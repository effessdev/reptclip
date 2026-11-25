import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";

/**
 * `generateContext` imports `ai-instructions.md`, which only esbuild can load,
 * so it cannot be required directly under `tsx`. Bundling it here is the only
 * way to test the real entry point — and it is the entry point the "Context"
 * button uses, so it should not be untested.
 */
async function loadGenerateContext(): Promise<{
  generateContext: (
    root: string,
    state: unknown,
    showLineCounts?: boolean,
  ) => Promise<{ markdown: string; allFiles: string[]; attachedFiles: string[] }>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-gen-bundle-"));
  const outfile = path.join(dir, "generateContext.cjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "generateContext.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    loader: { ".md": "text" },
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

test("generateContext lists every file, counts its lines and embeds the content", async () => {
  const { generateContext } = await loadGenerateContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-gen-tree-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.mkdir(path.join(root, "src"), { recursive: true });

  const expected: Array<[string, string, number]> = [];
  for (let index = 0; index < 40; index += 1) {
    const name = `f${index}.txt`;
    // One line per file index, so a line count read from the wrong file shows.
    const lines = Array.from({ length: index + 1 }, (_, line) => `row ${line} of ${name}`);
    const content = `${lines.join("\n")}\n`;
    await fs.writeFile(path.join(root, "src", name), content, "utf8");
    expected.push([`src/${name}`, content, index + 1]);
  }

  const result = await generateContext(
    root,
    {
      attach: "src/**/*.txt",
      exclude: "",
      files: true,
      projectStructure: true,
      diffFormat: false,
      promptTail: false,
    },
    true,
  );

  assert.equal(result.allFiles.length, expected.length);
  assert.equal(result.attachedFiles.length, expected.length);

  for (const [relPath, content, lineCount] of expected) {
    assert.ok(
      result.markdown.includes(content.split("\n")[0]),
      `content of ${relPath} missing`,
    );
    assert.ok(
      result.markdown.includes(`${relPath} (${lineCount})`),
      `line count for ${relPath} missing`,
    );
  }

  await fs.rm(root, { recursive: true, force: true });
});

test("generateContext does not depend on the order files are read in", async () => {
  const { generateContext } = await loadGenerateContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-gen-order-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    await fs.writeFile(path.join(root, name), `content-${name}\n`, "utf8");
  }

  const state = {
    attach: "*.txt",
    exclude: "",
    files: true,
    projectStructure: false,
    diffFormat: false,
    promptTail: false,
  };

  const first = await generateContext(root, state, false);
  const second = await generateContext(root, state, false);
  assert.equal(first.markdown, second.markdown);
  assert.deepEqual(first.attachedFiles, ["a.txt", "b.txt", "c.txt", "d.txt"]);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    assert.ok(first.markdown.includes(`content-${name}`), name);
  }

  await fs.rm(root, { recursive: true, force: true });
});
