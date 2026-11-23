import * as path from "path";
import * as fs from "fs/promises";
import { createEmbeddingGuard } from "./gitignoreScanner";
import { countFileLines, isUtf8TextFile, readFileSafe } from "./fileGuards";
import { fencedSection } from "./fence";
import { tokenize } from "./tokenizer";
import { estimateTokens } from "./tokenEstimator";
import { GenerateResult } from "./types";

/**
 * "More Context": the clipboard holds commands, one per line.
 * `cat <path>` embeds a file through the same guard/read pipeline as
 * "Context"; `grep <flags> <pattern> [paths...]` searches the project with
 * grepts (in-process, no subprocess); `read-lines <path> <start_line>
 * [end_line]` embeds a 1-indexed, inclusive slice of a file through that
 * same pipeline, clamping `end_line` to the file's last line (or defaulting
 * it to the last line when omitted). Each command becomes one Markdown
 * section headed by the file path (cat) or the command line itself (grep,
 * read-lines).
 */

// -----------------------------------------------------------------------------
// 1. Public types
// -----------------------------------------------------------------------------

export type MoreContextCommand =
  | { kind: "cat"; relPath: string; line: string }
  | { kind: "grep"; request: GrepRequest; line: string }
  | {
      kind: "readLines";
      relPath: string;
      startLine: number;
      endLine?: number;
      line: string;
    };

/**
 * Catastrophic-backtracking shapes: a quantified group whose body already
 * contains a quantifier (`(a+)+`, `(a*b)*`, `(a?)+`). grepts runs a JS RegExp
 * in-process, so one such pattern freezes the editor with no way to interrupt
 * it. Catching these turns a hang into a clear error; a creative pattern can
 * still be slow, which is why `-F` is offered.
 *
 * A hand-written scan, not a regex: the obvious regex
 * (`/\((\\.|[^()])*[*+?{](\\.|[^()])*\)[+*{]/`) has two overlapping
 * alternatives, so a run of backslashes inside parentheses makes the *check*
 * itself backtrack exponentially — the guard would hang on the input it is
 * meant to reject. This walk is linear in the pattern length.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  /** Does the body of each open group contain a quantifier? */
  const groups: boolean[] = [];

  /** End index of a quantifier starting at `index`, or -1 when there is none. */
  const quantifierEnd = (index: number): number => {
    const ch = pattern[index];
    if (ch === "*" || ch === "+" || ch === "?") {
      // A trailing `?` makes the quantifier lazy; it is not one more quantifier.
      return pattern[index + 1] === "?" ? index + 2 : index + 1;
    }
    if (ch === "{") {
      const bounded = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(index));
      return bounded ? index + bounded[0].length : -1;
    }
    return -1;
  };

  /** Index of the first character of the group body, after any `(?…)` prefix. */
  const bodyStart = (open: number): number => {
    if (pattern[open + 1] !== "?") {
      return open + 1;
    }
    const kind = pattern[open + 2];
    if (kind === ":" || kind === "=" || kind === "!") {
      return open + 3;
    }
    if (kind === "<") {
      const inner = pattern[open + 3];
      if (inner === "=" || inner === "!") {
        return open + 4;
      }
      const close = pattern.indexOf(">", open + 3);
      return close === -1 ? open + 3 : close + 1;
    }
    return open + 2;
  };

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      // A quantifier inside a character class is a literal.
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        i += pattern[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (ch === "(") {
      groups.push(false);
      i = bodyStart(i);
      continue;
    }
    if (ch === ")") {
      const bodyHadQuantifier = groups.pop() ?? false;
      i += 1;
      const repeated = quantifierEnd(i);
      if (repeated !== -1) {
        if (bodyHadQuantifier) {
          return true;
        }
        i = repeated;
        if (groups.length > 0) {
          groups[groups.length - 1] = true;
        }
      }
      continue;
    }
    const end = quantifierEnd(i);
    if (end !== -1) {
      i = end;
      if (groups.length > 0) {
        groups[groups.length - 1] = true;
      }
      continue;
    }
    i += 1;
  }

  return false;
}

