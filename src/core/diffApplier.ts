import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { createEmbeddingGuard } from "./gitignoreScanner";

// ============================================================================
// Types
// ============================================================================

interface DiffBlock {
  file: string;
  search: string;
  replace: string;
  /** A standalone file operation instead of a SEARCH/REPLACE block. */
  kind?: "move" | "delete";
  destination?: string;
}

export interface ApplySummary {
  modified: number;
  created: number;
  deleted: number;
  /** Blocks whose SEARCH matched only via the whitespace-lenient fallbacks. */
  fuzzy: number;
}

/**
 * The before/after content of a single file touched by an apply, keyed by
 * its workspace-relative path. `undefined` means the file does not exist
 * on that side, allowing snapshots to represent creations and deletions.
 */
export interface FileSnapshot {
  relPath: string;
  before: string | undefined;
  after: string | undefined;
}

/** One applied diff's worth of undo/redo information. */
export interface Checkpoint {
  files: FileSnapshot[];
}

export interface ApplyResult extends ApplySummary {
  /** Lets the caller push this apply onto an undo stack. */
  checkpoint: Checkpoint;
}

/** Optional hooks a host provides so core code stays free of VS Code dialogs. */
export interface ApplyOptions {
  /**
   * In-editor buffers that win over the on-disk copy, keyed by absolute path.
   * A dirty document is the truth the user sees; matching against the stale
   * disk copy would either miss the block or silently drop unsaved edits.
   */
  bufferOverrides?: Map<string, string>;

  /**
   * Called right before anything is written. The host uses it to abort if a
   * document changed while the diff was being resolved (TOCTOU).
   */
  assertBuffersCurrent?: () => void;

  /**
   * Resolve true to apply a block whose REPLACE contains a `=======` line,
   * which usually means the SEARCH separator was swallowed by the parser.
   */
  confirmSuspiciousReplace?: (files: string[]) => Promise<boolean>;

  /**
   * Resolve true to create, modify, delete, or move a `.gitignore` file.
   * Changing one can un-ignore previously protected paths, so the host must
   * warn the user explicitly before this is allowed to proceed.
   */
  confirmGitignoreEdits?: (paths: string[]) => Promise<boolean>;
}

/** Options for `applySnapshot` (undo/redo). */
export interface SnapshotOptions {
  /** In-editor buffers that win over the on-disk copy, keyed by absolute path. */
  bufferOverrides?: Map<string, string>;

  /** Abort if a document changed while undo/redo was being prepared. */
  assertBuffersCurrent?: () => void;

  /** Resolve true to overwrite files that changed since the checkpoint. */
  confirmConflict?: (paths: string[]) => Promise<boolean>;
}

