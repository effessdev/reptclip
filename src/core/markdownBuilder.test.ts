import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

(require as any).extensions[".md"] = (module: any, filename: string) => {
  module._compile(
    `module.exports = ${JSON.stringify(readFileSync(filename, "utf8"))};`,
    filename,
  );
};

const { buildMarkdown } =
  require("./markdownBuilder") as typeof import("./markdownBuilder");

test("buildMarkdown omits file sections when includeFiles is false", () => {
  const markdown = buildMarkdown({
    allFiles: ["src/a.ts", "src/b.ts"],
    attachedFiles: ["src/a.ts"],
    fileContents: { "src/a.ts": "const value = 1;" },
    includeStructure: true,
    includeDiffFormat: false,
    includePromptTail: false,
    includeFiles: false,
  });

  assert.ok(markdown.includes("# Project structure"));
  assert.ok(!markdown.includes("# Files"));
  assert.ok(!markdown.includes("## src/a.ts"));
});

test("buildMarkdown includes the enabled sections and omits the disabled ones", () => {
  const markdown = buildMarkdown({
    allFiles: ["src/a.ts", "src/b.ts"],
    attachedFiles: ["src/a.ts"],
    fileContents: { "src/a.ts": "const value = 1;" },
    includeStructure: true,
    includeDiffFormat: true,
    includeFiles: true,
    includePromptTail: true,
  });

  assert.ok(markdown.includes("# Project structure"));
  assert.ok(markdown.includes("# AI instructions"));
  assert.ok(markdown.includes("# Files"));
  assert.ok(markdown.includes("## src/a.ts"));
  assert.ok(markdown.includes("# Prompt"));

  const trimmed = buildMarkdown({
    allFiles: ["src/a.ts"],
    attachedFiles: ["src/a.ts"],
    fileContents: { "src/a.ts": "const value = 1;" },
    includeStructure: false,
    includeDiffFormat: false,
    includeFiles: false,
    includePromptTail: false,
  });

  assert.ok(!trimmed.includes("# Project structure"));
  assert.ok(!trimmed.includes("# AI instructions"));
  assert.ok(!trimmed.includes("# Files"));
  assert.ok(!trimmed.includes("## src/a.ts"));
  assert.ok(!trimmed.includes("# Prompt"));
});

test("buildMarkdown shows a message when no files are attached", () => {
  const markdown = buildMarkdown({
    allFiles: ["src/a.ts"],
    attachedFiles: [],
    fileContents: {},
    includeStructure: false,
    includeDiffFormat: false,
    includeFiles: true,
    includePromptTail: false,
  });

  assert.equal(markdown, "# Files\n\nNo files attached.\n");
});

test("buildMarkdown appends per-file line counts and the explanation when lineCounts is provided", () => {
  const markdown = buildMarkdown({
    allFiles: ["src/a.ts", "src/b.bin"],
    attachedFiles: [],
    fileContents: {},
    includeStructure: true,
    includeDiffFormat: false,
    includeFiles: false,
    includePromptTail: false,
    lineCounts: { "src/a.ts": 42 },
  });

  assert.ok(markdown.includes("src/a.ts (42)"));
  assert.ok(markdown.includes("src/b.bin\n"));
  assert.ok(!markdown.includes("src/b.bin ("));
  assert.ok(markdown.includes("raw line count"));
});

test("buildMarkdown omits line counts and the explanation when lineCounts is not provided", () => {
  const markdown = buildMarkdown({
    allFiles: ["src/a.ts"],
    attachedFiles: [],
    fileContents: {},
    includeStructure: true,
    includeDiffFormat: false,
    includeFiles: false,
    includePromptTail: false,
  });

  assert.ok(markdown.includes("src/a.ts"));
  assert.ok(!markdown.includes("("));
  assert.ok(!markdown.includes("raw line count"));
});