/** The grep flags we support, mapped 1:1 onto grepts' SearchOptions. */
export interface GrepRequest {
  pattern: string;
  paths: string[];
  ignoreCase: boolean;
  lineNumber: boolean;
  count: boolean;
  filesWithMatches: boolean;
  filesWithoutMatch: boolean;
  wordRegexp: boolean;
  fixedStrings: boolean;
  glob?: string;
  hidden: boolean;
  maxDepth?: number;
  maxCount?: number;
  invertMatch: boolean;
  multiline: boolean;
}

export interface MoreContextResult extends GenerateResult {
  /** Number of commands executed (cat + grep + read-lines), for status reporting. */
  commandCount: number;
  /** Number of grep searches executed, for status reporting. */
  searchCount: number;
  /** Total number of search results returned across all grep commands. */
  searchResultCount: number;
}

// -----------------------------------------------------------------------------
// 2. Grep flag definitions
// -----------------------------------------------------------------------------

const SHORT_BOOLEAN: Record<string, string | undefined> = {
  i: "ignore-case",
  n: "line-number",
  N: "no-line-number",
  c: "count",
  l: "files-with-matches",
  w: "word-regexp",
  F: "fixed-strings",
  v: "invert-match",
  U: "multiline",
  r: "recursive",
  R: "recursive",
  E: "extended-regexp",
};

const SHORT_VALUE: Record<string, string | undefined> = {
  g: "glob",
  m: "max-count",
  e: "regexp",
};

const SHORT_UNSUPPORTED: Record<string, string | undefined> = {
  C: "context lines are not supported by grepts yet",
  A: "context lines are not supported by grepts yet",
  B: "context lines are not supported by grepts yet",
  q: "quiet mode produces no output",
};

const LONG_BOOLEAN = new Set([
  "ignore-case",
  "line-number",
  "no-line-number",
  "count",
  "files-with-matches",
  "files-without-match",
  "word-regexp",
  "fixed-strings",
  "hidden",
  "invert-match",
  "multiline",
  "recursive",
  "extended-regexp",
  "color",
  "no-color",
]);

const LONG_VALUE = new Set(["glob", "max-count", "max-depth", "regexp"]);

const LONG_UNSUPPORTED: Record<string, string | undefined> = {
  "no-ignore": "ignored files are never searched",
  context: "context lines are not supported by grepts yet",
  "before-context": "context lines are not supported by grepts yet",
  "after-context": "context lines are not supported by grepts yet",
  quiet: "quiet mode produces no output",
};

// -----------------------------------------------------------------------------
// 3. Command parsing
// -----------------------------------------------------------------------------

/**
 * Splits clipboard text into commands, one per line: blank lines skipped,
 * exact duplicate lines collapsed, order preserved. Every malformed line is
 * reported with its line number before anything runs.
 */
export function parseMoreContextCommands(text: string): MoreContextCommand[] {
  const commands: MoreContextCommand[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    try {
      commands.push(parseCommand(line));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`line ${i + 1} (${line}): ${reason}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid commands: ${errors.join("; ")}`);
  }
  return commands;
}

function parseCommand(line: string): MoreContextCommand {
  const tokens = tokenize(line);
  if (tokens.length === 0) {
    throw new Error("empty command");
  }
  const [command, ...args] = tokens;
  if (command === "cat") {
    if (args.length !== 1) {
      throw new Error(
        "cat takes exactly one file path (quote paths containing spaces)",
      );
    }
    return { kind: "cat", relPath: args[0], line };
  }
  if (command === "grep") {
    return { kind: "grep", request: parseGrepArgs(args), line };
  }
  if (command === "read-lines") {
    return { kind: "readLines", ...parseReadLinesArgs(args), line };
  }
  throw new Error(
    `unknown command "${command}"; expected cat, grep, or read-lines`,
  );
}