interface FilePlan {
  absPath: string;
  /** Workspace-relative path (forward slashes), used to key a checkpoint. */
  relPath: string;
  existed: boolean;
  /** The file's content before this operation, if it existed. */
  original: string | undefined;
  content: string;
  deleted: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const SEARCH_MARKER = "<<<<<<< SEARCH";
const SEPARATOR = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ============================================================================
// Filesystem helpers
// ============================================================================

async function readFileIfExists(absPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a file has been modified on disk since the checkpoint was
 * recorded. Returns true if its existence or content differs from expected.
 */
async function hasDiskChanges(
  absPath: string,
  expectedContent: string | undefined,
): Promise<boolean> {
  const currentContent = await readFileIfExists(absPath);
  const currentExists = currentContent !== undefined;
  const expectedExists = expectedContent !== undefined;

  if (currentExists !== expectedExists) {
    return true;
  }

  if (currentExists && expectedExists && currentContent !== expectedContent) {
    return true;
  }

  return false;
}

/**
 * Strips a trailing NTFS alternate-data-stream suffix from a path's final
 * segment. For example, `.env::$DATA` becomes `.env`.
 */
function stripAdsSuffix(relative: string): string {
  // NTFS alternate data streams are a Windows concept; on POSIX a colon is an
  // ordinary filename character, so stripping it there would judge `a:b`
  // against rules written for `a`.
  if (process.platform !== "win32") {
    return relative;
  }
  const segments = relative.split(/[\\/]+/).filter(Boolean);

  if (segments.length === 0) {
    return relative;
  }

  const lastIndex = segments.length - 1;
  segments[lastIndex] = segments[lastIndex].split(":")[0];

  return segments.join("/");
}

/**
 * Whether a diff path's final segment is `.gitignore`.
 */
function isGitignoreFile(relative: string): boolean {
  const base = stripAdsSuffix(relative).split("/").pop()!.toLowerCase();
  return base === ".gitignore";
}

/**
 * Whether `absPath` is the *same file* as a `.gitignore`, without being
 * spelled that way. Symbolic links and junctions resolve through
 * `realRelPath`; hard links do not — they are one inode under two names — so
 * the only way to see them is to compare the inode with every `.gitignore`
 * on the target's ancestor chain.
 */
async function aliasesGitignoreFile(
  absPath: string,
  rootDir: string,
): Promise<boolean> {
  let target;
  try {
    target = await fs.stat(absPath, { bigint: true });
  } catch {
    return false; // a path that does not exist yet cannot be an alias
  }
  if (!target.isFile() || target.ino === 0n) {
    return false;
  }
  const root = path.resolve(rootDir);
  let dir = path.dirname(path.resolve(absPath));
  for (;;) {
    try {
      const candidate = await fs.stat(path.join(dir, ".gitignore"), {
        bigint: true,
      });
      if (candidate.dev === target.dev && candidate.ino === target.ino) {
        return true;
      }
    } catch {
      // No .gitignore at this level; keep walking up.
    }
    if (dir === root) {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

/** Whether `candidate` is `root` itself or lives inside it, using OS case rules. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolves a diff path against the workspace root, rejecting escapes.
 *
 * Returns:
 * - `absPath`: the lexical absolute path used for the edit.
 * - `realRelPath`: the workspace-relative real path, used for path-based rules.
 *
 * Resolving the deepest existing ancestor also prevents symlinks and directory
 * junctions from redirecting writes outside the workspace.
 */
async function resolveFile(
  rootDir: string,
  relative: string,
): Promise<{ absPath: string; realRelPath: string }> {
  const cleaned = relative
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

  const root = path.resolve(rootDir);
  const abs = path.resolve(root, cleaned);
  const prefix = root.toLowerCase() + path.sep;

  if (
    abs.toLowerCase() !== root.toLowerCase() &&
    !abs.toLowerCase().startsWith(prefix)
  ) {
    throw new Error(`Diff path escapes the workspace: ${relative}`);
  }

  const rootReal = await fs.realpath(root).catch(() => undefined);

  if (rootReal === undefined) {
    throw new Error(
      `Diff path escapes the workspace: ${relative} (workspace root is not readable)`,
    );
  }

  let probe = abs;
  const trailing: string[] = [];

  for (;;) {
    let probeReal: string | undefined;

    try {
      probeReal = await fs.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Diff path cannot be resolved: ${relative} (${(err as Error).message})`,
        );
      }

      // A dangling symlink still redirects a write. Reject it explicitly.
      const linkInfo = await fs.lstat(probe).catch(() => undefined);

      if (linkInfo?.isSymbolicLink()) {
        throw new Error(
          `Diff path escapes the workspace: ${relative} (dangling link at ${probe})`,
        );
      }
    }

    if (probeReal !== undefined) {
      const resolved = trailing.length
        ? path.resolve(probeReal, ...trailing)
        : probeReal;

      if (!isInside(rootReal, resolved)) {
        throw new Error(
          `Diff path escapes the workspace: ${relative} (resolves to ${resolved})`,
        );
      }

      return {
        absPath: abs,
        realRelPath: path
          .relative(rootReal, resolved)
          .split(path.sep)
          .join("/"),
      };
    }

    const parent = path.dirname(probe);

    if (parent === probe) {
      throw new Error(`Diff path escapes the workspace: ${relative}`);
    }

    trailing.unshift(path.basename(probe));
    probe = parent;
  }
}

/**
 * Buffer lookup by file identity.
 *
 * Exact path matches win immediately. Case-insensitive matches are accepted
 * only when the filesystem confirms that both paths refer to the same file.
 */
export async function findBufferOverride(
  overrides: Map<string, string> | undefined,
  absPath: string,
): Promise<string | undefined> {
  if (!overrides) {
    return undefined;
  }

  const exact = overrides.get(absPath);

  if (exact !== undefined) {
    return exact;
  }

  const needle = absPath.toLowerCase();

  for (const [key, value] of overrides) {
    if (key.toLowerCase() === needle && (await isSameFile(key, absPath))) {
      return value;
    }
  }

  return undefined;
}

async function isSameFile(first: string, second: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      fs.stat(first, { bigint: true }),
      fs.stat(second, { bigint: true }),
    ]);

    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Reads the current content of a file, preferring an in-editor buffer over
 * the on-disk copy.
 */
async function readCurrentContent(
  absPath: string,
  overrides: Map<string, string> | undefined,
): Promise<string | undefined> {
  return (
    (await findBufferOverride(overrides, absPath)) ??
    (await readFileIfExists(absPath))
  );
}

/**
 * Creates the initial plan for a file.
 *
 * A plan tracks both the original state and the content resulting from
 * applying all operations encountered so far.
 */
function createFilePlan(
  rootDir: string,
  absPath: string,
  original: string | undefined,
): FilePlan {
  return {
    absPath,
    relPath: path
      .relative(path.resolve(rootDir), absPath)
      .split(path.sep)
      .join("/"),
    existed: original !== undefined,
    original,
    content: original ?? "",
    deleted: false,
  };
}

// ============================================================================
// Diff parsing and fingerprinting
// ============================================================================

/**
 * Parses Search/Replace blocks and standalone move/delete operations.
 *
 * Outside a block, every non-empty line is treated as a candidate file path.
 * The line immediately preceding a SEARCH marker identifies the target.
 * Consecutive blocks for the same file reuse the last resolved path.
 *
 * Code fences around the whole dump are ignored.
 */
export function parseDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = text.split(/\r?\n/);

  let state: "outside" | "search" | "replace" = "outside";
  let currentFile: string | undefined;
  let candidatePath: string | undefined;
  let searchLines: string[] = [];
  let replaceLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (state === "outside") {
      if (trimmed.startsWith(SEARCH_MARKER)) {
        state = "search";
        searchLines = [];
        continue;
      }

      if (trimmed.startsWith("```") || trimmed === "") {
        continue;
      }

      const arrow = trimmed.match(/^(.+?)\s+->\s+(.+)$/);

      if (arrow) {
        blocks.push({
          file: arrow[1].trim(),
          destination: arrow[2].trim(),
          search: "",
          replace: "",
          kind: "move",
        });
        continue;
      }

      const deleteMatch = trimmed.match(/^(.+?)\s+delete$/i);

      if (deleteMatch) {
        blocks.push({
          file: deleteMatch[1].trim(),
          search: "",
          replace: "",
          kind: "delete",
        });
        continue;
      }

      candidatePath = trimmed;
      continue;
    }

    if (state === "search") {
      if (trimmed === SEPARATOR) {
        state = "replace";
        replaceLines = [];
        continue;
      }

      searchLines.push(line);
      continue;
    }

    // state === "replace"
    if (trimmed.startsWith(REPLACE_MARKER)) {
      const file = candidatePath ?? currentFile;

      if (!file) {
        throw new Error(
          "Found a SEARCH/REPLACE block with no file path before it.",
        );
      }

      blocks.push({
        file,
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
      });

      currentFile = file;
      candidatePath = undefined;
      state = "outside";
      continue;
    }

    replaceLines.push(line);
  }

  if (state !== "outside") {
    throw new Error("Truncated diff: a SEARCH/REPLACE block is not closed.");
  }

  return blocks;
}

/**
 * Stable content hash derived from parsed blocks rather than raw clipboard
 * text. This makes line-ending and surrounding-fence differences irrelevant.
 */
export function fingerprintDiff(text: string): string {
  const blocks = parseDiffBlocks(text);

  if (blocks.length === 0) {
    throw new Error(
      "Clipboard does not contain any supported diff operations.",
    );
  }

  const canonical = blocks
    .map(
      (block) =>
        `${block.kind ?? "replace"}\u0000${block.file}\u0000${block.destination ?? ""}\u0000${block.search}\u0000${block.replace}`,
    )
    .join("\u0001");

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ============================================================================
// SEARCH matching
// ============================================================================

/**
 * Builds progressively more forgiving regex patterns from SEARCH lines:
 *
 * 1. Ignore trailing whitespace on each line.
 * 2. Also allow flexible leading indentation.
 * 3. Treat internal whitespace runs as equivalent.
 */
function lenientPatterns(lines: string[]): string[] {
  const trailing = "[ \\t]*";
  const escape = escapeRegExp;

  const levels = [
    (line: string) => escape(line) + trailing,

    (line: string) =>
      `[ \\t]*${escape(line.replace(/^[ \t]+/, ""))}${trailing}`,

    (line: string) => {
      const tokens = line.trim().split(/\s+/).filter(Boolean).map(escape);

      return tokens.length
        ? `[ \\t]*${tokens.join("[ \\t]+")}${trailing}`
        : "[ \\t]*";
    },
  ];

  return levels.map((perLine) => lines.map(perLine).join("\\r?\\n"));
}

/**
 * Locates SEARCH in the file content.
 *
 * Exact matches are attempted first, followed by progressively more lenient
 * whitespace matches. Ambiguous matches are rejected.
 *
 * Replacement line endings are normalized to match the matched file content.
 */
function findMatch(
  content: string,
  search: string,
  replace: string,
  file: string,
): { index: number; text: string; replace: string; fuzzy: boolean } {
  const normalizeReplace = (matched: string, value: string): string => {
    const crlf = matched.includes("\r\n")
      ? true
      : matched.includes("\n")
        ? false
        : content.includes("\r\n");

    if (crlf) {
      return value.includes("\r\n") ? value : value.replace(/\n/g, "\r\n");
    }

    return value.includes("\r\n") ? value.replace(/\r\n/g, "\n") : value;
  };

  // Pass 0: byte-for-byte exact matching across line-ending combinations.
  const lf = search.replace(/\r\n/g, "\n");

  const bases = [search, lf, lf.replace(/\n/g, "\r\n")];

  let ambiguous = false;

  for (const base of bases) {
    for (const variant of [base, base.replace(/\r?\n+$/, "")]) {
      if (variant === "") {
        continue;
      }

      const count = content.split(variant).length - 1;

      if (count === 1) {
        return {
          index: content.indexOf(variant),
          text: variant,
          replace: normalizeReplace(variant, replace),
          fuzzy: false,
        };
      }

      if (count > 1) {
        ambiguous = true;
      }
    }
  }

  // Passes 1-3: whitespace-lenient matching, strictest first.
  const body = search.replace(/\r?\n+$/, "");

  if (body !== "") {
    const patterns = lenientPatterns(body.split(/\r?\n/));

    for (const pattern of patterns) {
      const matches = [...content.matchAll(new RegExp(pattern, "g"))];

      if (matches.length === 1) {
        const match = matches[0];

        return {
          index: match.index,
          text: match[0],
          replace: normalizeReplace(match[0], replace),
          fuzzy: true,
        };
      }

      if (matches.length > 1) {
        ambiguous = true;
      }
    }
  }

  if (ambiguous) {
    throw new Error(
      `SEARCH block for ${file} matches multiple locations. Please provide more context.`,
    );
  }

  throw new Error(`No match found for the SEARCH block in ${file}.`);
}

// ============================================================================
// Workspace edit / commit
// ============================================================================

/**
 * Turns file plans into disk changes through a single workspace edit.
 *
 * Creates, modifies, or deletes each file, saves dirty buffers, and reveals
 * affected files in the editor. Shared by applyDiffs and applySnapshot.
 */
async function commitPlans(
  plans: Iterable<FilePlan>,
  assertBuffersCurrent?: () => void,
): Promise<{ modified: number; created: number; deleted: number }> {
  const edit = new vscode.WorkspaceEdit();

  let modified = 0;
  let created = 0;
  let deleted = 0;

  // Files whose edits land in an in-memory document buffer.
  const touched: vscode.Uri[] = [];

  for (const plan of plans) {
    const uri = vscode.Uri.file(plan.absPath);

    if (plan.deleted) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      deleted++;
      continue;
    }

    if (!plan.existed) {
      edit.createFile(uri, { overwrite: true });
      edit.insert(uri, new vscode.Position(0, 0), plan.content);
      created++;
      touched.push(uri);
      continue;
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);

    edit.replace(doc.uri, fullRange, plan.content);
    modified++;
    touched.push(uri);
  }

  // Revalidate immediately before applying the edit. Opening documents above
  // awaited, so buffers may have changed since the earlier validation.
  assertBuffersCurrent?.();

  const applied = await vscode.workspace.applyEdit(edit);

  if (!applied) {
    throw new Error("VS Code refused to apply the workspace edit.");
  }

  // Persist changes while preserving the editor undo stack.
  for (const uri of touched) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  }

  // Open affected files as pinned tabs without repeatedly stealing focus.
  for (const uri of touched) {
    await vscode.window.showTextDocument(uri, {
      preview: false,
      preserveFocus: true,
    });
  }

  // Reveal the first affected file so focus lands somewhere predictable.
  if (touched.length > 0) {
    await vscode.window.showTextDocument(touched[0], { preview: false });
  }

  return { modified, created, deleted };
}

// ============================================================================
// Apply validation
// ============================================================================

/**
 * Detects REPLACE blocks containing a separator line.
 *
 * Such a line can indicate that the parser swallowed an intended SEARCH
 * separator, so the host must explicitly confirm the operation.
 */
async function validateSuspiciousReplacements(
  blocks: DiffBlock[],
  options: ApplyOptions,
): Promise<void> {
  const suspiciousReplace = [
    ...new Set(
      blocks
        .filter(
          (block) =>
            block.kind === undefined &&
            block.replace
              .split(/\r?\n/)
              .some((line) => line.trim() === SEPARATOR),
        )
        .map((block) => block.file),
    ),
  ];

  if (suspiciousReplace.length === 0) {
    return;
  }

  if (!options.confirmSuspiciousReplace) {
    throw new Error(
      `Refusing to apply: the REPLACE block for ${suspiciousReplace.join(", ")} ` +
        'contains a "=======" line, which usually means a SEARCH separator was ' +
        "swallowed. Split the edit into separate blocks or confirm explicitly.",
    );
  }

  const confirmed = await options.confirmSuspiciousReplace(suspiciousReplace);

  if (!confirmed) {
    throw new Error(
      `Apply cancelled: the "=======" line in ${suspiciousReplace.join(", ")} was not confirmed.`,
    );
  }
}

/**
 * Resolves all source and destination paths and checks whether they are
 * eligible for modification according to the embedding/gitignore guard.
 */
async function resolveAndValidatePaths(
  rootDir: string,
  blocks: DiffBlock[],
): Promise<{
  targets: { absPath: string; realRelPath: string }[];
  destinations: ({ absPath: string; realRelPath: string } | undefined)[];
}> {
  const targets: { absPath: string; realRelPath: string }[] = [];
  const destinations: ({ absPath: string; realRelPath: string } | undefined)[] =
    [];

  const refusedPaths = new Map<string, string>();
  const isEmbeddable = createEmbeddingGuard(rootDir);

  for (const block of blocks) {
    const target = await resolveFile(rootDir, block.file);
    targets.push(target);

    const verdict = await isEmbeddable(stripAdsSuffix(block.file));

    if (!verdict.ok) {
      refusedPaths.set(block.file, verdict.reason ?? "not a trackable path");
    }

    if (block.kind === "move") {
      if (!block.destination || block.destination.trim() === "") {
        throw new Error(`Move from ${block.file} has no destination path.`);
      }

      const destination = await resolveFile(rootDir, block.destination);
      destinations.push(destination);

      const destVerdict = await isEmbeddable(
        stripAdsSuffix(block.destination!),
      );

      if (!destVerdict.ok) {
        refusedPaths.set(
          block.destination!,
          destVerdict.reason ?? "not a trackable path",
        );
      }
    } else {
      destinations.push(undefined);
    }
  }

  if (refusedPaths.size > 0) {
    const details = [...refusedPaths.entries()]
      .map(([file, reason]) => `${file} (${reason})`)
      .join(", ");

    throw new Error(
      `Refusing to write paths .gitignore excludes from context: ${details}. ` +
        "Diffs can only touch tracked files — untrack them in .gitignore first if you want ReptClip to manage them.",
    );
  }

  return { targets, destinations };
}

/**
 * Requires explicit confirmation before any operation that touches a
 * `.gitignore` file.
 */
async function validateGitignoreEdits(
  rootDir: string,
  blocks: DiffBlock[],
  targets: { absPath: string; realRelPath: string }[],
  destinations: ({ absPath: string; realRelPath: string } | undefined)[],
  options: ApplyOptions,
): Promise<void> {
  // Judge the path the write really lands on, not just the spelling: a link
  // named `ignore-mirror` can point at `.gitignore`, and editing it then
  // un-ignores files with no dialog at all.
  const gitignoreTouches = new Set<string>();

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const target = targets[index];

    if (
      isGitignoreFile(block.file) ||
      isGitignoreFile(target.realRelPath) ||
      (await aliasesGitignoreFile(target.absPath, rootDir))
    ) {
      gitignoreTouches.add(block.file);
    }

    const destination = destinations[index];

    if (
      block.kind === "move" &&
      block.destination &&
      destination &&
      (isGitignoreFile(block.destination) ||
        isGitignoreFile(destination.realRelPath) ||
        (await aliasesGitignoreFile(destination.absPath, rootDir)))
    ) {
      gitignoreTouches.add(block.destination);
    }
  }

  if (gitignoreTouches.size === 0) {
    return;
  }

  const files = [...gitignoreTouches];

  if (!options.confirmGitignoreEdits) {
    throw new Error(
      `Refusing to modify .gitignore without confirmation: ${files.join(", ")}. ` +
        "Changing .gitignore can un-ignore sensitive files such as .env. " +
        "Confirm explicitly to proceed.",
    );
  }

  const confirmed = await options.confirmGitignoreEdits(files);

  if (!confirmed) {
    throw new Error(
      `Apply cancelled: changes to .gitignore were not confirmed (${files.join(", ")}).`,
    );
  }
}

// ============================================================================
// File-plan construction
// ============================================================================

/**
 * Loads a file's current content and creates its initial plan.
 */
async function getOrCreatePlan(
  plans: Map<string, FilePlan>,
  rootDir: string,
  absPath: string,
  overrides: Map<string, string> | undefined,
): Promise<FilePlan> {
  let plan = plans.get(absPath);

  if (!plan) {
    const original = await readCurrentContent(absPath, overrides);
    plan = createFilePlan(rootDir, absPath, original);
    plans.set(absPath, plan);
  }

  return plan;
}

/**
 * Applies a standalone delete operation to a file plan.
 */
function applyDeleteBlock(block: DiffBlock, plan: FilePlan): void {
  if (!plan.existed) {
    throw new Error(`Cannot delete ${block.file}: the file does not exist.`);
  }

  plan.deleted = true;
}

/**
 * Applies a standalone move operation to the source and destination plans.
 */
async function applyMoveBlock(
  block: DiffBlock,
  plan: FilePlan,
  destination: { absPath: string; realRelPath: string },
  plans: Map<string, FilePlan>,
  rootDir: string,
  overrides: Map<string, string> | undefined,
): Promise<void> {
  if (!plan.existed) {
    throw new Error(`Cannot move ${block.file}: the file does not exist.`);
  }

  if (destination.absPath.toLowerCase() === plan.absPath.toLowerCase()) {
    throw new Error(
      `Cannot move ${block.file}: source and destination are the same path.`,
    );
  }

  const destinationPlan = await getOrCreatePlan(
    plans,
    rootDir,
    destination.absPath,
    overrides,
  );

  if (destinationPlan.existed) {
    throw new Error(
      `Cannot move ${block.file} to ${block.destination}: destination already exists.`,
    );
  }

  destinationPlan.existed = false;
  destinationPlan.original = undefined;
  destinationPlan.content = plan.content;
  destinationPlan.deleted = false;

  plan.deleted = true;
}

/**
 * Applies a SEARCH/REPLACE block to an existing file plan.
 */
function applyReplaceBlock(block: DiffBlock, plan: FilePlan): boolean {
  if (block.search === "") {
    // Empty SEARCH: create a new file or append to a file being created.
    if (plan.existed && plan.content.trim() !== "") {
      throw new Error(
        `${block.file} already exists. An empty SEARCH block is only for new files.`,
      );
    }

    plan.content += block.replace;
    return false;
  }

  if (!plan.existed && plan.content === "") {
    throw new Error(
      `No match found for the SEARCH block in ${block.file}: the file does not exist. ` +
        "A file path must be on its own line immediately before <<<<<<< SEARCH.",
    );
  }

  const match = findMatch(
    plan.content,
    block.search,
    block.replace,
    block.file,
  );

  plan.content =
    plan.content.slice(0, match.index) +
    match.replace +
    plan.content.slice(match.index + match.text.length);

  return match.fuzzy;
}

/**
 * Simulates all operations in their original order.
 *
 * No disk changes are made here. All operations must successfully validate
 * before the resulting plans are committed.
 */
async function buildFilePlans(
  rootDir: string,
  blocks: DiffBlock[],
  targets: { absPath: string; realRelPath: string }[],
  destinations: ({ absPath: string; realRelPath: string } | undefined)[],
  options: ApplyOptions,
): Promise<{ plans: Map<string, FilePlan>; fuzzy: number }> {
  const plans = new Map<string, FilePlan>();
  let fuzzy = 0;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const { absPath } = targets[blockIndex];

    const plan = await getOrCreatePlan(
      plans,
      rootDir,
      absPath,
      options.bufferOverrides,
    );

    if (plan.deleted) {
      throw new Error(`Diff edits ${block.file} after it was deleted.`);
    }

    if (block.kind === "delete") {
      applyDeleteBlock(block, plan);
      continue;
    }

    if (block.kind === "move") {
      await applyMoveBlock(
        block,
        plan,
        destinations[blockIndex]!,
        plans,
        rootDir,
        options.bufferOverrides,
      );
      continue;
    }

    if (applyReplaceBlock(block, plan)) {
      fuzzy++;
    }
  }

  return { plans, fuzzy };
}

/**
 * Captures the before/after state of every planned file for undo/redo.
 */
function createCheckpoint(plans: Iterable<FilePlan>): FileSnapshot[] {
  return Array.from(plans).map((plan) => ({
    relPath: plan.relPath,
    before: plan.existed ? plan.original : undefined,
    after: plan.deleted ? undefined : plan.content,
  }));
}

// ============================================================================
// Public API: applying diffs
// ============================================================================

/**
 * Applies Search/Replace diff blocks copied from an LLM chat.
 *
 * Supported operations:
 *
 *   path/to/file.ext
 *   <<<<<<< SEARCH
 *   verbatim existing code
 *   =======
 *   replacement code
 *   >>>>>>> REPLACE
 *
 * An empty SEARCH creates a new file. An empty REPLACE removes the matched
 * text and leaves the file present, including when it becomes empty.
 */
export async function applyDiffs(
  rootDir: string,
  text: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // 1. Parse and validate the incoming diff.
  const blocks = parseDiffBlocks(text);

  if (blocks.length === 0) {
    throw new Error(
      "Clipboard does not contain any supported diff operations.",
    );
  }

  await validateSuspiciousReplacements(blocks, options);

  // 2. Resolve all paths and enforce path restrictions.
  const { targets, destinations } = await resolveAndValidatePaths(
    rootDir,
    blocks,
  );

  // 3. Confirm potentially dangerous .gitignore changes.
  await validateGitignoreEdits(rootDir, blocks, targets, destinations, options);

  // 4. Simulate all operations without modifying files.
  const { plans, fuzzy } = await buildFilePlans(
    rootDir,
    blocks,
    targets,
    destinations,
    options,
  );

  // 5. Capture undo/redo information before committing.
  const snapshot = createCheckpoint(plans.values());

  // 6. Commit the plans.
  options.assertBuffersCurrent?.();

  const { modified, created, deleted } = await commitPlans(
    plans.values(),
    options.assertBuffersCurrent,
  );

  return {
    modified,
    created,
    deleted,
    fuzzy,
    checkpoint: { files: snapshot },
  };
}

// ============================================================================
// Public API: undo / redo
// ============================================================================

/**
 * Restores a checkpoint's file contents in the given direction.
 *
 * Undo restores the pre-apply contents. Redo restores the post-apply contents.
 * Files whose expected state has changed are treated as conflicts and require
 * explicit confirmation before anything is written.
 */
export async function applySnapshot(
  rootDir: string,
  files: FileSnapshot[],
  direction: "undo" | "redo",
  options: SnapshotOptions = {},
): Promise<ApplySummary> {
  const plans: FilePlan[] = [];
  const conflicts: string[] = [];

  // 1. Prepare the plans and detect changes since the checkpoint.
  for (const file of files) {
    const target = direction === "undo" ? file.before : file.after;
    const expected = direction === "undo" ? file.after : file.before;

    const { absPath } = await resolveFile(rootDir, file.relPath);

    const currentContent = await readCurrentContent(
      absPath,
      options.bufferOverrides,
    );

    const currentExists = currentContent !== undefined;

    if (currentExists && currentContent !== expected) {
      conflicts.push(file.relPath);
    }

    // The target state does not contain this file, so delete it if present.
    if (target === undefined) {
      if (currentExists) {
        plans.push({
          absPath,
          relPath: file.relPath,
          existed: true,
          original: currentContent,
          content: "",
          deleted: true,
        });
      }

      continue;
    }

    plans.push({
      absPath,
      relPath: file.relPath,
      existed: currentExists,
      original: currentContent,
      content: target,
      deleted: false,
    });
  }

  // 2. Ask for confirmation before overwriting conflicting changes.
  if (conflicts.length > 0) {
    const action = direction === "undo" ? "Undo" : "Redo";

    if (!options.confirmConflict) {
      throw new Error(
        `Files changed since this diff was recorded: ${conflicts.join(", ")}. ` +
          `${action} cancelled; revert those files by hand first.`,
      );
    }

    const confirmed = await options.confirmConflict(conflicts);

    if (!confirmed) {
      throw new Error(
        `${action} cancelled: ${conflicts.join(", ")} changed since the diff was applied.`,
      );
    }
  }

  // 3. Commit the restored state.
  options.assertBuffersCurrent?.();

  const { modified, created, deleted } = await commitPlans(
    plans,
    options.assertBuffersCurrent,
  );

  return { modified, created, deleted, fuzzy: 0 };
}
