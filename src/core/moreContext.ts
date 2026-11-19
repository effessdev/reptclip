import * as path from "path";
import * as fs from "fs/promises";
import { createEmbeddingGuard } from "./gitignoreScanner";
import { readFileSafe } from "./fileGuards";
import { tokenize } from "./tokenizer";
import { GenerateResult } from "./types";

/**
 * "More Context": the clipboard holds commands, one per line.
 * `cat <path>` embeds a file through the same guard/read pipeline as
 * Generate; `grep <flags> <pattern> [paths...]` searches the project with
 * grepts (in-process, no subprocess). Each command becomes one Markdown
 * section headed by the file path (cat) or the command line itself (grep).
 */

export type MoreContextCommand =
  | { kind: "cat"; relPath: string; line: string }
  | { kind: "grep"; request: GrepRequest; line: string };

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
  /** Number of commands executed (cat + grep), for status reporting. */
  commandCount: number;
}

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
  throw new Error(`unknown command "${command}"; expected cat or grep`);
}

function parsePositiveInt(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${label} expects a positive integer`);
  }
  return Number(value);
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
  return request;
}

type ValidatedCommand =
  | { kind: "cat"; relPath: string; absPath: string; line: string }
  | { kind: "grep"; request: GrepRequest; absPaths: string[]; line: string };

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
    if (command.kind === "cat") {
      const verdict = await guard(command.relPath);
      if (!verdict.ok) {
        rejected.push(
          `${command.relPath} (${verdict.reason ?? "cannot be embedded"})`,
        );
        continue;
      }
      const absPath = verdict.absPath ?? path.join(rootDir, command.relPath);
      try {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) {
          rejected.push(`${command.relPath} (not a file)`);
          continue;
        }
      } catch {
        rejected.push(`${command.relPath} (not found)`);
        continue;
      }
      validated.push({
        kind: "cat",
        relPath: command.relPath,
        absPath,
        line: command.line,
      });
      continue;
    }
    const relPaths =
      command.request.paths.length > 0 ? command.request.paths : ["."];
    const absPaths: string[] = [];
    let ok = true;
    for (const rel of relPaths) {
      if (rel === "." || rel === "./") {
        absPaths.push(rootDir);
        continue;
      }
      const verdict = await guard(rel);
      if (!verdict.ok) {
        rejected.push(`${rel} (${verdict.reason ?? "cannot be searched"})`);
        ok = false;
        continue;
      }
      const absPath = verdict.absPath ?? path.join(rootDir, rel);
      try {
        const stat = await fs.stat(absPath);
        if (!stat.isFile() && !stat.isDirectory()) {
          rejected.push(`${rel} (not a file or directory)`);
          ok = false;
          continue;
        }
      } catch {
        rejected.push(`${rel} (not found)`);
        ok = false;
        continue;
      }
      absPaths.push(absPath);
    }
    if (ok) {
      validated.push({
        kind: "grep",
        request: command.request,
        absPaths,
        line: command.line,
      });
    }
  }
  if (rejected.length > 0) {
    throw new Error(`Cannot run commands: ${rejected.join(", ")}`);
  }
  return validated;
}

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
): Promise<string> {
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
  for (const result of results) {
    const relPath = path
      .relative(rootDir, result.filePath)
      .split(/[\\/]+/)
      .join("/");
    const verdict = await guard(relPath);
    if (!verdict.ok) {
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
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no matches)";
}

/** One Markdown section; the fence grows past any backtick run in the body. */
function renderSection(heading: string, body: string): string {
  const text = body.trimEnd();
  const longestRun = (text.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `## ${heading}\n\n${fence}\n${text}\n${fence}`;
}

/**
 * Executes a validated command list in order. Only the listed files and
 * search output are embedded — no project structure, AI instructions, or
 * Prompt scaffolding — so the supplement pastes cleanly onto the context
 * the chatbot already has.
 */
export async function moreContext(
  rootDir: string,
  commandText: string,
): Promise<MoreContextResult> {
  const commands = parseMoreContextCommands(commandText);
  if (commands.length === 0) {
    throw new Error("No cat/grep commands found in the clipboard.");
  }
  const validated = await validateCommands(rootDir, commands);
  const guard = createEmbeddingGuard(rootDir);
  const sections: string[] = [];
  const includedFiles: string[] = [];
  for (const command of validated) {
    if (command.kind === "cat") {
      const result = await readFileSafe(command.absPath).catch(() => undefined);
      const content =
        result === undefined
          ? "[File not found]"
          : result.skipped
            ? `[${result.reason}]`
            : (result.content ?? "");
      sections.push(renderSection(command.relPath, content));
      includedFiles.push(command.relPath);
    } else {
      const output = await runGrep(
        rootDir,
        command.request,
        command.absPaths,
        guard,
      );
      sections.push(renderSection(command.line, output));
    }
  }
  return {
    markdown: `# Files\n\n` + sections.join("\n\n") + "\n",
    allFiles: [],
    includedFiles,
    commandCount: validated.length,
  };
}