function parsePositiveInt(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${label} expects a positive integer`);
  }
  return Number(value);
}

/**
 * Parses `read-lines <file_path> <start_line> [end_line]`. Both line
 * numbers are 1-indexed; `end_line`, when given, must be >= `start_line`.
 * Whether `start_line` itself is in range depends on the file, so that
 * check happens later, during validation.
 */
function parseReadLinesArgs(args: string[]): {
  relPath: string;
  startLine: number;
  endLine?: number;
} {
  if (args.length !== 2 && args.length !== 3) {
    throw new Error("read-lines requires <file_path> <start_line> [end_line]");
  }
  const [relPath, startLineRaw, endLineRaw] = args;
  const startLine = parsePositiveInt(startLineRaw, "start_line");
  if (endLineRaw === undefined) {
    return { relPath, startLine, endLine: undefined };
  }
  const endLine = parsePositiveInt(endLineRaw, "end_line");
  if (endLine < startLine) {
    throw new Error("end_line must be >= start_line");
  }
  return { relPath, startLine, endLine };
}

/**
 * Maps grep-style flags onto a GrepRequest. The search itself is grepts';
 * this is only the command-line glue. `-r`/`-R`/`-E`/`--color`/`--no-color`
 * are accepted as no-ops (grepts is always recursive, output is never
 * colored); context flags and --no-ignore are refused explicitly.
 */
function parseGrepArgs(args: string[]): GrepRequest {
  const request: GrepRequest = {
    pattern: "",
    paths: [],
    ignoreCase: false,
    lineNumber: true,
    count: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    wordRegexp: false,
    fixedStrings: false,
    hidden: false,
    invertMatch: false,
    multiline: false,
  };
  const positionals: string[] = [];
  let patternFromFlag = false;
  let endOfFlags = false;

  const applyBoolean = (name: string, label: string): void => {
    switch (name) {
      case "ignore-case":
        request.ignoreCase = true;
        return;
      case "line-number":
        request.lineNumber = true;
        return;
      case "no-line-number":
        request.lineNumber = false;
        return;
      case "count":
        request.count = true;
        return;
      case "files-with-matches":
        request.filesWithMatches = true;
        return;
      case "files-without-match":
        request.filesWithoutMatch = true;
        return;
      case "word-regexp":
        request.wordRegexp = true;
        return;
      case "fixed-strings":
        request.fixedStrings = true;
        return;
      case "hidden":
        request.hidden = true;
        return;
      case "invert-match":
        request.invertMatch = true;
        return;
      case "multiline":
        request.multiline = true;
        return;
      case "recursive":
      case "extended-regexp":
      case "color":
      case "no-color":
        return;
      default:
        throw new Error(`unsupported flag "${label}"`);
    }
  };

  const applyValue = (
    name: string,
    label: string,
    value: string | undefined,
  ): void => {
    if (value === undefined || value === "") {
      throw new Error(`${label} requires a value`);
    }
    switch (name) {
      case "glob":
        request.glob = value;
        return;
      case "max-count":
        request.maxCount = parsePositiveInt(value, label);
        return;
      case "max-depth":
        request.maxDepth = parsePositiveInt(value, label);
        return;
      case "regexp":
        if (patternFromFlag) {
          throw new Error("only one -e/--regexp pattern is supported");
        }
        request.pattern = value;
        patternFromFlag = true;
        return;
      default:
        throw new Error(`unsupported flag "${label}"`);
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOfFlags || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      if (LONG_BOOLEAN.has(name)) {
        if (inline !== undefined) {
          throw new Error(`--${name} does not take a value`);
        }
        applyBoolean(name, `--${name}`);
      } else if (LONG_VALUE.has(name)) {
        applyValue(name, `--${name}`, inline ?? args[++i]);
      } else {
        const reason = LONG_UNSUPPORTED[name];
        throw new Error(
          reason
            ? `unsupported flag "--${name}": ${reason}`
            : `unsupported flag "--${name}"`,
        );
      }
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      const booleanName = SHORT_BOOLEAN[ch];
      if (booleanName !== undefined) {
        applyBoolean(booleanName, `-${ch}`);
        continue;
      }
      const valueName = SHORT_VALUE[ch];
      if (valueName !== undefined) {
        const inline = j + 1 < arg.length ? arg.slice(j + 1) : undefined;
        applyValue(valueName, `-${ch}`, inline ?? args[++i]);
        break;
      }
      const reason = SHORT_UNSUPPORTED[ch];
      throw new Error(
        reason
          ? `unsupported flag "-${ch}": ${reason}`
          : `unsupported flag "-${ch}"`,
      );
    }
  }

  if (patternFromFlag) {
    request.paths = positionals;
  } else {
    if (positionals.length === 0) {
      throw new Error("grep requires a pattern");
    }
    request.pattern = positionals[0];
    request.paths = positionals.slice(1);
  }
  if (!request.pattern) {
    throw new Error("grep requires a non-empty pattern");
  }
  if (!request.fixedStrings && hasNestedQuantifier(request.pattern)) {
    throw new Error(
      `pattern ${JSON.stringify(request.pattern)} has nested quantifiers, which ` +
        "can freeze the editor; simplify it or pass -F for a literal search",
    );
  }
  return request;
}

// -----------------------------------------------------------------------------
// 4. Command validation
// -----------------------------------------------------------------------------

type ValidatedCommand =
  | { kind: "cat"; relPath: string; absPath: string; line: string }
  | { kind: "grep"; request: GrepRequest; absPaths: string[]; line: string }
  | {
      kind: "readLines";
      relPath: string;
      absPath: string;
      startLine: number;
      endLine?: number;
      line: string;
    };

/**
 * Pre-flight, all-or-nothing: every cat path must clear the embedding guard
 * and be a real file; every grep path must clear the guard and be a file or
 * directory ("." means the project root). Nothing is read or searched until
 * the whole list passes.
 */
async function validateCommands(
  rootDir: string,
  commands: MoreContextCommand[],
): Promise<ValidatedCommand[]> {
  const guard = createEmbeddingGuard(rootDir);
  const rejected: string[] = [];
  const validated: ValidatedCommand[] = [];

  for (const command of commands) {
    if (command.kind === "grep") {
      const absPaths = await validateSearchPaths(
        rootDir,
        command.request.paths,
        guard,
        rejected,
      );
      if (absPaths !== undefined) {
        validated.push({
          kind: "grep",
          request: command.request,
          absPaths,
          line: command.line,
        });
      }
      continue;
    }

    const absPath = await validateFilePath(
      rootDir,
      command.relPath,
      guard,
      rejected,
    );
    if (absPath === undefined) continue;

    if (command.kind === "cat") {
      validated.push({ ...command, absPath });
      continue;
    }

    const totalLines = await countFileLines(absPath);
    if (totalLines !== undefined && command.startLine > totalLines) {
      rejected.push(
        `${command.relPath} (start_line ${command.startLine} exceeds file's line count of ${totalLines})`,
      );
      continue;
    }
    validated.push({ ...command, absPath });
  }

  if (rejected.length > 0) {
    throw new Error(`Cannot run commands: ${rejected.join(", ")}`);
  }
  return validated;
}

