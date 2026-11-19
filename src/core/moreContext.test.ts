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

const { parseMoreContextCommands, moreContext } =
  require("./moreContext") as typeof import("./moreContext");

test("parseMoreContextCommands parses valid cat command", () => {
  const commands = parseMoreContextCommands("cat src/main.ts");
  assert.deepEqual(commands, [
    { kind: "cat", relPath: "src/main.ts", line: "cat src/main.ts" },
  ]);
});

test("parseMoreContextCommands parses valid grep command", () => {
  const commands = parseMoreContextCommands("grep -n TODO src/");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, "grep");
  const req = (commands[0] as any).request;
  assert.equal(req.pattern, "TODO");
  assert.deepEqual(req.paths, ["src/"]);
  assert.equal(req.lineNumber, true);
});

test("parseMoreContextCommands parses combined short flags", () => {
  const commands = parseMoreContextCommands("grep -rn TODO src/");
  const req = (commands[0] as any).request;
  assert.equal(req.pattern, "TODO");
  assert.equal(req.lineNumber, true);
});

test("parseMoreContextCommands parses value flags", () => {
  const commands = parseMoreContextCommands("grep -m 5 TODO");
  const req = (commands[0] as any).request;
  assert.equal(req.maxCount, 5);
});

test("parseMoreContextCommands parses quoted paths for cat", () => {
  const commands = parseMoreContextCommands('cat "my file.txt"');
  assert.equal((commands[0] as any).relPath, "my file.txt");
});

test("parseMoreContextCommands skips empty lines and exact duplicates", () => {
  const commands = parseMoreContextCommands("cat a.ts\n\n\ncat b.ts\ncat a.ts");
  assert.equal(commands.length, 2);
  assert.equal((commands[0] as any).relPath, "a.ts");
  assert.equal((commands[1] as any).relPath, "b.ts");
});

test("parseMoreContextCommands throws for unknown command", () => {
  assert.throws(
    () => parseMoreContextCommands("ls -la"),
    /unknown command "ls"/,
  );
});

test("parseMoreContextCommands throws for cat with wrong number of args", () => {
  assert.throws(
    () => parseMoreContextCommands("cat"),
    /cat takes exactly one file path/,
  );
  assert.throws(
    () => parseMoreContextCommands("cat a b"),
    /cat takes exactly one file path/,
  );
});

test("parseMoreContextCommands throws for grep with unsupported flags", () => {
  assert.throws(
    () => parseMoreContextCommands("grep -C 3 TODO"),
    /context lines are not supported by grepts yet/,
  );
  assert.throws(
    () => parseMoreContextCommands("grep --no-ignore TODO"),
    /ignored files are never searched/,
  );
});

test("parseMoreContextCommands throws for grep with missing pattern", () => {
  assert.throws(
    () => parseMoreContextCommands("grep"),
    /grep requires a pattern/,
  );
});

test("parseMoreContextCommands handles -- end of flags", () => {
  const commands = parseMoreContextCommands("grep -- -TODO src/");
  assert.equal((commands[0] as any).request.pattern, "-TODO");
});

test("parseMoreContextCommands parses read-lines without end_line", () => {
  const commands = parseMoreContextCommands("read-lines src/main.ts 10");
  assert.deepEqual(commands, [
    {
      kind: "readLines",
      relPath: "src/main.ts",
      startLine: 10,
      endLine: undefined,
      line: "read-lines src/main.ts 10",
    },
  ]);
});

test("parseMoreContextCommands parses read-lines with end_line", () => {
  const commands = parseMoreContextCommands("read-lines src/main.ts 10 20");
  assert.equal(commands.length, 1);
  const cmd = commands[0] as any;
  assert.equal(cmd.kind, "readLines");
  assert.equal(cmd.startLine, 10);
  assert.equal(cmd.endLine, 20);
});

test("parseMoreContextCommands parses quoted paths for read-lines", () => {
  const commands = parseMoreContextCommands('read-lines "my file.txt" 1 5');
  assert.equal((commands[0] as any).relPath, "my file.txt");
});

