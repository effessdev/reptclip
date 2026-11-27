import * as path from "path";
import * as fs from "fs/promises";
import * as vm from "node:vm";
import {
  createEmbeddingGuard,
  collectNonIgnoredFiles,
} from "./gitignoreScanner";
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
 * The textbook catastrophic shape: a group repeated without bound whose body is
 * a single atom that also repeats without bound — `(a+)+`, `(a*)*`,
 * `((a+))+`. Refusing these turns the most common mistake into an immediate
 * error instead of a wait.
 *
 * The rule is deliberately narrow, and it is not what makes the feature safe.
 * `runGrep` bounds the whole search with a wall-clock timeout, which is the only
 * thing that closes the class: a shape rule cannot. Every version of this check
 * that tried to cover more also refused ordinary patterns such as
 * `(\d{1,3}\.){3}\d{1,3}` and `^https?://[\w-]+(\.[\w-]+)+…$`.
 *
 * A hand-written scan, not a regex, so the check itself stays linear.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  interface Group {
    /** Atoms in the body, all branches counted together. */
    atoms: number;
    /** Some atom in the body repeats without bound. */
    anyUnbounded: boolean;
    /** The atom just before the closing parenthesis repeats without bound. */
    lastUnbounded: boolean;
  }
  const groups: Group[] = [];
  const newGroup = (): Group => ({
    atoms: 0,
    anyUnbounded: false,
    lastUnbounded: false,
  });
  groups.push(newGroup());

  const isDigit = (ch: string | undefined): boolean =>
    ch !== undefined && ch >= "0" && ch <= "9";

  /** A quantifier at `at`: where it ends, and whether it has no upper bound. */
  const quantifierAt = (
    at: number,
  ): { end: number; unbounded: boolean } | null => {
    const ch = pattern[at];
    const lazy = pattern[at + 1] === "?" ? 1 : 0;
    if (ch === "?") {
      return { end: at + 1 + lazy, unbounded: false };
    }
    if (ch === "*" || ch === "+") {
      return { end: at + 1 + lazy, unbounded: true };
    }
    if (ch !== "{") {
      return null;
    }
    let j = at + 1;
    const lowStart = j;
    while (isDigit(pattern[j])) j += 1;
    if (j === lowStart) {
      return null;
    }
    const low = pattern.slice(lowStart, j);
    if (pattern[j] === "}") {
      return { end: j + 1, unbounded: false }; // {n}
    }
    if (pattern[j] !== ",") {
      return null;
    }
    j += 1;
    const highStart = j;
    while (isDigit(pattern[j])) j += 1;
    if (pattern[j] !== "}") {
      return null;
    }
    if (j === highStart) {
      return { end: j + 1, unbounded: true }; // {n,}
    }
    return { end: j + 1, unbounded: pattern.slice(highStart, j) !== low };
  };

  let i = 0;
  while (i < pattern.length) {
    const owner = groups[groups.length - 1];
    const ch = pattern[i];

    if (ch === "\\") {
      owner.atoms += 1;
      owner.lastUnbounded = false;
      i += 2;
      continue;
    }
    if (ch === "[") {
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        i += pattern[i] === "\\" ? 2 : 1;
      }
      i += 1;
      owner.atoms += 1;
      owner.lastUnbounded = false;
      continue;
    }
    if (ch === "|") {
      // Alternatives add atoms to the body; a branch never makes it one atom.
      i += 1;
      continue;
    }
    if (ch === "(") {
      groups.push(newGroup());
      i += 1;
      if (pattern[i] === "?") {
        const kind = pattern[i + 1];
        if (kind === ":" || kind === "=" || kind === "!") {
          i += 2;
        } else if (kind === "<") {
          const inner = pattern[i + 2];
          if (inner === "=" || inner === "!") {
            i += 3;
          } else {
            const close = pattern.indexOf(">", i);
            i = close === -1 ? i + 1 : close + 1;
          }
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (ch === ")") {
      const body = groups.pop();
      if (body === undefined) {
        i += 1;
        continue;
      }
      const quantifier = quantifierAt(i + 1);
      if (
        quantifier !== null &&
        quantifier.unbounded &&
        body.atoms === 1 &&
        body.lastUnbounded
      ) {
        return true;
      }
      const parent = groups[groups.length - 1] ?? newGroup();
      parent.atoms += 1;
      parent.lastUnbounded = body.anyUnbounded;
      parent.anyUnbounded = parent.anyUnbounded || body.anyUnbounded;
      i = quantifier === null ? i + 1 : quantifier.end;
      continue;
    }
    const quantifier = quantifierAt(i);
    if (quantifier !== null) {
      if (quantifier.unbounded) {
        owner.lastUnbounded = true;
        owner.anyUnbounded = true;
      }
      i = quantifier.end;
      continue;
    }
    owner.atoms += 1;
    owner.lastUnbounded = false;
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

/** How long a single search may run before it is abandoned. */
export const DEFAULT_GREP_TIMEOUT_MS = 15_000;

/**
 * How large a batch of files' combined size may grow before a search commits
 * to it, reports progress, and checks the deadline again. Smaller batches
 * mean progress updates and the "taking longer than expected" prompt land
 * sooner, at the cost of more `vm.runInNewContext` overhead (~4 ms per batch,
 * see `searchWithTimeout`) from re-entering the sandbox more often.
 */
export const DEFAULT_GREP_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Runs a synchronous search under a wall-clock bound.
 *
 * grepts matches with `RegExp.test` inside its own loop, and a catastrophic
 * pattern cannot be interrupted from JavaScript: it is one native call. `vm`
 * runs the call in a context whose execution V8 can terminate, so the search
 * returns either its results or a timeout error, never a frozen extension host.
 * The context is created per search; measured overhead on this project is about
 * 4 ms.
 */
function searchWithTimeout(
  search: (searchOptions: unknown) => unknown,
  options: unknown,
  timeoutMs: number,
  pattern: string,
): unknown {
  try {
    return vm.runInNewContext(
      "search(options)",
      { search, options },
      {
        timeout: timeoutMs,
      },
    );
  } catch (error) {
    // The timeout error is created in the vm realm, so `instanceof Error` is
    // false here; the code is what identifies it.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error(
        `pattern ${JSON.stringify(pattern)} ran for more than ${timeoutMs} ms ` +
          "and was stopped; narrow the paths, simplify the pattern, or pass -F " +
          "for a literal search",
      );
    }
    throw error;
  }
}

/**
 * Resolves grep's validated targets (files and/or directories) into a flat,
 * de-duplicated list of concrete files with their sizes, so the search can
 * be split into batches before anything is searched. A directory is expanded
 * through the same non-ignored file list used elsewhere, filtered to that
 * subtree — this is how grepts' own `respectGitignore` walk gets replicated
 * here. An explicit file bypasses that filter exactly as it does today; the
 * embedding guard still runs on every result either way.
 */
async function collectSearchFiles(
  rootDir: string,
  absPaths: string[],
  getNonIgnoredFiles: () => Promise<string[]>,
): Promise<{ absPath: string; size: number }[]> {
  const out: { absPath: string; size: number }[] = [];
  const seen = new Set<string>();

  for (const absPath of absPaths) {
    try {
      const stat = await fs.stat(absPath);
      if (stat.isFile()) {
        if (!seen.has(absPath)) {
          seen.add(absPath);
          out.push({ absPath, size: stat.size });
        }
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      const relPrefix = path
        .relative(rootDir, absPath)
        .split(/[\\/]+/)
        .join("/");
      const nonIgnored = await getNonIgnoredFiles();
      for (const relPath of nonIgnored) {
        if (
          relPrefix !== "" &&
          relPath !== relPrefix &&
          !relPath.startsWith(`${relPrefix}/`)
        ) {
          continue;
        }
        const fileAbsPath = path.join(rootDir, relPath);
        if (seen.has(fileAbsPath)) {
          continue;
        }
        try {
          const fileStat = await fs.stat(fileAbsPath);
          if (fileStat.isFile()) {
            seen.add(fileAbsPath);
            out.push({ absPath: fileAbsPath, size: fileStat.size });
          }
        } catch {
          // raced with a delete between the scan and this stat; skip it
        }
      }
    } catch {
      continue; // vanished since validation; the search just skips it
    }
  }
  return out;
}

/**
 * Packs files into batches whose combined size stays near `targetBytes`,
 * preserving order and always keeping at least one file per batch (a single
 * file larger than the target still gets its own batch rather than being
 * split).
 */
function batchBySize<T extends { size: number }>(
  items: T[],
  targetBytes: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;
  for (const item of items) {
    if (current.length > 0 && currentSize + item.size > targetBytes) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += item.size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

interface GrepRunOptions {
  /**
   * Overall wall-clock bound for this search, in milliseconds. Unlike the
   * old single `vm.runInNewContext` call, this spans every batch; each batch
   * only gets whatever is left of it.
   */
  timeoutMs: number;
  /** Target combined file size per batch, in bytes. */
  batchBytes: number;
  /** Reports 0-100 progress after each batch finishes. */
  onProgress?: (percent: number) => void;
  /**
   * Asked once the deadline is reached, whether that's before a batch starts
   * or because a batch itself timed out. Returning true doubles the deadline
   * and resumes the very batch that was about to run or just timed out —
   * nothing already completed is redone. Returning false (or omitting the
   * callback) fails the search exactly as it always has.
   */
  confirmContinue?: (info: {
    line: string;
    elapsedMs: number;
  }) => Promise<boolean>;
}

/**
 * Runs one grep via grepts, across as many batches as the target files need.
 * The sync `search()` is deliberate: `searchAsync` spawns a worker pool whose
 * script path is resolved relative to grepts' own module URL, which does not
 * survive esbuild bundling. Safety: grepts lets explicitly passed file paths
 * bypass .gitignore, so every result is re-checked through the embedding
 * guard before any line is embedded, and NUL-containing (binary) matches are
 * dropped.
 */
async function runGrep(
  rootDir: string,
  request: GrepRequest,
  absPaths: string[],
  guard: EmbeddingGuard,
  getNonIgnoredFiles: () => Promise<string[]>,
  line: string,
  runOptions: GrepRunOptions,
): Promise<{ output: string; resultCount: number }> {
  const grepts: GreptsModule = await import("grepts");

  let regex: RegExp;
  try {
    regex = grepts.buildRegex(
      grepts.searchOptionsSchema.parse({
        ...request,
        paths: absPaths,
        respectGitignore: true,
        color: false,
        quiet: false,
      }),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid grep pattern ${JSON.stringify(request.pattern)}: ${reason}`,
    );
  }

  const files = await collectSearchFiles(rootDir, absPaths, getNonIgnoredFiles);
  if (files.length === 0) {
    return { output: "(no matches)", resultCount: 0 };
  }
  const batches = batchBySize(files, runOptions.batchBytes);

  const lines: string[] = [];
  let resultCount = 0;
  // grepts decodes files as UTF-8 without validation, so a legacy-encoded file
  // would come back as mojibake even though `cat` skips it. Apply the same
  // text check the context pipeline uses, once per matched file.
  const textFiles = new Map<string, boolean>();

  const startTime = Date.now();
  let totalTimeoutMs = runOptions.timeoutMs;

  // true doubles the deadline so the caller can retry; false leaves the
  // caller to fail the search as it always has.
  const askToContinue = async (): Promise<boolean> => {
    if (!runOptions.confirmContinue) {
      return false;
    }
    const proceed = await runOptions.confirmContinue({
      line,
      elapsedMs: Date.now() - startTime,
    });
    if (proceed) {
      totalTimeoutMs *= 2;
    }
    return proceed;
  };

  const giveUp = (): never => {
    throw new Error(
      `pattern ${JSON.stringify(request.pattern)} ran for more than ${totalTimeoutMs} ms ` +
        "and was stopped; narrow the paths, simplify the pattern, or pass -F for a literal search",
    );
  };

  let batchIndex = 0;
  while (batchIndex < batches.length) {
    const remainingMs = startTime + totalTimeoutMs - Date.now();
    if (remainingMs <= 0) {
      if (await askToContinue()) {
        continue; // deadline just moved; re-check it from the top
      }
      giveUp();
    }

    const batch = batches[batchIndex];
    const batchOptions = grepts.searchOptionsSchema.parse({
      ...request,
      paths: batch.map((file) => file.absPath),
      respectGitignore: true,
      color: false,
      quiet: false,
    });

    let batchResults: ReturnType<typeof grepts.search> = [];
    try {
      batchResults = searchWithTimeout(
        grepts.search as (searchOptions: unknown) => unknown,
        batchOptions,
        remainingMs,
        request.pattern,
      ) as ReturnType<typeof grepts.search>;
    } catch (err) {
      const timedOut =
        err instanceof Error && /ran for more than/.test(err.message);
      if (!timedOut) {
        throw err;
      }
      if (await askToContinue()) {
        continue; // retry this same batch now that the deadline moved
      }
      giveUp();
    }

    for (const result of batchResults) {
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
        batchOptions,
        regex,
        true,
      );
      if (formatted) {
        lines.push(formatted);
        resultCount += batchOptions.count
          ? result.matchCount
          : batchOptions.filesWithMatches || batchOptions.filesWithoutMatch
            ? 1
            : result.matchCount;
      }
    }

    batchIndex += 1;
    runOptions.onProgress?.(Math.round((batchIndex / batches.length) * 100));
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

export interface MoreContextOptions {
  /** Overall wall-clock bound for one grep search, in milliseconds. */
  grepTimeoutMs?: number;
  /** Target combined file size per grep batch, in bytes. */
  grepBatchBytes?: number;
  /** Reports 0-100 progress for whichever grep search is currently running. */
  onSearchProgress?: (percent: number) => void;
  /**
   * Asked when a search's deadline is reached, whether that's before a batch
   * starts or because a batch timed out mid-run. Returning true doubles the
   * deadline and resumes from the batch that was running, keeping every
   * earlier batch's results; returning false fails the search as it always
   * has.
   */
  confirmContinueSearch?: (info: {
    line: string;
    elapsedMs: number;
  }) => Promise<boolean>;
}

export async function moreContext(
  rootDir: string,
  commandText: string,
  options: MoreContextOptions = {},
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

  // Computed at most once per call, since several grep commands can search
  // overlapping directories.
  let nonIgnoredFiles: Promise<string[]> | undefined;
  const getNonIgnoredFiles = () =>
    (nonIgnoredFiles ??= collectNonIgnoredFiles(rootDir));

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
      getNonIgnoredFiles,
      command.line,
      {
        timeoutMs: options.grepTimeoutMs ?? DEFAULT_GREP_TIMEOUT_MS,
        batchBytes: options.grepBatchBytes ?? DEFAULT_GREP_BATCH_BYTES,
        onProgress: options.onSearchProgress,
        confirmContinue: options.confirmContinueSearch,
      },
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