/** Validate a path that must resolve to an embeddable regular file. */
async function validateFilePath(
  rootDir: string,
  relPath: string,
  guard: EmbeddingGuard,
  rejected: string[],
): Promise<string | undefined> {
  const verdict = await guard(relPath);
  if (!verdict.ok) {
    rejected.push(`${relPath} (${verdict.reason ?? "cannot be embedded"})`);
    return undefined;
  }

  const absPath = verdict.absPath ?? path.join(rootDir, relPath);
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      rejected.push(`${relPath} (not a file)`);
      return undefined;
    }
  } catch {
    rejected.push(`${relPath} (not found)`);
    return undefined;
  }
  return absPath;
}

/** Validate grep targets; an omitted path (or ".") means the project root. */
async function validateSearchPaths(
  rootDir: string,
  requestedPaths: string[],
  guard: EmbeddingGuard,
  rejected: string[],
): Promise<string[] | undefined> {
  const relPaths = requestedPaths.length > 0 ? requestedPaths : ["."];
  const absPaths: string[] = [];
  let valid = true;

  for (const relPath of relPaths) {
    if (relPath === "." || relPath === "./") {
      absPaths.push(rootDir);
      continue;
    }

    const verdict = await guard(relPath);
    if (!verdict.ok) {
      rejected.push(`${relPath} (${verdict.reason ?? "cannot be searched"})`);
      valid = false;
      continue;
    }

    const absPath = verdict.absPath ?? path.join(rootDir, relPath);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        rejected.push(`${relPath} (not a file or directory)`);
        valid = false;
        continue;
      }
    } catch {
      rejected.push(`${relPath} (not found)`);
      valid = false;
      continue;
    }
    absPaths.push(absPath);
  }

  return valid ? absPaths : undefined;
}