test("parseMoreContextCommands throws for read-lines with wrong number of args", () => {
  assert.throws(
    () => parseMoreContextCommands("read-lines src/main.ts"),
    /read-lines requires <file_path> <start_line> \[end_line\]/,
  );
  assert.throws(
    () => parseMoreContextCommands("read-lines src/main.ts 1 2 3"),
    /read-lines requires <file_path> <start_line> \[end_line\]/,
  );
});

test("parseMoreContextCommands throws for read-lines with non-positive start_line", () => {
  assert.throws(
    () => parseMoreContextCommands("read-lines src/main.ts 0"),
    /start_line expects a positive integer/,
  );
  assert.throws(
    () => parseMoreContextCommands("read-lines src/main.ts -1"),
    /start_line expects a positive integer/,
  );
});

test("parseMoreContextCommands throws for read-lines with end_line below start_line", () => {
  assert.throws(
    () => parseMoreContextCommands("read-lines src/main.ts 10 5"),
    /end_line must be >= start_line/,
  );
});

test("moreContext runs valid cat command and returns markdown", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-morecat-"));
  const filePath = path.join(rootDir, "example.ts");
  await fs.writeFile(filePath, "console.log('hello');\n", "utf8");

  const result = await moreContext(rootDir, "cat example.ts");
  assert.equal(result.commandCount, 1);
  assert.deepEqual(result.includedFiles, ["example.ts"]);
  assert.ok(result.markdown.startsWith("# Files\n\n"));
  assert.ok(result.markdown.includes("## example.ts"));
  assert.ok(result.markdown.includes("console.log('hello');"));
});

test("moreContext runs valid grep command and returns markdown", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-moregrep-"),
  );
  const filePath = path.join(rootDir, "example.ts");
  await fs.writeFile(
    filePath,
    "console.log('hello');\n// TODO: fix this\n",
    "utf8",
  );

  const result = await moreContext(rootDir, "grep TODO example.ts");
  assert.equal(result.commandCount, 1);
  assert.ok(result.markdown.startsWith("# Files\n\n"));
  assert.ok(result.markdown.includes("## grep TODO example.ts"));
  assert.ok(result.markdown.includes("TODO: fix this"));
});

test("moreContext runs read-lines command and returns the requested range", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morereadlines-"),
  );
  const filePath = path.join(rootDir, "example.ts");
  await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n", "utf8");

  const result = await moreContext(rootDir, "read-lines example.ts 2 4");
  assert.equal(result.commandCount, 1);
  assert.deepEqual(result.includedFiles, ["example.ts"]);
  assert.ok(result.markdown.includes("## read-lines example.ts 2 4"));
  assert.ok(result.markdown.includes("line2\nline3\nline4"));
  assert.ok(!result.markdown.includes("line1"));
  assert.ok(!result.markdown.includes("line5"));
});

test("moreContext clamps end_line past the end of the file", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morereadclamp-"),
  );
  const filePath = path.join(rootDir, "example.ts");
  await fs.writeFile(filePath, "line1\nline2\nline3\n", "utf8");

  const result = await moreContext(rootDir, "read-lines example.ts 2 100");
  assert.ok(result.markdown.includes("line2\nline3"));
  assert.ok(!result.markdown.includes("line1"));
});

test("moreContext reads to the end of the file when end_line is omitted", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morereadnoend-"),
  );
  const filePath = path.join(rootDir, "example.ts");
  await fs.writeFile(filePath, "line1\nline2\nline3\n", "utf8");

  const result = await moreContext(rootDir, "read-lines example.ts 2");
  assert.ok(result.markdown.includes("line2\nline3"));
  assert.ok(!result.markdown.includes("line1"));
});

test("moreContext throws when path is ignored by .gitignore", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-moreignore-"),
  );
  await fs.writeFile(path.join(rootDir, ".gitignore"), "secret.txt\n", "utf8");
  await fs.writeFile(path.join(rootDir, "secret.txt"), "top secret\n", "utf8");

  await assert.rejects(
    () => moreContext(rootDir, "cat secret.txt"),
    /Cannot run commands: secret\.txt/,
  );
});

test("moreContext throws when cat path is absolute", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-moreabs-"));
  await fs.writeFile(path.join(rootDir, "example.ts"), "content\n", "utf8");

  await assert.rejects(
    () => moreContext(rootDir, `cat ${path.join(rootDir, "example.ts")}`),
    /Cannot run commands: .*absolute path/,
  );
});

