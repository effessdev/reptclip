import * as path from "path";
import * as fs from "fs/promises";
import {
  collectNonIgnoredFiles,
  createEmbeddingGuard,
} from "./gitignoreScanner";
import { selectFiles } from "./patternMatcher";
import { tokenize } from "./tokenizer";
import { readFileSafe, countFileLines } from "./fileGuards";
import { mapLimit } from "./mapLimit";

/** How many files the "Context" click may have open at once. */
const READ_CONCURRENCY = 32;
import { buildMarkdown } from "./markdownBuilder";
import { estimateTokens } from "./tokenEstimator";
import { GenerateResult, UiState } from "./types";

export async function generateContext(
  rootDir: string,
  state: UiState,
  showLineCounts: boolean = true,
): Promise<GenerateResult> {
  const allFiles = await collectNonIgnoredFiles(rootDir);

  const attachPatterns = tokenize(state.attach);
  const excludePatterns = tokenize(state.exclude);
  const attachedFiles = state.files
    ? selectFiles(allFiles, attachPatterns, excludePatterns)
    : [];

  const lineCounts =
    state.projectStructure && showLineCounts
      ? await collectLineCounts(rootDir, allFiles)
      : undefined;

  return buildContext(
    rootDir,
    {
      includeStructure: state.projectStructure,
      includeDiffFormat: state.diffFormat,
      includeFiles: state.files,
      includePromptTail: state.promptTail,
      lineCounts,
    },
    attachedFiles,
    allFiles,
  );
}

/**
 * Counts raw lines per file for the "Project structure" listing. A file that
 * `countFileLines` can't count (oversized or binary) is left out of the map
 * entirely, so it renders in the listing with no count rather than a 0.
 */
async function collectLineCounts(
  rootDir: string,
  files: string[],
): Promise<Record<string, number | undefined>> {
  const counted = await mapLimit(files, READ_CONCURRENCY, async (relPath) => {
    try {
      return await countFileLines(path.join(rootDir, relPath));
    } catch {
      return undefined;
    }
  });
  const counts: Record<string, number | undefined> = {};
  files.forEach((relPath, index) => {
    counts[relPath] = counted[index];
  });
  return counts;
}

/**
 * Only the listed files are embedded: the project structure, "AI instructions",
 * and "Prompt" sections are never added, so a mid-conversation supplement
 * pastes cleanly on top of the context already in the chat instead of
 * repeating scaffolding the chatbot has already seen. The file reads still go
 * through the exact same `buildContext` pipeline as "Context".
 *
 * Naming a file here grants no access: the same `.gitignore` rules that shape
 * "Context"'s candidate pool apply, and the whole list is validated up front so
 * a single unacceptable path aborts the run instead of producing partial
 * context.
 */
/** @deprecated Superseded by `moreContext` (cat/grep command lists); kept until the docs/tests cleanup pass. */
export async function moreFiles(
  rootDir: string,
  pathList: string,
  includeFiles: boolean = true,
): Promise<GenerateResult> {
  if (!includeFiles) {
    return buildContext(
      rootDir,
      {
        includeStructure: false,
        includeDiffFormat: false,
        includeFiles: false,
        includePromptTail: false,
      },
      [],
      [],
    );
  }

  const attachedFiles = parsePathList(pathList);

  // Validate before touching the clipboard/output: if any listed path can't be
  // embedded (missing, a directory, ignored by `.gitignore`, outside the root),
  // abort and report each one with its reason.
  const rejected = await findRejectedPaths(rootDir, attachedFiles);
  if (rejected.length > 0) {
    const detail = rejected.map((r) => `${r.path} (${r.reason})`).join(", ");
    throw new Error(`Cannot embed: ${detail}`);
  }

  return buildContext(
    rootDir,
    {
      includeStructure: false,
      includeDiffFormat: false,
      includeFiles: true,
      includePromptTail: false,
    },
    attachedFiles,
    [],
  );
}

// Splits clipboard text into relative paths, one per line, the way Python's
// str.split() drops empty pieces: surrounding whitespace trimmed, blank lines
// (including runs of consecutive newlines) skipped, duplicates removed while
// preserving order.
function parsePathList(pathList: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of pathList.split(/\r?\n/)) {
    const rel = line.trim();
    if (!rel || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    files.push(rel);
  }
  return files;
}

// Checks each path against the embedding guard and the filesystem, returning
// the ones that must not be embedded along with why. Directories are rejected
// as clearly as missing files, since only file contents can be embedded.
async function findRejectedPaths(
  rootDir: string,
  relPaths: string[],
): Promise<{ path: string; reason: string }[]> {
  const guard = createEmbeddingGuard(rootDir);
  const rejected: { path: string; reason: string }[] = [];

  for (const rel of relPaths) {
    const verdict = await guard(rel);
    if (!verdict.ok) {
      rejected.push({
        path: rel,
        reason: verdict.reason ?? "cannot be embedded",
      });
      continue;
    }
    try {
      const stat = await fs.stat(verdict.absPath ?? path.join(rootDir, rel));
      if (!stat.isFile()) {
        rejected.push({ path: rel, reason: "not a file" });
      }
    } catch {
      rejected.push({ path: rel, reason: "not found" });
    }
  }

  return rejected;
}

// Which optional sections to wrap around the embedded files. Kept separate
// from `UiState` so callers ("Context" vs. "More Context") can opt in explicitly.
interface SectionOptions {
  includeStructure: boolean;
  includeDiffFormat: boolean;
  includeFiles: boolean;
  includePromptTail: boolean;
  /** Per-file raw line counts for the "Project structure" listing; omitted entirely when the feature is off. */
  lineCounts?: Record<string, number | undefined>;
}

// Reads every selected file and assembles the final Markdown. Shared by
// `generateContext` and `moreFiles`, and the only place that reads files for
// embedding — each path clears the embedding guard first, so anything
// `.gitignore` hides can never be embedded regardless of which feature listed
// it. A path that can't be read (e.g. deleted between validation and reading)
// degrades to a placeholder instead of failing the whole run.
async function buildContext(
  rootDir: string,
  options: SectionOptions,
  attachedFiles: string[],
  allFiles: string[],
): Promise<GenerateResult> {
  const guard = createEmbeddingGuard(rootDir);
  const contents = await mapLimit(
    attachedFiles,
    READ_CONCURRENCY,
    async (relPath) => {
      const verdict = await guard(relPath);
      if (!verdict.ok) {
        return `[Skipped: ${verdict.reason}]`;
      }

      // Read the canonical path the guard validated; re-joining the user path
      // would follow a link the guard just rejected.
      const absPath = verdict.absPath ?? path.join(rootDir, relPath);
      try {
        const result = await readFileSafe(absPath);
        return result.skipped ? `[${result.reason}]` : (result.content ?? "");
      } catch {
        return "[File not found]";
      }
    },
  );
  const fileContents: Record<string, string> = {};
  attachedFiles.forEach((relPath, index) => {
    fileContents[relPath] = contents[index];
  });

  const markdown = buildMarkdown({
    allFiles,
    attachedFiles: attachedFiles,
    fileContents,
    includeStructure: options.includeStructure,
    includeDiffFormat: options.includeDiffFormat,
    includeFiles: options.includeFiles,
    includePromptTail: options.includePromptTail,
    lineCounts: options.lineCounts,
  });

  return {
    markdown,
    allFiles,
    attachedFiles,
    tokenCount: estimateTokens(markdown),
  };
}