// -----------------------------------------------------------------------------
// 5. Grep execution
// -----------------------------------------------------------------------------

type GreptsModule = typeof import("grepts");
type EmbeddingGuard = ReturnType<typeof createEmbeddingGuard>;

/**
 * Runs one grep via grepts. The sync `search()` is deliberate: `searchAsync`
 * spawns a worker pool whose script path is resolved relative to grepts'
 * own module URL, which does not survive esbuild bundling. Safety: grepts
 * lets explicitly passed file paths bypass .gitignore, so every result is
 * re-checked through the embedding guard before any line is embedded, and
 * NUL-containing (binary) matches are dropped.
 */
async function runGrep(
  rootDir: string,
  request: GrepRequest,
  absPaths: string[],
  guard: EmbeddingGuard,
): Promise<{ output: string; resultCount: number }> {
  const grepts: GreptsModule = await import("grepts");
  const options = grepts.searchOptionsSchema.parse({
    ...request,
    paths: absPaths,
    respectGitignore: true,
    color: false,
    quiet: false,
  });
  let regex: RegExp;
  try {
    regex = grepts.buildRegex(options);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid grep pattern ${JSON.stringify(request.pattern)}: ${reason}`,
    );
  }
  const results = grepts.search(options);
  const lines: string[] = [];
  let resultCount = 0;
  // grepts decodes files as UTF-8 without validation, so a legacy-encoded file
  // would come back as mojibake even though `cat` skips it. Apply the same
  // text check the context pipeline uses, once per matched file.
  const textFiles = new Map<string, boolean>();
  for (const result of results) {
    const relPath = path
      .relative(rootDir, result.filePath)
      .split(/[\\/]+/)
      .join("/");
    const verdict = await guard(relPath);
    if (!verdict.ok) {
      continue;
    }
    let isText = textFiles.get(result.filePath);
    if (isText === undefined) {
      isText = await isUtf8TextFile(result.filePath);
      textFiles.set(result.filePath, isText);
    }
    if (!isText) {
      continue;
    }
    if (result.matches.some((match) => match.line.includes("\0"))) {
      continue;
    }
    const formatted = grepts.formatResult(
      { ...result, filePath: relPath },
      options,
      regex,
      true,
    );
    if (formatted) {
      lines.push(formatted);
      resultCount += options.count
        ? result.matchCount
        : options.filesWithMatches || options.filesWithoutMatch
          ? 1
          : result.matchCount;
    }
  }
  return {
    output: lines.length > 0 ? lines.join("\n") : "(no matches)",
    resultCount,
  };
}

/**
 * Slices a 1-indexed, inclusive line range out of a file's content. Line
 * counting matches `countFileLines`: a trailing newline does not count as
 * an extra blank line. `endLine` is clamped to the file's last line (or
 * defaults to it when omitted), so a range that runs past the end of the
 * file simply stops there.
 */
// -----------------------------------------------------------------------------
// 6. Output formatting and file-reading helpers
// -----------------------------------------------------------------------------

function sliceLines(
  content: string,
  startLine: number,
  endLine: number | undefined,
): string {
  const lines = content.split(/\r\n|\r|\n/);
  if (
    lines.length > 0 &&
    lines[lines.length - 1] === "" &&
    /(?:\r\n|\r|\n)$/.test(content)
  ) {
    lines.pop();
  }
  const end =
    endLine === undefined ? lines.length : Math.min(endLine, lines.length);
  return lines.slice(startLine - 1, end).join("\n");
}

/** One Markdown section; the fence grows past any backtick run in the body. */
function renderSection(heading: string, body: string): string {
  return fencedSection(heading, body);
}

/**
 * Executes a validated command list in order. Only the listed files and
 * search output are embedded — no project structure, AI instructions, or
 * Prompt scaffolding — so the supplement pastes cleanly onto the context
 * the chatbot already has.
 */
/** Read a file using the same safe-read behaviour as the Context command. */
async function readEmbeddedContent(
  absPath: string,
): Promise<{ content: string; wasRead: boolean }> {
  const result = await readFileSafe(absPath).catch(() => undefined);
  if (result === undefined)
    return { content: "[File not found]", wasRead: false };
  if (result.skipped) return { content: `[${result.reason}]`, wasRead: false };
  return { content: result.content ?? "", wasRead: true };
}

async function renderFileCommand(
  command: Extract<ValidatedCommand, { kind: "cat" | "readLines" }>,
): Promise<string> {
  const { content, wasRead } = await readEmbeddedContent(command.absPath);
  const body =
    command.kind === "readLines" && wasRead
      ? sliceLines(content, command.startLine, command.endLine)
      : content;
  const heading = command.kind === "cat" ? command.relPath : command.line;
  // File content is embedded verbatim, like `buildMarkdown` does: trailing
  // spaces and newlines are part of the file, not decoration to trim.
  return fencedSection(heading, body, false);
}

/**
 * Executes a validated command list in order. Only the listed files and
 * search output are embedded — no project structure, AI instructions, or
 * prompt scaffolding — so the supplement pastes cleanly onto existing context.
 */
// -----------------------------------------------------------------------------
// 7. Public entry point
// -----------------------------------------------------------------------------

export async function moreContext(
  rootDir: string,
  commandText: string,
): Promise<MoreContextResult> {
  const commands = parseMoreContextCommands(commandText);
  if (commands.length === 0) {
    throw new Error("No cat/grep commands found in the clipboard.");
  }

  // Validate the complete batch before reading files or running searches.
  const validated = await validateCommands(rootDir, commands);
  const guard = createEmbeddingGuard(rootDir);
  const sections: string[] = [];
  const attachedFiles: string[] = [];
  let searchCount = 0;
  let searchResultCount = 0;

  for (const command of validated) {
    if (command.kind !== "grep") {
      sections.push(await renderFileCommand(command));
      attachedFiles.push(command.relPath);
      continue;
    }

    const result = await runGrep(
      rootDir,
      command.request,
      command.absPaths,
      guard,
    );
    sections.push(renderSection(command.line, result.output));
    searchCount++;
    searchResultCount += result.resultCount;
  }

  const markdown = `# Files\n\n` + sections.join("\n\n") + "\n";

  return {
    markdown,
    allFiles: [],
    attachedFiles,
    commandCount: validated.length,
    searchCount,
    searchResultCount,
    tokenCount: estimateTokens(markdown),
  };
}