test("moreContext throws when cat path escapes root", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-moreesc-"));

  await assert.rejects(
    () => moreContext(rootDir, "cat ../outside.ts"),
    /Cannot run commands: \.\.\/outside\.ts \(resolves outside the project root\)/,
  );
});

test("moreContext throws when cat path does not exist", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morenofind-"),
  );

  await assert.rejects(
    () => moreContext(rootDir, "cat missing.ts"),
    /Cannot run commands: missing\.ts \(not found\)/,
  );
});

test("moreContext throws when cat path is a directory", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-moredir-"));
  await fs.mkdir(path.join(rootDir, "my-dir"), { recursive: true });

  await assert.rejects(
    () => moreContext(rootDir, "cat my-dir"),
    /Cannot run commands: my-dir \(not a file\)/,
  );
});

test("moreContext throws when grep path does not exist", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-moregrep-no-"),
  );

  await assert.rejects(
    () => moreContext(rootDir, "grep TODO missing-dir/"),
    /Cannot run commands: missing-dir\/ \(not found\)/,
  );
});

test("moreContext throws when read-lines start_line exceeds the file's line count", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morereadover-"),
  );
  const filePath = path.join(rootDir, "example.ts");
  await fs.writeFile(filePath, "line1\nline2\n", "utf8");

  await assert.rejects(
    () => moreContext(rootDir, "read-lines example.ts 10"),
    /Cannot run commands: example\.ts \(start_line 10 exceeds file's line count of 2\)/,
  );
});

test("moreContext throws when grep pattern is invalid", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morebadpattern-"),
  );
  await fs.writeFile(path.join(rootDir, "example.ts"), "content\n", "utf8");

  await assert.rejects(
    () => moreContext(rootDir, "grep -e '[invalid' example.ts"),
    /Invalid grep pattern/,
  );
});

test("moreContext throws on empty clipboard", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-moreempty-"),
  );

  await assert.rejects(
    () => moreContext(rootDir, "   \n\n"),
    /No cat\/grep commands found in the clipboard\./,
  );
});

test("moreContext reads oversized file and returns placeholder", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morelarge-"),
  );
  const filePath = path.join(rootDir, "large.ts");
  const largeContent = "a".repeat(1024 * 1024 + 100);
  await fs.writeFile(filePath, largeContent, "utf8");

  const result = await moreContext(rootDir, "cat large.ts");
  assert.ok(result.markdown.includes("File skipped: exceeds 1 MB"));
});

test("moreContext returns a placeholder for read-lines on an oversized file", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morereadlarge-"),
  );
  const filePath = path.join(rootDir, "large.ts");
  const largeContent = "a".repeat(1024 * 1024 + 100);
  await fs.writeFile(filePath, largeContent, "utf8");

  const result = await moreContext(rootDir, "read-lines large.ts 1 5");
  assert.ok(result.markdown.includes("File skipped: exceeds 1 MB"));
});

test("moreContext reads binary file and returns placeholder", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reptclip-morebin-"));
  const filePath = path.join(rootDir, "binary.bin");
  await fs.writeFile(filePath, Buffer.from([0x00, 0x01, 0x02]), "utf8");

  const result = await moreContext(rootDir, "cat binary.bin");
  assert.ok(result.markdown.includes("File skipped: appears to be binary."));
});

test("moreContext grows fence length when file contains backticks", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-morefence-"),
  );
  const filePath = path.join(rootDir, "ticks.ts");
  await fs.writeFile(filePath, "```code\n```````", "utf8");

  const result = await moreContext(rootDir, "cat ticks.ts");
  assert.ok(result.markdown.includes("````````"));
  assert.ok(result.markdown.includes("## ticks.ts"));
});

test("moreContext drops grep matches containing NUL bytes", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reptclip-moregrep-bin-"),
  );
  const filePath = path.join(rootDir, "binary.ts");
  await fs.writeFile(filePath, Buffer.from("TODO\x00binary\n", "utf8"), "utf8");

  const result = await moreContext(rootDir, "grep TODO binary.ts");
  assert.ok(result.markdown.includes("(no matches)"));
});
